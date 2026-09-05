import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * "Is that pid still the worker we spawned?" — asked once, at startup, for each
 * worker `state.json` says was running when the console last stopped.
 *
 * Getting this wrong in the generous direction is the expensive mistake: an
 * adopted pid that is really some other process would be shown as an active
 * worker, and **Stop this worker** would then SIGTERM whatever now holds that
 * number. So the answer is only yes when three independent things agree, and
 * anything short of that reconciles the run as ended rather than adopting it.
 */

/** Signal 0 asks the kernel whether a pid exists and sends nothing. EPERM means
 *  it exists and belongs to somebody else — still alive, and exactly the case
 *  the identity check below is for. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type PsResult = {
  /** False only when there is no usable `ps` at all — then a command line proves
   *  nothing either way, and the file checks are all we have. */
  ran: boolean;
  commands: Map<number, string>;
};

export function parsePs(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S.*)$/);
    if (m) out.set(Number(m[1]), m[2]!.trim());
  }
  return out;
}

/**
 * ONE `ps` for every pid we are about to consider — never one per worker. It
 * runs at startup only, against at most `MAX_ACTIVE` pids, and its answer is the
 * full command line, which carries an identity token we chose before spawn.
 * Claude uses its session id; Codex uses its unique output-marker path because
 * Codex assigns the provider thread id only after the process has started. That
 * is what makes pid REUSE detectable rather than merely unlikely.
 */
export async function commandLines(pids: number[]): Promise<PsResult> {
  if (pids.length === 0) return { ran: true, commands: new Map() };
  const args = ['-ww', '-o', 'pid=,command=', '-p', pids.join(',')];
  try {
    const { stdout } = await run('ps', args, { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
    return { ran: true, commands: parsePs(stdout) };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string };
    // ps exits non-zero when NONE of the pids exist. It still ran, and "no such
    // process" is precisely the answer we want. A string code (ENOENT) is ps
    // itself missing, which is no answer at all.
    if (typeof err.code === 'number') return { ran: true, commands: parsePs(err.stdout ?? '') };
    return { ran: false, commands: new Map() };
  }
}

/** mtime granularity and clock skew: a file written in the same second the run
 *  started must not read as older than the run. */
export const MTIME_SLACK_MS = 2_000;

export type ReattachInput = {
  pidAlive: boolean;
  /** That pid's full command line from the batched ps; null = ps knows no such pid. */
  commandLine: string | null;
  /** False when ps could not be run at all. */
  psRan: boolean;
  /** Legacy Claude process identity and fallback for pre-provider persisted rows. */
  sessionId: string;
  /** Exact argv token chosen before spawn. Missing on legacy Claude rows, where
   * sessionId remains the process identity. */
  processIdentityToken?: string | null;
  streamExists: boolean;
  streamMtimeMs: number | null;
  startedAtMs: number;
};

/**
 * Yes only when: the process is there, its command line is still OUR run, and
 * the stream file it was writing to is there and is not older than the run.
 * Everything else is a no, with the plain reason — which becomes the reconcile
 * path, never a kill.
 */
export function decideReattach(i: ReattachInput): { attach: boolean; reason: string } {
  if (!i.streamExists) return { attach: false, reason: 'its stream file is gone' };
  if (!i.pidAlive) return { attach: false, reason: 'the process is no longer running' };
  if (i.psRan && i.commandLine === null) {
    return { attach: false, reason: 'ps has no such process' };
  }
  const processIdentity = i.processIdentityToken?.trim() || i.sessionId;
  if (i.psRan && i.commandLine !== null && !i.commandLine.includes(processIdentity)) {
    return { attach: false, reason: 'that pid belongs to a different process now' };
  }
  if (i.streamMtimeMs !== null && i.streamMtimeMs + MTIME_SLACK_MS < i.startedAtMs) {
    return { attach: false, reason: 'its stream file predates the run' };
  }
  return { attach: true, reason: 'still running' };
}
