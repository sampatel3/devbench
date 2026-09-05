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
import type { ResourceReport } from '../src/types.js';
import type { GhWriteExec } from '../src/comment.js';

/**
 * The bug this file exists for: the operator approved four gates, two of them ran, and
 * the other two silently did nothing. `resume()` met "at capacity: 2 of 2
 * active" and returned `ok: false` — a refusal that, at the far end of a click,
 * is indistinguishable from a dead button.
 *
 * The rule now: a decision a PERSON made is never dropped for want of a slot.
 * It is written to disk, the issue joins the queue, and the dispatch that finds
 * a free slot resumes with those exact words. Everything below asserts that
 * against real spawned workers and a real state file — the assertion that
 * matters most is what the resumed child actually received.
 */

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const BUSY = 4336; // holds the only slot
const HELD = 4344; // parked at a gate, and answered while the desk is full

let repo: string;
let busyTree: string;
let heldTree: string;
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

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-pending-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  busyTree = join(repo, '.worktrees', `issue-${BUSY}-demo`);
  heldTree = join(repo, '.worktrees', `issue-${HELD}-demo`);
  git(['worktree', 'add', '-b', `fix/issue-${BUSY}-demo`, busyTree, 'dev'], repo);
  git(['worktree', 'add', '-b', `fix/issue-${HELD}-demo`, heldTree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: BUSY, title: 'Org sysadmin filter pills', url: 'u', labels: ['P1', 'bug'], updatedAt: 'z', author: 'operator' },
    { number: HELD, title: 'Save and Exit', url: 'u', labels: ['P2'], updatedAt: 'z', author: 'operator' },
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
  // FIRST, and unconditionally: the worker holding the slot is a real detached
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
const heldMessage = () => persisted().pendingResume?.[String(HELD)];
/**
 * What the child actually received — empty until it has actually written it.
 *
 * `existsSync` is not the right signal and it cost a red run: `writeFileSync`
 * creates and truncates the file BEFORE it writes a byte to it, so a loaded
 * machine reads an empty string through that window and the assertion fails on
 * content that is about to arrive. So the wait is on the content, not the file.
 */
const resumedText = (): string => {
  try {
    return readFileSync(join(heldTree, 'resumed.txt'), 'utf8');
  } catch {
    return '';
  }
};
const gotResume = () => resumedText().includes('resumed with:');

/** A worker parked at gate C in #4344's worktree, exactly as one leaves it. */
function parkAtGate(sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') {
  writeFileSync(
    join(heldTree, '.gate.json'),
    JSON.stringify({
      issue: HELD,
      gate: 'C',
      stage: 5,
      sessionId,
      stoppedAt: new Date().toISOString(),
      reportPath: null,
      summary: 'Your QA, please.',
      questions: ['Does the click-script pass?'],
    }),
  );
}

/**
 * Fill the only slot with a real worker that will not finish until it is told
 * to, and leave #4344 parked at a gate. This is the operator's actual situation: two
 * workers away, and two more gates in front of them.
 */
async function deskFull(o: Orchestrator): Promise<void> {
  process.env.STUB_WAIT_FOR = goFile;
  await o.start();
  o.enqueue(BUSY);
  await waitFor('the first worker to be running', () => row(o, BUSY).status === 'active');
  // The env var is read at spawn, so removing it now leaves the running worker
  // waiting while everything spawned afterwards runs straight through.
  delete process.env.STUB_WAIT_FOR;
  parkAtGate();
  await o.poll();
  expect(row(o, HELD).status).toBe('at-gate');
}

/** Let the worker holding the slot finish. */
const freeTheSlot = () => writeFileSync(goFile, 'go');

describe('a gate answered while every slot is busy', () => {
  it('is accepted, queued and written down — never refused', async () => {
    const o = orch();
    await deskFull(o);

    const out = await o.resume(HELD, 'Gate C approved, proceed.');

    expect(out.ok).toBe(true);
    expect(out.message).toContain('answer taken');
    expect(out.message).toContain('queued');
    expect(heldMessage()).toBe('Gate C approved, proceed.');
    expect(o.state().queue).toContain(HELD);
    // Nothing is waiting on the operator any more: the row says queued, not AT GATE.
    expect(row(o, HELD).status).toBe('queued');
    expect(row(o, HELD).gate?.gate).toBe('C'); // the gate file is still on disk
    await o.stop();
  });

  it('resumes with exactly those words when a slot frees, then forgets them', async () => {
    const o = orch();
    await deskFull(o);
    await o.resume(HELD, 'Gate C approved — ship it, but rename the flag first.');

    freeTheSlot();

    await waitFor('the held issue to be resumed', () => gotResume());
    // What the child actually received, not what the console meant to send.
    expect(resumedText()).toContain('resumed with: Gate C approved — ship it, but rename the flag first.');
    await waitFor('the held answer to be consumed', () => heldMessage() === undefined);
    await o.stop();
  });

  it('survives the console being restarted underneath it', async () => {
    const first = orch();
    await deskFull(first);
    await first.resume(HELD, 'Gate C approved, proceed.');
    await first.stop();

    // Nothing but the file crosses this line — the queue is memory, and the
    // whole point of writing the decision down is that memory does not survive.
    expect(heldMessage()).toBe('Gate C approved, proceed.');

    const second = orch();
    await second.start();
    expect(second.state().queue).toContain(HELD);
    expect(row(second, HELD).status).toBe('queued');
    expect(heldMessage()).toBe('Gate C approved, proceed.');

    freeTheSlot();
    await waitFor('the second console to deliver the answer', () => gotResume());
    expect(resumedText()).toContain('resumed with: Gate C approved, proceed.');
    await second.stop();
  });

  it('keeps the newest answer when a second one is sent', async () => {
    const o = orch();
    await deskFull(o);

    await o.resume(HELD, 'Gate C approved, proceed.');
    const second = await o.resume(HELD, 'Actually: hold the rename, ship the rest.');

    expect(second.ok).toBe(true);
    expect(second.message).toContain('replaces the answer you sent before');
    expect(heldMessage()).toBe('Actually: hold the rename, ship the rest.');
    expect(o.state().queue.filter((n) => n === HELD)).toHaveLength(1);

    freeTheSlot();
    await waitFor('the held issue to be resumed', () => gotResume());
    expect(resumedText()).toContain('resumed with: Actually: hold the rename, ship the rest.');
    await o.stop();
  });

  it('is dropped when the operator takes the issue out of the queue', async () => {
    const o = orch();
    await deskFull(o);
    await o.resume(HELD, 'Gate C approved, proceed.');

    const out = o.dequeue(HELD);

    expect(out.message).toContain('the answer you had queued for it is dropped too');
    await waitFor('the answer to be forgotten', () => heldMessage() === undefined);
    expect(o.state().queue).not.toContain(HELD);
    // And the gate is the operator's again, rather than an issue with no way back.
    expect(row(o, HELD).status).toBe('at-gate');
    await o.stop();
  });

  it('is dropped by a restart-fresh, which abandons the session it was addressed to', async () => {
    const o = orch();
    await deskFull(o);
    await o.resume(HELD, 'Gate C approved, proceed.');

    const out = await o.restartFresh(HELD, 'personal');

    expect(out.ok).toBe(true);
    expect(heldMessage()).toBeUndefined();
    await o.stop();
  });
});

describe('an ordinary dispatch', () => {
  it('REFUSES to start a fresh worker on an issue parked at a gate', async () => {
    const o = orch();
    await deskFull(o);

    // This used to enqueue and later resume with a bare "Continue." — walking
    // past a decision sitting on screen. It is exactly how #4404's PR reached the
    // team without gate D: the row fell back to `checkpoint`, someone pressed
    // Start, and the new worker read the previous one's notes and carried on from
    // stage 6. The browser hides Start in this state; the refusal belongs in the
    // server, which is what actually owns the decision.
    const out = o.enqueue(HELD);
    expect(out.ok).toBe(false);
    expect(out.message).toContain('decide it on the card');

    // And nothing was written down on their behalf.
    expect(heldMessage()).toBeUndefined();
    expect(row(o, HELD).status).toBe('at-gate');
    await o.stop();
  });

  it('runs the answer straight away when there is room, with nothing written down', async () => {
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();

    const out = await o.resume(HELD, 'Gate C approved, proceed.');

    expect(out.ok).toBe(true);
    expect(out.message).toBe(`resumed #${HELD}`);
    expect(heldMessage()).toBeUndefined();
    await waitFor('the held issue to be resumed', () => gotResume());
    expect(resumedText()).toContain('resumed with: Gate C approved, proceed.');
    await o.stop();
  });
});

/**
 * THE ORPHAN. `dequeue` drops the held answer along with the queue entry, and
 * says why: leaving it behind means some later start silently resuming with a
 * decision about a gate the operator has since taken back. Two other paths removed the
 * queue entry and left `pendingResume` sitting there.
 *
 * What that costs, all three at once:
 *
 *  - `#dispatch` only ever selects from `this.#queue.list()`, so the answer is
 *    never delivered again — only a console restart rescues it;
 *  - `#answerIsQueued` is true, so the card reads "answered" and every button
 *    that asks them something steps aside. Nothing anywhere says an answer is
 *    held that will never arrive;
 *  - `inFlight` is true for ever, so the feed keeps deferring the issue's
 *    "newly assigned" row.
 */
describe('a held answer and its place in the queue are ONE thing', () => {
  it('STOPPING the issue drops the held answer too, and hands the gate straight back', async () => {
    const o = orch();
    await deskFull(o);
    await o.resume(HELD, 'Gate C approved, proceed.');
    expect(heldMessage()).toBe('Gate C approved, proceed.');

    // Nothing is RUNNING on #4344 — it is queued behind the full desk — so this
    // is the "nothing running" answer, and it still takes the queue entry.
    const out = await o.stopWorker(HELD);
    expect(out.message).toContain('the answer you had queued for it is dropped too');

    await waitFor('the answer to be forgotten', () => heldMessage() === undefined);
    expect(o.state().queue).not.toContain(HELD);
    // Back to asking them, rather than an issue that reads answered for ever with
    // nothing on its way.
    expect(row(o, HELD).status).toBe('at-gate');
    await o.stop();
  });

  it('POSTING a drafted comment keeps it — waiting on a reply is not cancelling a decision', async () => {
    writeFileSync(
      join(heldTree, '.comment-request.json'),
      JSON.stringify({
        issue: HELD,
        addressee: '@teammate-one',
        blocks: true,
        why: 'Which domain is live?',
        draftBody: 'Hi teammate-one — which domain is live for password-reset links?',
        sessionId: 'sess-4344',
        requestedAt: '2026-08-11T10:00:00Z',
      }),
    );
    const o = orch();
    await deskFull(o);
    await o.resume(HELD, 'Gate C approved, proceed.');

    const writeExec: GhWriteExec = async () => ({
      code: 0,
      stdout: 'https://github.com/example-org/example-repo/issues/4344#issuecomment-77',
      stderr: '',
    });
    const out = await o.postComment(HELD, 'Hi teammate-one — which domain is live?', writeExec);
    expect(out.ok).toBe(true);

    const block = row(o, HELD).commentBlock!;
    expect((await o.resolveCommentBlock(HELD, block.postedAt)).ok).toBe(true);

    // Posting and then explicitly resolving the external wait does not disturb
    // the answer already owed or its queue position.
    expect(heldMessage()).toBe('Gate C approved, proceed.');
    expect(o.state().queue).toContain(HELD);

    freeTheSlot();
    await waitFor('the held answer to be delivered', () => gotResume());
    expect(resumedText()).toContain('resumed with: Gate C approved, proceed.');
    await o.stop();
  });
});
