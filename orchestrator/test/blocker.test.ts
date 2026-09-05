import { describe, it, expect } from 'vitest';
import { mergeBlocker } from '../src/blocker.js';

/**
 * On PR #4547 the operator could not tell whether the review bot or the human
 * approver was the one holding the merge.
 *
 * It was the human approver — and the console was saying the opposite. The card
 * said "pr-swarm has not cleared the review", which sends the operator chasing a
 * bot that cannot unblock anything. GitHub's own words on that PR:
 *
 *   reviewDecision            REVIEW_REQUIRED
 *   pr-swarm               CHANGES_REQUESTED, authorCanPushToRepository=false
 *   reviewRequests            Default Reviewers  (the codeowner team)
 *   "Merging is blocked — at least 1 approving review is required by reviewers
 *    with write access."
 *
 * The load-bearing inference, which needs no extra field: **if a
 * CHANGES_REQUESTED review counted, `reviewDecision` would BE
 * CHANGES_REQUESTED.** It reads REVIEW_REQUIRED, so that review is advisory.
 * GitHub has already done the permission arithmetic; reading its answer is more
 * reliable than recomputing it.
 */
describe('who is actually holding this PR', () => {
  it('#4547 today: the codeowner team, not the bot that requested changes', () => {
    const b = mergeBlocker({
      state: 'OPEN',
      reviewDecision: 'REVIEW_REQUIRED',
      reviewRequests: ['Default Reviewers'],
      latestReviews: [{ author: 'pr-swarm', state: 'CHANGES_REQUESTED' }],
    });
    expect(b).not.toBeNull();
    expect(b!.who).toBe('Waiting for an approving review from Default Reviewers.');
    // Named, so the operator knows it exists — but plainly marked as unable
    // to block.
    expect(b!.advisory).toContain('pr-swarm');
    expect(b!.advisory).toContain('cannot approve or block');
  });

  it('does NOT name the bot as the blocker', () => {
    const b = mergeBlocker({
      state: 'OPEN',
      reviewDecision: 'REVIEW_REQUIRED',
      reviewRequests: ['Default Reviewers'],
      latestReviews: [{ author: 'pr-swarm', state: 'CHANGES_REQUESTED' }],
    });
    expect(b!.who).not.toContain('pr-swarm');
  });

  it('when a reviewer WITH write access requests changes, they ARE the blocker', () => {
    // GitHub says so itself by reporting the decision as CHANGES_REQUESTED.
    const b = mergeBlocker({
      state: 'OPEN',
      reviewDecision: 'CHANGES_REQUESTED',
      reviewRequests: [],
      latestReviews: [{ author: 'reviewer-one', state: 'CHANGES_REQUESTED' }],
    });
    expect(b!.who).toBe('reviewer-one has requested changes.');
    expect(b!.advisory).toBeNull();
  });

  it('names every requested reviewer when there are several', () => {
    const b = mergeBlocker({
      state: 'OPEN',
      reviewDecision: 'REVIEW_REQUIRED',
      reviewRequests: ['Default Reviewers', 'reviewer-one'],
      latestReviews: [],
    });
    expect(b!.who).toBe('Waiting for an approving review from Default Reviewers and reviewer-one.');
  });

  it('stays honest when nobody has been requested yet', () => {
    const b = mergeBlocker({ state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [], latestReviews: [] });
    expect(b!.who).toBe('Waiting for an approving review from someone with write access.');
  });

  it('is silent once GitHub says approved', () => {
    expect(mergeBlocker({ state: 'OPEN', reviewDecision: 'APPROVED', reviewRequests: [], latestReviews: [] })).toBeNull();
  });

  it('is silent on a merged or closed PR', () => {
    expect(mergeBlocker({ state: 'MERGED', reviewDecision: null, reviewRequests: [], latestReviews: [] })).toBeNull();
    expect(mergeBlocker({ state: 'CLOSED', reviewDecision: null, reviewRequests: [], latestReviews: [] })).toBeNull();
  });

  it('refuses to guess when GitHub reports no decision at all', () => {
    // The same honesty handover.ts already keeps: an unreadable verdict is said
    // out loud, never smoothed into "probably fine".
    const b = mergeBlocker({ state: 'OPEN', reviewDecision: null, reviewRequests: [], latestReviews: [] });
    expect(b!.who).toContain('could not read');
  });

  it('#5358 today: a DRAFT is held by nobody — GitHub has asked no one', () => {
    // The two-week bug. PR #5358 (#4375) and PR #5294 (#5269) both sat reading
    // "Waiting for an approving review from someone with write access." The
    // generic wording was the evidence: `reviewRequests` was EMPTY, because
    // GitHub dispatches no CODEOWNERS request until a draft is marked ready —
    // and `claude-code-review.yml` fires on `ready_for_review` for the same
    // reason. There was no reviewer, and none was coming.
    const b = mergeBlocker({
      state: 'OPEN',
      reviewDecision: 'REVIEW_REQUIRED',
      reviewRequests: [],
      latestReviews: [],
      isDraft: true,
    });
    expect(b).toBeNull();
  });

  it('will not call an unreadable decision a blocker on a draft either', () => {
    // GitHub commonly reports no decision at all on a draft. "Could not read a
    // review state" would be a second way of saying somebody is looking at it.
    const b = mergeBlocker({ state: 'OPEN', reviewDecision: null, reviewRequests: [], latestReviews: [], isDraft: true });
    expect(b).toBeNull();
  });

  it('still names a reviewer who DID look at a draft', () => {
    // Draftness does not erase a review that happened. Somebody looked, GitHub
    // counted it, and what they asked for is real work — the draft item the
    // operator owns is added alongside this by waiting.ts, not instead of it.
    const b = mergeBlocker({
      state: 'OPEN',
      reviewDecision: 'CHANGES_REQUESTED',
      reviewRequests: [],
      latestReviews: [{ author: 'reviewer-one', state: 'CHANGES_REQUESTED' }],
      isDraft: true,
    });
    expect(b!.who).toBe('reviewer-one has requested changes.');
  });

  it('is unchanged for a PR that is not a draft', () => {
    // The flag is optional and absent on every other call site: a missing
    // `isDraft` must never quietly turn a real reviewer into nobody.
    const b = mergeBlocker({ state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', reviewRequests: ['reviewer-one'], latestReviews: [], isDraft: false });
    expect(b!.who).toBe('Waiting for an approving review from reviewer-one.');
  });

  it('does not call an APPROVED review advisory', () => {
    // Only a CHANGES_REQUESTED that failed to move the decision is advisory.
    const b = mergeBlocker({
      state: 'OPEN',
      reviewDecision: 'REVIEW_REQUIRED',
      reviewRequests: ['Default Reviewers'],
      latestReviews: [{ author: 'claude', state: 'APPROVED' }],
    });
    expect(b!.advisory).toBeNull();
  });
});
