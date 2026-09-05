import { describe, it, expect, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CODEX_SANDBOX,
  DEFAULT_EDGE_CONTAINER,
  codexSandboxMode,
  edgeContainerName,
  loadConfig,
  watchLadder,
} from '../src/config.js';
import { DEFAULT_CODEX_MODEL } from '../src/models.js';

describe('loadConfig — Codex runtime', () => {
  it('has production defaults without changing the existing Claude defaults', () => {
    const cfg = loadConfig({});
    expect(cfg.claudeBin).toBe('claude');
    expect(cfg.codexBin).toBe('codex');
    expect(cfg.canonicalCodexDir).toBe(join(homedir(), '.codex'));
    expect(cfg.codexWorkerModel).toBe(DEFAULT_CODEX_MODEL);
    expect(cfg.codexSandbox).toBe('danger-full-access');
  });

  it('honours all four Codex runtime overrides', () => {
    const cfg = loadConfig({
      CODEX_BIN: '/opt/codex/bin/codex',
      CANONICAL_CODEX_DIR: '/profiles/codex',
      CODEX_WORKER_MODEL: 'gpt-custom',
      CODEX_SANDBOX: 'workspace-write',
    });
    expect(cfg.codexBin).toBe('/opt/codex/bin/codex');
    expect(cfg.canonicalCodexDir).toBe('/profiles/codex');
    expect(cfg.codexWorkerModel).toBe('gpt-custom');
    expect(cfg.codexSandbox).toBe('workspace-write');
  });

  it('accepts only Codex sandbox values the CLI supports and fails closed on a typo', () => {
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
      expect(codexSandboxMode(mode)).toBe(mode);
      expect(loadConfig({ CODEX_SANDBOX: mode }).codexSandbox).toBe(mode);
    }
    expect(() => codexSandboxMode('anything-goes')).toThrow(/CODEX_SANDBOX.*not supported/);
    expect(() => loadConfig({ CODEX_SANDBOX: 'anything-goes' })).toThrow(/CODEX_SANDBOX.*not supported/);
  });
});

describe('loadConfig — worker permission mode', () => {
  it('defaults to bypassPermissions so a headless worker can run its all-Bash preflight', () => {
    // A headless `-p` worker has no TTY. `acceptEdits` still prompts for Bash, and
    // the issue-pipeline Stage 0 preflight is all Bash — so acceptEdits stalls the
    // first command and the worker exits writing nothing (the #4329 failure).
    expect(loadConfig({}).workerPermissionMode).toBe('bypassPermissions');
  });

  it('honours the WORKER_PERMISSION_MODE override', () => {
    expect(loadConfig({ WORKER_PERMISSION_MODE: 'acceptEdits' }).workerPermissionMode).toBe('acceptEdits');
    expect(loadConfig({ WORKER_PERMISSION_MODE: 'plan' }).workerPermissionMode).toBe('plan');
  });
});

describe('work-source configuration', () => {
  it('keeps source credentials beside redirected state and accepts managed overrides', () => {
    const cfg = loadConfig({
      STATE_FILE: '/tmp/worker-console-test/state.json',
      LINEAR_API_KEY: 'managed-key',
      SOURCES_TTL_MS: '5000',
    });
    expect(cfg.connectionsFile).toBe('/tmp/worker-console-test/connections.json');
    expect(cfg.linearApiKey).toBe('managed-key');
    expect(cfg.sourcesTtlMs).toBe(5000);
  });

  it('lets the credential file be redirected explicitly', () => {
    expect(loadConfig({ CONNECTIONS_FILE: '/tmp/other-connections.json' }).connectionsFile).toBe(
      '/tmp/other-connections.json',
    );
  });
});

/**
 * EDGE_CONTAINER is an environment string on the one code path that restarts a
 * container, so the button will only ever accept a name that is an edge runtime.
 * Nothing restarts it automatically, but a click must still be incapable of
 * restarting the database.
 */
describe('the edge container name', () => {
  it('is the default when nothing is set', () => {
    expect(loadConfig({}).edgeContainer).toBe(DEFAULT_EDGE_CONTAINER);
  });

  it('honours an override that is genuinely an edge runtime', () => {
    const name = 'supabase_edge_runtime_other-project';
    expect(edgeContainerName(name, () => {})).toBe(name);
  });

  it('IGNORES a database (or any non-edge) container and says so', () => {
    const warn = vi.fn();
    expect(edgeContainerName('supabase_db_example-app', warn)).toBe(DEFAULT_EDGE_CONTAINER);
    expect(warn.mock.calls[0]![0]).toContain('supabase_db_example-app');
    for (const bad of ['supabase_storage_example-app', 'supabase_auth_example-app', 'postgres', '']) {
      expect(edgeContainerName(bad, () => {})).toBe(DEFAULT_EDGE_CONTAINER);
    }
  });

  it('carries the same rule through loadConfig, which is what the button reads', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadConfig({ EDGE_CONTAINER: 'supabase_db_example-app' }).edgeContainer).toBe(DEFAULT_EDGE_CONTAINER);
    expect(warn).toHaveBeenCalled();
    expect(loadConfig({ EDGE_CONTAINER: 'supabase_edge_runtime_other-project' }).edgeContainer).toBe(
      'supabase_edge_runtime_other-project',
    );
    warn.mockRestore();
  });
});

/**
 * The response ladder is four numbers that only mean anything in order. A
 * mis-ordered set would pause every worker before it had ever warned — an
 * automation acting harder than the person who configured it intended — so it is
 * refused as a SET rather than half-honoured.
 */
describe('the memory ladder', () => {
  const DEFAULTS = { minFreePct: 12, warnFreePct: 10, pauseFreePct: 7, floorFreePct: 5 };

  it('defaults to 12 / 10 / 7 / 5, with the floor automatic and level 3 opt-in', () => {
    const cfg = loadConfig({});
    // Lowered 2026-08-12 on the operator's correction: 25% held dispatch on a
    // machine with 45% free. Free RAM near zero is macOS working as designed, so
    // the gate sits near genuine trouble and the automatic floor stays at 5.
    expect([cfg.minFreePct, cfg.warnFreePct, cfg.pauseFreePct, cfg.floorFreePct]).toEqual([12, 10, 7, 5]);
    // The operator's decision, 2026-08-11: the floor ACTS. A floor that only
    // draws a button acts on nothing at 3 a.m., which is when the crash
    // happened.
    expect(cfg.autoPauseFloor).toBe(true);
    // Level 3 stays a click: there is still time for a person to choose.
    expect(cfg.autoPause).toBe(false);
  });

  it('honours a properly ordered override', () => {
    const cfg = loadConfig({ MIN_FREE_PCT: '30', WARN_FREE_PCT: '20', PAUSE_FREE_PCT: '12', FLOOR_FREE_PCT: '6' });
    expect([cfg.minFreePct, cfg.warnFreePct, cfg.pauseFreePct, cfg.floorFreePct]).toEqual([30, 20, 12, 6]);
  });

  it('falls back to the whole default set when the ladder does not escalate, and says so', () => {
    const warn = vi.fn();
    // The floor above the pause level: it would fire first, which inverts the
    // entire response.
    expect(watchLadder({ minFreePct: 25, warnFreePct: 15, pauseFreePct: 10, floorFreePct: 12 }, DEFAULTS, warn)).toEqual(
      DEFAULTS,
    );
    expect(warn.mock.calls[0]![0]).toContain('must escalate');
    for (const bad of [
      { minFreePct: 10, warnFreePct: 15, pauseFreePct: 10, floorFreePct: 5 }, // warn above min
      { minFreePct: 25, warnFreePct: 15, pauseFreePct: 15, floorFreePct: 5 }, // pause == warn
      { minFreePct: 25, warnFreePct: 15, pauseFreePct: 10, floorFreePct: 0 }, // a floor of zero never fires
    ]) {
      expect(watchLadder(bad, DEFAULTS, () => {})).toEqual(DEFAULTS);
    }
  });

  it('carries that rule through loadConfig, which is what the watcher reads', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig({ FLOOR_FREE_PCT: '40' });
    expect([cfg.minFreePct, cfg.warnFreePct, cfg.pauseFreePct, cfg.floorFreePct]).toEqual([12, 10, 7, 5]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('lets the floor be switched off, and the level-3 pause switched on', () => {
    expect(loadConfig({ AUTO_PAUSE_FLOOR: '0' }).autoPauseFloor).toBe(false);
    expect(loadConfig({ AUTO_PAUSE_FLOOR: 'false' }).autoPauseFloor).toBe(false);
    expect(loadConfig({ AUTO_PAUSE: '1' }).autoPause).toBe(true);
  });

  it('samples every 5s with workers running and every 30s without', () => {
    const cfg = loadConfig({});
    expect(cfg.watchIntervalMs).toBe(5_000);
    expect(cfg.watchIdleIntervalMs).toBe(30_000);
  });
});

/**
 * Three cadences, and they are three on purpose. A night of polling GitHub every
 * two minutes exhausted the 5,000/hr GraphQL quota, so the GITHUB poll went to
 * fifteen minutes — and nothing local was allowed to follow it out there, because
 * the memory guard is the reason this console is trusted to run workers at all.
 */
describe('the three cadences', () => {
  it('asks GitHub every 15 minutes', () => {
    expect(loadConfig({}).pollMs).toBe(900_000);
    expect(loadConfig({ POLL_MS: '60000' }).pollMs).toBe(60_000);
  });

  it('keeps the LOCAL machine read at two minutes, independent of the GitHub poll', () => {
    // memory_pressure + vm_stat + one `docker stats`: no network, no quota, and
    // the dispatch banner and the edge-runtime button are drawn from it.
    expect(loadConfig({}).resourcesMs).toBe(120_000);
    expect(loadConfig({ POLL_MS: '900000' }).resourcesMs).toBe(120_000);
    expect(loadConfig({ RESOURCES_MS: '30000' }).resourcesMs).toBe(30_000);
  });

  it('leaves the watcher alone — slowing GitHub must not slow the memory ticks', () => {
    const cfg = loadConfig({ POLL_MS: '900000' });
    expect(cfg.watchIntervalMs).toBe(5_000);
    expect(cfg.watchIdleIntervalMs).toBe(30_000);
  });
});
