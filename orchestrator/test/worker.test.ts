import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerRunner, cleanEnv, transcriptPath } from '../src/worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');

let worktree: string;
let configDir: string;
let canonical: string;
let streamDir: string;

/** `canonical` is a directory of its own here, so `configDir` is genuinely a
 *  non-canonical account and the two cases can be told apart. `streamDir` is
 *  where the workers' stream-json files go — a temp dir, never the repo's. */
const runner = (over: { bin?: string } = {}) =>
  new WorkerRunner({
    bin: STUB,
    permissionMode: 'acceptEdits',
    canonicalConfigDir: canonical,
    streamDir,
    pollMs: 20,
    onChange: () => {},
    ...over,
  });

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'wc-worker-'));
  configDir = mkdtempSync(join(tmpdir(), 'wc-acct-'));
  canonical = mkdtempSync(join(tmpdir(), 'wc-canon-'));
  streamDir = mkdtempSync(join(tmpdir(), 'wc-stream-'));
});
afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(canonical, { recursive: true, force: true });
  rmSync(streamDir, { recursive: true, force: true });
});

describe('cleanEnv', () => {
  it('strips the host-auth vars that stop a child claude from authenticating', () => {
    const env = cleanEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/operator',
        CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: '1',
        CLAUDECODE: '1',
        ANTHROPIC_BASE_URL: 'https://proxy.internal',
        AI_AGENT: 'claude',
      },
      'sess-1',
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/operator');
    expect(env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.AI_AGENT).toBeUndefined();
  });

  it('hands the worker its own session id so the skill can stamp .gate.json', () => {
    expect(cleanEnv({}, 'sess-42').WORKER_SESSION_ID).toBe('sess-42');
  });

  // Order is the whole point: strip every CLAUDE* var first, THEN set the
  // account's dir. The other way round the strip would delete it again and the
  // worker would quietly run under the default account.
  it('strips the inherited CLAUDE_CONFIG_DIR and sets the chosen account dir', () => {
    const env = cleanEnv({ CLAUDE_CONFIG_DIR: '/host/.claude', CLAUDECODE: '1' }, 'sess-1', '/Users/operator/.claude-work');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/Users/operator/.claude-work');
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it('sets no config dir at all when no account is given', () => {
    expect(cleanEnv({ CLAUDE_CONFIG_DIR: '/host/.claude' }, 'sess-1').CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});

/**
 * The regression that broke every worker on the default account: the console set
 * CLAUDE_CONFIG_DIR for EVERY account, canonical included, on the assumption
 * that naming `~/.claude` is the same as leaving it unset. It is not — the
 * default account's credentials live in the macOS Keychain, and naming the
 * directory makes Claude Code look for a credentials FILE instead and refuse to
 * start with "Not logged in". The variable must be ABSENT, not empty.
 */
describe('the canonical account is run with no CLAUDE_CONFIG_DIR at all', () => {
  it('leaves the variable out of the child env entirely on spawn and on resume', async () => {
    const r = runner();
    await r.start(4336, worktree, 'sess-canon', '/issue-pipeline 4336', canonical, 'claude-opus-5');
    const written = JSON.parse(readFileSync(join(worktree, '.gate.json'), 'utf8'));
    // The stub reports null only when the KEY is missing, not when it is empty.
    expect(written.env_config_dir).toBeNull();

    await r.resume(4336, worktree, 'sess-canon', 'go on', canonical, 'claude-opus-5');
    expect(readFileSync(join(worktree, 'resumed.txt'), 'utf8')).toContain('config dir: (none)');
  });

  it('still sets it for any other account', async () => {
    await runner().start(4336, worktree, 'sess-other', '/issue-pipeline 4336', configDir, 'claude-opus-5');
    expect(JSON.parse(readFileSync(join(worktree, '.gate.json'), 'utf8')).env_config_dir).toBe(configDir);
  });
});

describe('the model reaches the child process', () => {
  it('passes the resolved model to --model on spawn and on resume', async () => {
    const r = runner();
    await r.start(4336, worktree, 'sess-model', '/issue-pipeline 4336', configDir, 'claude-haiku-4-5-20251001');
    expect(JSON.parse(readFileSync(join(worktree, '.gate.json'), 'utf8')).model_arg).toBe('claude-haiku-4-5-20251001');

    await r.resume(4336, worktree, 'sess-model', 'go on', configDir, 'claude-haiku-4-5-20251001');
    expect(readFileSync(join(worktree, 'resumed.txt'), 'utf8')).toContain('model: claude-haiku-4-5-20251001');
  });

  it('passes an id this build has never heard of straight through', async () => {
    await runner().start(4336, worktree, 'sess-odd', '/issue-pipeline 4336', configDir, 'claude-something-unreleased');
    expect(JSON.parse(readFileSync(join(worktree, '.gate.json'), 'utf8')).model_arg).toBe('claude-something-unreleased');
  });

  it('reports what the run cost, off the result event', async () => {
    const res = await runner().start(4336, worktree, 'sess-usage', '/issue-pipeline 4336', configDir, 'claude-opus-5');
    // modelUsage is preferred over usage: it covers Task subagents, which is most
    // of what a issue-pipeline worker does.
    expect(res.usage).toEqual({
      inputTokens: 11,
      outputTokens: 300,
      reasoningOutputTokens: null,
      cacheReadTokens: 5000,
      cacheCreationTokens: 900,
      costUsd: 0.42,
      numTurns: 2,
      source: 'modelUsage',
    });
    expect(res.toolCalls).toBe(1);
    expect(res.resolvedModel).toBe('claude-opus-5');
  });
});

describe('transcriptPath', () => {
  it('matches how Claude Code names a worktree session directory', () => {
    const p = transcriptPath(
      '/Users/operator/Code/example-org/example-repo/.worktrees/issue-4336-org-sysadmin-filter-pills',
      'abc',
      '/Users/operator/.claude',
    );
    expect(p).toContain('/-Users-operator-Code-example-org-example-repo--worktrees-issue-4336-org-sysadmin-filter-pills/');
    expect(p.endsWith('/abc.jsonl')).toBe(true);
  });

  it('reads the transcript out of the account that wrote it', () => {
    const p = transcriptPath('/wt/issue-1-x', 'abc', '/Users/operator/.claude-work');
    expect(p.startsWith('/Users/operator/.claude-work/projects/')).toBe(true);
  });
});

/**
 * The loop the whole console rests on, against a stub that speaks the same
 * stream-json contract as `claude`. See spike/NOTES.txt for why it is a stub.
 */
describe('spawn -> gate stop -> resume', () => {
  it('runs the whole loop', async () => {
    const r = runner();

    const first = await r.start(4336, worktree, 'sess-abc', '/issue-pipeline 4336', configDir, 'claude-opus-5');
    expect(first.outcome).toBe('gate');
    expect(first.gate!.gate).toBe('C');
    expect(first.gate!.issue).toBe(4336);
    expect(first.gate!.questions).toHaveLength(2);
    expect(first.turns).toBe(2);
    expect(existsSync(join(worktree, '.gate.json'))).toBe(true);

    // The worker saw its own session id through the environment.
    const written = JSON.parse(readFileSync(join(worktree, '.gate.json'), 'utf8'));
    expect(written.env_session_id).toBe('sess-abc');

    const second = await r.resume(4336, worktree, 'sess-abc', 'Gate C approved, proceed.', configDir, 'claude-opus-5');
    expect(second.outcome).toBe('finished');
    expect(second.gate).toBeNull();
    expect(existsSync(join(worktree, '.gate.json'))).toBe(false);
    expect(readFileSync(join(worktree, 'resumed.txt'), 'utf8')).toContain('Gate C approved, proceed.');
  });

  // The account is not a hint: the child process really runs with that dir, on
  // the first spawn and on every resume of the same session.
  it('runs claude under the account dir it was given, spawn and resume alike', async () => {
    const r = runner();
    await r.start(4336, worktree, 'sess-acct', '/issue-pipeline 4336', configDir, 'claude-opus-5');
    const written = JSON.parse(readFileSync(join(worktree, '.gate.json'), 'utf8'));
    expect(written.env_config_dir).toBe(configDir);

    await r.resume(4336, worktree, 'sess-acct', 'go on', configDir, 'claude-opus-5');
    expect(readFileSync(join(worktree, 'resumed.txt'), 'utf8')).toContain(`config dir: ${configDir}`);
  });

  it('reports a failed run instead of pretending it stopped at a gate', async () => {
    const res = await runner().start(4444, worktree, 'sess-fail', 'FAIL please', configDir, 'claude-opus-5');
    expect(res.outcome).toBe('failed');
    expect(res.error).toBe('stub worker was told to fail');
    expect(res.gate).toBeNull();
  });

  it('refuses a second concurrent run of the same issue — as REFUSED, not as a failed run', async () => {
    // The distinction is load-bearing, not cosmetic. A `failed` outcome is an
    // ENDING and gets the full ending treatment from the orchestrator: the
    // running-worker row deleted, a line in runs.jsonl, an error on the card.
    // Every one of those belongs to the worker that is actually alive, so
    // reporting a refused duplicate as a failure deleted the LIVE worker's
    // re-attachment row — orphaning it across a restart — and wrote a phantom
    // failed run. `refused` says the true thing: this spawn never happened.
    const r = runner();
    const a = r.start(4336, worktree, 'sess-a', '/issue-pipeline 4336', configDir, 'claude-opus-5');
    const b = await r.start(4336, worktree, 'sess-b', '/issue-pipeline 4336', configDir, 'claude-opus-5');
    expect(b.outcome).toBe('refused');
    expect(b.error).toContain('already running');
    await a;
  });

  it('reports a binary that cannot start as a FAILED run — and does not take the console down', async () => {
    // A spawn that cannot resolve the binary reports it asynchronously on the
    // child emitter. The listener was registered only after the "no pid" early
    // return, so nothing was listening when the event arrived and the unhandled
    // 'error' killed the process. Reaching the assertions below at all is the
    // real proof; a missing `claude` must cost one run, never the console.
    const r = runner({ bin: join(here, 'fixtures', 'no-such-binary.mjs') });
    const res = await r.start(4336, worktree, 'sess-nobin', '/issue-pipeline 4336', configDir, 'claude-opus-5');
    expect(res.outcome).toBe('failed'); // a real attempt that really did not start
    expect(res.error).toContain('could not start');
  });

  it('clears the gate file before resuming, so a crashed resume does not look parked', async () => {
    const r = runner();
    await r.start(4336, worktree, 'sess-abc', '/issue-pipeline 4336', configDir, 'claude-opus-5');
    expect(existsSync(join(worktree, '.gate.json'))).toBe(true);
    await r.resume(4336, worktree, 'sess-abc', 'go on', configDir, 'claude-opus-5');
    expect(existsSync(join(worktree, '.gate.json'))).toBe(false);
  });
});
