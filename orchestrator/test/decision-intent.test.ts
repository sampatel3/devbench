import { describe, it, expect } from 'vitest';
import { sentBackByTheConsole, saidInTheApproveBox, gatesPassedFor, type GateDecision } from '../src/decisions.js';
import { readsAsQuestion } from '../src/approval.js';
import {
  approvePrompt,
  askForMissingShotsPrompt,
  askForQuizPrompt,
  askForScriptPrompt,
  askForShotsPrompt,
} from '../../ui/src/gate.js';

/**
 * WHICH BUTTON WAS REALLY PRESSED — the two readings the console has to do for
 * itself, because the page's `decision` flag was wrong in both directions.
 *
 * Down: `/resume` defaults an absent `decision` to `approved`, so all four of
 * the console's "your gate C deliverable is incomplete" prompts went into the
 * ledger as approvals of the gate they were sent back from — 110 of them.
 *
 * Up: `approvePrompt` puts `Gate D approved, proceed.` in front of whatever is
 * in the textarea, so the #5402 guard was handed a message that always said yes
 * and never fired once. Two questions typed at gate D were recorded as approvals
 * and the ticket sat for a day on a checkpoint with gates A-D passed and no PR.
 */

describe('a send-back the console composed is never an approval', () => {
  /**
   * The four prompts live in `ui/src/gate.ts` and the classifier lives here; the
   * console's two halves share no code, so this is the drift guard — the same
   * rule `gate-c-evidence-reminder.test.ts` applies to the evidence reminder.
   * If a prompt is reworded out of its "this is NOT an approval" line, that
   * prompt starts writing approvals again and this fails first.
   */
  it('recognises every nag the gate C card can send', () => {
    expect(sentBackByTheConsole(askForQuizPrompt())).toBe(true);
    expect(sentBackByTheConsole(askForShotsPrompt())).toBe(true);
    expect(sentBackByTheConsole(askForScriptPrompt())).toBe(true);
    expect(sentBackByTheConsole(askForMissingShotsPrompt([{ id: 3, legs: ['after'] }]))).toBe(true);
  });

  it('says nothing about a real approval, with or without their answers', () => {
    expect(sentBackByTheConsole(approvePrompt('D', ''))).toBe(false);
    expect(sentBackByTheConsole(approvePrompt('D', 'the empty state reads well, ship it'))).toBe(false);
    expect(
      sentBackByTheConsole(
        'Gate C approved — I ran the manual QA myself, step by step, and I understand the change. Proceed.',
      ),
    ).toBe(false);
  });

  /**
   * Cased on purpose. `NOT` in capitals is the console's own convention for that
   * line; matching case-insensitively would start reading the operator's own
   * prose, and a classifier that guesses at English is the thing this must not
   * become.
   */
  it('reads the console`s capitals, not an ordinary sentence about approvals', () => {
    expect(sentBackByTheConsole('this is not an approval of the wider refactor, just of stage 4')).toBe(false);
    expect(sentBackByTheConsole('This is NOT an approval and NOT a change request about the code.')).toBe(true);
  });
});

describe('a question typed into the approve box', () => {
  /** #5402's own two messages, sent the way the page actually sends them. */
  const asked = [
    'can you confirm that the expected result is for the previous dev signature to appear as a broken image?',
    "I still don't understand what changed, I still see the broken image for the dev signature - is this intentional?",
  ];

  it('is still a question once the page`s canned line is taken back off', () => {
    for (const question of asked) {
      // What the guard used to be handed, and why it never fired: the page's own
      // `approved` and `proceed` are in the bytes before the operator's first word.
      expect(readsAsQuestion(approvePrompt('D', question))).toBe(false);
      expect(readsAsQuestion(saidInTheApproveBox('D', approvePrompt('D', question)))).toBe(true);
    }
  });

  it('leaves an approval an approval — an empty box says yes and nothing else', () => {
    expect(saidInTheApproveBox('D', approvePrompt('D', ''))).toBe('');
    expect(readsAsQuestion(saidInTheApproveBox('D', approvePrompt('D', '')))).toBe(false);
  });

  it('lets a yes with a question attached through, which is an ordinary thing to send', () => {
    const said = approvePrompt('B', 'Approved, but why did you do it that way?');
    expect(readsAsQuestion(saidInTheApproveBox('B', said))).toBe(false);
  });

  /**
   * Gate C's approval is a DIFFERENT canned line (`approvalLineC`) and it
   * carries the graded quiz, which is nothing but question marks. It is machine
   * written and its own words say yes, so it is deliberately left whole.
   */
  it('does not strip gate C`s approval, which says yes in its own words', () => {
    const composed =
      'Gate C approved — I ran the manual QA myself, step by step, and I understand the change. Proceed.\n\n' +
      'Quiz record (3/3):\n1. right — What is stored on the broker record?';
    expect(saidInTheApproveBox('C', composed)).toBe(composed);
    expect(readsAsQuestion(saidInTheApproveBox('C', composed))).toBe(false);
  });

  it('only ever removes that one line, and only from the front', () => {
    // A message that merely mentions the line keeps every byte it had.
    const quoting = 'you sent "Gate A approved, proceed." last time — was that meant for this gate?';
    expect(saidInTheApproveBox('A', quoting)).toBe(quoting);
  });
});

/**
 * The other half of the same fix. A gate history round carries the operator's
 * words and nothing that says which way they went, so a round that was SENT
 * BACK ticked the gate the moment it was recorded — and the console now records
 * the round itself, at the decision, which would have made that tick immediate.
 */
describe('a round the console sent back does not tick the gate', () => {
  const decided = (gate: 'C' | 'D', decision: 'approved' | 'feedback', message: string): GateDecision => ({
    issue: 4344,
    gate,
    decision,
    message,
    at: '2026-09-01T09:05:00Z',
    sessionId: 'sess-1',
    account: 'personal',
  });
  const nag = 'Gate C is missing the comprehension quiz — this is NOT an approval';

  it('skips the history round whose words are a recorded send-back', () => {
    expect(gatesPassedFor([decided('C', 'feedback', nag)], 4344, [{ gate: 'C', decision: nag }])).toEqual([]);
  });

  it('still counts the same gate once they really approve it', () => {
    const decisions = [decided('C', 'feedback', nag), decided('C', 'approved', 'Gate C approved, proceed.')];
    const history = [
      { gate: 'C' as const, decision: nag },
      { gate: 'C' as const, decision: 'Gate C approved, proceed.' },
    ];
    expect(gatesPassedFor(decisions, 4344, history)).toEqual(['C']);
  });

  /** The ~25 decisions made before the ledger existed still stand on the worker's
   *  record alone — that is the whole reason history is read here at all. */
  it('leaves a pre-ledger round exactly as it was', () => {
    expect(gatesPassedFor([], 4344, [{ gate: 'D', decision: 'Gate D approved, proceed.' }])).toEqual(['D']);
  });
});
