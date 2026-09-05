import { describe, it, expect } from 'vitest';
import { parseDecisions, gatesApproved, approvedThrough, codeSince, type GateDecision } from '../src/decisions.js';

/**
 * The record the console was never keeping.
 *
 * A report reached the operator claiming three gates had been skipped. Two of
 * them were approved, and the operator's own words were on disk — in
 * `.gate-history.jsonl`, which the worker writes — while the console's spine
 * ticks were regexed out of a prose sentence in a DIFFERENT worker-written file
 * that had gone stale. Neither is a record the console owns, and 54 gate resumes
 * had produced 29 worker-written lines: roughly 25 decisions were never written
 * down by anyone.
 *
 * This is the replacement, and its whole point is to be the only one.
 */
const line = (over: Partial<GateDecision>): string =>
  JSON.stringify({
    issue: 4344,
    gate: 'C',
    decision: 'approved',
    message: 'Gate C approved — I ran the manual QA myself, step by step',
    at: '2026-08-12T20:35:32Z',
    sessionId: 'sess-1',
    account: 'work',
    ...over,
  });

describe('the decision ledger', () => {
  it('reads back what was written, byte for byte on the operator’s words', () => {
    const [d] = parseDecisions(line({}));
    expect(d!.gate).toBe('C');
    expect(d!.decision).toBe('approved');
    expect(d!.message).toBe('Gate C approved — I ran the manual QA myself, step by step');
    expect(d!.at).toBe('2026-08-12T20:35:32Z');
    expect(d!.sessionId).toBe('sess-1');
  });

  it('survives a half-written line from a kill mid-append', () => {
    // Append is not atomic. One torn line must not lose the rest of the file.
    const raw = `${line({})}\n{"issue":4344,"gate":"D","dec`;
    expect(parseDecisions(raw)).toHaveLength(1);
  });

  it('ignores blank lines and junk without throwing', () => {
    expect(parseDecisions('\n\nnot json\n' + line({}) + '\n')).toHaveLength(1);
    expect(parseDecisions('')).toEqual([]);
  });

  it('drops a record missing the fields that make it a decision', () => {
    expect(parseDecisions(JSON.stringify({ issue: 1, gate: 'C' }))).toEqual([]);
    expect(parseDecisions(JSON.stringify({ issue: 1, gate: 'C', decision: 'maybe' }))).toEqual([]);
  });
});

describe('which gates an issue has actually been approved through', () => {
  const raw = [
    line({ issue: 4344, gate: 'A' }),
    line({ issue: 4344, gate: 'C' }),
    line({ issue: 4344, gate: 'D' }),
    line({ issue: 4491, gate: 'A' }),
  ].join('\n');

  it('#4344 — the answer the spine should have been showing all along', () => {
    // Its prose line said "A, B, C" while his Gate D approval sat in the history
    // file. That contradiction is what made the audit report a skipped gate.
    expect(gatesApproved(parseDecisions(raw), 4344)).toEqual(['A', 'C', 'D']);
  });

  it('keeps issues apart', () => {
    expect(gatesApproved(parseDecisions(raw), 4491)).toEqual(['A']);
    expect(gatesApproved(parseDecisions(raw), 9999)).toEqual([]);
  });

  it('returns gates in gate order, not in the order they were decided', () => {
    const jumbled = [line({ gate: 'E' }), line({ gate: 'A' }), line({ gate: 'C' })].join('\n');
    expect(gatesApproved(parseDecisions(jumbled), 4344)).toEqual(['A', 'C', 'E']);
  });

  it('does NOT count sending work back as passing a gate', () => {
    const sentBack = line({ gate: 'C', decision: 'feedback', message: 'step 3 is wrong, redo it' });
    expect(gatesApproved(parseDecisions(sentBack), 4344)).toEqual([]);
  });

  it('counts a gate approved, reopened and approved again exactly once', () => {
    const twice = [line({ gate: 'C' }), line({ gate: 'C', decision: 'feedback' }), line({ gate: 'C' })].join('\n');
    expect(gatesApproved(parseDecisions(twice), 4344)).toEqual(['C']);
  });

  it('answers the question the fence needs to ask before `gh pr create`', () => {
    const ds = parseDecisions(raw);
    expect(approvedThrough(ds, 4344, 'D')).toBe(true);
    // #4404's real state: Gate D was never asked for, so the PR should not go out.
    expect(approvedThrough(ds, 4491, 'D')).toBe(false);
  });
});

/**
 * A Gate D card mentioned code added after the operator's QA pass — and the
 * question that raises is why such a thing surfaces at gate D rather than at
 * gate C, where it is a blocker.
 *
 * Two facts existed and neither was attached to the decision, so both reached the
 * operator as prose in a later gate's paragraph three:
 *
 *   - A SPECIFIC diff was approved. Nothing recorded which. So when a commit
 *     landed afterwards, nothing could work out that the QA no longer covered
 *     the code — the only reason it was mentioned at all is that a worker chose
 *     to mention it.
 *   - A Gate C question was left unanswered. It evaporated; the worker took its
 *     own recommendation and asked again at Gate D as a "last call".
 *
 * Both become derivable the moment the decision line carries them.
 */
describe('a decision remembers what it was a decision about', () => {
  it('records the commit the approval was given against', () => {
    const [d] = parseDecisions(line({ head: 'db59901ab' }));
    expect(d!.head).toBe('db59901ab');
  });

  it('records the questions the operator left unanswered', () => {
    const [d] = parseDecisions(line({ unanswered: ['do you want the sent_at hardening now or later?'] }));
    expect(d!.unanswered).toEqual(['do you want the sent_at hardening now or later?']);
  });

  it('says how much has landed since the approval', () => {
    const ds = parseDecisions(line({ gate: 'C', head: 'aaa1111' }));
    expect(codeSince(ds, 4344, 'C', 'aaa1111')).toBeNull(); // unchanged
    const moved = codeSince(ds, 4344, 'C', 'bbb2222');
    expect(moved).not.toBeNull();
    expect(moved!.approvedAt).toBe('aaa1111');
    expect(moved!.headNow).toBe('bbb2222');
  });

  it('is silent when there is no such approval, or no head was recorded', () => {
    expect(codeSince(parseDecisions(line({ gate: 'C' })), 4344, 'C', 'bbb2222')).toBeNull();
    expect(codeSince([], 4344, 'C', 'bbb2222')).toBeNull();
  });

  it('reads the LATEST approval of that gate, not the first', () => {
    // A gate reopened and re-approved resets the clock: the newest look is the
    // one the QA covers.
    const two = [line({ gate: 'C', head: 'old0000', at: '2026-08-12T10:00:00Z' }),
                 line({ gate: 'C', head: 'new1111', at: '2026-08-13T10:00:00Z' })].join('\n');
    expect(codeSince(parseDecisions(two), 4344, 'C', 'new1111')).toBeNull();
  });
});
