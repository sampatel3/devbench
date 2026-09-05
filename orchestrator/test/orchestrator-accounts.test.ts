import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  utimesSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import { branchNameFor, worktreeDirFor } from '../src/naming.js';
import { sessionDir } from '../src/worker.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ResourceReport } from '../src/types.js';

/**
 * The account boundary, end to end: which config dir a worker actually spawns
 * with, that a resume stays in the same one, that transcript scanning looks in
 * the right account, and that a restart-fresh is the only way to move an issue.
 * `claude` is the stub worker throughout — a test that needs a model to think is
 * not a test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const ISSUE = 4336;

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

/** Poll until a condition holds — the dispatch loop is fire-and-forget. */
async function waitFor(what: string, fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Poll until a condition holds. A poll already in flight is a no-op, so ask again. */
async function pollUntil(o: Orchestrator, what: string, fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await o.poll();
    if (fn()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function writeAccounts(def = 'personal') {
  writeFileSync(
    accountsFile,
    JSON.stringify({
      default: def,
      accounts: [
        { name: 'personal', configDir: canonical },
        { name: 'work', configDir: workDir },
      ],
    }),
  );
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-home-')));
  canonical = join(home, '.claude');
  workDir = join(home, '.claude-work');
  mkdirSync(canonical, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  accountsFile = join(home, 'accounts.json');
  stateFile = join(home, 'state.json');

  // realpath: on macOS /tmp is a symlink, and `git worktree list` reports the
  // resolved path — so must the paths this test compares against.
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-orch-acct-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-demo`);
  git(['worktree', 'add', '-b', `fix/issue-${ISSUE}-demo`, worktree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: ISSUE, title: 'Org sysadmin filter pills', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
  ]);
  // Merged PRs are read on every poll now (a merged PR used to vanish from the
  // console and the row lied). Stubbed empty so no test reaches the network.
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  // The RAM guard reads the real machine; pin it so dispatch is deterministic.
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
const rowOf = (o: Orchestrator, n: number) => o.state().issues.find((r) => r.number === n)!;
const row = (o: Orchestrator) => rowOf(o, ISSUE);

/** The transcript Claude Code would have written, in a given account's dir. */
function fakeTranscript(configDir: string, sessionId: string): string {
  const dir = sessionDir(worktree, configDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, '{"type":"user"}\n');
  return file;
}

describe('spawning under a chosen account', () => {
  it('runs claude with that account CLAUDE_CONFIG_DIR, and says so on the row', async () => {
    writeAccounts();
    const o = orch();
    await o.start();

    expect(o.state().accounts.map((a) => a.name)).toEqual(['personal', 'work']);
    expect(o.enqueue(ISSUE, 'work').ok).toBe(true);
    await waitFor('the worker to stop at its gate', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');

    // The spawn env is the assertion: the child really ran in the work account.
    expect(readGate().env_config_dir).toBe(workDir);

    const r = row(o);
    expect(r.account).toBe('work');
    expect(r.accountLocked).toBe(true);
    expect(r.resumeCommand).toContain(`CLAUDE_CONFIG_DIR='${workDir}'`);
    expect(r.resumeCommand).toContain("stub-worker.mjs' --resume");
    await o.stop();
  });

  it('resumes that worker in the same account dir', async () => {
    writeAccounts();
    const o = orch();
    await o.start();
    o.enqueue(ISSUE, 'work');
    await waitFor('a gate', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');

    const out = await o.resume(ISSUE, 'Gate C approved, proceed.');
    expect(out.ok).toBe(true);
    await waitFor('the resume to land', () => existsSync(join(worktree, 'resumed.txt')));
    expect(readFileSync(join(worktree, 'resumed.txt'), 'utf8')).toContain(`config dir: ${workDir}`);
    await o.stop();
  });

  it('refuses to change account while a session exists, and names the way out', async () => {
    writeAccounts();
    const o = orch();
    await o.start();
    o.enqueue(ISSUE, 'work');
    await waitFor('a gate', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');

    const out = o.enqueue(ISSUE, 'personal');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('cannot move between accounts');
    expect(out.message).toContain('Restart fresh under personal');
    expect(row(o).account).toBe('work');
    await o.stop();
  });
});

describe('the account chosen on the create-worktree card', () => {
  const OTHER = 4344;
  const OTHER_TITLE = 'Save and Exit on Quote Preview';
  const otherBranch = () => branchNameFor({ number: OTHER, title: OTHER_TITLE, labels: [] });
  const otherWorktree = () => join(repo, '.worktrees', worktreeDirFor(otherBranch()));

  /**
   * The issue the operator actually hit this on: assigned, no worktree, so the create card
   * is the whole first screen. The repo's own worktree script stands in as a
   * two-line stub, and `npm install` runs for real against a package.json with no
   * dependencies — offline, and over in a moment.
   */
  function anIssueWithNoWorktree() {
    vi.mocked(gh.listIssues).mockResolvedValue([
      { number: ISSUE, title: 'Org sysadmin filter pills', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
      { number: OTHER, title: OTHER_TITLE, url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
    ]);
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(
      join(repo, 'scripts', 'git-new-worktree.sh'),
      `#!/bin/sh\nset -e\ngit worktree add -b "$1" ".worktrees/${worktreeDirFor(otherBranch())}" dev\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'stub', version: '1.0.0', private: true }));
    git(['add', 'package.json'], repo);
    git(['commit', '-m', 'package.json'], repo);
  }

  it(
    'is the account the first worker actually spawns under',
    async () => {
      writeAccounts();
      anIssueWithNoWorktree();
      const o = orch();
      await o.start();

      const out = await o.createWorktree(OTHER, 'work');
      expect(out.ok).toBe(true);
      expect(out.message).toContain('under work');

      // Stamped before anything has run, so the row says which account it is for
      // rather than "never stamped" — and it is NOT locked, because there is no
      // session yet.
      expect(rowOf(o, OTHER).account).toBe('work');
      expect(rowOf(o, OTHER).accountLocked).toBe(false);

      await pollUntil(o, 'the worktree to be provisioned', () => rowOf(o, OTHER).status === 'checkpoint', 60_000);

      // The start card sends no account when the picker is left alone, so the
      // stamp is the only thing carrying the choice into the spawn.
      expect(o.enqueue(OTHER).ok).toBe(true);
      await waitFor('the worker to stop at its gate', () => existsSync(join(otherWorktree(), '.gate.json')));

      const gate = JSON.parse(readFileSync(join(otherWorktree(), '.gate.json'), 'utf8')) as Record<string, unknown>;
      expect(gate.env_config_dir).toBe(workDir);
      await o.stop();
    },
    90_000,
  );

  it('refuses an account that is not registered, and provisions nothing', async () => {
    writeAccounts();
    anIssueWithNoWorktree();
    const o = orch();
    await o.start();

    const out = await o.createWorktree(OTHER, 'ghost');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('unknown account');
    expect(existsSync(otherWorktree())).toBe(false);
    await o.stop();
  });

  it('restores an existing issue branch and lets the worker continue instead of holding a failed row', async () => {
    writeAccounts();
    anIssueWithNoWorktree();
    const seed = join(repo, '.existing-branch-seed');
    git(['worktree', 'add', '-b', otherBranch(), seed, 'dev'], repo);
    writeFileSync(join(seed, 'existing-work.txt'), 'keep this exact branch work\n');
    git(['add', 'existing-work.txt'], seed);
    git(['commit', '-m', 'existing branch work'], seed);
    git(['worktree', 'remove', seed], repo);
    // Mirror a branch whose remote was deleted after merge: recovery must not
    // silently rewrite even stale upstream metadata.
    git(['config', `branch.${otherBranch()}.remote`, 'origin'], repo);
    git(['config', `branch.${otherBranch()}.merge`, `refs/heads/${otherBranch()}`], repo);
    const existingHead = execFileSync('git', ['rev-parse', otherBranch()], { cwd: repo, encoding: 'utf8' }).trim();
    const existingUpstream = execFileSync(
      'git',
      ['config', '--get-regexp', `^branch\\.${otherBranch().replaceAll('.', '\\.')}\\.(remote|merge)$`],
      { cwd: repo, encoding: 'utf8' },
    );
    const primaryHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const primaryBranch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();

    const o = orch();
    await o.start();

    expect((await o.createWorktree(OTHER, 'work')).ok).toBe(true);
    await waitFor('the branch collision to surface', () => rowOf(o, OTHER).status === 'failed');
    expect(rowOf(o, OTHER).statusDetail).toContain(`branch ${otherBranch()} already exists`);
    expect(rowOf(o, OTHER).provision?.code).toBe('branch-exists');
    expect(rowOf(o, OTHER).provision?.port).toBe(8081);
    expect(existsSync(otherWorktree())).toBe(false);

    // The old reservation became stale while the row was failed. Recovery must
    // not give two worktrees the same dev-server port.
    writeFileSync(
      join(worktree, '.issue-state.md'),
      `# Issue #${ISSUE}\n\n- **Branch**: \`fix/issue-${ISSUE}-demo\`\n- **Dev-server port**: **8081**\n`,
    );
    vi.mocked(gh.listIssues).mockResolvedValue([
      { number: ISSUE, title: 'Org sysadmin filter pills', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
      { number: OTHER, title: 'Renamed after the failure', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
    ]);

    const recoveryPlan = await o.existingWorktreePlan(OTHER);
    expect(recoveryPlan.ok).toBe(true);
    expect(recoveryPlan.plan?.port).toBe(8082);
    expect(recoveryPlan.plan?.head).toBe(existingHead);
    expect(recoveryPlan.plan?.commands.join('\n')).toContain('git worktree add');
    const continued = await o.continueExistingWorktree(OTHER, recoveryPlan.plan?.head);
    expect(continued.ok).toBe(true);
    await pollUntil(o, 'the existing branch worktree to be adopted', () => rowOf(o, OTHER).worktree !== null);

    const recovered = rowOf(o, OTHER);
    expect(recovered.provision).toBeNull();
    expect(recovered.worktree).toBe(otherWorktree());
    expect(recovered.branch).toBe(otherBranch());
    expect(recovered.account).toBe('work');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: otherWorktree(), encoding: 'utf8' }).trim()).toBe(
      existingHead,
    );
    expect(readFileSync(join(otherWorktree(), 'existing-work.txt'), 'utf8')).toBe('keep this exact branch work\n');
    expect(readFileSync(join(otherWorktree(), '.issue-state.md'), 'utf8')).toContain('Dev-server port**: **8082');
    expect(readFileSync(join(otherWorktree(), '.issue-state.md'), 'utf8')).toContain('branch tip was preserved');
    expect(readFileSync(join(otherWorktree(), '.issue-state.md'), 'utf8')).toContain('Stage reached**: unknown');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(primaryHead);
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(primaryBranch);
    expect(
      execFileSync(
        'git',
        ['config', '--get-regexp', `^branch\\.${otherBranch().replaceAll('.', '\\.')}\\.(remote|merge)$`],
        { cwd: repo, encoding: 'utf8' },
      ),
    ).toBe(existingUpstream);

    expect(o.enqueue(OTHER).ok).toBe(true);
    await waitFor('the worker to continue in the restored worktree', () =>
      existsSync(join(otherWorktree(), '.gate.json')),
    );
    await o.stop();
  });

  it('reconnects the persisted session, model, account and path-derived transcript', async () => {
    writeAccounts();
    anIssueWithNoWorktree();
    git(['branch', otherBranch()], repo);
    const session = 'c39f87c8-5015-existing-session';
    const transcript = join(sessionDir(otherWorktree(), workDir), `${session}.jsonl`);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '{"type":"user","message":"existing work"}\n');
    writeFileSync(
      stateFile,
      JSON.stringify({
        sessions: { [OTHER]: session },
        agentSessions: { [OTHER]: session },
        accountByIssue: { [OTHER]: 'work' },
        providerByIssue: { [OTHER]: 'claude' },
        modelByIssue: { [OTHER]: 'claude-opus-5' },
      }),
    );

    const o = orch();
    await o.start();
    expect((await o.createWorktree(OTHER, 'work')).ok).toBe(true);
    await waitFor('the branch collision to surface', () => rowOf(o, OTHER).status === 'failed');
    const plan = await o.existingWorktreePlan(OTHER);
    expect(plan.ok).toBe(true);
    expect((await o.continueExistingWorktree(OTHER, plan.plan?.head)).ok).toBe(true);

    const recovered = rowOf(o, OTHER);
    expect(recovered.sessionId).toBe(session);
    expect(recovered.account).toBe('work');
    expect(recovered.accountLocked).toBe(true);
    expect(recovered.modelResolved).toBe('claude-opus-5');
    expect(recovered.resumeCommand).toContain(session);
    expect(readFileSync(transcript, 'utf8')).toContain('existing work');
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, Record<string, string>>;
    expect(persisted.sessions?.[OTHER]).toBe(session);
    expect(persisted.agentSessions?.[OTHER]).toBe(session);
    expect(persisted.accountByIssue?.[OTHER]).toBe('work');
    expect(persisted.modelByIssue?.[OTHER]).toBe('claude-opus-5');
    await o.stop();
  });

  it('refuses when the branch head changes after the recovery was reviewed', async () => {
    writeAccounts();
    anIssueWithNoWorktree();
    git(['branch', otherBranch()], repo);
    const o = orch();
    await o.start();
    expect((await o.createWorktree(OTHER, 'work')).ok).toBe(true);
    await waitFor('the branch collision to surface', () => rowOf(o, OTHER).status === 'failed');
    const plan = await o.existingWorktreePlan(OTHER);
    const reviewedHead = plan.plan!.head;
    const tree = execFileSync('git', ['rev-parse', `${reviewedHead}^{tree}`], { cwd: repo, encoding: 'utf8' }).trim();
    const movedHead = execFileSync('git', ['commit-tree', tree, '-p', reviewedHead, '-m', 'branch moved externally'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    git(['update-ref', `refs/heads/${otherBranch()}`, movedHead, reviewedHead], repo);

    const continued = await o.continueExistingWorktree(OTHER, reviewedHead);

    expect(continued.ok).toBe(false);
    expect(continued.message).toContain('changed since the recovery plan');
    expect(execFileSync('git', ['rev-parse', otherBranch()], { cwd: repo, encoding: 'utf8' }).trim()).toBe(movedHead);
    expect(existsSync(otherWorktree())).toBe(false);
    expect(rowOf(o, OTHER).provision?.code).toBe('branch-exists');
    await o.stop();
  });

  it('pins a reviewed use-existing mode and shows that worktree own port', async () => {
    writeAccounts();
    anIssueWithNoWorktree();
    git(['branch', otherBranch()], repo);
    const o = orch();
    await o.start();
    expect((await o.createWorktree(OTHER, 'work')).ok).toBe(true);
    await waitFor('the branch collision to surface', () => rowOf(o, OTHER).status === 'failed');

    git(['worktree', 'add', otherWorktree(), otherBranch()], repo);
    writeFileSync(
      join(otherWorktree(), '.issue-state.md'),
      `# Issue #${OTHER}\n\n- **Dev-server port**: **8099**\n- **Stage reached**: 4\n`,
    );
    const plan = await o.existingWorktreePlan(OTHER);
    expect(plan.plan?.mode).toBe('use-existing');
    expect(plan.plan?.port).toBe(8099);

    rmSync(join(otherWorktree(), '.issue-state.md'));
    git(['worktree', 'remove', otherWorktree()], repo);
    const continued = await o.continueExistingWorktree(
      OTHER,
      plan.plan?.head,
      plan.plan?.port,
      plan.plan?.mode,
    );

    expect(continued.ok).toBe(false);
    expect(continued.message).toContain('mode changed since the plan');
    expect(existsSync(otherWorktree())).toBe(false);
    expect(rowOf(o, OTHER).provision?.code).toBe('branch-exists');
    await o.stop();
  });

  it('leaves an untracked path collision untouched and removes the unsafe recovery action', async () => {
    writeAccounts();
    anIssueWithNoWorktree();
    git(['branch', otherBranch()], repo);
    const o = orch();
    await o.start();
    expect((await o.createWorktree(OTHER, 'work')).ok).toBe(true);
    await waitFor('the branch collision to surface', () => rowOf(o, OTHER).status === 'failed');

    mkdirSync(otherWorktree(), { recursive: true });
    const sentinel = join(otherWorktree(), 'do-not-touch.txt');
    writeFileSync(sentinel, 'foreign directory\n');

    const continued = await o.continueExistingWorktree(OTHER);
    expect(continued.ok).toBe(false);
    expect(continued.message).toContain('not a tracked');
    expect(readFileSync(sentinel, 'utf8')).toBe('foreign directory\n');
    expect(rowOf(o, OTHER).provision?.code).toBeNull();
    expect(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })).not.toContain(
      otherWorktree(),
    );
    await o.stop();
  });

  it('does not recreate a branch that disappeared after the failure', async () => {
    writeAccounts();
    anIssueWithNoWorktree();
    git(['branch', otherBranch()], repo);
    const o = orch();
    await o.start();
    expect((await o.createWorktree(OTHER, 'work')).ok).toBe(true);
    await waitFor('the branch collision to surface', () => rowOf(o, OTHER).status === 'failed');

    git(['branch', '-D', otherBranch()], repo);
    const continued = await o.continueExistingWorktree(OTHER);

    expect(continued.ok).toBe(false);
    expect(continued.message).toContain('no longer exists');
    expect(existsSync(otherWorktree())).toBe(false);
    expect(rowOf(o, OTHER).provision?.code).toBeNull();
    await o.stop();
  });

  it('keeps a post-attach scaffold failure visible instead of clearing it as the old branch refusal', async () => {
    writeAccounts();
    anIssueWithNoWorktree();
    const seed = join(repo, '.scaffold-failure-seed');
    git(['worktree', 'add', '-b', otherBranch(), seed, 'dev'], repo);
    writeFileSync(join(seed, 'supabase'), 'this file deliberately blocks the scaffold directory\n');
    git(['add', 'supabase'], seed);
    git(['commit', '-m', 'existing branch with scaffold blocker'], seed);
    git(['worktree', 'remove', seed], repo);
    const existingHead = execFileSync('git', ['rev-parse', otherBranch()], { cwd: repo, encoding: 'utf8' }).trim();

    const o = orch();
    await o.start();
    expect((await o.createWorktree(OTHER, 'work')).ok).toBe(true);
    await waitFor('the branch collision to surface', () => rowOf(o, OTHER).status === 'failed');

    const continued = await o.continueExistingWorktree(OTHER);
    expect(continued.ok).toBe(false);
    expect(continued.message).toContain('scaffolding the restored worktree failed');
    await o.poll();

    const failed = rowOf(o, OTHER);
    expect(failed.worktree).toBe(otherWorktree());
    expect(failed.provision?.phase).toBe('failed');
    expect(failed.provision?.code).toBeNull();
    expect(failed.provision?.error).toContain('scaffolding the restored worktree failed');
    expect(readFileSync(join(otherWorktree(), 'supabase'), 'utf8')).toContain('deliberately blocks');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: otherWorktree(), encoding: 'utf8' }).trim()).toBe(
      existingHead,
    );
    expect((await o.continueExistingWorktree(OTHER)).ok).toBe(false);
    await o.stop();
  });

  it('does not force an existing branch out of another worktree', async () => {
    writeAccounts();
    anIssueWithNoWorktree();
    const elsewhere = join(repo, '.worktrees', 'manual-existing-work');
    git(['worktree', 'add', '-b', otherBranch(), elsewhere, 'dev'], repo);
    writeFileSync(join(elsewhere, 'manual.txt'), 'keep this checkout\n');
    git(['add', 'manual.txt'], elsewhere);
    git(['commit', '-m', 'manual existing worktree'], elsewhere);
    const existingHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: elsewhere, encoding: 'utf8' }).trim();

    const o = orch();
    await o.start();
    expect((await o.createWorktree(OTHER, 'work')).ok).toBe(true);
    await waitFor('the branch collision to surface', () => rowOf(o, OTHER).status === 'failed');

    const plan = await o.existingWorktreePlan(OTHER);
    expect(plan.ok).toBe(false);
    expect(plan.message).toContain(elsewhere);
    const continued = await o.continueExistingWorktree(OTHER);
    expect(continued.ok).toBe(false);
    expect(existsSync(otherWorktree())).toBe(false);
    expect(readFileSync(join(elsewhere, 'manual.txt'), 'utf8')).toBe('keep this checkout\n');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: elsewhere, encoding: 'utf8' }).trim()).toBe(existingHead);
    expect(rowOf(o, OTHER).provision?.code).toBeNull();
    await o.stop();
  });

  it('serializes two recovery requests and settles on one healthy worktree', async () => {
    writeAccounts();
    anIssueWithNoWorktree();
    git(['branch', otherBranch()], repo);
    const o = orch();
    await o.start();
    expect((await o.createWorktree(OTHER, 'work')).ok).toBe(true);
    await waitFor('the branch collision to surface', () => rowOf(o, OTHER).status === 'failed');

    const results = await Promise.all([
      o.continueExistingWorktree(OTHER),
      o.continueExistingWorktree(OTHER),
    ]);
    expect(results.some((result) => result.ok)).toBe(true);
    await pollUntil(o, 'one restored worktree to settle', () => rowOf(o, OTHER).worktree === otherWorktree());
    expect(rowOf(o, OTHER).provision).toBeNull();
    const registrations = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repo,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line === `worktree ${otherWorktree()}`);
    expect(registrations).toHaveLength(1);
    await o.stop();
  });

  it('does not let an older in-flight poll hide the restored worktree', async () => {
    writeAccounts();
    anIssueWithNoWorktree();
    git(['branch', otherBranch()], repo);
    const o = orch();
    await o.start();
    expect((await o.createWorktree(OTHER, 'work')).ok).toBe(true);
    await waitFor('the branch collision to surface', () => rowOf(o, OTHER).status === 'failed');

    const issues = [
      { number: ISSUE, title: 'Org sysadmin filter pills', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
      { number: OTHER, title: OTHER_TITLE, url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
    ];
    let release: (() => void) | null = null;
    vi.mocked(gh.listIssues).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(issues);
        }),
    );
    const oldPoll = o.poll();
    await waitFor('the deliberately slow poll to start', () => release !== null);
    // Its local Git scan is quick; hold only the GitHub half so this snapshot is
    // definitively older than the recovery that follows.
    await wait(50);

    const plan = await o.existingWorktreePlan(OTHER);
    expect((await o.continueExistingWorktree(OTHER, plan.plan?.head)).ok).toBe(true);
    expect(rowOf(o, OTHER).worktree).toBe(otherWorktree());
    release!();
    await oldPoll;

    expect(rowOf(o, OTHER).worktree).toBe(otherWorktree());
    expect(rowOf(o, OTHER).provision).toBeNull();
    await o.stop();
  });

  it('stamps without locking: the lock is a session, not a stamp', async () => {
    writeAccounts();
    // What a create-then-never-run issue looks like on disk: an account stamped,
    // no session anywhere.
    writeFileSync(stateFile, JSON.stringify({ accountByIssue: { [ISSUE]: 'work' } }));
    const o = orch();
    await o.start();

    expect(row(o).account).toBe('work');
    expect(row(o).accountLocked).toBe(false);

    // So the picker on the start card can still move it, right up to the spawn.
    expect(o.enqueue(ISSUE, 'personal').ok).toBe(true);
    await waitFor('a gate', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');
    // The canonical account runs with NO CLAUDE_CONFIG_DIR — naming ~/.claude
    // stops Claude Code finding its Keychain credentials.
    expect(readGate().env_config_dir).toBeNull();
    expect(row(o).account).toBe('personal');

    // And now that a session exists, it is locked for real.
    expect(row(o).accountLocked).toBe(true);
    expect(o.enqueue(ISSUE, 'work').message).toContain('cannot move between accounts');
    await o.stop();
  });
});

describe('detached detection reads the issue own account', () => {
  it('sees a takeover in the work account, and is not fooled by the other account', async () => {
    writeAccounts();
    const o = orch();
    await o.start();
    o.enqueue(ISSUE, 'work');
    await waitFor('a gate', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');
    const sessionId = row(o).sessionId!;

    // The transcript this session would have left behind, in ITS account.
    const transcript = fakeTranscript(workDir, sessionId);
    // Run once more so the console records the mtime its own child left behind.
    // 'checkpoint' means that run closed AND the console re-scanned after it.
    await o.resume(ISSUE, 'carry on');
    await waitFor('the resume to land', () => existsSync(join(worktree, 'resumed.txt')));
    await waitFor('the run to be recorded', () => row(o).status === 'checkpoint');

    // The operator takes it over in a terminal: the same session's transcript grows.
    const later = new Date(statSync(transcript).mtimeMs + 60_000);
    utimesSync(transcript, later, later);
    // A stray, newer transcript in the OTHER account must not be looked at at
    // all — if it were, it would read as a different session and hide this.
    const stray = fakeTranscript(canonical, 'sess-not-ours');
    const strayLater = new Date(statSync(transcript).mtimeMs + 120_000);
    utimesSync(stray, strayLater, strayLater);

    await pollUntil(o, 'the takeover to be noticed', () => row(o).status === 'detached');
    await o.stop();
  });

  it('finds an unstamped issue transcript by scanning every account, newest wins', async () => {
    writeAccounts();
    fakeTranscript(workDir, 'sess-legacy');
    const o = orch();
    await o.start(); // nothing stamped this issue: scan them all
    expect(row(o).sessionId).toBe('sess-legacy');
    expect(row(o).account).toBeNull();
    await o.stop();
  });

  it('does not look in another account once the issue is stamped', async () => {
    writeAccounts();
    fakeTranscript(workDir, 'sess-legacy');
    writeFileSync(stateFile, JSON.stringify({ accountByIssue: { [ISSUE]: 'personal' } }));
    const o = orch();
    await o.start();
    expect(row(o).sessionId).toBeNull(); // the work account is not this issue's
    await o.stop();
  });
});

describe('restart fresh under another account', () => {
  it('mints a new session, re-stamps the account, and keeps the worktree and history', async () => {
    writeAccounts();
    // History the restart must not touch.
    writeFileSync(
      join(worktree, '.gate-history.jsonl'),
      JSON.stringify({
        issue: ISSUE,
        gate: 'A',
        stage: 1,
        summary: 'scope',
        questions: [],
        decision: 'Gate A approved, proceed.',
        account: 'personal',
      }) + '\n',
    );

    const o = orch();
    await o.start();
    o.enqueue(ISSUE, 'personal');
    await waitFor('a gate', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');
    const first = row(o).sessionId!;
    expect(readGate().env_config_dir).toBeNull(); // canonical: the variable is not set at all

    const out = await o.restartFresh(ISSUE, 'work');
    expect(out.ok).toBe(true);
    await waitFor('the new worker to reach its gate', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');

    const after = row(o);
    expect(after.account).toBe('work');
    expect(after.sessionId).not.toBe(first);
    expect(readGate().env_config_dir).toBe(workDir); // the new session ran in work
    expect(readGate().env_session_id).toBe(after.sessionId);

    // Everything that carries the work survived.
    expect(after.worktree).toBe(worktree);
    expect(after.branch).toBe(`fix/issue-${ISSUE}-demo`);
    expect(after.history.map((h) => h.gate)).toEqual(['A']);
    expect(after.history[0]!.account).toBe('personal');
    await o.stop();
  });

  it('refuses an account that is not registered', async () => {
    writeAccounts();
    const o = orch();
    await o.start();
    const out = await o.restartFresh(ISSUE, 'ghost');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('unknown account');
    await o.stop();
  });
});

describe('no accounts.json at all', () => {
  it('is one implicit account, the same worker, and a bare resume command', async () => {
    const o = orch(); // accountsFile does not exist
    await o.start();

    expect(o.state().accounts).toEqual([
      { name: 'personal', provider: 'claude', configDir: canonical, isDefault: true, model: null },
    ]);
    expect(o.state().defaultAccount).toBe('personal');

    expect(o.enqueue(ISSUE).ok).toBe(true);
    await waitFor('a gate', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');

    // Exactly the pre-accounts behaviour: the worker runs with the variable unset.
    expect(readGate().env_config_dir).toBeNull();
    const r = row(o);
    expect(r.resumeCommand).toContain(`cd '${worktree}'`);
    expect(r.resumeCommand).toContain("stub-worker.mjs' --resume");
    expect(r.resumeCommand).toContain(`'${r.sessionId}'`);
    expect(r.resumeCommand).not.toContain('CLAUDE_CONFIG_DIR');
    await o.stop();
  });

  it('reports the one account in the doctor without ever running claude', async () => {
    const report = await orch().accountsReport();
    expect(report).toHaveLength(1);
    expect(report[0]!.name).toBe('personal');
    expect(report[0]!.configDirExists).toBe(true);
    expect(report[0]!.loggedIn).toBe('unknown'); // empty temp dir, no marker either way
    // The canonical account's login line carries NO prefix: with one it would
    // fail for exactly the reason workers under it were failing.
    expect(report[0]!.loginCommand).toBe('claude /login');
  });
});
