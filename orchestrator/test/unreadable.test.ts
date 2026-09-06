import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { deriveStatus } from '../src/status.js';
import { chipClass } from '../../ui/src/look.js';
import { ORANGE, STOPPED, courtOf } from '../../ui/src/priority.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { GateFile, PullRequest, ResourceReport } from '../src/types.js';

/**
 * THE INCIDENT OF 2026-09-05, and the sentence that made it one.
 *
 * The console was restarted. GitHub then rejected the expensive GraphQL query
 * behind `listRecentMergedPrs` — "API rate limit already exceeded" — while every
 * documented counter read full (graphql 5000/5000) and the cheap queries
 * answered fine: a query-cost limit, not the quota.
 *
 * `poll()` did exactly what it was written to do and fell back to the previous
 * merged map. Its own comment says why: "a flaky network must not resurrect the
 * checkpoint — stopped after stage 7 lie mid-session". But a RESTART has no
 * previous map. So 21 rows whose PRs had merged and were sitting in the QA lane
 * lost their PR entirely, `deriveStatus` fell through to the last branch, and
 * every one of them read "checkpoint — stopped after stage 8 — the worker ended
 * its turn without stopping at a gate". The operator called that badly wrong.
 * Nothing was wrong with any of the work.
 *
 * `pr: null` was carrying two meanings — "this issue has no pull request" and
 * "we could not look" — and the row asserted the first whenever it meant either.
 * These tests pin the second one being SAID rather than guessed at.
 */

const ISSUE = 4336;
const BRANCH = `fix/issue-${ISSUE}-demo`;
const PR = 4446;
const MERGED_AT = '2026-09-04T22:04:00Z';

let repo: string;
let worktree: string;
let home: string;
let stateFile: string;

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

const mergedPr = (): PullRequest => ({
  number: PR,
  url: `https://github.com/example-org/example-repo/pull/${PR}`,
  state: 'MERGED',
  title: 'fix(pills): org sysadmin filter',
  isDraft: false,
  mergedAt: MERGED_AT,
});

/** The exact GitHub answer that caused it: a rejection with the quota full. */
const RATE_LIMITED = () => new Error('API rate limit already exceeded for installation ID 12345.');

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-unreadable-home-')));
  mkdirSync(join(home, '.claude'), { recursive: true });
  stateFile = join(home, 'state.json');

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-unreadable-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-demo`);
  git(['worktree', 'add', '-b', BRANCH, worktree, 'dev'], repo);
  // Stage 8: the work is through gate E and merged. The file is the only thing
  // on this machine that knows anything about it once GitHub goes quiet.
  writeFileSync(
    join(worktree, '.issue-state.md'),
    `# Issue ${ISSUE}\n\n**Stage reached**: 8\n**Dev-server port**: 8081\n`,
  );

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: ISSUE, title: 'Org sysadmin filter pills', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
  ]);
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map([[BRANCH, mergedPr()]]));
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(gh, 'listPrReviews').mockResolvedValue({ reviews: [], latestReviews: [], labels: [], commits: [] });
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
    checkedAt: new Date().toISOString(),
  } as ResourceReport);
});

afterEach(() => {
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
      RUNS_FILE: join(home, 'runs.jsonl'),
      STREAM_DIR: join(home, 'runs'),
      CANONICAL_CLAUDE_DIR: join(home, '.claude'),
      ACCOUNTS_FILE: join(home, 'accounts.json'),
      POLL_MS: '999999',
      RESOURCES_MS: '999999',
    }),
  );
}

const row = (o: Orchestrator) => o.state().issues.find((r) => r.number === ISSUE)!;

/** The console's own record that the last run exited cleanly at no gate — the
 *  half of the incident sentence that made 21 healthy rows read as dead ones. */
function recordACleanEndingWithNoGate() {
  writeFileSync(stateFile, JSON.stringify({ endedWithoutGate: { [ISSUE]: '2026-09-05T09:00:00Z' } }));
}

describe('a first poll that could not read the PR lists', () => {
  it('does NOT say the worker ended its turn without stopping at a gate', async () => {
    // THE INCIDENT, whole: a fresh console (no maps to fall back on), a merged
    // PR nobody can see, and a clean ending on record.
    recordACleanEndingWithNoGate();
    vi.mocked(gh.listRecentMergedPrs).mockRejectedValue(RATE_LIMITED());

    const o = orch();
    await o.start(); // start() polls once — and that poll is the failing one

    const r = row(o);
    expect(r.statusDetail).not.toContain('the worker ended its turn without stopping at a gate');
    expect(r.statusDetail).not.toContain('stopped after stage 8');
    expect(r.status).not.toBe('checkpoint');
    await o.stop();
  });

  it('says what actually happened, in both directions and neither', async () => {
    vi.mocked(gh.listRecentMergedPrs).mockRejectedValue(RATE_LIMITED());
    const o = orch();
    await o.start();

    const r = row(o);
    expect(r.status).toBe('unreadable');
    // "in full", because the branch covers two polls now: a list that could not
    // be read at all, and a capped REST fallback that read part of one. Neither
    // can place this row's PR. See `merged-rest-fallback.test.ts`.
    expect(r.statusDetail).toBe(
      "GitHub's PR lists were not read in full this poll, so this row cannot say where its PR stands — " +
        "and the stage below is the worktree's own, read off disk.",
    );
    // No invented certainty the other way either: it does not claim a PR.
    expect(r.pr).toBeNull();
    // And the stage is the file's, unmoved — `effectiveStage` only ever advances
    // on PR evidence, and there is none to advance it with.
    expect(r.stage).toBe(8);
    await o.stop();
  });

  it('names the failed read in the banner beside it, and freezes the read stamp', async () => {
    vi.mocked(gh.listRecentMergedPrs).mockRejectedValue(RATE_LIMITED());
    const o = orch();
    await o.start();

    const s = o.state();
    expect(s.pollError).toContain('gh pr list (merged) failed');
    expect(s.pollError).toContain('rate limit already exceeded');
    // The age on screen is the age of the DATA, never of the attempt.
    expect(s.lastPolledAt).toBeNull();
    await o.stop();
  });

  it('goes straight back to the truth the moment GitHub answers', async () => {
    recordACleanEndingWithNoGate();
    vi.mocked(gh.listRecentMergedPrs).mockRejectedValueOnce(RATE_LIMITED());
    const o = orch();
    await o.start();
    expect(row(o).status).toBe('unreadable');

    await o.poll(); // the mock is one-shot: this one reads
    const r = row(o);
    expect(r.status).toBe('pr-merged');
    expect(r.stage).toBe(9);
    expect(r.statusDetail).toContain(`PR #${PR} merged`);
    expect(o.state().pollError).toBeNull();
    await o.stop();
  });

  it('stays SILENT when the failed read has a map to fall back on', async () => {
    // The case the fallback was written for, and it is untouched: a read that
    // failed over an answer we already have keeps that answer, because the
    // previous answer is still the best one. Only an empty map is ignorance.
    const o = orch();
    await o.start();
    expect(row(o).status).toBe('pr-merged');

    vi.mocked(gh.listRecentMergedPrs).mockRejectedValue(new Error('gh: network is unreachable'));
    await o.poll();
    expect(row(o).status).toBe('pr-merged');
    expect(row(o).stage).toBe(9);
    await o.stop();
  });

  it('leaves a row that HAS a PR alone, however the poll went', async () => {
    // The open list answered and holds this branch, so the row knows where its
    // PR stands. Ignorance about one list is not ignorance about this row.
    const open: PullRequest = { number: 4499, url: 'u', state: 'OPEN', title: 't', isDraft: false, mergedAt: null };
    vi.mocked(gh.listOpenPrs).mockResolvedValue(new Map([[BRANCH, open]]));
    vi.mocked(gh.listRecentMergedPrs).mockRejectedValue(RATE_LIMITED());
    const o = orch();
    await o.start();

    expect(row(o).status).toBe('pr-open');
    // The banner still says the read failed — that is a fact about the console,
    // and it is true whether or not this particular row needed the answer.
    expect(o.state().pollError).toContain('gh pr list (merged) failed');
    await o.stop();
  });
});

/**
 * The precedence, unchanged. `unreadable` is the LAST branch on the worktree
 * path because every branch above it is something the console actually read, and
 * a fact beats an admission of ignorance.
 */
describe('what still outranks "we could not look"', () => {
  const base = {
    hasWorktree: true,
    isRunning: false,
    gate: null as GateFile | null,
    detached: false,
    queuePosition: null as number | null,
    lastError: null as string | null,
    pr: null as PullRequest | null,
    stage: 8,
    prsUnreadable: true,
  };

  const gateE: GateFile = {
    issue: ISSUE,
    gate: 'E',
    stage: 8,
    sessionId: null,
    stoppedAt: null,
    reportPath: null,
    summary: '',
    questions: [],
  };

  it('a gate — a person is waiting, and that is still true when GitHub is down', () => {
    expect(deriveStatus({ ...base, gate: gateE }).status).toBe('at-gate');
  });

  it('a live worker — the process is in the runner map, read locally', () => {
    expect(deriveStatus({ ...base, isRunning: true }).status).toBe('active');
  });

  it('a recorded failure — a failure is news', () => {
    expect(deriveStatus({ ...base, lastError: 'the worker crashed' }).status).toBe('failed');
  });

  it('a place in the queue — the console put it there itself', () => {
    expect(deriveStatus({ ...base, queuePosition: 2 }).status).toBe('queued');
  });

  it('a PR it did find, merged or open', () => {
    expect(deriveStatus({ ...base, pr: mergedPr() }).status).toBe('pr-merged');
    expect(deriveStatus({ ...base, pr: { ...mergedPr(), state: 'OPEN' } }).status).toBe('pr-open');
  });

  it('and with none of them, it says so instead of inventing a checkpoint', () => {
    const s = deriveStatus({ ...base, endedWithoutGate: true });
    expect(s.status).toBe('unreadable');
    expect(s.statusDetail).not.toContain('stopped');
  });

  it('claims no stage it does not have either', () => {
    const s = deriveStatus({ ...base, stage: null });
    expect(s.status).toBe('unreadable');
    expect(s.statusDetail).toContain('the worktree on disk records no stage either');
  });

  it('is not reached at all without a worktree — "no worktree yet" is a disk fact', () => {
    // It asserts nothing about a PR, so there is nothing there to correct.
    expect(deriveStatus({ ...base, hasWorktree: false }).status).toBe('no-worker');
  });
});

/**
 * WHY A SEVENTEENTH STATUS. Each existing candidate is an assertion about the
 * WORK, and every one of them is an assertion the console has just failed to be
 * able to make. These are the surfaces that would have carried the lie.
 */
describe('the row this produces on the page', () => {
  const row = (status: 'unreadable') => ({ status, uatFail: null, waiting: null, parked: null }) as never;

  it('does not shout: it is in neither list of what needs you', () => {
    // `checkpoint` is in STOPPED, which is what put 21 rows on the waiting-on-you
    // card with a "start it again" line under each.
    expect(ORANGE).not.toContain('unreadable');
    expect(STOPPED).not.toContain('unreadable');
  });

  it('does not climb the list, because nothing here is waiting on you', () => {
    // This file's own test for the tier: if the operator goes away for a week,
    // does this row move on its own? Yes — the next good poll replaces it.
    expect(courtOf({ status: 'unreadable', waiting: null })).toBe('elsewhere');
  });

  it('wears the ice chip, for the one thing that WAS read', () => {
    // A worktree exists and nothing is running in it — off disk, not off GitHub.
    // Grey would say "somebody else is moving it", which is precisely the claim
    // the console could not stand up.
    expect(chipClass(row('unreadable'))).toBe('held');
  });
});
