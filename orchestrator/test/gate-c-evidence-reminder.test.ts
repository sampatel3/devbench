/**
 * The standing evidence reminder at gate C.
 *
 * The before and after screenshots had to be asked for again at every round, and
 * all of the evidence has to be displayed rather than referenced. The skill says
 * it once; a worker three rounds into a gate is following the message in front
 * of it. So every message that sends a worker back to gate C ends with the same
 * block, and these are the properties that make that worth anything:
 *
 *  - the two copies of the words — server-side and UI-side — are byte-identical,
 *    because the console's halves share no code and a drifted reminder is two
 *    different rules;
 *  - it names BOTH legs and it names `evidence`, which are the two things the
 *    operator has had to repeat;
 *  - it never contains the approval word, so no gate C message can be misread as
 *    a decision — the same defence `ask-prompt.test.ts` and
 *    `rework-prompt.test.ts` already hold;
 *  - it rides gate C and nothing else: an ask at gate A has no evidence box and
 *    must not be handed gate C's checklist.
 */
import { describe, it, expect } from 'vitest';
import { EVIDENCE_REMINDER as UI_REMINDER, feedbackCPrompt, askForQuizPrompt, askForScriptPrompt, askForShotsPrompt } from '../../ui/src/gate.js';
import { EVIDENCE_REMINDER, withEvidenceReminder } from '../src/evidence-reminder.js';
import { askPrompt, type GateThreadEntry } from '../src/ask.js';
import { PRIOR_EVIDENCE_MARK, reworkPrompt, type QaSnapshot } from '../src/rework.js';
import { parseEvidence } from '../src/evidence.js';
import { parseManualQa } from '../src/manual-qa.js';
import type { GateLetter } from '../src/types.js';

const GATES: GateLetter[] = ['A', 'B', 'C', 'D', 'E'];

const open = (id: number, question: string): GateThreadEntry => ({
  id,
  question,
  askedAt: '2026-08-25T10:00:00.000Z',
  answer: null,
  answeredAt: null,
  supersededAt: null,
});

const snapshot = (): QaSnapshot => ({
  takenAt: '2026-08-25T10:00:00.000Z',
  stoppedAt: '2026-08-25T09:00:00.000Z',
  gateHash: null,
  evidence: parseEvidence([
    { kind: 'screenshot', path: 'docs/issue-pipeline/plans/qa-4404/s1-after.png', caption: 'step 1 — asks first' },
  ]),
  evidenceStamps: {},
  manualQa: parseManualQa({
    appUrl: 'http://localhost:8106',
    steps: [{ id: 1, rev: 1, do: 'Withdraw a sent quote', before: 'no warning', after: 'a confirm dialog asks first' }],
  })!,
});

const failed = [{ id: 1, rev: 1, do: 'Withdraw a sent quote', note: 'no dialog appeared' }];

describe('the gate C evidence reminder', () => {
  it('is the same words on both sides of the console', () => {
    // Two copies exist because `rootDir` is `src` here and the UI builds through
    // Vite. Two DIFFERENT copies would be two rules.
    expect(EVIDENCE_REMINDER).toBe(UI_REMINDER);
  });

  it('names both legs, and names where evidence has to be listed to be shown', () => {
    expect(EVIDENCE_REMINDER).toContain('beforeShot');
    expect(EVIDENCE_REMINDER).toContain('afterShot');
    expect(EVIDENCE_REMINDER).toMatch(/WAS shot/);
    expect(EVIDENCE_REMINDER).toMatch(/AFTER shot/);
    expect(EVIDENCE_REMINDER).toContain('"evidence"');
    expect(EVIDENCE_REMINDER).toContain('not displayed does');
  });

  it('says it applies to every stop, not just the first', () => {
    expect(EVIDENCE_REMINDER).toContain('EVERY TIME YOU STOP AT GATE C');
    expect(EVIDENCE_REMINDER).toContain('NOT ONLY THE FIRST TIME');
  });

  it('never contains the approval word — no gate C message may read as a decision', () => {
    expect(EVIDENCE_REMINDER.toLowerCase()).not.toContain('approved');
  });

  it('goes last, under whatever the message itself said', () => {
    const out = withEvidenceReminder('Words from the operator, first.');
    expect(out.startsWith('Words from the operator, first.')).toBe(true);
    expect(out.endsWith(EVIDENCE_REMINDER)).toBe(true);
  });
});

describe('every message that sends a worker back to gate C carries it', () => {
  it('the ask, at gate C', () => {
    expect(askPrompt('C', [open(1, 'What does a non-sysadmin see now?')], [])).toContain(EVIDENCE_REMINDER);
  });

  it('and at no other gate — the other gates have no evidence box', () => {
    for (const g of GATES.filter((g) => g !== 'C')) {
      expect(askPrompt(g, [open(1, 'q')], [])).not.toContain(EVIDENCE_REMINDER);
    }
  });

  it('the targeted rework — ahead of the payload, so it is readable', () => {
    const out = reworkPrompt(failed, snapshot());
    expect(out).toContain(EVIDENCE_REMINDER);
    // The JSON has to stay the last thing in the message: the tail is parsed,
    // and a standing rule buried under two blobs of JSON is a rule nobody reads.
    expect(out.indexOf(EVIDENCE_REMINDER)).toBeLessThan(out.indexOf(PRIOR_EVIDENCE_MARK));
  });

  it('the three "you did not attach it" prompts', () => {
    expect(askForShotsPrompt()).toContain(EVIDENCE_REMINDER);
    expect(askForScriptPrompt()).toContain(EVIDENCE_REMINDER);
    expect(askForQuizPrompt()).toContain(EVIDENCE_REMINDER);
  });

  it('feedback sent from the gate C card, with the operator’s words still leading', () => {
    const said = 'step 3 shows the after but there is no before — where is it?';
    const out = feedbackCPrompt(`  ${said}  `);
    expect(out.startsWith(said)).toBe(true);
    expect(out).toContain(EVIDENCE_REMINDER);
  });

  it('but an empty feedback box still sends nothing — the reminder is not a message', () => {
    // `Send feedback` is disabled on an empty box; if that ever slips, a bare
    // reminder arriving on its own would read as an instruction to redo the QA.
    expect(feedbackCPrompt('   ')).toBe('');
  });
});
