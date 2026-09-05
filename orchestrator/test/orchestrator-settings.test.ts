import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ResourceReport } from '../src/types.js';

/**
 * The Settings tab, at the orchestrator level: adding, re-defaulting and removing
 * registry ENTRIES, and running the one vetted link script. Everything here
 * writes exactly one file — accounts.json — except the link path, which runs the
 * script and nothing else. No account config directory is created or deleted.
 */

let home: string;
let canonical: string;
let canonicalCodex: string;
let workDir: string;
let accountsFile: string;
let stateFile: string;
let repoPath: string;
let linkScript: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-settings-')));
  canonical = join(home, '.claude');
  canonicalCodex = join(home, '.codex');
  workDir = join(home, '.claude-work');
  mkdirSync(canonical, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  accountsFile = join(home, 'accounts.json');
  stateFile = join(home, 'state.json');
  repoPath = join(home, 'repo'); // deliberately not a git repo: nothing here scans
  mkdirSync(repoPath, { recursive: true });

  // Stands in for scripts/link-account.sh: same contract (one argument, prints
  // what it did), without touching anything on this machine.
  linkScript = join(home, 'stub-link.sh');
  writeFileSync(
    linkScript,
    '#!/bin/sh\necho "ok   skills: linked $1/skills -> $CANONICAL_CLAUDE_DIR/skills"\nexit 0\n',
    { mode: 0o755 },
  );

  vi.spyOn(gh, 'listIssues').mockResolvedValue([]);
  // Merged PRs are read on every poll now (a merged PR used to vanish from the
  // console and the row lied). Stubbed empty so no test reaches the network.
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(resources, 'probeResources').mockResolvedValue({
    ok: true,
    reason: 'memory ok',
    freePct: 90,
    headroomBytes: 0,
    headroomLabel: '9 GB',
    minFreePct: 25,
    footprintBytes: 0,
    footprintLabel: '0 GB',
    ceilingBytes: 1,
    ceilingLabel: '1 GB',
    totalBytes: 2,
    edgeRuntimeLabel: null,
    checkedAt: new Date().toISOString(),
  } as ResourceReport);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function orch() {
  return new Orchestrator(
    loadConfig({
      REPO: 'example-org/example-repo',
      REPO_PATH: repoPath,
      STATE_FILE: stateFile,
      ACCOUNTS_FILE: accountsFile,
      CANONICAL_CLAUDE_DIR: canonical,
      CANONICAL_CODEX_DIR: canonicalCodex,
      LINK_ACCOUNT_SCRIPT: linkScript,
      POLL_MS: '999999',
    }),
  );
}

const registry = () => JSON.parse(readFileSync(accountsFile, 'utf8')) as { default: string; accounts: unknown[] };

describe('adding an account', () => {
  it('creates accounts.json from the example shape, keeps the canonical account, and reloads live', async () => {
    const o = orch();
    await o.start();
    expect(existsSync(accountsFile)).toBe(false);
    expect(o.state().accounts.map((a) => a.name)).toEqual(['personal']);

    const out = await o.addAccount('work', workDir);
    expect(out.ok).toBe(true);

    // The implicit fallback survives being written down, and the new one is there.
    expect(registry()).toEqual({
      default: 'personal',
      accounts: [
        { name: 'personal', provider: 'claude', configDir: canonical },
        { name: 'work', provider: 'claude', configDir: workDir },
      ],
    });

    // Live: no console restart, and the doctor re-reads the new account.
    expect(o.state().accounts.map((a) => a.name)).toEqual(['personal', 'work']);
    const report = await o.accountsReport();
    expect(report.map((h) => h.name)).toEqual(['personal', 'work']);
    expect(report[1]!.configDirExists).toBe(true);
    expect(report[1]!.loginCommand).toBe(`CLAUDE_CONFIG_DIR=${workDir} claude /login`);
    await o.stop();
  });

  it('takes a ~ path as typed and leaves it that way in the file', async () => {
    const o = orch();
    await o.start();
    expect((await o.addAccount('work', '~/.claude-work')).ok).toBe(true);
    expect(registry().accounts).toContainEqual({ name: 'work', provider: 'claude', configDir: '~/.claude-work' });
    await o.stop();
  });

  it('refuses a duplicate name, an empty directory and a name that is not a slug', async () => {
    const o = orch();
    await o.start();
    await o.addAccount('work', workDir);

    expect((await o.addAccount('work', '~/.claude-other')).message).toContain('already an account');
    expect((await o.addAccount('personal', '~/.claude-other')).message).toContain('already an account');
    expect((await o.addAccount('other', '  ')).message).toContain('config directory');
    expect((await o.addAccount('two words', '~/.claude-two')).message).toContain('not a usable name');
    const canonicalCodexResult = await o.addAccount('interactive-codex', canonicalCodex, 'codex');
    expect(canonicalCodexResult.ok).toBe(false);
    expect(canonicalCodexResult.message).toMatch(/interactive Codex home.*dedicated CODEX_HOME/);
    expect(registry().accounts).toHaveLength(2); // nothing got through
    await o.stop();
  });

  it('doctor re-reads after an add: an account whose directory is not there yet says so', async () => {
    const o = orch();
    await o.start();
    await o.addAccount('ghost', join(home, 'not-created-yet'));
    const report = await o.accountsReport();
    expect(report.find((h) => h.name === 'ghost')!.configDirExists).toBe(false);
    expect(existsSync(join(home, 'not-created-yet'))).toBe(false); // adding creates nothing
    await o.stop();
  });
});

describe('the default account', () => {
  it('moves the default and refuses one that is not registered', async () => {
    const o = orch();
    await o.start();
    await o.addAccount('work', workDir);

    expect((await o.setDefaultAccount('work')).ok).toBe(true);
    expect(registry().default).toBe('work');
    expect(o.state().defaultAccount).toBe('work');

    const bad = await o.setDefaultAccount('ghost');
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("no account called 'ghost'");
    expect(registry().default).toBe('work');
    await o.stop();
  });
});

describe('removing an account', () => {
  it('removes the registry entry and nothing else — the directory is untouched', async () => {
    const o = orch();
    await o.start();
    await o.addAccount('work', workDir);

    const out = await o.removeAccount('work');
    expect(out.ok).toBe(true);
    expect(registry().accounts).toEqual([{ name: 'personal', provider: 'claude', configDir: canonical }]);
    expect(existsSync(workDir)).toBe(true);
    expect(o.state().accounts.map((a) => a.name)).toEqual(['personal']);
    await o.stop();
  });

  it('hands the default back to a surviving account when the default is the one removed', async () => {
    const o = orch();
    await o.start();
    await o.addAccount('work', workDir);
    await o.setDefaultAccount('work');

    expect((await o.removeAccount('work')).ok).toBe(true);
    expect(registry().default).toBe('personal');
    await o.stop();
  });

  it('refuses to remove the only account — the console would have nothing to run under', async () => {
    const o = orch();
    await o.start();
    await o.addAccount('work', workDir);
    await o.removeAccount('work');

    const out = await o.removeAccount('personal');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('only account');
    expect(o.state().accounts.map((a) => a.name)).toEqual(['personal']);
    await o.stop();
  });

  it('refuses to remove an account issues are stamped with, and names them', async () => {
    writeFileSync(stateFile, JSON.stringify({ accountByIssue: { 4336: 'work', 4342: 'work', 4329: 'personal' } }));
    const o = orch();
    await o.start();
    await o.addAccount('work', workDir);

    const out = await o.removeAccount('work');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('#4336');
    expect(out.message).toContain('#4342');
    expect(out.message).not.toContain('#4329');
    expect(registry().accounts).toHaveLength(2);
    await o.stop();
  });

  it('refuses a name that is not registered', async () => {
    const o = orch();
    await o.start();
    await o.addAccount('work', workDir);
    expect((await o.removeAccount('ghost')).message).toContain("no account called 'ghost'");
    await o.stop();
  });
});

describe('linking an account', () => {
  it('runs the link script against that account config dir and returns its output verbatim', async () => {
    const o = orch();
    await o.start();
    await o.addAccount('work', workDir);

    const out = await o.linkAccount('work');
    expect(out.ok).toBe(true);
    expect(out.output).toBe(`ok   skills: linked ${workDir}/skills -> ${canonical}/skills`);
    await o.stop();
  });

  it('reports a failing script with its own output rather than swallowing it', async () => {
    writeFileSync(linkScript, '#!/bin/sh\necho "STOP skills: refusing to replace a real directory" >&2\nexit 1\n', {
      mode: 0o755,
    });
    const o = orch();
    await o.start();
    await o.addAccount('work', workDir);

    const out = await o.linkAccount('work');
    expect(out.ok).toBe(false);
    expect(out.output).toContain('refusing to replace a real directory');
    await o.stop();
  });

  it('refuses a name that is not registered, and runs nothing', async () => {
    const o = orch();
    await o.start();
    const out = await o.linkAccount('ghost');
    expect(out.ok).toBe(false);
    expect(out.output).toBe('');
    await o.stop();
  });
});
