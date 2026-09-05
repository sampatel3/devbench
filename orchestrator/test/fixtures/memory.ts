import type { ResourceReport } from '../../src/types.js';

const GB = 1024 ** 3;

/**
 * A comfortable machine, for tests that are about something else.
 *
 * Left unstubbed, `probeResources` shells out to the real `docker stats`,
 * `memory_pressure` and `vm_stat` — which is slow, makes the test's answer
 * depend on whatever else is running on the laptop, and hands the console real
 * measurements of a real machine it is allowed to act on.
 */
export function memoryOk(over: Partial<ResourceReport> = {}): ResourceReport {
  return {
    ok: true,
    reason: 'memory ok',
    freePct: 60,
    headroomBytes: 8 * GB,
    headroomLabel: '8.0 GB',
    minFreePct: 25,
    footprintBytes: 0,
    footprintLabel: '0.0 GB',
    ceilingBytes: 11 * GB,
    ceilingLabel: '11.0 GB',
    totalBytes: 16 * GB,
    edgeRuntimeLabel: null,
    edgeRuntimeBytes: null,
    workerHeadroomBytes: 2 * GB,
    checkedAt: new Date().toISOString(),
    ...over,
  };
}
