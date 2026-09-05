/**
 * What a targeted rework actually sends.
 *
 * Same standard as `ask-prompt.test.ts`, and for the same reason: a message sent
 * at a gate has been read as a decision on this console before. A rework is a
 * change request, not an approval, and it carries the rest of the issue's
 * evidence as its payload — so both the sentinel AND the payload are tested
 * string properties rather than a template somebody eyeballs.
 *
 * The payload matters more here than in the ask. It is the only copy the worker
 * gets of everything it must carry forward: get it wrong and the gate box loses
 * the evidence for the whole issue, which is the exact failure this feature was
 * built to prevent.
 */
import { describe, it, expect } from 'vitest';
import { PRIOR_EVIDENCE_MARK, PRIOR_MANUAL_QA_MARK, reworkPrompt, type QaSnapshot } from '../src/rework.js';
import { parseManualQa } from '../src/manual-qa.js';
import { parseEvidence } from '../src/evidence.js';

const QA = 'docs/issue-pipeline/plans/qa-4404';

const snapshot = (): QaSnapshot => ({
  takenAt: '2026-08-12T10:00:00.000Z',
  stoppedAt: '2026-08-12T09:00:00.000Z',
  evidence: parseEvidence([
    { kind: 'screenshot', path: `${QA}/step1-after.png`, caption: 'step 1 — Withdraw asks first' },
    { kind: 'screenshot', path: `${QA}/step2-after.png`, caption: 'step 2 — Accept is gone' },
  ]),
  manualQa: parseManualQa({
    appUrl: 'http://localhost:8106',
    start: 'Quotes list, filtered to Sent.',
    steps: [
      { id: 1, rev: 1, do: 'Withdraw a sent quote', before: 'no warning', after: 'a confirm dialog asks first' },
      { id: 2, rev: 1, do: 'Try to accept it', before: 'Accept still worked', after: 'Accept is gone' },
    ],
  })!,
});

const failed = [{ id: 2, rev: 1, do: 'Try to accept it', note: 'Accept was still there' }];

describe('the rework prompt', () => {
  it('leads with the sentinel, on its own first line', () => {
    expect(reworkPrompt(failed, snapshot()).split('\n')[0]).toBe(
      'GATE C QA REWORK — FAILED STEP(S) ONLY, NOT A FULL QA',
    );
  });

  it('never contains the approval word — the charge-past defence', () => {
    const out = reworkPrompt(failed, snapshot());
    expect(out.toLowerCase()).not.toContain('approved');
    expect(out).toContain('Gate C is');
    expect(out).toContain('still OPEN');
    expect(out).toContain('decides nothing');
  });

  it('passes their words through verbatim, however they wrote them', () => {
    const awkward = 'the "Confirm" button\nstill fired — and it kept the reason blank';
    const out = reworkPrompt([{ ...failed[0]!, note: awkward }], snapshot());
    expect(out).toContain(awkward);
  });

  it('forbids the full QA in the words the operator used to forbid it', () => {
    const out = reworkPrompt(failed, snapshot());
    expect(out).toContain('Do NOT re-run the full manual QA');
    expect(out).toContain('Do NOT');
    expect(out).toContain('re-capture any passing step');
    expect(out).toContain('waste of tokens and time and resources');
  });

  it('tells it to bump the rev and never overwrite an old capture', () => {
    const out = reworkPrompt(failed, snapshot());
    // The rev bump is what resets the operator's tick on the fixed step and ONLY that
    // step, so it is an instruction, not an implementation detail.
    expect(out).toContain('bumps "rev" by exactly 1');
    expect(out).toContain('Never overwrite or delete');
    expect(out).toContain('Remove nothing');
  });

  it('says stop at gate C twice — once in the write step, once on its own', () => {
    const out = reworkPrompt(failed, snapshot());
    expect(out.match(/gate C/g)!.length).toBeGreaterThanOrEqual(3);
    expect(out).toContain('Stop at gate C again');
    expect(out).toContain('Do NOT proceed');
  });

  it('carries the prior evidence and click-script as PARSEABLE json, last', () => {
    const out = reworkPrompt(failed, snapshot());
    const evAt = out.indexOf(PRIOR_EVIDENCE_MARK);
    const qaAt = out.indexOf(PRIOR_MANUAL_QA_MARK);
    expect(evAt).toBeGreaterThan(0);
    expect(qaAt).toBeGreaterThan(evAt); // payload last, instructions readable first

    const evidence = JSON.parse(out.slice(out.indexOf('[', evAt), qaAt)) as Array<{ path: string }>;
    expect(evidence.map((e) => e.path)).toEqual([`${QA}/step1-after.png`, `${QA}/step2-after.png`]);

    const qa = JSON.parse(out.slice(out.indexOf('{', qaAt))) as { steps: Array<{ id: number; rev: number }> };
    expect(qa.steps.map((s) => s.id)).toEqual([1, 2]); // every step, not just the failed one
    expect(qa.steps.every((s) => s.rev === 1)).toBe(true);
  });

  it('names every failed step when more than one went back, and counts them', () => {
    const two = [
      { id: 1, rev: 1, do: 'Withdraw a sent quote', note: 'no dialog appeared' },
      { id: 2, rev: 3, do: 'Try to accept it', note: 'Accept was still there' },
    ];
    const out = reworkPrompt(two, snapshot());
    expect(out).toContain('2 steps failed');
    expect(out).toContain('Step 1 (rev 1)');
    expect(out).toContain('Step 2 (rev 3)');
    expect(out).toContain('no dialog appeared');
    expect(out).toContain('Accept was still there');
  });

  it('says "One step" in the singular', () => {
    expect(reworkPrompt(failed, snapshot())).toContain('One step failed');
  });
});
