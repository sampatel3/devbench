import { describe, it, expect } from 'vitest';
import { readsAsQuestion, questionNotApprovalRefusal } from '../src/approval.js';

/**
 * The #5402 class: a question typed into the approval box, recorded as an
 * approval, answered by the worker, and left stranded between the two readings.
 *
 * The tests that matter are the false-positive ones. Refusing a real approval
 * stalls work; letting a question through is recoverable with `reopenGate`. So
 * anything that says yes must go through, whatever else it says.
 */
describe('readsAsQuestion — catches the real thing', () => {
  it('catches the two messages that actually did this to #5402', () => {
    expect(
      readsAsQuestion(
        'can you confirm that the expected result is for the previous dev signature to appear as a broken image?',
      ),
    ).toBe(true);
    expect(
      readsAsQuestion(
        "I still don't understand what changed, I still see the broken image for the dev signature - is this " +
          'intentional?\nI attached a screenshot at docs/issue-pipeline/plans/attachments/20260902-0555-screenshot.png',
      ),
    ).toBe(true);
  });

  it('is not fooled by `ok` inside `broken` or `yes` inside `eyes`', () => {
    expect(readsAsQuestion('is the image still broken?')).toBe(true);
    expect(readsAsQuestion('does it hurt your eyes?')).toBe(true);
  });
});

describe('readsAsQuestion — never refuses an approval', () => {
  it('lets a plain approval through', () => {
    expect(readsAsQuestion('Gate D approved, proceed.')).toBe(false);
    expect(readsAsQuestion('approved')).toBe(false);
  });

  it('lets an approval WITH a question attached through — an ordinary thing to send', () => {
    expect(readsAsQuestion('Approved, but why did you do it that way?')).toBe(false);
    expect(readsAsQuestion('Proceed. Also, did you check the mobile layout?')).toBe(false);
    expect(readsAsQuestion('lgtm — one thing, is the flag on by default?')).toBe(false);
    expect(readsAsQuestion('yes, go ahead. what about #4109?')).toBe(false);
  });

  it('lets the console`s own composed gate C approval through', () => {
    // The real shape: it carries the quiz, which is full of question marks.
    const composed =
      'Gate C approved — I ran the manual QA myself, step by step, and I understand the change. Proceed.\n\n' +
      'Quiz record (3/3):\n1. right — What is stored on the broker record?\n2. right — Which env serves it?';
    expect(readsAsQuestion(composed)).toBe(false);
  });

  it('says nothing about a message with no question in it at all', () => {
    expect(readsAsQuestion('This is wrong, the totals do not reconcile. Redo stage 4.')).toBe(false);
    expect(readsAsQuestion('')).toBe(false);
    expect(readsAsQuestion('   ')).toBe(false);
  });
});

describe('the refusal', () => {
  it('names Ask, names the gate, and names the word that would make it an approval', () => {
    const said = questionNotApprovalRefusal('D');
    expect(said).toContain('Ask');
    expect(said).toContain('gate D');
    expect(said).toMatch(/approved/);
    // It must say plainly that nothing happened.
    expect(said).toContain('nothing was sent');
  });
});
