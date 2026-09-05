import { describe, it, expect } from 'vitest';
import {
  parseVmStat,
  parseDockerFootprint,
  parseDockerStats,
  parseMemoryPressure,
  parseSwapUsage,
  decideResources,
} from '../src/resources.js';

const GB = 1024 ** 3;

// Real `vm_stat` output from this machine, trimmed.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     3722.
Pages active:                                 166103.
Pages inactive:                               164342.
Pages speculative:                               640.
Pages throttled:                                   0.
Pages wired down:                             188804.
Pages purgeable:                                   4.
"Translation faults":                     1234567890.
`;

// Real `memory_pressure` tail from this machine.
const MEM_PRESSURE = `The system has 17179869184 (1048576 pages with a page size of 16384).

Pages free: 3722
Pages purgeable: 4

System-wide memory free percentage: 33%
`;

const DOCKER = `supabase_edge_runtime_example-app_custom\t5.045GiB / 7.817GiB\t64.53%
supabase_db_example-app\t168.1MiB / 7.817GiB\t2.10%
supabase_studio_example-app\t137.9MiB / 7.817GiB\t1.72%`;

describe('parseMemoryPressure', () => {
  it('reads the system-wide free percentage', () => {
    expect(parseMemoryPressure(MEM_PRESSURE)).toBe(33);
  });
  it('is null when the line is absent, so the guard can degrade gracefully', () => {
    expect(parseMemoryPressure('nothing useful here')).toBeNull();
    expect(parseMemoryPressure('')).toBeNull();
  });
});

describe('parseVmStat — headroom before swap (the UI number)', () => {
  it('counts free + inactive + speculative + purgeable as available', () => {
    const bytes = parseVmStat(VM_STAT);
    const pages = 3722 + 164342 + 640 + 4;
    expect(bytes).toBe(pages * 16384);
  });
  it('returns null on unusable output', () => {
    expect(parseVmStat('')).toBeNull();
  });
});

describe('parseDockerFootprint — our Docker memory total', () => {
  it('sums every container’s memory use', () => {
    const total = parseDockerFootprint(DOCKER);
    expect(total).toBeCloseTo(5.045 * GB + 168.1 * 1024 ** 2 + 137.9 * 1024 ** 2, -6);
  });
  it('is 0 when docker is down (nothing running is not a footprint)', () => {
    expect(parseDockerFootprint('')).toBe(0);
  });
});

describe('parseDockerStats — one named container (for the restart button label)', () => {
  it('finds the leaking edge-runtime container', () => {
    const f = parseDockerStats(DOCKER, 'supabase_edge_runtime_example-app_custom');
    expect(f!.label).toBe('5.045GiB');
  });
  it('is null when that container is not running', () => {
    expect(parseDockerStats(DOCKER, 'nope')).toBeNull();
  });
});

/**
 * The corrected guard: the real gate is macOS memory-pressure FREE %, not the
 * edge-container size. A secondary ceiling catches our own Docker+dev footprint
 * running away. If we can't read the pressure at all we ALLOW — degrade
 * gracefully, never wedge the queue on a missing tool.
 */
describe('decideResources — system-memory guard', () => {
  const base = { minFreePct: 25, ceilingBytes: 11 * GB, footprintBytes: 4 * GB };

  it('allows when free% is well above the floor', () => {
    expect(decideResources({ ...base, freePct: 40 }).ok).toBe(true);
  });

  it('HOLDS just below the floor, and says the numbers', () => {
    const r = decideResources({ ...base, freePct: 24 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('waiting on memory — 24% free, need 25%');
  });

  it('allows exactly at the floor (the floor is "below this holds")', () => {
    expect(decideResources({ ...base, freePct: 25 }).ok).toBe(true);
  });

  it('allows just above the floor', () => {
    expect(decideResources({ ...base, freePct: 26 }).ok).toBe(true);
  });

  it('HOLDS when our footprint is just over the ceiling, even with free% ok', () => {
    const r = decideResources({ ...base, freePct: 50, footprintBytes: 11 * GB + 100 * 1024 ** 2 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('over the 11.0 GB ceiling');
  });

  it('allows when footprint is just under the ceiling', () => {
    const r = decideResources({ ...base, freePct: 50, footprintBytes: 11 * GB - 100 * 1024 ** 2 });
    expect(r.ok).toBe(true);
  });

  it('reports free% first when both free% and footprint are bad', () => {
    const r = decideResources({ ...base, freePct: 10, footprintBytes: 20 * GB });
    expect(r.reason).toContain('10% free');
  });

  it('ALLOWS when free% cannot be read — degrade gracefully, do not wedge', () => {
    const r = decideResources({ ...base, freePct: null });
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('could not read memory pressure');
  });

  it('does not block on a footprint it could not measure', () => {
    expect(decideResources({ ...base, freePct: 50, footprintBytes: null }).ok).toBe(true);
  });
});

/**
 * The forward-looking half of the guard. Free % says whether the machine is
 * comfortable NOW; this says whether there is room for what a new worker is
 * about to do. A worker at rest is 0.2–0.5 GB, but `npm run validate` or jest
 * spikes 1–2 GB, and two workers testing at once is the actual crash risk —
 * which MAX_ACTIVE cannot see at all.
 */
describe('decideResources — headroom for one more worker', () => {
  const base = { minFreePct: 25, ceilingBytes: 11 * GB, footprintBytes: 4 * GB, freePct: 50 };
  const needed = 2 * GB;

  it('HOLDS just under the headroom a worker needs, in gigabytes a person reads', () => {
    const r = decideResources({ ...base, headroomBytes: 1.4 * GB, headroomNeededBytes: needed });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('waiting on memory — 1.4 GB free, a worker needs ~2.0 GB of headroom');
  });

  it('allows exactly at the boundary, and just above it', () => {
    expect(decideResources({ ...base, headroomBytes: 2 * GB, headroomNeededBytes: needed }).ok).toBe(true);
    expect(decideResources({ ...base, headroomBytes: 2 * GB + 1, headroomNeededBytes: needed }).ok).toBe(true);
  });

  it('keeps the two memory reasons distinct — a free-% hold never mentions headroom', () => {
    const tight = decideResources({ ...base, freePct: 18, headroomBytes: 0.2 * GB, headroomNeededBytes: needed });
    expect(tight.reason).toBe('waiting on memory — 18% free, need 25%');
    expect(tight.reason).not.toContain('headroom');
  });

  it('does not block on headroom it could not measure, or when no headroom is asked for', () => {
    expect(decideResources({ ...base, headroomBytes: null, headroomNeededBytes: needed }).ok).toBe(true);
    expect(decideResources({ ...base, headroomBytes: 0, headroomNeededBytes: 0 }).ok).toBe(true);
  });
});


/**
 * SWAP — the signal that was missing on the night this was built for.
 *
 * The console reported "31% free" while swap was 15,137 MB of 16,384 used (92%)
 * with 8.37 GB compressed. Free % and swap disagree exactly when it matters:
 * one measures the room being reported, the other measures what has already
 * been paid to report it.
 */
describe('parseSwapUsage — the second memory signal', () => {
  // Verbatim from this machine: `sysctl -n vm.swapusage`.
  const SWAP = 'total = 16384.00M  used = 15137.38M  free = 1246.62M  (encrypted)';

  it('reads the real line the machine printed on the night it nearly went down', () => {
    expect(parseSwapUsage(SWAP)).toEqual({
      totalBytes: 16384 * 1024 ** 2,
      usedBytes: 15137.38 * 1024 ** 2,
      usedPct: 92,
    });
  });

  it('reads a healthy machine, and a gigabyte-suffixed one', () => {
    expect(parseSwapUsage('total = 2048.00M  used = 204.80M  free = 1843.20M')!.usedPct).toBe(10);
    expect(parseSwapUsage('total = 16.00G  used = 8.00G  free = 8.00G')!.usedPct).toBe(50);
  });

  it('calls swap-off 0% rather than dividing by zero', () => {
    expect(parseSwapUsage('total = 0.00M  used = 0.00M  free = 0.00M')).toEqual({
      totalBytes: 0,
      usedBytes: 0,
      usedPct: 0,
    });
  });

  it('is NULL when the sysctl said nothing usable — never a comfortable guess', () => {
    expect(parseSwapUsage('')).toBeNull();
    expect(parseSwapUsage('sysctl: unknown oid')).toBeNull();
    expect(parseSwapUsage('total = 16384.00M')).toBeNull(); // no `used`
  });
});

describe('decideResources — the kernel verdict gates, swap never does', () => {
  const base = { minFreePct: 12, ceilingBytes: 11 * GB, footprintBytes: 4 * GB };

  it('ignores swap entirely — 92% used with room free is NOT a hold', () => {
    // Swap % was briefly a ceiling and it was the wrong signal: every reading on
    // a real evening was 91-98%, and macOS shrinks the swap file as pressure
    // eases, so reclaiming 3.7 GB moved it only 93% -> 83%. The operator's point:
    // RAM can go to zero and the laptop carries on operating.
    expect(decideResources({ ...base, freePct: 31 }).ok).toBe(true);
    expect(decideResources({ ...base, freePct: 45 }).ok).toBe(true);
  });

  it('HOLDS when the kernel itself says CRITICAL, whatever the free % looks like', () => {
    const r = decideResources({ ...base, freePct: 40, pressureLevel: 4 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('CRITICAL');
    expect(r.reason).toContain('waiting on memory'); // a HOLD, never a pause or a kill
  });

  it('does NOT hold at WARN — this machine sits at warn as its working state', () => {
    expect(decideResources({ ...base, freePct: 40, pressureLevel: 2 }).ok).toBe(true);
    expect(decideResources({ ...base, freePct: 40, pressureLevel: 1 }).ok).toBe(true);
  });

  it('does NOT hold on a level it could not read', () => {
    expect(decideResources({ ...base, freePct: 40, pressureLevel: null }).ok).toBe(true);
  });

  it('still holds when free memory is genuinely low', () => {
    const r = decideResources({ ...base, freePct: 8 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('waiting on memory — 8% free, need 12%');
  });

  it('puts CRITICAL ahead of the free-%% floor, so one hold reads as one thing', () => {
    const r = decideResources({ ...base, freePct: 3, pressureLevel: 4 });
    expect(r.reason).toContain('CRITICAL');
  });
});
