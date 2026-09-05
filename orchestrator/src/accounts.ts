import { readFile, writeFile, rename, lstat, readlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import type { AgentProviderId } from './providers/types.js';
import { validateCodexHooksCommandJson } from './fence.js';

export type { AgentProviderId } from './providers/types.js';

/**
 * Agent profiles. Claude is isolated with `CLAUDE_CONFIG_DIR`; Codex is
 * isolated with `CODEX_HOME`. Each relocates that CLI's config, credentials and
 * sessions, so a profile directory is the authentication/session boundary.
 *
 * The registry is `accounts.json` at the repo root (machine-local, gitignored;
 * `accounts.example.json` is the committed shape). NO FILE AT ALL means one
 * implicit Claude account at `~/.claude` — what the console did before accounts
 * existed — so a machine with no registry behaves exactly as before.
 *
 * `accounts.json` is the ONE file this module writes, and it writes only that
 * file: the Settings tab adds, re-defaults and removes registry ENTRIES. No
 * account config directory is ever created, modified or deleted from here.
 */

/** The on-disk shape accepts a missing provider for pre-Codex registries. */
export type AccountConfig = {
  name: string;
  configDir: string;
  /** Missing only in a legacy input; every loaded Account is normalized. */
  provider?: AgentProviderId;
  /** This account's default model. Absent = the console's default. It is a
   *  preference, not a fence: the per-issue picker still wins over it. */
  model?: string | null;
};

/** Runtime accounts always carry the provider selected by their profile. */
export type Account = Omit<AccountConfig, 'provider'> & { provider: AgentProviderId };

export type AccountRegistry = {
  default: string;
  accounts: Account[];
  /** False when there is no accounts.json — the single implicit account. */
  fromFile: boolean;
};

export const IMPLICIT_ACCOUNT = 'personal';

/** Providerless entries are the registry format from before Codex existed. */
export function providerOf(account: Pick<AccountConfig, 'provider'>): AgentProviderId {
  return account.provider ?? 'claude';
}

/** Where Claude Code keeps its config when nobody has moved it. It also remains
 *  the source of the shared workflow skills and instructions for both CLIs. */
export function canonicalDir(home = homedir()): string {
  return join(home, '.claude');
}

/** Where Codex keeps config, auth, logs and sessions unless CODEX_HOME moves it. */
export function canonicalCodexDir(home = homedir()): string {
  return join(home, '.codex');
}

export function canonicalDirFor(provider: AgentProviderId, home = homedir()): string {
  return provider === 'codex' ? canonicalCodexDir(home) : canonicalDir(home);
}

/** `~` and `~/x` are the only shell-isms a config file may use. */
export function expandHome(p: string, home = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return resolve(p);
}

export function implicitRegistry(canonical = canonicalDir()): AccountRegistry {
  return {
    default: IMPLICIT_ACCOUNT,
    accounts: [{ name: IMPLICIT_ACCOUNT, provider: 'claude', configDir: canonical }],
    fromFile: false,
  };
}

/**
 * `accounts.json` exactly as it sits on disk: `configDir` is whatever was typed,
 * `~` and all. Rewriting the file goes through this shape so adding one account
 * does not silently expand every other one's path.
 */
export type RegistryFile = { default: string; accounts: AccountConfig[] };
export type ParsedRegistryFile = Omit<RegistryFile, 'accounts'> & { accounts: Account[] };

/**
 * Parse `accounts.json` without expanding anything. Anything unusable — bad
 * JSON, no usable entry — returns null and the caller falls back to the implicit
 * account: a typo in this file must never stop the console from running workers
 * the way it always has.
 */
export function parseRegistryFile(raw: string): ParsedRegistryFile | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const r = o as Record<string, unknown>;
  if (!Array.isArray(r.accounts)) return null;

  const accounts: Account[] = [];
  for (const entry of r.accounts) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || !e.name.trim()) continue;
    if (typeof e.configDir !== 'string' || !e.configDir.trim()) continue;
    if (e.provider !== undefined && e.provider !== 'claude' && e.provider !== 'codex') continue;
    const name = e.name.trim();
    if (accounts.some((a) => a.name === name)) continue; // first wins
    // `model` is optional and stays absent when it is not set, so writing the
    // registry back does not sprinkle nulls through a file the operator also edits.
    const model = typeof e.model === 'string' && e.model.trim() ? e.model.trim() : null;
    accounts.push({
      name,
      provider: e.provider === 'codex' ? 'codex' : 'claude',
      configDir: e.configDir.trim(),
      ...(model ? { model } : {}),
    });
  }
  if (accounts.length === 0) return null;

  const wanted = typeof r.default === 'string' ? r.default.trim() : '';
  const def = accounts.some((a) => a.name === wanted) ? wanted : accounts[0]!.name;
  return { default: def, accounts };
}

/** The registry the console runs on: the file, with every `configDir` expanded. */
export function parseAccounts(raw: string, home = homedir()): AccountRegistry | null {
  const file = parseRegistryFile(raw);
  if (!file) return null;
  return {
    default: file.default,
    accounts: file.accounts.map((a) => ({ ...a, configDir: expandHome(a.configDir, home) })),
    fromFile: true,
  };
}

export async function loadAccounts(
  file: string,
  opts: { canonical?: string; home?: string } = {},
): Promise<AccountRegistry> {
  const home = opts.home ?? homedir();
  const canonical = opts.canonical ?? canonicalDir(home);
  const raw = await readFile(file, 'utf8').catch(() => null);
  if (raw === null) return implicitRegistry(canonical);
  return parseAccounts(raw, home) ?? implicitRegistry(canonical);
}

/** `~` back on, so a file we write reads like `accounts.example.json`. */
export function tildify(p: string, home = homedir()): string {
  if (p === home) return '~';
  return p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

/**
 * The file to edit. When there is none, that is the shape
 * `accounts.example.json` documents, seeded with the canonical account — writing
 * the registry down must never lose the implicit `~/.claude` fallback.
 */
export async function readRegistryFile(
  file: string,
  opts: { canonical?: string; home?: string } = {},
): Promise<RegistryFile> {
  const home = opts.home ?? homedir();
  const canonical = opts.canonical ?? canonicalDir(home);
  const seed: RegistryFile = {
    default: IMPLICIT_ACCOUNT,
    accounts: [{ name: IMPLICIT_ACCOUNT, provider: 'claude', configDir: tildify(canonical, home) }],
  };
  const raw = await readFile(file, 'utf8').catch(() => null);
  if (raw === null) return seed;
  return parseRegistryFile(raw) ?? seed;
}

/** Atomic: a half-written registry would read as "no accounts" on the next load. */
export async function writeRegistryFile(file: string, data: RegistryFile): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  const normalized: ParsedRegistryFile = {
    default: data.default,
    accounts: data.accounts.map((account) => ({ ...account, provider: providerOf(account) })),
  };
  await writeFile(tmp, JSON.stringify(normalized, null, 2) + '\n');
  await rename(tmp, file);
}

/** Names go in a shell command, a UI badge and this file — keep them boring. */
export const ACCOUNT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** The account an issue runs under. An unknown or missing name is the default —
 *  a stale name in state must not wedge a worker. */
export function accountFor(reg: AccountRegistry, name: string | null | undefined): Account {
  const found = name ? reg.accounts.find((a) => a.name === name) : undefined;
  return found ?? reg.accounts.find((a) => a.name === reg.default) ?? reg.accounts[0]!;
}

export function hasAccount(reg: AccountRegistry, name: string): boolean {
  return reg.accounts.some((a) => a.name === name);
}

/** Is this the directory Claude Code uses when nobody has moved it? */
export function isCanonicalDir(dir: string, canonical: string): boolean {
  return resolve(dir) === resolve(canonical);
}

/**
 * The `CLAUDE_CONFIG_DIR` to set for an account — or NULL, meaning set nothing
 * at all.
 *
 * Setting it to the canonical `~/.claude` is NOT the same as leaving it unset,
 * which is what this console assumed and what broke every worker under the
 * default account. Proven on a real machine, same stripped environment both
 * times:
 *
 *   unset                             -> `claude -p …` answers
 *   CLAUDE_CONFIG_DIR=$HOME/.claude   -> "Not logged in · Please run /login"
 *
 * The default account's credentials are in the macOS Keychain; naming the
 * directory explicitly makes Claude Code look for a credentials FILE in it
 * instead, finds none, and refuses to start. So the canonical account is run the
 * way it has always been run: by not mentioning the variable.
 */
export function configDirEnv(dir: string, canonical: string): string | null {
  return isCanonicalDir(dir, canonical) ? null : dir;
}

/**
 * The exact line the operator types to log an account in. Composed HERE and
 * nowhere else, so the Settings card and the failed-worker card cannot drift
 * apart — and so the canonical account never gets the `CLAUDE_CONFIG_DIR=`
 * prefix, which would fail for exactly the reason above.
 */
function shellValue(value: string): string {
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function loginCommandFor(
  dir: string,
  canonical: string,
  provider: AgentProviderId = 'claude',
): string {
  if (provider === 'codex') return `CODEX_HOME=${shellValue(dir)} codex login`;
  return isCanonicalDir(dir, canonical)
    ? 'claude /login'
    : `CLAUDE_CONFIG_DIR=${shellValue(dir)} claude /login`;
}

/**
 * Which config dirs to search for one issue's transcripts: the account it was
 * stamped with, or — for an issue that predates the stamp — all of them, newest
 * transcript wins.
 */
export function scanDirsFor(reg: AccountRegistry, name: string | null | undefined): string[] {
  if (name && hasAccount(reg, name)) return [accountFor(reg, name).configDir];
  return reg.accounts.map((a) => a.configDir);
}

// ------------------------------------------------------------------- doctor

/**
 * Skills and process instructions must resolve IDENTICALLY under every profile.
 * Claude profiles expose the shared CLAUDE.md; Codex profiles expose the same
 * file as AGENTS.md. The doctor reports booleans only — it never reads, stores
 * or shows a credential, and it never invokes either CLI.
 */
export type AccountHealth = {
  name: string;
  provider: AgentProviderId;
  configDir: string;
  isDefault: boolean;
  /** Whether this is the provider's conventional ~/.claude or ~/.codex home. */
  isCanonicalConfigDir: boolean;
  configDirExists: boolean;
  /** 'unknown' when the machine keeps credentials somewhere we cannot see (the
   *  macOS Keychain). Never a live probe. */
  loggedIn: boolean | 'unknown';
  skillsLinked: boolean;
  /** The provider-specific instruction filename checked in this profile. */
  instructionsFile: 'CLAUDE.md' | 'AGENTS.md';
  /** Whether that filename resolves to the console's shared instructions. */
  instructionsLinked: boolean;
  /** Legacy UI field. For Codex it mirrors AGENTS.md's shared-link result. */
  claudeMdLinked: boolean;
  /** Null for Claude or when no expected Codex hook command was supplied. */
  hooksValid: boolean | null;
  /** This account's default model, or null for "the console's default". */
  model: string | null;
  /** What the operator types to fix a not-logged-in account. No credentials in it. */
  loginCommand: string;
};

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Is `path` a symlink pointing at `target`? A real file or directory is not. */
async function linkedTo(path: string, target: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    if (!st.isSymbolicLink()) return false;
    const raw = await readlink(path);
    const abs = isAbsolute(raw) ? raw : resolve(dirname(path), raw);
    return resolve(abs) === resolve(target);
  } catch {
    return false;
  }
}

async function probeLogin(dir: string, provider: AgentProviderId): Promise<boolean | 'unknown'> {
  // The file's existence is only a hint; Codex may use the OS credential store.
  // Never parse auth.json: even non-secret fields are unnecessary for this UI.
  if (provider === 'codex') return (await exists(join(dir, 'auth.json'))) ? true : 'unknown';
  if (await exists(join(dir, '.credentials.json'))) return true;
  try {
    const parsed = JSON.parse(await readFile(join(dir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    const oauth = parsed?.oauthAccount;
    // The KEY's presence is the whole signal. Nothing inside it is read or kept.
    if (typeof oauth === 'object' && oauth !== null) return true;
  } catch {
    /* no file, or not JSON — proves nothing either way */
  }
  // On macOS the credentials live in the Keychain, so their absence here is not
  // evidence of being logged out. Say so rather than guess.
  return 'unknown';
}

export type AccountDoctorOptions = {
  canonicalClaudeDir?: string;
  canonicalCodexDir?: string;
  /** Defaults to <canonical Claude dir>/skills. */
  sharedSkillsDir?: string;
  /** Defaults to <canonical Claude dir>/CLAUDE.md. */
  sharedInstructionsFile?: string;
  /** Exact command the Codex PreToolUse/Bash hook must execute. */
  expectedCodexHookCommand?: string;
};

type ResolvedDoctorOptions = Required<
  Omit<AccountDoctorOptions, 'expectedCodexHookCommand'>
> & { expectedCodexHookCommand?: string };

function resolveDoctorOptions(options: string | AccountDoctorOptions): ResolvedDoctorOptions {
  const input = typeof options === 'string' ? { canonicalClaudeDir: options } : options;
  const canonicalClaude = input.canonicalClaudeDir ?? canonicalDir();
  return {
    canonicalClaudeDir: canonicalClaude,
    canonicalCodexDir: input.canonicalCodexDir ?? canonicalCodexDir(),
    sharedSkillsDir: input.sharedSkillsDir ?? join(canonicalClaude, 'skills'),
    sharedInstructionsFile: input.sharedInstructionsFile ?? join(canonicalClaude, 'CLAUDE.md'),
    ...(input.expectedCodexHookCommand
      ? { expectedCodexHookCommand: input.expectedCodexHookCommand }
      : {}),
  };
}

/**
 * Read-only validation for the Codex hook trust boundary. This is the exact
 * document check launch uses, parameterized by the resolved command.
 */
export async function codexHooksUseCommand(configDir: string, expectedCommand: string): Promise<boolean> {
  try {
    return validateCodexHooksCommandJson(
      await readFile(join(configDir, 'hooks.json'), 'utf8'),
      expectedCommand,
    );
  } catch {
    return false;
  }
}

export async function checkAccount(
  account: AccountConfig,
  options: string | AccountDoctorOptions = canonicalDir(),
): Promise<AccountHealth> {
  const provider = providerOf(account);
  const resolved = resolveDoctorOptions(options);
  const providerCanonical =
    provider === 'codex' ? resolved.canonicalCodexDir : resolved.canonicalClaudeDir;
  const dirExists = await exists(account.configDir);
  const isCanonical = resolve(account.configDir) === resolve(providerCanonical);
  const instructionsFile = provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
  const skillsLinked =
    provider === 'claude' && isCanonical
      ? dirExists
      : await linkedTo(join(account.configDir, 'skills'), resolved.sharedSkillsDir);
  const instructionsLinked =
    provider === 'claude' && isCanonical
      ? dirExists
      : await linkedTo(join(account.configDir, instructionsFile), resolved.sharedInstructionsFile);
  return {
    name: account.name,
    provider,
    configDir: account.configDir,
    isDefault: false, // filled in by doctor(), which knows the registry
    isCanonicalConfigDir: isCanonical,
    configDirExists: dirExists,
    loggedIn: dirExists ? await probeLogin(account.configDir, provider) : false,
    // Canonical Claude is the shared source, so its own real skills/instructions
    // are consistent by definition. Codex must expose those shared files too.
    skillsLinked,
    instructionsFile,
    instructionsLinked,
    claudeMdLinked: instructionsLinked,
    hooksValid:
      provider === 'codex' && resolved.expectedCodexHookCommand
        ? await codexHooksUseCommand(account.configDir, resolved.expectedCodexHookCommand)
        : null,
    model: account.model ?? null,
    loginCommand: loginCommandFor(account.configDir, resolved.canonicalClaudeDir, provider),
  };
}

export async function doctor(
  reg: AccountRegistry,
  options: string | AccountDoctorOptions = canonicalDir(),
): Promise<AccountHealth[]> {
  return Promise.all(
    reg.accounts.map(async (a) => ({ ...(await checkAccount(a, options)), isDefault: a.name === reg.default })),
  );
}
