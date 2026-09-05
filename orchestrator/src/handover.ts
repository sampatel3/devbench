/**
 * Can this PR actually be handed to a codeowner?
 *
 * Gate E's whole question is "is this ready to hand over", and until 2026-08-13
 * the console answered it without ever looking at the PR. It tracked its OWN
 * review rounds instead, and a round marked `resolvedBy: 'operator'` — meaning the
 * operator pressed the button that sent the rework back — retired the round and
 * let the worker walk to Gate E. The reviewer had not moved. PR #4535 presented
 * as "ready to hand to the codeowner" carrying CHANGES_REQUESTED, the
 * `changes-requested` label, and `reviewDecision: REVIEW_REQUIRED`.
 *
 * The two ideas the console had conflated:
 *   - the operator answered the round → the ASK is dealt with. Console-side fact.
 *   - the reviewer approved           → the PR is mergeable. GitHub's fact, and
 *                                       the only one that decides a handover.
 *
 * So this reads GitHub's own verdict and nothing else. It is deliberately not
 * clever: every state that is not plainly approvable blocks, because the cost of
 * a false "ready" is the operator handing a codeowner a PR that cannot merge, and
 * the cost of a false "not ready" is one glance at the card.
 */
export type HandoverPr = {
  /** OPEN / MERGED / CLOSED. */
  state?: string | null;
  /** GitHub's verdict: APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / ''. */
  reviewDecision?: string | null;
  /** The repo's own label, meaning a reviewer asked for something not yet pushed. */
  changesRequested?: boolean;
  isDraft?: boolean;
};

export type Handover = {
  ready: boolean;
  /** One line, in the operator's terms, saying what stands between here and a
   *  merge. */
  why: string;
};

export function handoverBlock(pr: HandoverPr | null): Handover | null {
  // No PR: Gate E is not about a handover yet, so there is nothing to judge.
  if (pr === null) return null;

  // A MERGED or CLOSED PR has no handover left. It carries no reviewDecision
  // either, so without this it fell into "could not read" and three finished,
  // QA-signed-off issues read as BLOCKED an hour after this function shipped.
  const state = (pr.state ?? '').toUpperCase();
  if (state === 'MERGED' || state === 'CLOSED') return null;

  if (pr.isDraft) {
    return { ready: false, why: 'this PR is still a draft — nobody merges a draft' };
  }

  // The label is the repo's own convention and the worker removes it when it
  // pushes a fix. While it is on, a reviewer is waiting on something.
  if (pr.changesRequested) {
    return {
      ready: false,
      why: 'a reviewer has requested changes and the `changes-requested` label is still on the PR',
    };
  }

  const decision = (pr.reviewDecision ?? '').toUpperCase();

  // An unread field must never become a verdict in either direction. Saying
  // "blocked" would be as much a lie as saying "ready"; this says "unverified"
  // and leaves the judgement with the operator.
  if (decision === '') {
    return { ready: false, why: 'could not read the review state from GitHub — check the PR before handing it over' };
  }
  if (decision === 'CHANGES_REQUESTED') {
    return { ready: false, why: 'the standing review requests changes' };
  }
  if (decision === 'REVIEW_REQUIRED') {
    return { ready: false, why: 'GitHub still wants an approving review from a codeowner' };
  }
  if (decision !== 'APPROVED') {
    // A state we have not seen. Refuse rather than guess in the merge direction.
    return { ready: false, why: `unrecognised review state \`${decision}\` — check the PR before handing it over` };
  }

  return { ready: true, why: 'approved, and no changes outstanding' };
}
