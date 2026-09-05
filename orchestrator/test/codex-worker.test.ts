import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexProvider } from '../src/providers/index.js';
import { WorkerRunner } from '../src/worker.js';
import type { RunningRun } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const STUB_CODEX = join(here, 'fixtures', 'stub-codex.mjs');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what: string, condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await wait(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let worktree: string;
let configDir: string;
let streamDir: string;

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'wc-codex-worker-'));
  configDir = mkdtempSync(join(tmpdir(), 'wc-codex-home-'));
  streamDir = mkdtempSync(join(tmpdir(), 'wc-codex-stream-'));
});

afterEach(() => {
  delete process.env.STUB_CODEX_THREAD;
  delete process.env.STUB_CODEX_FAIL;
  delete process.env.STUB_ARGV_FILE;
  rmSync(worktree, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(streamDir, { recursive: true, force: true });
});

const makeRunner = (onAgentSession = vi.fn()) =>
  new WorkerRunner({
    providers: {
      codex: new CodexProvider({
        bin: STUB_CODEX,
        sandbox: 'danger-full-access',
        assertHooksReady: async () => {},
      }),
    },
    streamDir,
    pollMs: 20,
    decisionsFile: join(streamDir, 'decisions.jsonl'),
    onAgentSession,
    onChange: () => {},
  });

describe('Codex worker parity', () => {
  it('starts, learns the Codex thread, reaches a gate and resumes that same thread', async () => {
    process.env.STUB_CODEX_THREAD = '019-codex-thread';
    const argvFile = join(streamDir, 'spawned-codex-argv.json');
    process.env.STUB_ARGV_FILE = argvFile;
    const learned = vi.fn();
    const runner = makeRunner(learned);

    const first = await runner.start(
      4336,
      worktree,
      'console-session',
      '$issue-pipeline 4336',
      configDir,
      'gpt-5.6-sol',
      'codex',
    );
    expect(first.provider).toBe('codex');
    expect(first.agentSessionId).toBe('019-codex-thread');
    expect(first.outcome).toBe('gate');
    expect(first.gate?.gate).toBe('C');
    expect(first.gate?.sessionId).toBe('console-session');
    expect(first.usage).toEqual({
      inputTokens: 17,
      outputTokens: 11,
      reasoningOutputTokens: 2,
      cacheReadTokens: 7,
      cacheCreationTokens: 3,
      costUsd: null,
      numTurns: 1,
      source: 'codex',
    });
    expect(learned).toHaveBeenCalledWith(4336, 'codex', '019-codex-thread');

    const lastMessageFile = join(streamDir, '4336-console-session.last-message.txt');
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual({
      argv: [
        '-a',
        'never',
        '-C',
        worktree,
        '-s',
        'danger-full-access',
        '-m',
        'gpt-5.6-sol',
        '-c',
        'project_doc_fallback_filenames=["CLAUDE.md"]',
        '-c',
        'features.hooks=true',
        'exec',
        '--ignore-user-config',
        '--json',
        '--dangerously-bypass-hook-trust',
        '--output-last-message',
        lastMessageFile,
        '--',
        '$issue-pipeline 4336',
      ],
      codexHome: configDir,
      workerSessionId: 'console-session',
    });

    const gate = JSON.parse(readFileSync(join(worktree, '.gate.json'), 'utf8')) as Record<string, unknown>;
    expect(gate.prompt).toBe('$issue-pipeline 4336');
    expect(gate.env_codex_home).toBe(configDir);
    expect(gate.model_arg).toBe('gpt-5.6-sol');

    const second = await runner.resume(
      4336,
      worktree,
      'console-session',
      'Gate C approved',
      configDir,
      'gpt-5.6-sol',
      'codex',
      '019-codex-thread',
    );
    expect(second.outcome).toBe('finished');
    expect(second.agentSessionId).toBe('019-codex-thread');
    expect(existsSync(join(worktree, '.gate.json'))).toBe(false);
    expect(readFileSync(join(worktree, 'resumed-codex.txt'), 'utf8')).toContain('thread: 019-codex-thread');
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual({
      argv: [
        '-a',
        'never',
        '-C',
        worktree,
        '-s',
        'danger-full-access',
        '-m',
        'gpt-5.6-sol',
        '-c',
        'project_doc_fallback_filenames=["CLAUDE.md"]',
        '-c',
        'features.hooks=true',
        'exec',
        'resume',
        '--ignore-user-config',
        '--json',
        '--dangerously-bypass-hook-trust',
        '--output-last-message',
        lastMessageFile,
        '019-codex-thread',
        '--',
        'Gate C approved',
      ],
      codexHome: configDir,
      workerSessionId: 'console-session',
    });
  });

  it('fails one run cleanly when the Codex thread fails', async () => {
    process.env.STUB_CODEX_FAIL = '1';
    const result = await makeRunner().start(
      4336,
      worktree,
      'console-fail',
      '$issue-pipeline 4336',
      configDir,
      'gpt-5.6-sol',
      'codex',
    );
    expect(result.outcome).toBe('failed');
    expect(result.error).toBe('stub Codex was told to fail');
    expect(result.agentSessionId).not.toBeNull();
  });

  it('fails closed before spawn when the owned hooks are not ready', async () => {
    const runner = new WorkerRunner({
      providers: {
        codex: new CodexProvider({
          bin: STUB_CODEX,
          sandbox: 'danger-full-access',
          assertHooksReady: async () => {
            throw new Error('Codex write fence is missing');
          },
        }),
      },
      streamDir,
      onChange: () => {},
    });
    const result = await runner.start(
      4336,
      worktree,
      'console-no-hook',
      '$issue-pipeline 4336',
      configDir,
      'gpt-5.6-sol',
      'codex',
    );
    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('write fence');

    writeFileSync(join(worktree, '.gate.json'), '{"issue":4336,"gate":"C","sessionId":"console-no-hook"}\n');
    const resumed = await runner.resume(
      4336,
      worktree,
      'console-no-hook',
      'approved',
      configDir,
      'gpt-5.6-sol',
      'codex',
      'codex-thread',
    );
    expect(resumed.outcome).toBe('failed');
    expect(existsSync(join(worktree, '.gate.json'))).toBe(true);
  });

  it('times live Codex tools but never stamps a replayed reattach backlog with now', async () => {
    const streamFile = join(streamDir, 'codex-reattach.stream.jsonl');
    const stderrFile = join(streamDir, 'codex-reattach.stderr.log');
    writeFileSync(
      streamFile,
      [
        JSON.stringify({ type: 'thread.started', thread_id: '019-reattached' }),
        JSON.stringify({
          type: 'item.started',
          item: { id: 'old-command', type: 'command_execution', command: 'npm run old-command' },
        }),
      ].join('\n') + '\n',
    );
    writeFileSync(stderrFile, '');

    const runner = makeRunner();
    const entry: RunningRun = {
      issue: 4336,
      provider: 'codex',
      sessionId: 'console-reattach',
      agentSessionId: '019-reattached',
      processIdentityToken: 'codex-reattach-test',
      pid: process.pid,
      worktree,
      streamFile,
      stderrFile,
      startOffset: 0,
      offset: 0,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      model: 'gpt-5.6-sol',
      account: 'codex-test',
      headBefore: null,
      stageStart: null,
      labels: [],
    };
    const attached = runner.attach(entry, configDir);

    await waitFor('the historical tool event to be replayed', () => runner.live(4336)?.toolRunning === true);
    expect(runner.live(4336)?.lastToolCommand).toBe('npm run old-command');
    expect(runner.live(4336)?.lastToolAt).toBeNull();

    const observedAfter = Date.now();
    appendFileSync(
      streamFile,
      [
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'old-command', type: 'command_execution', command: 'npm run old-command', exit_code: 0 },
        }),
        JSON.stringify({
          type: 'item.started',
          item: { id: 'new-command', type: 'command_execution', command: 'npm run live-command' },
        }),
      ].join('\n') + '\n',
    );
    await waitFor('the new live tool event to be observed', () => runner.live(4336)?.lastToolCommand === 'npm run live-command');
    const observedAt = Date.parse(runner.live(4336)!.lastToolAt!);
    expect(observedAt).toBeGreaterThanOrEqual(observedAfter);
    expect(observedAt).toBeLessThanOrEqual(Date.now());

    expect(await runner.detachAll()).toBe(1);
    expect((await attached).outcome).toBe('left-running');
  });
});
