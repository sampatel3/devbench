import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
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

/**
 * A rework round must resolve ITSELF. The rework often happens somewhere other
 * than the console — in an interactive session, by hand — and an orange card for
 * an ask that was dealt with days ago is a card that lies. There is deliberately
 * no "mark handled" button: every signal here is read off the PR.
 *
 *  (a) the reviewer moved on;
 *  (b) the same reviewer asked again — old round out, new round in;
 *  (c) handled outside the console: label gone AND a commit after the ask.
 *
 * Nothing is ever deleted: the round stays in history with how it resolved.
 */

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const ISSUE = 4336;
const BRANCH = `fix/issue-${ISSUE}-demo`;
const REVIEWER = 'pr-swarm[bot]';
const ASKED_AT = '2026-08-11T11:00:00Z';
const ASK = 'Handle the empty-array case';

let repo: string;
let worktree: string;
let home: string;
let canonical: string;
let stateFile: string;
let accountsFile: string;

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

const review = (state: string, submittedAt: string, body = '') => ({
  author: { login: REVIEWER },
  state,
  submittedAt,
  body,
});

/** What `gh pr view` returns, for whatever the PR looks like in this test. */
function prLooksLike(o: {
  state?: string;
  submittedAt?: string;
  body?: string;
  labels?: string[];
  commits?: string[];
}) {
  const rv = review(o.state ?? 'CHANGES_REQUESTED', o.submittedAt ?? ASKED_AT, o.body ?? ASK);
  vi.mocked(gh.listPrReviews).mockResolvedValue({
    reviews: [rv],
    latestReviews: [rv],
    labels: o.labels ?? ['changes-requested'],
    commits: (o.commits ?? []).map((committedDate) => ({ committedDate })),
  });
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-home-')));
  canonical = join(home, '.claude');
  mkdirSync(canonical, { recursive: true });
  stateFile = join(home, 'state.json');
  accountsFile = join(home, 'accounts.json');

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-resolve-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-demo`);
  git(['worktree', 'add', '-b', BRANCH, worktree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: ISSUE, title: 'Filter pills', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
  ]);
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(
    new Map([[BRANCH, { number: 4446, url: 'u', state: 'OPEN', title: 't', isDraft: false }]]),
  );
  // Merged PRs are read on every poll now (a merged PR used to vanish and the row
  // lied). Stubbed empty here so no test reaches the network.
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(gh, 'listPrReviews').mockResolvedValue({ reviews: [], latestReviews: [], labels: [], commits: [] });
  prLooksLike({});
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
  // FIRST, and unconditionally: a worker is a real detached process, and a test
  // that fails an assertion never reaches its own cleanup.
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
      ACCOUNTS_FILE: accountsFile,
      CANONICAL_CLAUDE_DIR: canonical,
      CLAUDE_BIN: STUB,
      POLL_MS: '999999',
    }),
  );
}

const row = (o: Orchestrator) => o.state().issues.find((r) => r.number === ISSUE)!;

describe('a rework round resolves itself', () => {
  it('(a) clears when the reviewer moves on — their latest review is APPROVED now', async () => {
    const o = orch();
    await o.start(); // the ask becomes an actionable round
    expect(row(o).status).toBe('rework');

    prLooksLike({ state: 'APPROVED', submittedAt: '2026-08-12T09:00:00Z', body: 'good now' });
    await o.poll();

    const after = row(o);
    expect(after.status).not.toBe('rework');
    expect(after.reviewBlock).toBeNull(); // no card, nothing to click
    expect(after.reviewHistory).toHaveLength(1); // and nothing deleted
    expect(after.reviewHistory[0]!.resolvedBy).toBe('superseded');
    expect(after.reviewHistory[0]!.resolution).toContain('APPROVED');
    expect(after.reviewHistory[0]!.resolvedAt).not.toBeNull();
    await o.stop();
  });

  it('(a) does NOT clear on a later COMMENTED review — GitHub keeps the ask standing', async () => {
    // The live bug this pins: pr-swarm requested changes, then posted a
    // COMMENTED review. GitHub does not let a comment dismiss a changes-request
    // — the PR still reads "1 requested change" and merging stays blocked — so
    // the console must keep the round actionable instead of reporting all clear.
    const o = orch();
    await o.start();
    expect(row(o).status).toBe('rework');

    prLooksLike({ state: 'COMMENTED', submittedAt: '2026-08-12T09:00:00Z', body: 'some notes' });
    await o.poll();

    const after = row(o);
    expect(after.status).toBe('rework'); // still orange
    expect(after.reviewBlock).not.toBeNull(); // the card stays
    expect(after.reviewHistory).toHaveLength(1);
    expect(after.reviewHistory[0]!.resolvedBy ?? null).toBeNull();
    await o.stop();
  });

  it('(b) a newer change-request from the same reviewer supersedes the old round and opens a new one', async () => {
    const o = orch();
    await o.start();

    prLooksLike({ submittedAt: '2026-08-12T15:00:00Z', body: 'Now fix the loading state too' });
    await o.poll();

    const after = row(o);
    expect(after.reviewHistory).toHaveLength(2);

    const [first, second] = after.reviewHistory;
    expect(first!.resolvedBy).toBe('superseded');
    expect(first!.resolution).toContain('2026-08-12');
    expect(second!.round).toBe(2);
    expect(second!.requestedChanges).toContain('loading state');
    expect(second!.resolvedBy ?? null).toBeNull(); // the new ask is the live one

    // Orange returns, for the new ask — not the old one.
    expect(after.status).toBe('rework');
    expect(after.reviewBlock?.rounds).toHaveLength(2);
    await o.stop();
  });

  it('(c) clears when the label is gone AND a commit lands after the ask', async () => {
    const o = orch();
    await o.start();
    expect(row(o).status).toBe('rework');

    prLooksLike({ labels: [], commits: ['2026-08-11T12:30:00Z'] });
    await o.poll();

    const after = row(o);
    expect(after.status).not.toBe('rework');
    expect(after.reviewBlock).toBeNull();
    expect(after.reviewHistory).toHaveLength(1);
    expect(after.reviewHistory[0]!.resolvedBy).toBe('external');
    expect(after.reviewHistory[0]!.resolution).toContain('outside the console');
    await o.stop();
  });

  it('(c) does NOT clear on the label alone — nothing has been pushed', async () => {
    const o = orch();
    await o.start();

    prLooksLike({ labels: [], commits: [] });
    await o.poll();

    expect(row(o).status).toBe('rework');
    expect(row(o).reviewHistory[0]!.resolvedBy ?? null).toBeNull();
    await o.stop();
  });

  it('(c) does NOT clear on commits alone — the label still says nothing was pushed', async () => {
    const o = orch();
    await o.start();

    prLooksLike({ labels: ['changes-requested'], commits: ['2026-08-11T12:30:00Z'] });
    await o.poll();

    expect(row(o).status).toBe('rework');
    expect(row(o).reviewHistory[0]!.resolvedBy ?? null).toBeNull();
    await o.stop();
  });

  it('a commit from BEFORE the ask does not count as the rework, label or no label', async () => {
    const o = orch();
    await o.start();

    prLooksLike({ labels: [], commits: ['2026-08-10T09:00:00Z'] });
    await o.poll();

    expect(row(o).status).toBe('rework');
    await o.stop();
  });
});

describe('the operator starting the rework themselves is unchanged', () => {
  /** A round persisted before auto-resolution existed: no resolvedBy, no
   *  resolvedAt, no resolution — and a session id, as if they had run it here. */
  const OLD_STATE = {
    exitMtimes: {},
    lastErrors: {},
    sessions: { [String(ISSUE)]: '11111111-2222-3333-4444-555555555555' },
    commentBlocks: {},
    reviewBlocks: {
      [String(ISSUE)]: {
        pr: 4446,
        rounds: [
          {
            round: 1,
            reviewer: REVIEWER,
            requestedAt: ASKED_AT,
            requestedChanges: ASK,
            decision: null,
            resumedAt: null,
          },
        ],
      },
    },
    accountByIssue: {},
  };

  it('parses a round written before these fields existed, and still stamps it on resume', async () => {
    writeFileSync(stateFile, JSON.stringify(OLD_STATE, null, 2));
    const o = orch();
    await o.start();

    // The old round loads and reads exactly as it did: waiting on the operator.
    const before = row(o);
    expect(before.status).toBe('rework');
    expect(before.reviewHistory).toHaveLength(1);
    expect(before.reviewHistory[0]!.requestedChanges).toBe(ASK);

    expect((await o.resume(ISSUE, 'Fix the empty-array case.')).ok).toBe(true);
    await waitFor('the resumed worker to run', () => existsSync(join(worktree, 'resumed.txt')));
    await waitFor('the round to be stamped', () => row(o).reviewBlock === null);

    const after = row(o).reviewHistory[0]!;
    expect(after.decision).toBe('Fix the empty-array case.'); // as before
    expect(after.resumedAt).not.toBeNull(); // as before
    expect(after.account).toBe('personal'); // as before
    expect(after.resolvedBy).toBe('operator'); // and now says who resolved it
    await o.stop();
  });
});
