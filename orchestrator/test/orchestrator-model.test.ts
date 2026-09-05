import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import { readRuns } from '../src/metrics.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ResourceReport } from '../src/types.js';

/**
 * Model choice end to end: which model a worker is actually SPAWNED with at each
 * level of the precedence chain, and the run record that spawn leaves behind.
 * The assertion throughout is the `--model` argument the child really received,
 * read back out of the stub worker — not what the console says it intended.
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
let runsFile: string;

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

/** accounts.json with an optional per-account model on `work`. */
function writeAccounts(workModel?: string) {
  writeFileSync(
    accountsFile,
    JSON.stringify({
      default: 'personal',
      accounts: [
        { name: 'personal', configDir: canonical },
        { name: 'work', configDir: workDir, ...(workModel ? { model: workModel } : {}) },
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
  runsFile = join(home, 'runs.jsonl');

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-orch-model-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-demo`);
  git(['worktree', 'add', '-b', `fix/issue-${ISSUE}-demo`, worktree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: ISSUE, title: 'Org sysadmin filter pills', url: 'u', labels: ['bug'], updatedAt: 'z', author: 'operator' },
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
  // FIRST, and unconditionally: a worker is a real detached process, and a test
  // that fails an assertion never reaches its own cleanup.
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
      ACCOUNTS_FILE: accountsFile,
      CANONICAL_CLAUDE_DIR: canonical,
      CLAUDE_BIN: STUB,
      POLL_MS: '999999',
      ...env,
    }),
  );
}

const gateFile = () => join(worktree, '.gate.json');
const readGate = () => JSON.parse(readFileSync(gateFile(), 'utf8')) as Record<string, unknown>;
const row = (o: Orchestrator) => o.state().issues.find((r) => r.number === ISSUE)!;

/** Run one worker to its gate and report the `--model` the child really got. */
async function spawnAndReadModel(o: Orchestrator, enqueue: () => void): Promise<string> {
  enqueue();
  await waitFor('the worker to stop at its gate', () => existsSync(gateFile()));
  await waitFor('the row to settle', () => row(o).status === 'at-gate');
  return String(readGate().model_arg);
}

describe('the model a worker actually spawns with', () => {
  it('is the console default when nothing anywhere says otherwise', async () => {
    writeAccounts();
    const o = orch();
    await o.start();
    expect(o.state().defaultModel).toBe('claude-opus-5');
    expect(await spawnAndReadModel(o, () => o.enqueue(ISSUE))).toBe('claude-opus-5');
    await o.stop();
  });

  it('is the account default when the account has one', async () => {
    writeAccounts('claude-sonnet-5');
    const o = orch();
    await o.start();
    expect(await spawnAndReadModel(o, () => o.enqueue(ISSUE, 'work'))).toBe('claude-sonnet-5');
    expect(row(o).model).toBe('claude-sonnet-5'); // stamped at spawn, like the account
    await o.stop();
  });

  it('is what the issue is stamped with, over the account default', async () => {
    writeAccounts('claude-sonnet-5');
    writeFileSync(
      stateFile,
      JSON.stringify({ accountByIssue: { [ISSUE]: 'work' }, modelByIssue: { [ISSUE]: 'claude-fable-5' } }),
    );
    const o = orch();
    await o.start();
    expect(row(o).modelResolved).toBe('claude-fable-5');
    expect(await spawnAndReadModel(o, () => o.enqueue(ISSUE))).toBe('claude-fable-5');
    await o.stop();
  });

  it('is the picker on the start card, over everything else', async () => {
    writeAccounts('claude-sonnet-5');
    writeFileSync(
      stateFile,
      JSON.stringify({ accountByIssue: { [ISSUE]: 'work' }, modelByIssue: { [ISSUE]: 'claude-fable-5' } }),
    );
    const o = orch();
    await o.start();
    const got = await spawnAndReadModel(o, () => o.enqueue(ISSUE, null, 'claude-haiku-4-5-20251001'));
    expect(got).toBe('claude-haiku-4-5-20251001');
    expect(row(o).model).toBe('claude-haiku-4-5-20251001');
    await o.stop();
  });

  it('honours WORKER_MODEL, including an id this build has never heard of', async () => {
    writeAccounts();
    const o = orch({ WORKER_MODEL: 'claude-something-unreleased' });
    await o.start();
    // Unknown ids must not hard-fail — a rename cannot be allowed to wedge the console.
    expect(o.state().models.map((m) => m.id)).toContain('claude-something-unreleased');
    expect(await spawnAndReadModel(o, () => o.enqueue(ISSUE))).toBe('claude-something-unreleased');
    await o.stop();
  });

  it('runs a resume on the same model as the spawn', async () => {
    writeAccounts();
    const o = orch();
    await o.start();
    await spawnAndReadModel(o, () => o.enqueue(ISSUE, null, 'claude-fable-5'));

    expect((await o.resume(ISSUE, 'Gate C approved, proceed.')).ok).toBe(true);
    await waitFor('the resume to land', () => existsSync(join(worktree, 'resumed.txt')));
    expect(readFileSync(join(worktree, 'resumed.txt'), 'utf8')).toContain('model: claude-fable-5');
    await o.stop();
  });
});

describe('the model chosen before the work starts', () => {
  it('is stamped by the create-worktree card without locking anything', async () => {
    writeAccounts();
    const o = orch();
    await o.start();
    // #4344 has no worktree here, so the create card is its whole first screen.
    vi.mocked(gh.listIssues).mockResolvedValue([
      { number: ISSUE, title: 'x', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
      { number: 4344, title: 'Save and Exit', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
    ]);
    await o.poll();

    // The provisioner is not exercised here; the stamp is, and it is what carries
    // the choice through the minutes of npm install that follow.
    await o.createWorktree(4344, 'work', 'claude-fable-5');
    const r = o.state().issues.find((i) => i.number === 4344)!;
    expect(r.model).toBe('claude-fable-5');
    expect(r.modelResolved).toBe('claude-fable-5');
    expect(r.accountLocked).toBe(false); // a stamp is not a lock; a session is
    await o.stop();
  });
});

describe('a session fixes the model', () => {
  it('refuses to change it under a live session, and names the way out', async () => {
    writeAccounts();
    const o = orch();
    await o.start();
    await spawnAndReadModel(o, () => o.enqueue(ISSUE, null, 'claude-opus-5'));

    const out = o.enqueue(ISSUE, null, 'claude-haiku-4-5-20251001');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('Restart fresh');
    expect(row(o).modelResolved).toBe('claude-opus-5');
    await o.stop();
  });

  it('changes it on a restart fresh, which is a new session', async () => {
    writeAccounts();
    const o = orch();
    await o.start();
    await spawnAndReadModel(o, () => o.enqueue(ISSUE, null, 'claude-opus-5'));
    const firstSession = row(o).sessionId;

    const out = await o.restartFresh(ISSUE, 'personal', 'claude-haiku-4-5-20251001');
    expect(out.ok).toBe(true);
    await waitFor('the new worker to reach its gate', () => existsSync(gateFile()));
    await waitFor('the row to settle', () => row(o).status === 'at-gate');

    expect(String(readGate().model_arg)).toBe('claude-haiku-4-5-20251001');
    expect(row(o).sessionId).not.toBe(firstSession);
    await o.stop();
  });

  it('uses the destination account default on a same-provider restart when no model is requested', async () => {
    writeAccounts('claude-sonnet-5');
    const o = orch();
    await o.start();
    await spawnAndReadModel(o, () => o.enqueue(ISSUE, 'personal', 'claude-fable-5'));

    const out = await o.restartFresh(ISSUE, 'work');
    expect(out.ok).toBe(true);
    await waitFor('the restarted worker to reach its gate', () => existsSync(gateFile()));
    await waitFor('the restarted row to settle', () => row(o).status === 'at-gate');

    expect(String(readGate().model_arg)).toBe('claude-sonnet-5');
    expect(row(o).account).toBe('work');
    expect(row(o).modelResolved).toBe('claude-sonnet-5');
    await o.stop();
  });
});

describe('fresh Stage 9 identity', () => {
  it('uses the selected same-provider profile default instead of the previous issue stamp', async () => {
    writeAccounts('claude-sonnet-5');
    writeFileSync(
      stateFile,
      JSON.stringify({
        accountByIssue: { [ISSUE]: 'personal' },
        providerByIssue: { [ISSUE]: 'claude' },
        modelByIssue: { [ISSUE]: 'claude-fable-5' },
      }),
    );
    const o = orch();
    await o.start();
    expect(row(o).sessionId).toBeNull();

    const out = await o.postMergeStart(ISSUE, 'Run Stage 9 please.', 'work');
    expect(out.ok).toBe(true);
    await waitFor('the Stage 9 worker to reach its gate', () => existsSync(gateFile()));
    await waitFor('the Stage 9 row to settle', () => row(o).status === 'at-gate');

    expect(String(readGate().model_arg)).toBe('claude-sonnet-5');
    expect(row(o).account).toBe('work');
    expect(row(o).modelResolved).toBe('claude-sonnet-5');
    await o.stop();
  });
});

describe('what a run leaves behind in runs.jsonl', () => {
  it('records the segment, the model and what the run cost', async () => {
    writeAccounts();
    const o = orch();
    await o.start();
    await spawnAndReadModel(o, () => o.enqueue(ISSUE, 'work', 'claude-sonnet-5'));
    await waitFor('the run to be logged', () => existsSync(runsFile));

    const [record] = await readRuns(runsFile);
    expect(record!.issue).toBe(ISSUE);
    expect(record!.segment).toBe('C'); // the gate it stopped at — the unit of observation
    expect(record!.model).toBe('claude-sonnet-5');
    expect(record!.account).toBe('work');
    expect(record!.exit).toBe('gate');
    expect(record!.outputTokens).toBe(300);
    expect(record!.costUsd).toBe(0.42);
    expect(record!.usageSource).toBe('modelUsage');
    expect(record!.toolCalls).toBe(1);
    expect(record!.labels).toEqual(['bug']);
    // No commits were made, so the work stat is a real zero rather than unknown.
    expect(record!.filesChanged).toBe(0);
    expect(record!.touchedMigration).toBe(false);
    expect(record!.gateStopsBefore).toBe(0); // first attempt at gate C
    expect(record!.durationMs).toBeGreaterThanOrEqual(0);
    await o.stop();
  });

  it('appends a second line for the next run and keeps the first', async () => {
    writeAccounts();
    const o = orch();
    await o.start();
    await spawnAndReadModel(o, () => o.enqueue(ISSUE));

    await o.resume(ISSUE, 'Gate C approved, proceed.');
    await waitFor('the resume to land', () => existsSync(join(worktree, 'resumed.txt')));
    await waitFor('both runs to be logged', () => readFileSync(runsFile, 'utf8').trim().split('\n').length === 2);

    const runs = await readRuns(runsFile);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.segment).toBe('C');
    // The resume ran to completion without stopping at a gate, so it is its own
    // segment with no gate — which is exactly what 'none' means.
    expect(runs[1]!.segment).toBe('none');
    expect(runs[1]!.exit).toBe('exited-no-gate');
    await o.stop();
  });

  it('serves the aggregates with the sample count and the caveat', async () => {
    writeAccounts();
    const o = orch();
    await o.start();
    await spawnAndReadModel(o, () => o.enqueue(ISSUE));
    await waitFor('the run to be logged', () => existsSync(runsFile));

    const report = await o.metrics();
    expect(report.totalRuns).toBe(1);
    const cell = report.cells.find((c) => c.segment === 'C')!;
    expect(cell.runs).toBe(1);
    expect(cell.enough).toBe(false);
    expect(report.caveat).toContain('Not enough data');
    // The gate is still open — nothing about its approval is knowable yet.
    expect(cell.firstTimeApproval).toBeNull();
    await o.stop();
  });
});

describe('the login command a failed worker needs', () => {
  it('has no CLAUDE_CONFIG_DIR prefix for the canonical account, and one for any other', async () => {
    writeAccounts();
    const o = orch();
    await o.start();
    // Under `personal` (~/.claude), the prefixed form is the thing that BREAKS.
    expect(row(o).loginCommand).toBe('claude /login');

    await spawnAndReadModel(o, () => o.enqueue(ISSUE, 'work'));
    expect(row(o).loginCommand).toBe(`CLAUDE_CONFIG_DIR=${workDir} claude /login`);
    await o.stop();
  });
});

describe('the write fence a worker actually spawns with', () => {
  /**
   * The console spawns workers with `--permission-mode bypassPermissions`, which
   * is why nothing stopped the worker that filed example-repo#4562 against an
   * instruction that said, in capitals, not to. The fence is a PreToolUse hook —
   * the one decision that outranks bypassPermissions — and it is only real if it
   * is attached to EVERY spawn.
   *
   * This guards the wiring, not the parsing (write-fence.test.ts owns that).
   * Deleting `extraArgs: fenceArgs()` from orchestrator.ts would unfence every
   * worker silently, and nothing else in the suite would notice.
   */
  it('carries --settings with the hook, on a real spawn', async () => {
    const argvFile = join(home, 'argv.json');
    process.env.STUB_ARGV_FILE = argvFile;
    try {
      writeAccounts();
      const o = orch();
      await o.start();
      await spawnAndReadModel(o, () => o.enqueue(ISSUE));
      await o.stop();

      const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
      expect(argv).toContain('--permission-mode');
      expect(argv).toContain('bypassPermissions');
      // ...and precisely because of that, the fence must be there too.
      expect(argv).toContain('--settings');
      const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!);
      const hook = settings.hooks.PreToolUse[0];
      expect(hook.matcher).toBe('Bash');
      expect(hook.hooks[0].command).toContain('write-fence.mjs');
      // Named interpreter: pointing at the .mjs alone fails OPEN if it is not +x.
      expect(hook.hooks[0].command).toContain(process.execPath);
    } finally {
      delete process.env.STUB_ARGV_FILE;
    }
  });
});
