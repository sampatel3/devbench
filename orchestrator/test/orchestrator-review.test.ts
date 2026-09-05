import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import { memoryOk } from './fixtures/memory.js';

/**
 * The rework loop at the orchestrator level: an open PR whose review REQUESTS
 * CHANGES surfaces as an actionable 'rework' round, keyed off the issue→branch→PR
 * map, read-only. A repeat poll must not pile up duplicate rounds.
 */
let repo: string;
let worktree: string;
const BRANCH = 'fix/issue-4342-demo';

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

const review = (state: string, submittedAt: string, body = '') => ({
  author: { login: 'pr-swarm[bot]' },
  state,
  submittedAt,
  body,
});

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wc-rev-'));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  worktree = join(repo, '.worktrees', 'issue-4342-demo');
  git(['worktree', 'add', '-b', BRANCH, worktree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: 4342, title: 'Severa sync', url: 'u', labels: ['bug'], updatedAt: 'z', author: 'operator' },
  ]);
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(
    new Map([[BRANCH, { number: 4368, url: 'u', state: 'OPEN', title: 't', isDraft: false }]]),
  );
  // Merged PRs are read on every poll now (a merged PR used to vanish and the row
  // lied). Stubbed empty here so no test reaches the network.
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(gh, 'listPrReviews').mockResolvedValue({
    reviews: [review('CHANGES_REQUESTED', '2026-08-11T11:00:00Z', 'Handle the empty-array case')],
    latestReviews: [review('CHANGES_REQUESTED', '2026-08-11T11:00:00Z', 'Handle the empty-array case')],
    // The label is on and nothing has been pushed: the ask still stands.
    labels: ['changes-requested'],
    commits: [],
  });
  // The machine is stubbed for the same reason the network is: unstubbed, every
  // poll shelled out to the real `docker stats`, `memory_pressure` and `vm_stat`.
  vi.spyOn(resources, 'probeResources').mockResolvedValue(memoryOk());
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function orch() {
  const cfg = loadConfig({
    REPO_PATH: repo,
    REPO: 'example-org/example-repo',
    STATE_FILE: join(repo, 'state.json'),
    POLL_MS: '999999',
  });
  return new Orchestrator(cfg);
}

describe('a change-requested review surfaces as actionable rework', () => {
  it('a poll turns the open PR into a rework round waiting on the operator', async () => {
    const o = orch();
    await o.start(); // polls, runs #checkReviews

    const row = o.state().issues.find((r) => r.number === 4342)!;
    expect(row.status).toBe('rework');
    expect(row.statusDetail).toContain('pr-swarm[bot]');
    expect(row.reviewBlock?.pr).toBe(4368);
    expect(row.reviewBlock?.rounds).toHaveLength(1);
    expect(row.reviewHistory).toHaveLength(1);
    expect(row.reviewHistory[0]!.requestedChanges).toContain('empty-array');
    expect(row.reviewHistory[0]!.decision).toBeNull();
    await o.stop();
  });

  it('a repeat poll does not pile up a duplicate round for the same review', async () => {
    const o = orch();
    await o.start();
    await o.poll();
    await o.poll();

    const row = o.state().issues.find((r) => r.number === 4342)!;
    expect(row.reviewHistory).toHaveLength(1);
    await o.stop();
  });

  it('no rework round appears while the review is only APPROVED', async () => {
    vi.mocked(gh.listPrReviews).mockResolvedValue({
      reviews: [review('APPROVED', '2026-08-11T11:00:00Z', 'ship it')],
      latestReviews: [review('APPROVED', '2026-08-11T11:00:00Z', 'ship it')],
      labels: [],
      commits: [],
    });
    const o = orch();
    await o.start();

    const row = o.state().issues.find((r) => r.number === 4342)!;
    expect(row.status).toBe('pr-open');
    expect(row.reviewBlock).toBeNull();
    expect(row.reviewHistory).toHaveLength(0);
    await o.stop();
  });
});
