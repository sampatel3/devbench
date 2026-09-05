import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, listen } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import type { Orchestrator } from '../src/orchestrator.js';

/**
 * The routes. All of them are about the console's own state — none of them
 * touches GitHub, and `comment.ts` remains the only writer in the build.
 */

let dir: string;
let server: Awaited<ReturnType<typeof listen>>;
let base: string;

const calls: Record<string, unknown[]> = {};
/** The orchestrator's event listeners, so a test can fire one. */
const listeners: Record<string, ((payload: unknown) => void) | undefined> = {};

function fakeOrch() {
  const record = (name: string, ...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  return {
    state: () => ({ issues: [], actions: { actions: [], banner: null } }),
    on: (event: string, fn: (payload: unknown) => void) => {
      listeners[event] = fn;
    },
    off: (event: string) => {
      delete listeners[event];
    },
    poll: vi.fn(async (opts?: unknown) => record('poll', opts)),
    markActionsSeen: vi.fn(async () => {
      record('seen');
      return { seenAt: '2026-08-12T12:00:00Z' };
    }),
    vapidPublicKey: () => 'BPUBLICKEY',
    savePushSubscription: vi.fn(async (sub: unknown) => {
      record('subscribe', sub);
      return { ok: true, count: 1 };
    }),
    removePushSubscription: vi.fn(async (endpoint: string) => {
      record('unsubscribe', endpoint);
      return { ok: true, count: 0 };
    }),
    sendTestPush: vi.fn(async () => {
      record('test-push');
      return { ok: true, message: 'Sent to 1 phone — it should arrive within a few seconds.' };
    }),
    setNotifyPrefs: vi.fn(async (patch: unknown) => {
      record('prefs', patch);
      return { enabled: true, inApp: true, phone: true, detail: 'numbers', kinds: {} };
    }),
    notifyPrefs: () => ({ enabled: true, inApp: true, phone: false, detail: 'numbers', kinds: {} }),
    notifications: vi.fn(async () => {
      record('log');
      return {
        entries: [
          { id: 'uat-fail:issue#4334:9001', kind: 'uat-fail', tier: 1, at: '2026-08-12T09:00:00Z', seeded: false, read: false, subject: null, actor: null, reason: null },
        ],
        unread: 1,
      };
    }),
    markNotificationsRead: vi.fn(async () => {
      record('read');
      return { ok: true as const, unread: 0 };
    }),
    clearNotifications: vi.fn(async () => {
      record('clear');
      return { ok: true as const, message: 'log cleared' };
    }),
  } as unknown as Orchestrator;
}

beforeEach(async () => {
  for (const k of Object.keys(calls)) delete calls[k];
  for (const k of Object.keys(listeners)) delete listeners[k];
  dir = mkdtempSync(join(tmpdir(), 'wc-srv-actions-'));
  const cfg = loadConfig({ STATE_FILE: join(dir, 'state.json'), PORT: '0', UI_DIR: join(dir, 'no-ui') });
  server = await listen(createServer(cfg, fakeOrch()), { ...cfg, port: 0 });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

describe('the feed rides the state everyone already reads', () => {
  it('GET /api/state carries the actions feed — no second endpoint to poll', async () => {
    const s = await (await fetch(`${base}/api/state`)).json();
    expect(s.actions).toBeDefined();
    expect(s.actions.actions).toEqual([]);
  });

  it('the SSE carries a named `action` event, so the toast is decided once for every tab', async () => {
    // Per-tab diffing would toast the same UAT fail three times with three tabs
    // open, and never at all in a tab opened after the fact.
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read(); // the initial state frame

    listeners.action?.({ kind: 'uat-fail', subject: { number: 4334 } });
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain('event: action');
    expect(chunk).toContain('"kind":"uat-fail"');
    controller.abort();
  });
});

describe('POST /api/actions/seen', () => {
  it('advances the seen stamp', async () => {
    const res = await post('/api/actions/seen');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seenAt: '2026-08-12T12:00:00Z' });
    expect(calls.seen).toHaveLength(1);
  });
});

describe('push registration', () => {
  it('GET /api/push/vapid hands over the PUBLIC key only', async () => {
    const body = await (await fetch(`${base}/api/push/vapid`)).json();
    expect(body).toEqual({ publicKey: 'BPUBLICKEY' });
    expect(JSON.stringify(body)).not.toContain('privateKey');
  });

  it('POST /api/push/subscribe stores a well-formed subscription', async () => {
    const sub = { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } };
    const res = await post('/api/push/subscribe', sub);
    expect(res.status).toBe(200);
    expect(calls.subscribe![0]).toEqual([sub]);
  });

  it('refuses a subscription that is not one, rather than storing junk', async () => {
    const res = await post('/api/push/subscribe', { endpoint: 'https://x/y' });
    expect(res.status).toBe(400);
    expect(calls.subscribe).toBeUndefined();
  });

  it('refuses an endpoint that is not https — a push URL is always https', async () => {
    const res = await post('/api/push/subscribe', {
      endpoint: 'http://evil.local/x',
      keys: { p256dh: 'p', auth: 'a' },
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/push/unsubscribe removes it', async () => {
    const res = await post('/api/push/unsubscribe', { endpoint: 'https://web.push.apple.com/x' });
    expect(res.status).toBe(200);
    expect(calls.unsubscribe![0]).toEqual(['https://web.push.apple.com/x']);
  });

  /**
   * The button that proves the setup. Keys, subscription, relay and the phone's
   * own permission each fail silently and only matter when the operator is away from the
   * desk — a local `showNotification` in the page would prove none of them.
   */
  it('POST /api/push/test sends one, and answers in words a person can act on', async () => {
    const res = await post('/api/push/test');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'Sent to 1 phone — it should arrive within a few seconds.' });
    expect(calls['test-push']).toHaveLength(1);
  });
});

describe('the off switches are edited in the app, not in an env var', () => {
  it('POST /api/notify/prefs takes a patch', async () => {
    const res = await post('/api/notify/prefs', { phone: false, kinds: { 'uat-fail': 'feed' } });
    expect(res.status).toBe(200);
    expect(calls.prefs![0]).toEqual([{ phone: false, kinds: { 'uat-fail': 'feed' } }]);
  });

  it('rejects a switch value this build does not know', async () => {
    const res = await post('/api/notify/prefs', { kinds: { 'uat-fail': 'shout' } });
    expect(res.status).toBe(400);
    expect(calls.prefs).toBeUndefined();
  });
});

describe('Refresh tells the poll it was a person', () => {
  it('POST /api/refresh polls with manual: true, so the quota brake stands aside', async () => {
    await post('/api/refresh');
    expect(calls.poll![0]).toEqual([{ manual: true }]);
  });
});

/**
 * The bell. Its own route rather than a field on the state frame: the whole
 * history is far bigger than the handful of rows the feed carries, and it is
 * read when the tab is opened rather than on every tick.
 */
describe('the log of what was announced', () => {
  it('GET /api/notifications returns the entries and the unread count for the badge', async () => {
    const res = await fetch(`${base}/api/notifications`);
    expect(res.status).toBe(200);
    const o = await res.json();
    expect(o.entries).toHaveLength(1);
    expect(o.unread).toBe(1);
  });

  it('POST /api/notifications/read settles them — opening the tab is reading it', async () => {
    const res = await post('/api/notifications/read');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, unread: 0 });
    expect(calls.read).toHaveLength(1);
  });

  it('POST /api/notifications/clear empties the list', async () => {
    const res = await post('/api/notifications/clear');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'log cleared' });
    expect(calls.clear).toHaveLength(1);
  });
});
