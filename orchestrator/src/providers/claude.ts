import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isCanonicalDir } from '../accounts.js';
import { claudeWorkerEnv } from './env.js';
import { shellQuote } from './shell.js';
import type { AgentProvider, ProviderLaunchInput, ProviderLaunchSpec } from './types.js';

export type ClaudeProviderOptions = {
  bin: string;
  permissionMode: string;
  canonicalConfigDir: string;
  extraArgs?: string[];
};

export function claudeSessionDir(cwd: string, configDir: string): string {
  return join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

export function claudeTranscriptPath(cwd: string, sessionId: string, configDir: string): string {
  return join(claudeSessionDir(cwd, configDir), `${sessionId}.jsonl`);
}

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const;
  readonly label = 'Claude';

  constructor(private readonly opts: ClaudeProviderOptions) {}

  async assertReady(_configDir: string): Promise<void> {}

  async start(input: ProviderLaunchInput): Promise<ProviderLaunchSpec> {
    await this.assertReady(input.configDir);
    return this.#spec(input, [
      '-p',
      input.prompt,
      '--session-id',
      input.sessionId,
      '--model',
      input.model,
      '--permission-mode',
      this.opts.permissionMode,
      '--output-format',
      'stream-json',
      '--verbose',
      ...(this.opts.extraArgs ?? []),
    ]);
  }

  async resume(input: ProviderLaunchInput): Promise<ProviderLaunchSpec> {
    await this.assertReady(input.configDir);
    const agentSessionId = input.agentSessionId ?? input.sessionId;
    return this.#spec(input, [
      '--resume',
      agentSessionId,
      '-p',
      input.prompt,
      '--model',
      input.model,
      '--permission-mode',
      this.opts.permissionMode,
      '--output-format',
      'stream-json',
      '--verbose',
      ...(this.opts.extraArgs ?? []),
    ]);
  }

  #spec(input: ProviderLaunchInput, args: string[]): ProviderLaunchSpec {
    return {
      bin: this.opts.bin,
      args,
      env: claudeWorkerEnv({
        base: input.baseEnv,
        sessionId: input.sessionId,
        configDir: input.configDir,
        canonicalConfigDir: this.opts.canonicalConfigDir,
        gate: input.gate,
      }),
      processIdentityToken: input.agentSessionId ?? input.sessionId,
      initialAgentSessionId: input.agentSessionId ?? input.sessionId,
    };
  }

  workflowPrompt(issue: number, mode: 'start' | 'resume'): string {
    return `/issue-pipeline ${issue}${mode === 'resume' ? ' resume' : ''}`;
  }

  async sessionActivity(input: { worktree: string; configDir: string; agentSessionId: string }): Promise<number | null> {
    return stat(claudeTranscriptPath(input.worktree, input.agentSessionId, input.configDir))
      .then((value) => value.mtimeMs)
      .catch(() => null);
  }

  terminalResumeCommand(input: { worktree: string; configDir: string; agentSessionId: string }): string {
    const prefix =
      isCanonicalDir(input.configDir, this.opts.canonicalConfigDir)
        ? ''
        : `CLAUDE_CONFIG_DIR=${shellQuote(input.configDir)} `;
    return `cd ${shellQuote(input.worktree)} && ${prefix}${shellQuote(this.opts.bin)} --resume ${shellQuote(input.agentSessionId)}`;
  }
}
