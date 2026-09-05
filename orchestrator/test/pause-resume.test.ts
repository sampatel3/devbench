import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { readRuns } from '../src/metrics.js';
import { pidAlive } from '../src/reattach.js';
import { parsePsForest, signalProcessGroup, treeOf } from '../src/watch.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ResourceReport, RunningRun } from '../src/types.js';

/**
 * Pause and resume, against REAL processes this test spawns.
 *
 * The operator's binding constraint on the whole feature: good resource management
 * without throwing away work. Pausing is the lever that satisfies it, and every
 * claim made for it is a claim about the operating system, so none of it is
 * mocked here: a real detached worker, a real grandchild, a real `ps`, a real
 * SIGSTOP, and assertions about the state column.
 *
 * This file doubles as the verification of the mechanism the plan flagged as an
 * assumption — that `detached: true` makes the worker its own process-group
 * leader on macOS, and that signalling the negative pid freezes its
 * grandchildren too.
 *
 * The fence, unchanged: `signalGroup` THROWS under vitest unless a test wires
 * one, so no test that has not asked for it can stop anything, and the only pids
 * signalled are ones this test created.
 */

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const ISSUE = 4478;
/** A second piece of work with its own worktree, so "dispatch is held" can be
 *  observed as something actually waiting rather than inferred. */
const OTHER = 4479;

let repo: string;
let worktree: string;
let home: string;
let canonical: string;
let stateFile: string;
let runsFile: string;
let streamDir: string;
let goFile: string;
/** Every (pgid, signal) this test's console sent, in order. */
let signals: Array<{ pgid: number; signal: string }>;
/** Anything else the console tried to do TO the machine. Wired to recorders that
 *  do nothing, so "the automation only ever pauses" is an assertion about an
 *  empty list rather than a hope. */
let kills: number[];
let restarts: string[];
/** What the wired `memory_pressure` probe answers, so a test can change the
 *  machine's mood between ticks. Null = unreadable, which must never act. */
let freePctNow: number | null = null;

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

/** The real process table, exactly as the watcher reads it. */
const psNow = () => parsePsForest(execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,stat='], { encoding: 'utf8' }));

beforeEach(() => {
  signals = [];
  kills = [];
  restarts = [];
  freePctNow = null;
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-home-')));
  canonical = join(home, '.claude');
  mkdirSync(canonical, { recursive: true });
  stateFile = join(home, 'state.json');
  runsFile = join(home, 'runs.jsonl');
  streamDir = join(home, 'runs');
  goFile = join(home, 'go.txt');

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-pause-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-demo`);
  git(['worktree', 'add', '-b', `fix/issue-${ISSUE}-demo`, worktree, 'dev'], repo);
  git(['worktree', 'add', '-b', `fix/issue-${OTHER}-demo`, join(repo, '.worktrees', `issue-${OTHER}-demo`), 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: ISSUE, title: 'Filter pills', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
    { number: OTHER, title: 'Something else', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
  ]);
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(resources, 'probeResources').mockResolvedValue({
    ok: true,
    reason: 'memory ok',
    freePct: 90,
    headroomBytes: 8 * 1024 ** 3,
    headroomLabel: '8 GB',
    minFreePct: 25,
    footprintBytes: 0,
    footprintLabel: '0 GB',
    ceilingBytes: 11 * 1024 ** 3,
    ceilingLabel: '11 GB',
    totalBytes: 16 * 1024 ** 3,
    edgeRuntimeLabel: null,
    checkedAt: new Date().toISOString(),
  } as ResourceReport);
});

afterEach(() => {
  // FIRST, and unconditionally. These tests deliberately leave a real detached
  // worker AND its grandchild running, and a failed assertion never reaches the
  // line that would let them finish. It kills the whole group, so the grandchild
  // goes with the root.
  killSpawnedWorkers(stateFile);
  delete process.env.STUB_WAIT_FOR;
  delete process.env.STUB_CHILD;
  delete process.env.STUB_CHILD_STAYS;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * A console that can actually signal — and only ever the groups its own workers
 * lead. The recording wrapper is what lets a test assert the ORDER of signals,
 * which is how "CONT before TERM" is provable rather than hoped for.
 */
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
      ...env,
    }),
    {
      signalGroup: (pgid, signal) => {
        signals.push({ pgid, signal });
        signalProcessGroup(pgid, signal);
      },
      // Recorded and NOT performed. Nothing in the watcher may reach either of
      // these; wiring them makes that a checkable fact instead of a promise.
      kill: (pid) => {
        kills.push(pid);
      },
      restartContainer: async (name) => {
        restarts.push(name);
        return 'a test must never restart a container';
      },
      // The real `ps`, so the tree it measures is the tree it will signal. The
      // pressure reading is dictated by the test; vm_stat stays unreadable,
      // which the forecast is required to treat as "no forecast", not as a hold.
      watchProbes: {
        psForest: async () => execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,stat='], { encoding: 'utf8' }),
        memoryPressure: async () =>
          freePctNow === null ? '' : `System-wide memory free percentage: ${freePctNow}%\n`,
        vmStat: async () => '',
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
const runningRow = () => persisted().runningRuns[String(ISSUE)] ?? null;

/** A worker with a real grandchild, parked until the test lets it go. */
async function startATree(o: Orchestrator): Promise<RunningRun> {
  process.env.STUB_WAIT_FOR = goFile;
  process.env.STUB_CHILD = '1';
  await o.start();
  o.enqueue(ISSUE);
  await waitFor('the worker to be running', () => row(o).status === 'active');
  await waitFor('its row to be written down', () => runningRow() !== null);
  const entry = runningRow()!;
  await waitFor('its grandchild to exist', () => treeOf(entry.pid, psNow()).length >= 2);
  return entry;
}

describe('the mechanism — what detached: true actually gives us', () => {
  it('makes the worker its own process-group leader, so one signal reaches the whole tree', async () => {
    const o = orch();
    const entry = await startATree(o);

    const tree = treeOf(entry.pid, psNow());
    expect(tree.length).toBeGreaterThanOrEqual(2);
    // pgid === pid for the root, and every descendant inherits it. This is the
    // assumption the whole pause design rests on, asserted rather than assumed.
    for (const p of tree) expect(p.pgid).toBe(entry.pid);

    await o.stop();
  });
});

describe('pause and resume — a real tree, frozen and thawed', () => {
  it('stops every process in the tree, and starts them all again', async () => {
    const o = orch();
    const entry = await startATree(o);
    const pids = treeOf(entry.pid, psNow()).map((p) => p.pid);

    const out = await o.pauseWorker(ISSUE, 'you', 'testing the lever');
    expect(out.ok).toBe(true);
    await wait(200);

    // The state column is the proof: T is stopped. Nothing was killed.
    const stopped = psNow().filter((p) => pids.includes(p.pid));
    expect(stopped).toHaveLength(pids.length);
    for (const p of stopped) expect(p.stat.startsWith('T')).toBe(true);
    expect(signals).toEqual([{ pgid: entry.pid, signal: 'SIGSTOP' }]);

    // The next tick sees it and can say "11 of 11 stopped" rather than assume.
    await o.watchTick();
    const w = o.state().watch!.workers.find((x) => x.issue === ISSUE)!;
    expect(w.stoppedProcs).toBe(w.procCount);
    expect(w.procCount).toBe(pids.length);

    expect((await o.unpauseWorker(ISSUE)).ok).toBe(true);
    await wait(200);
    for (const p of psNow().filter((x) => pids.includes(x.pid))) expect(p.stat.startsWith('T')).toBe(false);
    expect(signals.map((s) => s.signal)).toEqual(['SIGSTOP', 'SIGCONT']);

    await o.stop();
  });

  it('shows the row as PAUSED, never as active or stuck, and says who did it and why', async () => {
    const o = orch();
    await startATree(o);
    await o.pauseWorker(ISSUE, 'floor', '4% free — the memory floor');

    const r = row(o);
    expect(r.status).toBe('paused');
    expect(r.paused).toMatchObject({ by: 'floor', reason: '4% free — the memory floor' });
    expect(r.statusDetail).toContain('paused by the memory floor');
    expect(r.statusDetail).toContain('Nothing is lost');

    await o.unpauseWorker(ISSUE);
    expect(row(o).status).toBe('active');
    expect(row(o).paused).toBeNull();
    await o.stop();
  });

  /**
   * PARKING ONE ISSUE TO WORK ANOTHER — the thing the pause button is for, and
   * the thing it did not do.
   *
   * It used to keep its slot, so "a worker is paused — resume it before
   * starting more" met every attempt to start the second issue. A paused worker
   * holds RAM, not a slot, and the two are answered by two different brakes:
   * the count below, and the memory guard (still exactly as strict — see the
   * next test).
   */
  it('GIVES ITS SLOT BACK, so a parked issue does not block the next one', async () => {
    const o = orch({ MAX_ACTIVE: '1' });
    await startATree(o);
    expect(o.state().activeCount).toBe(1);

    await o.pauseWorker(ISSUE, 'you', 'I want to work #4479 instead');

    // The slot is free at MAX_ACTIVE=1 — the tightest case there is.
    expect(o.state().activeCount).toBe(0);

    // And the other issue ACTUALLY STARTS — the whole point, asserted as a
    // running worker rather than as a hopeful-looking reason string. Its stub
    // parks on the same go-file, so it is still there for `afterEach` to kill.
    o.enqueue(OTHER);
    await o.poll();
    await waitFor('#4479 to be running', () => o.state().issues.find((r) => r.number === OTHER)!.live !== null);
    expect(o.state().dispatchReason).not.toContain('paused');
    expect(o.state().dispatchReason).not.toContain('resume');
    expect(o.state().dispatchHold).toBeNull();

    await o.stop();
  });

  /**
   * The other half, and it must NOT move: a frozen worker's pages are still
   * resident. Slot and memory are different questions.
   */
  it('still counts for MEMORY — a tight machine holds the next worker exactly as before', async () => {
    const o = orch({ MAX_ACTIVE: '2' });
    await startATree(o);
    await o.pauseWorker(ISSUE, 'floor', '4% free — the memory floor');

    freePctNow = 8; // the machine has not recovered just because a worker froze
    await o.watchTick();
    o.enqueue(OTHER);
    await o.poll();
    expect(o.state().dispatchReason).toContain('waiting on memory');
    expect(o.state().dispatchReason).toContain('8% free');
    expect(o.state().queue).toContain(OTHER);

    o.dequeue(OTHER);
    await o.stop();
  });

  it('refuses to pause what is not running, and to pause the same worker twice', async () => {
    const o = orch();
    await startATree(o);
    expect((await o.pauseWorker(9999, 'you', 'x')).message).toContain('not running');
    expect((await o.pauseWorker(ISSUE, 'you', 'x')).ok).toBe(true);
    expect((await o.pauseWorker(ISSUE, 'you', 'x')).message).toContain('already paused');
    expect((await o.unpauseWorker(ISSUE)).ok).toBe(true);
    expect((await o.unpauseWorker(ISSUE)).message).toContain('not paused');
    await o.stop();
  });
});

describe('a paused worker and the rest of the console', () => {
  /**
   * SIGTERM is not DELIVERED to a stopped process until it continues. Without
   * the CONT first, "Stop this worker" would look like it had done nothing, for
   * ever.
   */
  it('is thawed before it is stopped — CONT, then TERM, in that order', async () => {
    const o = orch();
    // This descendant deliberately survives its parent becoming orphaned. The
    // assertion therefore fails if stop signals only the CLI pid instead of the
    // detached worker's entire process group.
    process.env.STUB_CHILD_STAYS = '1';
    const entry = await startATree(o);
    const originalTree = treeOf(entry.pid, psNow());
    expect(originalTree.length).toBeGreaterThanOrEqual(2);
    await o.pauseWorker(ISSUE, 'you', 'testing');
    signals.length = 0;

    expect((await o.stopWorker(ISSUE)).ok).toBe(true);
    expect(signals).toEqual([{ pgid: entry.pid, signal: 'SIGCONT' }]);
    await waitFor(
      'the entire worker process group to die',
      () => psNow().every((process) => process.pgid !== entry.pid),
    );
    for (const process of originalTree) expect(pidAlive(process.pid)).toBe(false);
    await o.stop();
  });

  it('comes back PAUSED after a console restart, not active with a silent stream', async () => {
    const first = orch();
    const entry = await startATree(first);
    await first.pauseWorker(ISSUE, 'floor', '4% free — the memory floor');
    await first.stop();

    // Shutting down neither resumes nor kills it: it is still frozen.
    expect(pidAlive(entry.pid)).toBe(true);
    expect(psNow().find((p) => p.pid === entry.pid)!.stat.startsWith('T')).toBe(true);

    const second = orch();
    const picked = await second.start();
    expect(picked.reattached).toEqual([ISSUE]);
    expect(row(second).status).toBe('paused');
    expect(row(second).paused).toMatchObject({ by: 'floor' });
    // And its slot is still given back after the restart — the pause survives,
    // and so does what the pause means.
    expect(second.state().activeCount).toBe(0);

    await second.unpauseWorker(ISSUE);
    await wait(150);
    expect(row(second).status).toBe('active');
    await second.stop();
  });

  it('records how long it was paused, so a frozen hour is not read as model slowness', async () => {
    const o = orch();
    await startATree(o);
    await o.pauseWorker(ISSUE, 'you', 'testing');
    await wait(400);
    await o.unpauseWorker(ISSUE);

    writeFileSync(goFile, 'go'); // let it finish
    await waitFor('the run to be recorded', () => existsSync(runsFile));
    const [record] = await readRuns(runsFile);
    expect(record!.pausedMs).toBeGreaterThanOrEqual(300);
    expect(record!.durationMs).toBeGreaterThanOrEqual(record!.pausedMs!);
    await o.stop();
  });

  /**
   * "Detached" means YOU took the worker over in a terminal, and it is decided
   * from `weAreRunning`. A paused worker is still running as far as the runner is
   * concerned, so nothing here changes — but a paused row reading "you took this
   * one over in a terminal" would be a lie about a machine action, so it is
   * pinned.
   */
  it('is never mistaken for one you took over in a terminal', async () => {
    const o = orch();
    await startATree(o);
    await o.pauseWorker(ISSUE, 'floor', 'the memory floor');
    await o.poll(); // the scan that would notice a transcript moving under us

    expect(row(o).status).toBe('paused');
    expect(row(o).status).not.toBe('detached');
    await o.unpauseWorker(ISSUE);
    await o.stop();
  });

  it('records null pausedMs for a run that was never paused', async () => {
    const o = orch();
    await o.start();
    o.enqueue(ISSUE);
    await waitFor('the run to be recorded', () => existsSync(runsFile));
    expect((await readRuns(runsFile))[0]!.pausedMs).toBeNull();
    await o.stop();
  });
});

describe('the automation fence', () => {
  /**
   * The rule the whole design turns on: automation may only ever PAUSE. It never
   * kills, never restarts and — critically — never un-pauses, because a system
   * that could resume on its own could flap on a machine oscillating around a
   * threshold, and the operator would never be able to trust what they were looking at.
   */
  it('sends only SIGSTOP when the floor fires, and never resumes anything by itself', async () => {
    const o = orch({ FLOOR_FREE_PCT: '5', WATCH_INTERVAL_MS: '999999', WATCH_IDLE_INTERVAL_MS: '999999' });
    await startATree(o);
    signals.length = 0;

    // A tick with the machine at 3% free. One sample is all the floor needs.
    await withFreePct(o, 3);
    await waitFor('the floor to have paused it', () => row(o).status === 'paused');
    expect(row(o).paused!.by).toBe('floor');
    expect(signals.every((s) => s.signal === 'SIGSTOP')).toBe(true);
    // Nothing else was touched: no SIGTERM to a worker, no container restart.
    expect(kills).toEqual([]);
    expect(restarts).toEqual([]);

    // Now hand it a comfortable machine. It must NOT resume: that is a click.
    signals.length = 0;
    await withFreePct(o, 60);
    await withFreePct(o, 60);
    expect(signals).toEqual([]);
    expect(kills).toEqual([]);
    expect(restarts).toEqual([]);
    expect(row(o).status).toBe('paused');

    await o.unpauseWorker(ISSUE);
    await o.stop();
  });

  it('does not fire the floor twice, and re-arms only after a resume plus a recovery', async () => {
    const o = orch({ WATCH_INTERVAL_MS: '999999', WATCH_IDLE_INTERVAL_MS: '999999' });
    await startATree(o);
    await withFreePct(o, 3);
    await waitFor('the first pause', () => row(o).status === 'paused');

    signals.length = 0;
    await withFreePct(o, 60); // memory back — but only because it is frozen
    await withFreePct(o, 3); // and under again
    expect(signals).toEqual([]); // still spent

    await o.unpauseWorker(ISSUE);
    signals.length = 0;
    await withFreePct(o, 60); // resumed AND recovered: re-armed
    await withFreePct(o, 3);
    expect(signals.some((s) => s.signal === 'SIGSTOP')).toBe(true);
    await o.unpauseWorker(ISSUE);
    await o.stop();
  });

  it('leaves everything alone when AUTO_PAUSE_FLOOR is off, and still says the floor was reached', async () => {
    const o = orch({ AUTO_PAUSE_FLOOR: '0', WATCH_INTERVAL_MS: '999999', WATCH_IDLE_INTERVAL_MS: '999999' });
    await startATree(o);
    signals.length = 0;
    await withFreePct(o, 3);

    expect(signals).toEqual([]);
    expect(row(o).status).toBe('active');
    const w = o.state().watch!;
    expect(w.level).toBe('floor');
    expect(w.autoPauseFloor).toBe(false);
    await o.stop();
  });
});

/** Drive one watcher tick against a machine reporting `pct`% free. The `ps` is
 *  still REAL — only the pressure reading is dictated, so the trees the ladder
 *  acts on are the trees that actually exist. */
async function withFreePct(o: Orchestrator, pct: number): Promise<void> {
  freePctNow = pct;
  await o.watchTick();
}
