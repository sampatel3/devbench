import { describe, it, expect } from 'vitest';
import {
  ALL_MODELS,
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_MODEL,
  DEFAULT_MODELS,
  MODELS,
  MODELS_BY_PROVIDER,
  defaultModelFor,
  isKnownModel,
  modelLabel,
  modelsForProvider,
  pickableModels,
  pickableModelsFor,
  resolveModel,
} from '../src/models.js';

/**
 * The model list and the precedence chain. The chain is deliberately the same
 * shape as the account chain — one rule to learn, not two — and the list is a
 * menu, never a whitelist.
 */

describe('the known models', () => {
  it('are the four, with the default first and a line each on when to pick it', () => {
    expect(MODELS.map((m) => m.id)).toEqual([
      'claude-opus-5',
      'claude-fable-5',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ]);
    expect(MODELS[0]!.id).toBe(DEFAULT_MODEL);
    for (const m of MODELS) expect(m.when.length).toBeGreaterThan(20);
  });

  it('names an unknown id as itself rather than inventing a label for it', () => {
    expect(modelLabel('claude-opus-5')).toBe('Opus 5');
    expect(modelLabel('claude-from-the-future')).toBe('claude-from-the-future');
    expect(isKnownModel('claude-from-the-future')).toBe(false);
  });

  it('scopes the current Codex catalog and default separately from Claude', () => {
    expect(CODEX_MODELS.map((m) => m.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ]);
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(DEFAULT_MODELS).toEqual({ claude: DEFAULT_MODEL, codex: DEFAULT_CODEX_MODEL });
    expect(defaultModelFor('claude')).toBe(DEFAULT_MODEL);
    expect(defaultModelFor('codex')).toBe(DEFAULT_CODEX_MODEL);
    expect(modelsForProvider('claude')).toBe(MODELS);
    expect(modelsForProvider('codex')).toBe(CODEX_MODELS);
    expect(MODELS_BY_PROVIDER.codex).toBe(CODEX_MODELS);
    expect(ALL_MODELS).toHaveLength(MODELS.length + CODEX_MODELS.length);
    expect(ALL_MODELS.every((m) => m.provider === 'claude' || m.provider === 'codex')).toBe(true);
    expect(isKnownModel('gpt-5.6-sol', 'codex')).toBe(true);
    expect(isKnownModel('gpt-5.6-sol', 'claude')).toBe(false);
    expect(modelLabel('gpt-5.6-sol', 'codex')).toBe('GPT-5.6-Sol');
  });
});

describe('resolveModel — the precedence chain', () => {
  const all = {
    pending: 'claude-haiku-4-5-20251001',
    issue: 'claude-sonnet-5',
    account: 'claude-fable-5',
    fallback: 'claude-opus-5',
  };

  it('takes the picker on this preflight first', () => {
    expect(resolveModel(all)).toBe('claude-haiku-4-5-20251001');
  });

  it('then what the issue is stamped with', () => {
    expect(resolveModel({ ...all, pending: null })).toBe('claude-sonnet-5');
  });

  it('then the account default', () => {
    expect(resolveModel({ ...all, pending: null, issue: null })).toBe('claude-fable-5');
  });

  it('and finally the console default', () => {
    expect(resolveModel({ ...all, pending: null, issue: null, account: null })).toBe('claude-opus-5');
  });

  it('treats an empty or blank level as absent rather than as a choice', () => {
    expect(resolveModel({ pending: '', issue: '  ', account: null, fallback: 'claude-opus-5' })).toBe('claude-opus-5');
  });

  it('always answers, so a worker can always be spawned', () => {
    expect(resolveModel({ fallback: 'claude-opus-5' })).toBe('claude-opus-5');
  });

  it('passes an unknown id through — the list is a menu, not a whitelist', () => {
    expect(resolveModel({ pending: 'claude-something-unreleased', fallback: 'claude-opus-5' })).toBe(
      'claude-something-unreleased',
    );
  });
});

describe('pickableModels', () => {
  it('is the known list when nothing unusual is in force', () => {
    expect(pickableModels('claude-opus-5', null, undefined).map((m) => m.id)).toEqual(MODELS.map((m) => m.id));
  });

  it('adds an id actually in force that the list does not have, once', () => {
    const ids = pickableModels('claude-custom', 'claude-custom', 'claude-sonnet-5').map((m) => m.id);
    expect(ids.filter((id) => id === 'claude-custom')).toHaveLength(1);
    expect(ids).toHaveLength(MODELS.length + 1);
    // Otherwise a machine with WORKER_MODEL set to something unusual would show a
    // picker that cannot select what it is already running.
  });

  it('adds provider-local custom ids without leaking the other provider catalog', () => {
    const ids = pickableModelsFor('codex', 'codex-custom', 'codex-custom').map((m) => m.id);
    expect(ids.slice(0, CODEX_MODELS.length)).toEqual(CODEX_MODELS.map((m) => m.id));
    expect(ids.filter((id) => id === 'codex-custom')).toHaveLength(1);
    expect(ids).not.toContain('claude-opus-5');
  });
});
