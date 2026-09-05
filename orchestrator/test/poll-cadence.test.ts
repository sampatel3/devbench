import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ResourceReport } from '../src/types.js';

/**
 * Two cadences that used to be one.
 *
 * The GitHub poll went from two minutes to fifteen because a night of it
 * exhausted the 5,000/hr GraphQL quota. The local machine read — memory_pressure,
 * vm_stat, one `docker stats` — was the fifth entry in that poll's `Promise.all`,
 * and it costs no network and no quota, so it was NOT allowed to follow GitHub
 * out to fifteen minutes: the dispatch banner, the edge-runtime button's size
 * label and the poll-side half of the dispatch verdict are all drawn from it.
 *
 * Nothing here spawns a worker, signals a pid, or reads the operator's real machine: `gh`
 * and `probeResources` are both stubbed, and the timers are set far enough out
 * that only the explicit calls in these tests ever run.
 */

let home: string;
let repoPath: string;
let stateFile: string;
let freePct = 90;

const report = (): ResourceReport =>
  ({
    ok: freePct >= 25,
    reason: freePct >= 25 ? 'memory ok' : `waiting on memory — ${freePct}% free, need 25%`,
    freePct,
    headroomBytes: 0,
    headroomLabel: '9 GB',
    minFreePct: 25,
    footprintBytes: 0,
    footprintLabel: '0 GB',
    ceilingBytes: 1,
    ceilingLabel: '1 GB',
    totalBytes: 2,
    edgeRuntimeLabel: null,
    checkedAt: new Date().toISOString(),
  }) as ResourceReport;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-cadence-')));
  repoPath = join(home, 'repo'); // deliberately not a git repo: nothing here scans
  mkdirSync(repoPath, { recursive: true });
  stateFile = join(home, 'state.json');
  freePct = 90;

  vi.spyOn(gh, 'listIssues').mockResolvedValue([]);
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(resources, 'probeResources').mockImplementation(async () => report());
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Both timers far enough out that nothing fires on its own. */
function orch() {
  return new Orchestrator(
    loadConfig({
      REPO: 'example-org/example-repo',
      REPO_PATH: repoPath,
      STATE_FILE: stateFile,
      CANONICAL_CLAUDE_DIR: join(home, '.claude'),
      ACCOUNTS_FILE: join(home, 'accounts.json'),
      POLL_MS: '999999',
      RESOURCES_MS: '999999',
    }),
  );
}

describe('when GitHub was last read', () => {
  it('is stamped by a poll and reported to the UI with the cadence', async () => {
    const o = orch();
    await o.start(); // start() polls once
    const first = o.state().lastPolledAt;
    expect(first).not.toBeNull();
    expect(Date.parse(first!)).toBeGreaterThan(0);
    // The UI says the real cadence rather than hard-coding a number that would
    // then drift from POLL_MS.
    expect(o.state().pollMs).toBe(999999);
    await o.stop();
  });

  it('moves when Refresh forces one — the click that makes 15 minutes liveable', async () => {
    const o = orch();
    await o.start();
    const before = o.state().lastPolledAt!;
    await new Promise((r) => setTimeout(r, 5));
    await o.poll(); // exactly what POST /api/refresh does
    expect(Date.parse(o.state().lastPolledAt!)).toBeGreaterThan(Date.parse(before));
    await o.stop();
  });
});

describe('the local machine read', () => {
  it('refreshes the memory report WITHOUT asking GitHub anything', async () => {
    const o = orch();
    await o.start();
    const ghCalls = vi.mocked(gh.listIssues).mock.calls.length;
    const probeCalls = vi.mocked(resources.probeResources).mock.calls.length;
    const readAt = o.state().lastPolledAt;

    // The machine got tight between GitHub polls. At fifteen minutes, a console
    // that only learned this from the poll would tell the operator there was headroom for
    // a quarter of an hour after there was not — which is the exact failure the
    // whole memory guard exists for.
    freePct = 12;
    await o.resourceTick();

    expect(o.state().resources?.freePct).toBe(12);
    expect(o.state().resources?.ok).toBe(false);
    expect(vi.mocked(resources.probeResources).mock.calls.length).toBe(probeCalls + 1);
    // No quota spent, and the GitHub read time is untouched: this tick is not a
    // poll and must never look like one.
    expect(vi.mocked(gh.listIssues).mock.calls.length).toBe(ghCalls);
    expect(o.state().lastPolledAt).toBe(readAt);
    await o.stop();
  });

  it('keeps the last good report when the probe throws, rather than blanking it', async () => {
    const o = orch();
    await o.start();
    expect(o.state().resources?.freePct).toBe(90);

    vi.mocked(resources.probeResources).mockRejectedValueOnce(new Error('docker is not running'));
    await o.resourceTick();

    // An unreadable machine is not a machine with no memory: keep what we knew.
    expect(o.state().resources?.freePct).toBe(90);
    await o.stop();
  });

  it('does nothing once the console has been told to stop', async () => {
    const o = orch();
    await o.start();
    await o.stop();
    const probeCalls = vi.mocked(resources.probeResources).mock.calls.length;
    await o.resourceTick();
    expect(vi.mocked(resources.probeResources).mock.calls.length).toBe(probeCalls);
  });
});

/**
 * BLOCK — the poll stamped "read just now" over data it had failed to read.
 *
 * `#lastPolledAt` was set unconditionally at the end of `poll()`, but
 * `listOpenPrs` and `listRecentMergedPrs` swallowed their error and returned the
 * PREVIOUS map with no surface at all. Only `listIssues` set `#pollError`. So a
 * rate limit or a 502 on the two PR lists left the header and the Dashboard
 * rendering "GitHub read 16:44" over PR and stage data an hour old, with no
 * banner anywhere.
 *
 * That contradicts the rule stated three times in orchestrator.ts and kept
 * correctly by the actions feed: the age on screen is the age of the DATA, never
 * of the attempt.
 *
 * `scanWorktrees` is deliberately NOT in this set — it is a local filesystem
 * read, and `#lastPolledAt` is rendered as "GitHub read HH:MM".
 */
describe('a partly-failed poll does not claim to be a read', () => {
  it('names the read that failed instead of swallowing it', async () => {
    vi.mocked(gh.listOpenPrs).mockRejectedValue(new Error('HTTP 502: Bad gateway'));
    const o = orch();
    await o.poll();
    expect(o.state().pollError).toContain('502');
    await o.stop();
  });

  it('does not move the "GitHub read" stamp when a GitHub read failed', async () => {
    const o = orch();
    await o.poll();
    const good = o.state().lastPolledAt;
    expect(good).not.toBeNull();

    vi.mocked(gh.listRecentMergedPrs).mockRejectedValue(new Error('API rate limit exceeded'));
    await o.poll();
    const s = o.state();
    expect(s.lastPolledAt).toBe(good); // the DATA is still the old data
    expect(s.pollError).toContain('rate limit');
    await o.stop();
  });

  it('clears the error and moves the stamp again once GitHub answers', async () => {
    vi.mocked(gh.listOpenPrs).mockRejectedValueOnce(new Error('boom'));
    const o = orch();
    await o.poll();
    expect(o.state().pollError).not.toBeNull();
    const stuck = o.state().lastPolledAt;
    await o.poll();
    expect(o.state().pollError).toBeNull();
    expect(o.state().lastPolledAt).not.toBe(stuck);
    await o.stop();
  });
});

/**
 * FIX — `/api/refresh` reported success for a read that never happened.
 *
 * `poll()` returns silently on re-entry, and the route replied "read GitHub just
 * now" regardless. The dropped poll is the `manual: true` one — the only path
 * that outranks the quota brake — and the operator presses Refresh precisely when the
 * feed looks stale, which is exactly when a slow poll is most likely to be in
 * flight.
 */
describe('a poll says whether it actually ran', () => {
  it('reports true when it read, and false when it was dropped for one already running', async () => {
    const o = orch();
    const first = o.poll();
    const second = o.poll({ manual: true }); // lands while the first is in flight
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(await o.poll({ manual: true })).toBe(true);
    await o.stop();
  });
});
