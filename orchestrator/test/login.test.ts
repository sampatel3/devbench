import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkLogin, classifyLogin, codexLoginEnv, PROBE_SESSION_ID, type AccountReport } from '../src/login.js';
import { WorkerRunner, claudeEnv } from '../src/worker.js';
import { createServer, listen } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Orchestrator } from '../src/orchestrator.js';

/**
 * The Settings login check. Two things are defended here, and the first one is
 * the important one:
 *
 *  1. the probe runs in the SAME environment a real worker gets. A probe that
 *     built its own could report an account as fine while every worker on it
 *     failed with "Not logged in" — which is the bug that made this button
 *     necessary in the first place, so it is asserted against the environment
 *     the child processes ACTUALLY saw, not against the code that builds it;
 *  2. it never reports a green it did not earn.
 */

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const ORIGINAL_PROFILE_ENV = {
  CODEX_HOME: process.env.CODEX_HOME,
  CODEX_UNRELATED: process.env.CODEX_UNRELATED,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

function restoreEnv(name: keyof typeof ORIGINAL_PROFILE_ENV): void {
  const value = ORIGINAL_PROFILE_ENV[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

let dir: string;
let canonical: string;
let workDir: string;
let worktree: string;
let streamDir: string;
let codexStub: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-login-'));
  canonical = join(dir, '.claude');
  workDir = join(dir, '.claude-work');
  worktree = join(dir, 'issue-4336-demo');
  streamDir = join(dir, 'runs');
  for (const d of [canonical, workDir, worktree, streamDir]) mkdirSync(d, { recursive: true });
  codexStub = join(dir, 'codex-stub.mjs');
  writeFileSync(
    codexStub,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const home = process.env.CODEX_HOME ?? '(none)';
const leaked = 'OPENAI_API_KEY' in process.env || 'CODEX_UNRELATED' in process.env;
if (process.env.STUB_LOGIN === 'out') {
  process.stderr.write('Not logged in\\n');
  process.exit(1);
}
if (process.env.STUB_LOGIN === 'codex-stderr') {
  process.stderr.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
process.stdout.write('Logged in using ChatGPT args=' + args.join(' ') + ' CODEX_HOME=' + home + ' leaked=' + leaked + '\\n');
`,
  );
  chmodSync(codexStub, 0o755);
});

afterEach(() => {
  delete process.env.STUB_LOGIN;
  restoreEnv('CODEX_HOME');
  restoreEnv('CODEX_UNRELATED');
  restoreEnv('OPENAI_API_KEY');
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------- the one rule

/**
 * The anti-regression test. The stub reports the config dir it was handed —
 * ABSENT for the canonical account, set for any other — and both a real worker
 * spawn and the probe are asked the same question about the same account. If
 * these two ever disagree, the button is lying.
 */
describe('the probe runs in the same environment a worker does', () => {
  const workerSaw = async (configDir: string): Promise<string> => {
    const runner = new WorkerRunner({
      bin: STUB,
      permissionMode: 'acceptEdits',
      canonicalConfigDir: canonical,
      streamDir,
      pollMs: 20,
      onChange: () => {},
    });
    await runner.start(4336, worktree, `sess-${Math.random()}`, '/issue-pipeline 4336', configDir, 'claude-opus-5');
    const written = JSON.parse(readFileSync(join(worktree, '.gate.json'), 'utf8')) as { env_config_dir: string | null };
    return written.env_config_dir ?? '(none)';
  };

  const probeSaw = async (configDir: string): Promise<string> => {
    const probe = await checkLogin({ name: 'x', bin: STUB, configDir, canonicalConfigDir: canonical });
    return probe.detail.replace(/^.*config_dir=/, '');
  };

  it('sets no CLAUDE_CONFIG_DIR for the canonical account — in both', async () => {
    expect(await workerSaw(canonical)).toBe('(none)');
    expect(await probeSaw(canonical)).toBe('(none)');
  });

  it('sets it to the account dir for any other account — in both', async () => {
    expect(await workerSaw(workDir)).toBe(workDir);
    expect(await probeSaw(workDir)).toBe(workDir);
  });

  it('is literally the same helper, so the two cannot drift apart', () => {
    // Belt and braces on top of the behavioural check above.
    const worker = claudeEnv({ PATH: '/usr/bin' }, PROBE_SESSION_ID, canonical, canonical);
    const probe = claudeEnv({ PATH: '/usr/bin' }, PROBE_SESSION_ID, canonical, canonical);
    expect(probe).toEqual(worker);
    expect('CLAUDE_CONFIG_DIR' in worker).toBe(false);
  });
});

// ------------------------------------------------------------ classification

describe('reading what the probe said', () => {
  it('calls a clean answer signed in', () => {
    const out = classifyLogin({ exitedCleanly: true, timedOut: false, stdout: 'OK\n', stderr: '', spawnError: null });
    expect(out.verdict).toBe('signed-in');
    expect(out.detail).toContain('OK');
  });

  it('accepts the successful stderr-only output shape of codex login status', () => {
    const out = classifyLogin(
      {
        exitedCleanly: true,
        timedOut: false,
        stdout: '',
        stderr: 'Logged in using ChatGPT\n',
        spawnError: null,
      },
      'codex',
    );
    expect(out.verdict).toBe('signed-in');
    expect(out.detail).toContain('Logged in using ChatGPT');
  });

  it('does not treat arbitrary clean stderr as a successful Claude probe', () => {
    const out = classifyLogin({
      exitedCleanly: true,
      timedOut: false,
      stdout: '',
      stderr: 'warning only\n',
      spawnError: null,
    });
    expect(out.verdict).toBe('unknown');
  });

  it('calls the login message not signed in', () => {
    const out = classifyLogin({
      exitedCleanly: false,
      timedOut: false,
      stdout: '',
      stderr: 'Not logged in · Please run /login\n',
      spawnError: null,
    });
    expect(out.verdict).toBe('not-signed-in');
    expect(out.detail).toContain('Not logged in');
  });

  it("calls a timeout couldn't tell, never a failure and never a pass", () => {
    const out = classifyLogin({ exitedCleanly: false, timedOut: true, stdout: '', stderr: '', spawnError: null });
    expect(out.verdict).toBe('unknown');
    expect(out.detail).toContain('no answer');
  });

  it("calls unrecognised noise couldn't tell, never signed in", () => {
    const out = classifyLogin({
      exitedCleanly: false,
      timedOut: false,
      stdout: 'something went sideways\n',
      stderr: '',
      spawnError: null,
    });
    expect(out.verdict).toBe('unknown');
    expect(out.detail).toContain('sideways');
  });

  it('says so when claude could not be run at all', () => {
    const out = classifyLogin({
      exitedCleanly: false,
      timedOut: false,
      stdout: '',
      stderr: '',
      spawnError: 'ENOENT (claude)',
    });
    expect(out.verdict).toBe('unknown');
    expect(out.detail).toContain('ENOENT');
  });

  it('never calls an empty clean exit a pass', () => {
    const out = classifyLogin({ exitedCleanly: true, timedOut: false, stdout: '   ', stderr: '', spawnError: null });
    expect(out.verdict).toBe('unknown');
  });
});

describe('running the probe for real', () => {
  it('reports a signed-in account', async () => {
    const probe = await checkLogin({ name: 'personal', bin: STUB, configDir: canonical, canonicalConfigDir: canonical });
    expect(probe.verdict).toBe('signed-in');
    expect(probe.loginCommand).toBe('claude /login'); // canonical: no prefix, ever
    expect(Date.parse(probe.checkedAt)).toBeGreaterThan(0);
  });

  it('reports one that is not, with the exact line to type', async () => {
    process.env.STUB_LOGIN = 'out';
    const probe = await checkLogin({ name: 'work', bin: STUB, configDir: workDir, canonicalConfigDir: canonical });
    expect(probe.verdict).toBe('not-signed-in');
    expect(probe.loginCommand).toBe(`CLAUDE_CONFIG_DIR=${workDir} claude /login`);
  });

  it('gives up on a probe that hangs, rather than wedging on it', async () => {
    process.env.STUB_LOGIN = 'hang';
    const probe = await checkLogin({
      name: 'work',
      bin: STUB,
      configDir: workDir,
      canonicalConfigDir: canonical,
      timeoutMs: 300,
    });
    expect(probe.verdict).toBe('unknown');
    expect(probe.detail).toContain('no answer');
  });

  it('does not pretend a confused answer is a good one', async () => {
    process.env.STUB_LOGIN = 'confused';
    const probe = await checkLogin({ name: 'work', bin: STUB, configDir: workDir, canonicalConfigDir: canonical });
    expect(probe.verdict).toBe('unknown');
  });

  it('reports a claude that is not there at all', async () => {
    const probe = await checkLogin({
      name: 'work',
      bin: join(dir, 'no-such-claude'),
      configDir: workDir,
      canonicalConfigDir: canonical,
    });
    expect(probe.verdict).toBe('unknown');
    expect(probe.detail).toContain('could not run claude');
  });

  it('checks Codex login status in the selected isolated CODEX_HOME without spending a model turn', async () => {
    process.env.CODEX_HOME = join(dir, 'inherited-wrong-home');
    process.env.CODEX_UNRELATED = 'strip-me';
    process.env.OPENAI_API_KEY = 'strip-me-too';
    const selected = join(dir, '.codex-work');
    const probe = await checkLogin({
      provider: 'codex',
      name: 'codex-work',
      bin: codexStub,
      configDir: selected,
      canonicalConfigDir: canonical,
    });
    expect(probe.provider).toBe('codex');
    expect(probe.verdict).toBe('signed-in');
    expect(probe.detail).toContain('args=login status');
    expect(probe.detail).toContain(`CODEX_HOME=${selected}`);
    expect(probe.detail).toContain('leaked=false');
    expect(probe.loginCommand).toBe(`CODEX_HOME=${selected} codex login`);
  });

  it('recognises the real stderr-only success channel from codex login status', async () => {
    process.env.STUB_LOGIN = 'codex-stderr';
    const probe = await checkLogin({
      provider: 'codex',
      name: 'codex-work',
      bin: codexStub,
      configDir: join(dir, '.codex-work'),
      canonicalConfigDir: canonical,
    });
    expect(probe.verdict).toBe('signed-in');
    expect(probe.detail).toContain('Logged in using ChatGPT');
  });

  it('reports Codex signed-out and missing-binary results without a false green', async () => {
    process.env.STUB_LOGIN = 'out';
    const out = await checkLogin({
      provider: 'codex',
      name: 'codex-work',
      bin: codexStub,
      configDir: join(dir, '.codex-work'),
      canonicalConfigDir: canonical,
    });
    expect(out.verdict).toBe('not-signed-in');

    const missing = await checkLogin({
      provider: 'codex',
      name: 'codex-work',
      bin: join(dir, 'no-such-codex'),
      configDir: join(dir, '.codex-work'),
      canonicalConfigDir: canonical,
    });
    expect(missing.verdict).toBe('unknown');
    expect(missing.detail).toContain('could not run codex');
  });

  it('builds a Codex status environment by stripping inherited Codex/OpenAI selectors', () => {
    expect(
      codexLoginEnv(
        {
          PATH: '/usr/bin',
          CLAUDE_CODE_ENTRYPOINT: 'host',
          CODEX_HOME: '/wrong',
          CODEX_FOO: 'wrong',
          OPENAI_API_KEY: 'secret',
          KEEP: 'yes',
        },
        '/selected',
      ),
    ).toEqual({
      PATH: '/usr/bin',
      KEEP: 'yes',
      WORKER_SESSION_ID: PROBE_SESSION_ID,
      WORKER_PROVIDER: 'codex',
      CODEX_HOME: '/selected',
    });
  });
});

// -------------------------------------------------------------------- route

describe('POST /api/accounts/:name/check-login', () => {
  let server: Server;
  let base: string;
  let accountsFile: string;
  let stateFile: string;

  beforeEach(async () => {
    accountsFile = join(dir, 'accounts.json');
    stateFile = join(dir, 'state.json');
    writeFileSync(
      accountsFile,
      JSON.stringify({ default: 'personal', accounts: [{ name: 'personal', configDir: canonical }] }),
    );
    const cfg = loadConfig({
      PORT: '0',
      STATE_FILE: stateFile,
      ACCOUNTS_FILE: accountsFile,
      CANONICAL_CLAUDE_DIR: canonical,
      CLAUDE_BIN: STUB,
      POLL_MS: '999999',
    });
    const orch = new Orchestrator(cfg);
    await orch.accountsReport(); // load the registry without polling GitHub
    server = await listen(createServer(cfg, orch), cfg);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const call = async (path: string) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    return { status: res.status, body: (await res.json()) as { ok: boolean; message: string; accounts: AccountReport[] } };
  };

  it('answers with the verdict and carries it on the account report', async () => {
    const before = readFileSync(accountsFile, 'utf8');
    const { status, body } = await call('/api/accounts/personal/check-login');
    expect(status).toBe(200);
    expect(body.accounts[0]!.provider).toBe('claude');
    expect(body.accounts[0]!.probe!.verdict).toBe('signed-in');
    // It changes nothing on disk: not the registry, not the state file.
    expect(readFileSync(accountsFile, 'utf8')).toBe(before);
    expect(existsSync(stateFile)).toBe(false);
  });

  it('keeps the file signal and the probe as two separate things', async () => {
    const { body } = await call('/api/accounts/personal/check-login');
    const acct = body.accounts[0]!;
    // The canonical account's credentials are in the Keychain, so the FILE
    // signal cannot tell — and the probe can. Both are reported, unmerged.
    expect(acct.loggedIn).toBe('unknown');
    expect(acct.probe!.verdict).toBe('signed-in');
  });

  it('409s for an account that is not registered', async () => {
    const { status, body } = await call('/api/accounts/nope/check-login');
    expect(status).toBe(409);
    expect(body.message).toContain('no account called');
  });
});
