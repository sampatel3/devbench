/**
 * The page's half of the actions feed.
 *
 * The rule these tests exist to hold: the browser never decides what outranks
 * what. `action.tier` is stamped by the server off the one UAT predicate in
 * `uat.ts`, and everything here — the sections, the counts, the banner, the
 * fifth stat on the strip — reads that stamp. If a future change made the page
 * infer a tier from a kind string, the second test below is the one that fails.
 */
import { describe, it, expect } from 'vitest';
import {
  PUSHES_ALONE,
  SWITCHABLE,
  SWITCH_LABEL,
  TIER_SUB,
  TIER_TITLE,
  actionCount,
  byTier,
  feedOf,
  fixFirstCount,
  fixFirstLine,
  kindLabel,
  plainDetail,
  prefsOf,
  pushDeviceNote,
  quotaNote,
  since,
  switchOf,
} from '../../ui/src/actions.js';
import { KIND_META } from '../src/actions.js';
import type { Action } from '../../ui/src/types.js';

const action = (over: Partial<Action> & Pick<Action, 'id' | 'kind' | 'tier'>): Action => ({
  subject: { type: 'issue', number: 4170, title: 'Org sysadmin filter pills', url: 'https://github.com/x/4170' },
  actor: 'qa-alice',
  eventAt: '2026-08-11T09:00:00Z',
  reason: 'qa-alice tested this in UAT and marked it Fail',
  detail: '**Test Result:** Fail',
  url: 'https://github.com/x/4170#issuecomment-1',
  consoleIssue: null,
  ...over,
});

describe('the page reads the tier, it never decides it', () => {
  it('groups by the stamp on the action, not by the kind string', () => {
    // A tier deliberately at odds with what the kind normally means. The page
    // must follow the server: it is the only thing that ran the predicate.
    const odd = action({ id: 'a', kind: 'uat-fail', tier: 3 });
    expect(byTier([odd], 1)).toEqual([]);
    expect(byTier([odd], 3)).toEqual([odd]);
    expect(fixFirstCount([odd])).toBe(0);
  });

  it('counts tiers 1 and 2 and never tier 3 — an FYI is not a to-do', () => {
    const list = [
      action({ id: 'a', kind: 'uat-fail', tier: 1 }),
      action({ id: 'b', kind: 'comment', tier: 2 }),
      action({ id: 'c', kind: 'merged', tier: 3 }),
      action({ id: 'd', kind: 'uat-pass', tier: 3 }),
    ];
    expect(actionCount(list)).toBe(2);
    expect(fixFirstCount(list)).toBe(1);
  });

  it('keeps the order the server sent inside a tier', () => {
    const first = action({ id: 'a', kind: 'uat-fail', tier: 1, eventAt: '2026-08-09T09:00:00Z' });
    const second = action({ id: 'b', kind: 'uat-fail', tier: 1, eventAt: '2026-08-11T09:00:00Z' });
    expect(byTier([first, second], 1).map((a) => a.id)).toEqual(['a', 'b']);
  });
});

describe('what the rows say', () => {
  it('names every kind the orchestrator can emit — nothing renders as a wire string', () => {
    for (const kind of Object.keys(KIND_META)) {
      expect(kindLabel(kind)).not.toBe('');
      expect(kindLabel(kind)).not.toContain('-');
    }
  });

  it('renders a kind this build has never heard of rather than dropping the row', () => {
    // A feed that silently hides what it does not recognise is the one failure
    // mode nobody would ever notice.
    expect(kindLabel('some-future-kind')).toBe('some future kind');
  });

  it('has a title and a subtitle for all three sections', () => {
    for (const tier of [1, 2, 3] as const) {
      expect(TIER_TITLE[tier].length).toBeGreaterThan(0);
      expect(TIER_SUB[tier].length).toBeGreaterThan(0);
    }
    expect(TIER_TITLE[1]).toBe('Fix first');
  });

  it('says how long ago, and says so honestly when the date is unreadable', () => {
    const now = Date.parse('2026-08-11T12:00:00Z');
    expect(since('2026-08-11T11:59:30Z', now)).toBe('just now');
    expect(since('2026-08-11T11:30:00Z', now)).toBe('30 min ago');
    expect(since('2026-08-11T09:00:00Z', now)).toBe('3 h ago');
    expect(since('2026-08-08T12:00:00Z', now)).toBe('3 d ago');
    expect(since('not a date', now)).toBe('at an unknown time');
  });
});

describe('the one-line banner above the list', () => {
  it('is nothing at all when nothing is fix-first — never furniture', () => {
    expect(fixFirstLine([])).toBeNull();
    expect(fixFirstLine([action({ id: 'a', kind: 'comment', tier: 2 })])).toBeNull();
  });

  it('names what and where, so the top priority is readable without switching view', () => {
    const line = fixFirstLine([
      action({ id: 'a', kind: 'uat-fail', tier: 1 }),
      action({ id: 'b', kind: 'uat-fail', tier: 1, subject: { type: 'issue', number: 4342, title: 't', url: 'u' } }),
      action({ id: 'c', kind: 'comment', tier: 2 }),
    ]);
    expect(line).toBe('2 to fix first — UAT FAIL on #4170 · UAT FAIL on #4342');
  });
});

describe('the off switches', () => {
  it('defaults tier-3 kinds to feed-only and everything else to announcing', () => {
    expect(switchOf('uat-fail', {})).toBe('push');
    expect(switchOf('changes-requested', {})).toBe('push');
    expect(switchOf('merged', {})).toBe('feed');
    expect(switchOf('uat-pass', {})).toBe('feed');
    expect(switchOf('lane-change', {})).toBe('feed');
    expect(switchOf('uat-unparsed', {})).toBe('feed');
  });

  it('an explicit choice wins over the default, including turning tier 1 off', () => {
    expect(switchOf('uat-fail', { 'uat-fail': 'off' })).toBe('off');
    expect(switchOf('merged', { merged: 'push' })).toBe('push');
  });

  /**
   * The BLOCK the reviewers raised, pinned as a test. `changes-requested` lands
   * on 142 of 142 feature PRs; if it ever pushed on its own, the console would
   * buzz the operator's phone on essentially every PR they open, which is how a notifier
   * gets muted for ever.
   */
  it('offers exactly one kind that pushes on its own, and it is the UAT send-back', () => {
    expect(PUSHES_ALONE).toBe('uat-fail');
    const alone = Object.entries(KIND_META).filter(([, m]) => m.push);
    expect(alone.map(([k]) => k)).toEqual(['uat-fail']);
  });

  it('offers a switch for every kind the orchestrator can emit', () => {
    expect(new Set(SWITCHABLE.map((s) => s.kind))).toEqual(
      // `uat-fail-inflight` is the SAME verdict, decayed — it is not a separate
      // thing to switch on and off, and offering it as one would be a second
      // control for one fact.
      new Set(Object.keys(KIND_META).filter((k) => k !== 'uat-fail-inflight')),
    );
    for (const s of SWITCHABLE) expect(s.what.length).toBeGreaterThan(0);
  });

  it('words the three positions in what they DO, not in wire values', () => {
    expect(SWITCH_LABEL.push).toBe('Toast + phone');
    expect(SWITCH_LABEL.feed).toBe('Feed only');
    expect(SWITCH_LABEL.off).toBe('Off');
  });
});

describe('the detail line', () => {
  it('drops the markdown so the QA template reads as a sentence', () => {
    // The verified shape, from #4170. Printed raw it is `**Test Result:** Fail`,
    // which a person has to decode; nothing in a feed row renders markdown.
    expect(plainDetail('**Test Result:** Fail')).toBe('Test Result: Fail');
    expect(plainDetail('`npm test` is red')).toBe('npm test is red');
    expect(plainDetail('## Steps to Recreate')).toBe('Steps to Recreate');
  });

  it('leaves an ordinary comment exactly as it was written', () => {
    expect(plainDetail('Can we ship this behind the org flag first?')).toBe(
      'Can we ship this behind the org flag first?',
    );
    // A lone asterisk is somebody's prose, not markup.
    expect(plainDetail('2 * 3 is 6')).toBe('2 * 3 is 6');
  });
});

/**
 * The stale-bundle case, which is not hypothetical: `npm run build` overwrites
 * `ui/dist` under a console that is already running, so a NEW page talks to an
 * OLD server until it is restarted. That server sends no `actions` and no
 * `notify`. Reading straight through would white-screen the page BEFORE it could
 * draw the banner that tells them to reload — the banner would be the casualty of
 * the exact situation it exists for.
 */
describe('a page newer than the console it is talking to', () => {
  it('reads an empty feed rather than throwing', () => {
    const feed = feedOf({} as { actions?: never });
    expect(feed.actions).toEqual([]);
    expect(feed.fetchedAt).toBeNull();
    // Empty and never read are different sentences, and this is the second one.
    expect(feed.stale).toBe(false);
    expect(feed.banner).toBeNull();
    expect(actionCount(feed.actions)).toBe(0);
  });

  it('falls back to the shipped defaults for the switches', () => {
    const prefs = prefsOf({} as { notify?: never });
    expect(prefs.enabled).toBe(true);
    expect(prefs.inApp).toBe(true);
    // Phone stays OFF: it is only ever on because they turned it on.
    expect(prefs.phone).toBe(false);
    expect(prefs.detail).toBe('numbers');
  });

  it('passes a real feed straight through', () => {
    const real = { actions: [], fetchedAt: '2026-08-12T09:00:00Z', stale: true, error: 'x', seenAt: null, quota: null, paused: null, pushProblem: null, banner: 'b' };
    expect(feedOf({ actions: real })).toBe(real);
  });
});

/**
 * A phone registered by something that is not this browser used to be
 * completely invisible: Settings reported `ready.subscribed`, which is a
 * question about the browser you are already holding. Any device on the tailnet
 * can POST its own keypair to `/api/push/subscribe` — there is no auth — and it
 * can then decrypt every push. The count is the only thing that shows it.
 */
describe('registered phones, including the ones that are not this browser', () => {
  it('never hides a device you are not looking at', () => {
    expect(pushDeviceNote(2, true)).toBe('this device is registered, and 1 other device');
    expect(pushDeviceNote(3, true)).toBe('this device is registered, and 2 other devices');
    expect(pushDeviceNote(1, false)).toBe('1 other device registered — this one is not');
    expect(pushDeviceNote(2, false)).toBe('2 other devices registered — this one is not');
  });

  it('reads plainly in the two ordinary cases', () => {
    expect(pushDeviceNote(0, false)).toBe('no devices are registered');
    expect(pushDeviceNote(1, true)).toBe('this device is registered, and no others');
  });
});

/**
 * The console read the quota on every poll and showed it nowhere, so the first
 * sign of exhaustion was the feed going dark with no explanation. It is still
 * not a gauge — it says nothing while there is plenty.
 */
describe('what is left of the GitHub budget', () => {
  const q = (remaining: number) => ({ remaining, limit: 5000, resetAt: '2026-08-12T11:26:24Z' });

  it('says nothing at all when there is plenty', () => {
    expect(quotaNote(q(4000))).toBeNull();
    expect(quotaNote(q(1001))).toBeNull();
    expect(quotaNote(null)).toBeNull();
  });

  it('speaks once the number is low enough to explain something', () => {
    expect(quotaNote(q(900))).toContain('900 of 5000 left');
    expect(quotaNote(q(900))).toContain('Claude workers share it');
  });

  it('does not pretend to read an unreadable reset time', () => {
    expect(quotaNote({ remaining: 10, limit: 5000, resetAt: 'whenever' })).toContain('the next hour');
  });
});
