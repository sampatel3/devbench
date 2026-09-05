/**
 * APPROVING GATE C TAKES ITS DEV SERVER DOWN.
 *
 * The server's only two customers are the worker's Playwright capture and the
 * operator's own click-through. Both are over the moment the gate is approved,
 * nothing between there and the merge needs it, and one of them sat on port 8083
 * for a whole day. So the approval cleans up after itself.
 *
 * Three things are asserted, and they are the three that make this defensible:
 *
 *  1. it goes down the EXISTING guarded path — the process must be listening on
 *     that worktree's registered port AND have its working directory inside
 *     that worktree, both already enforced in instances.ts;
 *  2. it never touches port 8080, whatever a worktree claims to register;
 *  3. a stop that FAILS is logged and dropped — the operator's approval has
 *     already been taken, and a dev server that would not die must never make
 *     that decision read as failed.
 *
 * Nothing here signals a pid it did not invent: `kill` is a recorder, and the
 * lsof/cwd probes are fixtures. No worker is spawned — MAX_ACTIVE=0 parks the
 * resume, which is a real path of its own (an answer taken at capacity) and the
 * one that keeps this test deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { inertProbes } from '../src/instances.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ResourceReport } from '../src/types.js';

const ISSUE = 4404;
const PORT = 8083;
const DEV_PID = 424242;

let repo: string;
let worktree: string;
let home: string;
let stateFile: string;
/** Every pid the console asked to have signalled. Recorded, never delivered. */
let killed: number[];
let logs: string[];

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' });

beforeEach(() => {
  killed = [];
  logs = [];
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-gatec-home-')));
  stateFile = join(home, 'state.json');

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-gatec-repo-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-withdraw`);
  git(['worktree', 'add', '-b', `fix/issue-${ISSUE}-withdraw`, worktree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: ISSUE, title: 'Withdraw', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
  ]);
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(gh, 'listAuthoredOpenPrs').mockResolvedValue([]);
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
    edgeRuntimeBytes: null,
    workerHeadroomBytes: 0,
    swapUsedPct: 10,
    swapLabel: '1.6 GB of 16.0 GB (10%)',
    maxSwapPct: 85,
    checkedAt: new Date().toISOString(),
  } as ResourceReport);
});

afterEach(() => {
  killSpawnedWorkers(stateFile);
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The worktree as the worker left it: a port claimed in prose, and a gate C
 *  parked with a two-step click-script. */
function parkAtGateC(port = PORT): void {
  writeFileSync(
    join(worktree, '.issue-state.md'),
    `# Issue #${ISSUE}\n\n- **Dev-server port**: **${port}** — running\n- **Stage reached**: 5\n`,
  );
  writeFileSync(
    join(worktree, '.gate.json'),
    JSON.stringify({
      issue: ISSUE,
      gate: 'C',
      stage: 5,
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      stoppedAt: '2026-08-12T09:00:00.000Z',
      summary: 'Did: drove the app headlessly.',
      questions: [],
      manualQa: {
        appUrl: `http://localhost:${port}`,
        start: 'a quote in Sent',
        // Both legs: a step short of a capture locks the gate on its own now,
        // and what this file is about is the dev server.
        steps: [
          {
            id: 1,
            rev: 1,
            do: 'Withdraw a sent quote',
            before: 'no warning',
            beforeShot: `docs/issue-pipeline/plans/qa-${ISSUE}/s1-before.png`,
            after: 'it asks first',
            afterShot: `docs/issue-pipeline/plans/qa-${ISSUE}/s1-after.png`,
          },
        ],
      },
    }),
  );
}

/**
 * `cwd` is what the attribution rule verifies, so a test can make the process
 * belong to the worktree or not simply by pointing it somewhere else.
 */
function orch(opts: { listening?: number[]; cwd?: string | null } = {}) {
  return new Orchestrator(
    loadConfig({
      REPO: 'example-org/example-repo',
      REPO_PATH: repo,
      STATE_FILE: stateFile,
      RUNS_FILE: join(home, 'runs.jsonl'),
      STREAM_DIR: join(home, 'runs'),
      CANONICAL_CLAUDE_DIR: join(home, '.claude'),
      POLL_MS: '999999',
      // Nothing spawns: the approval is TAKEN and parked, which is the path an
      // answer at a busy desk already goes down.
      MAX_ACTIVE: '0',
    }),
    {
      instanceProbes: {
        ...inertProbes,
        listeningPids: async () => opts.listening ?? [DEV_PID],
        cwdOf: async () => (opts.cwd === undefined ? worktree : opts.cwd),
      },
      kill: (pid) => {
        killed.push(pid);
      },
      log: (line) => logs.push(line),
    },
  );
}

describe('approving gate C stops that issue’s dev server', () => {
  it('stops it — the right pid, on that worktree’s registered port', async () => {
    const o = orch();
    parkAtGateC();
    await o.poll();
    await o.setQaVerdict(ISSUE, { stepId: 1, rev: 1, status: 'verified', note: null });

    const out = await o.approveGateC(ISSUE, 'Gate C approved — I ran the manual QA myself.');
    expect(out.ok).toBe(true);

    expect(killed).toEqual([DEV_PID]);
    const stop = o.state().issues.find((r) => r.number === ISSUE)!.devServerStop;
    expect(stop).toMatchObject({ port: PORT, pid: DEV_PID, why: 'you approved gate C' });
    await o.stop();
  });

  it('leaves a REFUSED gate C alone — nothing approved, nothing stopped', async () => {
    const o = orch();
    parkAtGateC();
    await o.poll(); // no tick recorded: the gate is not passable

    const out = await o.approveGateC(ISSUE, 'looks fine to me');
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not passable yet/);
    expect(killed).toEqual([]);
    await o.stop();
  });

  it('NEVER touches port 8080, whatever the worktree claims to register', async () => {
    const o = orch();
    parkAtGateC(8080);
    await o.poll();
    await o.setQaVerdict(ISSUE, { stepId: 1, rev: 1, status: 'verified', note: null });

    const out = await o.approveGateC(ISSUE, 'Gate C approved.');
    expect(out.ok).toBe(true); // the approval still went through
    expect(killed).toEqual([]); // and 8080 was not signalled
    expect(logs.join('\n')).toMatch(/8080/);
    await o.stop();
  });

  it('does not signal a process whose working directory is outside that worktree', async () => {
    const o = orch({ cwd: '/some/other/checkout' });
    parkAtGateC();
    await o.poll();
    await o.setQaVerdict(ISSUE, { stepId: 1, rev: 1, status: 'verified', note: null });

    expect((await o.approveGateC(ISSUE, 'Gate C approved.')).ok).toBe(true);
    expect(killed).toEqual([]);
    await o.stop();
  });

  it('a failed stop is logged and dropped — it never turns the approval into a failure', async () => {
    // Nothing listening on the port at all: the guarded path refuses, loudly,
    // and the approval it is attached to is unaffected.
    const o = orch({ listening: [] });
    parkAtGateC();
    await o.poll();
    await o.setQaVerdict(ISSUE, { stepId: 1, rev: 1, status: 'verified', note: null });

    const out = await o.approveGateC(ISSUE, 'Gate C approved.');
    expect(out.ok).toBe(true);
    expect(out.message).not.toMatch(/dev server/i);
    expect(killed).toEqual([]);
    expect(logs.join('\n')).toMatch(/dev server not stopped/);
    await o.stop();
  });
});
