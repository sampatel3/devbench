/**
 * The comprehension quiz, parsed.
 *
 * The operator's rule for it is short and it decides every case here: the gate is blocked
 * by SUBMISSION, never by score. So the parser's only real job is to make sure a
 * question that reaches the card can be answered and graded honestly — and to
 * return null, loudly, when there is nothing usable, because a quiz that was
 * never offered must never read as a half that was passed.
 *
 * The sharp edge is `correct`, which is an INDEX. Anything that renumbers the
 * options underneath it turns a typo into a confidently wrong lesson, so a bad
 * option voids its whole question rather than being dropped on its own.
 */
import { describe, it, expect } from 'vitest';
import { parseQuiz, quizKey } from '../src/quiz.js';

const GOOD = {
  brief: ['Withdraw now asks before it changes the quote', 'A withdrawn quote cannot be accepted'],
  questions: [
    {
      context: 'A withdrawn quote is meant to be terminal — no further action on it.',
      question: 'What happens if a broker tries to accept a withdrawn quote?',
      options: [
        { text: 'Nothing — Accept is no longer offered', why: 'Withdrawn is terminal, so the action is gone.' },
        { text: 'It accepts and reopens the quote', why: 'That was the bug; step 2 shows it is gone.' },
        { text: 'It errors with a 500', why: 'Nothing throws — the control is simply not there.' },
      ],
      correct: 0,
    },
  ],
};

describe('parseQuiz', () => {
  it('keeps a well-formed quiz whole, answer key and all', () => {
    const q = parseQuiz(GOOD)!;
    expect(q.brief).toHaveLength(2);
    expect(q.questions).toHaveLength(1);
    expect(q.questions[0]!.correct).toBe(0);
    expect(q.questions[0]!.options).toHaveLength(3);
    // Every option's reasoning ships to the page — that is what makes grading
    // instant and free, and it is deliberate: the score has no authority.
    expect(q.questions[0]!.options[1]!.why).toContain('step 2');
  });

  it('returns null when there is no usable question — the gate must not pass a half nobody was offered', () => {
    expect(parseQuiz(undefined)).toBeNull();
    expect(parseQuiz(null)).toBeNull();
    expect(parseQuiz('a quiz')).toBeNull();
    expect(parseQuiz([])).toBeNull();
    expect(parseQuiz({})).toBeNull();
    expect(parseQuiz({ questions: [] })).toBeNull();
    expect(parseQuiz({ questions: ['not an object'] })).toBeNull();
  });

  it('VOIDS a whole question when one option is malformed — never renumbers the answer key', () => {
    const q = parseQuiz({
      questions: [
        { question: 'ok?', options: [{ text: 'a', why: 'x' }, { text: 'b' }], correct: 1 },
        GOOD.questions[0],
      ],
    })!;
    // The broken one is gone; dropping just option B would have made `correct: 1`
    // point at a different answer than the author meant.
    expect(q.questions).toHaveLength(1);
    expect(q.questions[0]!.question).toContain('broker');
  });

  /**
   * A voided question that nobody counts is the worst shape this can take. The
   * question most likely to be malformed is the "honest limits" one — the one
   * that states what the gate does NOT prove — and if it vanishes, the operator takes a
   * two-question quiz, scores 2/2, and neither they nor the worker ever learns a
   * third question was written.
   */
  it('counts the questions it had to void, so a vanished question is never silent', () => {
    const q = parseQuiz({
      questions: [
        GOOD.questions[0],
        { question: 'ok?', options: [{ text: 'a', why: 'x' }, { text: 'b' }], correct: 1 },
        { question: 'also broken?', options: [{ text: 'a', why: 'x' }], correct: 0 },
      ],
    })!;
    expect(q.questions).toHaveLength(1);
    expect(q.dropped).toBe(2);
    expect(parseQuiz(GOOD)!.dropped).toBe(0);
  });

  it('refuses an answer key that points nowhere', () => {
    const two = [{ text: 'a', why: 'x' }, { text: 'b', why: 'y' }];
    expect(parseQuiz({ questions: [{ question: 'q?', options: two, correct: 2 }] })).toBeNull();
    expect(parseQuiz({ questions: [{ question: 'q?', options: two, correct: -1 }] })).toBeNull();
    expect(parseQuiz({ questions: [{ question: 'q?', options: two, correct: 1.5 }] })).toBeNull();
    expect(parseQuiz({ questions: [{ question: 'q?', options: two }] })).toBeNull();
  });

  it('refuses a question with one option, or five — a choice needs a choice', () => {
    const opt = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `o${i}`, why: `w${i}` }));
    expect(parseQuiz({ questions: [{ question: 'q?', options: opt(1), correct: 0 }] })).toBeNull();
    expect(parseQuiz({ questions: [{ question: 'q?', options: opt(5), correct: 0 }] })).toBeNull();
    expect(parseQuiz({ questions: [{ question: 'q?', options: opt(2), correct: 0 }] })).not.toBeNull();
    expect(parseQuiz({ questions: [{ question: 'q?', options: opt(4), correct: 0 }] })).not.toBeNull();
  });

  it('lets a question stand without context, and drops junk out of the brief', () => {
    const q = parseQuiz({
      brief: ['kept', 42, null, '  ', 'also kept'],
      questions: [{ question: 'q?', options: [{ text: 'a', why: 'x' }, { text: 'b', why: 'y' }], correct: 0 }],
    })!;
    expect(q.questions[0]!.context).toBe('');
    expect(q.brief).toEqual(['kept', 'also kept']);
  });

  it('never throws, whatever the worker writes', () => {
    for (const junk of [0, true, [], [[]], { questions: 5 }, { questions: [null, undefined, 7] }]) {
      expect(() => parseQuiz(junk)).not.toThrow();
    }
  });
});

describe('quizKey', () => {
  it('is stable for a quiz carried forward byte for byte — their answers still count', () => {
    expect(quizKey(parseQuiz(GOOD)!)).toBe(quizKey(parseQuiz(structuredClone(GOOD))!));
  });

  it('changes when a question, an option or the answer changes — they retake only then', () => {
    const base = quizKey(parseQuiz(GOOD)!);
    const reworded = structuredClone(GOOD);
    reworded.questions[0]!.question = 'What happens if a broker accepts a withdrawn quote now?';
    expect(quizKey(parseQuiz(reworded)!)).not.toBe(base);

    const reordered = structuredClone(GOOD);
    reordered.questions[0]!.correct = 1;
    expect(quizKey(parseQuiz(reordered)!)).not.toBe(base);

    const relabelled = structuredClone(GOOD);
    relabelled.questions[0]!.options[0]!.text = 'Nothing at all happens';
    expect(quizKey(parseQuiz(relabelled)!)).not.toBe(base);
  });

  it('does NOT change when only the reasoning is improved — a better `why` is not a new quiz', () => {
    const better = structuredClone(GOOD);
    better.questions[0]!.options[0]!.why = 'Withdrawn is terminal. Step 2 is the proof.';
    expect(quizKey(parseQuiz(better)!)).toBe(quizKey(parseQuiz(GOOD)!));
  });
});
