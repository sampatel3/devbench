/**
 * ASKING A QUESTION AT A GATE, WITHOUT DECIDING IT.
 *
 * The operator asked for this: at a comprehension gate they need to ask questions
 * and get answers back before deciding, and the interface is too simple for that.
 * Today a gate has two buttons and both of them END it.
 *
 * So this is a third act with a hard rule attached: it must carry NONE of the
 * side effects of a decision. It does not clear the blocked-on-reply record, it
 * does not stamp a rework round as started, and it must come back to the same
 * gate. Everything below asserts that against real spawned workers, a real state
 * file and a real queue — the assertion that matters most, as ever, is what the
 * child process actually received.
 *
 * `probeResources` is stubbed in every test: nothing here reads or restarts
 * anything on the operator's actual machine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Orchestrator } from '../src/orchestrator.js';
import { createServer, listen } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import { waitingOnAPerson } from '../src/summary.js';
import type { GateThreadRecord } from '../src/ask.js';
import type { ResourceReport } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const BUSY = 4336; // holds the only slot
const GATE = 4344; // parked at gate C, and asked a question

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let repo: string;
let busyTree: string;
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

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-ask-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  busyTree = join(repo, '.worktrees', `issue-${BUSY}-demo`);
  gateTree = join(repo, '.worktrees', `issue-${GATE}-demo`);
  git(['worktree', 'add', '-b', `fix/issue-${BUSY}-demo`, busyTree, 'dev'], repo);
  git(['worktree', 'add', '-b', `fix/issue-${GATE}-demo`, gateTree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: BUSY, title: 'Org sysadmin filter pills', url: 'u', labels: ['P1'], updatedAt: 'z', author: 'operator' },
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
  // FIRST and unconditionally: these are real detached processes and a failed
  // assertion never reaches the rest of this function.
  killSpawnedWorkers(stateFile);
  delete process.env.STUB_WAIT_FOR;
  delete process.env.STUB_REPARK;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

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
const thread = (o: Orchestrator, n = GATE): GateThreadRecord | null => row(o, n).gateThread;

type State = {
  pendingResume?: Record<string, string>;
  gateThreads?: Record<string, GateThreadRecord>;
  commentBlocks?: Record<string, unknown>;
  reviewBlocks?: Record<string, { rounds: Array<{ decision: string | null; resolvedBy?: string | null }> }>;
  runningRuns?: Record<string, { ask: { gate: string; ids: number[] } | null }>;
};
const persisted = (): State => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8')) as State;
  } catch {
    return {};
  }
};
const heldMessage = () => persisted().pendingResume?.[String(GATE)];

/** What the child actually received. Waits on CONTENT, never on the file existing. */
const resumedText = (): string => {
  try {
    return readFileSync(join(gateTree, 'resumed.txt'), 'utf8');
  } catch {
    return '';
  }
};

/** A worker parked at gate C, exactly as one leaves it — click-script included. */
function parkAtGate(gate = 'C', sessionId: string | null = SESSION) {
  writeFileSync(
    join(gateTree, '.gate.json'),
    JSON.stringify({
      issue: GATE,
      gate,
      stage: 5,
      sessionId,
      stoppedAt: new Date().toISOString(),
      reportPath: null,
      summary: 'Your QA, please.',
      questions: ['Does the click-script pass?'],
      manualQa: {
        appUrl: 'http://localhost:8106',
        login: { email: 'sysadmin@localdev.test', password: 'localdev123!' },
        steps: [{ do: 'Open Organisations', url: 'http://localhost:8106/organisations', expected: 'pills gone' }],
      },
    }),
  );
}

/** Fill the only slot with a worker that will not finish until it is told to. */
async function deskFull(o: Orchestrator): Promise<void> {
  process.env.STUB_WAIT_FOR = goFile;
  await o.start();
  o.enqueue(BUSY);
  await waitFor('the first worker to be running', () => row(o, BUSY).status === 'active');
  delete process.env.STUB_WAIT_FOR;
  parkAtGate();
  await o.poll();
  expect(row(o, GATE).status).toBe('at-gate');
}

const freeTheSlot = () => writeFileSync(goFile, 'go');

describe('a question asked when a slot is free', () => {
  it('goes to the worker as a QUESTION, not as a decision', async () => {
    process.env.STUB_REPARK = 'C';
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();

    const out = await o.ask(GATE, 'What does a non-sysadmin actually see now?');

    expect(out.ok).toBe(true);
    expect(out.message).toContain('gate C');
    await waitFor('the worker to be asked', () => resumedText().includes('QUESTION'));
    const sent = resumedText();
    expect(sent).toContain('GATE C QUESTION — NOT A DECISION');
    expect(sent).toContain('What does a non-sysadmin actually see now?');
    expect(sent).not.toContain('approved');
    await o.stop();
  });

  it('carries NONE of a decision side effects — no comment block cleared, no rework round stamped', async () => {
    // Seeded through the state file rather than through the console, because the
    // only thing that writes a comment block is a real GitHub post.
    writeFileSync(
      stateFile,
      JSON.stringify({
        commentBlocks: {
          [String(GATE)]: { addressee: '@platform', postedAt: 'z', commentUrl: null, reply: null },
        },
        reviewBlocks: {
          [String(GATE)]: {
            pr: 7,
            rounds: [{ round: 1, reviewer: 'copilot', requestedAt: 'z', requestedChanges: 'fix it', decision: null, resumedAt: null }],
          },
        },
      }),
    );
    process.env.STUB_REPARK = 'C';
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();

    await o.ask(GATE, 'Which table does the role come from?');
    await waitFor('the worker to be asked', () => resumedText().includes('QUESTION'));

    const after = persisted();
    expect(after.commentBlocks?.[String(GATE)]).toBeDefined(); // still blocked on that reply
    expect(after.reviewBlocks?.[String(GATE)]?.rounds[0]?.decision).toBeNull(); // rework NOT started
    expect(after.reviewBlocks?.[String(GATE)]?.rounds[0]?.resolvedBy ?? null).toBeNull();
    await o.stop();
  });

  it('writes the question down before anything runs, so the thread is on the card at once', async () => {
    process.env.STUB_REPARK = 'C';
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();

    await o.ask(GATE, 'Why is the flag named that?');

    const rec = thread(o)!;
    expect(rec.gate).toBe('C');
    expect(rec.entries).toHaveLength(1);
    expect(rec.entries[0]!.question).toBe('Why is the flag named that?');
    expect(rec.entries[0]!.answer).toBeNull();
    expect(persisted().gateThreads?.[String(GATE)]?.entries).toHaveLength(1);
    await o.stop();
  });

  it('exposes the structured click-script on the row — real, clickable links', async () => {
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();

    const qa = row(o, GATE).gateManualQa!;
    expect(qa.appUrl).toBe('http://localhost:8106');
    expect(qa.login?.password).toBe('localdev123!');
    expect(qa.steps[0]!.url).toBe('http://localhost:8106/organisations');
    await o.stop();
  });
});

describe('a question asked while every slot is busy', () => {
  it('is held, queued and written down — exactly like a decision is', async () => {
    const o = orch();
    await deskFull(o);

    const out = await o.ask(GATE, 'What breaks if I say no?');

    expect(out.ok).toBe(true);
    expect(heldMessage()).toContain('GATE C QUESTION — NOT A DECISION');
    expect(heldMessage()).toContain('What breaks if I say no?');
    expect(o.state().queue).toContain(GATE);
    expect(thread(o)!.pendingAskIds).toEqual([1]);
    await o.stop();
  });

  it('survives the console being restarted underneath it, question and all', async () => {
    const first = orch();
    await deskFull(first);
    await first.ask(GATE, 'What breaks if I say no?');
    await first.stop();

    // Nothing but the state file crosses this line.
    const second = orch();
    await second.start();
    expect(second.state().queue).toContain(GATE);
    expect(thread(second)!.entries[0]!.question).toBe('What breaks if I say no?');
    expect(thread(second)!.pendingAskIds).toEqual([1]);
    expect(heldMessage()).toContain('What breaks if I say no?');
    await second.stop();
  });

  it('puts a SECOND question in the same held message rather than replacing the first', async () => {
    const o = orch();
    await deskFull(o);

    await o.ask(GATE, 'first question');
    await o.ask(GATE, 'second question');

    // The held prompt is recomposed from the whole thread, so the "newest
    // replaces oldest" rule that holds for decisions cannot lose a question.
    const held = heldMessage()!;
    expect(held).toContain('1. first question');
    expect(held).toContain('2. second question');
    expect(thread(o)!.entries).toHaveLength(2);
    expect(thread(o)!.pendingAskIds).toEqual([1, 2]);
    expect(o.state().queue.filter((n) => n === GATE)).toHaveLength(1);
    await o.stop();
  });

  it('is delivered as a QUESTION when a slot frees — never through the decision path', async () => {
    process.env.STUB_REPARK = 'C';
    const o = orch();
    await deskFull(o);
    writeFileSync(
      join(gateTree, '.comment-request.json'),
      JSON.stringify({ addressee: '@platform', body: 'x', sessionId: SESSION }),
    );
    await o.ask(GATE, 'held then delivered');

    freeTheSlot();

    await waitFor('the held question to be delivered', () => resumedText().includes('held then delivered'));
    expect(resumedText()).toContain('GATE C QUESTION — NOT A DECISION');
    await waitFor('the held question to be consumed', () => heldMessage() === undefined);
    // Delivery is not a decision either: nothing in the dispatch path may stamp one.
    expect(persisted().commentBlocks?.[String(GATE)]).toBeUndefined();
    await o.stop();
  });

  it('replaces a queued DECISION and says so out loud — an approval must never vanish quietly', async () => {
    const o = orch();
    await deskFull(o);
    await o.resume(GATE, 'Gate C approved, proceed.');

    const out = await o.ask(GATE, 'actually, hold on — which table is this?');

    // The newest thing the operator sent is the one that runs, exactly as it is for two
    // decisions. What must not happen is the approval disappearing in silence.
    expect(out.ok).toBe(true);
    expect(out.message).toContain('replaces the answer you had queued');
    expect(heldMessage()).toContain('GATE C QUESTION');
    expect(heldMessage()).not.toContain('approved');
    // And the gate is genuinely open again: the thread must not still be closed
    // by the decision that was just replaced, or it would be retired underneath
    // the question with the question still in it.
    expect(thread(o)!.closedAt).toBeNull();
    expect(thread(o)!.entries.at(-1)!.supersededAt).toBeNull();
    await o.stop();
  });

  it('starts a fresh thread when the open gate is no longer the one that was asked at', async () => {
    const o = orch();
    await deskFull(o);
    await o.ask(GATE, 'a question about gate C');
    // The worker moved on. Whatever the old thread was, a question asked now is
    // a question about gate D, and it must not be recorded against gate C.
    parkAtGate('D');
    await o.poll();

    await o.ask(GATE, 'a question about gate D');

    const rec = thread(o)!;
    expect(rec.gate).toBe('D');
    expect(rec.entries).toHaveLength(1);
    expect(rec.entries[0]!.question).toBe('a question about gate D');
    expect(heldMessage()).toContain('GATE D QUESTION — NOT A DECISION');
    await o.stop();
  });

  it('says out loud that the undelivered question about the OLD gate went with it', async () => {
    // Dropping it is right — it was a question about a gate that is over. Doing
    // it in silence is not: a question of the operator's that vanishes without a word is
    // exactly the failure this module exists to prevent, and the "this replaces
    // what you had queued" line only ever covered the decision case.
    const o = orch();
    await deskFull(o);
    await o.ask(GATE, 'a question about gate C');
    parkAtGate('D');
    await o.poll();

    const out = await o.ask(GATE, 'a question about gate D');

    expect(out.message).toContain('undelivered question about gate C is dropped');
    await o.stop();
  });

  it('delivers a held question as a question even if the gate letter changed under it', async () => {
    // The thread is what tells dispatch a held message is a QUESTION. If it can
    // be retired while a question is still in flight, the question goes out
    // through the decision path — clearing a comment block the operator is still waiting
    // on. So a thread with a question pending delivery is never retired.
    process.env.STUB_REPARK = 'C';
    writeFileSync(
      stateFile,
      JSON.stringify({
        commentBlocks: { [String(GATE)]: { addressee: '@platform', postedAt: 'z', commentUrl: null, reply: null } },
      }),
    );
    const o = orch();
    await deskFull(o);
    await o.ask(GATE, 'held while everything moved');
    parkAtGate('D'); // the gate file changes underneath the held question
    await o.poll();

    expect(thread(o)?.pendingAskIds ?? []).toEqual([1]);
    freeTheSlot();
    await waitFor('the held question to be delivered', () => resumedText().includes('held while everything moved'));
    expect(persisted().commentBlocks?.[String(GATE)]).toBeDefined(); // NOT the decision path
    await o.stop();
  });

  it('is replaced by a decision, and the question says so rather than vanishing', async () => {
    const o = orch();
    await deskFull(o);
    await o.ask(GATE, 'a question that never gets answered');

    const out = await o.resume(GATE, 'Gate C approved, proceed.');

    expect(out.ok).toBe(true);
    expect(heldMessage()).toBe('Gate C approved, proceed.');
    const rec = thread(o)!;
    expect(rec.entries[0]!.supersededAt).not.toBeNull();
    expect(rec.pendingAskIds).toEqual([]);
    await o.stop();
  });
});

describe('a question asked while the worker is mid-answer', () => {
  it('waits for it to stop, and dispatch never feeds it to the worker that is running', async () => {
    // Two slots: the bug this guards against needs a FREE slot while the issue
    // itself is running. Dispatch would then pick it, `resume` would refuse it
    // with "already running", and the held-answer error path would delete the
    // question and tell the operator it could not be sent — a silently lost question.
    process.env.STUB_REPARK = 'C';
    const o = orch({ MAX_ACTIVE: '2' });
    await o.start();
    parkAtGate();
    await o.poll();

    process.env.STUB_WAIT_FOR = goFile;
    await o.ask(GATE, 'the first question');
    await waitFor('the answering run to start', () => row(o, GATE).live !== null);
    delete process.env.STUB_WAIT_FOR;

    const out = await o.ask(GATE, 'the follow-up, asked mid-answer');
    expect(out.ok).toBe(true);
    expect(out.message).toContain('mid-answer');

    // Dispatch runs on every poll and on every resource tick. None of them may
    // consume this question into the worker that is already running.
    await o.poll();
    await o.poll();
    expect(heldMessage()).toContain('the follow-up, asked mid-answer');
    expect(row(o, GATE).lastError).toBeNull();

    freeTheSlot();
    await waitFor('the follow-up to be delivered', () => resumedText().includes('the follow-up, asked mid-answer'));
    await o.stop();
  });
});

describe('a question asked at capacity still says the gate is waiting on the operator', () => {
  it('keeps the row AT-GATE — an ask decides nothing, so the ball never left their court', async () => {
    // `pendingResume` holds decisions AND questions, and the row read "answered,
    // only waiting for a slot" for both. For a question that is
    // simply untrue: nothing has been decided, the gate is exactly as open as it
    // was, and the operator is exactly as much on the hook. The row dropped out of
    // "waiting on you", the AT GATE chip went, and the card was replaced by the
    // answered one — so Approve and Feedback were unreachable until a slot freed.
    const o = orch();
    await deskFull(o);

    await o.ask(GATE, 'what does a non-sysadmin actually see now?');

    expect(row(o, GATE).status).toBe('at-gate');
    expect(row(o, GATE).gate?.gate).toBe('C');
    // The dashboard's "waiting on a person" list is built from the same rows, so
    // this is the assertion that the gate did not fall off the operator's desk.
    expect(waitingOnAPerson(o.state().issues, []).some((w) => w.number === GATE)).toBe(true);
    await o.stop();
  });

  it('DOES read as answered once a decision replaces the question', async () => {
    const o = orch();
    await deskFull(o);
    await o.ask(GATE, 'a question');

    await o.resume(GATE, 'Gate C approved, proceed.');

    expect(row(o, GATE).status).toBe('queued');
    await o.stop();
  });
});

describe('a decision taken while the desk is full', () => {
  it('does NOT let the next poll delete the whole question thread', async () => {
    // `resume` supersedes the open questions BEFORE it finds out whether it can
    // run, so at capacity the thread was stamped closed and then parked. The
    // worker, though, is still sitting at the same gate with the same gate file
    // on disk — so the next poll read "a decision went out and the worker moved
    // on" and dropped the record. The operator's question, the worker's answer and the
    // "superseded before it was answered" stamp all vanished before the decision
    // had even been delivered.
    const o = orch();
    await deskFull(o);
    await o.ask(GATE, 'a question that never gets answered');

    await o.resume(GATE, 'Gate C approved, proceed.');
    await o.poll();

    const rec = thread(o);
    expect(rec, 'the thread must outlive a decision that has not been delivered yet').not.toBeNull();
    expect(rec!.entries[0]!.question).toBe('a question that never gets answered');
    expect(rec!.entries[0]!.supersededAt).not.toBeNull();
    expect(heldMessage()).toBe('Gate C approved, proceed.');
    await o.stop();
  });
});

describe('two questions arriving in the same tick', () => {
  it('spawns ONE worker and leaves its re-attachment row intact', async () => {
    // `isRunning` does not become true until well after `ask` has passed its own
    // check — across a save, a `git rev-parse` and an unlink — so two clicks in
    // the same tick both passed every guard and both spawned. The runner refused
    // the loser, but the refusal was reported as an ordinary FAILED RUN and went
    // through the full ending path: it deleted `runningRuns`, which is the only
    // thing a console restart re-attaches from, and took the live worker's
    // record that it was answering a question with it.
    process.env.STUB_REPARK = 'C';
    process.env.STUB_WAIT_FOR = goFile;
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();

    await Promise.all([o.ask(GATE, 'first question'), o.ask(GATE, 'second question')]);
    await waitFor('a worker to be running', () => row(o, GATE).live !== null);

    const running = persisted().runningRuns ?? {};
    expect(Object.keys(running), 'the live worker must still have its re-attachment row').toContain(String(GATE));
    expect(running[String(GATE)]!.ask, 'and that row must still say it is answering a question').not.toBeNull();
    expect(row(o, GATE).lastError).toBeNull();

    // And the question that lost the race is not lost with it: the second ask
    // sees a busy worker and takes the ordinary "held until it stops" path, so
    // both questions are still on the card and the second is queued for delivery.
    const rec = thread(o)!;
    expect(rec.entries.map((e) => e.question)).toEqual(['first question', 'second question']);
    expect(rec.pendingAskIds).toContain(2);
    expect(heldMessage()).toContain('second question');

    freeTheSlot();
    await o.stop();
  });

  it('survives a worker binary that cannot launch, and says so on the card', async () => {
    // The other half of the same worry: an ask whose worker never launches.
    //
    // First, the console has to still BE HERE. `spawn` reports an unresolvable
    // binary asynchronously on the child emitter, and the listener used to be
    // registered after the early return for "no pid" — so the unhandled 'error'
    // event killed the console outright. A missing `claude` is the likeliest
    // thing to be wrong on a fresh machine.
    //
    // Then: it is a real ending, so it keeps the full ending treatment. The
    // error lands on the row, where FailureNote renders it, and the question
    // stays on the card unanswered rather than being quietly marked delivered.
    const o = orch({ CLAUDE_BIN: join(here, 'fixtures', 'no-such-worker.mjs') });
    await o.start();
    parkAtGate();
    await o.poll();

    await o.ask(GATE, 'a question the worker never receives');
    await waitFor('the failed ask to be recorded', () => row(o, GATE).lastError !== null);

    expect(row(o, GATE).lastError).toContain('could not start');
    expect(thread(o)!.entries[0]!.question).toBe('a question the worker never receives');
    expect(thread(o)!.entries[0]!.answer).toBeNull();
    expect(thread(o)!.violation).toBeNull(); // a launch failure is not disobedience
    // The issue is free to be asked again — the failed spawn left no claim on it.
    expect(row(o, GATE).status).not.toBe('active');
    await o.stop();
  });
});

describe('refusals', () => {
  it('refuses when there is no open gate to ask at', async () => {
    const o = orch();
    await o.start();
    await o.poll();

    const out = await o.ask(GATE, 'anything?');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('no open gate');
    await o.stop();
  });

  it('refuses when there is no worktree', async () => {
    const o = orch();
    await o.start();
    const out = await o.ask(99999, 'anything?');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('no worktree');
    await o.stop();
  });

  it('refuses when the gate names no session to resume', async () => {
    const o = orch();
    await o.start();
    parkAtGate('C', null);
    await o.poll();

    const out = await o.ask(GATE, 'anything?');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('No session id');
    await o.stop();
  });

  it('refuses an empty question at the route, rather than sending an empty one', async () => {
    const cfg = loadConfig({
      PORT: '0',
      REPO: 'example-org/example-repo',
      REPO_PATH: repo,
      STATE_FILE: stateFile,
      RUNS_FILE: runsFile,
      ACCOUNTS_FILE: accountsFile,
      STREAM_DIR: streamDir,
      CANONICAL_CLAUDE_DIR: canonical,
      CLAUDE_BIN: STUB,
      POLL_MS: '999999',
    });
    const o = new Orchestrator(cfg);
    await o.poll();
    let server: Server | null = null;
    try {
      server = await listen(createServer(cfg, o), cfg);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(`${base}/api/issues/${GATE}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '   ' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain('words');
    } finally {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      await o.stop();
    }
  });
});
