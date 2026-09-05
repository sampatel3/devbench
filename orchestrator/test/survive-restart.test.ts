import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { readRuns } from '../src/metrics.js';
import { pidAlive } from '../src/reattach.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ResourceReport, RunningRun } from '../src/types.js';

/**
 * The bug this file exists for: every console restart killed every worker.
 * Shutdown ran `stopAll()`, which SIGTERM'd children whose stdout was a pipe
 * into the console — so a day of restarting to deploy fixes was a day of losing
 * in-flight work, which came back looking like "stopped after stage 0".
 *
 * The Claude SESSION always survived; only the PROCESS died. Nothing here
 * simulates that: a real detached child is spawned, a real orchestrator is
 * stopped, a real second orchestrator is started against the same state file,
 * and the assertions are about the actual pid and the actual files.
 */

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const ISSUE = 4336;

let repo: string;
let worktree: string;
let home: string;
let canonical: string;
let stateFile: string;
let runsFile: string;
let streamDir: string;
let goFile: string;

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

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-home-')));
  canonical = join(home, '.claude');
  mkdirSync(canonical, { recursive: true });
  stateFile = join(home, 'state.json');
  runsFile = join(home, 'runs.jsonl');
  streamDir = join(home, 'runs');
  goFile = join(home, 'go.txt');

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-restart-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-demo`);
  git(['worktree', 'add', '-b', `fix/issue-${ISSUE}-demo`, worktree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: ISSUE, title: 'Org sysadmin filter pills', url: 'u', labels: ['bug'], updatedAt: 'z', author: 'operator' },
  ]);
  // Merged PRs are read on every poll now (a merged PR used to vanish from the
  // console and the row lied). Stubbed empty so no test reaches the network.
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(gh, 'listAuthoredOpenPrs').mockResolvedValue([]);
  vi.spyOn(resources, 'probeResources').mockResolvedValue({
    ok: true,
    reason: 'memory ok',
    freePct: 90,
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
  } as ResourceReport);
});

afterEach(() => {
  // FIRST, and unconditionally. Half the tests here deliberately leave a real
  // detached worker running, and a failed assertion never reaches the line that
  // lets it finish — so without this it polls for a go-file in a directory that
  // is about to be deleted, for ever.
  killSpawnedWorkers(stateFile);
  delete process.env.STUB_WAIT_FOR;
  delete process.env.STUB_NO_GATE;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A console. Two of these in one test are two console runs against one machine. */
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
  );
}

const row = (o: Orchestrator) => o.state().issues.find((r) => r.number === ISSUE)!;
/**
 * `state.json` as it is on disk, or nothing if it has not been written yet.
 *
 * Not-there-yet is a real answer, not a failure: the console registers a run in
 * memory and THEN awaits the save, so the row is `active` before the file
 * exists. This used to throw ENOENT straight out of a `waitFor` predicate under
 * load. The file is written temp-then-rename, so a reader gets all of it or none
 * of it — there is no half-file case to worry about.
 */
const persisted = () => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')) as { runningRuns: Record<string, RunningRun> };
  } catch {
    return { runningRuns: {} };
  }
};
const runningRow = () => persisted().runningRuns[String(ISSUE)] ?? null;
const gateFile = () => join(worktree, '.gate.json');

/** Start a worker that will sit there until the test lets it go. */
async function startAWorkerThatKeepsRunning(o: Orchestrator): Promise<RunningRun> {
  process.env.STUB_WAIT_FOR = goFile;
  await o.start();
  o.enqueue(ISSUE);
  await waitFor('the worker to be running', () => row(o).status === 'active');
  await waitFor('its row to be written down', () => runningRow() !== null);
  return runningRow()!;
}

/** Let the waiting worker finish. */
const letItFinish = () => writeFileSync(goFile, 'go');

describe('a console restart does not touch the workers', () => {
  /**
   * THE regression test. One worker, running; the console goes away and comes
   * back; the same process is still there, the row is active again, and the gate
   * it writes afterwards is picked up exactly as if nothing had happened.
   */
  it('leaves a worker running, re-attaches to it, and still catches its gate', async () => {
    const first = orch();
    const entry = await startAWorkerThatKeepsRunning(first);

    await first.stop();
    // The worker is a detached process, not a child that dies with its parent.
    expect(pidAlive(entry.pid)).toBe(true);
    expect(runningRow()!.pid).toBe(entry.pid);

    const second = orch();
    const picked = await second.start();
    expect(picked.reattached).toEqual([ISSUE]);
    expect(row(second).status).toBe('active');
    // And it says so: this is not a fresh start and must not read as one.
    expect(row(second).live!.reattached).toBe(true);
    expect(row(second).statusDetail).toContain('re-attached');

    letItFinish();
    await waitFor('the gate to be reached', () => existsSync(gateFile()));
    await waitFor('the row to settle at the gate', () => row(second).status === 'at-gate');
    expect(row(second).gate!.gate).toBe('C');
    expect(runningRow()).toBeNull(); // the run is over, so its row is gone

    // One run happened, so there is exactly one measurement of it.
    const runs = await readRuns(runsFile);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.segment).toBe('C');
    expect(runs[0]!.sessionId).toBe(entry.sessionId);
    await second.stop();
  });

  it('does not kill anything on stop, and says how many it left alone', async () => {
    const o = orch();
    const entry = await startAWorkerThatKeepsRunning(o);

    const out = await o.stop();
    expect(out.leftRunning).toBe(1);
    await wait(200); // long enough for a SIGTERM to have landed, if one had been sent
    expect(pidAlive(entry.pid)).toBe(true);

    // And nothing was concluded about a run that has not ended.
    expect(existsSync(runsFile)).toBe(false);
    expect(runningRow()).not.toBeNull();

    letItFinish();
    await waitFor('the worker to finish on its own', () => !pidAlive(entry.pid), 10_000);
  });

  it('kills a worker when the operator asks it to, and only then', async () => {
    const o = orch();
    const entry = await startAWorkerThatKeepsRunning(o);

    // Stopping is async now: it also stops that worktree's dev server (this
    // worktree has no registered port, so there is nothing there to stop).
    expect((await o.stopWorker(ISSUE)).ok).toBe(true);
    await waitFor('the process to be gone', () => !pidAlive(entry.pid));
    await waitFor('the row to be released', () => runningRow() === null);
    expect(row(o).status).not.toBe('active');
    await o.stop();
  });
});

describe('a run that ended while the console was down', () => {
  /**
   * The other half of surviving a restart: the console must be able to come back
   * to a finished run and produce the same state, and the same runs.jsonl line,
   * as if it had watched it end.
   */
  it('is reconciled on the next start, with exactly one run record', async () => {
    const first = orch();
    const entry = await startAWorkerThatKeepsRunning(first);
    await first.stop();

    letItFinish();
    await waitFor('the worker to finish while nobody is watching', () => !pidAlive(entry.pid));
    expect(existsSync(runsFile)).toBe(false); // nobody recorded it — nobody was there

    const second = orch();
    const picked = await second.start();
    expect(picked.reconciled).toEqual([ISSUE]);
    expect(picked.reattached).toEqual([]);

    // The gate it reached is picked up exactly as the live path would have done.
    expect(row(second).status).toBe('at-gate');
    expect(row(second).gate!.gate).toBe('C');
    expect(runningRow()).toBeNull();

    const runs = await readRuns(runsFile);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.segment).toBe('C');
    expect(runs[0]!.exit).toBe('gate');
    expect(runs[0]!.sessionId).toBe(entry.sessionId);
    expect(runs[0]!.startedAt).toBe(entry.startedAt);
    // Difficulty was measurable because it was written down at spawn.
    expect(runs[0]!.filesChanged).toBe(0);
    expect(runs[0]!.labels).toEqual(['bug']);
    // The usage came off the stream file, which nobody was reading at the time.
    expect(runs[0]!.outputTokens).toBe(300);
    expect(runs[0]!.usageSource).toBe('modelUsage');

    // A third console start must not count the same run again.
    const third = orch();
    await third.start();
    expect(await readRuns(runsFile)).toHaveLength(1);
    await third.stop();
    await second.stop();
  });

  it('says so on a row that would otherwise read as an ordinary checkpoint', async () => {
    process.env.STUB_NO_GATE = '1';
    const first = orch();
    const entry = await startAWorkerThatKeepsRunning(first);
    await first.stop();

    letItFinish();
    await waitFor('the worker to finish', () => !pidAlive(entry.pid));

    const second = orch();
    await second.start();
    expect(row(second).status).toBe('checkpoint');
    expect(row(second).statusDetail).toContain('ended while the console was down');
    // It finished cleanly, so it is not a failure — just an unattended ending.
    expect(row(second).lastError).toBeNull();
    expect((await readRuns(runsFile))[0]!.exit).toBe('exited-no-gate');
    await second.stop();
  });

  it('reconciles a dead pid whose stream file is still there', async () => {
    // A worker that ran to its gate and exited, with a state file that still
    // thinks it is running — a console killed with SIGKILL mid-run.
    const o = orch();
    await o.start();
    o.enqueue(ISSUE);
    await waitFor('the run to finish normally', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');
    await o.stop();

    const done = (await readRuns(runsFile))[0]!;
    const streamFile = join(streamDir, `${ISSUE}-${done.sessionId}.stream.jsonl`);
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    state.runningRuns = {
      [ISSUE]: {
        issue: ISSUE,
        sessionId: done.sessionId,
        pid: 4_194_303, // above every default pid_max: it cannot be alive
        worktree,
        streamFile,
        stderrFile: join(streamDir, `${ISSUE}-${done.sessionId}.stderr.log`),
        startOffset: 0,
        offset: 0,
        startedAt: done.startedAt,
        model: done.model,
        account: done.account,
        headBefore: null,
        stageStart: null,
        labels: [],
      } satisfies RunningRun,
    };
    writeFileSync(stateFile, JSON.stringify(state));

    const second = orch();
    expect((await second.start()).reconciled).toEqual([ISSUE]);
    expect(row(second).status).toBe('at-gate');
    // The run was already recorded, and the identity check stops it being
    // recorded a second time.
    expect(await readRuns(runsFile)).toHaveLength(1);
    await second.stop();
  });

  /**
   * The pid is alive — but it is this test process, not a worker. Believing it
   * would mean "Stop this worker" sending SIGTERM to a stranger, so it must be
   * reconciled instead of adopted.
   */
  it('refuses a pid that has been recycled, and reconciles instead', async () => {
    const o = orch();
    await o.start();
    o.enqueue(ISSUE);
    await waitFor('the run to finish normally', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');
    await o.stop();

    const done = (await readRuns(runsFile))[0]!;
    const streamFile = join(streamDir, `${ISSUE}-${done.sessionId}.stream.jsonl`);
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    state.runningRuns = {
      [ISSUE]: {
        issue: ISSUE,
        sessionId: done.sessionId,
        pid: process.pid, // alive, and emphatically not a claude worker
        worktree,
        streamFile,
        stderrFile: join(streamDir, `${ISSUE}-${done.sessionId}.stderr.log`),
        startOffset: 0,
        offset: 0,
        startedAt: done.startedAt,
        model: done.model,
        account: done.account,
        headBefore: null,
        stageStart: null,
        labels: [],
      } satisfies RunningRun,
    };
    writeFileSync(stateFile, JSON.stringify(state));

    const second = orch();
    const picked = await second.start();
    expect(picked.reattached).toEqual([]);
    expect(picked.reconciled).toEqual([ISSUE]);
    expect(row(second).status).toBe('at-gate');
    await second.stop();
  });

  it('refuses an entry whose stream file predates the run it claims', async () => {
    const o = orch();
    await o.start();
    o.enqueue(ISSUE);
    await waitFor('the run to finish normally', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');
    await o.stop();

    const done = (await readRuns(runsFile))[0]!;
    const streamFile = join(streamDir, `${ISSUE}-${done.sessionId}.stream.jsonl`);
    // A file written long before the run that supposedly produced it is not that
    // run's file, whatever the pid says.
    const old = new Date(Date.parse(done.startedAt) - 3_600_000);
    utimesSync(streamFile, old, old);

    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    state.runningRuns = {
      [ISSUE]: {
        issue: ISSUE,
        sessionId: done.sessionId,
        pid: process.pid,
        worktree,
        streamFile,
        stderrFile: join(streamDir, `${ISSUE}-${done.sessionId}.stderr.log`),
        startOffset: 0,
        offset: 0,
        startedAt: done.startedAt,
        model: done.model,
        account: done.account,
        headBefore: null,
        stageStart: null,
        labels: [],
      } satisfies RunningRun,
    };
    writeFileSync(stateFile, JSON.stringify(state));

    const second = orch();
    expect((await second.start()).reattached).toEqual([]);
    await second.stop();
  });
});

describe('the stream file', () => {
  it('is one file per session that every segment appends to, read a segment at a time', async () => {
    const o = orch();
    await o.start();
    o.enqueue(ISSUE);
    await waitFor('the gate', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');

    const sessionId = row(o).sessionId!;
    const streamFile = join(streamDir, `${ISSUE}-${sessionId}.stream.jsonl`);
    expect(existsSync(streamFile)).toBe(true);
    const afterFirst = readFileSync(streamFile, 'utf8');

    await o.resume(ISSUE, 'Gate C approved, proceed.');
    await waitFor('both runs to be logged', () => (existsSync(runsFile) ? readFileSync(runsFile, 'utf8').trim().split('\n').length === 2 : false));

    // The same file, appended to — the whole session's stream in one place.
    expect(readFileSync(streamFile, 'utf8').startsWith(afterFirst)).toBe(true);
    const runs = await readRuns(runsFile);
    // Each segment measured itself, not the session: the second run's turns are
    // its own, not the first one's as well.
    expect(runs[0]!.segment).toBe('C');
    expect(runs[1]!.segment).toBe('none');
    expect(runs[1]!.assistantTurns).toBe(2);
    await o.stop();
  });
});
