import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchdLabel,
  readRebuildStatus,
  rebuildInFlight,
  rebuildScript,
  restartBlocker,
  startRebuild,
} from '../src/rebuild.js';

/**
 * Rebuild-and-restart is a button that ends the process serving the page, so the
 * two things worth testing are the ones a person cannot check by clicking it:
 * that it refuses when it has no way to restart, and that the script it hands to
 * a detached shell writes a status a LATER console can read — because a failed
 * build leaves no new server to ask.
 */
describe('launchdLabel', () => {
  it('reads the job label when launchd started us', () => {
    expect(launchdLabel({ XPC_SERVICE_NAME: 'com.worker-console.server' })).toBe('com.worker-console.server');
  });

  it('is null for the `0` a terminal shell carries, and for another job entirely', () => {
    expect(launchdLabel({ XPC_SERVICE_NAME: '0' })).toBeNull();
    expect(launchdLabel({})).toBeNull();
    // The only label this console may ever kickstart is its own.
    expect(launchdLabel({ XPC_SERVICE_NAME: 'com.apple.Safari' })).toBeNull();
  });
});

describe('restartBlocker', () => {
  it('says why, in a sentence, when there is no launch agent behind us', () => {
    const why = restartBlocker({});
    expect(why).toContain('launch agent');
  });

  it('is null when launchd started us on this platform', () => {
    // Guarded: the blocker's first clause is the platform, and CI is not a Mac.
    if (process.platform !== 'darwin') return;
    expect(restartBlocker({ XPC_SERVICE_NAME: 'com.worker-console.server' })).toBeNull();
  });
});

describe('rebuildScript', () => {
  const script = rebuildScript({ repoRoot: '/repo', streamDir: '/repo/runs', label: 'com.worker-console.server', uid: 501 });

  it('stamps `building` before the build, so a status left by a sleeping machine can be aged out', () => {
    expect(script.indexOf("printf 'building")).toBeLessThan(script.indexOf('npm run build'));
  });

  it('writes `failed` and stops when the build fails — nothing restarts', () => {
    expect(script).toContain("printf 'failed");
    expect(script.indexOf("printf 'failed")).toBeLessThan(script.indexOf('launchctl kickstart'));
  });

  it("kickstarts this console's own service, by uid and label", () => {
    expect(script).toContain("launchctl kickstart -k 'gui/501/com.worker-console.server'");
  });

  it('quotes every path, because a config path may contain spaces', () => {
    expect(script).toContain(`cd '/repo'`);
    expect(script).toContain(`'/repo/runs/rebuild.status'`);
  });
});

describe('rebuildInFlight', () => {
  const status = (state: string, at: string | null) =>
    ({ state, at, log: '', canRestart: true, why: null }) as ReturnType<typeof readRebuildStatus>;

  it('is true for a build that started a moment ago', () => {
    const now = Date.parse('2026-09-02T10:00:00Z');
    expect(rebuildInFlight(status('building', '2026-09-02T09:59:00Z'), now)).toBe(true);
  });

  it('ages out a status a sleeping machine left behind', () => {
    const now = Date.parse('2026-09-02T10:00:00Z');
    expect(rebuildInFlight(status('building', '2026-09-02T09:00:00Z'), now)).toBe(false);
  });

  it('believes a live-looking status with no readable stamp — refusing twice is cheaper than two builds writing one dist', () => {
    expect(rebuildInFlight(status('restarting', null))).toBe(true);
  });

  it('is false once it is over, either way', () => {
    expect(rebuildInFlight(status('done', '2026-09-02T09:59:00Z'))).toBe(false);
    expect(rebuildInFlight(status('failed', '2026-09-02T09:59:00Z'))).toBe(false);
  });
});

describe('readRebuildStatus', () => {
  it('is idle with no status file, and says whether a restart is possible at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rebuild-'));
    const out = readRebuildStatus(dir, {});
    expect(out.state).toBe('idle');
    expect(out.at).toBeNull();
    expect(out.canRestart).toBe(false);
    expect(out.why).toContain('launch agent');
  });

  it('reads the state and its stamp, and carries the log that explains a failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rebuild-'));
    writeFileSync(join(dir, 'rebuild.status'), 'failed\n2026-09-02T10:00:00Z\n');
    writeFileSync(join(dir, 'rebuild.log'), 'src/x.ts(3,1): error TS2339: nope\n');
    const out = readRebuildStatus(dir, { XPC_SERVICE_NAME: 'com.worker-console.server' });
    expect(out.state).toBe('failed');
    expect(out.at).toBe('2026-09-02T10:00:00Z');
    expect(out.log).toContain('error TS2339');
  });

  it('treats a word it does not recognise as idle rather than believing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rebuild-'));
    writeFileSync(join(dir, 'rebuild.status'), 'sideways\n2026-09-02T10:00:00Z\n');
    expect(readRebuildStatus(dir, {}).state).toBe('idle');
  });
});

describe('startRebuild', () => {
  it('refuses, and spawns nothing, when this console cannot restart itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rebuild-'));
    let spawned = 0;
    const out = startRebuild({
      repoRoot: '/repo',
      streamDir: dir,
      env: {},
      spawnFn: (() => {
        spawned += 1;
        return { unref() {} };
      }) as never,
    });
    expect(out.ok).toBe(false);
    expect(spawned).toBe(0);
  });

  it('refuses a second rebuild while one is running', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rebuild-'));
    const now = Date.parse('2026-09-02T10:00:00Z');
    writeFileSync(join(dir, 'rebuild.status'), 'building\n2026-09-02T09:59:00Z\n');
    const out = startRebuild({
      repoRoot: '/repo',
      streamDir: dir,
      env: { XPC_SERVICE_NAME: 'com.worker-console.server' },
      uid: 501,
      now,
      spawnFn: (() => ({ unref() {} })) as never,
    });
    expect(out.ok).toBe(false);
    expect(out.message).toContain('already running');
  });

  it('stamps building itself, so a page polling immediately cannot read the last run as this one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rebuild-'));
    writeFileSync(join(dir, 'rebuild.status'), 'done\n2026-09-01T10:00:00Z\n');
    const out = startRebuild({
      repoRoot: '/repo',
      streamDir: dir,
      env: { XPC_SERVICE_NAME: 'com.worker-console.server' },
      uid: 501,
      now: Date.parse('2026-09-02T10:00:00Z'),
      spawnFn: (() => ({ unref() {} })) as never,
    });
    expect(out.ok).toBe(true);
    expect(readFileSync(join(dir, 'rebuild.status'), 'utf8')).toContain('building');
  });

  it('spawns the script detached, with no stdio — it must outlive the process it kills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rebuild-'));
    let opts: Record<string, unknown> | null = null;
    let argv: string[] = [];
    startRebuild({
      repoRoot: '/repo',
      streamDir: dir,
      env: { XPC_SERVICE_NAME: 'com.worker-console.server' },
      uid: 501,
      spawnFn: ((_cmd: string, args: string[], o: Record<string, unknown>) => {
        argv = args;
        opts = o;
        return { unref() {} };
      }) as never,
    });
    expect(opts).not.toBeNull();
    expect(opts!.detached).toBe(true);
    expect(opts!.stdio).toBe('ignore');
    expect(argv[0]).toBe('-c');
    expect(argv[1]).toContain('launchctl kickstart');
  });
});
