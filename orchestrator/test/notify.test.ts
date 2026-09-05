import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  planNotifications,
  seedLedger,
  applySends,
  prunedLedger,
  notificationLog,
  unreadCount,
  markAllRead,
  clearLog,
  DEFAULT_PREFS,
  type Ledger,
  type NotifyPrefs,
} from '../src/notify.js';
import type { Action } from '../src/actions.js';

/**
 * What counts as NEW, and what is allowed to reach the phone.
 *
 * The two rules that matter most are both about failure:
 *  - first run must be SILENT (correction 5) — otherwise a fresh state file
 *    pushes their whole backlog to their phone in one go;
 *  - the ledger is stamped AFTER a successful send, not before, so a crash
 *    between the two re-sends rather than silently dropping. Duplicates are
 *    survivable; a dropped UAT fail is the entire point of the feature.
 */

const action = (over: Partial<Action> = {}): Action => ({
  id: 'uat-fail:issue#4334:9001',
  kind: 'uat-fail',
  tier: 1,
  subject: { type: 'issue', number: 4334, title: 'Branded auth email links', url: 'u' },
  actor: 'qa-alice',
  eventAt: '2026-08-12T09:00:00Z',
  reason: 'qa-alice tested this in UAT and marked it Fail',
  detail: null,
  url: 'u#issuecomment-9001',
  consoleIssue: 4334,
  ...over,
});

const NOW = new Date('2026-08-12T12:00:00Z');
const prefs = (over: Partial<NotifyPrefs> = {}): NotifyPrefs => ({ ...DEFAULT_PREFS, phone: true, ...over });

describe('correction 5 — no first-run storm', () => {
  it('seeds an empty ledger from the first payload and notifies NOTHING', () => {
    const actions = [
      action(),
      action({ id: 'assigned:issue#4491', kind: 'assigned', tier: 2 }),
      action({ id: 'comment:issue#4336:1', kind: 'comment', tier: 2 }),
    ];
    const seeded = seedLedger(actions, NOW);
    expect(Object.keys(seeded)).toHaveLength(3);
    expect(seeded['uat-fail:issue#4334:9001']!.seeded).toBe(true);
    const plan = planNotifications(actions, seeded, prefs(), NOW);
    expect(plan.toasts).toEqual([]);
    expect(plan.pushes).toEqual([]);
  });

  it('a seeded action stays silent for ever, but a NEW one after seeding notifies', () => {
    const first = action();
    const ledger = seedLedger([first], NOW);
    const plan = planNotifications([first, action({ id: 'uat-fail:issue#4342:7', subject: { type: 'issue', number: 4342, title: 't', url: 'u' } })], ledger, prefs(), NOW);
    expect(plan.toasts.map((a) => a.subject.number)).toEqual([4342]);
  });
});

describe('what counts as NEW across a console restart', () => {
  it('an id already in the ledger never notifies again', () => {
    const a = action();
    const ledger = applySends(seedLedger([], NOW), [a], NOW, true);
    expect(planNotifications([a], ledger, prefs(), NOW).toasts).toEqual([]);
  });

  it('the ledger is keyed on GitHub’s own ids, so a restart changes nothing', () => {
    const a = action();
    const afterRestart: Ledger = JSON.parse(JSON.stringify(applySends({}, [a], NOW, true)));
    expect(planNotifications([a], afterRestart, prefs(), NOW).toasts).toEqual([]);
  });

  it('a FAILED send is retried — firstSeenAt is stamped, notifiedAt is not', () => {
    // Write-then-send would record the id and then drop the notification for
    // ever. This is the safe direction: at-least-once.
    const a = action();
    const ledger = applySends({}, [a], NOW, false);
    expect(ledger[a.id]!.firstSeenAt).toBe(NOW.toISOString());
    expect(ledger[a.id]!.notifiedAt).toBeNull();
    expect(planNotifications([a], ledger, prefs(), NOW).toasts).toHaveLength(1);
  });
});

describe('the off switches', () => {
  it('tier 1 is the only kind that pushes on its own', () => {
    const plan = planNotifications(
      [action(), action({ id: 'changes-requested:pr#4501:x', kind: 'changes-requested', tier: 2 })],
      {},
      prefs(),
      NOW,
    );
    expect(plan.pushes.filter((p) => p.kind === 'uat-fail')).toHaveLength(1);
    expect(plan.pushes.some((p) => p.kind === 'changes-requested')).toBe(false);
  });

  it('tier 2 arrives as ONE bundled push, however many there are', () => {
    const many = [1, 2, 3, 4].map((n) =>
      action({ id: `comment:issue#${n}:1`, kind: 'comment', tier: 2, subject: { type: 'issue', number: n, title: 't', url: 'u' } }),
    );
    const plan = planNotifications(many, {}, prefs(), NOW);
    const bundles = plan.pushes.filter((p) => p.kind === 'bundle');
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.title).toBe('4 new actions on you');
  });

  /**
   * FIX — a single bot round was reaching the phone as a bundle.
   *
   * `pr-swarm[bot]` puts `changes-requested` on essentially every feature PR
   * the operator opens, so "1 new action on you / Open the console to see what they are"
   * fired once per PR round: a push per round that says LESS than the individual
   * push the design deliberately refuses to send for that kind. That is the mute
   * button this whole file exists to avoid.
   *
   * A bundle is a roll-up. One is not a roll-up — it stays in the feed and the
   * badge, where a kind whose meta says `push: false` belongs.
   */
  it('ONE tier-2 action does not reach the phone at all — a bundle of one is not a roll-up', () => {
    const plan = planNotifications(
      [action({ id: 'changes-requested:pr#4501:t', kind: 'changes-requested', tier: 2 })],
      {},
      prefs(),
      NOW,
    );
    expect(plan.pushes).toEqual([]);
    // still news at the desk, still ledgered so it never re-announces
    expect(plan.toasts).toHaveLength(1);
    expect(plan.ledgerable).toHaveLength(1);
  });

  it('two or more DO bundle — that is what the roll-up is for', () => {
    const two = [1, 2].map((n) =>
      action({ id: `comment:issue#${n}:1`, kind: 'comment', tier: 2, subject: { type: 'issue', number: n, title: 't', url: 'u' } }),
    );
    const plan = planNotifications(two, {}, prefs(), NOW);
    expect(plan.pushes.map((p) => p.title)).toEqual(['2 new actions on you']);
  });

  it('an unknown future kind gets the same treatment, not a free pass to the phone', () => {
    // UNKNOWN_KIND_META is tier 2 / push:false, so one of them must behave like
    // one changes-requested, not like a uat-fail.
    const plan = planNotifications([action({ id: 'whatsit:pr#1:t', kind: 'whatsit', tier: 2 })], {}, prefs(), NOW);
    expect(plan.pushes).toEqual([]);
  });

  it('but a kind the operator explicitly switched to push DOES push, on its own', () => {
    // Otherwise the per-kind override is a control that silently does nothing.
    const plan = planNotifications(
      [action({ id: 'changes-requested:pr#4501:t', kind: 'changes-requested', tier: 2 })],
      {},
      prefs({ kinds: { 'changes-requested': 'push' } }),
      NOW,
    );
    expect(plan.pushes.map((p) => p.kind)).toEqual(['changes-requested']);
  });

  it('tier 3 never pushes and never toasts', () => {
    const plan = planNotifications([action({ id: 'uat-pass:issue#1:2', kind: 'uat-pass', tier: 3 })], {}, prefs(), NOW);
    expect(plan.pushes).toEqual([]);
    expect(plan.toasts).toEqual([]);
  });

  it('phone off means no pushes at all — the in-app toast still fires', () => {
    const plan = planNotifications([action()], {}, prefs({ phone: false }), NOW);
    expect(plan.pushes).toEqual([]);
    expect(plan.toasts).toHaveLength(1);
  });

  it('a kind switched off produces nothing on any channel', () => {
    const plan = planNotifications([action()], {}, prefs({ kinds: { 'uat-fail': 'off' } }), NOW);
    expect(plan.pushes).toEqual([]);
    expect(plan.toasts).toEqual([]);
  });

  it('a kind set to feed-only shows in the feed but never leaves the machine', () => {
    const plan = planNotifications([action()], {}, prefs({ kinds: { 'uat-fail': 'feed' } }), NOW);
    expect(plan.pushes).toEqual([]);
    expect(plan.toasts).toEqual([]);
    expect(plan.ledgerable.map((a) => a.id)).toContain('uat-fail:issue#4334:9001');
  });

  it('the master switch kills everything', () => {
    const plan = planNotifications([action()], {}, prefs({ enabled: false }), NOW);
    expect(plan.pushes).toEqual([]);
    expect(plan.toasts).toEqual([]);
  });

  it('at most 3 individual pushes per poll; the rest bundle', () => {
    const four = [1, 2, 3, 4].map((n) =>
      action({ id: `uat-fail:issue#${n}:1`, subject: { type: 'issue', number: n, title: 't', url: 'u' } }),
    );
    const plan = planNotifications(four, {}, prefs(), NOW);
    expect(plan.pushes.filter((p) => p.kind === 'uat-fail')).toHaveLength(3);
    expect(plan.pushes.filter((p) => p.kind === 'bundle')).toHaveLength(1);
  });
});

describe('what the push actually says — nothing that identifies the work', () => {
  it('carries a number and a kind, never the issue title', () => {
    const plan = planNotifications([action()], {}, prefs(), NOW);
    const p = plan.pushes[0]!;
    expect(p.title).toBe('UAT fail — issue #4334');
    expect(p.body).toBe('A human tested this in UAT and sent it back. Open the console.');
    expect(JSON.stringify(p)).not.toContain('Branded auth email links');
    expect(JSON.stringify(p)).not.toContain('qa-alice');
  });

  it('numbers-off mode drops even the number', () => {
    const plan = planNotifications([action()], {}, prefs({ detail: 'none' }), NOW);
    expect(plan.pushes[0]!.title).toBe('New action on you');
    expect(JSON.stringify(plan.pushes[0])).not.toContain('4334');
  });
});

describe('the ledger stays small and truthful', () => {
  it('drops entries older than 30 days and keeps everything newer', () => {
    const ledger: Ledger = {
      old: { kind: 'comment', firstSeenAt: '2026-06-01T00:00:00Z', notifiedAt: '2026-06-01T00:00:00Z', seeded: false },
      recent: { kind: 'comment', firstSeenAt: '2026-08-01T00:00:00Z', notifiedAt: '2026-08-01T00:00:00Z', seeded: false },
    };
    expect(Object.keys(prunedLedger(ledger, NOW))).toEqual(['recent']);
  });

  it('never drops an entry that has not successfully notified yet', () => {
    const ledger: Ledger = {
      stuck: { kind: 'uat-fail', firstSeenAt: '2026-06-01T00:00:00Z', notifiedAt: null, seeded: false },
    };
    expect(Object.keys(prunedLedger(ledger, NOW))).toEqual(['stuck']);
  });
});

/**
 * The log the bell tab reads.
 *
 * It is the SAME ledger that decides what has already been sent, read back — so
 * the tab cannot disagree with what actually went out. The two rules that
 * matter: an entry written before the log existed degrades rather than crashes,
 * and clearing hides without ever deleting, because deleting would re-arm the
 * send-once dedup.
 */
describe('the log of what was announced', () => {
  const sent = (id: string, kind: string, at: string): Ledger[string] => ({
    kind,
    firstSeenAt: at,
    notifiedAt: at,
    seeded: false,
    subject: { type: 'issue', number: 4344, title: 'Withdraw quote is not terminal', url: 'u' },
    actor: 'qa-alice',
    reason: `${kind} on #4344`,
    readAt: null,
    clearedAt: null,
  });

  it('newest first, with the tier derived from the kind rather than stored', () => {
    const log = notificationLog({
      a: sent('a', 'comment', '2026-08-10T09:00:00Z'),
      b: sent('b', 'uat-fail', '2026-08-12T09:00:00Z'),
    });
    expect(log.map((e) => e.id)).toEqual(['b', 'a']);
    expect(log[0]!.tier).toBe(1);
    expect(log[1]!.tier).toBe(2);
  });

  it('a seeded entry can never be unread — it was never announced, so there is nothing to have missed', () => {
    // The ledger already on this machine holds nineteen of these, written by a
    // build that stamped no read state at all. Counting them would put a badge
    // of nineteen on the first open of a bell that has said nothing.
    const old: Ledger = {
      old: { kind: 'assigned', firstSeenAt: '2026-08-01T00:00:00Z', notifiedAt: '2026-08-01T00:00:00Z', seeded: true },
    };
    expect(unreadCount(old)).toBe(0);
    expect(notificationLog(old)[0]!.read).toBe(true);
  });

  it('an announced entry from before the log existed DOES read as unread, once', () => {
    const old: Ledger = {
      old: { kind: 'uat-fail', firstSeenAt: '2026-08-01T00:00:00Z', notifiedAt: '2026-08-01T00:00:00Z', seeded: false },
    };
    expect(unreadCount(old)).toBe(1);
    expect(unreadCount(markAllRead(old, NOW))).toBe(0);
  });

  it('an entry from before the log existed degrades to kind and time, and never throws', () => {
    const old: Ledger = {
      old: { kind: 'assigned', firstSeenAt: '2026-08-01T00:00:00Z', notifiedAt: '2026-08-01T00:00:00Z', seeded: false },
    };
    const log = notificationLog(old);
    expect(log[0]!.kind).toBe('assigned');
    expect(log[0]!.at).toBe('2026-08-01T00:00:00Z');
    expect(log[0]!.subject).toBeNull();
    expect(log[0]!.reason).toBeNull();
  });

  it('seeded entries are born READ, so first boot does not show a backlog as unread', () => {
    const seeded = seedLedger([action(), action({ id: 'assigned:issue#4491', kind: 'assigned', tier: 2 })], NOW);
    expect(unreadCount(seeded)).toBe(0);
    // …and they say so, rather than pretending they were announced.
    expect(notificationLog(seeded).every((e) => e.seeded)).toBe(true);
  });

  it('a real send lands unread, and reading the tab settles every one of them', () => {
    const ledger = applySends({}, [action()], NOW, true);
    expect(unreadCount(ledger)).toBe(1);
    const read = markAllRead(ledger, NOW);
    expect(unreadCount(read)).toBe(0);
    // Stamped once. A second open does not rewrite when it was read.
    expect(markAllRead(read, new Date('2026-08-13T00:00:00Z'))).toEqual(read);
  });

  it('applySends carries the display fields, so the log can draw a row', () => {
    const ledger = applySends({}, [action()], NOW, true);
    const row = notificationLog(ledger)[0]!;
    expect(row.subject!.number).toBe(4334);
    expect(row.actor).toBe('qa-alice');
    expect(row.reason).toBe('qa-alice tested this in UAT and marked it Fail');
  });

  it('clear HIDES and never deletes — the send-once record survives it intact', () => {
    const ledger = applySends({}, [action()], NOW, true);
    const cleared = clearLog(ledger, NOW);
    expect(notificationLog(cleared)).toEqual([]);
    // The entry is still there, still stamped as notified: nothing re-announces.
    expect(Object.keys(cleared)).toEqual(['uat-fail:issue#4334:9001']);
    expect(planNotifications([action()], cleared, prefs(), NOW).pushes).toEqual([]);
  });

  it('a cleared entry that is still OWED a notification survives the prune', () => {
    const owed = clearLog(applySends({}, [action()], NOW, false), NOW);
    expect(prunedLedger(owed, new Date('2026-12-01T00:00:00Z'))).toEqual(owed);
  });
});

/**
 * A real report: the operator turned the @mentions kind off in settings, because
 * a review swarm @-mentions on every PR, and the switch did not appear to take.
 *
 * The preference saved correctly and the bell went to zero — `off` was working for
 * pushes and the badge. But the ACTIONS feed still carried four mentions, and that
 * is the list they were looking at. A switch labelled "off" that leaves the thing on
 * screen is not off, whatever the internal distinction between a notification and
 * a feed row.
 *
 * Asserted against the source because the filter lives on the way OUT of the
 * orchestrator: `uatFail` and the row derivations read the unfiltered actions
 * directly, and a UAT send-back must never be silenceable by a preference.
 */
describe('a kind switched off leaves the feed too', () => {
  const SRC = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');

  it('filters the published feed by the off switch', () => {
    expect(SRC).toContain("this.#notifyStore.prefs.kinds[a.kind] !== 'off'");
  });

  it('filters on the way OUT, not at the source', () => {
    // The derivations must keep seeing everything.
    const feed = SRC.slice(SRC.indexOf('actionsFeed()'), SRC.indexOf('actionsFeed()') + 900);
    expect(feed).toContain('const visible =');
    expect(feed).toContain('actions: visible,');
    // uatFail still reads the raw list.
    expect(SRC).toContain('uatFailFor(this.#actions.actions');
  });
});
