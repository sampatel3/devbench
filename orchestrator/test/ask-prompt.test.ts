/**
 * What "Ask a question" actually sends to a worker parked at a gate.
 *
 * The failure this file is written against is the one that has already happened
 * once on this console, in gate.ts: a message the operator sent at a gate was
 * READ AS A DECISION. There it was an approval that silently dropped their
 * words; here it would be worse — a question read as an approval passes a gate
 * nobody passed, and the worker builds on it.
 *
 * So the composition is a pure function with tested string properties, not a
 * template someone eyeballs: the sentinel leads, the approval phrase can never
 * appear, the stop instruction is explicit, and the operator's words go through
 * byte for byte exactly as `approvePrompt` sends them.
 */
import { describe, it, expect } from 'vitest';
import { askPrompt, type GateThreadEntry } from '../src/ask.js';
import type { GateLetter } from '../src/types.js';

const GATES: GateLetter[] = ['A', 'B', 'C', 'D', 'E'];

function open(id: number, question: string): GateThreadEntry {
  return { id, question, askedAt: '2026-08-12T10:00:00.000Z', answer: null, answeredAt: null, supersededAt: null };
}

function answered(id: number, question: string, answer: string): GateThreadEntry {
  return {
    id,
    question,
    askedAt: '2026-08-12T09:00:00.000Z',
    answer,
    answeredAt: '2026-08-12T09:05:00.000Z',
    supersededAt: null,
  };
}

describe('the ask prompt', () => {
  it('leads with the sentinel, on its own first line', () => {
    const out = askPrompt('C', [open(1, 'What does a non-sysadmin see now?')], []);
    expect(out.split('\n')[0]).toBe('GATE C QUESTION — NOT A DECISION');
  });

  it('never contains the approval phrase, at any gate — the charge-past defence', () => {
    for (const g of GATES) {
      const out = askPrompt(g, [open(1, 'Which table does this read?')], []);
      expect(out).not.toContain(`Gate ${g} approved, proceed.`);
      // Not merely the exact phrase: the worker's own rule is to look for the
      // WORD, so the word must not be in the scaffolding at all.
      expect(out.toLowerCase()).not.toContain('approved');
      expect(out).toContain(`Gate ${g} is still OPEN`);
      expect(out).toContain('does not pass the gate');
    }
  });

  it('passes the operator’s words through verbatim — no summarising, no reformatting', () => {
    const awkward = 'Why `useOrgFilter`?\n\n- point one\n- point two\n\nAnd: "what breaks if I say no"?';
    const out = askPrompt('B', [open(1, awkward)], []);
    expect(out).toContain(awkward);
  });

  it('carries every open question, numbered by its own id', () => {
    const out = askPrompt('C', [open(1, 'first question'), open(2, 'second question')], []);
    expect(out).toContain('1. first question');
    expect(out).toContain('2. second question');
    expect(out).toMatch(/The questions/);
  });

  it('says "question" in the singular when there is one', () => {
    expect(askPrompt('C', [open(1, 'only one')], [])).toMatch(/The question:/);
  });

  it('embeds the prior answered exchange as verbatim JSON, so the thread reaches history', () => {
    const out = askPrompt('C', [open(2, 'and what about NULL roles?')], [answered(1, 'which table?', 'org_members')]);
    expect(out).toContain('"id": 1');
    expect(out).toContain('"q": "which table?"');
    expect(out).toContain('"a": "org_members"');
  });

  it('says the prior thread is empty rather than leaving a dangling instruction', () => {
    const out = askPrompt('C', [open(1, 'q')], []);
    expect(out).toContain('[]');
  });

  /**
   * An ask makes the worker rewrite `.gate.json` WHOLE. Everything gate C holds
   * has to be named in that instruction or the first question the operator asks
   * silently destroys it — and with the step ids and revisions goes every tick
   * already set by hand, which is verification a person did, thrown away by a
   * question.
   */
  it('names the quiz and the step ids the ticks hang on, so asking destroys neither', () => {
    const out = askPrompt('C', [open(1, 'q')], []);
    expect(out).toContain('"manualQa"');
    expect(out).toContain('"quiz"');
    expect(out).toContain('SAME "id"');
    expect(out).toContain('SAME "rev"');
    expect(out).toContain('ticks');
  });

  it('tells the worker to re-park at the SAME gate and stop', () => {
    const out = askPrompt('C', [open(1, 'q')], []);
    expect(out).toContain('"gate": "C"');
    expect(out).toContain('same');
    expect(out).toContain('Do NOT proceed');
    expect(out).toContain('.gate-history.jsonl');
    expect(out).toContain('thread');
  });

  it('is the same shape at every gate', () => {
    for (const g of GATES) {
      expect(askPrompt(g, [open(1, 'q')], []).split('\n')[0]).toBe(`GATE ${g} QUESTION — NOT A DECISION`);
    }
  });
});
