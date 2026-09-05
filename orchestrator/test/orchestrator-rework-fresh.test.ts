import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FANOUT_RULE, SKILLS_RULE, Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ResourceReport } from '../src/types.js';

/**
 * The rework round on an issue whose PR was made OUTSIDE the console: the
 * worktree, branch and PR exist, but no session does, so there is nothing to
 * resume. The fresh start spawns a NEW worker against the same worktree with the
 * skill's resume mode plus the brief, and stamps the round exactly as a resume
 * would — the history must not go quiet just because the session was not ours.
 */

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const ISSUE = 4342;
const BRANCH = `fix/issue-${ISSUE}-demo`;
const BRIEF = 'Handle the empty-array case in the filter pills.';

let repo: string;
let worktree: string;
let home: string;
let canonical: string;
let workDir: string;
let accountsFile: string;
let stateFile: string;

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

const review = (submittedAt: string, body: string) => ({
  author: { login: 'pr-swarm[bot]' },
  state: 'CHANGES_REQUESTED',
  submittedAt,
  body,
});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-home-')));
  canonical = join(home, '.claude');
  workDir = join(home, '.claude-work');
  mkdirSync(canonical, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  accountsFile = join(home, 'accounts.json');
  stateFile = join(home, 'state.json');

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-rework-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-demo`);
  git(['worktree', 'add', '-b', BRANCH, worktree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: ISSUE, title: 'Severa sync', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
  ]);
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(
    new Map([[BRANCH, { number: 4368, url: 'u', state: 'OPEN', title: 't', isDraft: false }]]),
  );
  // Merged PRs are read on every poll now (a merged PR used to vanish and the row
  // lied). Stubbed empty here so no test reaches the network.
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(gh, 'listPrReviews').mockResolvedValue({
    reviews: [review('2026-08-11T11:00:00Z', BRIEF)],
    latestReviews: [review('2026-08-11T11:00:00Z', BRIEF)],
    // The label is on and nothing has been pushed: the ask still stands.
    labels: ['changes-requested'],
    commits: [],
  });
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

const gateFile = () => join(worktree, '.gate.json');
const readGate = () => JSON.parse(readFileSync(gateFile(), 'utf8')) as Record<string, unknown>;
const row = (o: Orchestrator) => o.state().issues.find((r) => r.number === ISSUE)!;

describe('rework with no session to resume', () => {
  it('starts a fresh worker whose prompt is the skill resume mode plus the brief, and stamps the round', async () => {
    const o = orch();
    await o.start(); // the poll turns the CHANGES_REQUESTED review into a round

    const before = row(o);
    expect(before.status).toBe('rework');
    expect(before.sessionId).toBeNull(); // the PR was made outside the console
    expect(before.reviewBlock?.rounds[0]!.decision).toBeNull();

    const out = await o.reworkFresh(ISSUE, BRIEF);
    expect(out.ok).toBe(true);
    await waitFor('the fresh worker to reach its gate', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');

    // The spawn prompt is the assertion: resume mode, and the brief carried in.
    // This is a SPAWN, not a resume, so it also carries the fan-out rule — the
    // belt to the skill's braces, added after the 2026-08-11 crash. See
    // gate-prompt.test.ts for the other half of that rule: no resume ever gets it.
    expect(readGate().prompt).toBe(`/issue-pipeline ${ISSUE} resume\n\n${BRIEF}\n\n${FANOUT_RULE}\n\n${SKILLS_RULE}`);

    // The round is stamped exactly as the resume path stamps it, so history is
    // complete and the row has left 'rework'.
    const after = row(o);
    expect(after.reviewBlock).toBeNull();
    expect(after.reviewHistory).toHaveLength(1);
    expect(after.reviewHistory[0]!.decision).toBe(BRIEF);
    expect(after.reviewHistory[0]!.resumedAt).not.toBeNull();
    expect(after.reviewHistory[0]!.account).toBe('personal');

    // The work itself is untouched: same worktree, same branch, same PR.
    expect(after.worktree).toBe(worktree);
    expect(after.branch).toBe(BRANCH);
    expect(after.pr?.number).toBe(4368);
    expect(after.sessionId).not.toBeNull();
    await o.stop();
  });

  it('honours the account picker: the fresh worker runs in that account and the issue is stamped with it', async () => {
    writeFileSync(
      accountsFile,
      JSON.stringify({
        default: 'personal',
        accounts: [
          { name: 'personal', configDir: canonical },
          { name: 'work', configDir: workDir },
        ],
      }),
    );
    const o = orch();
    await o.start();

    expect((await o.reworkFresh(ISSUE, BRIEF, 'work')).ok).toBe(true);
    await waitFor('the fresh worker to reach its gate', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');

    expect(readGate().env_config_dir).toBe(workDir);
    expect(row(o).account).toBe('work');
    expect(row(o).reviewHistory[0]!.account).toBe('work');
    await o.stop();
  });

  it('refuses when there is no round waiting, an unknown account, or an empty brief', async () => {
    const o = orch();
    await o.start();

    expect((await o.reworkFresh(ISSUE, '   ')).message).toContain('needs a brief');
    expect((await o.reworkFresh(ISSUE, BRIEF, 'ghost')).message).toContain('unknown account');
    expect((await o.reworkFresh(9999, BRIEF)).message).toContain('no worktree');

    expect((await o.reworkFresh(ISSUE, BRIEF)).ok).toBe(true);
    await waitFor('the fresh worker to reach its gate', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');

    // The round is handled now; a second click has nothing to act on.
    const again = await o.reworkFresh(ISSUE, 'more changes');
    expect(again.ok).toBe(false);
    expect(again.message).toContain('no rework round waiting');
    await o.stop();
  });

  it('leaves the gate, state, and actionable review untouched when the selected Codex profile is not ready', async () => {
    const brokenCodex = join(home, '.codex-broken');
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
    const o = orch();
    await o.start();
    expect(row(o).status).toBe('rework');

    const gateBefore = '{"issue":4342,"gate":"C","sentinel":"keep me"}\n';
    writeFileSync(gateFile(), gateBefore);
    const stateBefore = readFileSync(stateFile, 'utf8');
    const reviewBefore = JSON.stringify(row(o).reviewBlock);

    const out = await o.reworkFresh(ISSUE, BRIEF, 'codex-broken');

    expect(out.ok).toBe(false);
    expect(out.message).toContain("Codex profile 'codex-broken' is not ready");
    expect(out.message).toContain('link-account.sh codex');
    expect(readFileSync(gateFile(), 'utf8')).toBe(gateBefore);
    expect(readFileSync(stateFile, 'utf8')).toBe(stateBefore);
    expect(JSON.stringify(row(o).reviewBlock)).toBe(reviewBefore);
    expect(row(o).reviewBlock?.rounds.at(-1)?.decision).toBeNull();
    expect(row(o).status).toBe('rework');
    await o.stop();
  });
});
