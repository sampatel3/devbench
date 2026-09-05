import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { sessionDir } from '../src/worker.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { GateHistoryRecord, ResourceReport } from '../src/types.js';

/**
 * Taking a gate decision BACK.
 *
 * "Is there a way I can go back to gate A?" — a gate approved on an assumption
 * that turned out to be wrong is not something to live with: the session is
 * resumable, the worktree is on disk, and the gate history is append-only, so
 * reversing the decision costs a resume and a written record.
 *
 * What is asserted here is what the worker actually RECEIVED, from the stub's
 * own recording of its prompt — not what the console meant to send — and that
 * the round being reopened is left exactly as it was decided.
 */

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const BUSY = 4336; // holds the only slot
const OPEN = 4344; // the issue whose gates get reopened
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let repo: string;
let busyTree: string;
let tree: string;
let home: string;
let canonical: string;
let accountsFile: string;
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

/** One recorded gate exchange, exactly as the worker appends it on resume. */
function historyLine(gate: string, stage: number, decision: string): string {
  return JSON.stringify({
    issue: OPEN,
    gate,
    stage,
    sessionId: SESSION,
    stoppedAt: '2026-08-10T09:00:00.000Z',
    reportPath: null,
    summary: `Gate ${gate} — here is what I propose.`,
    questions: [`Is gate ${gate} the right call?`],
    evidence: [],
    decision,
    resumedAt: '2026-08-10T09:05:00.000Z',
    account: 'personal',
  });
}

/**
 * #4344 as it stands after gates A, B and C have all been passed and the work
 * has moved on: no live `.gate.json`, a gates-passed line, and a recorded
 * exchange for each one.
 */
function pastGates(): void {
  writeFileSync(
    join(tree, '.issue-state.md'),
    ['# Issue 4344', '', '**Stage reached**: 6', '**Gates passed**: A ✅, B ✅, C ✅', ''].join('\n'),
  );
  writeFileSync(
    join(tree, '.gate-history.jsonl'),
    [
      historyLine('A', 1, 'Gate A approved, proceed.'),
      historyLine('B', 2, 'Gate B approved, proceed.'),
      historyLine('C', 5, 'Gate C approved, proceed.'),
      '',
    ].join('\n'),
  );
}

/** A transcript on disk, which is how the console finds a resumable session for
 *  a worktree with no live gate file. */
function sessionOnDisk(worktree: string, id = SESSION): void {
  const dir = sessionDir(worktree, canonical);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), '{"type":"user"}\n');
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

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-reopen-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  busyTree = join(repo, '.worktrees', `issue-${BUSY}-demo`);
  tree = join(repo, '.worktrees', `issue-${OPEN}-demo`);
  git(['worktree', 'add', '-b', `fix/issue-${BUSY}-demo`, busyTree, 'dev'], repo);
  git(['worktree', 'add', '-b', `fix/issue-${OPEN}-demo`, tree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: BUSY, title: 'Org sysadmin filter pills', url: 'u', labels: ['P1'], updatedAt: 'z', author: 'operator' },
    { number: OPEN, title: 'Save and Exit', url: 'u', labels: ['P2'], updatedAt: 'z', author: 'operator' },
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
  // FIRST, and unconditionally: a worker holding the slot is a real detached
  // process, and a test that fails an assertion never reaches its own cleanup.
  killSpawnedWorkers(stateFile);
  delete process.env.STUB_WAIT_FOR;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** One slot, so one running worker is a full desk. */
function orch(env: Record<string, string> = {}) {
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
      ...env,
    }),
  );
}

const row = (o: Orchestrator, n: number) => o.state().issues.find((r) => r.number === n)!;
const persisted = (): { pendingResume?: Record<string, string> } => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')) as { pendingResume?: Record<string, string> };
  } catch {
    return {};
  }
};
const heldMessage = () => persisted().pendingResume?.[String(OPEN)];
/**
 * Has the console FINISHED with this run — not just stopped watching it?
 *
 * `row(...).live` is the runner's map, and `#finish` deletes that entry and only
 * then reads the stream file, the stderr and the transcript mtime before
 * resolving the run. So for a few milliseconds `live` is null while `#track` has
 * not yet given the spawn claim back, and `resume` — which `reopenGate` calls —
 * refuses on `#busy` with "already running". The persisted `runningRuns` row is
 * deleted INSIDE `#track`, after that claim goes back, so its absence from disk
 * is the signal that the run really is over.
 */
const runFinished = (n: number): boolean => {
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as { runningRuns?: Record<string, unknown> };
    return raw.runningRuns?.[String(n)] === undefined;
  } catch {
    return false;
  }
};
/** What the child actually received. Empty until it has written it: `existsSync`
 *  goes true the instant the file is created, which is before it has content. */
const resumedText = (): string => {
  try {
    return readFileSync(join(tree, 'resumed.txt'), 'utf8');
  } catch {
    return '';
  }
};
const gotResume = () => resumedText().includes('resumed with:');
/** The gate ledger the console writes, beside `state.json`. */
const ledger = (): Array<{ gate: string; decision: string }> => {
  try {
    return readFileSync(join(home, 'decisions.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { gate: string; decision: string });
  } catch {
    return [];
  }
};

/** A worker parked at gate C, so a resume has a gate to be recorded against.
 *  `ready()` deliberately leaves no gate file — this is for the tests that care
 *  what the LEDGER says, which is written only when one is on disk. */
function parkedAtGateC(): void {
  writeFileSync(
    join(tree, '.gate.json'),
    JSON.stringify({
      issue: OPEN,
      gate: 'C',
      stage: 5,
      sessionId: SESSION,
      stoppedAt: '2026-08-31T09:00:00.000Z',
      reportPath: null,
      summary: 'Did: drove the app on 8106.',
      questions: [],
    }),
  );
}

const historyOnDisk = (): GateHistoryRecord[] =>
  readFileSync(join(tree, '.gate-history.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GateHistoryRecord);

/** An issue three gates deep with a resumable session, and a free desk. */
async function ready(o: Orchestrator): Promise<void> {
  pastGates();
  sessionOnDisk(tree);
  await o.start();
  expect(row(o, OPEN).gatesPassed).toEqual(['A', 'B', 'C']);
}

/** Fill the only slot with a worker that will not finish until it is told to. */
async function deskFull(o: Orchestrator): Promise<void> {
  pastGates();
  sessionOnDisk(tree);
  process.env.STUB_WAIT_FOR = goFile;
  await o.start();
  o.enqueue(BUSY);
  await waitFor('the first worker to be running', () => row(o, BUSY).status === 'active');
  // Read at spawn, so removing it now leaves the running worker waiting while
  // everything spawned afterwards runs straight through.
  delete process.env.STUB_WAIT_FOR;
  await o.poll();
}

const freeTheSlot = () => writeFileSync(goFile, 'go');

describe('reopening a gate', () => {
  it('sends the worker back to stage 1 for gate A, with the correction verbatim', async () => {
    const o = orch();
    await ready(o);

    const out = await o.reopenGate(OPEN, 'A', 'the org filter is sysadmin-only, not any admin');

    expect(out.ok).toBe(true);
    await waitFor('the worker to be resumed', () => gotResume());
    // What the child actually received — the whole point of the assertion.
    expect(resumedText()).toContain(
      'resumed with: Reopening gate A. What changed: the org filter is sysadmin-only, not any admin. ' +
        'Re-run from stage 1 with this correction, and tell me what you are redoing before you redo it.',
    );
    await o.stop();
  });

  it('sends it back to stage 5 for gate C — the mapping is the skill’s, not a guess', async () => {
    const o = orch();
    await ready(o);

    await o.reopenGate(OPEN, 'C', 'my QA missed the empty state');

    await waitFor('the worker to be resumed', () => gotResume());
    expect(resumedText()).toContain(
      'resumed with: Reopening gate C. What changed: my QA missed the empty state. ' +
        'Re-run from stage 5 with this correction, and tell me what you are redoing before you redo it.',
    );
    await o.stop();
  });

  /**
   * A reopened gate C lands the worker back at the one gate with an evidence
   * box, and the round that produced it is history by then — so the standing
   * evidence rule goes with the correction, exactly as it does on an ask or a
   * rework. Nowhere else: gate A has nothing to display.
   */
  it('carries the standing evidence reminder at gate C, and only there', async () => {
    const o = orch();
    await ready(o);

    await o.reopenGate(OPEN, 'C', 'my QA missed the empty state');
    await waitFor('the worker to be resumed', () => gotResume());
    expect(resumedText()).toContain('EVERY TIME YOU STOP AT GATE C');
    expect(resumedText()).toContain('beforeShot');
    await o.stop();
  });

  it('leaves every other gate’s reopening exactly as it was', async () => {
    const o = orch();
    await ready(o);

    await o.reopenGate(OPEN, 'A', 'the org filter is sysadmin-only, not any admin');
    await waitFor('the worker to be resumed', () => gotResume());
    expect(resumedText()).not.toContain('EVERY TIME YOU STOP AT GATE C');
    await o.stop();
  });

  it('takes a lower-case letter, because a gate is a gate', async () => {
    const o = orch();
    await ready(o);
    expect((await o.reopenGate(OPEN, ' b ', 'the sweep changed the plan')).ok).toBe(true);
    await waitFor('the worker to be resumed', () => gotResume());
    expect(resumedText()).toContain('Reopening gate B.');
    expect(resumedText()).toContain('Re-run from stage 2 with this correction');
    await o.stop();
  });

  it('records the reversal and leaves the round it reopens exactly as it was', async () => {
    const o = orch();
    await ready(o);
    const before = historyOnDisk();

    await o.reopenGate(OPEN, 'A', 'the org filter is sysadmin-only, not any admin');
    await waitFor('the worker to be resumed', () => gotResume());
    await o.poll();

    const reopenings = row(o, OPEN).reopenings;
    expect(reopenings).toHaveLength(1);
    expect(reopenings[0]!.gate).toBe('A');
    expect(reopenings[0]!.message).toBe('the org filter is sysadmin-only, not any admin');
    expect(reopenings[0]!.stage).toBe(1);
    expect(reopenings[0]!.round).toBe(1); // it takes back the one recorded round
    expect(Date.parse(reopenings[0]!.at)).toBeGreaterThan(0);

    // Append-only: nothing in the gate history is deleted, edited or re-decided.
    expect(historyOnDisk()).toEqual(before);
    expect(row(o, OPEN).history.find((h) => h.gate === 'A')!.decision).toBe('Gate A approved, proceed.');
    await o.stop();
  });

  it('is recorded as feedback — a reversal never writes an approval', async () => {
    // A reopen reached `resume` with no `decision`, which defaults to
    // `'approved'`, and `#recordDecision` writes against the gate the worker is
    // PARKED at. So taking gate A back while it waited at gate C wrote "gate C
    // approved" — the reversal and an approval of the same work, one line apart.
    // decisions.ts: "`feedback` never counts: sending work back is not passing a
    // gate." `reopenings` still holds which gate they took back; this is the kind.
    const o = orch();
    parkedAtGateC();
    await ready(o);

    await o.reopenGate(OPEN, 'A', 'the org filter is sysadmin-only, not any admin');
    await waitFor('the reopen to be recorded', () => ledger().length > 0);

    expect(ledger()).toHaveLength(1);
    expect(ledger()[0]!.decision).toBe('feedback');
    expect(ledger().filter((d) => d.decision === 'approved')).toEqual([]);
    // The reversal itself is unchanged, and still names the gate they took back.
    await o.poll();
    expect(row(o, OPEN).reopenings.map((r) => r.gate)).toEqual(['A']);
    await o.stop();
  });

  it('keeps every reversal, so reopening twice reads as two reversals', async () => {
    const o = orch();
    await ready(o);

    // Both return values are ASSERTED, not discarded. `reopenGate` refuses in
    // words — "#N is running — stop it first", "gate C was never passed" — and a
    // discarded refusal shows up only as a missing element in the array below,
    // which reads as a data bug and is not one. This turns the next occurrence
    // into a diagnosis.
    const first = await o.reopenGate(OPEN, 'A', 'first correction');
    expect(first.message).toContain('gate A reopened');
    await waitFor('the first resume', () => gotResume());
    await waitFor('the first run to end', () => row(o, OPEN).live === null && runFinished(OPEN));
    const second = await o.reopenGate(OPEN, 'C', 'second correction');
    expect(second.message).toContain('gate C reopened');
    await o.poll();

    expect(row(o, OPEN).reopenings.map((r) => [r.gate, r.message])).toEqual([
      ['A', 'first correction'],
      ['C', 'second correction'],
    ]);
    await o.stop();
  });

  it('survives a console restart — a reversal is a fact, not a memory', async () => {
    const first = orch();
    await ready(first);
    await first.reopenGate(OPEN, 'A', 'the org filter is sysadmin-only, not any admin');
    await waitFor('the worker to be resumed', () => gotResume());
    await first.stop();

    const second = orch();
    await second.start();
    expect(row(second, OPEN).reopenings).toHaveLength(1);
    expect(row(second, OPEN).reopenings[0]!.message).toBe('the org filter is sysadmin-only, not any admin');
    await second.stop();
  });
});

describe('reopening a gate while every slot is busy', () => {
  it('is taken and queued, never refused, and the row says queued', async () => {
    const o = orch();
    await deskFull(o);

    const out = await o.reopenGate(OPEN, 'A', 'the org filter is sysadmin-only, not any admin');

    expect(out.ok).toBe(true);
    expect(out.message).toContain('gate A reopened');
    expect(out.message).toContain('queued');
    expect(heldMessage()).toBe(
      'Reopening gate A. What changed: the org filter is sysadmin-only, not any admin. ' +
        'Re-run from stage 1 with this correction, and tell me what you are redoing before you redo it.',
    );
    expect(o.state().queue).toContain(OPEN);
    expect(row(o, OPEN).status).toBe('queued');
    // Written down before anything else, so it is already recorded.
    expect(row(o, OPEN).reopenings).toHaveLength(1);
    await o.stop();
  });

  it('resumes with exactly that message when a slot frees', async () => {
    const o = orch();
    await deskFull(o);
    await o.reopenGate(OPEN, 'C', 'my QA missed the empty state');

    freeTheSlot();

    await waitFor('the held reopen to be delivered', () => gotResume());
    expect(resumedText()).toContain(
      'resumed with: Reopening gate C. What changed: my QA missed the empty state. ' +
        'Re-run from stage 5 with this correction, and tell me what you are redoing before you redo it.',
    );
    await waitFor('the held message to be consumed', () => heldMessage() === undefined);
    await o.stop();
  });
});

describe('reopening a gate — what it refuses, and why in plain words', () => {
  it('refuses a letter that is not a gate', async () => {
    const o = orch();
    await ready(o);
    const out = await o.reopenGate(OPEN, 'F', 'something changed');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('is not a gate');
    expect(out.message).toContain('A, B, C, D, E');
    expect(gotResume()).toBe(false);
    await o.stop();
  });

  it('refuses a gate that has never been passed — there is no decision to take back', async () => {
    const o = orch();
    await ready(o);
    const out = await o.reopenGate(OPEN, 'E', 'we should not merge yet');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('has not passed gate E');
    expect(out.message).toContain('Passed so far: A, B, C');
    expect(row(o, OPEN).reopenings).toEqual([]);
    expect(gotResume()).toBe(false);
    await o.stop();
  });

  it('refuses an empty correction — a reopen that says nothing tells the worker nothing', async () => {
    const o = orch();
    await ready(o);
    for (const empty of ['', '   ', '\n\t ']) {
      const out = await o.reopenGate(OPEN, 'A', empty);
      expect(out.ok).toBe(false);
      expect(out.message).toContain('what changed');
    }
    expect(row(o, OPEN).reopenings).toEqual([]);
    expect(gotResume()).toBe(false);
    await o.stop();
  });

  it('refuses an issue with no session — there is no worker to send back', async () => {
    const o = orch();
    pastGates(); // gates passed, but no transcript anywhere
    await o.start();

    const out = await o.reopenGate(OPEN, 'A', 'the org filter is sysadmin-only');

    expect(out.ok).toBe(false);
    expect(out.message).toContain('No session id');
    expect(row(o, OPEN).reopenings).toEqual([]);
    await o.stop();
  });

  it('refuses an issue with no worktree at all', async () => {
    const o = orch();
    await ready(o);
    const out = await o.reopenGate(9999, 'A', 'anything');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('no worktree');
    await o.stop();
  });

  it('refuses while a worker is running — the resume would be refused anyway', async () => {
    const o = orch();
    await deskFull(o);
    const out = await o.reopenGate(BUSY, 'A', 'something changed');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('is running');
    await o.stop();
  });
});

/**
 * The gap the gate card's queued state left behind: it was the ONLY card that
 * knew about being answered at capacity. A rework brief or a drafted-comment row
 * answered while the desk was full was accepted and queued too, but the row went
 * on saying it was waiting on the operator — so the card stayed actionable and pressing it
 * again only replaced the answer already promised.
 */
describe('every card, not just the gate, goes quiet once it is answered', () => {
  it('an issue with a drafted comment reads queued once an answer is taken at capacity', async () => {
    const o = orch();
    await deskFull(o);
    writeFileSync(
      join(tree, '.comment-request.json'),
      JSON.stringify({
        issue: OPEN,
        addressee: '@teammate-one',
        why: 'which environment?',
        draftBody: 'Which environment should this go to?',
        sessionId: SESSION,
      }),
    );
    await o.poll();
    expect(row(o, OPEN).status).toBe('awaiting-post'); // it IS asking, before the answer

    const out = await o.resume(OPEN, 'Answered in Slack — dev only.');

    expect(out.ok).toBe(true);
    expect(row(o, OPEN).status).toBe('queued');
    expect(row(o, OPEN).commentRequest).not.toBeNull(); // the file is still there
    await o.stop();
  });

  it('a reopened gate on that same issue reads queued too, not awaiting-post', async () => {
    const o = orch();
    await deskFull(o);
    writeFileSync(
      join(tree, '.comment-request.json'),
      JSON.stringify({ issue: OPEN, addressee: '@teammate-one', why: 'x', draftBody: 'y', sessionId: SESSION }),
    );
    await o.poll();

    await o.reopenGate(OPEN, 'A', 'the org filter is sysadmin-only');

    expect(row(o, OPEN).status).toBe('queued');
    // Position first, and no longer only the position: the detail now carries
    // how long it has waited. Matched on the prefix so the clock cannot flake it.
    expect(row(o, OPEN).statusDetail).toMatch(/^next up\b/);
    await o.stop();
  });
});
