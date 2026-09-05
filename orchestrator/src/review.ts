/**
 * The rework loop, read-only. When a tracked issue's open PR gets a review that
 * REQUESTS CHANGES, the console surfaces it as actionable rework: the operator
 * kicks it off, the same worker resumes with the requested changes and pushes to
 * its own PR branch (as Stage 7 already does). This file only READS reviews; it
 * writes nothing to GitHub. Mirrors the shape of comment.ts's reply tracking.
 *
 * A round also has to be able to end WITHOUT the operator, because the rework
 * often happens somewhere else — in an interactive session, by hand. An ask that
 * has already been dealt with must not sit there orange, lying. `resolveRound` is
 * that check: three read-only signals off the PR itself, no button to click.
 */

/** How a round stopped being the one waiting on the operator. */
export type ResolvedBy =
  /** The operator started the rework from the console. `sam` is the legacy wire
   *  value written into every gate file on disk; renaming it would strand every
   *  round already persisted. */
  | 'operator'
  /** the reviewer moved on, or asked again — the old ask is history either way */
  | 'superseded'
  /** the rework was done outside the console: pushed and the label cleared, or
   *  the PR simply merged with the ask still open */
  | 'external';

/** One review round: what was asked, and — once handled — how it ended. */
export type ReviewRound = {
  round: number;
  reviewer: string;
  requestedAt: string;
  requestedChanges: string;
  /** The operator's resume prompt, stamped when the rework is started. null =
   *  they never started it. */
  decision: string | null;
  resumedAt: string | null;
  /** The Claude account that did this round, stamped when the rework is started. */
  account?: string | null;
  /** What took this round out of the actionable state. Absent = still waiting on
   *  the operator. Rounds recorded before auto-resolution existed have none of
   *  these three, which reads exactly the same as "still waiting" — the honest
   *  default. */
  resolvedBy?: ResolvedBy | null;
  resolvedAt?: string | null;
  /** Plain English, for the history: "handled outside the console — …". */
  resolution?: string | null;
};

/** The append-only round history for one PR. The last round that is still
 *  actionable is the one waiting on the operator. */
export type ReviewBlock = { pr: number; rounds: ReviewRound[] };

/** A round is actionable while nobody has started it and nothing has resolved it. */
export function isActionable(round: ReviewRound): boolean {
  return round.decision === null && !round.resolvedBy;
}

/**
 * The change-request we act on: the newest review with state CHANGES_REQUESTED
 * whose submittedAt is strictly after `sinceIso` and whose author is not us (so
 * bot reviewers count). Pass the PR's latest-per-reviewer list so a reviewer who
 * later approved does not read as still requesting changes. Null if there is none.
 */
export function detectChangeRequest(
  reviews: unknown[],
  sinceIso: string,
  me: string,
): { reviewer: string; submittedAt: string; body: string } | null {
  const sinceMs = Date.parse(sinceIso);
  let best: { reviewer: string; submittedAt: string; body: string } | null = null;
  let bestMs = -Infinity;
  for (const rv of reviews) {
    if (typeof rv !== 'object' || rv === null) continue;
    const r = rv as { author?: { login?: unknown }; state?: unknown; submittedAt?: unknown; body?: unknown };
    if (r.state !== 'CHANGES_REQUESTED') continue;
    const login = typeof r.author?.login === 'string' ? r.author.login : '';
    const submittedAt = typeof r.submittedAt === 'string' ? r.submittedAt : '';
    if (!login || !submittedAt) continue;
    if (login === me) continue;
    const ms = Date.parse(submittedAt);
    if (Number.isNaN(ms) || !(ms > sinceMs)) continue; // strictly after
    if (ms > bestMs) {
      bestMs = ms;
      best = { reviewer: login, submittedAt, body: typeof r.body === 'string' ? r.body : '' };
    }
  }
  return best;
}

/** A change-request, from wherever we found it, as a fresh round on the block. */
export function nextRound(
  rounds: ReviewRound[],
  cr: { reviewer: string; submittedAt: string; body: string },
): ReviewRound {
  return {
    round: rounds.length + 1,
    reviewer: cr.reviewer,
    requestedAt: cr.submittedAt,
    requestedChanges: cr.body,
    decision: null,
    resumedAt: null,
  };
}

/** The tracker repo's own convention: this label means "nothing pushed for this
 *  ask yet", and the worker deletes it once the rework is pushed. */
export const CHANGES_REQUESTED_LABEL = 'changes-requested';

/** The PR as it stands right now — the only things the resolver is allowed to see. */
export type ReviewSignals = {
  /** the latest review per reviewer, `gh pr view --json latestReviews` */
  latestReviews: Array<{ author: { login: string }; state: string; submittedAt: string; body: string }>;
  /** the PR's labels right now */
  labels: string[];
  /** every commit on the PR */
  commits: Array<{ committedDate: string }>;
};

export type Resolution = {
  resolvedBy: ResolvedBy;
  /** plain English, stored on the round and shown in the history */
  resolution: string;
  /** (b) only — the newer change-request that takes this round's place. */
  supersededBy?: { reviewer: string; submittedAt: string; body: string };
};

/** Strictly after, and false rather than throwing on anything unparseable. */
function after(iso: string, thanIso: string): boolean {
  const a = Date.parse(iso);
  const b = Date.parse(thanIso);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

/**
 * Has this round already been dealt with, without the operator? Three signals,
 * all read off the PR:
 *
 *  (a) the reviewer WITHDREW the ask — they later APPROVED, or their review is
 *      gone (dismissed). NOT merely "their latest word isn't CHANGES_REQUESTED":
 *      GitHub does not let a COMMENTED review dismiss a standing changes-request.
 *      The PR page keeps showing "1 requested change" and the merge stays blocked,
 *      so treating COMMENTED as withdrawal told the operator they were clear
 *      while GitHub still said otherwise. Only APPROVED / DISMISSED / absent
 *      count.
 *  (b) the same reviewer asked AGAIN, after this round — the old ask is history
 *      and the new one takes its place;
 *  (c) it was handled outside the console — the `changes-requested` label is gone
 *      AND a commit landed after the ask.
 *
 * (c) needs BOTH halves on purpose. A missing label alone proves nothing (nobody
 * may have set it), and a commit alone proves nothing (the round can be about
 * work that was pushed and still rejected). Clearing an ask that is still real
 * loses the operator the ask, so the bar is deliberately high.
 *
 * And, before all three: **the PR merged.** A CHANGES_REQUESTED review's state
 * does not change when a PR merges, so (a)–(c) would leave the orange card
 * standing for ever on work that is finished — which is exactly what was
 * happening to the rounds on the PRs that merged on 2026-08-11. Merged is
 * checked FIRST because it is unconditional: whatever the reviewers did or did
 * not do afterwards, the ask has been overtaken.
 *
 * Null = still actionable. Nothing here deletes anything.
 */
export function resolveRound(round: ReviewRound, signals: ReviewSignals, prState = 'OPEN'): Resolution | null {
  if (prState === 'MERGED') {
    return {
      resolvedBy: 'external',
      resolution: 'the PR merged with this round open — overtaken by events',
    };
  }
  const latest = signals.latestReviews.find((r) => r.author?.login === round.reviewer) ?? null;

  // (a) the reviewer WITHDREW the ask. A COMMENTED review does not: GitHub keeps
  // the changes-request standing (the PR still reads "1 requested change"), so
  // only an approval, a dismissal, or the review being gone clears it here.
  if (!latest) {
    return {
      resolvedBy: 'superseded',
      resolution: `superseded — ${round.reviewer} has no review on this PR any more`,
    };
  }
  if (latest.state === 'APPROVED' || latest.state === 'DISMISSED') {
    return {
      resolvedBy: 'superseded',
      resolution: `superseded — ${round.reviewer} now ${latest.state}`,
    };
  }

  // (b) the same reviewer asked again after this round. Only another
  // CHANGES_REQUESTED counts — a later COMMENTED review is not a new ask, and
  // treating it as one would close this round while its ask is still standing.
  if (latest.state === 'CHANGES_REQUESTED' && after(latest.submittedAt, round.requestedAt)) {
    return {
      resolvedBy: 'superseded',
      resolution: `superseded by the ${latest.submittedAt.slice(0, 10)} review`,
      supersededBy: { reviewer: round.reviewer, submittedAt: latest.submittedAt, body: latest.body },
    };
  }

  // (c) rework pushed elsewhere, and the label taken off to say so.
  const labelGone = !signals.labels.includes(CHANGES_REQUESTED_LABEL);
  const pushedSince = signals.commits.some((c) => after(c.committedDate, round.requestedAt));
  if (labelGone && pushedSince) {
    return {
      resolvedBy: 'external',
      resolution: 'handled outside the console — rework pushed and label cleared',
    };
  }

  return null;
}

/**
 * The operator answering a round and the reviewer clearing it are two different
 * events, and until 2026-08-13 the console had one field for both.
 *
 * `resolvedBy: 'operator'` is set when the operator presses the button that sends the
 * rework back. That correctly stops the round ASKING them anything — it is no
 * longer actionable, and the card should not keep demanding an answer they have
 * given. But it was also read as "this round is finished", and a finished round
 * left nothing on the row at all. #4344 therefore looked clean and walked to
 * Gate E while a review bot had two standing CHANGES_REQUESTED reviews on
 * PR #4535.
 *
 * The dangerous half is closed elsewhere: `handoverBlock` reads GitHub's verdict
 * and refuses the handover. This is the quiet half — the row going silent about a
 * review that is still open. Only the REVIEWER can clear a review, so that is the
 * only thing consulted here.
 *
 * Null means nothing to say: no round was ever sent back, the reviewer has moved
 * on, or GitHub could not be read — and an unread field must never invent a state.
 */
export function reviewOutstanding(
  rounds: ReviewRound[],
  pr: { reviewDecision?: string | null; changesRequested?: boolean },
): { reviewer: string; why: string; sentAt: string | null } | null {
  // Only rounds THEY have answered. One still waiting on the operator is the
  // gate card's job.
  const sent = rounds.filter((r) => r.resolvedBy === 'operator');
  if (sent.length === 0) return null;

  const decision = (pr.reviewDecision ?? '').toUpperCase();
  // An unread verdict is not an outstanding review. Saying "still blocked" on a
  // failed poll would be the same class of lie as saying "ready".
  if (decision === '' && !pr.changesRequested) return null;

  const stillAsking = pr.changesRequested === true || decision === 'CHANGES_REQUESTED' || decision === 'REVIEW_REQUIRED';
  if (!stillAsking) return null;

  const last = sent[sent.length - 1]!;
  return {
    reviewer: last.reviewer,
    why: `the rework went back on ${(last.resumedAt ?? '').slice(0, 10) || 'an earlier round'}, but ${last.reviewer} has not cleared the review`,
    sentAt: last.resumedAt ?? null,
  };
}
