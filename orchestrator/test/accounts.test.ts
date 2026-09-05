import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { codexHooksDocument } from '../src/fence.js';
import {
  accountFor,
  canonicalCodexDir,
  canonicalDirFor,
  checkAccount,
  codexHooksUseCommand,
  configDirEnv,
  doctor,
  expandHome,
  IMPLICIT_ACCOUNT,
  isCanonicalDir,
  loadAccounts,
  loginCommandFor,
  parseAccounts,
  parseRegistryFile,
  providerOf,
  readRegistryFile,
  scanDirsFor,
  tildify,
  writeRegistryFile,
} from '../src/accounts.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wc-home-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('the registry', () => {
  it('is one implicit account at ~/.claude when there is no accounts.json — exactly the old behaviour', async () => {
    const reg = await loadAccounts(join(home, 'accounts.json'));
    expect(reg.fromFile).toBe(false);
    expect(reg.default).toBe(IMPLICIT_ACCOUNT);
    expect(reg.accounts).toEqual([
      { name: IMPLICIT_ACCOUNT, provider: 'claude', configDir: join(homedir(), '.claude') },
    ]);
  });

  it('reads two accounts and expands ~ in configDir', () => {
    const reg = parseAccounts(
      JSON.stringify({
        default: 'work',
        accounts: [
          { name: 'personal', configDir: '~/.claude' },
          { name: 'work', provider: 'codex', configDir: '~/.codex-work' },
        ],
      }),
      home,
    )!;
    expect(reg.default).toBe('work');
    expect(reg.accounts.map((a) => a.configDir)).toEqual([join(home, '.claude'), join(home, '.codex-work')]);
    expect(reg.accounts.map((a) => a.provider)).toEqual(['claude', 'codex']);
    expect(reg.fromFile).toBe(true);
  });

  it('migrates a missing provider to Claude, rejects unknown providers, and keeps names globally unique', () => {
    const file = parseRegistryFile(
      JSON.stringify({
        default: 'personal',
        accounts: [
          { name: 'personal', configDir: '~/.claude' },
          { name: 'personal', provider: 'codex', configDir: '~/.codex' },
          { name: 'bad', provider: 'other', configDir: '/bad' },
          { name: 'codex', provider: 'codex', configDir: '~/.codex-worker' },
        ],
      }),
    )!;
    expect(file.accounts).toEqual([
      { name: 'personal', provider: 'claude', configDir: '~/.claude' },
      { name: 'codex', provider: 'codex', configDir: '~/.codex-worker' },
    ]);
    expect(providerOf({ name: 'legacy', configDir: '/legacy' })).toBe('claude');
  });

  it('knows both providers canonical config directories', () => {
    expect(canonicalDirFor('claude', home)).toBe(join(home, '.claude'));
    expect(canonicalCodexDir(home)).toBe(join(home, '.codex'));
    expect(canonicalDirFor('codex', home)).toBe(join(home, '.codex'));
  });

  it('falls back to the implicit account rather than break on a bad file', async () => {
    const file = join(home, 'accounts.json');
    writeFileSync(file, '{ not json');
    expect((await loadAccounts(file)).fromFile).toBe(false);

    writeFileSync(file, JSON.stringify({ accounts: [{ name: '', configDir: '' }] }));
    expect((await loadAccounts(file)).fromFile).toBe(false);
  });

  it('uses the first account when `default` names one that is not there', () => {
    const reg = parseAccounts(
      JSON.stringify({ default: 'ghost', accounts: [{ name: 'work', configDir: '/w' }] }),
      home,
    )!;
    expect(reg.default).toBe('work');
  });

  it('resolves an unknown or missing account name to the default, never to nothing', () => {
    const reg = parseAccounts(
      JSON.stringify({
        default: 'personal',
        accounts: [
          { name: 'personal', configDir: '/p' },
          { name: 'work', configDir: '/w' },
        ],
      }),
      home,
    )!;
    expect(accountFor(reg, 'work').configDir).toBe('/w');
    expect(accountFor(reg, null).name).toBe('personal');
    expect(accountFor(reg, 'deleted-account').name).toBe('personal');
  });

  it('scans one account for a stamped issue and all of them for an unstamped one', () => {
    const reg = parseAccounts(
      JSON.stringify({
        default: 'personal',
        accounts: [
          { name: 'personal', configDir: '/p' },
          { name: 'work', configDir: '/w' },
        ],
      }),
      home,
    )!;
    expect(scanDirsFor(reg, 'work')).toEqual(['/w']);
    expect(scanDirsFor(reg, null)).toEqual(['/p', '/w']);
    expect(scanDirsFor(reg, 'deleted-account')).toEqual(['/p', '/w']);
  });
});

/**
 * Writing the registry is the Settings tab's whole mechanism. What it writes has
 * to load back as exactly the same registry, and editing one account must not
 * quietly rewrite the others' paths.
 */
describe('the registry, written and read back', () => {
  it('round-trips through the file: what is written loads as the same registry', async () => {
    const file = join(home, 'accounts.json');
    await writeRegistryFile(file, {
      default: 'work',
      accounts: [
        { name: 'personal', configDir: '~/.claude' },
        { name: 'work', configDir: '~/.claude-work' },
      ],
    });

    const reg = await loadAccounts(file, { home, canonical: join(home, '.claude') });
    expect(reg.fromFile).toBe(true);
    expect(reg.default).toBe('work');
    expect(reg.accounts).toEqual([
      { name: 'personal', provider: 'claude', configDir: join(home, '.claude') },
      { name: 'work', provider: 'claude', configDir: join(home, '.claude-work') },
    ]);

    // The file keeps the `~` it was given — a rewrite must not expand everyone.
    const again = await readRegistryFile(file, { home, canonical: join(home, '.claude') });
    expect(again.accounts.map((a) => a.configDir)).toEqual(['~/.claude', '~/.claude-work']);
    expect(JSON.parse(readFileSync(file, 'utf8')).accounts.map((a: { provider: string }) => a.provider)).toEqual([
      'claude',
      'claude',
    ]);
  });

  it('hands back the example shape, seeded with the canonical account, when there is no file', async () => {
    const seed = await readRegistryFile(join(home, 'nothing.json'), { home, canonical: join(home, '.claude') });
    expect(seed).toEqual({
      default: IMPLICIT_ACCOUNT,
      accounts: [{ name: IMPLICIT_ACCOUNT, provider: 'claude', configDir: '~/.claude' }],
    });
  });

  it('writes atomically, leaving no half-file behind', async () => {
    const file = join(home, 'accounts.json');
    await writeRegistryFile(file, { default: 'a', accounts: [{ name: 'a', configDir: '~/.claude' }] });
    expect(readdirSync(home).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('tildifies a path under home and leaves anything else alone', () => {
    expect(tildify(join(home, '.claude-work'), home)).toBe('~/.claude-work');
    expect(tildify(home, home)).toBe('~');
    expect(tildify('/opt/claude', home)).toBe('/opt/claude');
  });
});

describe('expandHome', () => {
  it('expands ~ and ~/x and leaves an absolute path alone', () => {
    expect(expandHome('~', home)).toBe(home);
    expect(expandHome('~/.claude-work', home)).toBe(join(home, '.claude-work'));
    expect(expandHome('/tmp/x', home)).toBe('/tmp/x');
  });
});

/**
 * The doctor is booleans about files, and nothing else: no credential is read,
 * stored or shown, and `claude` is never run to answer a question about config.
 */
describe('the account doctor', () => {
  let canonical: string;
  beforeEach(() => {
    canonical = join(home, '.claude');
    mkdirSync(join(canonical, 'skills'), { recursive: true });
    writeFileSync(join(canonical, 'CLAUDE.md'), '# canonical process\n');
  });

  it('reports a dir that is not there at all', async () => {
    const h = await checkAccount({ name: 'work', configDir: join(home, 'nope') }, canonical);
    expect(h.configDirExists).toBe(false);
    expect(h.loggedIn).toBe(false);
    expect(h.skillsLinked).toBe(false);
    expect(h.claudeMdLinked).toBe(false);
    expect(h.loginCommand).toBe(`CLAUDE_CONFIG_DIR=${join(home, 'nope')} claude /login`);
  });

  it('reports a real skills DIRECTORY as unlinked — that is how process drifts', async () => {
    const dir = join(home, '.claude-work');
    mkdirSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), '# a different process\n');
    const h = await checkAccount({ name: 'work', configDir: dir }, canonical);
    expect(h.configDirExists).toBe(true);
    expect(h.skillsLinked).toBe(false);
    expect(h.claudeMdLinked).toBe(false);
  });

  it('reports real symlinks to the canonical dir as linked', async () => {
    const dir = join(home, '.claude-work');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(canonical, 'skills'), join(dir, 'skills'));
    symlinkSync(join(canonical, 'CLAUDE.md'), join(dir, 'CLAUDE.md'));
    const h = await checkAccount({ name: 'work', configDir: dir }, canonical);
    expect(h.skillsLinked).toBe(true);
    expect(h.claudeMdLinked).toBe(true);
  });

  it('does not call a symlink pointing somewhere else "linked"', async () => {
    const dir = join(home, '.claude-work');
    const elsewhere = join(home, 'other-skills');
    mkdirSync(dir, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(dir, 'skills'));
    expect((await checkAccount({ name: 'work', configDir: dir }, canonical)).skillsLinked).toBe(false);
  });

  it('treats the canonical dir itself as consistent — it is the source, not a link', async () => {
    const h = await checkAccount({ name: 'personal', configDir: canonical }, canonical);
    expect(h.skillsLinked).toBe(true);
    expect(h.claudeMdLinked).toBe(true);
  });

  it('reads login from the config dir only: a marker file, else unknown — never a live claude call', async () => {
    const withCreds = join(home, '.claude-creds');
    mkdirSync(withCreds, { recursive: true });
    writeFileSync(join(withCreds, '.credentials.json'), '{"whatever":1}');
    expect((await checkAccount({ name: 'a', configDir: withCreds }, canonical)).loggedIn).toBe(true);

    const withOauth = join(home, '.claude-oauth');
    mkdirSync(withOauth, { recursive: true });
    writeFileSync(join(withOauth, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x@y.z' } }));
    expect((await checkAccount({ name: 'b', configDir: withOauth }, canonical)).loggedIn).toBe(true);

    // Exists but says nothing — on macOS the credentials are in the Keychain, so
    // "no marker" is not evidence of being logged out. Say unknown, never block.
    const bare = join(home, '.claude-bare');
    mkdirSync(bare, { recursive: true });
    expect((await checkAccount({ name: 'c', configDir: bare }, canonical)).loggedIn).toBe('unknown');
  });

  it('reports every registered account and marks the default', async () => {
    const reg = parseAccounts(
      JSON.stringify({
        default: 'personal',
        accounts: [
          { name: 'personal', configDir: canonical },
          { name: 'work', configDir: join(home, '.claude-work') },
        ],
      }),
      home,
    )!;
    const report = await doctor(reg, canonical);
    expect(report.map((r) => r.name)).toEqual(['personal', 'work']);
    expect(report.map((r) => r.isDefault)).toEqual([true, false]);
    expect(report[1]!.configDirExists).toBe(false);
  });

  it('reports shared Codex skills/instructions and validates the exact Bash fence hook command', async () => {
    const dir = join(home, '.codex-work');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(canonical, 'skills'), join(dir, 'skills'));
    symlinkSync(join(canonical, 'CLAUDE.md'), join(dir, 'AGENTS.md'));
    const hookCommand = `node ${join(home, 'write-fence.mjs')}`;
    writeFileSync(
      join(dir, 'hooks.json'),
      JSON.stringify({
        ...codexHooksDocument('/tmp/fence.mjs', '/tmp/node'),
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand, timeout: 20 }] }],
        },
      }),
    );

    const options = {
      canonicalClaudeDir: canonical,
      canonicalCodexDir: join(home, '.codex'),
      expectedCodexHookCommand: hookCommand,
    };
    const h = await checkAccount({ name: 'codex-work', provider: 'codex', configDir: dir }, options);
    expect(h.provider).toBe('codex');
    expect(h.skillsLinked).toBe(true);
    expect(h.instructionsFile).toBe('AGENTS.md');
    expect(h.instructionsLinked).toBe(true);
    expect(h.hooksValid).toBe(true);
    expect(h.loginCommand).toBe(`CODEX_HOME=${dir} codex login`);
    expect(await codexHooksUseCommand(dir, hookCommand)).toBe(true);
    expect(await codexHooksUseCommand(dir, `${hookCommand} --wrong`)).toBe(false);

    const hooks = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ ...hooks, extraHandler: true }));
    expect(await codexHooksUseCommand(dir, hookCommand)).toBe(false);
  });
});

/**
 * The regression that stopped every worker on the default account. The console
 * set CLAUDE_CONFIG_DIR for EVERY account, canonical included, on the assumption
 * that naming `~/.claude` is the same as leaving it unset. Proven otherwise on
 * this machine, same stripped environment both times: unset answers, and
 * `CLAUDE_CONFIG_DIR=/Users/operator/.claude` gives "Not logged in · Please run
 * /login" — the default account's credentials are in the macOS Keychain, and
 * naming the directory makes Claude Code look for a credentials FILE instead.
 */
describe('the canonical account is addressed by NOT naming it', () => {
  it('sets no config dir for the canonical account, and the account own dir for any other', () => {
    const canonical = join(home, '.claude');
    expect(isCanonicalDir(canonical, canonical)).toBe(true);
    expect(configDirEnv(canonical, canonical)).toBeNull();

    // Trailing slashes and `.` segments are the same directory, so they must
    // resolve the same way — a path typed differently is not a second account.
    expect(configDirEnv(`${canonical}/`, canonical)).toBeNull();
    expect(configDirEnv(join(home, '.claude-work'), canonical)).toBe(join(home, '.claude-work'));
  });

  it('composes the login command without a prefix for canonical, with one otherwise', () => {
    const canonical = join(home, '.claude');
    // With the prefix, this command fails for exactly the reason above — so the
    // one place that composes it must not add one here.
    expect(loginCommandFor(canonical, canonical)).toBe('claude /login');
    expect(loginCommandFor(join(home, '.claude-work'), canonical)).toBe(
      `CLAUDE_CONFIG_DIR=${join(home, '.claude-work')} claude /login`,
    );
    expect(loginCommandFor(join(home, 'codex worker'), canonical, 'codex')).toBe(
      `CODEX_HOME='${join(home, 'codex worker')}' codex login`,
    );
  });

  it('gives the doctor the same command it gives the failed-worker card', async () => {
    const canonical = join(home, '.claude');
    mkdirSync(canonical, { recursive: true });
    const health = await checkAccount({ name: 'personal', configDir: canonical }, canonical);
    expect(health.loginCommand).toBe(loginCommandFor(canonical, canonical));
  });
});

describe('an account default model', () => {
  it('is read when it is there and left absent when it is not', () => {
    const file = parseRegistryFile(
      JSON.stringify({
        default: 'personal',
        accounts: [
          { name: 'personal', configDir: '~/.claude' },
          { name: 'work', configDir: '~/.claude-work', model: 'claude-sonnet-5' },
          { name: 'blank', configDir: '~/.claude-blank', model: '   ' },
        ],
      }),
    )!;
    expect(file.accounts[0]!.model).toBeUndefined();
    expect(file.accounts[1]!.model).toBe('claude-sonnet-5');
    expect(file.accounts[2]!.model).toBeUndefined(); // whitespace is not a choice
  });

  it('survives the ~ expansion the console runs on', () => {
    const reg = parseAccounts(
      JSON.stringify({
        default: 'work',
        accounts: [{ name: 'work', configDir: '~/.claude-work', model: 'claude-fable-5' }],
      }),
      home,
    )!;
    expect(reg.accounts[0]!.configDir).toBe(join(home, '.claude-work'));
    expect(reg.accounts[0]!.model).toBe('claude-fable-5');
  });

  it('is reported by the doctor so Settings can show it', async () => {
    const canonical = join(home, '.claude');
    const health = await checkAccount({ name: 'work', configDir: canonical, model: 'claude-fable-5' }, canonical);
    expect(health.model).toBe('claude-fable-5');
    expect((await checkAccount({ name: 'p', configDir: canonical }, canonical)).model).toBeNull();
  });
});
