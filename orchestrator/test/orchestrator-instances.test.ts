import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator, type OrchestratorDeps } from '../src/orchestrator.js';
import { DEFAULT_EDGE_CONTAINER, loadConfig } from '../src/config.js';
import { RESERVED_PORT, type InstanceProbes } from '../src/instances.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ResourceReport } from '../src/types.js';

/**
 * The resource controls, end to end through a real orchestrator:
 *
 *   - the inventory of what is running, and the ONE manual stop;
 *   - "Stop this worker" frees what the worker caused — and a stop of something
 *     that is not running frees nothing, because that dev server may be the app
 *     the operator has open;
 *   - a worker parked at a gate KEEPS its dev server: that gate is their QA of the
 *     running app, and the screenshots come from the same server;
 *   - the edge runtime is restarted when the operator clicks the button and at no other
 *     moment — never twice at once, and never a worker started into the middle
 *     of one;
 *   - and none of it ever touches port 8080, a process outside its worktree, or
 *     any container but the edge runtime.
 *
 * Nothing here signals a real process or restarts a real container: the three
 * things that touch the machine are injected, and the assertions are about what
 * was asked of them (usually: nothing).
 */

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const ISSUE = 4336;
const OTHER_ISSUE = 4342;
const PORT = 8083;
const DEV_PID = 5150;
const GB = 1024 ** 3;

let repo: string;
let worktree: string;
let home: string;
let canonical: string;
let stateFile: string;

let killed: number[];
let restarted: string[];
let attempts: string[];
let logged: string[];
/** What the fake machine currently looks like. Tests move these. */
let machine: { pids: number[]; cwd: string | null; edgeBytes: number | null; freePct: number | null };

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const report = (over: Partial<ResourceReport> = {}): ResourceReport => ({
  ok: true,
  reason: 'memory ok',
  freePct: machine.freePct,
  headroomBytes: 8 * GB,
  headroomLabel: '8.0 GB',
  minFreePct: 25,
  footprintBytes: 0,
  footprintLabel: '0 GB',
  ceilingBytes: 11 * GB,
  ceilingLabel: '11.0 GB',
  totalBytes: 16 * GB,
  edgeRuntimeLabel: '2.27GiB',
  edgeRuntimeBytes: machine.edgeBytes,
  workerHeadroomBytes: 2 * GB,
  checkedAt: new Date().toISOString(),
  ...over,
});

beforeEach(() => {
  killed = [];
  restarted = [];
  attempts = [];
  logged = [];
  machine = { pids: [DEV_PID], cwd: null, edgeBytes: 2.27 * GB, freePct: 20 };

  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-inst-home-')));
  canonical = join(home, '.claude');
  mkdirSync(canonical, { recursive: true });
  stateFile = join(home, 'state.json');

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-inst-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-demo`);
  git(['worktree', 'add', '-b', `fix/issue-${ISSUE}-demo`, worktree, 'dev'], repo);
  // The port registry the attribution rule reads.
  writeFileSync(
    join(worktree, '.issue-state.md'),
    `# Issue #${ISSUE}\n\n- **Dev-server port**: **${PORT}**\n- **Stage reached**: 4\n- **Gates passed**: none\n`,
  );
  // A dev server "running in" the worktree, unless a test says otherwise.
  machine.cwd = worktree;

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: ISSUE, title: 'Org sysadmin filter pills', url: 'u', labels: ['bug'], updatedAt: 'z', author: 'operator' },
    { number: OTHER_ISSUE, title: 'Mounts', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
  ]);
  // Merged PRs are read on every poll now (a merged PR used to vanish from the
  // console and the row lied). Stubbed empty so no test reaches the network.
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(gh, 'listAuthoredOpenPrs').mockResolvedValue([]);
  vi.spyOn(resources, 'probeResources').mockImplementation(async () => report());
});

afterEach(() => {
  // FIRST, and unconditionally: a test that fails an assertion never reaches its
  // own cleanup, and a stub worker is a real detached process that would poll
  // for a go-file in a directory this line is about to delete, for ever.
  killSpawnedWorkers(stateFile);
  delete process.env.STUB_WAIT_FOR;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const probes: InstanceProbes = {
  dockerStats: async () => `${DEFAULT_EDGE_CONTAINER}\t2.27GiB / 7.817GiB\t29%\n`,
  listeningPids: async (port) => (port === PORT ? machine.pids : []),
  cwdOf: async () => machine.cwd,
  rss: async (pids) => new Map(pids.map((p) => [p, 300 * 1024 * 1024])),
  freePct: async () => machine.freePct,
};

function deps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    instanceProbes: probes,
    kill: (pid) => killed.push(pid),
    restartContainer: async (name) => {
      attempts.push(name);
      restarted.push(name);
      machine.edgeBytes = 381 * 1024 ** 2; // what the restart actually achieves
      return 'ok';
    },
    log: (line) => logged.push(line),
    ...over,
  };
}

function orch(env: Record<string, string> = {}, over: Partial<OrchestratorDeps> = {}) {
  return new Orchestrator(
    loadConfig({
      REPO: 'example-org/example-repo',
      REPO_PATH: repo,
      STATE_FILE: stateFile,
      RUNS_FILE: join(home, 'runs.jsonl'),
      STREAM_DIR: join(home, 'runs'),
      STREAM_POLL_MS: '25',
      CANONICAL_CLAUDE_DIR: canonical,
      CLAUDE_BIN: STUB,
      POLL_MS: '999999',
      METRICS_REFRESH_HOURS: '999',
      // Two workers may run at once by default; these tests are about memory,
      // not about the desk, so pin it and stay independent of that default.
      MAX_ACTIVE: '1',
      ...env,
    }),
    deps(over),
  );
}

const row = (o: Orchestrator) => o.state().issues.find((r) => r.number === ISSUE)!;

// -------------------------------------- 3. a gate does NOT stop the dev server

describe('a worker parked at a gate keeps its dev server', () => {
  /**
   * The design decision this asserts, and it is the opposite of what the first
   * cut did: gate C IS the operator's manual QA of the running app, and the Playwright
   * screenshot capture drives the same dev server. Stopping it when the worker
   * parks would take the app away at exactly the moment they need it.
   */
  it('stops NOTHING when a worker parks at a gate', async () => {
    const o = orch();
    await o.start();
    o.enqueue(ISSUE);
    await waitFor('the gate', () => row(o).status === 'at-gate');

    expect(killed).toEqual([]);
    expect(row(o).devServerStop).toBeNull();
    expect(logged.join(' ')).not.toContain('stopped the dev server');
    await o.stop();
  });

  it('still stops it on the panel’s explicit click, and says so on the row', async () => {
    const o = orch();
    await o.start();

    const out = await o.stopDevServerFor(ISSUE, 'you stopped it from the instances panel');
    expect(out.ok).toBe(true);
    expect(killed).toEqual([DEV_PID]);
    expect(row(o).devServerStop).toMatchObject({ port: PORT, pid: DEV_PID });
    expect(row(o).devServerStop!.why).toContain('instances panel');
    await o.stop();
  });

  it('leaves it alone when the dev server is running somewhere else entirely', async () => {
    machine.cwd = '/somewhere/else';
    const o = orch();
    await o.start();

    const out = await o.stopDevServerFor(ISSUE, 'a test asked directly');
    expect(out.ok).toBe(false);
    expect(killed).toEqual([]);
    expect(row(o).devServerStop).toBeNull();
    await o.stop();
  });

  it('never stops anything on port 8080, whatever the registry says', async () => {
    writeFileSync(
      join(worktree, '.issue-state.md'),
      `# Issue #${ISSUE}\n\n- **Dev-server port**: **${RESERVED_PORT}**\n- **Stage reached**: 4\n`,
    );
    const o = orch();
    await o.start();

    const refusal = await o.stopDevServerFor(ISSUE, 'a test asked directly');
    expect(refusal.ok).toBe(false);
    expect(refusal.message).toContain('8080');
    expect(killed).toEqual([]);
    await o.stop();
  });

  it('never stops anything on a port that is not in the worktree range', async () => {
    writeFileSync(
      join(worktree, '.issue-state.md'),
      `# Issue #${ISSUE}\n\n- **Dev-server port**: **3000**\n- **Stage reached**: 4\n`,
    );
    const o = orch();
    await o.start();

    const refusal = await o.stopDevServerFor(ISSUE, 'a test asked directly');
    expect(refusal.ok).toBe(false);
    expect(refusal.message).toContain('8081');
    expect(killed).toEqual([]);
    await o.stop();
  });
});

// -------------------------------------------- 4. stopping a worker frees memory

describe('stopping a worker frees what the worker caused', () => {
  it('kills the worker AND that worktree’s dev server, and says both', async () => {
    const goFile = join(home, 'go.txt');
    process.env.STUB_WAIT_FOR = goFile;
    const o = orch();
    await o.start();
    o.enqueue(ISSUE);
    await waitFor('the worker to be running', () => row(o).status === 'active');

    const out = await o.stopWorker(ISSUE);
    expect(out.ok).toBe(true);
    expect(out.message).toContain('stopping #4336');
    expect(out.message).toContain('dev server');
    expect(killed).toContain(DEV_PID);

    delete process.env.STUB_WAIT_FOR;
    writeFileSync(goFile, 'go');
    await o.stop();
  });

  /**
   * A POST to stop an issue that is not running must not quietly become a bare
   * dev-server kill. That server may be the app the operator has open in a browser at a
   * gate — stopping "the worker" would take it away with nothing running.
   */
  it('stops NOTHING when there was no worker running', async () => {
    const o = orch();
    await o.start();

    const out = await o.stopWorker(ISSUE);
    expect(out.ok).toBe(false);
    expect(out.message).toBe('nothing running');
    expect(killed).toEqual([]);
    expect(row(o).devServerStop).toBeNull();
    await o.stop();
  });
});

// ------------------------------------------- 2. restarting the edge runtime

/**
 * The edge runtime is the one container the console may restart, and the ONLY
 * thing that ever restarts it is the operator's click. There is deliberately no automatic
 * path — see "Why there is no automatic restart" in docs/INFO.md — so what is
 * tested here is the fences on the click, and that nothing else fires it.
 */
describe('restarting the edge runtime on the operator’s click', () => {
  it('restarts nothing on its own, however fat the container and however tight the machine', async () => {
    machine.edgeBytes = 6 * GB;
    machine.freePct = 2; // as licensing as the old automatic path ever got
    const o = orch();
    await o.start();
    await o.poll();
    await o.poll();

    expect(restarted).toEqual([]);
    expect(o.state().lastEdgeReclaim).toBeNull();
    await o.stop();
  });

  /**
   * Every state.json written before the automatic restart was removed still has
   * a `lastEdgeReclaim` cooldown record in it. Loading one must not throw, must
   * not resurrect the banner, and must not carry the key back out on the next
   * save — the console simply no longer knows what it means.
   */
  it('ignores a lastEdgeReclaim left in state.json by an older console', async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        lastEdgeReclaim: { at: 'sometime last tuesday', grewTo: '2 GB', freePctBefore: 20, by: 'auto', ok: true },
        sessions: { '4336': 'kept-because-this-key-still-exists' },
      }),
    );
    const o = orch();
    await o.start();

    expect(o.state().lastEdgeReclaim).toBeNull();
    expect(restarted).toEqual([]);
    await o.stop();

    const written = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    expect(written.lastEdgeReclaim).toBeUndefined();
    expect(written.sessions).toEqual({ '4336': 'kept-because-this-key-still-exists' });
  });

  it('restarts it on the click, and says what it did', async () => {
    const o = orch();
    await o.start();

    const out = await o.reclaimEdgeRuntime();
    expect(out.ok).toBe(true);
    expect(restarted).toEqual([DEFAULT_EDGE_CONTAINER]);
    expect(o.state().lastEdgeReclaim).toMatchObject({ grewTo: '2.27GiB', freePctBefore: 20, ok: true });
    await o.stop();
  });

  /**
   * EDGE_CONTAINER is an environment string on the one code path that restarts a
   * container. Point it at the DATABASE and the answer has to be that nothing of
   * the sort happens — the name is rejected by config, and the click restarts the
   * edge runtime it actually measured.
   */
  it('can never be pointed at the database container', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const o = orch({ EDGE_CONTAINER: 'supabase_db_example-app' });
    await o.start();

    const out = await o.reclaimEdgeRuntime();
    expect(out.ok).toBe(true);
    expect(restarted).toEqual([DEFAULT_EDGE_CONTAINER]);
    expect(restarted).not.toContain('supabase_db_example-app');
    warn.mockRestore();
    await o.stop();
  });

  /** A valid override — another project's edge runtime — is honoured. */
  it('follows an EDGE_CONTAINER override that is genuinely an edge runtime', async () => {
    const other = 'supabase_edge_runtime_other-project';
    const o = orch({ EDGE_CONTAINER: other });
    await o.start();

    await o.reclaimEdgeRuntime();
    expect(restarted).toEqual([other]);
    await o.stop();
  });

  /**
   * The restart takes ~12 seconds. While it is happening: a second click must not
   * start a second restart, and no worker may be dispatched into it — with its
   * own reason, not a free-% number that is about to change anyway.
   */
  it('holds dispatch and refuses a second restart while one is in flight', async () => {
    let release = () => {};
    const blocked = new Promise<void>((r) => (release = r));
    const o = orch(
      {},
      {
        restartContainer: async (name) => {
          attempts.push(name);
          await blocked;
          restarted.push(name);
          return 'ok';
        },
      },
    );
    await o.start();

    const inFlight = o.reclaimEdgeRuntime();
    await waitFor('the restart to be under way', () => attempts.length === 1);

    const second = await o.reclaimEdgeRuntime();
    expect(second.ok).toBe(false);
    expect(second.message).toContain('already being restarted');

    o.enqueue(ISSUE);
    await o.poll();
    expect(o.state().dispatchReason).toContain('reclaiming the edge runtime');
    expect(row(o).status).not.toBe('active');

    release();
    await inFlight;
    expect(restarted).toEqual([DEFAULT_EDGE_CONTAINER]);
    await o.stop();
  });

  /** A restart that fails says so, once, rather than failing silently — and the
   *  in-flight flag clears, so the queue is not wedged by it. */
  it('reports a restart that did not come back, and does not wedge dispatch', async () => {
    const o = orch(
      {},
      {
        restartContainer: async (name) => {
          attempts.push(name);
          throw new Error('Cannot connect to the Docker daemon\nis it running?');
        },
      },
    );
    await o.start();

    const out = await o.reclaimEdgeRuntime();
    expect(out.ok).toBe(false);
    expect(attempts).toHaveLength(1);

    const failure = o.state().lastEdgeReclaim!;
    expect(failure.ok).toBe(false);
    expect(failure.error).toContain('Docker daemon');
    expect(logged.join(' ')).toContain('could not restart');

    // ...and the console is still able to work.
    await o.poll();
    expect(o.state().dispatchReason).not.toContain('reclaiming the edge runtime');
    await o.stop();
  });
});

// ---------------------------------------------------------- 1. the inventory

describe('the instances inventory', () => {
  it('reports containers, the attributed dev server and this console’s workers', async () => {
    const o = orch();
    await o.start();

    const inv = await o.instances();
    expect(inv.containers[0]!.isEdgeRuntime).toBe(true);
    expect(inv.devServers).toHaveLength(1);
    expect(inv.devServers[0]).toMatchObject({ issue: ISSUE, port: PORT, pid: DEV_PID, stoppable: true });
    expect(inv.workers).toEqual([]); // nothing running right now
    expect(inv.notes).toEqual([]); // everything was readable, so nothing to warn about
    await o.stop();
  });

  /**
   * The rule that exists because it went wrong: a test that let the real
   * `probeResources` run measured the real edge runtime, found it fat, and
   * restarted the operator's actual container while a worker was live. An orchestrator
   * that has not been handed a machine does not get one.
   */
  it('touches nothing at all when a test has not wired the machine', async () => {
    const o = new Orchestrator(
      loadConfig({
        REPO: 'example-org/example-repo',
        REPO_PATH: repo,
        STATE_FILE: stateFile,
        RUNS_FILE: join(home, 'runs.jsonl'),
        STREAM_DIR: join(home, 'runs'),
        CANONICAL_CLAUDE_DIR: canonical,
        CLAUDE_BIN: STUB,
        POLL_MS: '999999',
        METRICS_REFRESH_HOURS: '999',
        MAX_ACTIVE: '1',
      }),
      // no deps: no probes, no kill, no container action
    );
    await o.start();
    expect(restarted).toEqual([]);
    expect(killed).toEqual([]);
    expect(o.state().lastEdgeReclaim).toBeNull();

    const inv = await o.instances();
    expect(inv.containers).toEqual([]);
    expect(inv.devServers).toEqual([]);
    expect(inv.freePct).toBeNull();
    await o.stop();
  });

  it('is held briefly, so opening the panel does not hammer docker and lsof', async () => {
    let calls = 0;
    const counting: InstanceProbes = { ...probes, dockerStats: async () => (calls++, '') };
    const o = orch({}, { instanceProbes: counting });
    await o.start();
    await o.instances();
    await o.instances();
    expect(calls).toBe(1);
    await o.stop();
  });
});
