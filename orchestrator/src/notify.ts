/**
 * What counts as NEW, and what is allowed to leave the machine.
 *
 * Pure — the ledger goes in and out as plain data, and `orchestrator.ts` owns
 * reading and writing the file. Three decisions are load-bearing:
 *
 *  1. **First run is silent.** An empty ledger is SEEDED from the first payload
 *     and nothing notifies. Without that, a fresh `state.json` — or the first
 *     ever start — pushes the operator's entire backlog to their phone at once,
 *     which is how a notifier gets muted on day one and never trusted again.
 *  2. **Send first, stamp after.** `firstSeenAt` is written when an action is
 *     first seen; `notifiedAt` only after a send actually succeeded. Anything
 *     with the first and not the second is retried. Write-then-send would have
 *     given at-most-once — a crash in that window drops the notification for
 *     ever, on the one tier that means "QA is blocked on you".
 *  3. **One kind may push on its own.** `uat-fail`. Everything else is the feed,
 *     the badge, and at most one bundled "N new actions" push. A review bot's
 *     changes-requested round lands on essentially every feature PR the operator
 *     opens; pushing that individually is the mute button.
 */

import { metaFor, type Action, type ActionTier } from './actions.js';

/** Per kind: push it, show it in the feed only, or nothing at all. */
export type KindSwitch = 'push' | 'feed' | 'off';

export type NotifyPrefs = {
  /** Master. NOTIFY=0 in the environment forces this false. */
  enabled: boolean;
  /** In-app toasts and the badge. */
  inApp: boolean;
  /** Web Push to the phone. Off until the operator has actually subscribed. */
  phone: boolean;
  /** How much a push may say. `numbers` = kind + issue number. `none` = neither. */
  detail: 'numbers' | 'none';
  /** Overrides, per kind. Anything absent uses the kind's own default. */
  kinds: Record<string, KindSwitch>;
};

export const DEFAULT_PREFS: NotifyPrefs = {
  enabled: true,
  inApp: true,
  phone: false,
  detail: 'numbers',
  kinds: {},
};

export type LedgerEntry = {
  kind: string;
  /** When the console first saw this action. Stamped BEFORE any send. */
  firstSeenAt: string;
  /** When a notification for it actually went out. Null = still owed. */
  notifiedAt: string | null;
  /** Written by the first-run seed: seen, never announced. */
  seeded: boolean;
  /**
   * What it was about, and why — so the log can draw a row.
   *
   * OPTIONAL, and every reader treats it that way. The ledger existed as a
   * send-deduplication record long before anything read it back, so entries
   * written by an older build carry none of this. They degrade to a kind and a
   * time; they never crash, and they are never rewritten to invent detail
   * nobody recorded.
   */
  subject?: { type: 'issue' | 'pr'; number: number; title: string; url: string };
  /** Who did it. Empty when GitHub gave no author. */
  actor?: string;
  /** The plain-English line, the same one the feed shows. */
  reason?: string;
  /** When you read it in the log. Null = unread. Absent on entries from before
   *  the log existed, which read as unread until the first `markAllRead`. */
  readAt?: string | null;
  /** Hidden from the log. The entry itself is NEVER deleted: the send-once
   *  guarantee and the owed-entry retry both depend on it still being here. */
  clearedAt?: string | null;
};

export type Ledger = Record<string, LedgerEntry>;

/** One row of the log, as the page receives it. */
export type LogEntry = {
  id: string;
  kind: string;
  /** The kind's tier, derived — never stored, so a re-tiered kind re-reads
   *  correctly instead of showing what it was tiered as last week. */
  tier: ActionTier;
  /** When it was announced, or first seen when it never was. */
  at: string;
  /** True when nothing was ever sent for it — the first-run seed. */
  seeded: boolean;
  read: boolean;
  subject: LedgerEntry['subject'] | null;
  actor: string | null;
  reason: string | null;
};

export type PushMessage = {
  /** The action kind, or `bundle` for the roll-up. */
  kind: string;
  title: string;
  body: string;
  /** Where tapping it goes — the console, over the tailnet. Never a GitHub URL:
   *  the phone would then need a GitHub session to make sense of it. */
  path: string;
};

export type NotifyPlan = {
  /** In-app toasts, in tier order. */
  toasts: Action[];
  /** What to send to the phone. Empty when phone is off. */
  pushes: PushMessage[];
  /** Everything considered new this round — what the ledger should record once
   *  the sends have been attempted, including the feed-only kinds. */
  ledgerable: Action[];
};

/** Individual pushes per poll before the rest roll into one bundle. */
const MAX_INDIVIDUAL_PUSHES = 3;

/**
 * How many feed-only actions it takes to be worth a phone push at all.
 *
 * A bundle is a ROLL-UP: "five things happened, go and look". One thing is not a
 * roll-up — and "1 new action on you / Open the console to see what they are"
 * says strictly less than the individual push the design deliberately refuses to
 * send for that kind, while costing exactly as much attention.
 *
 * This is not a taste call. A review bot puts `changes-requested` on essentially
 * every feature PR, so at one-is-enough the phone buzzed once per bot round, for
 * ever — the mute button this file's whole preamble is about.
 *
 * Overflow is the exception and is handled separately below: a `uat-fail` cut by
 * MAX_INDIVIDUAL_PUSHES earned a push on its own and must not be dropped just
 * because it is alone in the remainder.
 */
const MIN_BUNDLE = 2;

/**
 * How long a settled ledger entry is kept.
 *
 * This is also a CEILING on `actionsLookbackDays`, and the two are tied together
 * in config.ts rather than left to coincide. The no-re-notify guarantee depends
 * on an action leaving the payload before its ledger entry is pruned; a lookback
 * longer than this TTL inverts that, and every long-lived action re-announces
 * itself the moment its entry ages out.
 */
export const LEDGER_TTL_DAYS = 30;
const LEDGER_TTL_MS = LEDGER_TTL_DAYS * 86_400_000;

function switchFor(kind: string, prefs: NotifyPrefs): KindSwitch {
  const override = prefs.kinds[kind];
  if (override) return override;
  const meta = metaFor(kind);
  if (meta.push) return 'push';
  return meta.tier === 3 ? 'feed' : 'push';
}

/**
 * The first-run seed. Everything currently true is recorded as already
 * announced, so the feed shows it and nothing fires.
 */
export function seedLedger(actions: Action[], now: Date): Ledger {
  const iso = now.toISOString();
  const ledger: Ledger = {};
  for (const a of actions) {
    // Born READ. Nothing was announced, so a bell showing nineteen unread on
    // first boot would be counting things the console never told the operator.
    ledger[a.id] = { ...display(a), kind: a.kind, firstSeenAt: iso, notifiedAt: iso, seeded: true, readAt: iso, clearedAt: null };
  }
  return ledger;
}

/** The display half of an action, copied onto its entry. */
function display(a: Action): Pick<LedgerEntry, 'subject' | 'actor' | 'reason'> {
  return { subject: a.subject, actor: a.actor, reason: a.reason };
}

/** Anything not yet successfully announced. */
function owed(actions: Action[], ledger: Ledger): Action[] {
  return actions.filter((a) => !ledger[a.id]?.notifiedAt);
}

export function planNotifications(actions: Action[], ledger: Ledger, prefs: NotifyPrefs, _now: Date): NotifyPlan {
  const empty: NotifyPlan = { toasts: [], pushes: [], ledgerable: [] };
  if (!prefs.enabled) return { ...empty, ledgerable: owed(actions, ledger) };

  const fresh = owed(actions, ledger).filter((a) => switchFor(a.kind, prefs) !== 'off');
  const announceable = fresh.filter((a) => switchFor(a.kind, prefs) === 'push' && a.tier !== 3);

  const toasts = prefs.inApp ? announceable : [];

  const pushes: PushMessage[] = [];
  if (prefs.phone) {
    // A kind reaches the phone on its own if its own meta says so, or if the
    // operator said so. Without the second half the per-kind `push` override is
    // a control that silently does nothing: it moved the kind into
    // `announceable` and then the bundle swallowed it anyway.
    const alone = announceable.filter((a) => metaFor(a.kind).push || prefs.kinds[a.kind] === 'push');
    const shown = alone.slice(0, MAX_INDIVIDUAL_PUSHES);
    for (const a of shown) pushes.push(pushFor(a, prefs));

    /** Earned a push of its own, lost it to the cap. Always rolls up. */
    const overflow = alone.slice(MAX_INDIVIDUAL_PUSHES);
    /** Never earned one alone. Rolls up only when there are enough to be news. */
    const quiet = announceable.filter((a) => !alone.includes(a));

    const rest = [...overflow, ...quiet];
    if (overflow.length > 0 || quiet.length >= MIN_BUNDLE) {
      pushes.push({
        kind: 'bundle',
        title: `${rest.length} new action${rest.length === 1 ? '' : 's'} on you`,
        body: 'Open the console to see what they are.',
        path: '/',
      });
    }
  }

  return { toasts, pushes, ledgerable: fresh };
}

/**
 * What a push is allowed to say.
 *
 * Delivery transits Apple's APNs. The payload is end-to-end encrypted (RFC 8291)
 * so the relay sees an opaque blob — but the phone DECRYPTS it onto a lock
 * screen, which mirrors to any paired Watch or Mac. So the content is minimal by
 * construction as well as sealed in transit: a kind and a number, never an issue
 * title, never a body, never a customer name. `detail: 'none'` drops even the
 * number.
 */
function pushFor(a: Action, prefs: NotifyPrefs): PushMessage {
  if (prefs.detail === 'none') {
    return { kind: a.kind, title: 'New action on you', body: 'Open the console.', path: '/' };
  }
  const where = `${a.subject.type === 'pr' ? 'PR' : 'issue'} #${a.subject.number}`;
  if (a.kind === 'uat-fail') {
    return {
      kind: a.kind,
      title: `UAT fail — ${where}`,
      body: 'A human tested this in UAT and sent it back. Open the console.',
      path: `/?issue=${a.subject.number}`,
    };
  }
  return {
    kind: a.kind,
    title: `${metaFor(a.kind).label} — ${where}`,
    body: 'Open the console.',
    path: `/?issue=${a.subject.number}`,
  };
}

/**
 * Record the round. `sent` says whether the notification for these actually went
 * out: on false the entry is created with `notifiedAt: null` and will be tried
 * again next poll.
 */
export function applySends(ledger: Ledger, actions: Action[], now: Date, sent: boolean): Ledger {
  const iso = now.toISOString();
  const next: Ledger = { ...ledger };
  for (const a of actions) {
    const held = next[a.id];
    next[a.id] = {
      ...display(a),
      kind: a.kind,
      firstSeenAt: held?.firstSeenAt ?? iso,
      notifiedAt: sent ? iso : (held?.notifiedAt ?? null),
      seeded: held?.seeded ?? false,
      readAt: held?.readAt ?? null,
      clearedAt: held?.clearedAt ?? null,
    };
  }
  return next;
}

/* ------------------------------------------------------------------ the log */

/**
 * What the console has announced, newest first.
 *
 * A LOG, not a second copy of the feed. The feed answers "what still needs me";
 * this answers "what did the console tell me, and when" — so an entry stays here
 * after the thing it announced has been dealt with, and a cleared entry is
 * hidden rather than deleted.
 */
export function notificationLog(ledger: Ledger): LogEntry[] {
  return Object.entries(ledger)
    .filter(([, e]) => !e.clearedAt)
    .map(([id, e]) => ({
      id,
      kind: e.kind,
      tier: metaFor(e.kind).tier,
      at: e.notifiedAt ?? e.firstSeenAt,
      seeded: e.seeded,
      /**
       * Unread means "the console told you and you have not looked". A seeded
       * entry was never announced, so it cannot be unread however old the file
       * is — and the ledger on this machine holds nineteen of them, which is a
       * badge of nineteen on the very first open of a bell that has said
       * nothing. That is the day-one mute this whole file is written against.
       *
       * An entry with no `readAt` that WAS announced reads as unread once, and
       * the first `markAllRead` settles it.
       */
      read: Boolean(e.readAt) || e.seeded,
      subject: e.subject ?? null,
      actor: e.actor ?? null,
      reason: e.reason ?? null,
    }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function unreadCount(ledger: Ledger): number {
  return notificationLog(ledger).filter((e) => !e.read).length;
}

/** Opening the tab is reading it. Stamps every unread, cleared ones included —
 *  a cleared entry that came back would otherwise arrive already-unread. */
export function markAllRead(ledger: Ledger, now: Date): Ledger {
  const iso = now.toISOString();
  const next: Ledger = {};
  for (const [id, e] of Object.entries(ledger)) next[id] = e.readAt ? e : { ...e, readAt: iso };
  return next;
}

/**
 * Empty the log.
 *
 * It STAMPS, it never deletes. `prunedLedger` keeps its owed-entry guarantee and
 * the send-once dedup keeps working, because every id is still here — clearing
 * the list the operator reads must not become a path that re-announces a UAT
 * send-back.
 */
export function clearLog(ledger: Ledger, now: Date): Ledger {
  const iso = now.toISOString();
  const next: Ledger = {};
  for (const [id, e] of Object.entries(ledger)) next[id] = e.clearedAt ? e : { ...e, clearedAt: iso, readAt: e.readAt ?? iso };
  return next;
}

/** Old, settled entries go. Anything still owed a notification stays, however
 *  old — dropping it would turn a retry into a silent loss. */
export function prunedLedger(ledger: Ledger, now: Date): Ledger {
  const cutoff = now.getTime() - LEDGER_TTL_MS;
  const out: Ledger = {};
  for (const [id, e] of Object.entries(ledger)) {
    if (!e.notifiedAt) {
      out[id] = e;
      continue;
    }
    if (Date.parse(e.notifiedAt) >= cutoff) out[id] = e;
  }
  return out;
}
