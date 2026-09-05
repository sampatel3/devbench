/**
 * A WORKER THAT ENDED ITS TURN AND STOPPED AT NO GATE.
 *
 * On #5402 — gates A, B, C and D all passed, no PR, no gate file, one button on
 * the card — nothing said why the row was on a checkpoint. The answer was not on
 * the card and the button was the wrong one, and both halves are asserted here.
 *
 *  1. WHAT THE ROW SAYS. `outcome: 'finished'` means the process exited 0,
 *     emitted its `result` event and wrote no `.gate.json`. Nothing failed, so
 *     `#track` clears `lastError` — which removed the last trace that a run had
 *     happened at all, and the row printed "stopped after stage N", the same
 *     sentence an untouched worktree prints. The console wrote
 *     `exit: 'exited-no-gate'` into `runs.jsonl` in the very next line of the
 *     same handler; now it says so where the operator reads it.
 *
 *  2. WHAT THE BUTTON DOES. Such a row has no gate file and holds no answer, so
 *     dispatch matched neither of its two resume tests and took the fresh path:
 *     `/issue-pipeline <N>` from the TOP, under a newly minted session id, because
 *     `claude -p --session-id` refuses an id whose transcript already exists. So
 *     the only offer on a card four gates deep abandoned the context that got it
 *     there. It now continues that session with the skill's own resume mode.
 *
 * The stub is the real mechanism in both: `STUB_NO_GATE=1` is a clean exit with
 * no gate file, and on `--resume` it records the prompt it was handed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { sessionDir } from '../src/worker.js';
import { readRuns } from '../src/metrics.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ResourceReport } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const ISSUE = 5402;

let repo: string;
let tree: string;
let home: string;
let canonical: string;
let accountsFile: string;
let stateFile: string;
let runsFile: string;
let streamDir: string;

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

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-home-')));
  canonical = join(home, '.claude');
  mkdirSync(canonical, { recursive: true });
  accountsFile = join(home, 'accounts.json');
  stateFile = join(home, 'state.json');
  runsFile = join(home, 'runs.jsonl');
  streamDir = join(home, 'runs');
  writeFileSync(
    accountsFile,
    JSON.stringify({ default: 'personal', accounts: [{ name: 'personal', configDir: canonical }] }),
  );

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-checkpoint-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  tree = join(repo, '.worktrees', `issue-${ISSUE}-overlay`);
  git(['worktree', 'add', '-b', `fix/issue-${ISSUE}-overlay`, tree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    {
      number: ISSUE,
      title: 'broker-license overlay parity, token precedence, image allowlist',
      url: 'u',
      labels: ['P2'],
      updatedAt: 'z',
      author: 'reviewer-one',
    },
  ]);
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
  killSpawnedWorkers(stateFile);
  delete process.env.STUB_NO_GATE;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function orch() {
  return new Orchestrator(
    loadConfig({
      REPO: 'example-org/example-repo',
      REPO_PATH: repo,
      STATE_FILE: stateFile,
      RUNS_FILE: runsFile,
      ACCOUNTS_FILE: accountsFile,
      STREAM_DIR: streamDir,
      STREAM_POLL_MS: '25',
      CANONICAL_CLAUDE_DIR: canonical,
      CLAUDE_BIN: STUB,
      MAX_ACTIVE: '1',
      POLL_MS: '999999',
    }),
  );
}

const row = (o: Orchestrator) => o.state().issues.find((r) => r.number === ISSUE)!;

/** The transcript the real CLI would have left. It is what proves a worker has
 *  worked in this worktree, and the one file `#canContinue` asks about. */
function transcriptFor(sessionId: string): void {
  const dir = sessionDir(tree, canonical);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), '{"type":"user"}\n');
}

/** What the child received on a resume. Empty until it has written it. */
const resumedText = (): string => {
  try {
    return readFileSync(join(tree, 'resumed.txt'), 'utf8');
  } catch {
    return '';
  }
};

/**
 * A whole run has settled. The metrics ledger is written at the END of `#track`,
 * so a record appearing there is proof the run happened AND that everything
 * `#track` records has been recorded.
 *
 * Waiting on `status === 'checkpoint'` instead is a trap, and it is the one this
 * file fell into first: between `#dequeue` and `#runner.start` the row is
 * neither queued nor running, so it reads `checkpoint` — "stopped part-way" —
 * for the few milliseconds before the worker exists.
 */
async function waitForRuns(n: number, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await readRuns(runsFile)).length >= n) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${n} settled run(s)`);
}

/** A run that exits 0 and stops at no gate — the ending this file is about. */
async function endWithoutAGate(o: Orchestrator): Promise<void> {
  process.env.STUB_NO_GATE = '1';
  o.enqueue(ISSUE);
  await waitForRuns(1);
  delete process.env.STUB_NO_GATE;
  expect(row(o).status).toBe('checkpoint');
}

describe('a run that exits cleanly and stops at no gate', () => {
  it('says so on the row, instead of the sentence an untouched worktree prints', async () => {
    const o = orch();
    await o.start();
    await waitFor('the worktree to be scanned', () => o.state().issues.length === 1);
    await endWithoutAGate(o);

    expect(row(o).status).toBe('checkpoint');
    expect(row(o).statusDetail).toContain('the worker ended its turn without stopping at a gate');
    // Not a failure: it exited 0 and said so. That is exactly why the row had
    // nothing left to print — `#track` clears the error on any clean ending.
    expect(row(o).lastError).toBeNull();
    // The same fact the console has always written to the metrics ledger.
    expect((await readRuns(runsFile))[0]!.exit).toBe('exited-no-gate');
    await o.stop();
  }, 30_000);

  it('does not say it about a worker that parked at a gate', async () => {
    // The stub's default ending writes `.gate.json`, which is a legal stop and
    // the opposite of this. A flag that were set on every ending would say
    // nothing at all.
    const o = orch();
    await o.start();
    await waitFor('the worktree to be scanned', () => o.state().issues.length === 1);

    o.enqueue(ISSUE);
    await waitFor('the worker to park at its gate', () => row(o).status === 'at-gate');
    expect(row(o).statusDetail).not.toContain('without stopping at a gate');
    await o.stop();
  }, 30_000);
});

describe('starting a checkpoint back up', () => {
  it('CONTINUES the session it already has, rather than the skill from the top', async () => {
    const o = orch();
    await o.start();
    await waitFor('the worktree to be scanned', () => o.state().issues.length === 1);
    await endWithoutAGate(o);

    // The transcript the real CLI leaves behind. Without it there is nothing to
    // continue, and a fresh start is the right answer — which is the next test.
    const session = row(o).sessionId!;
    expect(session).not.toBeNull();
    transcriptFor(session);

    o.enqueue(ISSUE);
    await waitFor('the worker to be resumed', () => resumedText().includes('resumed with:'));
    await waitForRuns(2);

    // The skill's resume mode, into the SAME session. Both halves matter: the
    // old path sent `/issue-pipeline 5402` with no `resume`, and minted a new id
    // because that transcript exists — so the context went with it.
    expect(resumedText()).toContain(`resumed with: /issue-pipeline ${ISSUE} resume`);
    expect(resumedText()).not.toContain(`resumed with: /issue-pipeline ${ISSUE}\n`);
    expect(row(o).sessionId).toBe(session);
    await o.stop();
  }, 30_000);

  it('still starts the skill from the top when there is nothing to continue', async () => {
    // A worktree no worker has ever run in: no transcript, so no context, so the
    // fresh path is correct and untouched. This is the guard that keeps the new
    // branch from swallowing every start in the console.
    const o = orch();
    await o.start();
    await waitFor('the worktree to be scanned', () => o.state().issues.length === 1);

    o.enqueue(ISSUE);
    await waitFor('the worker to park at its gate', () => row(o).status === 'at-gate');

    // The stub records the prompt it was given inside the gate file it writes.
    const gate = JSON.parse(readFileSync(join(tree, '.gate.json'), 'utf8')) as { prompt: string };
    expect(gate.prompt).toContain(`/issue-pipeline ${ISSUE}`);
    expect(gate.prompt).not.toContain('resume');
    expect(resumedText()).toBe('');
    await o.stop();
  }, 30_000);
});
