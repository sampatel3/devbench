import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const GB = 1024 ** 3;

/**
 * The watcher: what the running workers are ACTUALLY costing, sampled while they
 * run.
 *
 * Why this module exists, precisely. On 2026-08-11 a 16 GB MacBook went down at
 * ~40 GB of pressure. Every memory guard in this console evaluated at DISPATCH —
 * "is there room to start another worker?" — and then never looked again. Two
 * workers reached Stage 4 Validate, whose `npm run validate` ends in bare `jest`
 * (cores−1 ≈ 9 workers, 1–2 GB each), and the dashboard went on reporting
 * "2.7 GB headroom" off a poll up to two minutes old while the machine died.
 *
 * So: a short tick that measures the process TREE under each worker, and a
 * ladder of responses that can act. Two honesty rules are baked into the shapes
 * below and must survive any edit:
 *
 *  - **RSS overcounts shared pages.** Each jest worker counts its own copy of
 *    shared libraries, so Σ tree is an over-estimate of what the workers really
 *    cost. Over-counting OUR OWN processes is the safe direction — we pause a
 *    hair early, never late — but the panel must never present Σ tree as "what
 *    the workers cost", only as "what these trees add up to".
 *  - **`memory_pressure` free % is the primary truth**, not our RSS sums: it
 *    sees Chrome, OrbStack's VM and everything else we cannot itemize. The trees
 *    say WHOSE FAULT; the free % says HOW BAD. A response ladder driven off our
 *    own sums would ignore the half of the machine we did not start.
 */

/** One row of `ps -axo pid=,ppid=,pgid=,rss=,stat=`. RSS is in bytes here; ps
 *  reports KB. `stat` is the state column — anything starting `T` is STOPPED,
 *  which is how a pause is verified rather than assumed. */
export type PsProc = { pid: number; ppid: number; pgid: number; rssBytes: number; stat: string };

/**
 * Parse the whole process table in one go.
 *
 * ONE `ps` per tick, never one per pid: parsing the full table and walking it in
 * memory is what makes a changing tree a non-problem. A pid that died since the
 * last tick is simply not in the snapshot, so no per-pid follow-up call can ever
 * hit ESRCH. Malformed lines are skipped rather than thrown on — a partial table
 * is still worth more than no measurement at all.
 */
export function parsePsForest(out: string): PsProc[] {
  const procs: PsProc[] = [];
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    const [pid, ppid, pgid, rss] = [Number(f[0]), Number(f[1]), Number(f[2]), Number(f[3])];
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid) || !Number.isFinite(rss)) continue;
    if (pid <= 0) continue;
    procs.push({ pid, ppid, pgid, rssBytes: rss * 1024, stat: f[4]! });
  }
  return procs;
}

/**
 * Every process in `rootPid`'s descendant tree, the root included.
 *
 * BFS over a ppid→children map built once per call. The visited set guards the
 * impossible cycle: a corrupt or racing snapshot that claims A is B's parent and
 * B is A's must not hang the watcher, because the watcher is the thing that is
 * supposed to still be running when everything else is in trouble.
 *
 * A root that is not in the snapshot returns an EMPTY tree, not an error: the
 * run just ended between the `ps` and the lookup, which is ordinary.
 */
export function treeOf(rootPid: number, procs: PsProc[]): PsProc[] {
  const byPid = new Map<number, PsProc>();
  const children = new Map<number, PsProc[]>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    const kids = children.get(p.ppid);
    if (kids) kids.push(p);
    else children.set(p.ppid, [p]);
  }
  const root = byPid.get(rootPid);
  if (!root) return [];

  const out: PsProc[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: PsProc[] = [root];
  while (queue.length > 0) {
    const p = queue.shift()!;
    out.push(p);
    for (const kid of children.get(p.pid) ?? []) {
      if (seen.has(kid.pid)) continue;
      seen.add(kid.pid);
      queue.push(kid);
    }
  }
  return out;
}

/** What one worker's whole tree looks like this tick. */
export type WorkerSample = {
  issue: number;
  /** the `claude` root we spawned */
  pid: number;
  /** processes in the tree — the fan-out, made visible. 11 under one worker is
   *  the picture that was missing on the night of the crash. */
  procCount: number;
  /** Σ rss over the tree. An over-estimate; see the module header. */
  treeBytes: number;
  /** every distinct process group in the tree, leader's group first — what a
   *  pause has to signal */
  pgids: number[];
  /** how many of them are in state T. A pause is VERIFIED, never assumed. */
  stoppedProcs: number;
};

export type WatchSample = {
  at: string;
  /** memory_pressure free %. Null = unreadable, which is never an act. */
  freePct: number | null;
  /** vm_stat reclaimable headroom. Null = unreadable. */
  headroomBytes: number | null;
  workers: WorkerSample[];
};

/** Measure each worker's tree out of one snapshot. */
export function sampleWorkers(procs: PsProc[], workers: Array<{ issue: number; pid: number }>): WorkerSample[] {
  return workers.map(({ issue, pid }) => {
    const tree = treeOf(pid, procs);
    // The leader's own group first: it is the one that holds the whole tree, and
    // signalling it first means the common case is done in one call.
    const pgids: number[] = [];
    for (const p of tree) if (!pgids.includes(p.pgid)) pgids.push(p.pgid);
    pgids.sort((a, b) => (a === pid ? -1 : b === pid ? 1 : a - b));
    return {
      issue,
      pid,
      procCount: tree.length,
      treeBytes: tree.reduce((sum, p) => sum + p.rssBytes, 0),
      pgids,
      stoppedProcs: tree.filter((p) => p.stat.startsWith('T')).length,
    };
  });
}

/** A MEASURED size, always to one decimal: 5.2 GB, 3.0 GB. The decimal is kept
 *  even when it is a zero, because these are readings and a reading that rounds
 *  itself to a whole number looks like a setting. */
export const gb = (b: number): string => `${(b / GB).toFixed(1)} GB`;

/** A CONFIGURED size — the spike allowance somebody typed as `WORKER_HEADROOM_GB=2`.
 *  It reads back the way it was written: "2 GB", not "2.0 GB". */
export const gbSetting = (b: number): string => `${Number((b / GB).toFixed(1))} GB`;

export type Forecast = {
  /** headroom − Σ per unpaused worker of max(0, spike − tree). Null when the
   *  headroom itself could not be read. */
  projectedHeadroomBytes: number | null;
  /** the sentence the header and the panel both print */
  sentence: string;
  /** projected ≥ one more spike — room for a surprise, not merely room for what
   *  is already committed */
  comfortable: boolean;
};

/**
 * The forward-looking number, and the direct answer to "the dashboard still
 * pretended there was headroom".
 *
 * It asks a different question from the free-% floor. The floor asks whether the
 * machine is comfortable NOW; this asks what happens if every worker that is
 * running hits its test spike AT ONCE — which is exactly the thing that had
 * already been set in motion when the dashboard last said everything was fine.
 *
 * It is a MODEL, not a measurement: the spike allowance is one configured number
 * per worker (`WORKER_HEADROOM_GB`, 2 GB), so the sentence says "~" and the panel
 * says what the allowance is. Observed peaks feed the eye, not this arithmetic.
 *
 * An unreadable headroom forecasts NOTHING and is deliberately `comfortable`:
 * an unmeasurable machine gets the old behaviour, exactly as `decideResources`
 * has always treated a null free %.
 */
export function forecast(input: {
  headroomBytes: number | null;
  spikeBytes: number;
  workers: Array<{ treeBytes: number; paused: boolean }>;
  /** The free % at which the floor pauses everything — quoted in the sentence so
   *  the reader knows what happens next. */
  floorFreePct?: number;
  /** Whether the floor actually acts. When it does not, the sentence must not
   *  promise that it will. */
  autoPauseFloor?: boolean;
}): Forecast {
  const running = input.workers.filter((w) => !w.paused);
  const n = running.length;
  const floorFreePct = input.floorFreePct ?? 5;
  const autoPauseFloor = input.autoPauseFloor ?? true;

  if (input.headroomBytes === null) {
    return {
      projectedHeadroomBytes: null,
      sentence:
        `${n === 0 ? 'No workers' : n === 1 ? '1 worker' : `${n} workers`} running. ` +
        `Headroom could not be read, so there is no forecast — the free % is the only signal.`,
      comfortable: true,
    };
  }

  const committed = running.reduce((sum, w) => sum + Math.max(0, input.spikeBytes - w.treeBytes), 0);
  const projected = input.headroomBytes - committed;
  const comfortable = projected >= input.spikeBytes;

  if (n === 0) {
    return {
      projectedHeadroomBytes: projected,
      sentence: `No workers running. Headroom ${gb(input.headroomBytes)} — nothing committed against it.`,
      comfortable,
    };
  }

  const spike = gbSetting(input.spikeBytes);
  const who =
    n === 1
      ? `1 worker running. If it hits a ${spike} test spike`
      : n === 2
        ? `2 workers running. If both hit a ${spike} test spike at once`
        : `${n} workers running. If all ${n} hit a ${spike} test spike at once`;
  // A negative projection is a real answer and must not be rounded into a
  // comfortable-looking "~0.0 GB".
  const landing = projected < 0 ? 'nothing left' : `~${gb(projected)}`;
  const verdict = comfortable
    ? 'room to spare.'
    : autoPauseFloor
      ? `NOT enough. Dispatch is held; the floor pauses workers at ${floorFreePct}% free.`
      : 'NOT enough. Dispatch is held; automatic pause is off, so nothing will pause on its own.';

  return {
    projectedHeadroomBytes: projected,
    sentence: `${who}, headroom ${gb(input.headroomBytes)} → ${landing} — ${verdict}`,
    comfortable,
  };
}

// ------------------------------------------------------------------- the ladder

export type WatchLevel = 'ok' | 'hold' | 'warn' | 'pause-largest' | 'floor';

export type WatchState = {
  level: WatchLevel;
  /** consecutive samples below the warn threshold */
  belowWarnCount: number;
  belowPauseCount: number;
  /** when the floor last fired. Non-null means it is SPENT until it re-arms. */
  firedFloorAt: string | null;
};

export const EMPTY_WATCH_STATE: WatchState = {
  level: 'ok',
  belowWarnCount: 0,
  belowPauseCount: 0,
  firedFloorAt: null,
};

/** How far free % has to recover before a banner steps back down. Without it the
 *  warn banner would flap on and off across 15.0%. */
export const HYSTERESIS_PCT = 3;

const RANK: Record<WatchLevel, number> = { ok: 0, hold: 1, warn: 2, 'pause-largest': 3, floor: 4 };

export type WatchLadderConfig = {
  minFreePct: number;
  warnFreePct: number;
  pauseFreePct: number;
  floorFreePct: number;
  /** level 3 automation — opt-IN, off by default. */
  autoPause: boolean;
  /** level 4 automation — ON by default (the operator's decision, 2026-08-11). */
  autoPauseFloor: boolean;
};

/**
 * The graduated response, as a pure function so every boundary is a test rather
 * than an observation about a live machine.
 *
 * The rules that matter, and why each one is here:
 *
 *  - **A null free % is never an act.** A machine we cannot measure gets the old
 *    behaviour, exactly like `decideResources` today. Acting on an absent
 *    measurement is how monitoring kills the thing it was watching.
 *  - **Levels 2 and 3 want two consecutive samples; the floor wants one.** jest
 *    can allocate gigabytes in seconds, so a two-sample confirmation at a 5 s
 *    cadence is a 10 s blind window, and at 5 % free the machine is seconds from
 *    the swap death spiral. A false positive at the floor costs one Resume
 *    click; a false negative costs the machine.
 *  - **De-escalation needs +3 points.** The warn banner clears at 18 %, not at
 *    15.1 %.
 *  - **The floor re-arms EXPLICITLY.** Once it has fired it does nothing more
 *    until every worker has been resumed AND free % has recovered past
 *    `pauseFreePct + 3`. It therefore cannot machine-gun pauses, and it cannot
 *    "fix" its own damage by firing again on the memory its last pause freed.
 *  - **An act is emitted once per transition**, on ENTERING a level, never while
 *    sitting in it.
 *
 * The automation may only ever PAUSE. There is no act here that kills, restarts
 * or un-pauses anything, and there must never be: un-pausing is your click, so
 * the system cannot flap.
 */
export function nextWatchState(
  prev: WatchState,
  sample: {
    at: string;
    freePct: number | null;
    forecastComfortable: boolean;
    /** Whether any worker is currently paused — the re-arm condition. */
    anyPaused: boolean;
  },
  cfg: WatchLadderConfig,
): { state: WatchState; act: null | { kind: 'pause-largest' | 'pause-all' } } {
  // Unmeasurable: back to plain 'ok', counters cleared, nothing done. The floor's
  // spent flag is KEPT — a tool going missing is not a recovery.
  if (sample.freePct === null) {
    return {
      state: { level: 'ok', belowWarnCount: 0, belowPauseCount: 0, firedFloorAt: prev.firedFloorAt },
      act: null,
    };
  }

  const free = sample.freePct;
  const belowWarnCount = free < cfg.warnFreePct ? prev.belowWarnCount + 1 : 0;
  const belowPauseCount = free < cfg.pauseFreePct ? prev.belowPauseCount + 1 : 0;

  let firedFloorAt = prev.firedFloorAt;
  if (firedFloorAt !== null && !sample.anyPaused && free >= cfg.pauseFreePct + HYSTERESIS_PCT) {
    firedFloorAt = null; // re-armed: everything is running again and the machine recovered
  }

  let level: WatchLevel;
  if (free < cfg.floorFreePct) level = 'floor';
  else if (belowPauseCount >= 2) level = 'pause-largest';
  else if (belowWarnCount >= 2) level = 'warn';
  else if (free < cfg.minFreePct || !sample.forecastComfortable) level = 'hold';
  else level = 'ok';

  // Hysteresis, on the three LOUD levels only: hold↔ok is the existing dispatch
  // floor said out loud and must keep tracking the real number, but a red banner
  // that blinks off at 15.1 % and back on at 14.9 % teaches you to ignore it.
  const floorOf: Record<WatchLevel, number> = {
    ok: 0,
    hold: 0,
    warn: cfg.warnFreePct,
    'pause-largest': cfg.pauseFreePct,
    floor: cfg.floorFreePct,
  };
  if (RANK[level] < RANK[prev.level] && RANK[prev.level] >= RANK.warn) {
    if (free < floorOf[prev.level] + HYSTERESIS_PCT) level = prev.level;
  }

  let act: null | { kind: 'pause-largest' | 'pause-all' } = null;
  if (level === 'floor' && prev.level !== 'floor' && firedFloorAt === null && cfg.autoPauseFloor) {
    act = { kind: 'pause-all' };
    firedFloorAt = sample.at;
  } else if (level === 'pause-largest' && prev.level !== 'pause-largest' && cfg.autoPause) {
    act = { kind: 'pause-largest' };
  }

  return { state: { level, belowWarnCount, belowPauseCount, firedFloorAt }, act };
}

// -------------------------------------------------------------------- probes

/**
 * The three things a tick touches. Injectable for the same reason everything
 * else that touches the machine is: a test must be able to prove the ladder
 * without reading — or acting on — the machine's actual memory.
 *
 * Deliberately NOT on this tick: `docker stats` (1–2 s) and anything `gh`
 * (network). `docker stats` stays on the 2-minute machine read; anything `gh`
 * stays on the 15-minute GitHub poll and the on-demand panel.
 */
export type WatchProbes = {
  /** `ps -axo pid=,ppid=,pgid=,rss=,stat=` — the whole table, ~20–50 ms */
  psForest: () => Promise<string>;
  /** `memory_pressure` — the gate signal, ~30 ms */
  memoryPressure: () => Promise<string>;
  /** `vm_stat` — reclaimable headroom, ~10 ms */
  vmStat: () => Promise<string>;
};

async function tryRun(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return ''; // a missing tool degrades to "unknown", never to a wedged queue
  }
}

export const realWatchProbes: WatchProbes = {
  psForest: () => tryRun('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,stat=']),
  memoryPressure: () => tryRun('memory_pressure', []),
  vmStat: () => tryRun('vm_stat', []),
};

/** Under vitest, unless a test wires the real thing. Empty output parses to an
 *  empty forest and a null free %, which the ladder treats as "never act". */
export const inertWatchProbes: WatchProbes = {
  psForest: async () => '',
  memoryPressure: async () => '',
  vmStat: async () => '',
};

/**
 * Pause or resume a whole process group.
 *
 * Verified on this machine before anything was built on it: a worker spawned
 * `detached: true` is a session and process-group leader (pgid === pid), npm,
 * jest and its workers inherit that pgid, and `kill(-pid, 'SIGSTOP')` puts the
 * grandchildren into state T along with the root. The tree stops as one.
 *
 * SIGSTOP/SIGCONT appear NOWHERE else in this codebase. Every pause goes through
 * `Orchestrator.pauseWorker` / `unpauseWorker` / `pauseAllWorkers`, which go
 * through here, which is what makes "the automation can only ever pause"
 * checkable rather than merely intended.
 */
export function signalProcessGroup(pgid: number, signal: 'SIGSTOP' | 'SIGCONT'): void {
  process.kill(-pgid, signal);
}
