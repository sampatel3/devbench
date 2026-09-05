import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Kill every stub worker this test's console spawned. Call it FIRST in
 * `afterEach`, unconditionally.
 *
 * A worker is spawned detached and `unref`'d — that is the design, and it is why
 * `Orchestrator.stop()` deliberately kills nothing. The cost is that a test
 * which fails an assertion never reaches its own cleanup, and leaves a real
 * `node` process behind polling every 25 ms for a go-file in a temp directory
 * that `afterEach` has just deleted. Five leaked processes were found on this
 * machine that way.
 *
 * The pids come from the console's OWN state file, which it writes the instant a
 * worker has a pid — so this only ever signals a process this test created. A
 * pid whose process has ended can be reused by anything on the machine, so `ps`
 * has to confirm it is still the stub before anything is signalled.
 */
export function killSpawnedWorkers(stateFile: string): void {
  let pids: number[];
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as { runningRuns?: Record<string, { pid?: number }> };
    pids = Object.values(raw.runningRuns ?? {}).map((r) => r.pid ?? 0);
  } catch {
    return; // no state file, or nothing readable in it: nothing was spawned
  }
  for (const pid of pids) {
    if (pid <= 1) continue;
    const stub = identify(pid);
    if (!stub.isStub) continue;
    try {
      // The WHOLE GROUP when this pid leads one, which it does: a worker is
      // spawned `detached: true`, so pgid === pid and every descendant — the
      // stub's own grandchild in the pause tests included — inherits it. Killing
      // only the root would leave that grandchild polling a temp directory that
      // afterEach has just deleted, which is the leak this file exists for.
      // Signalling the negative pid is only safe BECAUSE the identity check above
      // proved this pid is our stub and leads its own group.
      if (stub.leadsGroup) process.kill(-pid, 'SIGKILL');
      else process.kill(pid, 'SIGKILL');
    } catch {
      /* it ended between the check and the signal, which is the good outcome */
    }
  }
}

/** Is that pid still OUR stub worker — and does it lead its own process group? */
function identify(pid: number): { isStub: boolean; leadsGroup: boolean } {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'pgid=,command='], { encoding: 'utf8' });
    const pgid = Number(out.trim().split(/\s+/)[0]);
    return { isStub: out.includes('stub-worker.mjs'), leadsGroup: pgid === pid };
  } catch {
    return { isStub: false, leadsGroup: false }; // `ps` exits non-zero when there is no such process
  }
}
