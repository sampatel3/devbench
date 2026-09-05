/**
 * TARGETED REWORK — the defect that matters most.
 *
 * The operator's constraint is exact: a failed QA step goes back to Build carrying
 * ONLY that point, and the worker must not redo the FULL QA — that would waste
 * tokens, time and resources on eight steps nobody asked about. So the worker
 * fixes one step, re-captures one step's evidence, and rewrites `.gate.json`.
 *
 * That rewrite is the danger. `.gate.json` is written WHOLE by the worker every
 * time, so a rework can silently take the other eight steps' screenshots with
 * it — and the operator's ticks with them. Then the gate box no longer holds the
 * full evidence for the issue, which is the one thing they asked for: show that
 * the step was fixed while the gate C box still holds the full evidence for the
 * entire issue.
 *
 * Two independent defences, both asserted here against a REAL spawned worker:
 *
 *  1. The operator's ticks live in the console's own state file, keyed to the step id,
 *     its revision AND a hash of what they actually looked at. A step carried
 *     forward untouched keeps its tick through the rewrite; the fixed step's
 *     rev bump resets its tick to unset, so they re-check exactly one thing.
 *  2. The console snapshots the evidence and the steps at the moment it
 *     dispatches the rework. Whatever the worker returns, nothing the operator has
 *     already seen can disappear from the card — and the console says so out
 *     loud when it had to put something back.
 *
 * `probeResources` is stubbed in every test: nothing here reads or restarts
 * anything on the operator's actual machine, and no worker but this test's own stub is
 * ever signalled.
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
import * as worktrees from '../src/worktrees.js';
import { PRIOR_EVIDENCE_MARK } from '../src/rework.js';
import { missingShots } from '../src/manual-qa.js';
import type { QaVerdict } from '../src/qa-verdict.js';
import type { ResourceReport } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const GATE = 4404; // parked at gate C with a three-step click-script
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const QA = 'docs/issue-pipeline/plans/qa-4404';

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

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-qarework-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  tree = join(repo, '.worktrees', `issue-${GATE}-withdraw`);
  git(['worktree', 'add', '-b', `fix/issue-${GATE}-withdraw`, tree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: GATE, title: 'Withdraw quote is not terminal', url: 'u', labels: ['P1'], updatedAt: 'z', author: 'operator' },
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
  delete process.env.STUB_QA_REWORK;
  delete process.env.STUB_QA_DROP_EVIDENCE;
  delete process.env.STUB_QA_DROP_STEPS;
  delete process.env.STUB_QA_STOPPED_AT;
  delete process.env.STUB_QA_DUP_STEP;
  delete process.env.STUB_QA_DELETE_SHOTS;
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

const row = (o: Orchestrator) => o.state().issues.find((r) => r.number === GATE)!;

/** The evidence a whole issue's QA produced — three steps, three captures. */
const EVIDENCE = [
  { kind: 'screenshot', path: `${QA}/step1-after.png`, caption: 'step 1 — Withdraw asks first' },
  { kind: 'screenshot', path: `${QA}/step2-after.png`, caption: 'step 2 — withdrawn quote cannot be accepted' },
  { kind: 'screenshot', path: `${QA}/step3-after.png`, caption: 'step 3 — empty reason is rejected' },
];

/** Three paired before/after steps, exactly as a v2 worker leaves them. */
const STEPS = [
  {
    id: 1,
    rev: 1,
    do: 'Withdraw a sent quote',
    url: 'http://localhost:8106/quotes',
    before: 'it withdrew with no warning',
    beforeShot: `${QA}/step1-before.png`,
    after: 'a confirm dialog asks first',
    afterShot: `${QA}/step1-after.png`,
  },
  {
    id: 2,
    rev: 1,
    do: 'Try to accept the withdrawn quote',
    url: 'http://localhost:8106/quotes',
    before: 'Accept still worked',
    beforeShot: `${QA}/step2-before.png`,
    after: 'Accept is gone',
    afterShot: `${QA}/step2-after.png`,
  },
  {
    id: 3,
    rev: 1,
    do: 'Confirm the withdrawal with an empty reason',
    url: 'http://localhost:8106/quotes',
    before: 'the modal accepted it',
    beforeShot: `${QA}/step3-before.png`,
    after: 'Confirm stays disabled',
    afterShot: `${QA}/step3-after.png`,
  },
];

/** A worker parked at gate C, click-script, evidence and quiz all in place. */
function parkAtGate(stoppedAt = '2026-08-12T09:00:00.000Z') {
  writeFileSync(
    join(tree, '.gate.json'),
    JSON.stringify({
      issue: GATE,
      gate: 'C',
      stage: 5,
      sessionId: SESSION,
      stoppedAt,
      reportPath: null,
      summary: 'Did: drove the app headlessly on 8106 as the local-dev sysadmin.',
      questions: [],
      evidence: EVIDENCE,
      manualQa: {
        appUrl: 'http://localhost:8106',
        login: { email: 'sysadmin@localdev.test', password: 'localdev123!' },
        start: 'Quotes list, filtered to Sent.',
        steps: STEPS,
      },
      quiz: {
        brief: ['Withdraw now asks before it changes the quote'],
        questions: [
          {
            context: 'A quote that is withdrawn is meant to be terminal — no further action on it.',
            question: 'What happens if a broker tries to accept a withdrawn quote?',
            options: [
              { text: 'Nothing — Accept is no longer offered', why: 'Withdrawn is terminal, so the action is gone.' },
              { text: 'It accepts and reopens the quote', why: 'That was the bug; step 2 shows it is gone.' },
            ],
            correct: 0,
          },
        ],
      },
    }),
  );
}

/**
 * The captures, as actual bytes on disk.
 *
 * Most of these tests never need them — a path in a manifest is enough to check
 * a manifest. The ones that do are the ones about what is UNDER the path, which
 * is the half a string comparison cannot see.
 */
function writeShots(): void {
  mkdirSync(join(tree, QA), { recursive: true });
  for (const n of [1, 2, 3]) {
    writeFileSync(join(tree, QA, `step${n}-before.png`), `before ${n}`);
    writeFileSync(join(tree, QA, `step${n}-after.png`), `after ${n}`);
  }
}

/**
 * The gate ledger, as the console wrote it. `decisions.jsonl` sits beside
 * `state.json` when `DECISIONS_FILE` is not set.
 */
const ledger = (): Array<{ gate: string; decision: string; message: string }> => {
  try {
    return readFileSync(join(home, 'decisions.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { gate: string; decision: string; message: string });
  } catch {
    return [];
  }
};

/** What the child actually received. */
const resumedText = (): string => {
  try {
    return readFileSync(join(tree, 'resumed.txt'), 'utf8');
  } catch {
    return '';
  }
};

const persistedVerdicts = (): QaVerdict[] => {
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as { qaVerdicts?: Record<string, QaVerdict[]> };
    return raw.qaVerdicts?.[String(GATE)] ?? [];
  } catch {
    return [];
  }
};

/** The operator works down the card: two steps pass, the third does not. */
async function tickTwoAndFailOne(o: Orchestrator) {
  await o.setQaVerdict(GATE, { stepId: 1, rev: 1, status: 'verified', note: null });
  await o.setQaVerdict(GATE, { stepId: 2, rev: 1, status: 'verified', note: null });
  await o.setQaVerdict(GATE, { stepId: 3, rev: 1, status: 'failed', note: 'modal accepted an empty reason' });
}

describe('a rework carries the whole issue forward', () => {
  it('KEEPS the untouched steps ticked and every screenshot, even when the worker returns neither', async () => {
    // The worker misbehaves in the exact way the design fears: it fixes step 3,
    // re-captures step 3, and writes back an `evidence` array holding ONLY its
    // new capture. Everything the operator already looked at is gone from the file.
    process.env.STUB_QA_REWORK = '1';
    process.env.STUB_QA_DROP_EVIDENCE = '1';
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();
    await tickTwoAndFailOne(o);

    const out = await o.qaRework(GATE);
    expect(out.ok).toBe(true);
    await waitFor('the worker to be sent the rework', () => resumedText().includes('QA REWORK'));
    // On CONTENT, never on the gate file existing: the OLD gate file is also a
    // stage-5 gate C, and waiting on that raced the worker and asserted against
    // the state the rework was sent to change.
    await waitFor('the rework to come back and be checked', () => row(o).qaRework?.status === 'returned');

    const after = row(o);

    // 1. THE EVIDENCE. Nothing the operator has already seen is allowed to vanish from
    //    the card because a worker rewrote the file badly.
    const paths = after.gateEvidence.map((e) => e.path);
    for (const e of EVIDENCE) expect(paths).toContain(e.path);
    expect(paths).toContain(`${QA}/step3-after-rev2.png`); // and the new capture is there too

    // 2. THE TICKS. Two steps came back byte for byte, so their verdicts on them
    //    stand — they do not re-check nine things to fix one.
    expect(after.qaVerdicts.find((v) => v.stepId === 1 && v.status === 'verified')).toBeTruthy();
    expect(after.qaVerdicts.find((v) => v.stepId === 2 && v.status === 'verified')).toBeTruthy();
    const steps = after.gateManualQa!.steps;
    expect(o.qaStepState(GATE, steps.find((s) => s.id === 1)!)).toBe('verified');
    expect(o.qaStepState(GATE, steps.find((s) => s.id === 2)!)).toBe('verified');

    // 3. THE FIXED STEP. Its revision moved, so its tick is unset again and the
    //    gate stays locked until the operator looks at the one thing that changed.
    expect(steps.find((s) => s.id === 3)!.rev).toBe(2);
    expect(o.qaStepState(GATE, steps.find((s) => s.id === 3)!)).toBe('unset');
    expect(steps.find((s) => s.id === 3)!.fix).toBeTruthy();

    // 4. AND IT IS SAID OUT LOUD. A silent repair would teach the worker nothing
    //    and tell the operator nothing.
    expect(after.qaRework!.violation).toMatch(/dropped/i);
    expect(after.qaRework!.violation).toContain('own copy');
    expect(after.qaRework!.restored).toEqual(expect.arrayContaining([`${QA}/step1-after.png`]));
    await o.stop();
  }, 30_000);

  it('leaves an obedient rework alone — no violation, nothing restored', async () => {
    process.env.STUB_QA_REWORK = '1';
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();
    await tickTwoAndFailOne(o);

    await o.qaRework(GATE);
    await waitFor('the worker to be sent the rework', () => resumedText().includes('QA REWORK'));
    // On CONTENT, never on the gate file existing: the OLD gate file is also a
    // stage-5 gate C, and waiting on that raced the worker and asserted against
    // the state the rework was sent to change.
    await waitFor('the rework to come back and be checked', () => row(o).qaRework?.status === 'returned');

    const after = row(o);
    expect(after.gateEvidence).toHaveLength(4); // the three it carried, plus the new one
    expect(after.qaRework!.violation).toBeNull();
    expect(after.qaRework!.restored).toEqual([]);
    expect(after.qaRework!.status).toBe('returned');
    await o.stop();
  }, 30_000);

  it('sends ONLY the failed step, and forbids the full QA being run again', async () => {
    process.env.STUB_QA_REWORK = '1';
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();
    await tickTwoAndFailOne(o);

    await o.qaRework(GATE);
    await waitFor('the worker to be sent the rework', () => resumedText().includes('QA REWORK'));

    const sent = resumedText();
    expect(sent).toContain('GATE C QA REWORK');
    expect(sent.toLowerCase()).not.toContain('approved'); // it is not a decision
    expect(sent).toContain('modal accepted an empty reason'); // their words, verbatim
    expect(sent).toContain('Do NOT re-run the full manual QA');
    expect(sent).toContain('waste of tokens');

    // The INSTRUCTIONS name one step and no other: that is what stops the worker
    // re-driving nine. The payload below them is a different thing and must be
    // complete — carrying every step forward is the whole point of it.
    const instructions = sent.slice(0, sent.indexOf(PRIOR_EVIDENCE_MARK));
    expect(instructions).toContain('Confirm the withdrawal with an empty reason'); // the failed step
    expect(instructions).not.toContain('Try to accept the withdrawn quote'); // a passing step
    expect(instructions).not.toContain('Withdraw a sent quote');

    const payload = sent.slice(sent.indexOf(PRIOR_EVIDENCE_MARK));
    expect(payload).toContain(`${QA}/step1-after.png`); // every screenshot goes back
    expect(payload).toContain('"id": 2'); // and every step, so nothing is dropped
    await o.stop();
  }, 30_000);

  /**
   * A rework parked at capacity lives in `pendingResume`, which holds exactly one
   * message. The next thing the operator sends from the same card overwrites it — and the
   * rework prompt is the ONLY thing carrying their failed step, the prior evidence
   * and the click-script forward. It used to go silently, under a line about
   * replacing "the answer you had queued", leaving the card saying the step was
   * with Build and the next gate stop judged against a baseline for a round no
   * worker ever received.
   */
  it('cancels a queued rework OUT LOUD when the next thing they send replaces it', async () => {
    process.env.STUB_QA_REWORK = '1';
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();
    await tickTwoAndFailOne(o);

    // The machine goes busy, so the rework parks instead of spawning.
    vi.mocked(resources.probeResources).mockResolvedValue({
      ok: false,
      reason: 'memory is short',
      freePct: 5,
      headroomBytes: 0,
      headroomLabel: '0 GB',
      minFreePct: 25,
      footprintBytes: 0,
      footprintLabel: '0 GB',
      ceilingBytes: 1,
      ceilingLabel: '1 GB',
      totalBytes: 2,
      edgeRuntimeLabel: null,
      checkedAt: new Date().toISOString(),
    } as ResourceReport);
    await o.poll();

    const sent = await o.qaRework(GATE);
    expect(sent.ok).toBe(true);
    expect(row(o).qaRework!.status).toBe('queued');

    // ...and then they ask a question from the same card.
    const asked = await o.ask(GATE, 'why does the modal not trim whitespace?');
    expect(asked.ok).toBe(true);
    // The words that replaced it say WHICH thing was cancelled, in their terms.
    expect(asked.message).toMatch(/rework/i);
    expect(asked.message).toContain('step 3');

    const rw = row(o).qaRework!;
    expect(rw.status).toBe('cancelled');
    // Nothing is outstanding, so no later gate stop is judged against a round
    // that was never sent — and their tick on step 3 is untouched, so one click
    // sends it again.
    expect(row(o).qaSteps.find((s) => s.id === 3)!.state).toBe('failed');

    // The same rule on the DECISION path: a resume held for a slot writes over
    // `pendingResume` exactly as an ask does, and used to take a queued rework
    // with it just as quietly.
    expect((await o.qaRework(GATE)).ok).toBe(true);
    expect(row(o).qaRework!.status).toBe('queued');
    const decided = await o.resume(GATE, 'Some other feedback entirely.');
    expect(decided.message).toMatch(/rework of step 3 is CANCELLED/i);
    expect(row(o).qaRework!.status).toBe('cancelled');
    await o.stop();
  }, 30_000);

  it('finds a capture the gate file DECLARED and never wrote, and says which leg', async () => {
    // The bug the operator hit repeatedly: a step names its shot, no file exists at the
    // path, and the card rendered the browser's own broken-image icon with
    // nothing said — no warning, Approve wide open, and them writing a comment
    // for each one. The scan stat'd both legs the whole time and spent the
    // answer on a tick fingerprint.
    const o = orch();
    await o.start();
    parkAtGate();
    writeShots();
    rmSync(join(tree, QA, 'step3-after.png')); // the one the worker never really wrote
    await o.poll();

    const steps = row(o).gateManualQa!.steps;
    expect(steps.find((s) => s.id === 3)!.goneShots).toEqual(['after']);
    // The steps whose files ARE there are not accused of anything.
    expect(steps.find((s) => s.id === 1)!.goneShots).toEqual([]);
    expect(steps.find((s) => s.id === 2)!.goneShots).toEqual([]);

    // And the shared rule turns it into the warning they have to accept by hand,
    // naming the leg rather than the step alone.
    expect(missingShots(steps)).toEqual([{ id: 3, legs: ['after'], gone: ['after'] }]);
    await o.stop();
  }, 30_000);

  it('does not accuse a step whose captures are all on disk', async () => {
    const o = orch();
    await o.start();
    parkAtGate();
    writeShots();
    await o.poll();

    expect(missingShots(row(o).gateManualQa!.steps)).toEqual([]);
    await o.stop();
  }, 30_000);

  it('keeps every tick when a capture goes missing — the stamp already did that job', async () => {
    // `goneShots` is deliberately NOT an input to `stepHash`. A vanished file
    // already moves `shotStamp` and resets that step's tick; adding a second
    // input would have reset every tick on disk the moment this shipped.
    const o = orch();
    await o.start();
    parkAtGate();
    writeShots();
    await o.poll();
    await o.setQaVerdict(GATE, { stepId: 1, rev: 1, status: 'verified', note: null });
    expect(row(o).qaSteps.find((s) => s.id === 1)!.state).toBe('verified');

    // Step 3's capture disappears. Step 1 is a different step and keeps its tick.
    rmSync(join(tree, QA, 'step3-after.png'));
    await o.poll();
    expect(row(o).qaSteps.find((s) => s.id === 1)!.state).toBe('verified');
    await o.stop();
  }, 30_000);

  it('is recorded as FEEDBACK, so sending a step back never reads as passing gate C', async () => {
    // `#recordDecision` writes against the gate the worker is parked at, and a
    // rework reached `resume` with no `decision` — which defaults to
    // `'approved'`. So a failed QA step wrote "gate C approved" into the ledger
    // decisions.ts calls authoritative, one line after they had rejected it.
    // Three readers believed it: the spine ticked C, `codeSince` reset the
    // "code has landed since your QA" clock, and `leftUnanswered` took the
    // rework's own empty list as their newest approval.
    process.env.STUB_QA_REWORK = '1';
    const o = orch();
    await o.start();
    parkAtGate();
    writeShots();
    await o.poll();
    await tickTwoAndFailOne(o);

    expect((await o.qaRework(GATE)).ok).toBe(true);
    await waitFor('the rework to be recorded', () => ledger().length > 0);

    const forC = ledger().filter((d) => d.gate === 'C');
    expect(forC).toHaveLength(1);
    expect(forC[0]!.decision).toBe('feedback');
    expect(ledger().filter((d) => d.decision === 'approved')).toEqual([]);
    // And the spine does not tick a gate they have just sent work back through.
    expect(row(o).gatesPassed).not.toContain('C');
    await o.stop();
  }, 30_000);

  it('records a HELD feedback answer as feedback, not as an approval for waiting', async () => {
    // The same defect on the other path, and it turned on nothing but timing:
    // the dispatch of a parked answer hard-coded `'approved'`, so the identical
    // feedback recorded correctly when a slot was free and as an approval when
    // it had to wait. The mark parked beside the words is what it now reads.
    const o = orch();
    await o.start();
    parkAtGate();
    writeShots();
    await o.poll();

    // The desk goes short, so their answer parks instead of spawning.
    vi.mocked(resources.probeResources).mockResolvedValue({
      ok: false,
      reason: 'memory is short',
      freePct: 5,
      headroomBytes: 0,
      headroomLabel: '0 GB',
      minFreePct: 25,
      footprintBytes: 0,
      footprintLabel: '0 GB',
      ceilingBytes: 1,
      ceilingLabel: '1 GB',
      totalBytes: 2,
      edgeRuntimeLabel: null,
      checkedAt: new Date().toISOString(),
    } as ResourceReport);
    await o.poll();

    const held = await o.resume(GATE, 'the empty state is still wrong — look again', { decision: 'feedback' });
    expect(held.ok).toBe(true);
    expect(ledger()).toEqual([]); // nothing is recorded until it actually goes

    // The machine recovers and the queue delivers it.
    vi.mocked(resources.probeResources).mockResolvedValue({
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
    await o.poll();
    await waitFor('the held answer to be delivered', () => ledger().length > 0);

    expect(ledger()).toHaveLength(1);
    expect(ledger()[0]!.decision).toBe('feedback');
    expect(ledger()[0]!.message).toBe('the empty state is still wrong — look again');
    await o.stop();
  }, 30_000);

  it('refuses a rework with nothing failed, and refuses one while the worker is live', async () => {
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();

    const none = await o.qaRework(GATE);
    expect(none.ok).toBe(false);
    expect(none.message).toMatch(/failed/i);

    await o.setQaVerdict(GATE, { stepId: 3, rev: 1, status: 'failed', note: 'still wrong' });
    process.env.STUB_QA_REWORK = '1';
    await o.qaRework(GATE);
    const twice = await o.qaRework(GATE);
    expect(twice.ok).toBe(false);
    await o.stop();
  }, 30_000);
});

/**
 * WHAT A SECOND ROUND CAN TAKE WITH IT.
 *
 * Every defence in the file above is a comparison against the console's own
 * snapshot, and the snapshot is retaken at every dispatch. So the question that
 * decides whether any of it holds is: retaken FROM WHAT. From the raw gate file,
 * a round that shrank the evidence rebases the baseline onto the shrunken list,
 * and the round after it carries the loss forward as though it were the truth —
 * one fumbled merge followed by one obedient one and the proof is gone from the
 * card, the file and the baseline at once, with nothing raised.
 *
 * The rule these four tests hold down: the console's copy only ever GROWS while
 * a gate C stop is open. It is a ratchet, not a mirror.
 */
describe('the console copy is a ratchet, never a mirror', () => {
  it('cannot be shrunk by two rounds in a row — round 2 rebases on what round 1 already lost', async () => {
    process.env.STUB_QA_REWORK = '1';
    process.env.STUB_QA_DROP_EVIDENCE = '1'; // round 1 fumbles the merge
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();
    await tickTwoAndFailOne(o);

    expect((await o.qaRework(GATE)).ok).toBe(true);
    await waitFor('round 1 to come back', () => row(o).qaRework?.status === 'returned');
    // The card is whole again — that is the defence working, and it is also the
    // exact moment the next snapshot gets taken from.
    for (const e of EVIDENCE) expect(row(o).gateEvidence.map((x) => x.path)).toContain(e.path);

    // The operator looks at the fix, is still not happy, and sends the same step back.
    await o.setQaVerdict(GATE, { stepId: 3, rev: 2, status: 'failed', note: 'still accepts a single space' });
    delete process.env.STUB_QA_DROP_EVIDENCE; // round 2 is a perfectly obedient worker
    expect((await o.qaRework(GATE)).ok).toBe(true);
    await waitFor(
      'round 2 to come back',
      () => row(o).qaRework?.status === 'returned' && row(o).qaVerdicts.length > 0,
    );
    await waitFor('the rev-3 capture to land', () =>
      row(o).gateEvidence.some((e) => e.path.includes('rev3')),
    );

    // Everything the operator ticked against in round 0 is STILL on the card. An obedient
    // worker can only carry forward what it was handed, so this is really an
    // assertion about what the console handed it.
    const paths = row(o).gateEvidence.map((e) => e.path);
    for (const e of EVIDENCE) expect(paths).toContain(e.path);
    expect(paths).toContain(`${QA}/step3-after-rev2.png`);
    await o.stop();
  }, 30_000);

  /**
   * The whole return check used to hang on `stoppedAt` moving. Nothing requires
   * a worker to move it: the rework prompt lists the fields to carry forward
   * unchanged and a worker that reads "keep the header" is being obedient. When
   * it does not move, no comparison ever runs — the drop is never named, the
   * round never leaves `sent`, and the card says "with Build now" for ever.
   */
  it('checks a round that came back under the SAME stop stamp', async () => {
    process.env.STUB_QA_REWORK = '1';
    process.env.STUB_QA_DROP_EVIDENCE = '1';
    process.env.STUB_QA_STOPPED_AT = '2026-08-12T09:00:00.000Z'; // byte-identical header
    const o = orch();
    await o.start();
    parkAtGate('2026-08-12T09:00:00.000Z');
    await o.poll();
    await tickTwoAndFailOne(o);

    await o.qaRework(GATE);
    await waitFor('the worker to be sent the rework', () => resumedText().includes('QA REWORK'));
    await waitFor('the rework to be checked anyway', () => row(o).qaRework?.status === 'returned', 15_000);

    const after = row(o);
    expect(after.qaRework!.violation).toMatch(/dropped/i);
    expect(after.qaRework!.restored).toEqual(expect.arrayContaining([`${QA}/step1-after.png`]));
    await o.stop();
  }, 30_000);

  /**
   * A dropped STEP is worse than a dropped screenshot, because the step is the
   * unit Approve counts. Nine steps came back as two and the card said "verify 1
   * more step to approve" — true about the two that survived, and the button went
   * green over a QA whose size the worker had chosen.
   */
  it('keeps a dropped step, its tick and its place in the count', async () => {
    process.env.STUB_QA_REWORK = '1';
    process.env.STUB_QA_DROP_STEPS = '2';
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();
    await tickTwoAndFailOne(o);

    await o.qaRework(GATE);
    await waitFor('the rework to come back and be checked', () => row(o).qaRework?.status === 'returned');

    const after = row(o);
    // The denominator is the console's, not the worker's.
    expect(after.qaProgress.total).toBe(3);
    expect(after.gateManualQa!.steps.map((s) => s.id)).toEqual([1, 2, 3]);
    // Step 2 is still on the card, still ticked, and marked as the console's copy.
    const two = after.qaSteps.find((s) => s.id === 2)!;
    expect(two.state).toBe('verified');
    expect(two.missing).toBe(true);
    expect(after.gateManualQa!.steps.find((s) => s.id === 2)!.afterShot).toBe(`${QA}/step2-after.png`);
    // And it is said out loud rather than left for them to notice.
    expect(after.qaRework!.violation).toMatch(/without step 2/i);
    await o.stop();
  }, 30_000);

  /**
   * `EvidenceItem` is `{kind, path, caption}` — the console's "own copy" is a
   * path, and the evidence route reads the bytes live out of the worktree. A
   * worker that deletes the file defeats the restore completely: the operator gets a
   * broken image while the round reports it was put back.
   */
  it('names the captures the rework DELETED, not just the ones it stopped listing', async () => {
    process.env.STUB_QA_REWORK = '1';
    process.env.STUB_QA_DELETE_SHOTS = '1'; // the manifest is perfect; the files are gone
    const o = orch();
    await o.start();
    writeShots();
    parkAtGate();
    await o.poll();
    await tickTwoAndFailOne(o);

    await o.qaRework(GATE);
    await waitFor('the rework to come back and be checked', () => row(o).qaRework?.status === 'returned');

    const after = row(o);
    expect(after.qaRework!.violation).toMatch(/deleted/i);
    expect(after.qaRework!.violation).toContain(`${QA}/step1-after.png`);
    await o.stop();
  }, 30_000);
});

describe('the ticks are the operator’s own, and nobody else’s', () => {
  /**
   * `stepHash` joined the screenshot PATHS. `server.ts` says rounds reuse
   * filenames, and the evidence route sends `no-cache` — so a capture rewritten
   * in place put a new picture on the card underneath a tick the operator gave to the old
   * one, with no chip, no reset and nothing to notice.
   */
  it('drops the tick when a capture is rewritten in place, under the same filename', async () => {
    const o = orch();
    await o.start();
    writeShots();
    parkAtGate();
    await o.poll();
    await o.setQaVerdict(GATE, { stepId: 1, rev: 1, status: 'verified', note: null });
    expect(row(o).qaProgress.verified).toBe(1);

    // `.gate.json` is not touched at all — only the bytes under a path it names.
    writeFileSync(join(tree, QA, 'step1-after.png'), 'a completely different picture entirely');
    await o.poll();

    expect(o.qaStepState(GATE, row(o).gateManualQa!.steps.find((s) => s.id === 1)!)).toBe('unset');
    expect(row(o).qaProgress.verified).toBe(0);
    await o.stop();
  }, 30_000);


  it('records the note, stamps the time itself, and keeps the failing capture reachable', async () => {
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();

    const bad = await o.setQaVerdict(GATE, { stepId: 3, rev: 1, status: 'failed', note: '   ' });
    expect(bad.ok).toBe(false); // a fail with no words is not actionable rework

    await o.setQaVerdict(GATE, { stepId: 3, rev: 1, status: 'failed', note: 'modal accepted an empty reason' });
    const v = persistedVerdicts().at(-1)!;
    expect(v.note).toBe('modal accepted an empty reason');
    expect(Date.parse(v.at)).toBeGreaterThan(0); // stamped here, not by the page
    expect(v.shotAtFail).toBe(`${QA}/step3-after.png`); // the old capture stays findable
    await o.stop();
  }, 30_000);

  it('refuses a tick against a revision that is no longer on the card', async () => {
    const o = orch();
    await o.start();
    parkAtGate();
    await o.poll();

    const stale = await o.setQaVerdict(GATE, { stepId: 1, rev: 9, status: 'verified', note: null });
    expect(stale.ok).toBe(false);
    expect(persistedVerdicts()).toEqual([]);

    const ghost = await o.setQaVerdict(GATE, { stepId: 99, rev: 1, status: 'verified', note: null });
    expect(ghost.ok).toBe(false);
    await o.stop();
  }, 30_000);

  it('survives the console being restarted underneath them', async () => {
    const first = orch();
    await first.start();
    parkAtGate();
    await first.poll();
    await first.setQaVerdict(GATE, { stepId: 1, rev: 1, status: 'verified', note: null });
    await first.setQaVerdict(GATE, { stepId: 3, rev: 1, status: 'failed', note: 'modal accepted an empty reason' });
    await first.stop();

    // Nothing but the state file crosses this line.
    const second = orch();
    await second.start();
    await second.poll();

    const after = row(second);
    expect(after.qaProgress).toMatchObject({ total: 3, verified: 1, failed: 1, unset: 1, complete: false });
    expect(after.qaSteps.map((s) => s.state)).toEqual(['verified', 'unset', 'failed']);
    expect(after.qaSteps[2]!.note).toBe('modal accepted an empty reason');
    // And the rework it feeds is still dispatchable — the ticks are not just
    // shown, they are still load-bearing after a restart.
    process.env.STUB_QA_REWORK = '1';
    expect((await second.qaRework(GATE)).ok).toBe(true);
    await second.stop();
  }, 30_000);

  it('is not thrown away when the FIRST scan after a restart fails', async () => {
    const first = orch();
    await first.start();
    parkAtGate();
    await first.poll();
    await first.setQaVerdict(GATE, { stepId: 1, rev: 1, status: 'verified', note: null });
    await first.stop();
    expect(persistedVerdicts()).toHaveLength(1);

    // The console comes back up and `git worktree list` hiccups on the very
    // first read. There is no previous scan to fall back to, so the list is
    // empty — and an empty scan must never be read as "every worktree is gone".
    // Deleting a person's own verification because a git call failed once is
    // exactly the loss this whole feature exists to prevent.
    const spy = vi.spyOn(worktrees, 'scanWorktrees').mockRejectedValue(new Error('git exploded'));
    const second = orch();
    await second.start();
    expect(persistedVerdicts()).toHaveLength(1);

    // ...and it is still a live tick once the scan recovers.
    spy.mockRestore();
    await second.poll();
    expect(row(second).qaProgress.verified).toBe(1);
    await second.stop();
  }, 30_000);

  it('cannot be forged by the worker — a "verified" in .gate.json is not a tick', async () => {
    const o = orch();
    await o.start();
    writeFileSync(
      join(tree, '.gate.json'),
      JSON.stringify({
        issue: GATE,
        gate: 'C',
        stage: 5,
        sessionId: SESSION,
        stoppedAt: '2026-08-12T09:00:00.000Z',
        summary: 'Did: drove the app.',
        questions: [],
        manualQa: {
          steps: [{ id: 1, rev: 1, do: 'Open Quotes', verified: true, status: 'verified', checked: true }],
        },
      }),
    );
    await o.poll();

    expect(row(o).qaVerdicts).toEqual([]);
    expect(o.qaStepState(GATE, row(o).gateManualQa!.steps[0]!)).toBe('unset');
    await o.stop();
  }, 30_000);
});
