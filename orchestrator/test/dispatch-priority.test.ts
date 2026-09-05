/**
 * The line, end to end: three tickets waiting, and the one the console picks.
 *
 * `queue-priority.test.ts` proves the ordering; this proves it is WIRED — that
 * the band comes off the issue's real labels, that the UAT send-back comes off
 * the same derived actions feed the row and the rail read, and that the "2 in
 * line" printed on a row is the position that ticket will actually be served in.
 *
 * Nothing is allowed to start: the RAM guard is pinned to "not ok", so all three
 * stay in the line and the line can be read whole. That is also the state the
 * console was in when the order looked like it was picking either at random or
 * by the moment a ticket entered the queue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ActionsPayload } from '../src/gh.js';
import type { ResourceReport } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');

/** Enqueued FIRST and ranked LAST — the case that used to win on arrival alone. */
const CHORE = 5417; // P3
const SECURITY = 5410; // P1
const SENT_BACK = 5305; // P2, and QA rejected it after the merge

let repo: string;
let home: string;
let canonical: string;
let stateFile: string;
let labels: Record<number, string[]>;

const emptyPayload = (over: Partial<ActionsPayload> = {}): ActionsPayload => ({
  issues: [],
  prs: [],
  reviewRequested: [],
  mentions: [],
  merged: [],
  quota: { cost: 2, remaining: 4000, limit: 5000, resetAt: '2026-09-01T11:00:00Z' },
  truncated: null,
  ...over,
});

/** #5305's own work, shipped — the merge a post-UAT verdict has to come after. */
const SHIPPED = {
  number: 5501,
  url: 'u',
  state: 'MERGED',
  createdAt: '2026-08-30T12:00:00Z',
  mergedAt: '2026-08-31T09:00:00Z',
  headRefName: `fix/issue-${SENT_BACK}-drs-cascade`,
  lastCommitAt: '2026-08-31T08:50:00Z',
};

/** A real QA tester, on the issue, after the merge, in the template — the four
 *  gates `uat.ts` requires. Anything less is not a send-back. */
const sentBackPayload = (): ActionsPayload =>
  emptyPayload({
    issues: [
      {
        number: SENT_BACK,
        title: `#${SENT_BACK}`,
        url: `https://github.com/example-org/example-repo/issues/${SENT_BACK}`,
        updatedAt: '2026-08-31T12:00:00Z',
        labels: ['P2'],
        comments: [
          {
            id: '9001',
            author: { login: 'qa-alice', typename: 'User' },
            createdAt: '2026-08-31T12:00:00Z',
            body: '**Test Result:** Fail\nThe DRS score is still NULL.',
            url: `https://github.com/example-org/example-repo/issues/${SENT_BACK}#issuecomment-9001`,
          },
        ],
        lane: 'QA',
        laneAt: '2026-08-31T09:01:00Z',
        referencingPrs: [SHIPPED],
        mergedPrs: [SHIPPED],
        mergedAt: '2026-08-31T09:00:00Z',
      },
    ],
  });

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

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-dispatch-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  for (const n of [CHORE, SECURITY, SENT_BACK]) {
    git(['worktree', 'add', '-b', `fix/issue-${n}-x`, join(repo, '.worktrees', `issue-${n}-x`), 'dev'], repo);
  }

  labels = { [CHORE]: ['P3'], [SECURITY]: ['P1'], [SENT_BACK]: ['P2'] };

  vi.spyOn(gh, 'listIssues').mockImplementation(async () =>
    [CHORE, SECURITY, SENT_BACK].map((number) => ({
      number,
      title: `#${number}`,
      url: `https://github.com/example-org/example-repo/issues/${number}`,
      labels: labels[number] ?? [],
      updatedAt: '2026-08-30T10:00:00Z',
      author: 'someone-else',
    })),
  );
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(gh, 'readGraphqlQuota').mockResolvedValue({ limit: 5000, remaining: 4000, resetAt: '2026-09-01T11:00:00Z' });
  vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(emptyPayload());

  // Nothing may start: the line has to stay readable.
  vi.spyOn(resources, 'probeResources').mockResolvedValue({
    ok: false,
    reason: 'waiting on memory — 9% free, need 25%',
    freePct: 9,
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
});

afterEach(() => {
  killSpawnedWorkers(stateFile);
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
      CANONICAL_CLAUDE_DIR: canonical,
      CLAUDE_BIN: STUB,
      POLL_MS: '999999',
    }),
  );
}

/** A worker parked at gate C in one of the three worktrees, with a session for
 *  a resume to land in. The minimum this file needs — `qa-rework.test.ts` owns
 *  the full click-script fixture. */
function parkAtGateC(issue: number): void {
  writeFileSync(
    join(repo, '.worktrees', `issue-${issue}-x`, '.gate.json'),
    JSON.stringify({
      issue,
      gate: 'C',
      stage: 5,
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      stoppedAt: '2026-08-31T09:00:00.000Z',
      reportPath: null,
      summary: 'Did: drove the app and captured before/after on two ports.',
      questions: [],
      // One step, so a QA tick and a targeted rework are reachable from here.
      // The full click-script fixture lives in `qa-rework.test.ts`.
      manualQa: {
        appUrl: 'http://localhost:8106',
        start: 'Quotes list, filtered to Sent.',
        steps: [
          {
            id: 1,
            rev: 1,
            do: 'Withdraw a sent quote',
            url: 'http://localhost:8106/quotes',
            before: 'it withdrew with no warning',
            beforeShot: `docs/issue-pipeline/plans/qa-${issue}/step1-before.png`,
            after: 'a confirm dialog asks first',
            afterShot: `docs/issue-pipeline/plans/qa-${issue}/step1-after.png`,
          },
        ],
      },
    }),
  );
}

describe('what the console picks out of the queue', () => {
  it('serves the P1 before the P3 that asked first', async () => {
    const o = orch();
    await o.start();
    await waitFor('the worktrees to be scanned', () => o.state().issues.length === 3);

    expect(o.enqueue(CHORE).ok).toBe(true);
    expect(o.enqueue(SECURITY).ok).toBe(true);

    expect(o.state().queue).toEqual([SECURITY, CHORE]);
    const row = (n: number) => o.state().issues.find((r) => r.number === n)!;
    expect(row(SECURITY).queuePosition).toBe(1);
    expect(row(CHORE).queuePosition).toBe(2);
    await o.stop();
  });

  it('re-ranks a ticket that triage labels while it is still waiting', async () => {
    const o = orch();
    await o.start();
    await waitFor('the worktrees to be scanned', () => o.state().issues.length === 3);

    o.enqueue(CHORE);
    o.enqueue(SECURITY);
    expect(o.state().queue).toEqual([SECURITY, CHORE]);

    labels[CHORE] = ['P0']; // somebody re-triages it upward
    await o.poll();

    expect(o.state().queue).toEqual([CHORE, SECURITY]);
    await o.stop();
  });

  it('puts a ticket the operator sent back above every band, but not above UAT', async () => {
    // The rule: a P2 already sent back outranks a P1 nobody has touched yet, and
    // failures are resolved first and immediately. The P2 here is parked at gate
    // C with feedback sent back; the P1 and the P3 have not been touched.
    // Nothing may start (the RAM guard is pinned), so the whole line stays
    // readable — which is the state the rule is about.
    parkAtGateC(SENT_BACK);

    const o = orch();
    await o.start();
    await waitFor('the gate to be scanned', () =>
      o.state().issues.some((r) => r.number === SENT_BACK && r.gate?.gate === 'C'),
    );

    // The real path: the operator's words, sent from the gate card, parked because
    // can run. `decision: 'feedback'` is what the /resume route sends for the
    // feedback box — decisions.ts: "`approved` moves the work on; `feedback`
    // sends it back".
    const out = await o.resume(SENT_BACK, 'step 3 has no screenshot — add it and show me', {
      decision: 'feedback',
    });
    expect(out.ok).toBe(true);
    expect(out.message).toContain('queued');

    o.enqueue(CHORE);
    o.enqueue(SECURITY);

    // P2, sent back, above the untouched P1 and P3.
    expect(o.state().queue).toEqual([SENT_BACK, SECURITY, CHORE]);
    expect(o.state().issues.find((r) => r.number === SENT_BACK)!.queuePosition).toBe(1);
    await o.stop();
  });

  it('does NOT lift a gate the operator APPROVED — that is progress, and it waits its band', async () => {
    // The discriminator, and the reason the mark is not simply "something is
    // parked on this issue": an approval parks in exactly the same place. If it
    // ranked the same way, every answered gate would outrank every unstarted P0
    // and the band would stop deciding anything.
    parkAtGateC(SENT_BACK);

    const o = orch();
    await o.start();
    await waitFor('the gate to be scanned', () =>
      o.state().issues.some((r) => r.number === SENT_BACK && r.gate?.gate === 'C'),
    );

    const out = await o.resume(SENT_BACK, 'looks right — carry on', { decision: 'approved' });
    expect(out.ok).toBe(true);

    o.enqueue(CHORE);
    o.enqueue(SECURITY);

    // Straight band order: the P1 leads, the approved P2 waits its turn.
    expect(o.state().queue).toEqual([SECURITY, SENT_BACK, CHORE]);
    await o.stop();
  });

  it('puts a FAILED QA STEP above every band — the sharpest send-back there is', async () => {
    // The path that reaches `resume` with no `decision` at all and therefore
    // records `'approved'` in the ledger. Inferring the queue's key from that
    // would rank the failed step as progress, so `qaRework` says `sentBack`
    // outright — and this is the test that holds it there.
    parkAtGateC(SENT_BACK);

    const o = orch();
    await o.start();
    await waitFor('the click-script to be scanned', () =>
      o.state().issues.some((r) => r.number === SENT_BACK && r.qaSteps.length === 1),
    );

    const ticked = await o.setQaVerdict(SENT_BACK, {
      stepId: 1,
      rev: 1,
      status: 'failed',
      note: 'the after screenshot is not there — the box is empty',
    });
    expect(ticked.ok).toBe(true);

    const sent = await o.qaRework(SENT_BACK);
    expect(sent.ok).toBe(true);
    expect(o.state().issues.find((r) => r.number === SENT_BACK)!.qaRework!.status).toBe('queued');

    o.enqueue(CHORE);
    o.enqueue(SECURITY);

    expect(o.state().queue).toEqual([SENT_BACK, SECURITY, CHORE]);
    await o.stop();
  });

  it('puts a ticket UAT sent back above every band, and says so on the row', async () => {
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(sentBackPayload());

    const o = orch();
    await o.start();
    await o.poll();
    await waitFor('the send-back to be derived', () => o.state().issues.some((r) => r.uatFail !== null));

    o.enqueue(CHORE);
    o.enqueue(SENT_BACK);
    o.enqueue(SECURITY);

    // P2, and it still goes before the P1 and the P3.
    expect(o.state().queue).toEqual([SENT_BACK, SECURITY, CHORE]);
    expect(o.state().issues.find((r) => r.number === SENT_BACK)!.queuePosition).toBe(1);
    await o.stop();
  });
});
