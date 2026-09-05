/**
 * What the console offers on a send-back from UAT.
 *
 * The most urgent state in the system had one button and it pointed at finished
 * work: with the PR merged and the issue open, the only card was Stage 9's, whose
 * prompt tells the worker to move the board card and draft the ready-to-verify
 * comment — both of which happened BEFORE QA could have tested. The operator had to
 * hand-write the fix brief on a phone, with the skill's Partial-vs-Fail rule
 * nowhere on screen.
 *
 * The prompt is client-side, but it is the payload that reaches a real worker,
 * so it is tested here rather than eyeballed.
 */
import { describe, it, expect } from 'vitest';
import { postMergePrompt, uatFixPrompt } from '../../ui/src/App.js';

const URL = 'https://github.com/example-org/example-repo/issues/4404#issuecomment-1';

describe('A UAT send-back gets its own brief', () => {
  /** Would have caught: the send-back card sending Stage 9's prompt. */
  it('never re-runs the Stage 9 work QA has already acted on', () => {
    const out = uatFixPrompt(4404, 'Fail', 'a-tester', URL);
    expect(out).not.toContain('move the board card');
    expect(out).toContain('Stage 9 is already done');
    expect(postMergePrompt(4404, 4433, null)).toContain('move the board card');
  });

  it('carries the verdict, the tester and the link to the steps to recreate', () => {
    const out = uatFixPrompt(4404, 'Fail', 'a-tester', URL);
    expect(out).toContain('#4404');
    expect(out).toContain('a-tester');
    expect(out).toContain('Fail');
    expect(out).toContain(URL);
  });

  /**
   * The skill's Stage 9 step 5 split, which is the part the operator has to choose
   * between and the part a phone cannot be expected to remember: a Partial Pass
   * is new work on a new branch through every gate; an outright Fail continues
   * on this issue, and they are told before anything changes so a revert is still
   * on the table.
   */
  it('states the Partial-vs-Fail branch, and states a different one for each', () => {
    const partial = uatFixPrompt(4404, 'Partial Pass', 'a-tester', URL);
    expect(partial).toContain('NEW branch');
    expect(partial).toContain('every gate from A');
    expect(partial).not.toContain('reverted');

    const fail = uatFixPrompt(4404, 'Fail', 'a-tester', URL);
    expect(fail).toContain('new PR');
    expect(fail).toContain('reverted');
    expect(fail).toContain('stop at a gate');
  });
});
