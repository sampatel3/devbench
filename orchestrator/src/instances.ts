import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseDockerTable, parseMemoryPressure } from './resources.js';

const run = promisify(execFile);

/**
 * What is actually running on this machine, and the fence that decides whether
 * any of it may be stopped.
 *
 * The measured truth this is built on (2026-08-11, the operator's laptop):
 *
 *  - there is exactly ONE local Supabase stack, shared by every worktree. A
 *    worktree does NOT get its own containers, so "more worktrees" does not mean
 *    "more Docker";
 *  - one container is the whole problem: the edge runtime had grown to 2.27 GB.
 *    Restarting it took 12s, dropped it to 381 MB and took system free memory
 *    from 33% to 46%. The database is untouched by that restart;
 *  - what actually scales per worker is the `claude` process (0.2–0.5 GB) and,
 *    much more so, the transient spike when a worker runs `npm run validate` or
 *    jest (1–2 GB each);
 *  - only ONE dev server was running (port 8083), not one per worktree.
 *
 * This module is READ-ONLY except for one thing, fenced below: stopping a dev
 * server that is provably a specific worktree's, on the operator's explicit
 * click. It is never automatic — a worker parked at a gate KEEPS its dev server,
 * because that gate is the operator's own QA of the running app.
 */

/**
 * THE FENCE. Port 8080 is the primary checkout's dev server, and it also serves
 * edge functions for every worktree — killing it breaks every worker at once.
 * It is refused by number, first, before any other reasoning can be reached.
 */
export const RESERVED_PORT = 8080;

/**
 * The worktree port registry: 8081–8099, as `references/parallel.md` allocates
 * them. A port is now KILL-RELEVANT — it is read out of free-text prose in
 * `.issue-state.md` by three loose regexes, and whatever comes back decides
 * which process gets a signal. So it is validated as a port in the registry
 * before it can be acted on, and anything else is a refusal.
 */
export const WORKTREE_PORT_MIN = 8081;
export const WORKTREE_PORT_MAX = 8099;

export function isWorktreePort(port: number | null | undefined): port is number {
  return (
    typeof port === 'number' &&
    Number.isInteger(port) &&
    port !== RESERVED_PORT &&
    port >= WORKTREE_PORT_MIN &&
    port <= WORKTREE_PORT_MAX
  );
}

export type ContainerRow = {
  name: string;
  bytes: number | null;
  label: string;
  /** The known leaker — the one container the console may restart. */
  isEdgeRuntime: boolean;
};

export type DevServerRow = {
  issue: number | null;
  worktree: string | null;
  port: number;
  pid: number | null;
  cwd: string | null;
  bytes: number | null;
  label: string;
  /** Whether this row may be stopped, and the plain-English why-not when it may not. */
  stoppable: boolean;
  reason: string;
};

export type WorkerRow = {
  issue: number;
  pid: number;
  bytes: number | null;
  label: string;
};

export type InstanceReport = {
  containers: ContainerRow[];
  devServers: DevServerRow[];
  workers: WorkerRow[];
  totals: {
    containerBytes: number | null;
    containerLabel: string;
    devServerBytes: number | null;
    devServerLabel: string;
    workerBytes: number | null;
    workerLabel: string;
  };
  freePct: number | null;
  /** Everything we could NOT read. An inventory that quietly omits a group is
   *  worse than one that says which tool was missing. */
  notes: string[];
  checkedAt: string;
};

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export function human(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  return bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${Math.round(bytes / MB)} MB`;
}

/**
 * A path as it actually is on disk. `resolve` only tidies a string up; it does
 * not follow symlinks, so `/var/folders/…` and `/private/var/folders/…` are the
 * same directory with two different names, and comparing them as strings makes
 * an attribution that should pass refuse forever with a misleading message
 * ("running in X, which is not inside Y" — where X and Y ARE the same place).
 *
 * A path that cannot be resolved is not "outside the worktree": it is a path we
 * could not read, and it comes back as an error that names itself.
 */
export function realOf(path: string): { path: string | null; error: string | null } {
  try {
    return { path: realpathSync(resolve(path)), error: null };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { path: null, error: err.code ?? err.message };
  }
}

/**
 * True when `child` is the same directory as `parent` or sits inside it, both
 * compared as their real paths. `refusal` is non-null when the question could
 * not be answered at all, and it says which path could not be read and why —
 * never the misleading "not inside" that an unresolvable path used to produce.
 */
export function isInside(child: string, parent: string): { inside: boolean; refusal: string | null } {
  const c = realOf(child);
  if (c.path === null) {
    return { inside: false, refusal: `could not resolve ${child} on disk (${c.error}) — refusing rather than guessing` };
  }
  const p = realOf(parent);
  if (p.path === null) {
    return { inside: false, refusal: `could not resolve ${parent} on disk (${p.error}) — refusing rather than guessing` };
  }
  const inside = c.path === p.path || c.path.startsWith(p.path.endsWith(sep) ? p.path : p.path + sep);
  return { inside, refusal: null };
}

/**
 * The half of the rule that needs no process: the 8080 fence, a worktree to
 * attribute to, and a registered port that is actually a worktree port. It is
 * separate so a port we would never act on is a port we never even probe.
 * Returns the refusal, or null when the port itself is acceptable.
 */
export function fenceRefusal(input: {
  issue: number | null;
  worktree: string | null;
  registeredPort: number | null;
}): string | null {
  const { issue, worktree, registeredPort } = input;
  const who = issue === null ? 'that worktree' : `#${issue}`;

  // FIRST, and by number: 8080 is the primary checkout's dev server and serves
  // edge functions for every worktree. Nothing below can ever be reached for it.
  if (registeredPort === RESERVED_PORT) {
    return (
      `port ${RESERVED_PORT} is the primary checkout's dev server — it also serves edge functions for every ` +
      `worktree, so the console will never stop it`
    );
  }
  if (!worktree) return 'no worktree, so nothing can be attributed to it';
  if (registeredPort === null) return `${who} has no port in its registry`;
  // The registered port is read out of prose. A number that is not a worktree
  // port is a misreading, not an instruction — refuse before it can be acted on.
  if (!isWorktreePort(registeredPort)) {
    return (
      `${who} registers port ${registeredPort}, which is not a worktree port ` +
      `(${WORKTREE_PORT_MIN}–${WORKTREE_PORT_MAX}) — refusing to act on a port read out of prose`
    );
  }
  return null;
}

/**
 * May we stop this dev server? Every rule is a refusal; the last line is the
 * only way through. Two things must BOTH hold: the process is listening on the
 * port this worktree is registered for, and its working directory is inside
 * that worktree. Anything unreadable is a refusal, never an assumption.
 */
export function decideStopDevServer(input: {
  issue: number | null;
  worktree: string | null;
  /** The port this worktree is registered for, from `.issue-state.md`. */
  registeredPort: number | null;
  /** The port we actually found a listener on. */
  port: number | null;
  pid: number | null;
  /** The listener's working directory, as read from the process itself. */
  cwd: string | null;
}): { ok: boolean; reason: string } {
  const { issue, worktree, registeredPort, port, pid, cwd } = input;
  const who = issue === null ? 'that worktree' : `#${issue}`;

  if (port === RESERVED_PORT) {
    return {
      ok: false,
      reason:
        `port ${RESERVED_PORT} is the primary checkout's dev server — it also serves edge functions for every ` +
        `worktree, so the console will never stop it`,
    };
  }
  const fence = fenceRefusal({ issue, worktree, registeredPort });
  if (fence) return { ok: false, reason: fence };
  // The fence has already refused both of these; this is how the compiler learns it.
  if (!worktree || registeredPort === null) return { ok: false, reason: 'no worktree to attribute this to' };
  if (port === null || port !== registeredPort) {
    return {
      ok: false,
      reason: `port ${port ?? 'none'} is not the port ${who} is registered for (${registeredPort})`,
    };
  }
  if (pid === null) return { ok: false, reason: `nothing is listening on port ${port}` };
  if (!cwd) {
    return {
      ok: false,
      reason: `could not read the working directory of pid ${pid} — refusing to kill a process we cannot attribute`,
    };
  }
  const attribution = isInside(cwd, worktree);
  if (attribution.refusal) return { ok: false, reason: attribution.refusal };
  if (!attribution.inside) {
    return {
      ok: false,
      reason: `pid ${pid} is running in ${cwd}, which is not inside ${worktree} — refusing`,
    };
  }
  return { ok: true, reason: `pid ${pid} on port ${port}, running in ${worktree}` };
}

/** `lsof -tiTCP:<port> -sTCP:LISTEN` → every pid holding that port, in order. */
export function parseListeningPids(out: string): number[] {
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const n = Number(line.trim());
    if (Number.isInteger(n) && n > 0 && !pids.includes(n)) pids.push(n);
  }
  return pids;
}

/** `lsof -a -p <pid> -d cwd -Fn` → the `n<path>` line. */
export function parseLsofCwd(out: string): string | null {
  for (const line of out.split('\n')) {
    if (line.startsWith('n/')) return line.slice(1).trim();
  }
  return null;
}

/** `ps -o pid=,rss=` → pid → resident bytes. RSS is in KB. */
export function parseRss(out: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) map.set(Number(m[1]), Number(m[2]) * 1024);
  }
  return map;
}

/** Null means the command could not be run at all — a missing tool, not silence. */
async function tryRun(cmd: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  try {
    const { stdout } = await run(cmd, args, { timeout: timeoutMs });
    return stdout;
  } catch {
    return null;
  }
}

export type InstanceProbes = {
  dockerStats: () => Promise<string | null>;
  /** EVERY pid listening on the port, not just the first — see `resolveDevServer`. */
  listeningPids: (port: number) => Promise<number[]>;
  cwdOf: (pid: number) => Promise<string | null>;
  rss: (pids: number[]) => Promise<Map<number, number>>;
  freePct: () => Promise<number | null>;
};

/** The real macOS/Unix probes. Each one degrades to null on its own. */
export const systemProbes: InstanceProbes = {
  dockerStats: () => tryRun('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}']),
  listeningPids: async (port) => {
    // `lsof` exits non-zero when nothing is listening, which tryRun reports as
    // null — indistinguishable from "no lsof", and that is fine here: both mean
    // "no pid", and the missing-tool case is reported once, from cwdOf.
    const out = await tryRun('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], 5_000);
    return out === null ? [] : parseListeningPids(out);
  },
  cwdOf: async (pid) => {
    const out = await tryRun('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], 5_000);
    return out === null ? null : parseLsofCwd(out);
  },
  rss: async (pids) => {
    if (pids.length === 0) return new Map();
    const out = await tryRun('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], 5_000);
    return out === null ? new Map() : parseRss(out);
  },
  freePct: async () => {
    if (platform() !== 'darwin') return null;
    const out = await tryRun('memory_pressure', []);
    return out === null ? null : parseMemoryPressure(out);
  },
};

/**
 * A machine that is not there. This is what a test gets unless it deliberately
 * wires one up — see the constructor of Orchestrator. Every probe reports
 * "could not read", which is a case the inventory already handles honestly.
 */
export const inertProbes: InstanceProbes = {
  dockerStats: async () => null,
  listeningPids: async () => [],
  cwdOf: async () => null,
  rss: async () => new Map(),
  freePct: async () => null,
};

/**
 * Which ONE process on this port is this worktree's dev server?
 *
 * `lsof -t` can name several pids for one port, and taking the first is a real
 * bug rather than a tidy shortcut: `npm run dev` is a wrapper that holds the
 * port through its child, so the first pid is often the PARENT. Signalling the
 * parent can leave the real server holding the port and the memory — the stop
 * reports success and frees nothing.
 *
 * So the pid is CHOSEN by the attribution rule, not by position: the one whose
 * working directory verifies as inside this worktree. If several qualify, or
 * none can be verified, this refuses and says so rather than guessing — a wrong
 * guess here is a killed process.
 *
 * Resolved ONCE per logical stop. The caller acts on the pid this returns and
 * never re-resolves, because a second resolution is a second target.
 */
export async function resolveDevServer(
  port: number,
  worktree: string,
  probes: InstanceProbes = systemProbes,
): Promise<{ pid: number | null; cwd: string | null; pids: number[]; reason: string }> {
  const pids = await probes.listeningPids(port);
  if (pids.length === 0) return { pid: null, cwd: null, pids, reason: `nothing is listening on port ${port}` };

  const candidates: Array<{ pid: number; cwd: string | null }> = [];
  for (const pid of pids) candidates.push({ pid, cwd: await probes.cwdOf(pid) });

  const inside = candidates.filter((c) => c.cwd !== null && isInside(c.cwd, worktree).inside);
  if (inside.length === 1) {
    return { pid: inside[0]!.pid, cwd: inside[0]!.cwd, pids, reason: `pid ${inside[0]!.pid} on port ${port}` };
  }
  if (inside.length > 1) {
    return {
      pid: null,
      cwd: null,
      pids,
      reason:
        `${inside.length} processes on port ${port} (${inside.map((c) => c.pid).join(', ')}) are all running inside ` +
        `${worktree} — refusing to guess which one is the dev server`,
    };
  }
  // Nothing verified. Say which pids were looked at and what was wrong with the
  // one closest to an answer, so the refusal is actionable rather than blank.
  const unreadable = candidates.filter((c) => c.cwd === null).map((c) => c.pid);
  if (unreadable.length === candidates.length) {
    return {
      pid: null,
      cwd: null,
      pids,
      reason:
        `could not read the working directory of ${unreadable.length === 1 ? 'pid ' : 'pids '}` +
        `${unreadable.join(', ')} on port ${port} — refusing to kill a process we cannot attribute`,
    };
  }
  const elsewhere = candidates.find((c) => c.cwd !== null)!;
  return {
    pid: null,
    cwd: elsewhere.cwd,
    pids,
    reason: `pid ${elsewhere.pid} is running in ${elsewhere.cwd}, which is not inside ${worktree} — refusing`,
  };
}

const sum = (values: Array<number | null>): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
};

/**
 * The inventory. Read-only from end to end: it runs `docker stats`, `lsof` and
 * `ps`, and it stops nothing. Every group degrades on its own — no docker still
 * reports dev servers, no lsof still reports containers — and whatever could not
 * be read is named in `notes` rather than shown as an empty group.
 */
export async function probeInstances(
  input: {
    edgeContainer: string;
    /** Every known worktree with its registered port. */
    worktrees: Array<{ issue: number; path: string; port: number | null }>;
    /** The workers this console knows it started. */
    workers: Array<{ issue: number; pid: number }>;
  },
  probes: InstanceProbes = systemProbes,
): Promise<InstanceReport> {
  const notes: string[] = [];
  if (platform() !== 'darwin') {
    notes.push(`system free % is macOS-only — not available on ${platform()}`);
  }

  const [dockerOut, freePct] = await Promise.all([probes.dockerStats(), probes.freePct()]);
  const containers: ContainerRow[] =
    dockerOut === null
      ? []
      : parseDockerTable(dockerOut).map((c) => ({
          name: c.name,
          bytes: c.bytes,
          label: c.bytes === null ? c.label : human(c.bytes),
          isEdgeRuntime: c.name === input.edgeContainer,
        }));
  if (dockerOut === null) notes.push('could not run `docker stats` — container memory is not shown');

  // One lsof per known worktree port, then one lsof for each pid we found.
  const devServers: DevServerRow[] = [];
  let lsofWorked = false;
  for (const tree of input.worktrees) {
    // The fence again, at the earliest possible point: 8080 — and anything that
    // is not a worktree port at all — is not even LOOKED at, so it can never
    // appear as a row with a Stop button on it.
    if (!isWorktreePort(tree.port)) continue;
    const resolved = await resolveDevServer(tree.port, tree.path, probes);
    if (resolved.pids.length === 0) continue;
    lsofWorked = true;
    const verdict =
      resolved.pid === null
        ? { ok: false, reason: resolved.reason }
        : decideStopDevServer({
            issue: tree.issue,
            worktree: tree.path,
            registeredPort: tree.port,
            port: tree.port,
            pid: resolved.pid,
            cwd: resolved.cwd,
          });
    devServers.push({
      issue: tree.issue,
      worktree: tree.path,
      port: tree.port,
      pid: resolved.pid,
      cwd: resolved.cwd,
      bytes: null,
      label: 'unknown',
      stoppable: verdict.ok,
      reason: verdict.reason,
    });
  }
  if (input.worktrees.some((t) => isWorktreePort(t.port)) && !lsofWorked) {
    notes.push('no dev server found on any worktree port (or `lsof` is unavailable)');
  }

  const rss = await probes.rss([
    ...devServers.map((d) => d.pid).filter((p): p is number => p !== null),
    ...input.workers.map((w) => w.pid),
  ]);
  for (const d of devServers) {
    d.bytes = d.pid === null ? null : (rss.get(d.pid) ?? null);
    d.label = human(d.bytes);
  }
  const workers: WorkerRow[] = input.workers.map((w) => {
    const bytes = rss.get(w.pid) ?? null;
    return { issue: w.issue, pid: w.pid, bytes, label: human(bytes) };
  });
  if (rss.size === 0 && (devServers.length > 0 || workers.length > 0)) {
    notes.push('could not run `ps` — process memory is not shown');
  }

  const containerBytes = containers.length === 0 ? null : sum(containers.map((c) => c.bytes));
  const devServerBytes = devServers.length === 0 ? null : sum(devServers.map((d) => d.bytes));
  const workerBytes = workers.length === 0 ? null : sum(workers.map((w) => w.bytes));

  return {
    containers,
    devServers,
    workers,
    totals: {
      containerBytes,
      containerLabel: human(containerBytes),
      devServerBytes,
      devServerLabel: human(devServerBytes),
      workerBytes,
      workerLabel: human(workerBytes),
    },
    freePct,
    notes,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Stop ONE worktree's dev server. The only kill in this module, and it happens
 * only on the operator's explicit click — from the instances panel, or as part of
 * stopping a worker that was actually running. Never automatically, and never
 * because a worker parked at a gate: that gate IS the operator's QA of the
 * running app.
 *
 * The target is resolved ONCE — port → pids → the one pid whose working
 * directory verifies as inside that worktree — and the signal goes to THAT pid.
 * Nothing is re-resolved along the way, because a second resolution taken a
 * moment later can name a different, newly started process.
 */
export async function stopDevServer(
  input: { issue: number | null; worktree: string | null; registeredPort: number | null },
  probes: InstanceProbes = systemProbes,
  kill: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM'),
): Promise<{ ok: boolean; message: string; pid?: number; port?: number }> {
  const { issue, worktree, registeredPort } = input;
  // The fence and the registry check FIRST, before any process is looked for: a
  // port we would never act on is a port we never even probe.
  const fence = fenceRefusal({ issue, worktree, registeredPort });
  if (fence) return { ok: false, message: fence };
  if (!worktree || registeredPort === null) return { ok: false, message: 'no worktree to attribute this to' };

  const resolved = await resolveDevServer(registeredPort, worktree, probes);
  if (resolved.pid === null) return { ok: false, message: resolved.reason };

  const verdict = decideStopDevServer({
    issue,
    worktree,
    registeredPort,
    port: registeredPort,
    pid: resolved.pid,
    cwd: resolved.cwd,
  });
  if (!verdict.ok) return { ok: false, message: verdict.reason };

  // The last check before the signal: is this still the process holding that
  // port? Between reading a pid's working directory and signalling it, that pid
  // could in principle exit and the number be reused — the window cannot be
  // closed from here (there is no atomic "kill this pid if it still owns this
  // port" on macOS), but it can be made as small as one lsof, which is what this
  // is. Residual window: the microseconds between this check and `kill`.
  const stillListening = await probes.listeningPids(registeredPort!);
  if (!stillListening.includes(resolved.pid)) {
    return {
      ok: false,
      message: `pid ${resolved.pid} is no longer listening on port ${registeredPort} — nothing was signalled`,
    };
  }

  try {
    kill(resolved.pid);
  } catch (e) {
    return { ok: false, message: `could not stop pid ${resolved.pid}: ${(e as Error).message}` };
  }
  return {
    ok: true,
    message: `stopped the dev server on port ${registeredPort} (pid ${resolved.pid})`,
    pid: resolved.pid,
    port: registeredPort!,
  };
}
