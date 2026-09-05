import { describe, it, expect } from 'vitest';
import { handoverBlock } from '../src/handover.js';

/**
 * Gate E says "ready to hand to the team lead". On 2026-08-13 it said exactly
 * that for PR #4535 while GitHub said `reviewDecision: REVIEW_REQUIRED`, the
 * `changes-requested` label was on, and pr-swarm's standing review was
 * CHANGES_REQUESTED.
 *
 * The console had the data and never looked: `reviewDecision` has been fetched in
 * gh.ts since it was written and was read by nothing. What the console DID track
 * was its own review rounds — and both were marked as resolved by the operator,
 * which means "the operator kicked off the rework", not "the reviewer is
 * satisfied". Closing the round closed the gate. So a PR carrying
 * changes-requested read as fine on the console.
 *
 * The direction of the bug is what makes it serious: the MORE the operator
 * engaged with a review round, the more likely the console declared the PR
 * ready. The two other open PRs, whose rounds were unanswered, sat correctly at
 * stage 7.
 */
describe('Gate E refuses a PR the reviewer has not cleared', () => {
  it('BLOCKS on a standing CHANGES_REQUESTED — the #4535 case, exactly', () => {
    const b = handoverBlock({ reviewDecision: 'CHANGES_REQUESTED', changesRequested: true, isDraft: false });
    expect(b).not.toBeNull();
    expect(b!.ready).toBe(false);
    expect(b!.why).toContain('changes');
  });

  it('BLOCKS on REVIEW_REQUIRED even when the label has been taken off', () => {
    // The worker deletes `changes-requested` when it pushes a fix — that is a
    // sanctioned write. It says "I have responded", never "you may merge".
    const b = handoverBlock({ reviewDecision: 'REVIEW_REQUIRED', changesRequested: false, isDraft: false });
    expect(b!.ready).toBe(false);
    expect(b!.why).toContain('approving review');
  });

  it('BLOCKS on the label alone, whatever the decision says', () => {
    const b = handoverBlock({ reviewDecision: 'APPROVED', changesRequested: true, isDraft: false });
    expect(b!.ready).toBe(false);
  });

  it('BLOCKS a draft — nobody merges a draft', () => {
    expect(handoverBlock({ reviewDecision: 'APPROVED', changesRequested: false, isDraft: true })!.ready).toBe(false);
  });

  it('lets a genuinely approved PR through', () => {
    const b = handoverBlock({ reviewDecision: 'APPROVED', changesRequested: false, isDraft: false });
    expect(b!.ready).toBe(true);
  });

  it('does NOT invent a blocker when GitHub could not be read', () => {
    // An unread field is not a refusal. Degrading into "you may not hand this
    // over" on a failed poll would be its own kind of lie, so an empty decision
    // says plainly that it is unverified and leaves the decision with the operator.
    const b = handoverBlock({ reviewDecision: null, changesRequested: false, isDraft: false });
    expect(b!.ready).toBe(false);
    expect(b!.why).toContain('could not read');
  });

  it('is null for a MERGED PR — it is already handed over and merged', () => {
    // My own regression, caught the same hour: a merged PR carries no
    // reviewDecision, so the "could not read" branch marked #4334, #4336 and
    // #4342 — all closed, all QA-signed-off — as BLOCKED. Finished work has no
    // handover left to judge.
    expect(handoverBlock({ state: 'MERGED', reviewDecision: null, changesRequested: false, isDraft: false })).toBeNull();
  });

  it('is null when there is no PR at all — nothing to hand over yet', () => {
    expect(handoverBlock(null)).toBeNull();
  });
});
