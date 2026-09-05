import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { codexWorkerEnv } from './env.js';
import { shellQuote } from './shell.js';
import type { AgentProvider, ProviderLaunchInput, ProviderLaunchSpec } from './types.js';

export type CodexProviderOptions = {
  bin: string;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Refuses broad execution when the console-owned hook is absent or changed. */
  assertHooksReady: (configDir: string) => Promise<void>;
};

const PROJECT_DOC_FALLBACK = 'project_doc_fallback_filenames=["CLAUDE.md"]';
/** A profile or repository config may otherwise set `[features] hooks = false`.
 * The trust bypass only runs hooks that are enabled, so broad worker execution
 * must pin the feature on at the invocation's highest ordinary config layer. */
const HOOKS_ENABLED = 'features.hooks=true';
export const CODEX_SHARED_SKILL_COMPAT =
  'Host compatibility: this shared workflow was authored for Claude Code. ' +
  "Treat every referenced Claude slash skill (for example /code-review) as an explicit invocation of the same installed skill using Codex's dollar-prefixed syntax. " +
  'Map Read, Write, Edit and Bash to the equivalent Codex tools, ' +
  'TodoWrite to the Codex plan, and Task/subagent instructions to Codex subagents when available. ' +
  'If it names AskUserQuestion in this headless worker, preserve the stop-and-wait intent through the workflow gate files. ' +
  'Preserve every safety rule and never start a nested claude or codex process.';

async function findSessionFile(root: string, sessionId: string): Promise<string | null> {
  const pending: Array<{ dir: string; depth: number }> = [{ dir: join(root, 'sessions'), depth: 0 }];
  while (pending.length > 0) {
    const current = pending.shift()!;
    const entries = await readdir(current.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(current.dir, entry.name);
      if (entry.isFile() && entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) return path;
      if (entry.isDirectory() && current.depth < 6) pending.push({ dir: path, depth: current.depth + 1 });
    }
  }
  return null;
}

function assertPromptArgument(prompt: string): void {
  if (prompt === '-') {
    throw new Error("Codex reserves the exact prompt '-' for stdin; send an explicit instruction instead");
  }
}

export class CodexProvider implements AgentProvider {
  readonly id = 'codex' as const;
  readonly label = 'Codex';

  constructor(private readonly opts: CodexProviderOptions) {}

  async assertReady(configDir: string): Promise<void> {
    await this.opts.assertHooksReady(configDir);
  }

  async start(input: ProviderLaunchInput): Promise<ProviderLaunchSpec> {
    await this.assertReady(input.configDir);
    assertPromptArgument(input.prompt);
    return this.#spec(input, [
      '-a',
      'never',
      '-C',
      input.worktree,
      '-s',
      this.opts.sandbox,
      '-m',
      input.model,
      '-c',
      PROJECT_DOC_FALLBACK,
      '-c',
      HOOKS_ENABLED,
      'exec',
      // Keep CODEX_HOME for auth, sessions, skills, AGENTS.md and the owned
      // hooks.json, but do not activate config.toml trust entries that would
      // make repository or plugin hooks eligible for the trust bypass below.
      '--ignore-user-config',
      '--json',
      '--dangerously-bypass-hook-trust',
      '--output-last-message',
      input.lastMessageFile,
      '--',
      input.prompt,
    ]);
  }

  async resume(input: ProviderLaunchInput): Promise<ProviderLaunchSpec> {
    await this.assertReady(input.configDir);
    if (!input.agentSessionId) throw new Error('Codex cannot resume before its thread id has been recorded');
    assertPromptArgument(input.prompt);
    return this.#spec(input, [
      '-a',
      'never',
      '-C',
      input.worktree,
      '-s',
      this.opts.sandbox,
      '-m',
      input.model,
      '-c',
      PROJECT_DOC_FALLBACK,
      '-c',
      HOOKS_ENABLED,
      'exec',
      'resume',
      '--ignore-user-config',
      '--json',
      '--dangerously-bypass-hook-trust',
      '--output-last-message',
      input.lastMessageFile,
      input.agentSessionId,
      '--',
      input.prompt,
    ]);
  }

  #spec(input: ProviderLaunchInput, args: string[]): ProviderLaunchSpec {
    return {
      bin: this.opts.bin,
      args,
      env: codexWorkerEnv({
        base: input.baseEnv,
        sessionId: input.sessionId,
        configDir: input.configDir,
        gate: input.gate,
      }),
      processIdentityToken: input.lastMessageFile,
      initialAgentSessionId: input.agentSessionId,
    };
  }

  workflowPrompt(issue: number, mode: 'start' | 'resume'): string {
    return `$issue-pipeline ${issue}${mode === 'resume' ? ' resume' : ''}\n\n${CODEX_SHARED_SKILL_COMPAT}`;
  }

  async sessionActivity(input: { configDir: string; agentSessionId: string }): Promise<number | null> {
    const path = await findSessionFile(input.configDir, input.agentSessionId);
    return path ? stat(path).then((value) => value.mtimeMs).catch(() => null) : null;
  }

  terminalResumeCommand(input: { worktree: string; configDir: string; agentSessionId: string }): string {
    return (
      `cd ${shellQuote(input.worktree)} && CODEX_HOME=${shellQuote(input.configDir)} ` +
      `${shellQuote(this.opts.bin)} -C ${shellQuote(input.worktree)} resume ${shellQuote(input.agentSessionId)}`
    );
  }
}
