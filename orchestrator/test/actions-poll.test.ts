import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import * as push from '../src/push.js';
import { memoryOk } from './fixtures/memory.js';
import type { ActionsPayload } from '../src/gh.js';

/**
 * The feed inside the running console: how it degrades, when it declines to
 * read at all, and what it does on a first-ever start.
 *
 * Nothing here touches the network, the real machine, or a pid it did not
 * create: `probeResources` is stubbed, every `gh` function is stubbed, and the
 * push sender is injected.
 */

let repo: string;

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

const emptyPayload = (over: Partial<ActionsPayload> = {}): ActionsPayload => ({
  issues: [],
  prs: [],
  reviewRequested: [],
  mentions: [],
  merged: [],
  quota: { cost: 2, remaining: 4000, limit: 5000, resetAt: '2026-08-12T11:26:24Z' },
  truncated: null,
  ...over,
});

/** #4334's own work, shipped. The branch name is what makes it #4334's OWN. */
const SHIPPED_4334 = {
  number: 4466,
  url: 'u',
  state: 'MERGED',
  createdAt: '2026-08-10T12:00:00Z',
  mergedAt: '2026-08-11T18:45:31Z',
  headRefName: 'fix/issue-4334-branded-auth-email-links',
  lastCommitAt: '2026-08-11T18:40:00Z',
};

const uatFailPayload = (): ActionsPayload =>
  emptyPayload({
    issues: [
      {
        number: 4334,
        title: 'Branded auth email links',
        url: 'https://github.com/example-org/example-repo/issues/4334',
        updatedAt: '2026-08-12T09:00:00Z',
        labels: ['P2'],
        comments: [
          {
            id: '9001',
            author: { login: 'qa-alice', typename: 'User' },
            createdAt: '2026-08-12T09:00:00Z',
            body: '**Test Result:** Fail\nStill shows 100%.',
            url: 'https://github.com/example-org/example-repo/issues/4334#issuecomment-9001',
          },
        ],
        lane: 'QA',
        laneAt: '2026-08-11T18:44:03Z',
        referencingPrs: [SHIPPED_4334],
        mergedPrs: [SHIPPED_4334],
        mergedAt: '2026-08-11T18:45:31Z',
      },
    ],
  });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wc-actions-'));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: 4334, title: 'Branded auth email links', url: 'u', labels: ['P2'], updatedAt: 'z', author: 'operator' },
  ]);
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(gh, 'readGraphqlQuota').mockResolvedValue({ limit: 5000, remaining: 4000, resetAt: '2026-08-12T11:26:24Z' });
  vi.spyOn(resources, 'probeResources').mockResolvedValue(memoryOk());
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function orch(env: Record<string, string> = {}) {
  return new Orchestrator(
    loadConfig({
      REPO_PATH: repo,
      REPO: 'example-org/example-repo',
      STATE_FILE: join(repo, 'state.json'),
      POLL_MS: '999999',
      RESOURCES_MS: '999999',
      ...env,
    }),
  );
}

describe('the feed on a poll', () => {
  it('reads the omnibus once per poll and puts the verdict on the row', async () => {
    const fetchSpy = vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(uatFailPayload());
    const o = orch();
    await o.poll();
    const s = o.state();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(s.actions.actions.filter((a) => a.tier === 1)).toHaveLength(1);
    expect(s.actions.fetchedAt).not.toBeNull();
    // The row itself carries the send-back, so the list can float it above P0.
    // `inflight` says whether anybody is already fixing it — false here, and
    // never absent: an in-flight fail that reached the row as nothing at all is
    // what left #4914 reading "stage 9 post-merge".
    expect(s.issues.find((r) => r.number === 4334)!.uatFail).toEqual({
      by: 'qa-alice',
      at: '2026-08-12T09:00:00Z',
      verdict: 'Fail',
      url: 'https://github.com/example-org/example-repo/issues/4334#issuecomment-9001',
      inflight: false,
    });
    await o.stop();
  });

  it('reports what the read cost, straight off GitHub', async () => {
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(uatFailPayload());
    const o = orch();
    await o.poll();
    expect(o.state().actions.quota).toEqual({ remaining: 4000, limit: 5000, resetAt: '2026-08-12T11:26:24Z' });
    await o.stop();
  });
});

describe('honest degradation', () => {
  it('a failed read keeps the LAST good actions and says they are stale', async () => {
    const spy = vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(uatFailPayload());
    const o = orch();
    await o.poll();
    const fetchedAt = o.state().actions.fetchedAt;
    expect(fetchedAt).not.toBeNull();

    spy.mockRejectedValue(new Error('API rate limit exceeded'));
    await o.poll();
    const s = o.state();
    expect(s.actions.actions.filter((a) => a.tier === 1)).toHaveLength(1); // not emptied
    expect(s.actions.stale).toBe(true);
    expect(s.actions.error).toContain('rate limit');
    // The age on screen is the age of the DATA, never of the attempt.
    expect(s.actions.fetchedAt).toBe(fetchedAt);
    await o.stop();
  });

  it('a first-ever read that fails leaves fetchedAt null — "not read yet", not "nothing needs you"', async () => {
    vi.spyOn(gh, 'fetchActionsOnMe').mockRejectedValue(new Error('boom'));
    const o = orch();
    await o.poll();
    expect(o.state().actions).toMatchObject({ actions: [], fetchedAt: null, stale: true });
    await o.stop();
  });

  it('a good read after a bad one clears stale and error', async () => {
    const spy = vi.spyOn(gh, 'fetchActionsOnMe').mockRejectedValue(new Error('boom'));
    const o = orch();
    await o.poll();
    spy.mockResolvedValue(uatFailPayload());
    await o.poll();
    expect(o.state().actions).toMatchObject({ stale: false, error: null });
    await o.stop();
  });
});

describe('the brake', () => {
  it('skips the omnibus on a timer poll when the graphql bucket is under the floor', async () => {
    vi.spyOn(gh, 'readGraphqlQuota').mockResolvedValue({
      limit: 5000,
      remaining: 100,
      resetAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const spy = vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(emptyPayload());
    const o = orch({ ACTIONS_QUOTA_FLOOR: '500' });
    await o.poll();
    expect(spy).not.toHaveBeenCalled();
    expect(o.state().actions.paused).toContain('quota low');
    await o.stop();
  });

  it('the operator’s Refresh outranks the brake', async () => {
    vi.spyOn(gh, 'readGraphqlQuota').mockResolvedValue({
      limit: 5000,
      remaining: 0,
      resetAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const spy = vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(emptyPayload());
    const o = orch({ ACTIONS_QUOTA_FLOOR: '500' });
    await o.poll({ manual: true });
    expect(spy).toHaveBeenCalledTimes(1);
    await o.stop();
  });

  it('reads the quota FRESH every poll rather than trusting the last rider', async () => {
    // The workers on this token burn 13–70 points a minute; a fifteen-minute-old
    // rider is worthless. /rate_limit is free, so it is asked every time.
    const q = vi.spyOn(gh, 'readGraphqlQuota');
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(emptyPayload());
    const o = orch();
    await o.poll();
    await o.poll();
    expect(q).toHaveBeenCalledTimes(2);
    await o.stop();
  });
});

describe('correction 5 — a first run never storms the operator’s phone', () => {
  it('seeds the ledger silently on the first poll and sends nothing', async () => {
    // The #4334 scenario is dated, and the news floor is `now` minus seven days,
    // so this assertion aged out on its own: from 18 Aug the board move stopped
    // being news and only the ungated tier-1 verdict was left. Pin the clock to
    // the day the scenario happened. Date only — the orchestrator's own timers
    // must keep running, and faking them deadlocks the poll.
    vi.useFakeTimers({ now: Date.parse('2026-08-12T10:00:00Z'), toFake: ['Date'] });
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(uatFailPayload());
    const sent = vi.spyOn(push, 'sendPush');
    const o = orch();
    await o.poll();
    expect(sent).not.toHaveBeenCalled();
    // The actions are still in the feed — seen, just not announced: the verdict
    // and the board move. NOT an `assigned` row — #4334's PR merged, so "newly
    // assigned" is stale news about work that already shipped. That row was one
    // of the five rows the operator was looking at when the feed was calling
    // things "waiting on you" that needed nothing from them.
    expect(o.state().actions.actions.map((a) => a.kind).sort()).toEqual(['lane-change', 'uat-fail']);
    expect(existsSync(join(repo, 'actions.json'))).toBe(true);
    await o.stop();
  });

  it('the same action on the next poll is still not news', async () => {
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(uatFailPayload());
    const sent = vi.spyOn(push, 'sendPush');
    const o = orch();
    await o.poll();
    await o.poll();
    expect(sent).not.toHaveBeenCalled();
    await o.stop();
  });

  it('a NEW verdict after the seed does notify — once', async () => {
    const spy = vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(emptyPayload());
    const sent = vi.spyOn(push, 'sendPush').mockResolvedValue({ ok: true, gone: false, status: 201, error: null });
    const o = orch();
    await o.poll(); // seeds an empty ledger
    await o.setNotifyPrefs({ phone: true });
    await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } });

    spy.mockResolvedValue(uatFailPayload());
    await o.poll();
    // The verdict pushes on its own. The other thing this poll turned up (the
    // issue is newly `assigned`) does NOT: a single feed-only action is not a
    // roll-up, and "1 new action on you" per bot round is the mute button.
    // Two or more of them would bundle — see notify.test.ts.
    const kinds = sent.mock.calls.map((c) => c[1].kind);
    expect(kinds).toEqual(['uat-fail']);

    const before = sent.mock.calls.length;
    await o.poll();
    expect(sent.mock.calls.length).toBe(before); // nothing is news twice
    await o.stop();
  });

  it('a console RESTART does not re-announce anything', async () => {
    const spy = vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(emptyPayload());
    const sent = vi.spyOn(push, 'sendPush').mockResolvedValue({ ok: true, gone: false, status: 201, error: null });
    const o = orch();
    await o.poll();
    await o.setNotifyPrefs({ phone: true });
    await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } });
    spy.mockResolvedValue(uatFailPayload());
    await o.poll();
    const before = sent.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    await o.stop();

    // A brand new Orchestrator over the same actions.json — the real restart.
    const o2 = orch();
    await o2.poll();
    expect(sent.mock.calls.length).toBe(before);
    await o2.stop();
  });
});

/**
 * `actions.json` is not a cache. It holds the push subscription `auth` secret —
 * endpoint + auth is enough to FORGE notifications to the operator's phone — and
 * the `detail` field of every action, which is the first line of a real comment
 * on a private repository's work.
 *
 * `push-keys.json` was already written 0600. This file holds a secret of the
 * same class and was going out at the default 0644.
 */
describe('the secret file is written like a secret', () => {
  it('actions.json is 0600, like push-keys.json', async () => {
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(uatFailPayload());
    const o = orch();
    await o.poll();
    await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } });
    const file = join(repo, 'actions.json');
    expect(existsSync(file)).toBe(true);
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
    await o.stop();
  });

  it('and it really does hold both the auth secret and work data', async () => {
    // The reason for the mode, asserted rather than described in a comment.
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(uatFailPayload());
    const o = orch();
    await o.poll();
    await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'sekrit' } });
    const raw = readFileSync(join(repo, 'actions.json'), 'utf8');
    expect(raw).toContain('sekrit');
    expect(raw).toContain('Branded auth email links');
    await o.stop();
  });
});

/**
 * `/api/push/subscribe` has no auth — the console binds loopback and says it
 * will never have any, but Tailscale Serve proxies the whole tailnet at it. A
 * device that registers its own keypair can DECRYPT every push from then on:
 * the kind, the issue number, and the fact a UAT fail landed.
 *
 * A pairing code is the real answer and is not built (`publicVapid` still
 * claims it is). Two things that ARE cheap and that the design was missing
 * entirely: a rogue registration must be VISIBLE, and it must be BOUNDED —
 * every registered device costs up to four sequential HTTP round trips inside
 * the poll, which holds the `#polling` guard shut while they run.
 */
describe('registered phones are visible and bounded', () => {
  it('says how many devices are registered, so a rogue one can be seen at all', async () => {
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(emptyPayload());
    const o = orch();
    await o.poll();
    expect(o.state().pushDevices).toBe(0);
    await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/a', keys: { p256dh: 'p', auth: 'a' } });
    await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/b', keys: { p256dh: 'p', auth: 'a' } });
    expect(o.state().pushDevices).toBe(2);
    // Re-registering the same endpoint is the SAME device, not a second one.
    await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/b', keys: { p256dh: 'p2', auth: 'a2' } });
    expect(o.state().pushDevices).toBe(2);
    await o.stop();
  });

  it('refuses to grow without bound, and says so rather than silently dropping', async () => {
    const o = orch();
    for (let i = 0; i < 5; i += 1) {
      const r = await o.savePushSubscription({ endpoint: `https://web.push.apple.com/${i}`, keys: { p256dh: 'p', auth: 'a' } });
      expect(r.ok).toBe(true);
    }
    const over = await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/six', keys: { p256dh: 'p', auth: 'a' } });
    expect(over.ok).toBe(false);
    expect(over.message).toContain('5');
    expect(o.state().pushDevices).toBe(5);
    // An existing device can still re-register — the cap must never lock the
    // operator's own phone out of refreshing its subscription.
    const again = await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/0', keys: { p256dh: 'p', auth: 'a' } });
    expect(again.ok).toBe(true);
    await o.stop();
  });
});

describe('a dead phone subscription surfaces', () => {
  it('drops the subscription on 410 and raises a banner rather than failing silently', async () => {
    const spy = vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(emptyPayload());
    vi.spyOn(push, 'sendPush').mockResolvedValue({ ok: false, gone: true, status: 410, error: 'gone' });
    const o = orch();
    await o.poll();
    await o.setNotifyPrefs({ phone: true });
    await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } });
    spy.mockResolvedValue(uatFailPayload());
    await o.poll();
    expect(o.state().actions.pushProblem).toContain('Phone notifications stopped');
    expect(JSON.parse(readFileSync(join(repo, 'actions.json'), 'utf8')).subscriptions).toEqual([]);
    await o.stop();
  });

  /**
   * BLOCK — the banner had a half-life of one restart.
   *
   * The feed snapshot was taken BEFORE `#announce` ran, so the copy written to
   * disk was the pre-banner one. On restart the subscription was already gone
   * (correctly removed) AND the only evidence it had ever been dropped was gone
   * too — and because the subscription is deleted, no future 410 can ever raise
   * it again. The operator's phone ends up permanently unsubscribed, silently,
   * on a console whose entire design story is surviving restarts.
   */
  it('the banner SURVIVES a restart — otherwise the phone is silently unsubscribed for ever', async () => {
    const spy = vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(emptyPayload());
    vi.spyOn(push, 'sendPush').mockResolvedValue({ ok: false, gone: true, status: 410, error: 'gone' });
    const o = orch();
    await o.poll();
    await o.setNotifyPrefs({ phone: true });
    await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } });
    spy.mockResolvedValue(uatFailPayload());
    await o.poll();
    expect(o.state().actions.pushProblem).toContain('Phone notifications stopped');
    // It is on disk, not only in memory — that is the whole bug.
    const saved = JSON.parse(readFileSync(join(repo, 'actions.json'), 'utf8'));
    expect(saved.feed.pushProblem).toContain('Phone notifications stopped');
    expect(saved.subscriptions).toEqual([]);
    await o.stop();

    // A brand new Orchestrator over the same actions.json — the real restart.
    const o2 = orch();
    await o2.poll();
    expect(o2.state().actions.pushProblem).toContain('Phone notifications stopped');
    await o2.stop();
  });

  /**
   * BLOCK — every failure that was not 404/410 was thrown away.
   *
   * `r.error` and `r.status` were never read on the poll path. A 400
   * BadJwtToken, a 403 VapidPkHashMismatch (which is exactly what a regenerated
   * `push-keys.json` produces), a 429 or a 500 all left `sent` false, so the
   * ledger was never stamped and the SAME notifications were re-planned on every
   * poll for ever — no backoff, no cap, no banner. `sendTestPush` surfaced
   * `r.error`; the automatic path, the one that runs when the operator is away
   * from the desk, did not.
   */
  it('a relay that keeps refusing says so, once, instead of retrying in silence for ever', async () => {
    const spy = vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(emptyPayload());
    vi.spyOn(push, 'sendPush').mockResolvedValue({ ok: false, gone: false, status: 403, error: 'VapidPkHashMismatch' });
    const o = orch();
    const toasts: unknown[] = [];
    o.on('action', (a) => toasts.push(a));
    await o.poll();
    await o.setNotifyPrefs({ phone: true });
    await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } });

    spy.mockResolvedValue(uatFailPayload());
    await o.poll();
    // It is said out loud, in the relay's own words.
    expect(o.state().actions.pushProblem).toContain('VapidPkHashMismatch');
    const afterFirst = toasts.length;
    expect(afterFirst).toBeGreaterThan(0);

    // ...and the round is settled. A working channel (the in-app toast) DID
    // deliver it, so it must not re-fire on every poll from now until reboot.
    await o.poll();
    await o.poll();
    expect(toasts.length).toBe(afterFirst);
    // The subscription is NOT dropped: a refusal is not a dead phone.
    expect(JSON.parse(readFileSync(join(repo, 'actions.json'), 'utf8')).subscriptions).toHaveLength(1);
    await o.stop();
  });
});

/**
 * The button in Settings that proves the setup end to end. Four things each fail
 * silently — keys, subscription, relay, the phone's own permission — and all
 * four only matter when the operator is away from the desk, so there has to be a
 * way to ask them a question and get an answer they can act on.
 */
describe('send test push', () => {
  it('says what to do when no phone is registered, rather than appearing to work', async () => {
    const sent = vi.spyOn(push, 'sendPush');
    const o = orch();
    const r = await o.sendTestPush();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('No phone is registered');
    expect(sent).not.toHaveBeenCalled();
    await o.stop();
  });

  it('sends one to each registered phone and carries NO work data at all', async () => {
    const sent = vi.spyOn(push, 'sendPush').mockResolvedValue({ ok: true, gone: false, status: 201, error: null });
    const o = orch();
    await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } });
    const r = await o.sendTestPush();
    expect(r.ok).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
    // Not a title, not a number, not a login. It is a test of the plumbing, and
    // the plumbing does not need to know what an issue is called.
    const message = JSON.stringify(sent.mock.calls[0]![1]);
    expect(message).not.toMatch(/#\d/);
    expect(message).not.toMatch(/issue|example-repo|operator/i);
    await o.stop();
  });

  it('a 410 drops the phone, raises the banner, and says so in the answer', async () => {
    vi.spyOn(push, 'sendPush').mockResolvedValue({ ok: false, gone: true, status: 410, error: 'gone' });
    const o = orch();
    await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } });
    const r = await o.sendTestPush();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('expired');
    expect(o.state().actions.pushProblem).toContain('Phone notifications stopped');
    await o.stop();
  });

  it('a relay that refuses it repeats the relay’s own reason', async () => {
    vi.spyOn(push, 'sendPush').mockResolvedValue({ ok: false, gone: false, status: 400, error: 'BadJwtToken' });
    const o = orch();
    await o.savePushSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } });
    const r = await o.sendTestPush();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('BadJwtToken');
    // A refusal is not a dead phone: the subscription stays.
    expect(JSON.parse(readFileSync(join(repo, 'actions.json'), 'utf8')).subscriptions).toHaveLength(1);
    await o.stop();
  });
});

describe('nothing here writes to GitHub', () => {
  it('a poll that produces a tier-1 action still calls no writer', async () => {
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(uatFailPayload());
    const o = orch();
    await o.poll();
    // gh.ts exports no writer at all — this is the guard that keeps it that way.
    const writers = Object.keys(gh).filter((k) => /^(post|create|update|delete|add|remove|merge|close)/i.test(k));
    expect(writers).toEqual([]);
    await o.stop();
  });
});

/**
 * SUPPRESSION MUST DEFER THE ROW, NEVER SPEND IT.
 *
 * `knownAssigned` was stamped from the whole payload on every poll, straight
 * after `deriveActions` and regardless of what it had produced. So the first
 * poll where an issue was at a gate / in flight / shipped both hid the "newly
 * assigned" row AND marked the issue known — and when the condition cleared
 * there was no second chance, for ever. Every issue this console ever ran a
 * worker on had its assignment event silently consumed.
 */
describe('an assignment the console suppressed is deferred, not spent', () => {
  const oneAssigned = (n: number): ActionsPayload =>
    emptyPayload({
      issues: [
        {
          number: n,
          title: 'Save and Exit',
          url: `https://github.com/example-org/example-repo/issues/${n}`,
          updatedAt: '2026-08-12T09:00:00Z',
          labels: ['P2'],
          comments: [],
          lane: 'In progress',
          laneAt: null,
          referencingPrs: [],
          mergedPrs: [],
          mergedAt: null,
        },
      ],
    });

  const assignedRows = (o: Orchestrator) =>
    o.state().actions.actions.filter((a) => a.kind === 'assigned').map((a) => a.subject.number);

  it('#4405 is parked at a gate on the first read, and is announced once the gate is gone', async () => {
    vi.spyOn(gh, 'listIssues').mockResolvedValue([
      { number: 4405, title: 'Save and Exit', url: 'u', labels: ['P2'], updatedAt: 'z', author: 'operator' },
    ]);
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(oneAssigned(4405));
    const tree = join(repo, '.worktrees', 'issue-4405-save-and-exit');
    execFileSync('git', ['worktree', 'add', '-b', 'fix/issue-4405-save-and-exit', tree, 'dev'], {
      cwd: repo,
      stdio: 'ignore',
    });
    const gate = join(tree, '.gate.json');
    writeFileSync(
      gate,
      JSON.stringify({
        issue: 4405,
        gate: 'C',
        stage: 5,
        sessionId: null,
        stoppedAt: new Date().toISOString(),
        reportPath: null,
        summary: 'Your QA, please.',
        questions: [],
      }),
    );

    const o = orch();
    await o.poll();
    // The gate card owns it, so no feed row beside it. Right — and it must not
    // cost it the row.
    expect(assignedRows(o)).toEqual([]);

    // The gate is answered, the run ends, the worker deletes its own gate file.
    unlinkSync(gate);
    await o.poll();
    expect(assignedRows(o)).toEqual([4405]);
    await o.stop();
  });

  it('and once it HAS been announced it is never announced again', async () => {
    vi.spyOn(gh, 'listIssues').mockResolvedValue([]);
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(oneAssigned(4472));
    const o = orch();
    await o.poll();
    expect(assignedRows(o)).toEqual([4472]);
    await o.poll();
    expect(assignedRows(o)).toEqual([]);
    await o.stop();
  });

  it('an issue that LEFT the operator’s plate and came back is news again', async () => {
    // `knownAssigned` is intersected with the live payload on purpose: closed or
    // reassigned away drops it, so being handed it back reads as the fresh ask
    // it is. A plain union would have made that silent for ever.
    const spy = vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(oneAssigned(4472));
    vi.spyOn(gh, 'listIssues').mockResolvedValue([]);
    const o = orch();
    await o.poll();
    expect(assignedRows(o)).toEqual([4472]);
    spy.mockResolvedValue(emptyPayload());
    await o.poll();
    spy.mockResolvedValue(oneAssigned(4472));
    await o.poll();
    expect(assignedRows(o)).toEqual([4472]);
    await o.stop();
  });
});
