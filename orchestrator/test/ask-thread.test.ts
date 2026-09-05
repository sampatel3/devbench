/**
 * Reading the worker's half of the exchange back.
 *
 * The console owns the QUESTIONS (it wrote them down on the click) and the
 * gate file owns the ANSWERS. Merging by id is what makes that split safe: a
 * worker that forgets to echo the earlier entries loses nothing, and a worker
 * that invents an id changes nothing.
 */
import { describe, it, expect } from 'vitest';
import { parseGateThreadFile, mergeThreadAnswers, type GateThreadRecord } from '../src/ask.js';

const record = (over: Partial<GateThreadRecord> = {}): GateThreadRecord => ({
  gate: 'C',
  entries: [
    {
      id: 1,
      question: 'which table?',
      askedAt: '2026-08-12T10:00:00.000Z',
      answer: null,
      answeredAt: null,
      supersededAt: null,
    },
  ],
  pendingAskIds: [],
  violation: null,
  closedAt: null,
  stoppedAt: null,
  ...over,
});

describe('parseGateThreadFile', () => {
  it('keeps well-formed entries', () => {
    const out = parseGateThreadFile([{ id: 1, q: 'which table?', a: 'org_members', at: '2026-08-12T10:05:00.000Z' }]);
    expect(out).toEqual([{ id: 1, q: 'which table?', a: 'org_members', at: '2026-08-12T10:05:00.000Z' }]);
  });

  it('drops entries with a non-numeric id or non-string q/a', () => {
    const out = parseGateThreadFile([
      { id: 'one', q: 'a', a: 'b' },
      { id: 2, q: 42, a: 'b' },
      { id: 3, q: 'a', a: { nested: true } },
      { id: 4, q: 'kept', a: 'kept' },
    ]);
    expect(out).toEqual([{ id: 4, q: 'kept', a: 'kept', at: null }]);
  });

  it('never throws on anything a hostile or half-written gate file can hold', () => {
    expect(parseGateThreadFile(undefined)).toEqual([]);
    expect(parseGateThreadFile(null)).toEqual([]);
    expect(parseGateThreadFile('thread')).toEqual([]);
    expect(parseGateThreadFile([null, 1, 'x', []])).toEqual([]);
  });
});

describe('mergeThreadAnswers', () => {
  it('stamps the answer onto the question the console is holding', () => {
    const r = record();
    const changed = mergeThreadAnswers(r, [{ id: 1, q: 'ignored', a: 'org_members', at: '2026-08-12T10:05:00.000Z' }]);
    expect(changed).toBe(true);
    expect(r.entries[0]!.answer).toBe('org_members');
    expect(r.entries[0]!.answeredAt).toBe('2026-08-12T10:05:00.000Z');
  });

  it('is write-once: a second, different answer for the same id is ignored', () => {
    const r = record();
    mergeThreadAnswers(r, [{ id: 1, q: 'q', a: 'first answer', at: null }]);
    const changed = mergeThreadAnswers(r, [{ id: 1, q: 'q', a: 'a different answer', at: null }]);
    expect(changed).toBe(false);
    expect(r.entries[0]!.answer).toBe('first answer');
  });

  it('keeps the question the console wrote down, whatever the file says it was', () => {
    const r = record();
    mergeThreadAnswers(r, [{ id: 1, q: 'the worker paraphrased me', a: 'x', at: null }]);
    expect(r.entries[0]!.question).toBe('which table?');
  });

  it('survives a worker that echoed none of the prior entries', () => {
    const r = record({
      entries: [
        {
          id: 1,
          question: 'answered earlier',
          askedAt: 'z',
          answer: 'yes',
          answeredAt: 'z',
          supersededAt: null,
        },
        { id: 2, question: 'asked now', askedAt: 'z', answer: null, answeredAt: null, supersededAt: null },
      ],
    });
    mergeThreadAnswers(r, [{ id: 2, q: 'asked now', a: 'here you go', at: null }]);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]!.answer).toBe('yes'); // untouched
    expect(r.entries[1]!.answer).toBe('here you go');
  });

  it('ignores an answer to an id nobody asked — no phantom entries', () => {
    const r = record();
    const changed = mergeThreadAnswers(r, [{ id: 99, q: 'invented', a: 'invented', at: null }]);
    expect(changed).toBe(false);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.answer).toBeNull();
  });

  it('does not answer a question the operator has already overtaken with a decision', () => {
    const r = record();
    r.entries[0]!.supersededAt = '2026-08-12T10:04:00.000Z';
    const changed = mergeThreadAnswers(r, [{ id: 1, q: 'q', a: 'too late', at: null }]);
    expect(changed).toBe(false);
    expect(r.entries[0]!.answer).toBeNull();
  });
});
