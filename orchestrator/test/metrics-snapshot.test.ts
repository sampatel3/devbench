import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import * as gh from '../src/gh.js';
import * as metrics from '../src/metrics.js';
import * as resources from '../src/resources.js';
import { memoryOk } from './fixtures/memory.js';
import type { RunRecord } from '../src/metrics.js';

/**
 * The router-readiness card is a BACKGROUND job, not something the Dashboard
 * computes on render: once when the console starts, then daily, persisted so a
 * restart shows the last answer immediately.
 *
 * Two things it must never do: compute on the page (it reads a log and makes a
 * gh call), and present a stale answer as a fresh one. A refresh that fails
 * keeps the last good figures AND says the refresh failed.
 *
 * Nothing here touches the machine: no deps are wired, so the orchestrator gets
 * no probes, no signal and no container action, and `probeResources` is stubbed.
 */

let home: string;
let stateFile: string;
let runsFile: string;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const RUN: RunRecord = {
  issue: 4336,
  segment: 'C',
  model: 'claude-opus-5',
  resolvedModel: 'claude-opus-5',
  account: 'personal',
  startedAt: '2026-08-11T10:00:00.000Z',
  endedAt: '2026-08-11T10:20:00.000Z',
  durationMs: 1_200_000,
  sessionId: 's',
  exit: 'gate',
  error: null,
  stageStart: 1,
  stageEnd: 4,
  inputTokens: 10,
  outputTokens: 100,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  costUsd: 1,
  assistantTurns: 5,
  toolCalls: 5,
  usageSource: 'modelUsage',
  filesChanged: 3,
  insertions: 30,
  deletions: 3,
  touchedMigration: false,
  labels: [],
  gateStopsBefore: 0,
};

const logRun = (over: Partial<RunRecord> = {}) =>
  appendFileSync(runsFile, JSON.stringify({ ...RUN, ...over, sessionId: String(Math.random()) }) + '\n');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wc-snap-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  stateFile = join(home, 'state.json');
  runsFile = join(home, 'runs.jsonl');

  vi.spyOn(gh, 'listIssues').mockResolvedValue([]);
  // Merged PRs are read on every poll now (a merged PR used to vanish from the
  // console and the row lied). Stubbed empty so no test reaches the network.
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listAuthoredOpenPrs').mockResolvedValue([]);
  vi.spyOn(resources, 'probeResources').mockResolvedValue(memoryOk());
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function orch(env: Record<string, string> = {}) {
  return new Orchestrator(
    loadConfig({
      REPO: 'example-org/example-repo',
      REPO_PATH: join(home, 'repo'),
      STATE_FILE: stateFile,
      RUNS_FILE: runsFile,
      STREAM_DIR: join(home, 'runs'),
      CANONICAL_CLAUDE_DIR: join(home, '.claude'),
      POLL_MS: '999999',
      METRICS_REFRESH_HOURS: '999',
      ...env,
    }),
  );
}

/**
 * The snapshot as it is ON DISK, or null if it is not there yet.
 *
 * `state.json` is written temp-file-then-rename, so a reader gets the whole file
 * or no file — never half of one. "No file" is a real answer here and not a
 * failure: the console sets the snapshot in memory and THEN awaits the save, so
 * `metricsSnapshot() !== null` leads the file by one turn of the event loop.
 * Waiting on the in-memory signal and then reading the file is the race this
 * test used to lose under load (ENOENT on state.json, roughly one run in ten).
 */
const persistedSnapshot = (): { computedAt: string } | null => {
  try {
    return (JSON.parse(readFileSync(stateFile, 'utf8')) as { metricsSnapshot?: { computedAt: string } })
      .metricsSnapshot ?? null;
  } catch {
    return null;
  }
};

describe('the router-readiness snapshot', () => {
  it('is computed once at startup and written down', async () => {
    for (let i = 0; i < 3; i++) logRun();
    const o = orch();
    await o.start();
    await waitFor('the snapshot to be written down', () => persistedSnapshot() !== null);

    const snap = o.metricsSnapshot()!;
    expect(snap.totalRuns).toBe(3);
    expect(snap.models).toEqual(['claude:claude-opus-5']);
    expect(snap.readiness.ready).toBe(false);
    expect(snap.readiness.headline).toContain('cannot be compared with itself');
    expect(persistedSnapshot()!.computedAt).toBe(snap.computedAt);
    await o.stop();
  });

  /**
   * The failure that matters: the card must not go blank, and it must not look
   * fresh. The last good figures stay, with the failure attached — the age is
   * always on screen beside them.
   */
  it('survives a restart, and keeps the last good answer when a refresh fails', async () => {
    for (let i = 0; i < 3; i++) logRun();
    const first = orch();
    await first.start();
    await waitFor('the first snapshot', () => first.metricsSnapshot() !== null);
    const before = first.metricsSnapshot()!;
    await first.stop();

    vi.spyOn(metrics, 'readRuns').mockRejectedValue(new Error('runs.jsonl is unreadable'));
    const second = orch();
    await second.start();
    await waitFor('the failed refresh', () => second.metricsSnapshot()?.error != null);

    const after = second.metricsSnapshot()!;
    expect(after.totalRuns).toBe(3); // the last good figures, not zero
    expect(after.computedAt).toBe(before.computedAt); // and honestly dated
    expect(after.error).toContain('could not refresh');
    expect(after.error).toContain('unreadable');
    await second.stop();
  });

  it('says so plainly when it has never managed to compute one', async () => {
    vi.spyOn(metrics, 'readRuns').mockRejectedValue(new Error('nope'));
    const o = orch();
    await o.start();
    await waitFor('the failed refresh', () => o.metricsSnapshot() !== null);

    const snap = o.metricsSnapshot()!;
    expect(snap.readiness.ready).toBe(false);
    expect(snap.readiness.headline).toContain('Could not read the run log');
    expect(snap.error).toContain('nope');
    await o.stop();
  });

  it('recomputes on demand, which is what the button does', async () => {
    logRun();
    const o = orch();
    await o.start();
    await waitFor('the first snapshot', () => o.metricsSnapshot() !== null);
    expect(o.metricsSnapshot()!.totalRuns).toBe(1);

    logRun({ model: 'claude-sonnet-5' });
    const fresh = await o.refreshMetricsSnapshot();
    expect(fresh.totalRuns).toBe(2);
    expect(fresh.models).toEqual(['claude:claude-opus-5', 'claude:claude-sonnet-5']);
    await o.stop();
  });

  /**
   * The interval really does fire, and really does stop with the console.
   *
   * The reading that proves it has to be taken AFTER the console has stopped and
   * after anything already in flight has landed. Sampling before `stop()` and
   * asserting the value afterwards is a race the test loses under load: on a
   * 36 ms timer another refresh can fire between the sample and the stop, and the
   * suite then fails on a console that behaved perfectly.
   */
  it('refreshes on its own timer, and stops when the console stops', async () => {
    logRun();
    // 0.00001 h ≈ 36 ms: the same code path as the daily one, in a test's time.
    const o = orch({ METRICS_REFRESH_HOURS: '0.00001' });
    await o.start();
    await waitFor('the first snapshot', () => o.metricsSnapshot() !== null);
    const first = o.metricsSnapshot()!.computedAt;

    // It fires on its own.
    await waitFor('a scheduled refresh', () => o.metricsSnapshot()!.computedAt !== first, 5_000);

    await o.stop();
    await wait(200); // long enough for a refresh already under way to finish
    const settled = o.metricsSnapshot()!.computedAt;
    await wait(200); // several more intervals' worth: a live timer would move it
    expect(o.metricsSnapshot()!.computedAt).toBe(settled);
  });
});
