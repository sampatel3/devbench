import { describe, it, expect } from 'vitest';
import { auditIssues, type AuditInput } from '../src/audit.js';
import type { CycleSummary } from '../src/cycle.js';

/**
 * The ask: one recon pass over every open issue that validates its status, so
 * nothing is stuck without anyone knowing, a blocked issue carries a clear
 * reason, and a status that has hung around too long is named as such.
 *
 * What is worth testing is the line between the two verdicts — stuck is a
 * dropped ball, slow is a long wait — and the honesty rules around the
 * comparison: withheld below the sample floor, and never derived from an
 * anchor that does not exist.
 */

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();

/** Median 10 h on every leg, over a healthy sample. */
const SUMMARY: CycleSummary = {
  toRaise: { n: 10, medianMin: 600, meanMin: 700 },
  toMerge: { n: 10, medianMin: 600, meanMin: 700 },
  toClose: { n: 10, medianMin: 600, meanMin: 700 },
};

/** Too few finished legs for any comparison to be honest. */
const THIN: CycleSummary = {
  toRaise: { n: 2, medianMin: 600, meanMin: 600 },
  toMerge: { n: 2, medianMin: 600, meanMin: 600 },
  toClose: { n: 2, medianMin: 600, meanMin: 600 },
};

const base: AuditInput = {
  number: 100,
  title: 'a ticket',
  status: 'active',
  statusDetail: 'working',
  parked: false,
  blockedNote: null,
  prNumber: null,
  prIsDraft: false,
  startedAt: null,
  raisedAt: null,
  mergedAt: null,
};

const one = (over: Partial<AuditInput>, summary: CycleSummary = SUMMARY) =>
  auditIssues([{ ...base, ...over }], summary, NOW).issues[0]!;

describe('stuck — a dropped ball, whatever the clock says', () => {
  it('a blocked issue with no human note is stuck', () => {
    const a = one({ status: 'blocked' });
    expect(a.verdict).toBe('stuck');
    expect(a.findings.map((f) => f.key)).toContain('blocked-unexplained');
  });

  it('a blocked issue whose labeller wrote nothing is still unexplained', () => {
    const a = one({ status: 'blocked', blockedNote: { by: 'priya', at: hoursAgo(3), body: '   ' } });
    expect(a.findings.map((f) => f.key)).toContain('blocked-unexplained');
  });

  it('a blocked issue with a named dependency is not stuck for being blocked', () => {
    const a = one({
      status: 'blocked',
      blockedNote: { by: 'priya', at: hoursAgo(3), body: 'waiting on the upstream fix in #99' },
    });
    expect(a.findings.map((f) => f.key)).not.toContain('blocked-unexplained');
    expect(a.verdict).toBe('ok');
  });

  it('a draft PR is stuck — a draft gets no review at all', () => {
    const a = one({ status: 'pr-open', prNumber: 5358, prIsDraft: true, raisedAt: hoursAgo(2) });
    expect(a.verdict).toBe('stuck');
    expect(a.findings[0]!.text).toContain('#5358');
  });

  it('a dead worker is stuck in both of its shapes', () => {
    expect(one({ status: 'failed' }).verdict).toBe('stuck');
    expect(one({ status: 'checkpoint' }).verdict).toBe('stuck');
  });

  it('a reply that arrived and was never resumed is stuck', () => {
    expect(one({ status: 'reply-received' }).findings.map((f) => f.key)).toContain('reply-unresumed');
  });

  it('a board card at In progress with nothing behind it is stuck', () => {
    const a = one({ status: 'no-worker', startedAt: hoursAgo(30) });
    expect(a.findings.map((f) => f.key)).toContain('started-nothing-behind');
  });

  it('…but not once a PR was raised — no-worker after the raise is a different, ordinary state', () => {
    const a = one({ status: 'no-worker', startedAt: hoursAgo(30), raisedAt: hoursAgo(2) });
    expect(a.findings.map((f) => f.key)).not.toContain('started-nothing-behind');
  });
});

describe('slow — held past the median of the leg it is in', () => {
  it('an issue far past the median of its phase is slow', () => {
    // 30 h into a leg whose median is 10 h.
    const a = one({ status: 'pr-open', prNumber: 1, raisedAt: hoursAgo(30) });
    expect(a.verdict).toBe('slow');
    expect(a.findings[0]!.key).toBe('past-median');
    // The finding carries the numbers, so the phase line is withheld — a line
    // said twice reads like two facts.
    expect(a.phase).toBeNull();
  });

  it('the phase is the furthest milestone reached, not the status name', () => {
    // Blocked, but with a PR raised — judged inside raised → merged, and 30 h
    // against a 10 h median is slow on that leg.
    const a = one({
      status: 'blocked',
      blockedNote: { by: 'priya', at: hoursAgo(1), body: 'waiting on infra' },
      raisedAt: hoursAgo(30),
      startedAt: hoursAgo(90),
    });
    expect(a.verdict).toBe('slow');
    expect(a.findings[0]!.text).toContain('PR raised → merged');
  });

  it('merged-not-closed is judged against merged → issue closed', () => {
    const a = one({ status: 'pr-merged', mergedAt: hoursAgo(48), raisedAt: hoursAgo(90) });
    expect(a.verdict).toBe('slow');
    expect(a.findings[0]!.text).toContain('merged → issue closed');
  });

  it('within the median band it is on pace, and the phase line still shows the ruler', () => {
    const a = one({ status: 'pr-open', prNumber: 1, raisedAt: hoursAgo(9) });
    expect(a.verdict).toBe('ok');
    expect(a.phase).toContain('median 10h across 10 finished');
  });

  it('below the sample floor nothing is called slow, and the figure stands alone', () => {
    const a = one({ status: 'pr-open', prNumber: 1, raisedAt: hoursAgo(30) }, THIN);
    expect(a.verdict).toBe('ok');
    expect(a.phase).toBe('PR raised → merged: 1d 6h so far');
  });

  it('no phase has begun — nothing started, nothing raised — so nothing is measured', () => {
    const a = one({ status: 'queued' });
    expect(a.phase).toBeNull();
    expect(a.verdict).toBe('ok');
  });
});

describe('the report', () => {
  it('orders stuck before slow before ok, longest-held first inside a band', () => {
    const report = auditIssues(
      [
        { ...base, number: 1, status: 'pr-open', prNumber: 1, raisedAt: hoursAgo(9) },
        { ...base, number: 2, status: 'failed' },
        { ...base, number: 3, status: 'pr-open', prNumber: 3, raisedAt: hoursAgo(30) },
        { ...base, number: 4, status: 'pr-open', prNumber: 4, raisedAt: hoursAgo(50) },
      ],
      SUMMARY,
      NOW,
    );
    expect(report.issues.map((i) => i.issue)).toEqual([2, 4, 3, 1]);
    expect([report.stuck, report.slow, report.ok]).toEqual([1, 2, 1]);
  });

  it('a parked row is named, never judged', () => {
    const report = auditIssues([{ ...base, number: 7, status: 'failed', parked: true }], SUMMARY, NOW);
    expect(report.issues).toEqual([]);
    expect(report.parked).toEqual([7]);
  });
});
