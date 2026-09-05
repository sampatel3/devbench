import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RESERVED_PORT,
  WORKTREE_PORT_MAX,
  WORKTREE_PORT_MIN,
  decideStopDevServer,
  human,
  isInside,
  isWorktreePort,
  parseListeningPids,
  parseLsofCwd,
  parseRss,
  probeInstances,
  resolveDevServer,
  stopDevServer,
  type InstanceProbes,
} from '../src/instances.js';

/**
 * This module can kill processes on the operator's machine, so its tests are
 * mostly about what it REFUSES to do. The rules that matter:
 *
 *   1. port 8080 is never touched — it is the primary checkout's dev server and
 *      it serves edge functions for every worktree;
 *   2. the registered port has to BE a worktree port (8081–8099) before anything
 *      is done with it: it is read out of free-text prose, and it decides who
 *      gets a signal;
 *   3. nothing is killed unless it is listening on that worktree's own
 *      registered port AND its working directory is inside that worktree;
 *   4. where several processes hold the port — `npm run dev` is a wrapper, so
 *      this is the normal case, not an exotic one — the pid is CHOSEN by the
 *      attribution rule, and an ambiguous answer is a refusal.
 *
 * The paths are real directories in a temp dir, because the attribution rule now
 * goes through `realpath`: on macOS a temp dir is `/var/…` symlinked to
 * `/private/var/…`, which is exactly the case that used to refuse for ever with
 * a message saying the two were different places. No process is signalled and no
 * machine command is run anywhere in this file.
 */

let root: string;
let WORKTREE: string;
let OTHER: string;
let LOOKALIKE: string;
let LINK: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wc-inst-unit-')));
  WORKTREE = join(root, '.worktrees', 'issue-4336-pills');
  OTHER = join(root, '.worktrees', 'issue-4342-mounts');
  LOOKALIKE = `${WORKTREE}-old`;
  LINK = join(root, 'pills-link');
  for (const d of [WORKTREE, OTHER, LOOKALIKE, join(WORKTREE, 'src', 'components')]) {
    mkdirSync(d, { recursive: true });
  }
  symlinkSync(WORKTREE, LINK);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const attempt = (over: Partial<Parameters<typeof decideStopDevServer>[0]> = {}) =>
  decideStopDevServer({
    issue: 4336,
    worktree: WORKTREE,
    registeredPort: 8083,
    port: 8083,
    pid: 5150,
    cwd: WORKTREE,
    ...over,
  });

describe('isInside — the working-directory half of the attribution rule', () => {
  it('accepts the worktree itself and anything under it', () => {
    expect(isInside(WORKTREE, WORKTREE).inside).toBe(true);
    expect(isInside(join(WORKTREE, 'src', 'components'), WORKTREE).inside).toBe(true);
  });

  it('refuses a sibling worktree, the parent, and a same-prefix imposter', () => {
    expect(isInside(OTHER, WORKTREE).inside).toBe(false);
    expect(isInside(root, WORKTREE).inside).toBe(false);
    // The classic prefix bug: "…-pills-old" starts with "…-pills".
    expect(isInside(LOOKALIKE, WORKTREE).inside).toBe(false);
  });

  /**
   * The bug this is here for. A symlinked path — which every macOS temp dir is,
   * and which a worktree behind a symlinked home directory is — compared as a
   * string is a different place from itself, so a stop that should be allowed
   * refused for ever, and said the process was "not inside" a directory that it
   * was in fact inside.
   */
  it('follows symlinks, so the same directory by two names is the same directory', () => {
    expect(isInside(LINK, WORKTREE).inside).toBe(true);
    expect(isInside(WORKTREE, LINK).inside).toBe(true);
    expect(isInside(join(LINK, 'src'), WORKTREE).inside).toBe(true);
  });

  it('refuses a path it cannot resolve, and says that is the reason', () => {
    const r = isInside(join(root, 'gone'), WORKTREE);
    expect(r.inside).toBe(false);
    expect(r.refusal).toContain('could not resolve');
    expect(r.refusal).toContain('ENOENT');
    // Never the misleading answer.
    expect(r.refusal).not.toContain('not inside');
  });
});

describe('isWorktreePort — the registry range', () => {
  it('accepts 8081 to 8099 and nothing else', () => {
    expect(isWorktreePort(WORKTREE_PORT_MIN)).toBe(true);
    expect(isWorktreePort(WORKTREE_PORT_MAX)).toBe(true);
    expect(isWorktreePort(8083)).toBe(true);
    expect(isWorktreePort(RESERVED_PORT)).toBe(false);
    expect(isWorktreePort(8100)).toBe(false);
    expect(isWorktreePort(3000)).toBe(false);
    expect(isWorktreePort(null)).toBe(false);
    expect(isWorktreePort(8083.5)).toBe(false);
  });
});

describe('decideStopDevServer — right worktree stops, anything else refuses', () => {
  it('agrees when the port is that worktree’s and the process is running inside it', () => {
    const d = attempt();
    expect(d.ok).toBe(true);
    expect(d.reason).toContain('5150');
  });

  // THE fence. Hard-coded by number, checked first, and unreachable by any
  // combination of the other inputs.
  it('REFUSES port 8080, always, however right everything else looks', () => {
    const d = attempt({ port: RESERVED_PORT, registeredPort: RESERVED_PORT });
    expect(RESERVED_PORT).toBe(8080);
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('8080');
    expect(d.reason).toContain('edge functions');
  });

  it('REFUSES port 8080 even when a worktree claims to be registered for it', () => {
    expect(attempt({ registeredPort: RESERVED_PORT, port: 8083 }).ok).toBe(false);
    expect(attempt({ registeredPort: 8083, port: RESERVED_PORT }).ok).toBe(false);
  });

  /**
   * The registered port comes from three loose regexes over free-text
   * `.issue-state.md` — `localhost:(\d{4,5})` will happily match a port in a
   * sentence about something else — and it is now the number that decides which
   * process gets a signal. So it has to be a port from the registry.
   */
  it('REFUSES a registered port that is not a worktree port at all', () => {
    const d = attempt({ registeredPort: 3000, port: 3000 });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('8081');
    expect(d.reason).toContain('8099');
    expect(attempt({ registeredPort: 5432, port: 5432 }).ok).toBe(false);
    expect(attempt({ registeredPort: 8100, port: 8100 }).ok).toBe(false);
  });

  it('REFUSES a process whose working directory is another worktree', () => {
    const d = attempt({ cwd: OTHER });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('not inside');
  });

  it('REFUSES when the working directory cannot be read at all — never assumes', () => {
    const d = attempt({ cwd: null });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('cannot attribute');
  });

  it('REFUSES when the working directory no longer exists, naming the real reason', () => {
    const d = attempt({ cwd: join(root, 'was-deleted') });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('could not resolve');
  });

  it('REFUSES a port that is not the one this worktree is registered for', () => {
    const d = attempt({ port: 8084 });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('8083');
  });

  it('REFUSES when there is no worktree, no registered port, or nothing listening', () => {
    expect(attempt({ worktree: null }).ok).toBe(false);
    expect(attempt({ registeredPort: null }).ok).toBe(false);
    expect(attempt({ pid: null }).ok).toBe(false);
  });
});

describe('the process parsers', () => {
  it('reads EVERY listening pid out of lsof -t, in order, without duplicates', () => {
    expect(parseListeningPids('5150\n5151\n')).toEqual([5150, 5151]);
    expect(parseListeningPids('5150\n5150\n')).toEqual([5150]);
    expect(parseListeningPids('')).toEqual([]);
  });

  it('reads the working directory out of lsof -Fn', () => {
    expect(parseLsofCwd(`p5150\nfcwd\nn${WORKTREE}\n`)).toBe(WORKTREE);
    expect(parseLsofCwd('p5150\nfcwd\n')).toBeNull();
  });

  it('reads RSS in kilobytes and reports bytes', () => {
    const m = parseRss(' 5150 524288\n 5151   2048\n');
    expect(m.get(5150)).toBe(524288 * 1024);
    expect(m.get(5151)).toBe(2048 * 1024);
  });

  it('says unknown rather than zero for memory it could not read', () => {
    expect(human(null)).toBe('unknown');
    expect(human(2.27 * 1024 ** 3)).toBe('2.27 GB');
    expect(human(381 * 1024 ** 2)).toBe('381 MB');
  });
});

/** A machine that answers everything, unless a test takes something away. */
function fakeProbes(over: Partial<InstanceProbes> = {}): InstanceProbes {
  return {
    dockerStats: async () =>
      'supabase_edge_runtime_example-app_custom\t2.27GiB / 7.817GiB\t29%\n' +
      'supabase_db_example-app\t168.1MiB / 7.817GiB\t2.1%\n',
    listeningPids: async (port) => (port === 8083 ? [5150] : []),
    cwdOf: async () => WORKTREE,
    rss: async (pids) => new Map(pids.map((p) => [p, 400 * 1024 * 1024])),
    freePct: async () => 46,
    ...over,
  };
}

/**
 * The bug that makes this function exist: `npm run dev` is a wrapper around the
 * real server, so `lsof -t` on the port names the PARENT first. Signalling the
 * first pid can leave the actual server holding the port and the memory, while
 * the console reports that it stopped it.
 */
describe('resolveDevServer — which of the pids on this port is the dev server', () => {
  it('prefers the pid that verifies, not the first one lsof printed', async () => {
    const r = await resolveDevServer(
      8083,
      WORKTREE,
      // 4000 is the `npm run dev` wrapper, started from the repo root; 4001 is
      // the vite process itself, running in the worktree.
      fakeProbes({
        listeningPids: async () => [4000, 4001],
        cwdOf: async (pid) => (pid === 4001 ? WORKTREE : root),
      }),
    );
    expect(r.pid).toBe(4001);
  });

  it('REFUSES when several pids on the port all verify — it will not guess', async () => {
    const r = await resolveDevServer(
      8083,
      WORKTREE,
      fakeProbes({ listeningPids: async () => [4000, 4001], cwdOf: async () => WORKTREE }),
    );
    expect(r.pid).toBeNull();
    expect(r.reason).toContain('refusing to guess');
  });

  it('REFUSES when no pid can be verified, and says which it looked at', async () => {
    const r = await resolveDevServer(
      8083,
      WORKTREE,
      fakeProbes({ listeningPids: async () => [4000, 4001], cwdOf: async () => null }),
    );
    expect(r.pid).toBeNull();
    expect(r.reason).toContain('4000');
    expect(r.reason).toContain('cannot attribute');
  });

  it('says nothing is listening when nothing is', async () => {
    const r = await resolveDevServer(8084, OTHER, fakeProbes());
    expect(r.pid).toBeNull();
    expect(r.pids).toEqual([]);
    expect(r.reason).toContain('nothing is listening');
  });
});

const inventory = (probes: Partial<InstanceProbes> = {}) =>
  probeInstances(
    {
      edgeContainer: 'supabase_edge_runtime_example-app_custom',
      worktrees: [
        { issue: 4336, path: WORKTREE, port: 8083 },
        { issue: 4342, path: OTHER, port: 8084 },
      ],
      workers: [{ issue: 4336, pid: 7000 }],
    },
    fakeProbes(probes),
  );

describe('probeInstances — the inventory', () => {
  it('names the containers, marks the known leaker, and totals them', async () => {
    const r = await inventory();
    expect(r.containers.map((c) => c.name)).toEqual([
      'supabase_edge_runtime_example-app_custom',
      'supabase_db_example-app',
    ]);
    const edge = r.containers.find((c) => c.isEdgeRuntime)!;
    expect(edge.label).toBe('2.27 GB');
    expect(r.containers.filter((c) => c.isEdgeRuntime)).toHaveLength(1);
    expect(r.totals.containerBytes).toBeGreaterThan(2 * 1024 ** 3);
    expect(r.freePct).toBe(46);
  });

  it('attributes a dev server to the worktree whose port it is on, with its memory', async () => {
    const r = await inventory();
    expect(r.devServers).toHaveLength(1);
    expect(r.devServers[0]).toMatchObject({ issue: 4336, port: 8083, pid: 5150, stoppable: true });
    expect(r.devServers[0]!.label).toBe('400 MB');
  });

  it('marks a dev server running somewhere else as NOT stoppable, and says why', async () => {
    const r = await inventory({ cwdOf: async () => OTHER });
    expect(r.devServers[0]!.stoppable).toBe(false);
    expect(r.devServers[0]!.reason).toContain('not inside');
  });

  // 8080 is never even probed: a row for it could grow a Stop button later.
  it('never looks at port 8080, so it can never appear as a stoppable row', async () => {
    const listeningPids = vi.fn(async () => [5150]);
    const r = await probeInstances(
      { edgeContainer: 'x', worktrees: [{ issue: 0, path: root, port: RESERVED_PORT }], workers: [] },
      fakeProbes({ listeningPids }),
    );
    expect(listeningPids).not.toHaveBeenCalled();
    expect(r.devServers).toHaveLength(0);
  });

  it('never looks at a port outside the registry either', async () => {
    const listeningPids = vi.fn(async () => [5150]);
    const r = await probeInstances(
      { edgeContainer: 'x', worktrees: [{ issue: 4336, path: WORKTREE, port: 3000 }], workers: [] },
      fakeProbes({ listeningPids }),
    );
    expect(listeningPids).not.toHaveBeenCalled();
    expect(r.devServers).toHaveLength(0);
  });

  it('reports this console’s own workers with their resident memory', async () => {
    const r = await inventory();
    expect(r.workers).toEqual([{ issue: 4336, pid: 7000, bytes: 400 * 1024 * 1024, label: '400 MB' }]);
  });

  it('degrades when docker is not there: dev servers still reported, and it says what it missed', async () => {
    const r = await inventory({ dockerStats: async () => null });
    expect(r.containers).toHaveLength(0);
    expect(r.devServers).toHaveLength(1);
    expect(r.notes.join(' ')).toContain('docker stats');
    expect(r.totals.containerLabel).toBe('unknown');
  });

  it('degrades when lsof and ps are not there, and never throws', async () => {
    const r = await inventory({ listeningPids: async () => [], rss: async () => new Map() });
    expect(r.devServers).toHaveLength(0);
    expect(r.containers).toHaveLength(2);
    expect(r.notes.join(' ')).toContain('ps');
  });
});

describe('stopDevServer — the only kill in this module', () => {
  it('signals the pid when both halves of the rule hold', async () => {
    const kill = vi.fn();
    const out = await stopDevServer({ issue: 4336, worktree: WORKTREE, registeredPort: 8083 }, fakeProbes(), kill);
    expect(out.ok).toBe(true);
    expect(kill).toHaveBeenCalledWith(5150);
    expect(out.message).toContain('8083');
  });

  it('kills NOTHING when the process is running outside that worktree', async () => {
    const kill = vi.fn();
    const out = await stopDevServer(
      { issue: 4336, worktree: WORKTREE, registeredPort: 8083 },
      fakeProbes({ cwdOf: async () => OTHER }),
      kill,
    );
    expect(out.ok).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills NOTHING on port 8080, and does not even look for a process', async () => {
    const kill = vi.fn();
    const listeningPids = vi.fn(async () => [999]);
    const out = await stopDevServer(
      { issue: null, worktree: root, registeredPort: RESERVED_PORT },
      fakeProbes({ listeningPids }),
      kill,
    );
    expect(out.ok).toBe(false);
    expect(out.message).toContain('8080');
    expect(listeningPids).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills NOTHING on a port outside the registry, and does not look for a process', async () => {
    const kill = vi.fn();
    const listeningPids = vi.fn(async () => [999]);
    const out = await stopDevServer(
      { issue: 4336, worktree: WORKTREE, registeredPort: 3000 },
      fakeProbes({ listeningPids }),
      kill,
    );
    expect(out.ok).toBe(false);
    expect(listeningPids).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills NOTHING when nothing is listening on that port', async () => {
    const kill = vi.fn();
    const out = await stopDevServer({ issue: 4342, worktree: OTHER, registeredPort: 8084 }, fakeProbes(), kill);
    expect(out.ok).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('signals the pid that verifies when a wrapper process holds the port too', async () => {
    const kill = vi.fn();
    const out = await stopDevServer(
      { issue: 4336, worktree: WORKTREE, registeredPort: 8083 },
      fakeProbes({
        listeningPids: async () => [4000, 4001],
        cwdOf: async (pid) => (pid === 4001 ? WORKTREE : root),
      }),
      kill,
    );
    expect(out.ok).toBe(true);
    expect(kill).toHaveBeenCalledWith(4001);
    expect(kill).not.toHaveBeenCalledWith(4000);
  });

  /**
   * The window between reading a pid's working directory and signalling it
   * cannot be closed, but it can be made one lsof wide: if the pid has stopped
   * holding the port by then, the number may have been reused and the signal
   * would go to a stranger.
   */
  it('re-checks that the pid still holds the port immediately before signalling', async () => {
    const kill = vi.fn();
    let call = 0;
    const out = await stopDevServer(
      { issue: 4336, worktree: WORKTREE, registeredPort: 8083 },
      fakeProbes({ listeningPids: async () => (call++ === 0 ? [5150] : []) }),
      kill,
    );
    expect(out.ok).toBe(false);
    expect(out.message).toContain('no longer listening');
    expect(kill).not.toHaveBeenCalled();
  });
});
