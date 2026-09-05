import { configDirEnv } from '../accounts.js';
import type { WorkerGateEnv } from './types.js';

/**
 * A worker launched from inside another coding-agent process must not inherit
 * that host's session or authentication. Strip both vendors first, then add
 * only the selected profile boundary.
 */
export function cleanWorkerEnv(
  base: NodeJS.ProcessEnv,
  sessionId: string,
  gate?: WorkerGateEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (
      key.startsWith('CLAUDE') ||
      key.startsWith('ANTHROPIC') ||
      key.startsWith('CODEX') ||
      key.startsWith('OPENAI') ||
      key.startsWith('CHATGPT') ||
      key === 'AI_AGENT' ||
      key === 'BAGGAGE'
    ) {
      continue;
    }
    env[key] = value;
  }
  env.WORKER_SESSION_ID = sessionId;
  if (gate) {
    env.WORKER_ISSUE = String(gate.issue);
    env.WORKER_DECISIONS_FILE = gate.decisionsFile;
  }
  return env;
}

export function claudeWorkerEnv(input: {
  base: NodeJS.ProcessEnv;
  sessionId: string;
  configDir: string;
  canonicalConfigDir: string;
  gate?: WorkerGateEnv;
}): NodeJS.ProcessEnv {
  const env = cleanWorkerEnv(input.base, input.sessionId, input.gate);
  const selected = configDirEnv(input.configDir, input.canonicalConfigDir);
  if (selected) env.CLAUDE_CONFIG_DIR = selected;
  env.WORKER_PROVIDER = 'claude';
  return env;
}

export function codexWorkerEnv(input: {
  base: NodeJS.ProcessEnv;
  sessionId: string;
  configDir: string;
  gate?: WorkerGateEnv;
}): NodeJS.ProcessEnv {
  const env = cleanWorkerEnv(input.base, input.sessionId, input.gate);
  env.CODEX_HOME = input.configDir;
  env.WORKER_PROVIDER = 'codex';
  return env;
}
