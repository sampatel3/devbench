import { describe, expect, it, vi } from 'vitest';
import { ClaudeProvider, CodexProvider } from '../src/providers/index.js';

const base = {
  issue: 4336,
  worktree: '/tmp/issue-4336-demo',
  sessionId: 'console-session',
  agentSessionId: null,
  prompt: '$issue-pipeline 4336',
  model: 'gpt-5.6-sol',
  configDir: '/tmp/codex-home',
  lastMessageFile: '/tmp/runs/4336-console-session.last.txt',
  baseEnv: {
    PATH: '/usr/bin',
    CODEX_THREAD_ID: 'host-thread',
    CODEX_HOME: '/host/codex',
    OPENAI_API_KEY: 'must-not-leak',
    CLAUDECODE: '1',
  },
  gate: { issue: 4336, decisionsFile: '/tmp/decisions.jsonl' },
};

describe('Claude provider contract', () => {
  const provider = new ClaudeProvider({
    bin: '/usr/local/bin/claude',
    permissionMode: 'bypassPermissions',
    canonicalConfigDir: '/Users/operator/.claude',
    extraArgs: ['--settings', '{"hooks":{}}'],
  });

  it('keeps the established start and resume contract', async () => {
    const input = {
      ...base,
      prompt: '/issue-pipeline 4336',
      model: 'claude-opus-5',
      configDir: '/Users/operator/.claude-work',
    };
    const start = await provider.start(input);
    expect(start.bin).toBe('/usr/local/bin/claude');
    expect(start.args).toEqual([
      '-p',
      '/issue-pipeline 4336',
      '--session-id',
      'console-session',
      '--model',
      'claude-opus-5',
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'stream-json',
      '--verbose',
      '--settings',
      '{"hooks":{}}',
    ]);
    expect(start.env.CLAUDE_CONFIG_DIR).toBe('/Users/operator/.claude-work');
    expect(start.initialAgentSessionId).toBe('console-session');
    expect(start.processIdentityToken).toBe('console-session');

    const resume = await provider.resume({ ...input, prompt: 'Gate C approved', agentSessionId: 'console-session' });
    expect(resume.args.slice(0, 4)).toEqual(['--resume', 'console-session', '-p', 'Gate C approved']);
  });

  it('uses Claude skill syntax and a provider-specific terminal command', () => {
    expect(provider.workflowPrompt(4336, 'start')).toBe('/issue-pipeline 4336');
    expect(provider.workflowPrompt(4336, 'resume')).toBe('/issue-pipeline 4336 resume');
    expect(
      provider.terminalResumeCommand({
        worktree: '/tmp/issue 4336',
        configDir: '/Users/operator/.claude-work',
        agentSessionId: 'abc',
      }),
    ).toContain("CLAUDE_CONFIG_DIR='/Users/operator/.claude-work'");
  });
});

describe('Codex provider contract', () => {
  it('builds exact non-interactive JSONL start and resume commands after validating hooks', async () => {
    const ready = vi.fn(async () => {});
    const provider = new CodexProvider({
      bin: '/opt/homebrew/bin/codex',
      sandbox: 'danger-full-access',
      assertHooksReady: ready,
    });

    const start = await provider.start(base);
    expect(ready).toHaveBeenCalledWith('/tmp/codex-home');
    expect(start.bin).toBe('/opt/homebrew/bin/codex');
    expect(start.args).toEqual([
      '-a',
      'never',
      '-C',
      '/tmp/issue-4336-demo',
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
      '/tmp/runs/4336-console-session.last.txt',
      '--',
      '$issue-pipeline 4336',
    ]);
    expect(start.initialAgentSessionId).toBeNull();
    expect(start.processIdentityToken).toBe('/tmp/runs/4336-console-session.last.txt');
    expect(start.env.CODEX_HOME).toBe('/tmp/codex-home');
    expect(start.env.WORKER_SESSION_ID).toBe('console-session');
    expect(start.env.WORKER_PROVIDER).toBe('codex');
    expect(start.env.CODEX_THREAD_ID).toBeUndefined();
    expect(start.env.OPENAI_API_KEY).toBeUndefined();
    expect(start.env.CLAUDECODE).toBeUndefined();

    const resume = await provider.resume({ ...base, prompt: 'Gate C approved', agentSessionId: '019-thread' });
    expect(resume.args).toEqual([
      '-a',
      'never',
      '-C',
      '/tmp/issue-4336-demo',
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
      '/tmp/runs/4336-console-session.last.txt',
      '019-thread',
      '--',
      'Gate C approved',
    ]);
  });

  it('delimits dash-leading prompts and refuses the stdin sentinel', async () => {
    const provider = new CodexProvider({ bin: 'codex', sandbox: 'danger-full-access', assertHooksReady: async () => {} });

    const start = await provider.start({ ...base, prompt: '--help' });
    expect(start.args.slice(-2)).toEqual(['--', '--help']);

    const resume = await provider.resume({ ...base, agentSessionId: '019-thread', prompt: '--keep-going' });
    expect(resume.args.slice(-3)).toEqual(['019-thread', '--', '--keep-going']);

    await expect(provider.start({ ...base, prompt: '-' })).rejects.toThrow('reserves');
    await expect(provider.resume({ ...base, agentSessionId: '019-thread', prompt: '-' })).rejects.toThrow('stdin');
  });

  it('refuses to launch or resume when the owned hook is not ready', async () => {
    const provider = new CodexProvider({
      bin: 'codex',
      sandbox: 'danger-full-access',
      assertHooksReady: async () => {
        throw new Error('Codex write fence is not linked');
      },
    });
    await expect(provider.start(base)).rejects.toThrow('write fence');
    await expect(provider.resume({ ...base, agentSessionId: '019-thread' })).rejects.toThrow('write fence');
  });

  it('requires the learned Codex thread id for resume', async () => {
    const provider = new CodexProvider({ bin: 'codex', sandbox: 'danger-full-access', assertHooksReady: async () => {} });
    await expect(provider.resume(base)).rejects.toThrow('thread id');
  });

  it('uses Codex skill syntax and a CODEX_HOME-scoped terminal command', () => {
    const provider = new CodexProvider({ bin: 'codex', sandbox: 'danger-full-access', assertHooksReady: async () => {} });
    expect(provider.workflowPrompt(4336, 'start')).toMatch(/^\$issue-pipeline 4336\n\nHost compatibility:/);
    expect(provider.workflowPrompt(4336, 'resume')).toMatch(/^\$issue-pipeline 4336 resume\n\nHost compatibility:/);
    expect(provider.workflowPrompt(4336, 'start')).toContain('/code-review');
    expect(provider.workflowPrompt(4336, 'start')).toContain('never start a nested claude or codex process');
    const command = provider.terminalResumeCommand({
      worktree: '/tmp/issue 4336',
      configDir: '/tmp/codex home',
      agentSessionId: '019-thread',
    });
    expect(command).toContain("CODEX_HOME='/tmp/codex home'");
    expect(command).toContain("resume '019-thread'");
  });
});
