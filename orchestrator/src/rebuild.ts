/**
 * REBUILD AND RESTART — from the page, and never at a worker's expense.
 *
 * The console serves a bundle it built, so a source change is invisible until
 * both halves are rebuilt and the server restarted. `StaleBundleBanner` exists
 * because of the other half of that: a page left open across a rebuild keeps
 * rendering with code that silently drops every field it does not know about.
 * So the button that rebuilds is also the thing that gets the page onto the new
 * bundle, and both halves live here.
 *
 * WHY A WORKER SURVIVES THIS — the whole reason it can be a button at all.
 * Nothing here goes near a worker. The build writes this repo's own `ui/dist`
 * and `orchestrator/dist` and nothing else; workers run in another repo's
 * worktrees entirely. The restart is the launch agent's own `kickstart -k`, and
 * three independent things make that survivable: every `claude` child is spawned
 * into its own process group, the agent is declared `AbandonProcessGroup` so
 * launchd will not sweep the group, and `Orchestrator.stop` deliberately leaves
 * running workers alone — then startup re-adopts them by pid (`reattach.ts`).
 * Observed end to end on 2026-09-02 with two workers mid-gate: "2 workers left
 * running — they are detached", then "re-attached #5502, #5539".
 *
 * WHY IT IS A DETACHED SHELL SCRIPT and not work done in this process: the
 * restart KILLS this process, so the thing performing it cannot be this process
 * or a child of it. The script is spawned into its own session, outlives the
 * kickstart, and writes what happened to a status file the NEXT console reads.
 * That file is the only way a failure can ever reach the page — a build that
 * fails means no restart, so there is no new server to ask.
 *
 * It builds the WORKING TREE as it stands, uncommitted changes included. That is
 * the point: the button exists to see a change you just made.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `building` and `restarting` are written by the script; `done` and `failed` are
 * its two endings. `idle` is the absence of a status file — no rebuild has ever
 * been asked for on this machine.
 */
export type RebuildState = 'idle' | 'building' | 'restarting' | 'failed' | 'done';

export type RebuildStatus = {
  state: RebuildState;
  /** When the state was written, ISO. Null on `idle`. */
  at: string | null;
  /** The tail of the build output — the only thing that explains a failure. */
  log: string;
  /** False when this console has no way to restart itself. */
  canRestart: boolean;
  /** Why it cannot, in the words the button will show. Null when it can. */
  why: string | null;
};

/** How long a `building` status is believed before it is treated as abandoned. */
const STALE_MS = 15 * 60_000;

/** How much of the build log the page is given. A tsc failure is short; a stack is not. */
const LOG_TAIL_BYTES = 8_000;

/**
 * The launch agent's label, or null when this console was not started by it.
 *
 * launchd sets `XPC_SERVICE_NAME` to the job label for a LaunchAgent, and a
 * plain `npm start` in a terminal either leaves it unset or sets it to `0`. The
 * prefix check is what makes the difference legible rather than assumed: the
 * only labels this console may kickstart are its own.
 */
export function launchdLabel(env: NodeJS.ProcessEnv = process.env): string | null {
  const label = env.XPC_SERVICE_NAME;
  if (typeof label !== 'string') return null;
  return label.startsWith('com.worker-console') ? label : null;
}

/** Both files live in the stream directory, which is already git-ignored. */
export function rebuildPaths(streamDir: string): { status: string; log: string } {
  return { status: join(streamDir, 'rebuild.status'), log: join(streamDir, 'rebuild.log') };
}

/**
 * Why this console cannot rebuild itself, or null when it can.
 *
 * Said as a sentence rather than a boolean because it is what the button shows,
 * and "Rebuild" that quietly does nothing is the failure this console is built
 * against.
 */
export function restartBlocker(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform !== 'darwin') return 'this console can only restart itself on macOS, through launchd';
  if (launchdLabel(env) === null) {
    return 'this console was not started by its launch agent, so it cannot restart itself — rebuild it in your terminal';
  }
  return null;
}

export function readRebuildStatus(streamDir: string, env: NodeJS.ProcessEnv = process.env): RebuildStatus {
  const paths = rebuildPaths(streamDir);
  const why = restartBlocker(env);
  const base = { canRestart: why === null, why };

  let state: RebuildState = 'idle';
  let at: string | null = null;
  try {
    const [word, stamp] = readFileSync(paths.status, 'utf8').split('\n');
    const w = (word ?? '').trim();
    if (w === 'building' || w === 'restarting' || w === 'failed' || w === 'done') state = w;
    at = (stamp ?? '').trim() || null;
  } catch {
    // No status file is the normal state on a machine that has never rebuilt.
  }

  let log = '';
  try {
    const all = readFileSync(paths.log, 'utf8');
    log = all.length > LOG_TAIL_BYTES ? all.slice(-LOG_TAIL_BYTES) : all;
  } catch {
    // A missing log with a `failed` status is itself worth showing as empty:
    // the page then says the build failed and offers no explanation, which is
    // true, rather than inventing one.
  }
  return { ...base, state, at, log };
}

/** True while a rebuild started recently enough to still believe in. */
export function rebuildInFlight(status: RebuildStatus, now = Date.now()): boolean {
  if (status.state !== 'building' && status.state !== 'restarting') return false;
  const started = status.at ? Date.parse(status.at) : NaN;
  // An unparseable or absent stamp on a live-looking status is treated as in
  // flight: refusing a second rebuild is cheap, and two `npm run build` runs
  // writing one `dist` is not.
  if (!Number.isFinite(started)) return true;
  return now - started < STALE_MS;
}

/**
 * The one-liner the detached shell runs. Built here so a test can read it.
 *
 * Every path is single-quoted because these come from config and a config path
 * may contain spaces. Nothing in it comes from a request — there is no input to
 * this route at all — so there is nothing to escape beyond that.
 */
export function rebuildScript(input: { repoRoot: string; streamDir: string; label: string; uid: number }): string {
  const paths = rebuildPaths(input.streamDir);
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const status = q(paths.status);
  const log = q(paths.log);
  const service = q(`gui/${input.uid}/${input.label}`);
  return [
    `cd ${q(input.repoRoot)} || exit 1`,
    // The stamp is written before the build so a status left behind by a machine
    // that slept mid-build can be aged out rather than believed for ever.
    `printf 'building\\n%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${status}`,
    `npm run build > ${log} 2>&1`,
    `if [ $? -ne 0 ]; then printf 'failed\\n%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${status}; exit 1; fi`,
    `printf 'restarting\\n%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${status}`,
    // This is the line that ends the console. What follows it runs because this
    // script is its own session leader, not a child of the process being killed.
    `if launchctl kickstart -k ${service} >> ${log} 2>&1; then`,
    `  printf 'done\\n%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${status}`,
    `else`,
    `  printf 'failed\\n%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${status}`,
    `fi`,
  ].join('\n');
}

/**
 * Start a rebuild, or refuse and say why. Returns as soon as the script is away:
 * the answer to "did it work?" arrives as a new `buildId` on `/api/version`, or
 * as a `failed` status carrying the build log.
 */
export function startRebuild(input: {
  repoRoot: string;
  streamDir: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  now?: number;
  /** Test seam. */
  spawnFn?: typeof spawn;
}): { ok: boolean; message: string } {
  const env = input.env ?? process.env;
  const blocked = restartBlocker(env);
  if (blocked !== null) return { ok: false, message: blocked };

  const status = readRebuildStatus(input.streamDir, env);
  if (rebuildInFlight(status, input.now ?? Date.now())) {
    return { ok: false, message: 'a rebuild is already running — nothing new was started' };
  }

  const label = launchdLabel(env)!;
  const uid = input.uid ?? process.getuid?.() ?? 0;
  const script = rebuildScript({ repoRoot: input.repoRoot, streamDir: input.streamDir, label, uid });

  // The status is stamped HERE as well as in the script, so a page that polls
  // immediately never sees the previous run's `done` and call it this one's.
  try {
    writeFileSync(rebuildPaths(input.streamDir).status, `building\n${new Date(input.now ?? Date.now()).toISOString()}\n`);
  } catch (e) {
    return { ok: false, message: `could not write the rebuild status — ${(e as Error).message}` };
  }

  const child = (input.spawnFn ?? spawn)('/bin/sh', ['-c', script], {
    cwd: input.repoRoot,
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { ok: true, message: 'rebuilding — the console restarts itself when the build passes' };
}
