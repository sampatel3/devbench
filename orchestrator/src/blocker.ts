/**
 * Who is actually holding a pull request.
 *
 * On PR #4547 the operator asked whether it was the review bot holding the PR or
 * the human approver — the human approver, and the console had been saying it was
 * the bot. That sends a person chasing a bot which cannot merge anything even if
 * it relents. GitHub was unambiguous on that PR: the decision read
 * REVIEW_REQUIRED, the bot's CHANGES_REQUESTED carried
 * `authorCanPushToRepository = false`, and the pending request was on the
 * codeowner team.
 *
 * THE INFERENCE THIS RESTS ON, which needs no extra field: if a CHANGES_REQUESTED
 * review counted, `reviewDecision` would BE `CHANGES_REQUESTED`. When the
 * decision reads `REVIEW_REQUIRED` while such a review exists, GitHub has already
 * decided that review does not count. Reading its answer beats recomputing the
 * permission arithmetic ourselves and disagreeing with the merge button.
 *
 * A read-only review is still worth naming — it is real work for a worker to
 * address (see the skill's Stage 7 rule) — but it must never be printed as the
 * thing standing between this PR and a merge.
 */
export type Blocker = {
  /** Who is holding it, as a sentence. */
  who: string;
  /** A review that cannot block, named so nobody chases it. */
  advisory: string | null;
};

export type BlockerInput = {
  state: string;
  reviewDecision: string | null | undefined;
  /** Reviewers GitHub is waiting on — team names or logins. */
  reviewRequests: string[];
  latestReviews: Array<{ author: string; state: string }>;
  /** A draft has asked nobody, so nobody else is holding it. See below. */
  isDraft?: boolean;
};

/** "a and b", "a, b and c" — a list a person would read aloud. */
function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function mergeBlocker(input: BlockerInput): Blocker | null {
  if (input.state !== 'OPEN') return null;

  const decision = (input.reviewDecision ?? '').trim();
  if (decision === 'APPROVED') return null;

  if (decision === 'CHANGES_REQUESTED') {
    // GitHub reports this only when the requester can actually push, so whoever
    // asked IS the gate. No advisory line: the blocker and the reviewer are one.
    const who = input.latestReviews.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.author);
    return {
      who: who.length ? `${list(who)} ${who.length > 1 ? 'have' : 'has'} requested changes.` : 'A reviewer has requested changes.',
      advisory: null,
    };
  }

  // A DRAFT HAS ASKED NOBODY, so nobody else is holding it.
  //
  // GitHub dispatches CODEOWNERS review requests only when a PR is marked ready,
  // and `claude-code-review.yml` fires on `ready_for_review` for the same reason
  // (docs/INFO.md, "The review layer"). So on a draft `REVIEW_REQUIRED` means "no
  // review has been requested", not "a reviewer is sitting on it", and an
  // unreadable decision means nothing at all. Neither is a person to wait for.
  //
  // #4375 (PR #5358) and #5269 (PR #5294) each sat for weeks under "Waiting for
  // an approving review from someone with write access. Nothing for you to do."
  // — a reviewer nobody had asked, and an instruction to leave alone the one row
  // that needed a click. The generic wording was the tell: `reviewRequests` was
  // empty because GitHub had requested nobody, and it never would while the PR
  // stayed a draft. Both gates read green, both workers had finished, and the
  // rows sat in the `elsewhere` tier where the sort keeps things that are moving.
  //
  // The CHANGES_REQUESTED branch above is deliberately BEFORE this one: somebody
  // did look, and what they asked for is real work whether or not the PR is a
  // draft. What is the operator's — the click that makes any of this reachable —
  // is not a blocker at all and belongs in `waiting.yours`, which is where
  // waiting.ts puts it. This function only ever answers "who ELSE is holding it".
  if (input.isDraft) return null;

  if (decision === 'REVIEW_REQUIRED') {
    const requested = input.reviewRequests.filter((r) => r.trim() !== '');
    const who = requested.length
      ? `Waiting for an approving review from ${list(requested)}.`
      : 'Waiting for an approving review from someone with write access.';

    // Any CHANGES_REQUESTED still standing here failed to move the decision,
    // which is GitHub's way of saying its author has no write access.
    const toothless = input.latestReviews.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.author);
    const advisory = toothless.length
      ? `${list(toothless)} requested changes, but cannot approve or block the merge — read-only reviewer${toothless.length > 1 ? 's' : ''}.`
      : null;

    return { who, advisory };
  }

  // Same honesty handover.ts keeps: an unreadable verdict is said out loud
  // rather than smoothed into something reassuring.
  return { who: 'GitHub could not read a review state for this PR — check it before relying on this.', advisory: null };
}
