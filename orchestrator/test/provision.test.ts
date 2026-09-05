import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Provisioner,
  checkCreatable,
  nextFreePort,
  pathExists,
  staleFenceJobs,
  verifiedRecoveryJobs,
  type ProvisionJob,
} from '../src/provision.js';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wc-repo-'));
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'supabase'), { recursive: true });
  writeFileSync(join(repo, '.env'), 'PRIMARY\n');
  writeFileSync(join(repo, 'supabase', '.env.local'), 'PRIMARY\n');
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/**
 * FENCE 1 — create-only, forever. These are the terms of the approval, so they
 * are enforced here in code, not in a comment.
 */
describe('checkCreatable — the console may only ever create something new', () => {
  const base = {
    worktreeRoot: '/repo/.worktrees',
    worktreePath: '/repo/.worktrees/issue-4400-new-thing',
    branch: 'fix/issue-4400-new-thing',
    pathExists: async () => false,
    branchExists: async () => false,
  };

  it('allows a worktree that does not exist yet', async () => {
    expect(await checkCreatable(base)).toEqual({ ok: true, reason: 'creatable', code: 'ok' });
  });

  it('REFUSES when the worktree directory already exists', async () => {
    const r = await checkCreatable({ ...base, pathExists: async () => true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(
      'refusing: /repo/.worktrees/issue-4400-new-thing already exists. This console only ever creates new worktrees.',
    );
    // The refusals differ in what they IMPLY, so the caller must be able to tell
    // them apart without reading English. `exists` is the only one that can mean
    // "the thing you asked for is already there".
    expect(r.code).toBe('exists');
  });

  it('REFUSES when the branch already exists, even if the directory does not', async () => {
    const r = await checkCreatable({ ...base, branchExists: async () => true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(
      'refusing: branch fix/issue-4400-new-thing already exists. This console only ever creates new worktrees.',
    );
  });

  it('REFUSES a path that escapes the worktree root', async () => {
    const r = await checkCreatable({ ...base, worktreePath: '/repo/.worktrees/../../elsewhere' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('outside');
  });

  it('REFUSES the worktree root itself', async () => {
    const r = await checkCreatable({ ...base, worktreePath: '/repo/.worktrees' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('outside');
  });

  it('treats a dangling symlink as occupied rather than following it', async () => {
    const link = join(repo, '.worktrees', 'issue-4400-new-thing');
    mkdirSync(join(repo, '.worktrees'), { recursive: true });
    symlinkSync(join(repo, 'missing-target'), link);
    expect(await pathExists(link)).toBe(true);
  });
});

/**
 * #4642, in full.
 *
 * 12:25:18 — the console created the worktree and scaffolded it. It worked.
 * 12:28:02 — a second create ran, and by then the console had lost sight of what
 *            it had just built: the fence saw the directory, refused, and stored
 *            a FAILED job. `deriveStatus` reads provision before anything else,
 *            so a healthy worktree sat behind a red card reading "refusing: ...
 *            already exists", with no way to clear it short of a restart.
 *
 * The proof the console had lost it is the port: the failed attempt planned 8095,
 * the port the 12:25 worktree had already claimed — `nextFreePort` skips ports
 * held by tracked worktrees, so it was not tracking one.
 *
 * The fence was right to refuse; it must never adopt a directory it did not make.
 * The error was keeping the refusal AS a failure once the worktree turned out to
 * be present and tracked — at that point the state we wanted already holds, and
 * there is nothing to report.
 *
 * Which failures may be dropped is the whole question, so it turns on the CODE and
 * not on prose. A fence refusal happens before anything runs, so the worktree is
 * untouched by it. A scaffolding failure happens after `git-new-worktree.sh` has
 * already made the directory — that one leaves a half-built worktree that a scan
 * WILL find, and dropping it would hide a missing `.env` symlink behind a normal
 * looking row.
 */
describe('a refusal to rebuild something that already exists is not a failure', () => {
  const failed = (issue: number, code: ProvisionJob['code']): Pick<ProvisionJob, 'issue' | 'phase' | 'code'> => ({
    issue,
    phase: 'failed',
    code,
  });

  it('drops the fence refusal once the worktree is really there — #4642', () => {
    expect(staleFenceJobs([failed(4642, 'exists')], (n) => n === 4642)).toEqual([4642]);
  });

  it('KEEPS it while the worktree is still not tracked, because then it is news', () => {
    expect(staleFenceJobs([failed(4642, 'exists')], () => false)).toEqual([]);
  });

  it('KEEPS a scaffolding failure, whose worktree exists but is half-built', () => {
    // `git-new-worktree.sh` ran, the `.env` symlink did not. A scan finds this
    // worktree, so scanning alone must never be enough to clear a failure.
    expect(staleFenceJobs([failed(4400, null)], () => true)).toEqual([]);
  });

  it('KEEPS a branch-exists refusal: no worktree was made, so a scan proves nothing', () => {
    expect(staleFenceJobs([failed(4400, 'branch-exists')], () => true)).toEqual([]);
  });

  it('leaves jobs that have not failed alone', () => {
    const live = [
      { issue: 1, phase: 'creating' as const, code: null },
      { issue: 2, phase: 'ready' as const, code: null },
    ];
    expect(staleFenceJobs(live, () => true)).toEqual([]);
  });

  it('clears verification-pending recovery only after the exact worktree is scanned', () => {
    const job = {
      issue: 4400,
      phase: 'failed' as const,
      code: 'recovery-pending' as const,
      branch: 'fix/issue-4400-new-thing',
      worktreePath: '/repo/.worktrees/issue-4400-new-thing',
    };
    expect(verifiedRecoveryJobs([job], () => false)).toEqual([]);
    expect(verifiedRecoveryJobs([job], (candidate) => candidate === job)).toEqual([4400]);
  });
});

describe('nextFreePort', () => {
  it('starts at 8081, leaving 8080 to the primary checkout', () => {
    expect(nextFreePort([])).toBe(8081);
  });
  it('skips ports other worktrees have claimed', () => {
    expect(nextFreePort([8081, 8082, 8083])).toBe(8084);
  });
  it('fills a hole rather than always climbing', () => {
    expect(nextFreePort([8081, 8083])).toBe(8082);
  });
  it('never hands out a reserved port', () => {
    // 3001/3002 belong to intake-sim and wip-preview; 8080 to the primary checkout.
    const taken = Array.from({ length: 20 }, (_, i) => 8081 + i);
    const p = nextFreePort(taken);
    expect([8080, 3001, 3002]).not.toContain(p);
    expect(p).toBe(8101);
  });

  it('throws rather than inventing a port when the range is exhausted', () => {
    const everything = Array.from({ length: 120 }, (_, i) => 8081 + i);
    expect(() => nextFreePort(everything, 8081, 8200)).toThrow(/no free dev-server port/);
  });
});

/**
 * Provisioning is CREATE plus SCAFFOLD, and nothing else.
 *
 * `npm install` used to run here — minutes, ~1.2 GB — before a worker had read
 * a line of source, and stages 0-2 need no node_modules at all. It is gone: the
 * worktree is reported ready without dependencies, and the skill installs them
 * at the moment a worker first needs to build, test or serve.
 */
describe('Provisioner — phases', () => {
  const issue = { number: 4400, title: 'A brand new thing', labels: ['bug'] };

  function fakeExec(script: {
    worktree?: { code: number; output: string; createDir?: boolean; delayMs?: number };
  }) {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const exec = async (
      cmd: string,
      args: string[],
      opts: { cwd: string; onOutput?: (s: string) => void },
    ): Promise<{ code: number }> => {
      calls.push({ cmd, args, cwd: opts.cwd });
      if (cmd.includes('git-new-worktree')) {
        const w = script.worktree ?? { code: 0, output: 'created', createDir: true };
        if (w.delayMs) await new Promise((r) => setTimeout(r, w.delayMs));
        if (w.createDir !== false) mkdirSync(join(repo, '.worktrees', 'issue-4400-a-brand-new-thing', 'supabase'), { recursive: true });
        opts.onOutput?.(w.output);
        return { code: w.code };
      }
      // Nothing else may be run from provisioning. If this ever fires, something
      // has been put back that was deliberately taken out.
      throw new Error(`provisioning ran an unexpected command: ${cmd} ${args.join(' ')}`);
    };
    return { exec, calls };
  }

  it('walks creating -> ready, and NEVER runs npm install', async () => {
    const { exec, calls } = fakeExec({});
    const seen: string[] = [];
    const p = new Provisioner({ repoPath: repo, exec });

    const plan = p.plan(issue, []);
    expect(plan.branch).toBe('fix/issue-4400-a-brand-new-thing');
    expect(plan.port).toBe(8081);

    const done = p.start(plan, () => {
      const phase = p.job(4400)!.phase;
      if (seen[seen.length - 1] !== phase) seen.push(phase);
    });
    await done;

    expect(seen).toEqual(['creating', 'ready']);
    expect(p.job(4400)!.error).toBeNull();
    // THE WHOLE POINT: one command ran, and it was the worktree script.
    expect(calls.map((c) => c.cmd.split('/').pop())).toEqual(['git-new-worktree.sh']);
    expect(calls.some((c) => c.cmd === 'npm')).toBe(false);
  });

  it('reports READY without node_modules, and says so in .issue-state.md', async () => {
    const { exec } = fakeExec({});
    const p = new Provisioner({ repoPath: repo, exec });
    const plan = p.plan(issue, []);
    await p.start(plan, () => {});

    expect(p.job(4400)!.phase).toBe('ready');
    // A missing node_modules is the EXPECTED state here. If the worktree does
    // not say so, the next person to look reads it as breakage.
    expect(existsSync(join(plan.worktreePath, 'node_modules'))).toBe(false);
    const state = readFileSync(join(plan.worktreePath, '.issue-state.md'), 'utf8');
    expect(state).toContain('NOT installed');
    expect(state).toMatch(/npm install` has deliberately NOT been run/);
  });

  it('scaffolds .issue-state.md and the two env symlinks inside the NEW worktree', async () => {
    const { exec } = fakeExec({});
    const p = new Provisioner({ repoPath: repo, exec });
    const plan = p.plan(issue, []);
    await p.start(plan, () => {});

    const state = readFileSync(join(plan.worktreePath, '.issue-state.md'), 'utf8');
    expect(state).toContain('# Issue #4400 — A brand new thing');
    expect(state).toContain('fix/issue-4400-a-brand-new-thing');
    expect(state).toContain('8081');
    expect(state).toContain('Stage reached**: 0');

    expect(lstatSync(join(plan.worktreePath, '.env')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(plan.worktreePath, 'supabase', '.env.local')).isSymbolicLink()).toBe(true);
  });

  it('a failed worktree script leaves nothing behind and runs nothing else', async () => {
    const { exec, calls } = fakeExec({ worktree: { code: 1, output: 'Error: already exists', createDir: false } });
    const p = new Provisioner({ repoPath: repo, exec });
    const plan = p.plan(issue, []);
    await p.start(plan, () => {});

    expect(p.job(4400)!.phase).toBe('failed');
    expect(calls).toHaveLength(1);
  });

  it('fails loudly if the script exits 0 but no worktree appeared', async () => {
    const { exec } = fakeExec({ worktree: { code: 0, output: 'nothing happened', createDir: false } });
    const p = new Provisioner({ repoPath: repo, exec });
    const plan = p.plan(issue, []);
    await p.start(plan, () => {});
    expect(p.job(4400)!.phase).toBe('failed');
    expect(p.job(4400)!.error).toContain('did not appear');
  });

  it('refuses to start a second provision for an issue already being provisioned', async () => {
    const { exec } = fakeExec({ worktree: { code: 0, output: 'creating', delayMs: 40 } });
    const p = new Provisioner({ repoPath: repo, exec });
    const plan = p.plan(issue, []);
    const first = p.start(plan, () => {});
    await expect(p.start(plan, () => {})).rejects.toThrow(/already/i);
    await first;
  });

  it('keeps a partial git recovery failure visible and removes its retry action', async () => {
    const path = join(repo, '.worktrees', 'issue-4400-a-brand-new-thing');
    const exec = async (cmd: string): Promise<{ code: number }> => {
      if (cmd !== 'git') throw new Error(`unexpected command ${cmd}`);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'partial-checkout.txt'), 'preserve for inspection\n');
      return { code: 1 };
    };
    const p = new Provisioner({
      repoPath: repo,
      exec,
      branchExists: async () => true,
      inspectBranch: async () => ({ head: 'existing-head', worktreePath: null }),
    });
    const plan = p.plan(issue, []);
    await p.start(plan, () => {});
    expect(p.job(issue.number)?.code).toBe('branch-exists');

    const out = await p.continueExistingBranch(issue, () => {});

    expect(out.ok).toBe(false);
    expect(p.job(issue.number)?.phase).toBe('failed');
    expect(p.job(issue.number)?.code).toBeNull();
    expect(readFileSync(join(path, 'partial-checkout.txt'), 'utf8')).toBe('preserve for inspection\n');
  });

  it('does not silently switch a reviewed restore to use an exact worktree that appeared', async () => {
    const path = join(repo, '.worktrees', 'issue-4400-a-brand-new-thing');
    let writes = 0;
    const p = new Provisioner({
      repoPath: repo,
      exec: async () => {
        writes += 1;
        return { code: 0 };
      },
      branchExists: async () => true,
      inspectBranch: async () => {
        mkdirSync(path, { recursive: true });
        return { head: 'existing-head', worktreePath: path };
      },
    });
    const plan = p.plan(issue, []);
    await p.start(plan, () => {});

    const out = await p.continueExistingBranch(issue, () => {}, 'existing-head', 'restore');

    expect(out.ok).toBe(false);
    expect(out.message).toContain('appeared since the recovery plan');
    expect(p.job(issue.number)?.code).toBe('branch-exists');
    expect(writes).toBe(0);
  });

  it('refuses outright when the worktree directory is already there', async () => {
    mkdirSync(join(repo, '.worktrees', 'issue-4400-a-brand-new-thing'), { recursive: true });
    const { exec, calls } = fakeExec({});
    const p = new Provisioner({ repoPath: repo, exec });
    const plan = p.plan(issue, []);
    await p.start(plan, () => {});

    expect(p.job(4400)!.phase).toBe('failed');
    expect(p.job(4400)!.error).toContain('already exists');
    expect(calls).toHaveLength(0); // nothing was run at all
    expect(existsSync(join(repo, '.worktrees', 'issue-4400-a-brand-new-thing', '.issue-state.md'))).toBe(false);
  });

  /**
   * The fake-exec tests above prove the phase machine. This one runs the real
   * spawn path against a stand-in repo, so `realExec`, the symlinks and the
   * state scaffold are exercised for real — never against example-repo.
   */
  it('end to end with the real executor, against a stand-in repo', async () => {
    writeFileSync(
      join(repo, 'scripts', 'git-new-worktree.sh'),
      // Stands in for `git worktree add`: makes the directory and checks the tree out.
      `#!/usr/bin/env bash\nset -euo pipefail\nDIR=".worktrees/\${1##*/}"\nmkdir -p "$DIR/supabase"\ncp package.json "$DIR/package.json"\necho "Creating worktree: $1"\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'standin', private: true }));

    const p = new Provisioner({ repoPath: repo, branchExists: async () => false });
    const plan = p.plan(issue, []);
    await p.start(plan, () => {});

    const job = p.job(4400)!;
    expect(job.phase).toBe('ready');
    expect(job.error).toBeNull();
    expect(job.logTail.join('\n')).toContain('Creating worktree: fix/issue-4400-a-brand-new-thing');

    expect(lstatSync(join(plan.worktreePath, '.env')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(plan.worktreePath, 'supabase', '.env.local')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(plan.worktreePath, '.issue-state.md'), 'utf8')).toContain('Stage reached**: 0');
    // Nothing was installed, for real: no lockfile, no node_modules. That is
    // minutes and ~1.2 GB this path no longer spends before a worker has read
    // a line of source.
    expect(existsSync(join(plan.worktreePath, 'package-lock.json'))).toBe(false);
    expect(existsSync(join(plan.worktreePath, 'node_modules'))).toBe(false);
  }, 60_000);

  it('the plan carries the exact commands, for the confirm dialog', () => {
    const { exec } = fakeExec({});
    const plan = new Provisioner({ repoPath: repo, exec }).plan(issue, [8081]);
    expect(plan.port).toBe(8082);
    expect(plan.commands).toEqual([
      `cd ${repo}`,
      './scripts/git-new-worktree.sh fix/issue-4400-a-brand-new-thing',
      `cd ${plan.worktreePath}`,
      'ln -s ../../.env .env',
      'ln -s ../../../supabase/.env.local supabase/.env.local',
    ]);
    // The dialog says what runs. It must not promise an install that no longer happens.
    expect(plan.commands.join('\n')).not.toContain('npm install');
  });
});

/**
 * The window the poll-side fix left open, which the operator hit on #4405.
 *
 * `staleFenceJobs` drops the refusal once a scan finds the worktree — but that
 * is the NEXT poll. Between the click and that poll the row wears a red
 * "Setting the worktree up failed" card over a worktree that is present,
 * scaffolded and fine. The operator saw it, reasonably read it as broken, and
 * asked for it to be fixed a second time.
 *
 * The cure is to stop making the job at all. `worktreePlan` already refuses when
 * `#scans` knows about the worktree, but `#scans` is a cache: it is empty until
 * the first poll finishes, and a poll behind after that. The DISK is not a
 * cache, and by the time the fence has spoken we have already asked it.
 */
describe('an issue that already has a worktree is told so, not failed', () => {
  it('reports the existing worktree as a plain refusal, with no job recorded', async () => {
    const verdict = await checkCreatable({
      worktreeRoot: '/repo/.worktrees',
      worktreePath: '/repo/.worktrees/issue-4405-thing',
      branch: 'fix/issue-4405-thing',
      pathExists: async () => true,
      branchExists: async () => false,
    });
    // The caller can act on this without reading English, which is the whole
    // point of the code: `exists` means "the end state you asked for is already
    // true", and that is not a failure to show anybody.
    expect(verdict.code).toBe('exists');
    expect(verdict.ok).toBe(false);
  });

  it('still FAILS loudly when the branch exists but the worktree does not', () => {
    // Not the same thing at all: no worktree was made, so there is nothing to
    // pick up and the refusal is real news.
    expect(staleFenceJobs([{ issue: 4405, phase: 'failed', code: 'branch-exists' }], () => true)).toEqual([]);
  });
});
