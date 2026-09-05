export type AgentProviderId = 'claude' | 'codex';

export type WorkerGateEnv = { issue: number; decisionsFile: string };

export type ProviderLaunchInput = {
  issue: number;
  worktree: string;
  /** Console-owned id: stable before the provider process exists. */
  sessionId: string;
  /** Provider-owned conversation id. Null on a fresh Codex turn. */
  agentSessionId: string | null;
  prompt: string;
  model: string;
  configDir: string;
  /** Unique, console-owned argv marker used for safe PID reattachment. */
  lastMessageFile: string;
  baseEnv: NodeJS.ProcessEnv;
  gate: WorkerGateEnv;
};

export type ProviderLaunchSpec = {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Present in `ps` from the moment of spawn, before Codex yields a thread id. */
  processIdentityToken: string;
  /** Claude knows this before spawn; Codex learns it from `thread.started`. */
  initialAgentSessionId: string | null;
};

export type ProviderSessionInput = {
  worktree: string;
  configDir: string;
  agentSessionId: string;
};

export type ProviderTerminalInput = ProviderSessionInput;

/**
 * Everything a detached coding-agent process does differently. The runner owns
 * process lifetime and files; an adapter owns only the vendor contract.
 */
export interface AgentProvider {
  readonly id: AgentProviderId;
  readonly label: string;
  /** Refuse before the console mutates state for a launch this profile cannot run. */
  assertReady(configDir: string): Promise<void>;
  start(input: ProviderLaunchInput): Promise<ProviderLaunchSpec>;
  resume(input: ProviderLaunchInput): Promise<ProviderLaunchSpec>;
  workflowPrompt(issue: number, mode: 'start' | 'resume'): string;
  sessionActivity(input: ProviderSessionInput): Promise<number | null>;
  terminalResumeCommand(input: ProviderTerminalInput): string;
}

export type AgentProviderRegistry = Record<AgentProviderId, AgentProvider>;
