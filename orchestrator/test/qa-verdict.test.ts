/**
 * WHOSE TICK IS IT, AND WHAT IS IT A TICK ON.
 *
 * A tick is the record that a PERSON looked at one thing and was satisfied. The
 * worker rewrites `.gate.json` whole on every stop, so the only interesting
 * question about a tick is which version of a step it belongs to — and the only
 * acceptable failure direction is UNSET. The operator re-ticking something costs
 * a moment of their time; the operator inheriting a tick they never gave is the
 * framework lying to them.
 *
 * Two independent keys, because one is not enough:
 *  - `rev`, which the worker bumps when it fixes a step. That is the designed
 *    reset, and it is what makes a targeted rework cost them ONE re-check.
 *  - the content hash, which covers what rev cannot: a worker that edits a step
 *    and forgets to bump anything.
 */
import { describe, it, expect } from 'vitest';
import { currentVerdict, failedSteps, qaProgress, stepHash, stepState, type QaVerdict } from '../src/qa-verdict.js';
import type { ManualQaStep } from '../src/manual-qa.js';

const step = (over: Partial<ManualQaStep> = {}): ManualQaStep => ({
  id: 1,
  rev: 1,
  do: 'Confirm the withdrawal with an empty reason',
  url: 'http://localhost:8106/quotes',
  before: 'the modal accepted it',
  beforeShot: 'docs/issue-pipeline/plans/qa-4404/s1-before.png',
  after: 'Confirm stays disabled',
  afterShot: 'docs/issue-pipeline/plans/qa-4404/s1-after.png',
  fix: null,
  shotStamp: null,
  ...over,
});

const tick = (s: ManualQaStep, status: QaVerdict['status'] = 'verified', note: string | null = null): QaVerdict => ({
  stepId: s.id,
  rev: s.rev,
  hash: stepHash(s),
  status,
  note,
  at: '2026-08-12T10:00:00.000Z',
  shotAtFail: status === 'failed' ? s.afterShot : null,
});

describe('a tick and the step it belongs to', () => {
  it('SURVIVES the worker rewriting the file, when the step comes back identical', () => {
    const s = step();
    const verdicts = [tick(s)];
    // The same step, parsed out of a freshly written .gate.json. Different
    // object, same content — which is the whole carry-forward contract.
    expect(stepState(step(), verdicts)).toBe('verified');
    expect(currentVerdict(step(), verdicts)!.at).toBe('2026-08-12T10:00:00.000Z');
  });

  it('RESETS when the step is fixed and its revision moves', () => {
    const verdicts = [tick(step(), 'failed', 'modal accepted an empty reason')];
    const fixed = step({ rev: 2, fix: 'disabled Confirm until a reason is typed', afterShot: 'docs/issue-pipeline/plans/qa-4404/s1-after-rev2.png' });
    expect(stepState(fixed, verdicts)).toBe('unset');
  });

  it('RESETS when the wording changed and the worker never said so', () => {
    const verdicts = [tick(step())];
    expect(stepState(step({ after: 'Confirm is disabled until a reason is typed' }), verdicts)).toBe('unset');
    expect(stepState(step({ do: 'Confirm with a whitespace-only reason' }), verdicts)).toBe('unset');
    expect(stepState(step({ afterShot: 'docs/issue-pipeline/plans/qa-4404/other.png' }), verdicts)).toBe('unset');
  });

  /**
   * THE RE-CAPTURE AT A STABLE FILENAME.
   *
   * `server.ts` says it in as many words: "rounds reuse filenames (after.png is
   * after.png every round)". So hashing the path string cannot tell a step whose
   * picture the operator approved from the same step with a different picture under it —
   * and the evidence route sends `no-cache`, so the card renders the NEW image
   * beneath their old green tick. The stamp is what the path cannot carry.
   */
  it('RESETS when a screenshot was re-captured under the same filename', () => {
    const verdicts = [tick(step({ shotStamp: '84210:1760000000000' }))];
    expect(stepState(step({ shotStamp: '84210:1760000000000' }), verdicts)).toBe('verified');
    expect(stepState(step({ shotStamp: '91884:1760000900000' }), verdicts)).toBe('unset');
    // ...and a capture that has gone missing entirely is not a verified step either.
    expect(stepState(step({ shotStamp: null }), verdicts)).toBe('unset');
  });

  it('does NOT reset when only the dev-server port moved', () => {
    const verdicts = [tick(step())];
    // A restarted stack picks a new port. Wiping nine ticks for that would make
    // the feature unusable, and the url is not what they verified.
    expect(stepState(step({ url: 'http://localhost:8199/quotes' }), verdicts)).toBe('verified');
  });

  it('takes the LATEST verdict, so undo works and nothing is ever deleted', () => {
    const s = step();
    const verdicts = [tick(s, 'failed', 'wrong'), tick(s, 'cleared'), tick(s, 'verified')];
    expect(stepState(s, verdicts)).toBe('verified');
    expect(stepState(s, verdicts.slice(0, 2))).toBe('unset'); // cleared reads as unset
    expect(verdicts).toHaveLength(3); // the failure is still on the record
  });

  it('never resolves a tick for a step id that is not this one', () => {
    const verdicts = [tick(step({ id: 4 }))];
    expect(currentVerdict(step({ id: 1 }), verdicts)).toBeNull();
  });
});

describe('what the Approve button counts', () => {
  const s1 = step({ id: 1 });
  const s2 = step({ id: 2, do: 'Try to accept the withdrawn quote' });
  const s3 = step({ id: 3, do: 'Withdraw a sent quote' });

  it('is complete only when every step is ticked verified', () => {
    expect(qaProgress([s1, s2, s3], [tick(s1), tick(s2)])).toMatchObject({
      total: 3,
      verified: 2,
      failed: 0,
      unset: 1,
      complete: false,
    });
    expect(qaProgress([s1, s2, s3], [tick(s1), tick(s2), tick(s3)]).complete).toBe(true);
  });

  it('is NOT complete with zero steps — an empty click-script is not a passed QA', () => {
    // Otherwise a worker could skip the whole half by emitting `steps: []`.
    expect(qaProgress([], []).complete).toBe(false);
  });

  it('a failed step keeps it incomplete however many others pass', () => {
    const p = qaProgress([s1, s2, s3], [tick(s1), tick(s2), tick(s3, 'failed', 'nope')]);
    expect(p).toMatchObject({ verified: 2, failed: 1, complete: false });
  });

  it('names the failed steps, with their words, for the rework', () => {
    const failed = failedSteps([s1, s2, s3], [tick(s1), tick(s3, 'failed', 'modal accepted an empty reason')]);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.step.id).toBe(3);
    expect(failed[0]!.verdict.note).toBe('modal accepted an empty reason');
  });

  it('drops a failure whose step has since been fixed — it is not still failed', () => {
    const verdicts = [tick(s3, 'failed', 'nope')];
    const fixed = step({ id: 3, rev: 2, do: s3.do, fix: 'fixed it' });
    expect(failedSteps([fixed], verdicts)).toEqual([]);
    expect(stepState(fixed, verdicts)).toBe('unset');
  });
});
