import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { sessionDir } from '../src/worker.js';
import { parseGateHistory } from '../src/history.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import { approvePrompt, askForQuizPrompt } from '../../ui/src/gate.js';
import type { GateHistoryRecord, ResourceReport } from '../src/types.js';

/**
 * THE ROUND IS WRITTEN DOWN BY WHOEVER WAS THERE.
 *
 * The console unlinks `.gate.json` before it resumes, so the worker's own
 * history line is written from memory — 109 of 126 recorded gate C rounds (87%)
 * came back with no `manualQa` and no `evidence`, and 135 of those lines say so
 * in prose: "RECONSTRUCTED: console consumed the gate file". What is asserted
 * here is the FILE ON DISK in the worktree, because that is the audit trail; the
 * row is checked afterwards to prove the console reads back what it wrote.
 */

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const OPEN = 4344;
const BUSY = 4336; // holds the only slot, so a decision has to be parked
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const STOPPED = '2026-09-01T09:00:00.000Z';

let repo: string;
let tree: string;
let busyTree: string;
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

/**
 * A gate C stop with everything the card renders on it: the captures, the
 * click-script the operator ticks, and the quiz they answer. All three are what
 * the reconstruction loses.
 */
function parkedAtGateC(stoppedAt = STOPPED): void {
  writeFileSync(
    join(tree, '.gate.json'),
    JSON.stringify({
      issue: OPEN,
      gate: 'C',
      stage: 5,
      sessionId: SESSION,
      stoppedAt,
      reportPath: 'docs/issue-pipeline/plans/issue-4344-report.md',
      summary: 'Did: drove the app on 8106.',
      questions: [],
      evidence: [
        { kind: 'screenshot', path: 'docs/issue-pipeline/plans/qa-4344/s1-after.png', caption: 'the new empty state' },
      ],
      thread: [{ id: 1, q: 'which table does the role come from?', a: 'org_members', at: '2026-09-01T08:50:00.000Z' }],
      manualQa: {
        appUrl: 'http://localhost:8106',
        start: 'a quote in Sent',
        steps: [
          {
            id: 1,
            rev: 2,
            do: 'Withdraw with an empty reason',
            before: 'the modal accepted it',
            beforeShot: 'docs/issue-pipeline/plans/qa-4344/s1-before.png',
            after: 'Confirm stays disabled',
            afterShot: 'docs/issue-pipeline/plans/qa-4344/s1-after.png',
            fix: 'disabled Confirm until a reason is typed',
          },
        ],
      },
      quiz: {
        brief: ['Withdraw asks for a reason first'],
        questions: [
          {
            question: 'What happens on an empty reason?',
            options: [
              { text: 'Confirm stays disabled', why: 'A reason is now required.' },
              { text: 'It withdraws anyway', why: 'That was the bug.' },
            ],
            correct: 0,
          },
        ],
      },
    }),
  );
}

/** A gate D stop — #5402's own gate, and the plain card's approve box. */
function parkedAtGateD(): void {
  writeFileSync(
    join(tree, '.gate.json'),
    JSON.stringify({
      issue: OPEN,
      gate: 'D',
      stage: 6,
      sessionId: SESSION,
      stoppedAt: STOPPED,
      reportPath: null,
      summary: 'Ready to raise the PR.',
      questions: [],
    }),
  );
}

/** A transcript on disk, which is how the console finds a resumable session. */
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

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-gate-history-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  tree = join(repo, '.worktrees', `issue-${OPEN}-demo`);
  busyTree = join(repo, '.worktrees', `issue-${BUSY}-demo`);
  git(['worktree', 'add', '-b', `fix/issue-${OPEN}-demo`, tree, 'dev'], repo);
  git(['worktree', 'add', '-b', `fix/issue-${BUSY}-demo`, busyTree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: OPEN, title: 'Save and Exit', url: 'u', labels: ['P2'], updatedAt: 'z', author: 'operator' },
    { number: BUSY, title: 'Org sysadmin filter pills', url: 'u', labels: ['P1'], updatedAt: 'z', author: 'operator' },
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

const row = (o: Orchestrator, n: number) => o.state().issues.find((r) => r.number === n)!;

const historyRaw = (): string => {
  try {
    return readFileSync(join(tree, '.gate-history.jsonl'), 'utf8');
  } catch {
    return '';
  }
};

const historyOnDisk = (): GateHistoryRecord[] =>
  historyRaw()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GateHistoryRecord);

/** The console's own ledger, beside `state.json`. */
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

const gotResume = (): boolean => {
  try {
    return readFileSync(join(tree, 'resumed.txt'), 'utf8').includes('resumed with:');
  } catch {
    return false;
  }
};

describe('the console writes the round it is about to destroy', () => {
  it('appends the whole decided gate C round — evidence, click-script and quiz', async () => {
    const o = orch();
    parkedAtGateC();
    sessionOnDisk(tree);
    await o.start();

    const said = 'Gate C approved — I ran the manual QA myself, step by step. Proceed.';
    expect((await o.resume(OPEN, said)).ok).toBe(true);
    await waitFor('the worker to be resumed', () => gotResume());

    const rounds = historyOnDisk();
    expect(rounds).toHaveLength(1);
    const round = rounds[0]!;
    // The gate object, as the worker wrote it.
    expect(round.gate).toBe('C');
    expect(round.issue).toBe(OPEN);
    expect(round.stoppedAt).toBe(STOPPED);
    expect(round.summary).toBe('Did: drove the app on 8106.');
    // The three things the reconstruction loses.
    expect(round.evidence.map((e) => e.path)).toEqual(['docs/issue-pipeline/plans/qa-4344/s1-after.png']);
    expect(round.manualQa!.steps[0]!.fix).toBe('disabled Confirm until a reason is typed');
    expect(round.manualQa!.steps[0]!.rev).toBe(2);
    expect(round.quiz!.questions[0]!.correct).toBe(0);
    expect(round.thread[0]!.a).toBe('org_members');
    // Their exact words, and no invented resume time: the console records the
    // DECISION, and the resume it is about to attempt may still be refused.
    expect(round.decision).toBe(said);
    expect(round.resumedAt).toBeNull();
    // Nothing has stamped an account on this worktree — the console adopted a
    // session it never spawned — and history.ts's rule is that the account is
    // never guessed after the fact. Null is the honest answer, not 'personal'.
    expect(round.account).toBeNull();
    await o.stop();
  });

  it('writes ONE line, appended, and never rewrites what is already there', async () => {
    const o = orch();
    parkedAtGateC();
    sessionOnDisk(tree);
    // A round the worker recorded before this console existed. It must survive
    // untouched: the write is an append, not an edit of the file.
    const older = JSON.stringify({
      issue: OPEN,
      gate: 'B',
      stage: 2,
      sessionId: SESSION,
      stoppedAt: '2026-08-30T09:00:00.000Z',
      summary: 'The plan.',
      questions: [],
      decision: 'Gate B approved, proceed.',
      resumedAt: '2026-08-30T09:05:00.000Z',
    });
    writeFileSync(join(tree, '.gate-history.jsonl'), `${older}\n`);
    await o.start();

    await o.resume(OPEN, 'Gate C approved, proceed.');
    await waitFor('the worker to be resumed', () => gotResume());

    const lines = historyRaw().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(older); // byte for byte
    expect(historyRaw().endsWith('\n')).toBe(true);
    await o.stop();
  });

  it('records nothing at all when no gate is parked — a continue is not a decision', async () => {
    const o = orch();
    sessionOnDisk(tree);
    await o.start();

    await o.resume(OPEN, 'Continue.');
    await waitFor('the worker to be resumed', () => gotResume());

    expect(historyRaw()).toBe('');
    expect(ledger()).toEqual([]);
    await o.stop();
  });
});

/**
 * The worker still appends its own line for the round on its next resume, and
 * that line is the reconstruction. Two records of one stop must read as one
 * round — otherwise the spine counts the gate twice and `reopenGate` aims a
 * reversal at an exchange that never happened separately.
 */
describe('the worker`s later reconstruction of the same round', () => {
  it('does not double it — the console`s complete line is the one that stands', async () => {
    const o = orch();
    parkedAtGateC();
    sessionOnDisk(tree);
    await o.start();

    await o.resume(OPEN, 'Gate C approved, proceed.');
    await waitFor('the worker to be resumed', () => gotResume());

    // What a worker writes when the file it was told to copy is gone.
    appendFileSync(
      join(tree, '.gate-history.jsonl'),
      `${JSON.stringify({
        issue: OPEN,
        gate: 'C',
        stage: 5,
        sessionId: null,
        stoppedAt: STOPPED,
        summary: 'RECONSTRUCTED: console consumed the gate file',
        questions: [],
        decision: 'Gate C approved, proceed.',
        resumedAt: '2026-09-01T09:05:00.000Z',
      })}\n`,
    );

    // Both lines are on disk — nothing deletes a worker's record.
    expect(historyRaw().split('\n').filter(Boolean)).toHaveLength(2);
    // The reader sees one round, and it is the one with the QA on it.
    const rounds = parseGateHistory(historyRaw());
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.summary).toBe('Did: drove the app on 8106.');
    expect(rounds[0]!.manualQa!.steps).toHaveLength(1);

    // The round arrives on a poll, but not necessarily on THIS one. `poll` is
    // guarded against re-entry and `#track` fires its own the moment the worker
    // parks, so the call below can return `false` having read nothing at all —
    // leaving the row on the scan taken at `start()`, when this file did not
    // exist yet and its history was empty. That is the flake: `[]` where one
    // round was expected. Waiting for the round to land is the honest version of
    // the same assertion, and the count below still has to be exactly one. What
    // a dropped poll returns is pinned in `poll-cadence.test.ts`.
    await o.poll();
    await waitFor('the console to read the round back', () => row(o, OPEN).history.some((h) => h.gate === 'C'));
    expect(row(o, OPEN).history.filter((h) => h.gate === 'C')).toHaveLength(1);
    await o.stop();
  });

  it('keeps two genuine rounds of the same gate apart, because each has its own stop', () => {
    const round = (stoppedAt: string, summary: string) =>
      JSON.stringify({ issue: OPEN, gate: 'C', stoppedAt, summary, questions: [], decision: 'x' });
    const rounds = parseGateHistory(
      [round('2026-09-01T09:00:00.000Z', 'round one'), round('2026-09-01T11:00:00.000Z', 'round two')].join('\n'),
    );
    expect(rounds.map((r) => r.summary)).toEqual(['round one', 'round two']);
  });

  it('never collapses two rounds that carry no stop stamp — a lost round is worse than a doubled one', () => {
    const round = (summary: string) => JSON.stringify({ issue: OPEN, gate: 'C', summary, questions: [], decision: 'x' });
    expect(parseGateHistory([round('one'), round('two')].join('\n')).map((r) => r.summary)).toEqual(['one', 'two']);
  });
});

describe('which decision the ledger records', () => {
  it('writes a gate C nag as feedback — asking for the quiz is not passing the gate', async () => {
    const o = orch();
    parkedAtGateC();
    sessionOnDisk(tree);
    await o.start();

    // Exactly as the card sends it: `/resume` with no `decision`, which the
    // route defaults to `approved`. That default is why 110 send-backs are in
    // the ledger as approvals.
    expect((await o.resume(OPEN, askForQuizPrompt())).ok).toBe(true);
    await waitFor('the nag to be recorded', () => ledger().length > 0);

    expect(ledger()).toHaveLength(1);
    expect(ledger()[0]!.gate).toBe('C');
    expect(ledger()[0]!.decision).toBe('feedback');
    await o.poll();
    expect(row(o, OPEN).gatesPassed).not.toContain('C');
    await o.stop();
  });

  it('still writes a real approval as approved', async () => {
    const o = orch();
    parkedAtGateC();
    sessionOnDisk(tree);
    await o.start();

    await o.resume(OPEN, approvePrompt('C', 'the empty state reads well'));
    await waitFor('the approval to be recorded', () => ledger().length > 0);

    expect(ledger()[0]!.decision).toBe('approved');
    await o.stop();
  });

  /**
   * #5402: two questions typed into the approve box at gate D, both recorded as
   * approvals, so the ledger said the gate was passed twice while the worker was
   * off answering a question. The guard existed the whole time — it was reading
   * the composed message, whose first line is the page's own "Gate D approved,
   * proceed.", so it never once fired.
   */
  it('refuses a question typed into the approve box, and mints no approval', async () => {
    const o = orch();
    parkedAtGateD();
    sessionOnDisk(tree);
    await o.start();

    const asked =
      'can you confirm that the expected result is for the previous dev signature to appear as a broken image?';
    const out = await o.resume(OPEN, approvePrompt('D', asked));

    expect(out.ok).toBe(false);
    expect(out.message).toContain('gate D');
    expect(out.message).toContain('Ask');
    // Nothing was recorded anywhere, and nothing was sent.
    expect(ledger()).toEqual([]);
    expect(historyRaw()).toBe('');
    expect(gotResume()).toBe(false);
    await o.poll();
    expect(row(o, OPEN).gatesPassed).not.toContain('D');
    await o.stop();
  });

  it('lets an approval with a question attached through, as it always has', async () => {
    const o = orch();
    parkedAtGateD();
    sessionOnDisk(tree);
    await o.start();

    const out = await o.resume(OPEN, approvePrompt('D', 'Approved — but why did you do it that way?'));

    expect(out.ok).toBe(true);
    await waitFor('the approval to be recorded', () => ledger().length > 0);
    expect(ledger()[0]!.decision).toBe('approved');
    await o.stop();
  });

  /**
   * The capacity path is where a mislabelled kind used to survive its own fix: a
   * decision that waits for a slot is recorded at DISPATCH, from the mark parked
   * beside the words, not from the flag the caller passed. So the send-back has
   * to be read before it is parked, or a nag that only waited for a slot lands
   * in the ledger as an approval — the exact bug this class already carries a
   * comment about for held feedback.
   */
  it('a nag held for a free slot is still feedback when it finally runs', async () => {
    const o = orch();
    parkedAtGateC();
    sessionOnDisk(tree);
    sessionOnDisk(busyTree, 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee');
    process.env.STUB_WAIT_FOR = goFile;
    await o.start();
    o.enqueue(BUSY);
    await waitFor('the first worker to hold the slot', () => row(o, BUSY).status === 'active');
    delete process.env.STUB_WAIT_FOR; // read at spawn: everything after this runs straight through
    await o.poll();

    const out = await o.resume(OPEN, askForQuizPrompt());
    expect(out.ok).toBe(true);
    expect(out.message).toContain('queued');
    expect(ledger()).toEqual([]); // nothing is recorded until it actually runs

    writeFileSync(goFile, 'go'); // let the busy worker finish and free the slot
    await waitFor('the held nag to be dispatched and recorded', () => ledger().length > 0, 30_000);

    expect(ledger()[0]!.gate).toBe('C');
    expect(ledger()[0]!.decision).toBe('feedback');
    await o.stop();
  });
});
