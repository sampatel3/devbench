import { spawn } from 'node:child_process';
import { lstat, symlink, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { branchNameFor, issueFromBranch, worktreeDirFor } from './naming.js';

/**
 * Creating worktrees is the ONE write this console is allowed to make under the
 * tracked repository's checkout, and it is create-only, forever:
 *
 *   - it may only ever bring a worktree that does not exist into existence;
 *   - it may never delete, modify, or write into an existing worktree;
 *   - every file it writes must land inside the worktree it just created.
 *
 * Those are the terms of the approval, so they are checked in code before
 * anything runs, and again before every single write.
 */

/** `preparing` is kept in the union for anything already persisted or on screen
 *  under it, but nothing enters it any more: provisioning is create + scaffold,
 *  and there is no long second step to be in the middle of. */
export type ProvisionPhase = 'creating' | 'preparing' | 'ready' | 'failed';

export type ProvisionPlan = {
  issue: number;
  title: string;
  branch: string;
  worktreePath: string;
  worktreeRoot: string;
  port: number;
  /** Shown verbatim in the confirm dialog. What you see is what runs. */
  commands: string[];
};

export type ProvisionJob = {
  issue: number;
  branch: string;
  worktreePath: string;
  port: number;
  phase: ProvisionPhase;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /**
   * A structured pre-write fence result, or `recovery-pending` after Git and
   * scaffolding succeeded but the scanner could not immediately verify them.
   * Null means a real failure happened after work began — or nothing failed.
   */
  code: ProvisionCode | null;
  logTail: string[];
};

export type ContinuationPlan = {
  issue: number;
  title: string;
  branch: string;
  worktreePath: string;
  port: number | null;
  head: string;
  mode: 'restore' | 'use-existing';
  commands: string[];
};

export type BranchInspection = {
  head: string;
  worktreePath: string | null;
};

type InspectBranch = (branch: string) => Promise<BranchInspection | null>;

export type ExecOptions = { cwd: string; onOutput?: (chunk: string) => void };
export type Exec = (cmd: string, args: string[], opts: ExecOptions) => Promise<{ code: number }>;

const RESERVED_PORTS = new Set([8080, 3001, 3002]);
const LOG_TAIL_LINES = 25;

function appendJobLog(job: ProvisionJob, onChange: () => void, chunk: string): void {
  for (const line of chunk.split('\n')) {
    if (line.trim()) job.logTail.push(line.trimEnd());
  }
  if (job.logTail.length > LOG_TAIL_LINES) job.logTail.splice(0, job.logTail.length - LOG_TAIL_LINES);
  onChange();
}

function failJob(
  job: ProvisionJob,
  onChange: () => void,
  message: string,
  code: ProvisionCode | null = null,
): void {
  job.phase = 'failed';
  job.error = message;
  job.code = code;
  job.finishedAt = new Date().toISOString();
  onChange();
}

export function nextFreePort(taken: number[], start = 8081, limit = 8200): number {
  const used = new Set(taken);
  for (let p = start; p <= limit; p++) {
    if (!used.has(p) && !RESERVED_PORTS.has(p)) return p;
  }
  throw new Error(`no free dev-server port between ${start} and ${limit}`);
}

/** True only when `child` sits strictly inside `parent`. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Why the fence said no, in a form the caller can act on.
 *
 * Only `exists` can ever mean "what you asked for is already there" — the other
 * two say nothing about whether a usable worktree is present, so only `exists`
 * may be dropped later. See `staleFenceJobs`.
 */
export type FenceCode = 'ok' | 'outside' | 'exists' | 'branch-exists';
/** `recovery-pending` means Git and scaffolding succeeded, but the scanner has
 *  not verified the exact path/branch yet. A later exact scan may clear it. */
export type ProvisionCode = FenceCode | 'recovery-pending';

export async function checkCreatable(input: {
  worktreeRoot: string;
  worktreePath: string;
  branch: string;
  pathExists: (p: string) => Promise<boolean>;
  branchExists: (b: string) => Promise<boolean>;
}): Promise<{ ok: boolean; reason: string; code: FenceCode }> {
  const { worktreeRoot, worktreePath, branch, pathExists, branchExists } = input;

  if (!isInside(worktreeRoot, worktreePath)) {
    return {
      ok: false,
      code: 'outside',
      reason: `refusing: ${worktreePath} is outside the worktree root ${worktreeRoot}.`,
    };
  }
  if (await pathExists(worktreePath)) {
    return {
      ok: false,
      code: 'exists',
      reason: `refusing: ${worktreePath} already exists. This console only ever creates new worktrees.`,
    };
  }
  if (await branchExists(branch)) {
    return {
      ok: false,
      code: 'branch-exists',
      reason: `refusing: branch ${branch} already exists. This console only ever creates new worktrees.`,
    };
  }
  return { ok: true, reason: 'creatable', code: 'ok' };
}

/**
 * Failed jobs the poll should drop, because what they refused to build is now
 * present and tracked.
 *
 * #4642: the console built a worktree at 12:25, lost sight of it, and a second
 * create at 12:28 was refused by the fence — correctly, it must never adopt a
 * directory it did not make. What was wrong was KEEPING that refusal as a
 * failure. `deriveStatus` reads provision before everything else, so a red card
 * reading "refusing: ... already exists" sat over a perfectly good worktree with
 * no way to clear it short of restarting the console.
 *
 * Only `exists` qualifies, and the reason is what each code implies about the
 * worktree on disk:
 *
 *   - `exists`        — the fence ran BEFORE anything was touched, so the
 *                       worktree a scan is now finding is untouched by this
 *                       failure. Nothing happened; nothing to report.
 *   - scaffolding     — `git-new-worktree.sh` HAD already run, so a scan finds a
 *     (code null)       half-built worktree. Dropping this would hide a missing
 *                       `.env` symlink behind a normal-looking row.
 *   - `branch-exists` — no worktree was made at all, so a scan finding one says
 *     / `outside`       nothing about this attempt either way.
 */
export function staleFenceJobs(
  jobs: ReadonlyArray<Pick<ProvisionJob, 'issue' | 'phase' | 'code'>>,
  hasWorktree: (issue: number) => boolean,
): number[] {
  return jobs.filter((j) => j.phase === 'failed' && j.code === 'exists' && hasWorktree(j.issue)).map((j) => j.issue);
}

/** Successful recovery whose immediate verification was interrupted may clear
 *  only when a later scan finds its exact recorded path and branch. */
export function verifiedRecoveryJobs(
  jobs: ReadonlyArray<Pick<ProvisionJob, 'issue' | 'phase' | 'code' | 'branch' | 'worktreePath'>>,
  exactWorktree: (job: Pick<ProvisionJob, 'issue' | 'branch' | 'worktreePath'>) => boolean,
): number[] {
  return jobs
    .filter((job) => job.phase === 'failed' && job.code === 'recovery-pending' && exactWorktree(job))
    .map((job) => job.issue);
}

/** Does this path exist? Exported so callers can ask the DISK rather than a
 *  cache before deciding whether there is anything to create. */
export const pathExists = (p: string): Promise<boolean> =>
  lstat(p).then(
    () => true,
    () => false,
  );

const exists = pathExists;

type CaptureResult = { code: number; stdout: string; stderr: string };

const capture = (cmd: string, args: string[], cwd: string): Promise<CaptureResult> =>
  new Promise((resolveCapture) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: CaptureResult) => {
      if (settled) return;
      settled = true;
      resolveCapture(result);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => finish({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
  });

/** Resolve the exact local branch tip and whether another worktree owns it. */
export async function inspectLocalBranch(repoPath: string, branch: string): Promise<BranchInspection | null> {
  const head = await capture('git', ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], repoPath);
  if (head.code !== 0) return null;
  const resolvedHead = head.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(resolvedHead)) throw new Error(`git returned an invalid head for ${branch}`);

  const listed = await capture('git', ['worktree', 'list', '--porcelain'], repoPath);
  if (listed.code !== 0) throw new Error(`git worktree list failed: ${listed.stderr.trim() || `code ${listed.code}`}`);

  const wanted = `refs/heads/${branch}`;
  let currentPath: string | null = null;
  let owner: string | null = null;
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) currentPath = line.slice('worktree '.length);
    if (line === `branch ${wanted}`) {
      if (owner !== null && owner !== currentPath) throw new Error(`branch ${branch} is registered more than once`);
      owner = currentPath;
    }
  }
  return { head: resolvedHead, worktreePath: owner };
}

/** The default executor: streams output, so the worktree script is visible as it runs. */
export const realExec: Exec = (cmd, args, opts) =>
  new Promise((resolveExec) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (d: Buffer) => opts.onOutput?.(String(d));
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', (e) => {
      opts.onOutput?.(e.message);
      resolveExec({ code: -1 });
    });
    child.on('close', (code) => resolveExec({ code: code ?? -1 }));
  });

export class Provisioner {
  #repoPath: string;
  #exec: Exec;
  #jobs = new Map<number, ProvisionJob>();
  #branchExists: (b: string) => Promise<boolean>;
  #inspectBranch: InspectBranch;

  constructor(opts: {
    repoPath: string;
    exec?: Exec;
    branchExists?: (b: string) => Promise<boolean>;
    inspectBranch?: InspectBranch;
  }) {
    this.#repoPath = opts.repoPath;
    this.#exec = opts.exec ?? realExec;
    this.#branchExists =
      opts.branchExists ??
      ((b) =>
        new Promise<boolean>((res) => {
          const p = spawn('git', ['-C', this.#repoPath, 'rev-parse', '--verify', `refs/heads/${b}`], {
            stdio: 'ignore',
          });
          p.on('close', (code) => res(code === 0));
          p.on('error', () => res(false));
        }));
    this.#inspectBranch = opts.inspectBranch ?? ((branch) => inspectLocalBranch(this.#repoPath, branch));
  }

  plan(issue: { number: number; title: string; labels: string[] }, takenPorts: number[]): ProvisionPlan {
    const branch = branchNameFor(issue);
    const worktreeRoot = join(this.#repoPath, '.worktrees');
    const worktreePath = join(worktreeRoot, worktreeDirFor(branch));
    const port = nextFreePort(takenPorts);
    return {
      issue: issue.number,
      title: issue.title,
      branch,
      worktreePath,
      worktreeRoot,
      port,
      commands: [
        `cd ${this.#repoPath}`,
        `./scripts/git-new-worktree.sh ${branch}`,
        `cd ${worktreePath}`,
        'ln -s ../../.env .env',
        'ln -s ../../../supabase/.env.local supabase/.env.local',
      ],
    };
  }

  job(issue: number): ProvisionJob | null {
    return this.#jobs.get(issue) ?? null;
  }

  jobs(): ProvisionJob[] {
    return [...this.#jobs.values()];
  }

  clear(issue: number): void {
    const j = this.#jobs.get(issue);
    if (j && (j.phase === 'ready' || j.phase === 'failed')) this.#jobs.delete(issue);
  }

  deferContinuationVerification(issue: number, message: string, onChange: () => void): void {
    const job = this.#jobs.get(issue);
    if (job) failJob(job, onChange, message, 'recovery-pending');
  }

  refreshContinuationPort(issue: number, takenPorts: number[], onChange: () => void): void {
    const job = this.#jobs.get(issue);
    if (!job || job.phase !== 'failed' || job.code !== 'branch-exists') return;
    job.port = nextFreePort(takenPorts);
    onChange();
  }

  /** Read-only recovery preview. The POST repeats every check after claiming the
   *  job; this answer exists so the browser can show what will run first. */
  async continuationPlan(issue: { number: number; title: string }, existingPort?: number | null): Promise<{
    ok: boolean;
    message: string;
    plan?: ContinuationPlan;
  }> {
    const job = this.#jobs.get(issue.number);
    if (!job || job.phase !== 'failed' || job.code !== 'branch-exists') {
      return { ok: false, message: `#${issue.number} has no existing-branch failure to continue` };
    }
    const identityError = this.#continuationIdentityError(issue.number, job);
    if (identityError) return { ok: false, message: identityError };

    let inspection: BranchInspection | null;
    try {
      inspection = await this.#inspectBranch(job.branch);
    } catch (error) {
      return { ok: false, message: `cannot inspect ${job.branch}: ${(error as Error).message}` };
    }
    if (!inspection) return { ok: false, message: `cannot continue: branch ${job.branch} no longer exists` };

    const pathPresent = await exists(job.worktreePath);
    if (inspection.worktreePath !== null) {
      if (inspection.worktreePath !== job.worktreePath || !pathPresent) {
        return {
          ok: false,
          message: `cannot continue: branch ${job.branch} is already checked out at ${inspection.worktreePath}`,
        };
      }
      return {
        ok: true,
        message: 'ready to use the existing worktree',
        plan: {
          issue: issue.number,
          title: issue.title,
          branch: job.branch,
          worktreePath: job.worktreePath,
          port: existingPort === undefined ? job.port : existingPort,
          head: inspection.head,
          mode: 'use-existing',
          commands: [],
        },
      };
    }
    if (pathPresent) {
      return { ok: false, message: `cannot continue: ${job.worktreePath} exists but is not a tracked worktree` };
    }

    return {
      ok: true,
      message: 'ready to restore the existing branch',
      plan: {
        issue: issue.number,
        title: issue.title,
        branch: job.branch,
        worktreePath: job.worktreePath,
        port: job.port,
        head: inspection.head,
        mode: 'restore',
        commands: [
          `cd ${this.#repoPath}`,
          `git worktree add ${job.worktreePath} ${job.branch}`,
          `cd ${job.worktreePath}`,
          'ln -s ../../.env .env',
          'ln -s ../../../supabase/.env.local supabase/.env.local',
        ],
      },
    };
  }

  async start(plan: ProvisionPlan, onChange: () => void): Promise<void> {
    const existing = this.#jobs.get(plan.issue);
    if (existing && (existing.phase === 'creating' || existing.phase === 'preparing')) {
      throw new Error(`#${plan.issue} is already being provisioned`);
    }

    const job: ProvisionJob = {
      issue: plan.issue,
      branch: plan.branch,
      worktreePath: plan.worktreePath,
      port: plan.port,
      phase: 'creating',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      code: null,
      logTail: [],
    };
    this.#jobs.set(plan.issue, job);

    const log = (chunk: string) => appendJobLog(job, onChange, chunk);
    const fail = (message: string, code: FenceCode | null = null) => failJob(job, onChange, message, code);

    // FENCE 1, checked before anything at all runs.
    const verdict = await checkCreatable({
      worktreeRoot: plan.worktreeRoot,
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      pathExists: exists,
      branchExists: this.#branchExists,
    });
    if (!verdict.ok) return fail(verdict.reason, verdict.code);

    onChange();

    // 1. The repo's own script. It is the only thing that touches the primary checkout.
    const script = join(this.#repoPath, 'scripts', 'git-new-worktree.sh');
    const created = await this.#exec(script, [plan.branch], { cwd: this.#repoPath, onOutput: log });
    if (created.code !== 0) return fail(`git-new-worktree.sh exited with code ${created.code}`);
    if (!(await exists(plan.worktreePath))) {
      return fail(`git-new-worktree.sh reported success but ${plan.worktreePath} did not appear`);
    }

    try {
      await this.#scaffold(plan, false);
    } catch (e) {
      return fail(`scaffolding the new worktree failed: ${(e as Error).message}`);
    }

    // NO `npm install`. It used to run here — minutes, ~1.2 GB — before a
    // worker had read a line of source, and stages 0-2 (preflight, the issue,
    // understanding the code) need no node_modules at all. The worker skill
    // already tells a worker to install when it first needs one, which is
    // the point at which the cost is actually being bought.
    //
    // So the worktree is READY without dependencies, and the card says so
    // plainly: a missing node_modules here is the expected state, not breakage.
    job.phase = 'ready';
    job.finishedAt = new Date().toISOString();
    onChange();
  }

  /**
   * Restore the exact worktree a failed create planned, using the issue branch
   * that already exists. This is opt-in and only follows a `branch-exists`
   * fence refusal: it never resets the branch, invents a path, or adopts an
   * unrelated directory.
   */
  async continueExistingBranch(
    issue: { number: number; title: string },
    onChange: () => void,
    expectedHead?: string,
    expectedMode?: ContinuationPlan['mode'],
  ): Promise<{ ok: boolean; message: string }> {
    const job = this.#jobs.get(issue.number);
    if (!job || job.phase !== 'failed' || job.code !== 'branch-exists') {
      return { ok: false, message: `#${issue.number} has no existing-branch failure to continue` };
    }

    const identityError = this.#continuationIdentityError(issue.number, job);
    if (identityError) {
      const message = identityError;
      failJob(job, onChange, message);
      return { ok: false, message };
    }
    const worktreeRoot = join(this.#repoPath, '.worktrees');

    // Claim this issue before the first disk await. Two recovery requests can
    // otherwise both pass the failed-job check and race two `git worktree add`
    // commands against the same branch and path.
    job.phase = 'creating';
    job.startedAt = new Date().toISOString();
    job.finishedAt = null;
    job.error = null;
    job.code = null;
    job.logTail = [];
    onChange();

    const pathPresent = await exists(job.worktreePath);
    let before: BranchInspection | null;
    try {
      before = await this.#inspectBranch(job.branch);
    } catch (error) {
      const message = `cannot inspect ${job.branch}: ${(error as Error).message}`;
      failJob(job, onChange, message);
      return { ok: false, message };
    }
    if (!before) {
      const message = `cannot continue: branch ${job.branch} no longer exists`;
      failJob(job, onChange, message);
      return { ok: false, message };
    }
    if (expectedHead && before.head !== expectedHead) {
      const message = `cannot continue: branch ${job.branch} changed since the recovery plan was reviewed`;
      failJob(job, onChange, message, 'branch-exists');
      return { ok: false, message };
    }
    if (before.worktreePath !== null) {
      // Another request or local actor may have attached the exact branch after
      // the orchestrator's fresh scan but before this preflight. That end state
      // is idempotent and requires no write; the orchestrator still demands an
      // exact normal scan before it clears this job.
      if (before.worktreePath === job.worktreePath && (pathPresent || (await exists(job.worktreePath)))) {
        if (expectedMode === 'restore') {
          const message = `cannot continue: the worktree appeared since the recovery plan was reviewed`;
          failJob(job, onChange, message, 'branch-exists');
          return { ok: false, message };
        }
        job.phase = 'ready';
        job.finishedAt = new Date().toISOString();
        onChange();
        return { ok: true, message: `using ${job.branch}, which is already attached at ${job.worktreePath}` };
      }
      const message = `cannot continue: branch ${job.branch} is already checked out at ${before.worktreePath}`;
      failJob(job, onChange, message);
      return { ok: false, message };
    }
    if (pathPresent) {
      const message = `refusing to continue: ${job.worktreePath} now exists but is not a tracked #${issue.number} worktree`;
      failJob(job, onChange, message);
      return { ok: false, message };
    }

    const log = (chunk: string) => appendJobLog(job, onChange, chunk);
    const restored = await this.#exec('git', ['worktree', 'add', job.worktreePath, job.branch], {
      cwd: this.#repoPath,
      onOutput: log,
    });
    if (restored.code !== 0) {
      // The command ran, so this is no longer a pre-write fence result. Git may
      // have left a path or a prunable registration even when neither is easy
      // to see; keep it as a real failure and never offer automatic retry.
      failJob(job, onChange, `restoring branch ${job.branch} exited with code ${restored.code}`);
      return { ok: false, message: job.error! };
    }
    if (!(await exists(job.worktreePath))) {
      failJob(job, onChange, `git worktree add reported success but ${job.worktreePath} did not appear`);
      return { ok: false, message: job.error! };
    }

    let after: BranchInspection | null;
    try {
      after = await this.#inspectBranch(job.branch);
    } catch (error) {
      failJob(job, onChange, `restored ${job.branch}, but could not verify it: ${(error as Error).message}`);
      return { ok: false, message: job.error! };
    }
    if (!after || after.head !== before.head || after.worktreePath !== job.worktreePath) {
      failJob(job, onChange, `restored ${job.branch}, but its branch head or worktree registration changed unexpectedly`);
      return { ok: false, message: job.error! };
    }

    const plan: ProvisionPlan = {
      issue: issue.number,
      title: issue.title,
      branch: job.branch,
      worktreePath: job.worktreePath,
      worktreeRoot,
      port: job.port,
      commands: [],
    };
    try {
      await this.#scaffold(plan, true);
    } catch (e) {
      // Git already attached the branch. This is no longer the harmless
      // preflight collision, so keep it as a real failure: a later click must
      // not clear a half-scaffolded worktree merely because the scanner sees it.
      failJob(job, onChange, `scaffolding the restored worktree failed: ${(e as Error).message}`);
      return { ok: false, message: job.error! };
    }

    job.phase = 'ready';
    job.finishedAt = new Date().toISOString();
    onChange();
    return { ok: true, message: `restored ${job.branch} at ${job.worktreePath}` };
  }

  #continuationIdentityError(issue: number, job: ProvisionJob): string | null {
    const worktreeRoot = join(this.#repoPath, '.worktrees');
    const expectedPath = join(worktreeRoot, worktreeDirFor(job.branch));
    if (
      issueFromBranch(job.branch) !== issue ||
      job.worktreePath !== expectedPath ||
      !isInside(worktreeRoot, job.worktreePath)
    ) {
      return `refusing to continue: the failed branch or worktree does not match #${issue}`;
    }
    return null;
  }

  async #scaffold(plan: ProvisionPlan, restored: boolean): Promise<void> {
    await this.#writeInside(plan, 'supabase', null); // ensure the directory exists
    await this.#linkInside(plan, '.env', '../../.env');
    await this.#linkInside(plan, join('supabase', '.env.local'), '../../../supabase/.env.local');
    await this.#writeInside(plan, '.issue-state.md', initialIssueState(plan, restored));
  }

  #assertInside(plan: ProvisionPlan, target: string): string {
    const full = join(plan.worktreePath, target);
    if (!isInside(plan.worktreePath, full)) {
      throw new Error(`refusing to write ${full}: outside the worktree this console created`);
    }
    return full;
  }

  async #writeInside(plan: ProvisionPlan, target: string, content: string | null): Promise<void> {
    const full = this.#assertInside(plan, target);
    if (content === null) {
      if (await exists(full)) {
        const found = await lstat(full);
        if (found.isDirectory() && !found.isSymbolicLink()) return;
        throw new Error(`refusing to use ${full}: expected a directory`);
      }
      await mkdir(full);
      return;
    }
    if (await exists(full)) return; // never overwrite anything, even here
    // `wx` closes the check/write race as well: an entry created after the
    // lstat above is preserved and turns scaffolding into a visible failure.
    await writeFile(full, content, { flag: 'wx' });
  }

  async #linkInside(plan: ProvisionPlan, target: string, pointsTo: string): Promise<void> {
    const full = this.#assertInside(plan, target);
    if (await exists(full)) return;
    await symlink(pointsTo, full);
  }
}

/** A created or restored worktree is never stateless: it starts with its port claimed. */
export function initialIssueState(plan: ProvisionPlan, restored = false): string {
  return `# Issue #${plan.issue} — ${plan.title}

- **Branch**: \`${plan.branch}\`
- **Worktree**: \`.worktrees/${worktreeDirFor(plan.branch)}\`
- **Dev-server port**: **${plan.port}** — claimed, not started
- **Stage reached**: ${restored ? 'unknown — restore complete; recover the current stage before changing code' : '0 — preflight not started'}
- **Gates passed**: ${restored ? 'recover from console history and branch evidence' : 'none'}
- **Dependencies**: NOT installed — no \`node_modules\` here yet

${restored ? 'Restored from the existing branch' : 'Created by worker-console'} on ${new Date().toISOString()}.
${restored ? 'The branch tip was preserved; it was not reset or recreated. The console did not start a new worker as part of this restore.' : 'Nothing has run in this worktree yet.'}
\`npm install\` has deliberately NOT been run in this new checkout: stages 0-2 need
no dependencies. Run it yourself the first time you need to build, test or start
the dev server. The worker skill owns this file from here on: update it
after every stage, and write \`.gate.json\` next to it at every gate stop.
`;
}
