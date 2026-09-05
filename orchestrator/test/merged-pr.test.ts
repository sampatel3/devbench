import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FANOUT_RULE, SKILLS_RULE, Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { deriveStatus, effectiveStage, needsOperator } from '../src/status.js';
import { resolveRound } from '../src/review.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as comment from '../src/comment.js';
import * as resources from '../src/resources.js';
import type { PullRequest, ResourceReport } from '../src/types.js';

/**
 * The lie this file exists to end.
 *
 * `listOpenPrs` was the only way the console learned about a PR, so the instant
 * one merged it vanished: the row's `pr` went null, `effectiveStage` fell back to
 * whatever `.issue-state.md` last said, and finished work rendered as
 * "checkpoint — stopped after stage 7". On 2026-08-11 three issues read exactly
 * that way, behind PRs #4368, #4446 and #4466 — all merged. A rework round left
 * open on any of them would have sat orange for ever, because a
 * CHANGES_REQUESTED review's state does not change when a PR merges.
 */

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const ISSUE = 4336;
const BRANCH = `fix/issue-${ISSUE}-demo`;
const PR = 4446;
const MERGED_AT = '2026-08-11T22:04:00Z';

let repo: string;
let worktree: string;
let home: string;
let canonical: string;
let stateFile: string;
let runsFile: string;
let streamDir: string;

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

const mergedPr = (): PullRequest => ({
  number: PR,
  url: `https://github.com/example-org/example-repo/pull/${PR}`,
  state: 'MERGED',
  title: 'fix(pills): org sysadmin filter',
  isDraft: false,
  mergedAt: MERGED_AT,
});

const review = (submittedAt: string) => ({
  author: { login: 'pr-swarm[bot]' },
  state: 'CHANGES_REQUESTED',
  submittedAt,
  body: 'Please narrow the predicate.',
});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-home-')));
  canonical = join(home, '.claude');
  mkdirSync(canonical, { recursive: true });
  stateFile = join(home, 'state.json');
  runsFile = join(home, 'runs.jsonl');
  streamDir = join(home, 'runs');

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-merged-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-demo`);
  git(['worktree', 'add', '-b', BRANCH, worktree, 'dev'], repo);
  // The worker's own stale note to itself — the file the row used to believe.
  writeFileSync(join(worktree, '.issue-state.md'), `# Issue ${ISSUE}\n\nStage: 7\nPort: 8081\n`);

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
  killSpawnedWorkers(stateFile);
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
      STREAM_DIR: streamDir,
      STREAM_POLL_MS: '25',
      CANONICAL_CLAUDE_DIR: canonical,
      CLAUDE_BIN: STUB,
      POLL_MS: '999999',
      ...env,
    }),
  );
}

const row = (o: Orchestrator) => o.state().issues.find((r) => r.number === ISSUE)!;

describe('the row follows the work once its PR merges', () => {
  it('reads stage 9 and "merged" instead of a checkpoint that stopped after stage 7', async () => {
    const o = orch();
    await o.start();

    const r = row(o);
    expect(r.status).toBe('pr-merged');
    expect(r.stage).toBe(9);
    expect(r.statusDetail).toContain(`PR #${PR} merged`);
    expect(r.pr).toMatchObject({ number: PR, state: 'MERGED', mergedAt: MERGED_AT });
    // The old behaviour, named so a regression is unmistakable.
    expect(r.statusDetail).not.toContain('stopped after stage 7');
    await o.stop();
  });

  it('is NOT orange — merged work is a state with an action, not a demand', () => {
    expect(needsOperator('pr-merged')).toBe(false);
    const { status } = deriveStatus({
      hasWorktree: true,
      isRunning: false,
      gate: null,
      detached: false,
      queuePosition: null,
      lastError: null,
      pr: mergedPr(),
      stage: 9,
    });
    expect(status).toBe('pr-merged');
  });

  it('lets an OPEN PR on the same branch win — a reused branch is live work, not history', async () => {
    const open: PullRequest = { number: 4499, url: 'u', state: 'OPEN', title: 't', isDraft: false, mergedAt: null };
    vi.mocked(gh.listOpenPrs).mockResolvedValue(new Map([[BRANCH, open]]));
    const o = orch();
    await o.start();
    expect(row(o).pr).toMatchObject({ number: 4499, state: 'OPEN' });
    expect(row(o).status).toBe('pr-open');
    expect(row(o).stage).toBe(7);
    await o.stop();
  });

  it('keeps the last merged map when the fetch fails — a flaky network must not bring the lie back', async () => {
    const o = orch();
    await o.start();
    expect(row(o).status).toBe('pr-merged');

    vi.mocked(gh.listRecentMergedPrs).mockRejectedValue(new Error('gh: network is unreachable'));
    await o.poll();
    expect(row(o).status).toBe('pr-merged');
    expect(row(o).stage).toBe(9);
    await o.stop();
  });

  it('moves the stage forward and never back', () => {
    expect(effectiveStage({ fileStage: 5, pr: mergedPr() })).toBe(9);
    expect(effectiveStage({ fileStage: 9, pr: { ...mergedPr(), state: 'OPEN' } })).toBe(9);
  });
});

describe('a rework round that the merge overtook', () => {
  it('resolves as external with the plain reason, and never as still-waiting', () => {
    const round = {
      round: 1,
      reviewer: 'pr-swarm[bot]',
      requestedAt: '2026-08-11T11:00:00Z',
      requestedChanges: 'x',
      decision: null,
      resumedAt: null,
    };
    // Nothing about the reviews changed — that is exactly the problem this fixes.
    const signals = { latestReviews: [review('2026-08-11T11:00:00Z')], labels: ['changes-requested'], commits: [] };
    expect(resolveRound(round, signals)).toBeNull();
    expect(resolveRound(round, signals, 'MERGED')).toEqual({
      resolvedBy: 'external',
      resolution: 'the PR merged with this round open — overtaken by events',
    });
  });

  it('clears the orange card on a real row once the poll sees the merge', async () => {
    // First poll: the PR is open with a change-request, so a round opens.
    vi.mocked(gh.listOpenPrs).mockResolvedValue(
      new Map([[BRANCH, { number: PR, url: 'u', state: 'OPEN', title: 't', isDraft: false, mergedAt: null }]]),
    );
    vi.mocked(gh.listPrReviews).mockResolvedValue({
      reviews: [review('2026-08-11T11:00:00Z')],
      latestReviews: [review('2026-08-11T11:00:00Z')],
      labels: ['changes-requested'],
      commits: [],
    });
    const o = orch();
    await o.start();
    expect(row(o).status).toBe('rework');

    // It merges. The reviews are untouched — GitHub does not clear them.
    vi.mocked(gh.listOpenPrs).mockResolvedValue(new Map());
    await o.poll();

    const r = row(o);
    expect(r.status).toBe('pr-merged');
    expect(r.reviewBlock).toBeNull(); // no longer actionable
    expect(r.reviewHistory).toHaveLength(1); // and never deleted
    expect(r.reviewHistory[0]!.resolvedBy).toBe('external');
    expect(r.reviewHistory[0]!.resolution).toContain('overtaken by events');
    await o.stop();
  });

  it('opens no NEW round on a merged PR, however loud the reviews still are', async () => {
    vi.mocked(gh.listPrReviews).mockResolvedValue({
      reviews: [review('2026-08-11T23:00:00Z')],
      latestReviews: [review('2026-08-11T23:00:00Z')],
      labels: ['changes-requested'],
      commits: [],
    });
    const o = orch();
    await o.start();
    expect(row(o).reviewBlock).toBeNull();
    expect(row(o).reviewHistory).toHaveLength(0);
    expect(row(o).status).toBe('pr-merged');
    await o.stop();
  });

  /**
   * The half that actually empties the waiting-on-you count. `#checkReviews`
   * used to walk the OPEN ISSUES, so an issue that closed behind its merge could
   * never be re-examined and its synthetic worktree row stayed orange for ever.
   * It walks the tracked worktrees now.
   */
  it('resolves the round on a worktree whose issue has already CLOSED', async () => {
    vi.mocked(gh.listOpenPrs).mockResolvedValue(
      new Map([[BRANCH, { number: PR, url: 'u', state: 'OPEN', title: 't', isDraft: false, mergedAt: null }]]),
    );
    vi.mocked(gh.listPrReviews).mockResolvedValue({
      reviews: [review('2026-08-11T11:00:00Z')],
      latestReviews: [review('2026-08-11T11:00:00Z')],
      labels: ['changes-requested'],
      commits: [],
    });
    const o = orch();
    await o.start();
    expect(row(o).status).toBe('rework');

    // The PR merges AND the issue closes — it drops off the assigned list.
    vi.mocked(gh.listOpenPrs).mockResolvedValue(new Map());
    vi.mocked(gh.listIssues).mockResolvedValue([]);
    await o.poll();

    const synthetic = row(o); // the worktree still deserves a row
    expect(synthetic.title).toContain('worktree with no matching open issue');
      // CLOSED, so `done` — not `pr-merged`. Stage 9 exists to get an issue to QA
      // and closed; once QA has closed it there is nothing left to ask for. #4336
      // read "stage 9 post-merge" six hours after QA posted a full pass, with a
      // card asking the operator to do work QA had already done.
      expect(synthetic.status).toBe('done');
      expect(synthetic.statusDetail).toContain('QA signed it off');
    expect(synthetic.reviewBlock).toBeNull();
    expect(o.state().issues.filter((x) => needsOperator(x.status))).toHaveLength(0);
    await o.stop();
  });
});

describe('Stage 9 — the handoff, and the write fence around it', () => {
  it('resumes the existing session with byte-exactly what the card sent', async () => {
    const o = orch();
    await o.start();
    // Give the worktree a session to resume, the way a real run leaves one.
    const sessionId = '11111111-2222-3333-4444-555555555555';
    writeFileSync(
      join(worktree, '.gate.json'),
      JSON.stringify({ issue: ISSUE, gate: 'E', stage: 8, sessionId, summary: 's', questions: [] }),
    );
    await o.poll();

    const prompt = `PR #${PR} for issue #${ISSUE} merged into dev at ${MERGED_AT}. Run Stage 9 (post-merge): move the board card, choose and justify the verification path, and draft the QA ready-to-verify comment for issue #${ISSUE}. Do NOT post the comment yourself — write it as .comment-request.json and stop, as the comment path requires.`;
    expect((await o.postMergeStart(ISSUE, prompt)).ok).toBe(true);
    await waitFor('the resume to land', () => existsSync(join(worktree, 'resumed.txt')));

    const said = readFileSync(join(worktree, 'resumed.txt'), 'utf8');
    // Byte-exact, and no fan-out suffix: a resume is the operator's words and
    // nothing else.
    expect(said).toContain(`resumed with: ${prompt}\n`);
    expect(said).not.toContain(FANOUT_RULE);
    // The style rule is a standing rule too, and standing rules never touch a resume.
    expect(said).not.toContain(SKILLS_RULE);
    await o.stop();
  });

  it('spawns a fresh worker in resume mode when there is no session to pick up', async () => {
    const o = orch();
    await o.start();
    expect(row(o).sessionId).toBeNull();

    expect((await o.postMergeStart(ISSUE, 'Run Stage 9 please.')).ok).toBe(true);
    await waitFor('the fresh worker to reach its gate', () => existsSync(join(worktree, '.gate.json')));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');

    const gate = JSON.parse(readFileSync(join(worktree, '.gate.json'), 'utf8')) as { prompt: string };
    // A SPAWN, so it carries the fan-out rule; a resume never would.
    expect(gate.prompt).toBe(`/issue-pipeline ${ISSUE} resume\n\nRun Stage 9 please.\n\n${FANOUT_RULE}\n\n${SKILLS_RULE}`);
    await o.stop();
  });

  it('refuses an empty instruction rather than resuming a worker with nothing to do', async () => {
    const o = orch();
    await o.start();
    expect((await o.postMergeStart(ISSUE, '   ')).ok).toBe(false);
    await o.stop();
  });

  it('leaves Stage 9 actionable and preserves state and gate bytes when the selected Codex profile is not ready', async () => {
    const brokenCodex = join(home, '.codex-broken');
    const accountsFile = join(home, 'accounts.json');
    mkdirSync(brokenCodex, { recursive: true });
    writeFileSync(
      accountsFile,
      JSON.stringify({
        default: 'personal',
        accounts: [
          { name: 'personal', provider: 'claude', configDir: canonical },
          { name: 'codex-broken', provider: 'codex', configDir: brokenCodex },
        ],
      }),
    );
    const o = orch({
      ACCOUNTS_FILE: accountsFile,
      CANONICAL_CODEX_DIR: join(home, '.codex'),
      CODEX_BIN: '/not-used/codex',
    });
    await o.start();
    expect(row(o)).toMatchObject({ status: 'pr-merged', sessionId: null });

    const gateFile = join(worktree, '.gate.json');
    const gateBefore = '{"issue":4336,"gate":"E","sentinel":"keep me"}\n';
    writeFileSync(gateFile, gateBefore);
    const stateBefore = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null;

    const out = await o.postMergeStart(ISSUE, 'Run Stage 9 please.', 'codex-broken');

    expect(out.ok).toBe(false);
    expect(out.message).toContain("Codex profile 'codex-broken' is not ready");
    expect(out.message).toContain('link-account.sh codex');
    expect(readFileSync(gateFile, 'utf8')).toBe(gateBefore);
    expect(existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null).toBe(stateBefore);
    expect(row(o)).toMatchObject({ status: 'pr-merged', sessionId: null });
    await o.stop();
  });

  /**
   * THE FENCE. The skill's Stage 9 tells a worker to post the ready-to-verify
   * comment on the issue. A console worker may not: `postComment` remains the
   * only path that writes to GitHub, and it only runs on the operator's click.
   */
  it('writes nothing to GitHub anywhere in the flow', async () => {
    const writes: string[][] = [];
    vi.spyOn(comment, 'postIssueComment').mockImplementation(async (...args) => {
      writes.push(args.map(String));
      return { ok: false, error: 'a test must never post' };
    });
    const o = orch();
    await o.start();
    await o.postMergeStart(ISSUE, 'Run Stage 9 please.');
    await waitFor('the worker to finish', () => row(o).status === 'at-gate');
    expect(writes).toEqual([]);
    await o.stop();
  });
});
