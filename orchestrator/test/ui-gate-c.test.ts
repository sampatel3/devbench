/**
 * The two decisions gate C's card makes, tested without a browser.
 *
 * They are rules the operator stated, not styling: WHY Approve is locked, and whether the
 * summary reads as bullets or as the paragraph they refused to read. Each one is
 * wrong in a way a screenshot would not catch — a lock that reads "verify 0 more
 * steps", a label that swallows a worker's text.
 */
import { describe, it, expect } from 'vitest';
import { approveLockC, parseGateSummary } from '../../ui/src/gate-c.js';
import type { QaProgress } from '../../ui/src/types.js';

const progress = (total: number, verified: number, failed = 0): QaProgress => ({
  total,
  verified,
  failed,
  unset: total - verified - failed,
  complete: total > 0 && verified === total,
});

const lock = (over: Partial<Parameters<typeof approveLockC>[0]> = {}) =>
  approveLockC({
    progress: progress(6, 6),
    failedIds: [],
    hasQuiz: true,
    quizSubmitted: true,
    typed: false,
    ...over,
  });

describe('Approve at gate C is locked by BOTH halves', () => {
  /**
   * The operator considered basing approval on the QA alone, and reversed it in
   * the same conversation once the trade was named: the gate is blocked by both
   * the QA and comprehension. The framework's guarantee is that they do not ship
   * what they have not understood, and that survives this redesign.
   */
  it('unlocks only when every step is verified AND the quiz is submitted', () => {
    expect(lock().locked).toBe(false);
    expect(lock({ quizSubmitted: false }).locked).toBe(true);
    expect(lock({ progress: progress(6, 5) }).locked).toBe(true);
  });

  it('says WHY it is locked, in the button, one blocker at a time', () => {
    expect(lock({ progress: progress(6, 5) }).label).toBe('Verify 1 more step to approve');
    expect(lock({ progress: progress(6, 3) }).label).toBe('Verify 3 more steps to approve');
    expect(lock({ quizSubmitted: false }).label).toBe('Submit the quiz to approve');
    expect(lock({ hasQuiz: false, quizSubmitted: false }).label).toBe('No quiz yet — ask for it');
  });

  it('names the failed step, because that is the one they have to act on', () => {
    expect(lock({ progress: progress(6, 5, 1), failedIds: [4] }).label).toBe(
      'Step 4 failed — send it back or change your tick',
    );
    expect(lock({ progress: progress(6, 4, 2), failedIds: [4, 7] }).label).toBe('2 steps failed — send them back');
  });

  /** A failed step outranks an unset one: it is the tick they have a decision to make about. */
  it('reports the failure before the unset steps', () => {
    expect(lock({ progress: progress(6, 2, 1), failedIds: [3] }).label).toMatch(/^Step 3 failed/);
  });

  /**
   * Zero steps locking Approve is the loophole closed: a worker that emits an
   * empty `steps` array would otherwise skip the QA half of the gate entirely.
   */
  it('locks on a click-script with no steps, and says what to ask for', () => {
    expect(lock({ progress: progress(0, 0) })).toEqual({
      locked: true,
      label: 'No QA steps yet — ask for the click-script',
    });
    expect(lock({ progress: null }).locked).toBe(true);
  });

  /** A wrong answer is where the learning is. Only SKIPPING the quiz blocks. */
  it('never consults the score — a submitted quiz unlocks whatever they scored', () => {
    expect(lock({ quizSubmitted: true }).locked).toBe(false);
  });

  it('keeps the "your words ride with it" label when they have typed something', () => {
    expect(lock({ typed: true }).label).toBe('Approve with these answers');
    expect(lock({ typed: false }).label).toBe('Approve gate C');
  });

  /**
   * THE SHRINKING DENOMINATOR.
   *
   * A rework that comes back having dropped seven of nine steps leaves a card
   * whose own counts are true about the two steps that survived — "verify 1 more
   * step" — and Approve then goes green over a QA the worker chose the size of.
   * The console already computes the accusation; it just was not wired to the
   * button. `violation` is that wire, and it outranks everything except having no
   * script at all.
   */
  it('refuses to unlock while the last rework is under an accusation', () => {
    expect(lock({ violation: 'the rework came back without steps 2, 3' })).toEqual({
      locked: true,
      label: 'The rework came back short — read the note and send feedback',
    });
    // ...even when the surviving steps are all ticked and the quiz is in.
    expect(lock({ violation: 'the rework dropped 2 screenshots', progress: progress(2, 2) }).locked).toBe(true);
    expect(lock({ violation: null }).locked).toBe(false);
  });

  /**
   * The other way a denominator shrinks: the parsers drop what they cannot use.
   * A step with an empty `do` and a quiz question missing one option's `why` are
   * both invisible on the card, so the count of what was dropped is the only
   * thing that can stop the gate passing on a fraction of itself.
   */
  it('refuses to unlock when the click-script or the quiz came back malformed', () => {
    expect(lock({ droppedSteps: 1 })).toEqual({
      locked: true,
      label: '1 QA step came back malformed — ask for the click-script again',
    });
    expect(lock({ droppedSteps: 2 }).label).toBe('2 QA steps came back malformed — ask for the click-script again');
    expect(lock({ droppedQuestions: 1 })).toEqual({
      locked: true,
      label: '1 quiz question came back malformed — ask for the quiz again',
    });
    expect(lock({ droppedSteps: 0, droppedQuestions: 0 }).locked).toBe(false);
  });
});

describe('The summary reads as bullets, not as a paragraph', () => {
  const written = [
    'Did: drove the app headlessly on 5173 as sysadmin@shape.local',
    'Confirmed:',
    '- Withdraw is disabled once a quote has expired',
    '- The reason box refuses a blank reason',
    'Limits:',
    '- Nothing was checked on a phone',
    'Start: the seed script makes two orgs; use either',
  ].join('\n');

  it('splits the labelled groups into one-line bullets', () => {
    const s = parseGateSummary(written);
    expect(s.groups.map((g) => g.label)).toEqual([
      'What I did',
      'What I confirmed',
      'Honest limits',
      'Where to start',
    ]);
    expect(s.groups[1]!.items).toEqual([
      'Withdraw is disabled once a quote has expired',
      'The reason box refuses a blank reason',
    ]);
    expect(s.groups[0]!.items).toEqual(['drove the app headlessly on 5173 as sysadmin@shape.local']);
    expect(s.prose).toBeNull();
  });

  it('takes the labels however the worker spells them, and through markdown', () => {
    const s = parseGateSummary('**What I did:** ran it\n* Confirmed: it works\nWhere to start: the seed');
    expect(s.groups.map((g) => g.label)).toEqual(['What I did', 'What I confirmed', 'Where to start']);
    expect(s.groups[0]!.items).toEqual(['ran it']);
  });

  /**
   * The console cannot make a worker write bullets. What it must never do is
   * DELETE what the worker wrote — an essay is clamped by the card, and every
   * word of it is still there behind "more".
   */
  it('keeps a prose summary whole rather than dropping it', () => {
    const essay = 'I drove the app on localhost:5173 and confirmed a great many things, at length, in one block.';
    const s = parseGateSummary(essay);
    expect(s.groups).toEqual([]);
    expect(s.prose).toBe(essay);
  });

  it('keeps prose that arrives ABOVE the labels, rather than silently eating it', () => {
    const s = parseGateSummary('One preamble sentence.\nDid: ran it headlessly');
    expect(s.groups).toHaveLength(1);
    expect(s.prose).toBe('One preamble sentence.');
  });

  /** DEGRADED is the skill's own first line: the run itself was compromised. */
  it('lifts a DEGRADED line out, above everything else', () => {
    const s = parseGateSummary('DEGRADED: the dev server would not start\nDid: read the diff only');
    expect(s.degraded).toBe('the dev server would not start');
    expect(s.groups[0]!.items).toEqual(['read the diff only']);
  });

  it('does not turn an ordinary sentence with a colon into a heading', () => {
    const s = parseGateSummary('Note: the flag name did not change.');
    expect(s.groups).toEqual([]);
    expect(s.prose).toBe('Note: the flag name did not change.');
  });
});
