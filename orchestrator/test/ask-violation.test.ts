/**
 * THE NAMED FAILURE MODE: the worker charges past a gate it was only asked about.
 *
 * A question at a gate is a message at a gate, and this console has already been
 * burned once by a message at a gate being read as more than it was (see
 * ui/src/gate.ts). If a worker reads "the operator wrote back at gate C" as
 * "gate C passed", it proceeds to stage 6, builds, and may open a PR — on a gate
 * nobody decided.
 *
 * The console cannot PREVENT that: the worker is autonomous and the prompt is
 * the only lever. What it can do is refuse to let it happen quietly. When an
 * ask-run ends anywhere other than the same gate it was asked at, that is
 * recorded against the issue, in plain English, with the one-click remedy named.
 *
 * A crash is NOT disobedience, and is deliberately not accused of it.
 *
 * `probeResources` is stubbed in every test: nothing here touches the real machine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { GateThreadRecord } from '../src/ask.js';
import type { ResourceReport } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const GATE = 4344;
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let repo: string;
let gateTree: string;
let home: string;
let canonical: string;
let accountsFile: string;
let stateFile: string;
let runsFile: string;
let streamDir: string;
let goFile: string;

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
  goFile = join(home, 'go.txt');
  writeFileSync(
    accountsFile,
    JSON.stringify({ default: 'personal', accounts: [{ name: 'personal', configDir: canonical }] }),
  );

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-viol-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  gateTree = join(repo, '.worktrees', `issue-${GATE}-demo`);
  git(['worktree', 'add', '-b', `fix/issue-${GATE}-demo`, gateTree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: GATE, title: 'Save and Exit', url: 'u', labels: ['P2'], updatedAt: 'z', author: 'operator' },
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
  delete process.env.STUB_WAIT_FOR;
  delete process.env.STUB_REPARK;
  delete process.env.STUB_COMMIT;
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

const row = (o: Orchestrator, n = GATE) => o.state().issues.find((r) => r.number === n)!;
const thread = (o: Orchestrator): GateThreadRecord | null => row(o).gateThread;
const resumed = (): string => {
  try {
    return readFileSync(join(gateTree, 'resumed.txt'), 'utf8');
  } catch {
    return '';
  }
};

function parkAtGate() {
  writeFileSync(
    join(gateTree, '.gate.json'),
    JSON.stringify({
      issue: GATE,
      gate: 'C',
      stage: 5,
      sessionId: SESSION,
      stoppedAt: new Date().toISOString(),
      reportPath: null,
      summary: 'Your QA, please.',
      questions: ['Does the click-script pass?'],
    }),
  );
}

/**
 * Park at gate C, ask one question, and wait for the answering run to be over —
 * and for the console to have written down what it made of it.
 *
 * The run ENDING is not the moment the record is complete, and a `poll()` here
 * is not the barrier it looks like. `live` clears the instant the worker's
 * process goes; the verdict is written after that, when the ending is judged;
 * and the ANSWER lands later still, in the poll that follows the judgement and
 * merges the gate file the worker left behind. `poll()` is re-entrancy guarded,
 * so calling it here returns immediately — long before any scan — whenever the
 * run's own poll is already in flight. Under a loaded parallel suite that gap is
 * wide enough to hand the assertions a half-written record.
 *
 * So wait for the thing actually being asserted, exactly as the second-answer
 * test below does. Waiting on the merge also fixes the ORDER: the only poll left
 * is the run's own, which runs strictly after the ending is judged, so a merged
 * answer proves the violation — or the deliberate absence of one — is settled too.
 */
async function askAndSettle(o: Orchestrator, question: string): Promise<void> {
  await o.start();
  parkAtGate();
  await o.poll();
  await o.ask(GATE, question);
  await waitFor('the answering run to end', () => row(o).live === null && resumed().includes(question));
  // A worker that re-parks writes its answer into the gate file it leaves
  // behind, so the merged answer IS the whole ending having landed. One that
  // charges past never answers at all: there the ending is the violation, plus
  // the gate it walked away from being gone.
  if (process.env.STUB_REPARK) {
    await waitFor('the answer to be merged onto the question', () => (thread(o)?.entries[0]?.answer ?? null) !== null);
  } else {
    await waitFor(
      'the charge-past to be recorded',
      () => (thread(o)?.violation ?? null) !== null && row(o).gate === null,
    );
  }
}

describe('the good path: the worker answers and stops at the same gate again', () => {
  it('stamps the answer onto the question and records no violation', async () => {
    process.env.STUB_REPARK = 'C';
    const o = orch();
    await askAndSettle(o, 'which table does the role come from?');

    const rec = thread(o)!;
    expect(rec.violation).toBeNull();
    expect(rec.entries[0]!.answer).toContain('answered: which table does the role come from?');
    expect(rec.entries[0]!.answeredAt).not.toBeNull();
    // And the gate is still there, still the operator's to decide.
    expect(row(o).gate?.gate).toBe('C');
    expect(row(o).status).toBe('at-gate');
    await o.stop();
  });

  it('leaves an answered question answered when a later question is asked', async () => {
    process.env.STUB_REPARK = 'C';
    const o = orch();
    await askAndSettle(o, 'first question');
    await o.ask(GATE, 'second question');
    await waitFor('the second answer', () => (thread(o)?.entries[1]?.answer ?? null) !== null);

    const rec = thread(o)!;
    expect(rec.entries).toHaveLength(2);
    expect(rec.entries[0]!.answer).toContain('first question');
    expect(rec.entries[1]!.answer).toContain('second question');
    await o.stop();
  });
});

describe('the charge-past', () => {
  it('is caught when the worker stops at a DIFFERENT gate', async () => {
    process.env.STUB_REPARK = 'D';
    const o = orch();
    await askAndSettle(o, 'why is the flag named that?');

    const rec = thread(o)!;
    expect(rec.violation).toContain('moved past gate C');
    expect(rec.violation).toContain('Reopen gate C');
    expect(rec.violation).toContain('nothing you sent passed the gate');
    // The question stays on the card, so nothing asked is lost in the noise.
    expect(rec.entries[0]!.question).toBe('why is the flag named that?');
    await o.stop();
  });

  it('is caught in its worst form — the worker sailed on with no gate file at all', async () => {
    // No STUB_REPARK: the stub resume deletes .gate.json and finishes, which is
    // exactly what a worker that read the question as an approval would do.
    const o = orch();
    await askAndSettle(o, 'what happens to existing rows?');

    expect(thread(o)!.violation).toContain('moved past gate C');
    expect(row(o).gate).toBeNull(); // the gate really is gone — that is the point
    await o.stop();
  });

  it('is NOT recorded when the run simply died — a crash is not disobedience', async () => {
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();
    // The stub fails on a prompt containing FAIL, so this question makes the run
    // die rather than misbehave.
    await o.ask(GATE, 'why did the migration FAIL?');
    await waitFor('the failed run to end', () => row(o).live === null && row(o).lastError !== null);
    await o.poll();

    const rec = thread(o)!;
    expect(rec.violation).toBeNull();
    expect(rec.entries[0]!.answer).toBeNull(); // still unanswered, honestly
    await o.stop();
  });

  it('is caught even when a POLL lands in the window before the run ends', async () => {
    // The charge-past is detected when the run ENDS, and the verdict is written
    // onto the thread record. But the worker writes its new `.gate.json` before
    // it exits, so between those two moments the console can see a gate file for
    // a DIFFERENT gate with the answering run still in flight. Any poll landing
    // there — the 15-minute timer, another run ending, or the operator pressing
    // Refresh — used to retire the thread as "the worker moved on", and the
    // ending then found no record to write the violation onto. The gate was lost
    // silently: gate D appeared as an ordinary new stop and nothing said that
    // gate C had never been decided.
    process.env.STUB_WAIT_FOR = goFile;
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();
    await o.ask(GATE, 'what does a non-sysadmin see now?');
    await waitFor('the answering run to start', () => row(o).live !== null);

    // The worker has charged past and written gate D — and is STILL RUNNING.
    writeFileSync(
      join(gateTree, '.gate.json'),
      JSON.stringify({ issue: GATE, gate: 'D', stage: 6, sessionId: SESSION, stoppedAt: new Date().toISOString(), summary: 'PR time', questions: [] }),
    );
    await o.poll(); // <- the poll that used to delete the thread

    expect(thread(o), 'the thread must survive a poll taken while its own run is still going').not.toBeNull();

    writeFileSync(goFile, 'go');
    await waitFor('the violation to be recorded', () => (thread(o)?.violation ?? null) !== null);
    expect(thread(o)!.violation).toContain('moved past gate C');
    expect(thread(o)!.entries[0]!.question).toBe('what does a non-sysadmin see now?');
    await o.stop();
  });

  it('is caught when the worker BUILT during the answer, even though it re-parked correctly', async () => {
    // The gate letter is the only thing the console could prove, and the ask
    // prompt itself tells the worker to write the same letter back — so the one
    // structural check was satisfied by a mandated step of the run. Everything
    // else it did went unexamined: a worker could answer the question, build the
    // feature, commit it, re-park at gate C, and the row would read `at-gate` as
    // if nothing had happened. That is exactly the thing a gate exists to stop.
    process.env.STUB_REPARK = 'C';
    process.env.STUB_COMMIT = '1';
    const o = orch();
    await askAndSettle(o, 'which table does the role come from?');

    const rec = thread(o)!;
    expect(rec.violation).toContain('a commit landed');
    expect(rec.violation).toContain('gate C');
    expect(rec.violation).toContain('you did not approve');
    // The answer still landed and is still shown — this is not a failed run.
    expect(rec.entries[0]!.answer).toContain('answered:');
    expect(row(o).gate?.gate).toBe('C');
    await o.stop();
  });

  it('says NOTHING about commits when the worker only answered', async () => {
    process.env.STUB_REPARK = 'C';
    const o = orch();
    await askAndSettle(o, 'why is the flag named that?');
    expect(thread(o)!.violation).toBeNull();
    await o.stop();
  });

  it('is still caught when the console restarted while the worker was answering', async () => {
    // Detection has to survive a restart, which means it cannot live in memory:
    // the fact that THIS run is an ask is written into the running-worker row.
    process.env.STUB_WAIT_FOR = goFile;
    const first = orch();
    await first.start();
    parkAtGate();
    await first.poll();
    await first.ask(GATE, 'asked before the console restarted');
    await waitFor('the answering run to start', () => row(first).live !== null);
    await first.stop(); // leaves the worker running on purpose
    delete process.env.STUB_WAIT_FOR;

    const second = orch();
    await second.start(); // re-attaches to the same pid
    await waitFor('the re-attached run to be visible', () => row(second).live !== null);
    writeFileSync(goFile, 'go'); // it finishes without re-parking: the charge-past

    await waitFor('the violation to be recorded', () => (thread(second)?.violation ?? null) !== null);
    expect(thread(second)!.violation).toContain('moved past gate C');
    await second.stop();
  });
});
