import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, totalmem } from 'node:os';
import type { ResourceReport } from './types.js';

const run = promisify(execFile);
const GB = 1024 ** 3;

/**
 * The RAM guard keeps the operator's laptop responsive while they work. The real
 * gate is macOS memory-pressure FREE % — how much headroom the whole system has,
 * not the size of any one container. A secondary ceiling catches OUR own footprint
 * (Docker + dev servers) running away past the budget. On a 16 GB machine we
 * leave ~5 GB for macOS and the operator's own apps, so our ceiling is ~11 GB —
 * but the free-% floor is the real gate, the ceiling is a backstop.
 *
 * All signals are macOS-specific. If a tool is missing we ALLOW and say so — a
 * missing tool must never wedge the queue.
 */

/** `memory_pressure` → "System-wide memory free percentage: 33%". The gate signal. */
export function parseMemoryPressure(out: string): number | null {
  const m = out.match(/System-wide memory free percentage:\s*([\d.]+)%/i);
  return m ? Number(m[1]) : null;
}

/**
 * Available memory on macOS from `vm_stat`, for the headroom number shown in the
 * UI. `Pages free` alone is always near zero on a healthy Mac; inactive,
 * speculative and purgeable pages are reclaimable.
 */
export function parseVmStat(out: string): number | null {
  const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 0);
  if (!pageSize) return null;
  const pages = (name: string) => Number(out.match(new RegExp(`Pages ${name}:\\s+(\\d+)`))?.[1] ?? 0);
  const total = pages('free') + pages('inactive') + pages('speculative') + pages('purgeable');
  if (total === 0) return null;
  return total * pageSize;
}

/**
 * `sysctl -n vm.swapusage` → "total = 16384.00M  used = 15137.38M  free = 1246.62M".
 *
 * REPORTED, NEVER GATED. Swap % was briefly a dispatch ceiling and it was the
 * wrong control signal — twice over:
 *
 *  - It has no useful range on this machine. Every reading across one evening:
 *    92, 98, 96, 95, 92, 91. An 85% ceiling holds dispatch essentially always.
 *  - The denominator MOVES THE WRONG WAY. macOS resizes the swap file down as
 *    pressure eases: 16,384 → 15,360 → 13,312 → 11,264 MB in a single evening.
 *    Reclaiming 3.7 GB of real memory moved the number from 93% to 83%, because
 *    the ceiling shrank to meet it. A metric that barely notices a 3.7 GB
 *    improvement cannot be used to decide anything.
 *
 * The operator's correction, which was right: stop caring about swap and watch
 * free memory only — RAM can go to zero and the machine keeps operating. Free RAM
 * near zero is macOS working as designed, not a warning.
 *
 * So this stays on screen — it is useful for a human reading the machine — and
 * `decideResources` ignores it. Null when the line cannot be read.
 */
export function parseSwapUsage(out: string): { totalBytes: number; usedBytes: number; usedPct: number } | null {
  const size = (label: string): number | null => {
    const m = out.match(new RegExp(`${label}\\s*=\\s*([\\d.]+)([KMGT])`, 'i'));
    if (!m) return null;
    const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2]!.toUpperCase()];
    return mult ? Number(m[1]) * mult : null;
  };
  const totalBytes = size('total');
  const usedBytes = size('used');
  if (totalBytes === null || usedBytes === null) return null;
  // Swap off is a real answer, not a divide-by-zero: nothing is swapped, so 0%.
  const usedPct = totalBytes === 0 ? 0 : Math.round((usedBytes / totalBytes) * 100);
  return { totalBytes, usedBytes, usedPct };
}

const UNITS: Record<string, number> = {
  B: 1,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
};

function memToBytes(used: string | undefined): number | null {
  const m = used?.match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return null;
  const unit = UNITS[m[2]!.toUpperCase()];
  return unit ? Number(m[1]) * unit : null;
}

/** Every container `docker stats` reported, in the order it reported them. */
export function parseDockerTable(out: string): Array<{ name: string; bytes: number | null; label: string }> {
  const rows: Array<{ name: string; bytes: number | null; label: string }> = [];
  for (const line of out.split('\n')) {
    const [name, mem] = line.split('\t');
    if (!name?.trim()) continue;
    const used = mem?.split('/')[0]?.trim() ?? '';
    rows.push({ name: name.trim(), bytes: memToBytes(used), label: used });
  }
  return rows;
}

/** One named container's memory (for the restart-button label). */
export function parseDockerStats(out: string, container: string): { bytes: number; label: string } | null {
  const row = parseDockerTable(out).find((r) => r.name === container);
  return row && row.bytes !== null ? { bytes: row.bytes, label: row.label } : null;
}

/** Sum of every container's memory — our Docker footprint. */
export function parseDockerFootprint(out: string): number {
  return parseDockerTable(out).reduce((total, r) => total + (r.bytes ?? 0), 0);
}

const gb = (b: number) => `${(b / GB).toFixed(1)} GB`;

/**
 * The decision. Free % is the gate (below the floor → hold). Footprint over the
 * ceiling is a secondary hold. A null free % means we could not measure — allow,
 * never wedge.
 */
export function decideResources(input: {
  freePct: number | null;
  minFreePct: number;
  footprintBytes: number | null;
  ceilingBytes: number;
  /** Reclaimable headroom right now (vm_stat). Null when it could not be read. */
  headroomBytes?: number | null;
  /** What one more worker needs: itself plus room for a test spike. */
  headroomNeededBytes?: number;
  /**
   * The kernel's OWN verdict: `sysctl -n kern.memorystatus_vm_pressure_level`.
   * 1 = normal, 2 = warn, 4 = critical. Null when it could not be read.
   */
  pressureLevel?: number | null;
}): { ok: boolean; reason: string } {
  const { freePct, minFreePct, footprintBytes, ceilingBytes } = input;
  const headroomBytes = input.headroomBytes ?? null;
  const headroomNeededBytes = input.headroomNeededBytes ?? 0;
  const pressureLevel = input.pressureLevel ?? null;

  if (freePct === null) {
    return { ok: true, reason: 'could not read memory pressure — allowing (tool missing?)' };
  }
  // The kernel's own judgment, and the only whole-machine signal worth gating on.
  // It weighs compression, swap and page rates together — the thing Activity
  // Monitor shows. CRITICAL only: this machine sits at WARN as its ordinary
  // working state (it was at 2 all evening, including while perfectly healthy),
  // so holding at warn would hold almost always. Null holds nothing.
  if (pressureLevel !== null && pressureLevel >= 4) {
    return {
      ok: false,
      reason: `waiting on memory — macOS reports CRITICAL memory pressure (${freePct}% free)`,
    };
  }
  if (freePct < minFreePct) {
    return { ok: false, reason: `waiting on memory — ${freePct}% free, need ${minFreePct}%` };
  }
  // Forward-looking, and a different question from the free-% floor: the floor
  // asks "is the machine comfortable now", this asks "is there room for what a
  // NEW worker is about to do". A worker is 0.2–0.5 GB at rest, but `npm run
  // validate` or jest spikes 1–2 GB, and two of those at once is the real crash
  // risk on a 16 GB machine.
  if (headroomNeededBytes > 0 && headroomBytes !== null && headroomBytes < headroomNeededBytes) {
    return {
      ok: false,
      reason: `waiting on memory — ${gb(headroomBytes)} free, a worker needs ~${gb(headroomNeededBytes)} of headroom`,
    };
  }
  if (footprintBytes !== null && footprintBytes > ceilingBytes) {
    return {
      ok: false,
      reason: `waiting on memory — our footprint ${gb(footprintBytes)} is over the ${gb(ceilingBytes)} ceiling`,
    };
  }
  return { ok: true, reason: 'memory ok' };
}

async function tryRun(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { timeout: 10_000 });
    return stdout;
  } catch {
    return '';
  }
}

export async function probeResources(opts: {
  systemReserveBytes: number;
  minFreePct: number;
  edgeContainer: string;
  /** What one more worker plus its test spike needs free. 0 disables the check. */
  workerHeadroomBytes?: number;
}): Promise<ResourceReport> {
  const totalBytes = totalmem();
  const ceilingBytes = Math.max(0, totalBytes - opts.systemReserveBytes);

  if (platform() !== 'darwin') {
    // Not a Mac: none of these signals exist. Allow, and say so.
    return {
      ok: true,
      reason: 'memory guard is macOS-only — allowing on this platform',
      freePct: null,
      headroomBytes: 0,
      headroomLabel: 'n/a',
      minFreePct: opts.minFreePct,
      footprintBytes: null,
      footprintLabel: 'n/a',
      ceilingBytes,
      ceilingLabel: gb(ceilingBytes),
      totalBytes,
      edgeRuntimeLabel: null,
      edgeRuntimeBytes: null,
      workerHeadroomBytes: opts.workerHeadroomBytes ?? 0,
      swapUsedPct: null,
      swapLabel: 'n/a',
      pressureLevel: null,
      checkedAt: new Date().toISOString(),
    };
  }

  const [pressure, vm, swapOut, levelOut, docker] = await Promise.all([
    tryRun('memory_pressure', []),
    tryRun('vm_stat', []),
    tryRun('sysctl', ['-n', 'vm.swapusage']),
    tryRun('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
    tryRun('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}']),
  ]);

  const freePct = parseMemoryPressure(pressure);
  const headroom = parseVmStat(vm);
  const swap = parseSwapUsage(swapOut);
  const footprint = docker ? parseDockerFootprint(docker) : null;
  const edge = parseDockerStats(docker, opts.edgeContainer);
  // The kernel's own verdict — 1 normal, 2 warn, 4 critical. Reported always,
  // and at CRITICAL only it is the one whole-machine signal that holds dispatch.
  // Anything unreadable or zero is null: an unread sysctl gates nothing.
  const lvl = Number(String(levelOut ?? '').trim());
  const pressureLevel = Number.isFinite(lvl) && lvl > 0 ? lvl : null;

  const verdict = decideResources({
    freePct,
    minFreePct: opts.minFreePct,
    footprintBytes: footprint,
    ceilingBytes,
    headroomBytes: headroom,
    headroomNeededBytes: opts.workerHeadroomBytes ?? 0,
    pressureLevel,
  });

  return {
    ...verdict,
    freePct,
    swapUsedPct: swap?.usedPct ?? null,
    // An unreadable sysctl says so. It never becomes "0%", which would read as
    // a healthy machine on the strength of a measurement nobody took.
    swapLabel: swap === null ? 'swap unreadable' : `${gb(swap.usedBytes)} of ${gb(swap.totalBytes)} (${swap.usedPct}%)`,
    pressureLevel,
    headroomBytes: headroom ?? 0,
    headroomLabel: headroom === null ? 'unknown' : gb(headroom),
    minFreePct: opts.minFreePct,
    footprintBytes: footprint,
    footprintLabel: footprint === null ? 'unknown' : gb(footprint),
    ceilingBytes,
    ceilingLabel: gb(ceilingBytes),
    totalBytes,
    edgeRuntimeLabel: edge?.label ?? null,
    edgeRuntimeBytes: edge?.bytes ?? null,
    workerHeadroomBytes: opts.workerHeadroomBytes ?? 0,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * The operator's click on "Restart edge runtime", and nothing else. The edge
 * runtime is
 * the ONLY container the console ever restarts, by exact name — nothing here
 * stops, removes or prunes anything, and there is no automatic caller.
 *
 * The console does NOT decide on its own when to do this. See "Why there is no
 * automatic restart" in docs/INFO.md: the question the automatic path had to
 * answer — "is a worker running right now?" — has more answers than any check
 * of it managed to cover, and getting it wrong means pulling the edge functions
 * out from under a live worker to save one click.
 */
export async function restartEdgeRuntime(container: string): Promise<string> {
  const { stdout, stderr } = await run('docker', ['restart', container], { timeout: 60_000 });
  return (stdout + stderr).trim();
}
