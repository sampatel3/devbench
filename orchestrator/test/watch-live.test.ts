import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator, FANOUT_RULE, SKILLS_RULE } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ResourceReport, RunningRun } from '../src/types.js';

/**
 * The watcher as it is actually wired: what one tick costs, what it refuses to
 * do from a test, how quickly dispatch reacts to it, and whether a spike that
 * has already passed is still visible afterwards.
 *
 * The 2-minute blind spot is the point of most of this. On the night of the
 * crash the dashboard reported headroom from a poll up to two minutes old while
 * the machine went down; dispatch has to react in one tick, not one poll.
 */

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const ISSUE = 4478;
const GB = 1024 ** 3;

let repo: string;
let worktree: string;
let home: string;
let canonical: string;
let stateFile: string;
let runsFile: string;
let streamDir: string;
let goFile: string;
let calls: { ps: number; pressure: number; vm: number };
let freePctNow: number | null;

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A fabricated process table: a claude root with a big fan-out under it. */
function fakeForest(rootPid: number, workerRssKb: number, workers = 9): string {
  const lines = [` 1 0 1 20000 S`, ` ${rootPid} 1 ${rootPid} 400000 Ss`, ` ${rootPid + 1} ${rootPid} ${rootPid} 90000 S`];
  for (let i = 0; i < workers; i += 1) {
    lines.push(` ${rootPid + 10 + i} ${rootPid + 1} ${rootPid} ${workerRssKb} S`);
  }
  return lines.join('\n') + '\n';
}

/** What the fabricated forest says this tree weighs. */
let forestFor: (rootPid: number) => string;

beforeEach(() => {
  calls = { ps: 0, pressure: 0, vm: 0 };
  freePctNow = 90;
  forestFor = (pid) => fakeForest(pid, 100_000);
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-home-')));
  canonical = join(home, '.claude');
  mkdirSync(canonical, { recursive: true });
  stateFile = join(home, 'state.json');
  runsFile = join(home, 'runs.jsonl');
  streamDir = join(home, 'runs');
  goFile = join(home, 'go.txt');

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-watch-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-demo`);
  git(['worktree', 'add', '-b', `fix/issue-${ISSUE}-demo`, worktree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: ISSUE, title: 'Filter pills', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
  ]);
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(resources, 'probeResources').mockResolvedValue({
    ok: true,
    reason: 'memory ok',
    freePct: 90,
    headroomBytes: 8 * GB,
    headroomLabel: '8.0 GB',
    minFreePct: 25,
    footprintBytes: 0,
    footprintLabel: '0.0 GB',
    ceilingBytes: 11 * GB,
    ceilingLabel: '11.0 GB',
    totalBytes: 16 * GB,
    edgeRuntimeLabel: null,
    // Deliberately in the PAST: the whole question is whether a fresher watch
    // sample overrides a poll that is minutes old.
    checkedAt: new Date(Date.now() - 120_000).toISOString(),
  } as ResourceReport);
});

afterEach(() => {
  killSpawnedWorkers(stateFile);
  delete process.env.STUB_WAIT_FOR;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A console whose watcher reads a fabricated machine — counted, so the tick's
 *  cost is an assertion rather than a claim. */
function orch(env: Record<string, string> = {}) {
  return new Orchestrator(
    loadConfig({
      REPO: 'example-org/example-repo',
      REPO_PATH: repo,
      STATE_FILE: stateFile,
      RUNS_FILE: runsFile,
      STREAM_DIR: streamDir,
      STREAM_POLL_MS: '25',
      CANONICAL_CLAUDE_DIR: canonical,
      CLAUDE_BIN: STUB,
      POLL_MS: '999999',
      WATCH_INTERVAL_MS: '999999',
      WATCH_IDLE_INTERVAL_MS: '999999',
      ...env,
    }),
    {
      watchProbes: {
        psForest: async () => {
          calls.ps += 1;
          // Built from the console's own record of what is running, so the
          // fabricated table always names the pids it actually spawned.
          return Object.values(persisted().runningRuns)
            .map((r) => forestFor(r.pid))
            .join('');
        },
        memoryPressure: async () => {
          calls.pressure += 1;
          return freePctNow === null ? '' : `System-wide memory free percentage: ${freePctNow}%\n`;
        },
        vmStat: async () => {
          calls.vm += 1;
          return [
            'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
            'Pages free:                              100000.',
            'Pages inactive:                          200000.',
            'Pages speculative:                         1000.',
            'Pages purgeable:                           1000.',
          ].join('\n');
        },
      },
    },
  );
}

const row = (o: Orchestrator) => o.state().issues.find((r) => r.number === ISSUE)!;
const persisted = () => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')) as { runningRuns: Record<string, RunningRun> };
  } catch {
    return { runningRuns: {} };
  }
};

async function startAWorker(o: Orchestrator): Promise<RunningRun> {
  process.env.STUB_WAIT_FOR = goFile;
  await o.start();
  o.enqueue(ISSUE);
  await waitFor('the worker to be running', () => row(o).status === 'active');
  await waitFor('its row to be written down', () => persisted().runningRuns[String(ISSUE)] !== undefined);
  return persisted().runningRuns[String(ISSUE)]!;
}

describe('what a tick costs', () => {
  it('is exactly one ps, one memory_pressure and one vm_stat — no docker, nothing on the network', async () => {
    const o = orch();
    await o.start(); // start() takes one tick of its own
    const after = { ...calls };
    await o.watchTick();
    expect(calls.ps - after.ps).toBe(1);
    expect(calls.pressure - after.pressure).toBe(1);
    expect(calls.vm - after.vm).toBe(1);
    await o.stop();
  });

  it('makes the fan-out visible — 11 processes under one worker, and what they weigh', async () => {
    const o = orch();
    const entry = await startAWorker(o);
    forestFor = (pid) => fakeForest(pid, 300_000); // nine jest workers at ~300 MB
    await o.watchTick();

    const w = o.state().watch!.workers.find((x) => x.issue === entry.issue)!;
    expect(w.procCount).toBe(11);
    expect(w.treeBytes).toBe((400_000 + 90_000 + 9 * 300_000) * 1024);
    await o.stop();
  });
});

describe('the fences a test cannot talk past', () => {
  it('gives an unwired console inert probes, so no test reads the real machine', async () => {
    const bare = new Orchestrator(
      loadConfig({
        REPO: 'example-org/example-repo',
        REPO_PATH: repo,
        STATE_FILE: stateFile,
        RUNS_FILE: runsFile,
        STREAM_DIR: streamDir,
        CANONICAL_CLAUDE_DIR: canonical,
        CLAUDE_BIN: STUB,
        POLL_MS: '999999',
        WATCH_INTERVAL_MS: '999999',
      }),
    );
    await bare.start();
    const w = bare.state().watch!;
    expect(w.sample.freePct).toBeNull();
    expect(w.sample.headroomBytes).toBeNull();
    expect(w.sample.workers).toEqual([]);
    // And an unmeasurable machine never acts.
    expect(w.level).toBe('ok');
    await bare.stop();
  });

  it('refuses to signal a process group from a console that has not wired one', async () => {
    const o = orch();
    await startAWorker(o);
    const out = await o.pauseWorker(ISSUE, 'you', 'testing the fence');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('no process group may be signalled from a test that has not wired one');
    // And it did NOT stamp a pause that never happened.
    expect(row(o).status).toBe('active');
    expect(row(o).paused).toBeNull();
    await o.stop();
  });
});

describe('dispatch reacts within one tick, not one poll', () => {
  it('holds a queued issue on a fresh low-memory sample with no poll in between', async () => {
    const o = orch();
    await o.start(); // the poll says 90% free, and its stamp is two minutes old
    expect(o.state().resources!.ok).toBe(true);

    freePctNow = 8;
    await o.watchTick();

    // The header reads the same fresh sample, so the number on screen and the
    // number dispatch acted on cannot disagree — which is exactly what the
    // two-minute-old poll allowed on the night of the crash.
    expect(o.state().watch!.sample.freePct).toBe(8);
    expect(o.state().resources!.freePct).toBe(90); // the stale poll, still there

    o.enqueue(ISSUE);
    await wait(100);
    expect(o.state().dispatchReason).toContain('8% free');
    expect(o.state().dispatchReason).toContain('need 12%');
    expect(row(o).status).toBe('queued'); // nothing was started
    await o.stop();
  });

  it('goes back to dispatching on the next tick once the machine recovers', async () => {
    const o = orch();
    await o.start();
    freePctNow = 8;
    await o.watchTick();
    o.enqueue(ISSUE);
    await wait(100);
    expect(row(o).status).toBe('queued');

    process.env.STUB_WAIT_FOR = goFile;
    freePctNow = 90;
    await o.watchTick();
    await o.poll();
    await waitFor('the worker to start', () => row(o).status === 'active');
    await o.stop();
  });

  /**
   * The dangerous direction. `decideResources` reads a null free % as "allow —
   * tool missing", which is right for a machine nobody can measure and
   * catastrophic as a way of overturning a hold the poll had already decided on.
   */
  it('does not let an UNREADABLE watch sample overturn a hold the poll decided', async () => {
    vi.mocked(resources.probeResources).mockResolvedValue({
      ok: false,
      reason: 'waiting on memory — 8% free, need 12%',
      freePct: 8,
      headroomBytes: 0,
      headroomLabel: '0.0 GB',
      minFreePct: 25,
      footprintBytes: 0,
      footprintLabel: '0.0 GB',
      ceilingBytes: 11 * GB,
      ceilingLabel: '11.0 GB',
      totalBytes: 16 * GB,
      edgeRuntimeLabel: null,
      checkedAt: new Date(Date.now() - 1000).toISOString(),
    } as ResourceReport);
    const o = orch();
    await o.start();

    freePctNow = null; // memory_pressure has gone missing
    await o.watchTick();
    expect(o.state().watch!.sample.freePct).toBeNull();

    o.enqueue(ISSUE);
    await wait(100);
    expect(o.state().dispatchReason).toContain('8% free');
    expect(row(o).status).toBe('queued');
    await o.stop();
  });

  it('ignores a watch sample that is OLDER than the poll rather than un-doing it', async () => {
    // A poll stamped NOW that says the machine is in trouble must not be
    // overridden by a watch sample taken before it.
    vi.mocked(resources.probeResources).mockResolvedValue({
      ok: false,
      reason: 'waiting on memory — 8% free, need 12%',
      freePct: 8,
      headroomBytes: 0,
      headroomLabel: '0.0 GB',
      minFreePct: 25,
      footprintBytes: 0,
      footprintLabel: '0.0 GB',
      ceilingBytes: 11 * GB,
      ceilingLabel: '11.0 GB',
      totalBytes: 16 * GB,
      edgeRuntimeLabel: null,
      checkedAt: new Date(Date.now() + 60_000).toISOString(),
    } as ResourceReport);
    const o = orch();
    await o.start();
    o.enqueue(ISSUE);
    await wait(100);
    expect(o.state().dispatchReason).toContain('8% free');
    await o.stop();
  });
});

describe('the peak — a spike that has already passed is still visible', () => {
  it('remembers the biggest the tree got, and does not walk back down with it', async () => {
    const o = orch();
    const entry = await startAWorker(o);

    forestFor = (pid) => fakeForest(pid, 300_000); // the Validate spike
    await o.watchTick();
    const peak = o.state().watch!.workers[0]!.treeBytes;
    expect(peak).toBeGreaterThan(3 * GB);

    forestFor = (pid) => fakeForest(pid, 1_000); // it passes; the tree shrinks
    await o.watchTick();
    const now = o.state().watch!.workers[0]!;
    expect(now.treeBytes).toBeLessThan(GB);
    expect(now.peakTreeBytes).toBe(peak);

    // And a peak worth knowing about reached disk, so a console restart keeps it.
    expect(persisted().runningRuns[String(entry.issue)]!.peakTreeBytes).toBe(peak);
    await o.stop();
  });

  it('starts a NEW segment with no peak — a peak belongs to one run, not to an issue', async () => {
    const o = orch();
    await startAWorker(o);
    forestFor = (pid) => fakeForest(pid, 300_000);
    await o.watchTick();
    expect(o.state().watch!.workers[0]!.peakTreeBytes).toBeGreaterThan(3 * GB);

    writeFileSync(goFile, 'go');
    await waitFor('the first segment to end', () => persisted().runningRuns[String(ISSUE)] === undefined);
    rmSync(goFile);

    process.env.STUB_WAIT_FOR = goFile;
    forestFor = (pid) => fakeForest(pid, 1_000);
    await o.resume(ISSUE, 'Gate C approved, proceed.');
    await waitFor('the second segment to be running', () => persisted().runningRuns[String(ISSUE)] !== undefined);
    await o.watchTick();
    expect(o.state().watch!.workers[0]!.peakTreeBytes).toBeLessThan(GB);
    await o.stop();
  });
});

describe('the prompt a resume carries', () => {
  /**
   * The other half of the fan-out rule. A fresh spawn is told to cap jest; a
   * RESUME is the operator's words and nothing else, because gate history records them
   * verbatim and a console that quietly appended to them would be editing what
   * they said.
   */
  it('is byte-exactly what the operator typed — the fan-out suffix never touches a resume', async () => {
    const o = orch();
    await o.start();
    o.enqueue(ISSUE);
    await waitFor('the gate', () => existsSync(join(worktree, '.gate.json')));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');

    // The SPAWN carries it...
    const gate = JSON.parse(readFileSync(join(worktree, '.gate.json'), 'utf8')) as { prompt: string };
    expect(gate.prompt).toBe(`/issue-pipeline ${ISSUE}\n\n${FANOUT_RULE}\n\n${SKILLS_RULE}`);

    // ...and the resume does not.
    const words = 'Gate C approved, proceed.\n\n1. option A 2. option A 3 dev only';
    await o.resume(ISSUE, words);
    await waitFor('the resume to land', () => existsSync(join(worktree, 'resumed.txt')));
    const said = readFileSync(join(worktree, 'resumed.txt'), 'utf8');
    expect(said).toContain(`resumed with: ${words}\n`);
    expect(said).not.toContain(FANOUT_RULE);
    // The style rule is a standing rule too, and standing rules never touch a resume.
    expect(said).not.toContain(SKILLS_RULE);
    await o.stop();
  });
});

/**
 * WHAT THE PAGE IS ALLOWED TO SAY WHILE THE QUEUE IS FROZEN.
 *
 * The `hold` rung of the ladder stops dispatch and raises no banner: `hold` is
 * below the level `WatchBanner` draws at, and the shell's other banner reads
 * `resources.ok`, which is the two-minute machine read — the very number the
 * fresher watch sample is there to override. So for up to two minutes the
 * queued row said "#N is queued and runs as soon as a slot frees" while nothing
 * could start, and the header's own last clause said "nothing running".
 *
 * `dispatchReason` had the sentence in it all along, written for a human, and
 * nothing rendered it. `dispatchHold` is that sentence read at snapshot time
 * off the same verdict `#dispatch` consults, so it cannot be stale, and it is
 * null unless there is actually work being held.
 */
describe('a queue frozen for memory says so', () => {
  it('names the hold while the two-minute read still says the machine is fine', async () => {
    const o = orch();
    await o.start();
    freePctNow = 11; // under MIN_FREE_PCT (12), above every loud rung (warn 10): `hold`
    await o.watchTick();
    o.enqueue(ISSUE);
    await wait(100);

    const s = o.state();
    expect(s.resources!.ok).toBe(true); // the stale read: nothing to see here
    expect(s.watch!.level).toBe('hold'); // and the banner draws nothing at this rung
    expect(s.queue).toContain(ISSUE); // ...while the work sits there
    expect(s.dispatchHold).toContain('waiting on memory');
    expect(s.dispatchHold).toContain('need 12%');
    await o.stop();
  });

  it('says nothing when nothing is being held', async () => {
    const o = orch();
    await o.start();
    await o.watchTick();
    expect(o.state().dispatchHold).toBeNull();
    // Memory can be bad without anything waiting on it. Then there is no queue
    // to lie about, and the ladder and the Resources tab already say the rest.
    freePctNow = 20;
    await o.watchTick();
    expect(o.state().dispatchHold).toBeNull();
    await o.stop();
  });
});
