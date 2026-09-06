/**
 * How the actions feed READS. Display only.
 *
 * The one rule this file exists to keep: the page never decides what outranks
 * what. `action.tier` is stamped by the server, off the single UAT predicate in
 * `orchestrator/src/uat.ts`, and everything here — grouping, ordering, the
 * counts, the pill — reads that stamp. There is no regex in the browser, no
 * label test, and no second opinion about whether a comment was a human verdict.
 *
 * Kind LABELS are mirrored (a kind is a wire string; something has to turn it
 * into English) and an unknown kind falls back to the kind itself rather than
 * disappearing — a feed that silently drops rows it does not recognise is the
 * one failure mode nobody would ever notice.
 */
import type { Action, ActionTier, ActionsFeed, KindSwitch, NotifyPrefs } from './types';

/**
 * The feed, or an empty one.
 *
 * Not defensiveness for its own sake: `npm run build` overwrites `ui/dist` under
 * a console that is already running, so a NEW page routinely talks to an OLD
 * server for as long as it takes to restart it — the exact case the stale-bundle
 * banner exists to shout about. That server sends no `actions` at all, and a page
 * that read `state.actions.actions` would white-screen before it could draw the
 * banner telling you to reload.
 */
export function feedOf(state: { actions?: ActionsFeed }): ActionsFeed {
  return (
    state.actions ?? {
      actions: [],
      fetchedAt: null,
      stale: false,
      error: null,
      seenAt: null,
      quota: null,
      paused: null,
      pushProblem: null,
      truncated: null,
      banner: null,
    }
  );
}

/** Same reason, for the switches. */
export function prefsOf(state: { notify?: NotifyPrefs }): NotifyPrefs {
  return state.notify ?? { enabled: true, inApp: true, phone: false, detail: 'numbers', kinds: {} };
}

/**
 * What Settings says about registered phones — and specifically about phones
 * that are NOT the one you are looking at.
 *
 * `/api/push/subscribe` has no auth, and Tailscale Serve exposes the console to
 * the whole tailnet, so any device on it can register its own keypair and then
 * decrypt every push. The page could previously only report whether THIS
 * browser was subscribed, which made exactly the registrations that matter —
 * somebody else's — invisible.
 *
 * So the count is always stated, and a device you are not looking at is called
 * out rather than folded into a total.
 */
export function pushDeviceNote(count: number, thisOne: boolean): string {
  if (count === 0) return 'no devices are registered';
  const others = count - (thisOne ? 1 : 0);
  const plural = (n: number) => (n === 1 ? 'device' : 'devices');
  if (!thisOne) return `${count} other ${plural(count)} registered — this one is not`;
  if (others === 0) return 'this device is registered, and no others';
  return `this device is registered, and ${others} other ${plural(others)}`;
}

/** What each kind is called on screen. Mirrors `KIND_META` in the orchestrator —
 *  labels only; the tier beside them there is the server's business. */
const KIND_LABEL: Record<string, string> = {
  'uat-fail': 'UAT FAIL',
  'uat-fail-inflight': 'UAT fail — fix in flight',
  // Not "UAT FAIL": the verdict is the same, and what makes this one worth its
  // own words is that the ticket was signed off over the top of it.
  'closed-over-fail': 'closed over a QA fail',
  'changes-requested': 'changes requested',
  'review-requested': 'review asked of you',
  mention: 'mentioned',
  comment: 'new comment',
  'ci-failed': 'CI red',
  assigned: 'newly assigned',
  'uat-unparsed': 'comment after merge',
  'uat-pass': 'UAT pass',
  'lane-change': 'board moved',
  merged: 'merged',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/-/g, ' ');
}

/** The three sections, in the words that say what to DO about them. */
export const TIER_TITLE: Record<ActionTier, string> = {
  1: 'Fix first',
  2: 'Waiting on you',
  3: 'For information',
};

export const TIER_SUB: Record<ActionTier, string> = {
  1: 'a human tested the shipped work in UAT and sent it back',
  2: 'someone is waiting on an answer from you',
  3: 'nothing to do — here so a missed verdict is visible rather than silent',
};

/** Tier 1 and 2 only. Tier 3 is news; counting it would make the number
 *  meaningless within a day. */
export function actionCount(actions: readonly Action[]): number {
  return actions.filter((a) => a.tier !== 3).length;
}

export function fixFirstCount(actions: readonly Action[]): number {
  return actions.filter((a) => a.tier === 1).length;
}

/** Already ordered by the server (tier, then oldest-first in 1–2 and
 *  newest-first in 3). This only cuts it into its sections, keeping that order. */
export function byTier(actions: readonly Action[], tier: ActionTier): Action[] {
  return actions.filter((a) => a.tier === tier);
}

/**
 * The one line of the comment, without its markdown.
 *
 * The QA template starts `**Test Result:** Fail`, and printing the asterisks
 * makes a row that a person has to decode. Nothing here is rendered as markdown
 * — this is one line inside a list — so the markers are dropped and the words
 * are kept.
 */
export function plainDetail(detail: string): string {
  return detail
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[*_]{2,}|[*_]{2,}$/g, '')
    .trim();
}

/** "just now" / "2 h ago" / "3 d ago" — same vocabulary as the account cards. */
export function since(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'at an unknown time';
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/** The one-line banner above the rail when something is fix-first. Says what and
 *  where, so the top priority is readable without switching view. */
export function fixFirstLine(actions: readonly Action[]): string | null {
  const one = byTier(actions, 1);
  if (one.length === 0) return null;
  const parts = one.map((a) => `${kindLabel(a.kind)} on #${a.subject.number}`);
  return `${one.length} to fix first — ${parts.join(' · ')}`;
}

/* --------------------------------------------------------- the off switches */

/** What the settings panel offers, in the order it offers it. */
export const SWITCHABLE: Array<{ kind: string; what: string }> = [
  { kind: 'uat-fail', what: 'a human tested it in UAT and sent it back' },
  { kind: 'closed-over-fail', what: 'it was closed while a tester’s fail still stood' },
  { kind: 'changes-requested', what: 'a reviewer asked for changes on your PR' },
  { kind: 'review-requested', what: 'someone asked you to review their PR' },
  { kind: 'ci-failed', what: 'CI went red on your open PR' },
  { kind: 'mention', what: 'you were @-mentioned' },
  { kind: 'assigned', what: 'an issue was assigned to you' },
  { kind: 'comment', what: 'somebody commented on your issue or PR' },
  { kind: 'uat-unparsed', what: 'a comment landed after merge that did not read as a verdict' },
  { kind: 'uat-pass', what: 'a human passed it in UAT' },
  { kind: 'lane-change', what: 'the board moved it to another lane' },
  { kind: 'merged', what: 'your PR merged' },
];

/**
 * What a kind does when nothing has been said about it. Mirrors `switchFor` in
 * `orchestrator/src/notify.ts`: tier 3 is feed-only, everything else announces.
 * Display only — the server applies its own copy of this rule, so a drift here
 * shows the wrong word and never sends the wrong notification.
 */
const DEFAULT_SWITCH: Record<string, KindSwitch> = {
  'uat-unparsed': 'feed',
  'uat-pass': 'feed',
  'lane-change': 'feed',
  merged: 'feed',
};

export function switchOf(kind: string, kinds: Record<string, KindSwitch>): KindSwitch {
  return kinds[kind] ?? DEFAULT_SWITCH[kind] ?? 'push';
}

/** Exactly one kind is allowed to reach the phone on its own. Everything else
 *  that announces is rolled into a single "N new actions" push per read. */
export const PUSHES_ALONE = 'uat-fail';

export const SWITCH_LABEL: Record<KindSwitch, string> = {
  push: 'Toast + phone',
  feed: 'Feed only',
  off: 'Off',
};

/**
 * What is left of the GitHub GraphQL budget, when that is worth saying.
 *
 * The console reads `GET /rate_limit` on every single poll and, until now,
 * rendered the number nowhere at all — so the first sign of exhaustion was the
 * feed quietly going dark. It is not a dashboard gauge: it stays silent while
 * there is plenty, and speaks only once the number is low enough to explain
 * something the operator is about to notice.
 *
 * The bucket is shared with the Claude worker sessions on the same token, which
 * drain it far faster than this console does, so "low" is about what is left,
 * never about what the console spent.
 */
export function quotaNote(
  quota: { remaining: number; limit: number; resetAt: string } | null,
  floor = 500,
): string | null {
  if (!quota || quota.limit <= 0) return null;
  // Twice the brake's floor: enough warning to be useful, quiet the rest of the
  // time. Below the floor itself the brake has already spoken (`feed.paused`).
  if (quota.remaining > floor * 2) return null;
  const at = new Date(quota.resetAt);
  const hhmm = Number.isNaN(at.getTime())
    ? 'the next hour'
    : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `GitHub budget: ${quota.remaining} of ${quota.limit} left, back to full at ${hhmm}. Claude workers share it.`;
}
