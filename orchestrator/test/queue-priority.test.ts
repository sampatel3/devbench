/**
 * WHO GOES NEXT.
 *
 * The operator asked for one order out of the queue — UAT failures, then P0, P1,
 * P2, P3 — and reported that the console appeared to pick at random, or by when a
 * ticket entered the queue.
 *
 * It was arrival order, and these are the tests that say it no longer is. The
 * last case is the one that matters most in a year's time: it fails if the
 * dispatcher's band order and the rail's band order are ever changed apart.
 */
import { describe, it, expect } from 'vitest';
import { BANDS as DISPATCH_BANDS, WorkerQueue, bandOf, orderQueue, selectNext, type Weigh } from '../src/queue.js';
import { BANDS as RAIL_BANDS } from '../../ui/src/priority.js';

/** A weigher built from a plain table, the way the orchestrator's `#weigh`
 *  builds one from the issue list and the actions feed. */
const weigher = (table: Record<number, { band?: string[]; uatFail?: boolean; sentBack?: boolean }>): Weigh => {
  return (issue) => ({
    uatFail: table[issue]?.uatFail ?? false,
    sentBack: table[issue]?.sentBack ?? false,
    band: bandOf(table[issue]?.band ?? []),
  });
};

describe('bandOf', () => {
  it('reads the repo’s five priority labels, however they are cased', () => {
    expect(bandOf(['P0'])).toBe('P0');
    expect(bandOf(['p1'])).toBe('P1');
    expect(bandOf([' P2 '])).toBe('P2');
    expect(bandOf(['icebox'])).toBe('icebox');
  });

  it('calls an unlabelled issue untriaged, never P2', () => {
    expect(bandOf([])).toBe('untriaged');
    expect(bandOf(['bug', 'needs-triage'])).toBe('untriaged');
  });

  it('takes the most urgent when triage left two on, so P2 + icebox dispatches as P2', () => {
    expect(bandOf(['icebox', 'P2'])).toBe('P2');
    expect(bandOf(['P3', 'P1'])).toBe('P1');
  });
});

describe('the order the line is served in', () => {
  it('picks P0 before P1 before P2 before P3, whatever order they arrived in', () => {
    const weigh = weigher({ 1: { band: ['P3'] }, 2: { band: ['P1'] }, 3: { band: ['P0'] }, 4: { band: ['P2'] } });
    expect(orderQueue([1, 2, 3, 4], weigh)).toEqual([3, 2, 4, 1]);
  });

  it('puts a UAT send-back above every band, P0 included', () => {
    const weigh = weigher({ 1: { band: ['P0'] }, 2: { band: ['P3'], uatFail: true } });
    expect(orderQueue([1, 2], weigh)).toEqual([2, 1]);
  });

  it('ranks several send-backs among themselves by band', () => {
    const weigh = weigher({
      1: { band: ['P2'], uatFail: true },
      2: { band: ['P0'], uatFail: true },
      3: { band: ['P0'] },
    });
    expect(orderQueue([1, 2, 3], weigh)).toEqual([2, 1, 3]);
  });

  it('serves a P2 they sent back before a P1 they have not — their exact example', () => {
    // The rule the operator gave: a sent-back P1 outranks an untouched P1, and a
    // sent-back P2 outranks an untouched P1 too. Both halves, in one line: the
    // failure is resolved first, and only then does the band decide who
    // progresses.
    const weigh = weigher({ 1: { band: ['P1'] }, 2: { band: ['P2'], sentBack: true } });
    expect(orderQueue([1, 2], weigh)).toEqual([2, 1]);
  });

  it('serves the sent-back P1 before the untouched P1', () => {
    const weigh = weigher({ 1: { band: ['P1'] }, 2: { band: ['P1'], sentBack: true } });
    expect(orderQueue([1, 2], weigh)).toEqual([2, 1]);
  });

  it('keeps a UAT send-back above one of theirs, however it is banded', () => {
    // None of that applies to UAT fails: those are always top. A P0 they sent
    // back still goes behind an icebox ticket QA rejected after it shipped.
    const weigh = weigher({ 1: { band: ['P0'], sentBack: true }, 2: { band: ['icebox'], uatFail: true } });
    expect(orderQueue([1, 2], weigh)).toEqual([2, 1]);
  });

  it('ranks several of their send-backs among themselves by band', () => {
    const weigh = weigher({
      1: { band: ['P2'], sentBack: true },
      2: { band: ['P0'], sentBack: true },
      3: { band: ['P0'] },
    });
    expect(orderQueue([1, 2, 3], weigh)).toEqual([2, 1, 3]);
  });

  it('is still FIFO between two send-backs in the same band', () => {
    const weigh = weigher({ 7: { band: ['P1'], sentBack: true }, 8: { band: ['P1'], sentBack: true } });
    expect(orderQueue([7, 8], weigh)).toEqual([7, 8]);
    expect(orderQueue([8, 7], weigh)).toEqual([8, 7]);
  });

  it('does not lift an icebox send-back above a P0 send-back', () => {
    // The band still decides inside the group, so "sent back" cannot be used to
    // walk a ticket a human has already declined to schedule to the front.
    const weigh = weigher({ 1: { band: ['icebox'], sentBack: true }, 2: { band: ['P0'], sentBack: true } });
    expect(orderQueue([1, 2], weigh)).toEqual([2, 1]);
  });

  it('is still FIFO inside a band, so nothing starves and the line stays predictable', () => {
    const weigh = weigher({ 7: { band: ['P1'] }, 8: { band: ['P1'] }, 9: { band: ['P1'] } });
    expect(orderQueue([7, 8, 9], weigh)).toEqual([7, 8, 9]);
    expect(orderQueue([9, 7, 8], weigh)).toEqual([9, 7, 8]);
  });

  it('sends an unranked issue below P3 but above icebox', () => {
    const weigh = weigher({ 1: { band: ['icebox'] }, 2: {}, 3: { band: ['P3'] } });
    expect(orderQueue([1, 2, 3], weigh)).toEqual([3, 2, 1]);
  });

  it('weighs an issue the console knows nothing about as unranked rather than first or last', () => {
    // No entry at all for 2 — enqueued before the first poll landed.
    const weigh = weigher({ 1: { band: ['P1'] }, 3: { band: ['icebox'] } });
    expect(orderQueue([3, 2, 1], weigh)).toEqual([1, 2, 3]);
  });

  it('leaves the line alone when nothing outranks anything', () => {
    expect(orderQueue([5, 3, 9])).toEqual([5, 3, 9]);
  });
});

describe('the queue itself', () => {
  const weigh = weigher({ 100: { band: ['P3'] }, 200: { band: ['P1'] }, 300: { band: ['P2'], uatFail: true } });

  it('serves the P1 first even though the P3 asked first', () => {
    const q = new WorkerQueue(weigh);
    q.enqueue(100);
    q.enqueue(200);
    expect(q.list()).toEqual([200, 100]);
  });

  it('says "next up" about the issue that will actually start', () => {
    const q = new WorkerQueue(weigh);
    q.enqueue(100);
    q.enqueue(200);
    expect(q.position(200)).toBe(1);
    expect(q.position(100)).toBe(2);
    expect(q.position(999)).toBe(null);
  });

  it('keeps arrival order available for anything that wants it', () => {
    const q = new WorkerQueue(weigh);
    q.enqueue(100);
    q.enqueue(300);
    q.enqueue(200);
    expect(q.arrivals()).toEqual([100, 300, 200]);
    expect(q.list()).toEqual([300, 200, 100]);
  });

  it('does not let a re-enqueue jump the line inside its own band', () => {
    const flat = weigher({ 1: { band: ['P1'] }, 2: { band: ['P1'] } });
    const q = new WorkerQueue(flat);
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(1); // a resume that found a broken profile putting its claim back
    expect(q.list()).toEqual([1, 2]);
  });

  it('re-ranks a waiting ticket the moment its label changes, without a restart', () => {
    // The labels the console holds — the queue reads them back on every list(),
    // which is the whole reason it stores arrival order and sorts on the way out.
    const live: Record<number, string[]> = { 1: ['P3'], 2: ['P3'] };
    const q = new WorkerQueue((issue) => ({ uatFail: false, sentBack: false, band: bandOf(live[issue] ?? []) }));
    q.enqueue(1);
    q.enqueue(2);
    expect(q.list()).toEqual([1, 2]);
    live[2] = ['P0']; // triage ranks it while it waits
    expect(q.list()).toEqual([2, 1]);
  });

  it('hands selectNext a head that is the highest-ranked waiting ticket', () => {
    const q = new WorkerQueue(weigh);
    q.enqueue(100);
    q.enqueue(200);
    q.enqueue(300);
    const d = selectNext({ queue: q.list(), activeCount: 0, maxActive: 2, resources: { ok: true, reason: '' } });
    expect(d.issue).toBe(300); // the send-back
  });
});

describe('the dispatcher and the rail agree about the bands', () => {
  it('ranks the priority bands in exactly the order ui/src/priority.ts draws them', () => {
    // Copied, not imported — orchestrator/tsconfig.json has rootDir: src, so
    // orchestrator/src cannot reach ui/src at build time. This test is the thing
    // that stops the copy from drifting.
    expect([...DISPATCH_BANDS]).toEqual([...RAIL_BANDS]);
  });
});
