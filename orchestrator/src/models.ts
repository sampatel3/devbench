/**
 * Which model a worker runs. The point of this file is that the choice is
 * VISIBLE and DELIBERATE — the console used to hard-wire one model into every
 * spawn, so nobody ever made the decision at all.
 *
 * The list below is the single source of truth for what the pickers offer. It is
 * NOT a whitelist: an id that is not here still runs. `WORKER_MODEL` may name a
 * model this build has never heard of, and a console that refused it would be a
 * console that cannot follow a rename. Unknown ids pass straight through to
 * `claude --model` and are shown as themselves.
 */

import type { AgentProviderId } from './providers/types.js';

export type KnownModel = {
  provider: AgentProviderId;
  id: string;
  label: string;
  /** Plain English: when you would pick this one. */
  when: string;
};

export const CLAUDE_MODELS: KnownModel[] = [
  {
    provider: 'claude',
    id: 'claude-opus-5',
    label: 'Opus 5',
    when: 'The default. Work where being wrong is expensive: the plan sweeps, the build, anything that a rework round would punish.',
  },
  {
    provider: 'claude',
    id: 'claude-fable-5',
    label: 'Fable 5',
    when: 'Writing-heavy stages — the scope at gate A, the walkthrough at gate C, the PR body at gate D.',
  },
  {
    provider: 'claude',
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    when: 'A change that is already well specified: the plan is approved and the work is mostly typing it out.',
  },
  {
    provider: 'claude',
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    when: 'Small mechanical edits, and dry runs of the machinery where you do not need it to think.',
  },
];

export const CODEX_MODELS: KnownModel[] = [
  {
    provider: 'codex',
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6-Sol',
    when: 'The Codex default. The strongest choice for difficult implementation, debugging, and high-consequence repository work.',
  },
  {
    provider: 'codex',
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6-Terra',
    when: 'Balanced agentic coding for well-scoped everyday changes where speed and reliable execution both matter.',
  },
  {
    provider: 'codex',
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6-Luna',
    when: 'Fast, economical work such as mechanical edits, routine checks, and tightly specified small changes.',
  },
  {
    provider: 'codex',
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    when: 'Complex coding and research work that benefits from a proven frontier model from the previous generation.',
  },
  {
    provider: 'codex',
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    when: 'General coding tasks that do not require the newest Codex reasoning and implementation capabilities.',
  },
  {
    provider: 'codex',
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4-Mini',
    when: 'Small, fast, cost-efficient work such as simpler coding tasks, targeted edits, and routine repository operations.',
  },
  {
    provider: 'codex',
    id: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3-Codex-Spark',
    when: 'Ultra-fast coding work where latency matters more than using the newest general-purpose reasoning model.',
  },
];

/** Legacy name: callers which have not selected a provider still get Claude. */
export const MODELS = CLAUDE_MODELS;
export const ALL_MODELS: KnownModel[] = [...CLAUDE_MODELS, ...CODEX_MODELS];
export const MODELS_BY_PROVIDER: Record<AgentProviderId, KnownModel[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
};

/** What each provider spawns with when nothing anywhere says otherwise. */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
export const DEFAULT_MODELS: Record<AgentProviderId, string> = {
  claude: DEFAULT_CLAUDE_MODEL,
  codex: DEFAULT_CODEX_MODEL,
};
/** Legacy default for providerless configuration. */
export const DEFAULT_MODEL = DEFAULT_CLAUDE_MODEL;

export function modelsForProvider(provider: AgentProviderId): KnownModel[] {
  return MODELS_BY_PROVIDER[provider];
}

export function defaultModelFor(provider: AgentProviderId): string {
  return DEFAULT_MODELS[provider];
}

export function isKnownModel(id: string, provider?: AgentProviderId): boolean {
  const models = provider ? modelsForProvider(provider) : ALL_MODELS;
  return models.some((m) => m.id === id);
}

/** A model's short name, or the raw id for one this build does not know. */
export function modelLabel(id: string, provider?: AgentProviderId): string {
  const models = provider ? modelsForProvider(provider) : ALL_MODELS;
  return models.find((m) => m.id === id)?.label ?? id;
}

/**
 * The precedence chain, most specific first:
 *
 *   the picker on this preflight  →  what this issue is stamped with
 *     →  the account's own default  →  the console's default (`WORKER_MODEL`)
 *
 * Exactly the shape the account choice already has, so there is one rule to
 * learn rather than two.
 */
export function resolveModel(levels: {
  /** the picker's choice, held until the worker actually spawns */
  pending?: string | null;
  /** stamped on the issue at spawn */
  issue?: string | null;
  /** the account's default, from accounts.json */
  account?: string | null;
  /** config.workerModel — always a string, so this function always answers */
  fallback: string;
}): string {
  const first = [levels.pending, levels.issue, levels.account].find((v) => typeof v === 'string' && v.trim());
  return (first ?? levels.fallback).trim();
}

/**
 * The list the pickers show: the known models, plus whatever is actually in
 * force if that is not one of them — so a custom `WORKER_MODEL`, or an account
 * pinned to an old id, is still selectable rather than silently missing.
 */
export function pickableModelsFor(
  provider: AgentProviderId,
  ...inUse: Array<string | null | undefined>
): KnownModel[] {
  const known = modelsForProvider(provider);
  const extra = inUse
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim())
    .filter((id) => !isKnownModel(id, provider))
    .filter((id, i, all) => all.indexOf(id) === i)
    .map((id) => ({
      provider,
      id,
      label: id,
      when: 'Not one of the models this console knows about — it is passed through as it is.',
    }));
  return [...known, ...extra];
}

/** Legacy picker: providerless callers retain the original Claude-only menu. */
export function pickableModels(...inUse: Array<string | null | undefined>): KnownModel[] {
  return pickableModelsFor('claude', ...inUse);
}
