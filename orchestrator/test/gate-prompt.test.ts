/**
 * What the gate card's two buttons actually send.
 *
 * This file exists because of a real, silent loss. "Approve gate A" sent only
 * `Gate A approved, proceed.` and ignored the textarea entirely: the operator
 * typed three numbered answers, pressed Approve, and all three went nowhere.
 * The worker recorded that gate A had been approved "with no
 * explicit answers, so I took all three of my recommendations" — and one of
 * those was broader than the issue asked for.
 *
 * The composition is client-side, but it is the payload that reaches a real
 * worker, so it is tested here rather than eyeballed.
 */
import { describe, it, expect } from 'vitest';
import { approvalLine, approvePrompt, feedbackPrompt } from '../../ui/src/gate.js';

const TYPED_WORDS = '1. option A 2. option A 3 dev only';

describe('Approve', () => {
  it('sends exactly the canned line when the box is empty', () => {
    expect(approvePrompt('A', '')).toBe('Gate A approved, proceed.');
    expect(approvePrompt('C', '   \n  ')).toBe('Gate C approved, proceed.');
  });

  it('sends the approval AND the typed answers when there are some — the bug', () => {
    const out = approvePrompt('A', TYPED_WORDS);
    expect(out).toContain(approvalLine('A'));
    expect(out).toContain(TYPED_WORDS);
    expect(out).toBe(`Gate A approved, proceed.\n\n${TYPED_WORDS}`);
  });

  it('passes the operator’s words through verbatim — no summarising, no reformatting', () => {
    const awkward = 'Do NOT touch `useOrgFilter`.\n\n- point one\n- point two\n\nAnd: "keep the flag name".';
    expect(approvePrompt('B', awkward)).toBe(`Gate B approved, proceed.\n\n${awkward}`);
  });

  it('is the same rule at every gate', () => {
    for (const g of ['A', 'B', 'C', 'D', 'E'] as const) {
      expect(approvePrompt(g, 'x')).toBe(`Gate ${g} approved, proceed.\n\nx`);
    }
  });
});

describe('Send feedback', () => {
  it('sends the operator’s words and nothing else — no approval is manufactured', () => {
    expect(feedbackPrompt(TYPED_WORDS)).toBe(TYPED_WORDS);
    expect(feedbackPrompt(TYPED_WORDS)).not.toContain('approved');
  });

  it('trims the surrounding whitespace and nothing inside it', () => {
    expect(feedbackPrompt('  line one\n\nline two  ')).toBe('line one\n\nline two');
  });
});
