/**
 * "Everything on GitHub that needs the operator", as a list.
 *
 * Pure: an omnibus payload and some local context go in, `Action[]` comes out.
 * No network, no clock of its own, no writes — the feed links OUT to GitHub and
 * `comment.ts` remains the only thing in this console that ever writes to it.
 *
 * The one fact the whole file turns on: the post-UAT human verdict lands on the
 * ISSUE as a free-text comment with no label, and it is what tier 1 is for. The
 * `changes-requested` label is the pre-merge review bot's, it lands on
 * essentially every feature PR the operator opens, and putting it in tier 1 would
 * push "fix first" to their phone on every PR — the failure mode that gets a
 * notifier muted for ever. It is tier 2 here, and `review.ts` still owns its
 * rework loop.
 *
 * Tier 1 has a second member, and it is the same fact one step later:
 * `closed-over-fail`, a ticket whose fix shipped and which was then closed with
 * the send-back still the newest word on it. Only `uat-fail` reaches the phone
 * on its own — see `KindMeta.push`, the only thing notify.ts reads to decide it.
 */

import type { ActionsPayload, GhActionsIssue } from './gh.js';
import { isHumanUatVerdict, isPostMergeHumanComment, mentionsVerdictHeading, type UatComment, type UatVerdictKind, revisitSendBack } from './uat.js';

/** 1 = fix first. 2 = needs a response from you. 3 = FYI. */
export type ActionTier = 1 | 2 | 3;

export type KindMeta = {
  tier: ActionTier;
  /** What the row says it is, in the operator's words. */
  label: string;
  /**
   * May this kind ever be pushed to the phone on its own?
   *
   * Exactly one kind may. Everything else is the feed and the badge, or is
   * bundled into a single "N new actions" push — because a push per bot round or
   * per comment is a push nobody reads.
   */
  push: boolean;
};

/**
 * Every kind this build knows. `Action.kind` is deliberately a `string`: a new
 * kind ships by adding a row here, and an older UI renders an unknown one
 * through `UNKNOWN_KIND_META` instead of crashing.
 */
export const KIND_META: Record<string, KindMeta> = {
  // Tier 1 — the post-UAT send-back. Outranks P0, and the only kind in this
  // table that pushes on its own.
  'uat-fail': { tier: 1, label: 'UAT fail', push: true },
  // Tier 1, and NOT a push. The ticket SHIPPED a fix for a send-back and was
  // then closed with nothing re-testing it — 4 of 105 closures, #4619, #5019,
  // #5139 and #4344 — so it is fix-first by the same rule `uat-fail` is. It does
  // not reach the phone alone, because it is a fact about work that has already
  // stopped rather than an interruption; a live send-back on an open issue is
  // still `uat-fail` and still pushes. One more kind buzzing a phone is how the
  // whole notifier gets muted.
  'closed-over-fail': { tier: 1, label: 'closed over a QA fail', push: false },

  // Tier 2 — needs a response, but does not outrank triage.
  'changes-requested': { tier: 2, label: 'changes requested', push: false },
  'uat-fail-inflight': { tier: 2, label: 'UAT fail — fix in flight', push: false },
  'review-requested': { tier: 2, label: 'review asked of you', push: false },
  mention: { tier: 2, label: 'mentioned', push: false },
  comment: { tier: 2, label: 'new comment', push: false },
  'ci-failed': { tier: 2, label: 'CI red', push: false },
  assigned: { tier: 2, label: 'newly assigned', push: false },

  // Tier 3 — FYI. Never pushed, never counted as waiting on the operator.
  'uat-unparsed': { tier: 3, label: 'comment after merge', push: false },
  'uat-pass': { tier: 3, label: 'UAT pass', push: false },
  'lane-change': { tier: 3, label: 'board moved', push: false },
  merged: { tier: 3, label: 'merged', push: false },
};

export const UNKNOWN_KIND_META: KindMeta = { tier: 2, label: 'action', push: false };

export function metaFor(kind: string): KindMeta {
  return KIND_META[kind] ?? UNKNOWN_KIND_META;
}

export type Action = {
  /**
   * Stable across polls and across a console restart, because every part of it
   * is GitHub's own: a comment `databaseId`, a commit oid, a review timestamp.
   * Never the poll time — that is what makes notify-once work.
   */
  id: string;
  kind: string;
  tier: ActionTier;
  subject: { type: 'issue' | 'pr'; number: number; title: string; url: string };
  /** Who did the thing. Empty when GitHub gives no author. */
  actor: string;
  /** When it landed on the operator. */
  eventAt: string;
  /** Plain English, why this is on the operator. */
  reason: string;
  /** First line of the body, trimmed. Never the whole thing, never null-typed away. */
  detail: string | null;
  /** Where the click goes on GitHub — the comment anchor when there is one. */
  url: string;
  /** The console row that owns this, when one exists. */
  consoleIssue: number | null;
  /** Only on a UAT verdict. */
  verdict?: UatVerdictKind;
};

export type DeriveContext = {
  /** The gh viewer. */
  me: string;
  now: Date;
  /** When the operator last said "seen". Tier 2–3 news older than this is retired;
   *  tier 1 ignores it entirely — a to-do does not expire because they glanced at it. */
  seenAt: string | null;
  lookbackMs: number;
  /** Issues with a worktree on this machine. */
  trackedIssues: Set<number>;
  /** Issues parked at a gate, waiting on the operator locally. Their card already
   *  says so, so the feed does not repeat it as news. */
  atGate: Set<number>;
  /** Issues whose PR `review.ts` already tracks as an actionable rework round. */
  reworkIssues: Set<number>;
  /** Last local activity on each issue's branch — the third decay signal, and the
   *  one that catches the operator fixing something interactively. */
  branchActivity: Map<number, string>;
  /** Issues already known to be assigned to them. An issue in here is a row, not
   *  news. Seeded from the first payload so first boot is silent. */
  knownAssigned: Set<number>;
  /** Issues where the work is already moving without the operator: a worker is live
   *  on it (running or paused), it is queued to run next, or the console owes it a
   *  resume they have already authorised. See `alreadyHandled`. */
  inFlight: Set<number>;
  /**
   * Board moves the CONSOLE made. GitHub's ProjectV2 field change carries no
   * actor at all, so the console's own write comes back through the poll wearing
   * exactly the shape of "a person moved this card" — and would be reported to
   * the operator as news about themselves. Keyed by issue; `to` and `at` are what
   * a matching lane-change looks like.
   */
  ownBoardMoves?: Map<number, { to: string; at: string }>;
};

/**
 * The one rule for "this is not on you", and it is about ONE kind: `assigned`.
 *
 * "Newly assigned" is only an action while nobody and nothing else owns the next
 * move. Five issues were listed as "waiting on you" that needed nothing from
 * anyone: two whose work had merged, two with a worker live on them, and one queued
 * to run next. Each was true as GitHub news and false as a to-do, and the feed
 * had no way to tell the difference because the only console state it consulted
 * was `atGate`.
 *
 * `comment` is NOT in here, and that is the whole point of scoping it:
 *
 *  - nothing in this console reads GitHub issue comments back to the operator. No worker
 *    answers them, no gate card renders them. "Do not ship this, the endpoint
 *    changed" landing on #4487 while a worker builds #4487 is the single moment
 *    it is most needed, and suppressing it there hid it — permanently,
 *    because `seenAt` moves the news floor forward on the next "Mark all seen";
 *  - a merged PR is the PRECONDITION for the tier-1 `uat-fail` kind and for the
 *    `uat-unparsed` valve, so a blanket "merged ⇒ not an action" would delete
 *    the one kind this feed exists for.
 *
 * A human still talking to you is still talking to you, whatever the console is
 * doing about it. It is "newly assigned" that goes stale, not the conversation.
 *
 * A worker that died at a CHECKPOINT is in none of these sets, so its row stays:
 * nobody is working it, so it is on the operator again. One that died parked at a GATE
 * is a different thing — `atGate` is read off `.gate.json`, not off a live
 * process — and clause (a) still holds it, which is right: that card renders
 * `at-gate` with its buttons, so a feed row would only be saying it twice.
 *
 * Suppression here DEFERS the row; it must never spend it. See where
 * `knownAssigned` is stamped in `orchestrator.ts`.
 */
export function alreadyHandled(issue: GhActionsIssue, ctx: DeriveContext): boolean {
  // (a) The gate card already says "waiting on you", loudly, with buttons.
  if (ctx.atGate.has(issue.number)) return true;
  // (b) A worker is live or paused on it, it is queued, or a resume is owed.
  if (ctx.inFlight.has(issue.number)) return true;
  // (c) Shipped — and it has to be THIS issue's own work that shipped.
  //     `referencingPrs` is every `CROSS_REFERENCED_EVENT`, so any merged PR
  //     whose body merely says `#4502` is in the set, and somebody else's PR
  //     shipping says nothing about whether #4502 is on the operator. The branch-name
  //     test is the one the `changes-requested` row already uses.
  //
  //     Known limit: an issue REOPENED after its own merge and handed back is
  //     suppressed by this too, and the payload carries no assignment or reopen
  //     timestamp to date the merge against. It is not silent in practice — the
  //     reason for the reopen arrives as a verdict, a valve row, a `comment` or
  //     a `lane-change`, none of which this rule touches — but "newly assigned"
  //     is the one thing it will not say.
  return issue.referencingPrs.some((p) => p.mergedAt !== null && p.headRefName.includes(String(issue.number)));
}

const at = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

const firstLine = (body: string): string | null => {
  const l = body.split('\n').find((x) => x.trim() !== '');
  if (l === undefined) return null;
  const trimmed = l.trim();
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}…` : trimmed;
};

/** The label that must never become an action: 351 PRs carry it and nothing ever
 *  removes it, so a feed that counted it would light up permanently. */
export const NEVER_AN_ACTION_LABEL = 'human-review-needed';

/** The board lane that means "shipped, awaiting UAT" — 110 items sit in it. */
export const UAT_LANE = 'QA';

const toUatComment = (c: GhActionsIssue['comments'][number]): UatComment => c;

/**
 * The newest human UAT verdict on an issue, or null. ONE call into `uat.ts`;
 * there is no second implementation of the predicate anywhere in this console.
 *
 * Exported for the close record (`close-verdict.ts`), which asks the same
 * question at a different moment — what QA had said when the ticket closed. That
 * record decides what a closed row says about itself, so it must be the same
 * predicate the feed uses, not a second reading of the same comments.
 */
export function newestUatVerdict(
  issue: GhActionsIssue,
  me: string,
): { comment: GhActionsIssue['comments'][number]; verdict: UatVerdictKind } | null {
  let best: { comment: GhActionsIssue['comments'][number]; verdict: UatVerdictKind } | null = null;
  for (const c of issue.comments) {
    const verdict = isHumanUatVerdict(toUatComment(c), { me, mergedAt: issue.mergedAt });
    if (!verdict) continue;
    if (!best || at(c.createdAt) > at(best.comment.createdAt)) best = { comment: c, verdict };
  }
  return best;
}

/**
 * Is a fix already under way for this verdict?
 *
 * Mirrors `resolveRound` in review.ts, which earns its keep precisely because
 * rework usually happens outside the console. A verdict that sits red at the top
 * for days while the operator fixes it interactively is a broken feature, so three
 * signals, all dated strictly after the verdict:
 *
 *   'shipped'  — a referencing PR MERGED. The fix is out; QA's ball again.
 *   'inflight' — a referencing PR is OPEN and was opened or PUSHED TO after the
 *                verdict, or the branch was touched. They are on it.
 *
 * Deliberately not "any PR exists": the PR that FAILED UAT also references the
 * issue, and it predates the verdict.
 *
 * `lastCommitAt` is the third signal and it closes a real hole. `createdAt`
 * only sees a fix that opened a NEW PR; `branchActivity` only sees a fix in a
 * worktree that still exists, and a post-merge UAT fail is exactly when the
 * worktree has usually been cleaned up. A fix pushed to a PR that already
 * existed had NO signal, so the row sat tier-1 red for days while the operator was
 * visibly working on it — which is the failure this whole function exists to
 * prevent.
 */
function fixProgress(issue: GhActionsIssue, verdictAt: string, branchAt: string | undefined): 'shipped' | 'inflight' | null {
  const after = (iso: string | null): boolean => iso !== null && at(iso) > at(verdictAt);
  if (issue.referencingPrs.some((p) => after(p.mergedAt))) return 'shipped';
  if (issue.referencingPrs.some((p) => p.state === 'OPEN' && (after(p.createdAt) || after(p.lastCommitAt)))) return 'inflight';
  if (after(branchAt ?? null)) return 'inflight';
  return null;
}

export function deriveActions(payload: ActionsPayload, ctx: DeriveContext): Action[] {
  const out: Action[] = [];
  const nowMs = ctx.now.getTime();
  const floor = Math.max(nowMs - ctx.lookbackMs, ctx.seenAt ? at(ctx.seenAt) : 0);
  /** Tier 2–3 news is gated; tier 1 state never is. */
  const isNews = (iso: string): boolean => at(iso) > floor;

  const push = (a: Omit<Action, 'tier'>): void => {
    out.push({ ...a, tier: metaFor(a.kind).tier });
  };

  for (const issue of payload.issues) {
    const subject = { type: 'issue' as const, number: issue.number, title: issue.title, url: issue.url };
    const consoleIssue = ctx.trackedIssues.has(issue.number) ? issue.number : null;
    const verdict = newestUatVerdict(issue, ctx.me);
    // A CLOSED issue is in this payload for ONE reason: a send-back that arrived
    // on or after the close. #4914 is the instance — `Test Result: Fail` posted
    // and the issue closed as COMPLETED in the same second, `Revisit` twelve
    // seconds later — and until it appeared, closed issues were not read at all.
    //
    // Everything else a closed issue could say is finished work. A week of
    // passes, assignments, comments and lane moves would bury the one thing that
    // is not finished, so the four that describe a life already lived are
    // suppressed here rather than at the source: the send-back rules below need
    // the same issue, whole. See `buildActionsSearchArgs`.
    const closed = issue.closed;

    // A send-back said on the BOARD rather than in a comment. Only consulted when
    // no parsed verdict exists: a real `Test Result:` comment is the better
    // record — it names its author and carries their words — and must not be
    // displaced by the lane. #4847 had neither graded, so the row sat at low tier
    // while a P1 regression was open.
    const lane = verdict ? null : revisitSendBack({ lane: issue.lane, laneAt: issue.laneAt }, { mergedAt: issue.mergedAt });
    if (lane && isNews(lane.at)) {
      const laneProgress = fixProgress(issue, lane.at, ctx.branchActivity.get(issue.number));
      if (laneProgress !== 'shipped') {
        push({
          id: `uat-fail:issue#${issue.number}:revisit:${lane.at}`,
          kind: laneProgress === 'inflight' ? 'uat-fail-inflight' : 'uat-fail',
          subject,
          actor: '',
          eventAt: lane.at,
          reason: `#${issue.number} was moved to Revisit after its PR merged — sent back from testing`,
          // NOT "from UAT". A merge lands on `dev`, and a Revisit can come from
          // testing on EITHER dev or UAT. Assuming UAT is how the #4847 analysis
          // went wrong: it concluded "the fix was never promoted" when the tester
          // may well have been on dev, where the fix was present and the defect
          // reproduced anyway. Check dev first; only call it a promotion gap once
          // the comment actually says UAT.
          detail: 'the board says so, not a Test Result comment — check dev before assuming UAT',
          url: issue.url,
          consoleIssue,
          verdict: lane.verdict,
        });
      }
    }

    if (verdict) {
      const progress = fixProgress(issue, verdict.comment.createdAt, ctx.branchActivity.get(issue.number));
      if (verdict.verdict === 'Pass') {
        // Good news, and it retires any standing fail by being the newest word.
        // Not when it closed the issue, though: that is the ordinary end of the
        // line, and 47 of 68 passes closed their issue within one second.
        if (isNews(verdict.comment.createdAt) && !closed) {
          push({
            id: `uat-pass:issue#${issue.number}:${verdict.comment.id}`,
            kind: 'uat-pass',
            subject,
            actor: verdict.comment.author.login,
            eventAt: verdict.comment.createdAt,
            reason: `${verdict.comment.author.login} passed this in UAT`,
            detail: firstLine(verdict.comment.body),
            url: verdict.comment.url,
            consoleIssue,
            verdict: verdict.verdict,
          });
        }
      } else if (progress !== 'shipped') {
        // 'inflight' drops it out of tier 1 without deleting it: nothing has
        // shipped, so it is still true — it has just stopped being the loudest
        // thing on the page while somebody is visibly working on it.
        const kind = progress === 'inflight' ? 'uat-fail-inflight' : 'uat-fail';
        push({
          id: `${kind}:issue#${issue.number}:${verdict.comment.id}`,
          kind,
          subject,
          actor: verdict.comment.author.login,
          eventAt: verdict.comment.createdAt,
          reason:
            progress === 'inflight'
              ? `${verdict.comment.author.login} marked this ${verdict.verdict} in UAT — fix in flight`
              : `${verdict.comment.author.login} tested this in UAT and marked it ${verdict.verdict}`,
          detail: firstLine(verdict.comment.body),
          url: verdict.comment.url,
          consoleIssue,
          verdict: verdict.verdict,
        });
      } else if (closed) {
        // SHIPPED, THEN CLOSED, WITH THE SEND-BACK STILL THE NEWEST WORD ON IT.
        //
        // The one case the branch above deliberately says nothing about. A merge
        // after the verdict is `shipped` — QA's ball again, and while the issue
        // is OPEN that is right, because the next thing to happen is a re-test.
        // A CLOSE is that re-test never happening: #4619, #5019, #5139 and #4344
        // were each failed by a human, fixed, merged and closed, and nothing
        // anywhere said the verdict had never been answered. The row read
        // "closed — PR merged and QA signed it off" over a standing Fail.
        //
        // Only a NEWER `Pass` answers a `Fail`, and a newer Pass would BE this
        // verdict — `newestUatVerdict` returns the latest one. So the test is
        // exactly "the last thing a human said about this was a send-back, and
        // then it was closed".
        //
        // Tier 1 and NOT a push. It is fix-first by the same rule `uat-fail` is,
        // but it is a fact about work that has already stopped rather than an
        // interruption: the shipped fix is months of nobody waiting, and the
        // one kind that buzzes a phone stays the live send-back. The toast, the
        // badge and the bundle carry this one. See `KindMeta.push`.
        //
        // Exclusive with the kinds above by construction — one branch each — so
        // one verdict is never two rows. `uatFailFor` reads all three, which is
        // what puts the UAT chip and the verdict sentence back on a closed row.
        push({
          id: `closed-over-fail:issue#${issue.number}:${verdict.comment.id}`,
          kind: 'closed-over-fail',
          subject,
          actor: verdict.comment.author.login,
          eventAt: verdict.comment.createdAt,
          reason: `#${issue.number} was closed while ${verdict.comment.author.login}'s ${verdict.verdict} still stood — the fix shipped, nothing re-tested it`,
          detail: firstLine(verdict.comment.body),
          url: verdict.comment.url,
          consoleIssue,
          verdict: verdict.verdict,
        });
      }
    }

    // THE SAFETY VALVE. A human commented after the merge and it did not parse
    // as a verdict. Never tier 1, never a push — it exists so a missed verdict
    // is visible rather than silent, which is the one failure mode of this
    // feature that nothing else can catch.
    //
    // Two ways in, and the second one is a fix:
    //
    //  - the issue is still in the UAT lane, so anything a human says about it
    //    post-merge is plausibly the verdict, prose or not; or
    //  - the comment OPENS WITH THE VERDICT LABEL, whatever lane the board is
    //    in. Scoping the valve to `QA` alone made it blind in exactly the case
    //    it exists for: a Fail send-back MOVES the item out of `QA`, so a
    //    verdict the regex could not parse arrived on an issue sitting in
    //    `In progress` and rendered as an ordinary "new comment".
    //
    // The label check is what keeps this from swallowing the whole feed: an
    // ordinary post-merge question in another lane is still a tier-2 comment
    // that needs a response, not a tier-3 FYI.
    const isValveComment = (c: GhActionsIssue['comments'][number]): boolean =>
      isPostMergeHumanComment(toUatComment(c), { me: ctx.me, mergedAt: issue.mergedAt }) &&
      (issue.lane === UAT_LANE || mentionsVerdictHeading(c.body));

    {
      const missed = issue.comments.filter(isValveComment).sort((a, b) => at(b.createdAt) - at(a.createdAt))[0];
      if (missed && isNews(missed.createdAt)) {
        push({
          id: `uat-unparsed:issue#${issue.number}:${missed.id}`,
          kind: 'uat-unparsed',
          subject,
          actor: missed.author.login,
          eventAt: missed.createdAt,
          reason: `${missed.author.login} commented on #${issue.number} after merge — not a recognised verdict`,
          detail: firstLine(missed.body),
          url: missed.url,
          consoleIssue,
        });
      }
    }

    // A human other than the operator, talking on the issue. Ungated by console
    // state on purpose — see `alreadyHandled`. The bot rounds and their own words
    // are already filtered out below, so what is left is always a person to answer.
    {
      const newest = issue.comments
        .filter((c) => c.author.login.toLowerCase() !== ctx.me.toLowerCase())
        .filter((c) => c.author.typename === 'User')
        .filter((c) => isHumanUatVerdict(toUatComment(c), { me: ctx.me, mergedAt: issue.mergedAt }) === null)
        // Whatever the valve above claimed is not ALSO ordinary chat. Same
        // predicate, so the two can never disagree about one comment.
        .filter((c) => !isValveComment(c))
        .sort((a, b) => at(b.createdAt) - at(a.createdAt))[0];
      if (newest && isNews(newest.createdAt) && !closed) {
        push({
          id: `comment:issue#${issue.number}:${newest.id}`,
          kind: 'comment',
          subject,
          actor: newest.author.login,
          eventAt: newest.createdAt,
          reason: `${newest.author.login} commented on #${issue.number}`,
          detail: firstLine(newest.body),
          url: newest.url,
          consoleIssue,
        });
      }
    }

    if (!closed && !alreadyHandled(issue, ctx) && !ctx.knownAssigned.has(issue.number)) {
      push({
        id: `assigned:issue#${issue.number}`,
        kind: 'assigned',
        subject,
        actor: '',
        eventAt: issue.updatedAt,
        reason: `#${issue.number} was assigned to you`,
        detail: firstLine(issue.title),
        url: issue.url,
        consoleIssue,
      });
    }

    // Not news when it was us. Narrow on purpose: the SAME lane we wrote, and the
    // change stamped at or after our write. If the operator moves it somewhere else
    // afterwards, that fires normally — because that one is real news.
    // Absent map means we know of no move of ours — so nothing is suppressed,
    // which is the safe direction: a shown action is noise, a hidden one is a lie.
    const ours = ctx.ownBoardMoves?.get(issue.number) ?? null;
    const isOwnMove =
      ours !== null && issue.lane === ours.to && issue.laneAt !== null && at(issue.laneAt) >= at(ours.at);

    // A closed issue's move to `Revisit` is already a send-back above, in the
    // words that prioritise it. Announcing it again as a plain lane change would
    // be the same fact twice, the second time in a voice that says nothing.
    if (!closed && issue.lane && issue.laneAt && isNews(issue.laneAt) && !isOwnMove) {
      push({
        id: `lane-change:issue#${issue.number}:${issue.lane}:${issue.laneAt}`,
        kind: 'lane-change',
        subject,
        actor: '',
        eventAt: issue.laneAt,
        reason: `#${issue.number} moved to ${issue.lane}`,
        detail: null,
        url: issue.url,
        consoleIssue,
      });
    }
  }

  for (const pr of payload.prs) {
    const subject = { type: 'pr' as const, number: pr.number, title: pr.title, url: pr.url };
    // `human-review-needed` is read and thrown away, deliberately and for ever.
    const _ignored = pr.labels.includes(NEVER_AN_ACTION_LABEL);
    void _ignored;

    const cr = pr.latestReviews
      .filter((r) => r.state === 'CHANGES_REQUESTED')
      .filter((r) => r.author.login.toLowerCase() !== ctx.me.toLowerCase())
      .sort((a, b) => at(b.submittedAt) - at(a.submittedAt))[0];
    if (cr) {
      // The console may already own this ask as a rework round with a Start
      // button. Then the row points AT that card instead of duplicating it.
      const tracked = [...ctx.reworkIssues].find((n) => pr.headRefName.includes(String(n))) ?? null;

      // AND IF IT OWNS IT AND HAS RESOLVED IT, there is nothing to report. The
      // header once read "3 actions on you" over work that was already finished:
      // three change-requests whose rounds the console's own state had recorded
      // as resolved by the operator. Each review had been read and the rework
      // sent back, and the operator was being counted three times for it.
      //
      // Only when the console TRACKS the issue: with no worktree it has no
      // opinion, and silence there would hide a real ask.
      const owned = [...ctx.trackedIssues].find((n) => pr.headRefName.includes(String(n))) ?? null;
      if (owned !== null && tracked === null) continue;

      push({
        id: `changes-requested:pr#${pr.number}:${cr.submittedAt}`,
        kind: 'changes-requested',
        subject,
        actor: cr.author.login,
        eventAt: cr.submittedAt,
        reason: `${cr.author.login} requested changes on PR #${pr.number}`,
        detail: firstLine(cr.body),
        url: pr.url,
        consoleIssue: tracked,
      });
    }

    if (pr.checkState === 'FAILURE' && !pr.isDraft && pr.headOid) {
      push({
        id: `ci-failed:pr#${pr.number}:${pr.headOid}`,
        kind: 'ci-failed',
        subject,
        actor: '',
        eventAt: pr.updatedAt,
        reason: `CI is red on PR #${pr.number}`,
        detail: null,
        url: pr.url,
        consoleIssue: null,
      });
    }

    const newest = pr.comments
      .filter((c) => c.author.login.toLowerCase() !== ctx.me.toLowerCase() && c.author.typename === 'User')
      .sort((a, b) => at(b.createdAt) - at(a.createdAt))[0];
    if (newest && isNews(newest.createdAt)) {
      push({
        id: `comment:pr#${pr.number}:${newest.id}`,
        kind: 'comment',
        subject,
        actor: newest.author.login,
        eventAt: newest.createdAt,
        reason: `${newest.author.login} commented on PR #${pr.number}`,
        detail: firstLine(newest.body),
        url: newest.url,
        consoleIssue: null,
      });
    }
  }

  for (const r of payload.reviewRequested) {
    push({
      id: `review-requested:pr#${r.number}:${r.updatedAt}`,
      kind: 'review-requested',
      subject: { type: 'pr', number: r.number, title: r.title, url: r.url },
      actor: r.actor,
      eventAt: r.updatedAt,
      reason: `you were asked to review PR #${r.number}`,
      detail: null,
      url: r.url,
      consoleIssue: null,
    });
  }

  for (const m of payload.mentions) {
    if (!isNews(m.updatedAt)) continue;
    push({
      id: `mention:#${m.number}:${m.updatedAt}`,
      kind: 'mention',
      subject: { type: 'issue', number: m.number, title: m.title, url: m.url },
      actor: m.actor,
      eventAt: m.updatedAt,
      reason: `you were mentioned in #${m.number}`,
      detail: null,
      url: m.url,
      consoleIssue: ctx.trackedIssues.has(m.number) ? m.number : null,
    });
  }

  for (const p of payload.merged) {
    if (!isNews(p.mergedAt)) continue;
    push({
      id: `merged:pr#${p.number}:${p.mergedAt}`,
      kind: 'merged',
      subject: { type: 'pr', number: p.number, title: p.title, url: p.url },
      actor: '',
      eventAt: p.mergedAt,
      reason: `PR #${p.number} merged`,
      detail: null,
      url: p.url,
      consoleIssue: null,
    });
  }

  return sortActions(dedupe(out));
}

/** R1 — one action per (kind, subject). Newest event wins. */
function dedupe(actions: Action[]): Action[] {
  const best = new Map<string, Action>();
  for (const a of actions) {
    const key = `${a.kind}:${a.subject.type}#${a.subject.number}`;
    const held = best.get(key);
    if (!held || at(a.eventAt) > at(held.eventAt)) best.set(key, a);
  }
  return [...best.values()];
}

/**
 * Tier ascending. Inside tiers 1–2, OLDEST first — the queue reads top-down,
 * longest-waiting first. Inside tier 3, newest first: that is news, and stale
 * news is not worth the top of a list.
 */
export function sortActions(actions: Action[]): Action[] {
  return [...actions].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const byTime = a.tier === 3 ? at(b.eventAt) - at(a.eventAt) : at(a.eventAt) - at(b.eventAt);
    if (byTime !== 0) return byTime;
    return b.subject.number - a.subject.number;
  });
}

/** The feed as the UI receives it, with its own honesty fields. */
export type ActionsFeed = {
  actions: Action[];
  /** When these actions were READ from GitHub. Never the time of the attempt. */
  fetchedAt: string | null;
  /** True when the last attempt failed and `actions` is the previous good read. */
  stale: boolean;
  /** Plain English, what went wrong and what that means for the rows below. */
  error: string | null;
  seenAt: string | null;
  /** What the last read cost and what is left, straight off GitHub. */
  quota: { remaining: number; limit: number; resetAt: string } | null;
  /** Set while the brake is on — see quota.ts. */
  paused: string | null;
  /** Set when the phone subscription has expired and pushes are going nowhere. */
  pushProblem: string | null;
  /** Set when GitHub gave back a shorter list than it holds — see
   *  `ActionsPayload.truncated`. A short list must never render as a whole one. */
  truncated: string | null;
};

export const EMPTY_FEED: ActionsFeed = {
  actions: [],
  fetchedAt: null,
  stale: false,
  error: null,
  seenAt: null,
  quota: null,
  paused: null,
  pushProblem: null,
  truncated: null,
};

/** The tier-1 verdict on one issue, for the row's `uatFail` stamp. Read off the
 *  SAME derived actions the feed shows — never a second parse of the comments. */
/**
 * The standing send-back on one issue, for the row to draw.
 *
 * `uat-fail-inflight` counts, and leaving it out was the bug #4914 exposed.
 * A teammate opened QA-fix PR #5027 an hour after the tester's Fail, which is exactly
 * what `inflight` is for — the fail stops being the loudest thing on the page
 * while somebody is visibly fixing it. But this function fed the row's chip, its
 * card and its status sentence, so the demotion did not quieten the row: it
 * emptied it. #4914 read `PR #4976 merged — stage 9 post-merge`, inviting a QA
 * hand-off for work QA had already failed, with nothing anywhere on the row
 * saying a verdict existed.
 *
 * Quieter is a wording decision, made by the caller from `inflight`. Absent is
 * not a wording decision.
 *
 * `closed-over-fail` counts for the same reason, one step further on. A closed
 * row is the quietest row on the page — `done`, faded, sunk to the floor — and
 * the four tickets closed over a standing verdict are exactly the ones where
 * that silence is wrong. It is never `inflight`: a close is an ending, not a fix
 * somebody is visibly working on.
 */
const SEND_BACK_KINDS = new Set(['uat-fail', 'uat-fail-inflight', 'closed-over-fail']);

export function uatFailFor(
  actions: Action[],
  issue: number,
): { by: string; at: string; verdict: UatVerdictKind; url: string; inflight: boolean } | null {
  const a = actions.find(
    (x) => SEND_BACK_KINDS.has(x.kind) && x.subject.type === 'issue' && x.subject.number === issue,
  );
  if (!a || !a.verdict) return null;
  return { by: a.actor, at: a.eventAt, verdict: a.verdict, url: a.url, inflight: a.kind === 'uat-fail-inflight' };
}
