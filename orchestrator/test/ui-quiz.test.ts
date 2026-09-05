/**
 * The operator's half of the comprehension quiz: the picks, the grading, and the one
 * thing about it that has authority over the gate.
 *
 * "it can tell me if it's right or wrong and then when i submit it can tell me
 * the answers and why" — so grading has to be local and instant, which means it
 * is a pure function over the payload and can be tested here rather than clicked
 * through a browser. What is checked below is mostly what must NOT happen: a
 * score that blocks, a pick that can be taken back, a stale submission carried
 * onto rewritten questions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  allAnswered,
  answeredCount,
  freshProgress,
  loadProgress,
  quizKey,
  quizRecord,
  saveProgress,
  scoreOf,
  verdictOf,
  withPick,
  withSubmit,
} from '../../ui/src/quiz.js';
import type { Quiz } from '../../ui/src/types.js';
import { parseQuiz } from '../src/quiz.js';

const QUIZ: Quiz = parseQuiz({
  brief: ['Withdraw is refused once a quote has expired'],
  questions: [
    {
      context: 'A quote expires 30 days after it is issued.',
      question: 'What happens if you try to withdraw an expired quote?',
      options: [
        { text: 'It withdraws as normal', why: 'That was the old behaviour, and the Was capture on step 3 shows it.' },
        { text: 'The button is disabled', why: 'Right — the Now capture on step 3 shows Withdraw greyed out.' },
      ],
      correct: 1,
    },
    {
      context: '',
      question: 'What is not proven by this gate?',
      options: [
        { text: 'Anything on a phone', why: 'Right — every capture was taken at desktop width.' },
        { text: 'The expiry rule itself', why: 'The expiry rule is covered by step 2 and its capture.' },
      ],
      correct: 0,
    },
  ],
})!;

/** A localStorage stand-in — the module has to work with one, and without one. */
class MemStore {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

let store: MemStore;
beforeEach(() => {
  store = new MemStore();
  (globalThis as { localStorage?: Storage }).localStorage = store as unknown as Storage;
});

describe('Answering', () => {
  it('grades a pick immediately, with no worker in the loop', () => {
    let p = freshProgress(quizKey(QUIZ), 2);
    expect(verdictOf(QUIZ, p, 0)).toBeNull();
    p = withPick(p, 0, 1);
    expect(verdictOf(QUIZ, p, 0)).toBe('right');
    p = withPick(p, 1, 1);
    expect(verdictOf(QUIZ, p, 1)).toBe('missed');
    expect(scoreOf(QUIZ, p)).toBe(1);
  });

  /**
   * Write-once, and no retake. The score has no authority over the gate, so a
   * redo affordance would only invite them to game themselves — and a misclick costs
   * nothing, because the miss is what reveals the reasoning.
   */
  it('refuses to change a pick, and refuses any pick after submit', () => {
    let p = withPick(freshProgress(quizKey(QUIZ), 2), 0, 0);
    expect(withPick(p, 0, 1)).toBe(p);
    p = withSubmit(QUIZ, withPick(p, 1, 0), '2026-08-12T10:00:00.000Z');
    expect(p.submittedAt).not.toBeNull();
    expect(withPick(p, 0, 1)).toBe(p);
  });

  it('will not submit a half-answered quiz', () => {
    const p = withPick(freshProgress(quizKey(QUIZ), 2), 0, 1);
    expect(answeredCount(p)).toBe(1);
    expect(allAnswered(QUIZ, p)).toBe(false);
    expect(withSubmit(QUIZ, p, 'now').submittedAt).toBeNull();
  });

  /** Wrong answers block nothing. Submitting is the whole of the quiz's authority. */
  it('submits an all-wrong quiz exactly as readily as a perfect one', () => {
    const wrong = withSubmit(QUIZ, withPick(withPick(freshProgress(quizKey(QUIZ), 2), 0, 0), 1, 1), 'now');
    expect(wrong.submittedAt).toBe('now');
    expect(scoreOf(QUIZ, wrong)).toBe(0);
  });
});

describe('Their answers survive the file being rewritten — and only while they should', () => {
  it('comes back after a reload', () => {
    const p = withPick(freshProgress(quizKey(QUIZ), 2), 0, 1);
    saveProgress(4404, p);
    expect(loadProgress(4404, QUIZ).picks).toEqual([1, null]);
  });

  /**
   * A targeted rework rewrites `.gate.json` whole. A quiz carried forward byte
   * for byte keeps its key and their submission stands; a question the fix
   * genuinely changed mints a new key and they retake exactly that quiz. No
   * cleanup pass and no worker discipline beyond "don't touch what you didn't
   * change".
   */
  it('drops a submission when a question, an option or the answer key changes', () => {
    saveProgress(4404, withSubmit(QUIZ, withPick(withPick(freshProgress(quizKey(QUIZ), 2), 0, 1), 1, 0), 'now'));
    expect(loadProgress(4404, QUIZ).submittedAt).toBe('now');

    const reworded: Quiz = {
      ...QUIZ,
      questions: [{ ...QUIZ.questions[0]!, question: 'What happens on an expired quote now?' }, QUIZ.questions[1]!],
    };
    expect(quizKey(reworded)).not.toBe(quizKey(QUIZ));
    expect(loadProgress(4404, reworded).submittedAt).toBeNull();

    const rekeyed: Quiz = { ...QUIZ, questions: [{ ...QUIZ.questions[0]!, correct: 0 }, QUIZ.questions[1]!] };
    expect(loadProgress(4404, rekeyed).submittedAt).toBeNull();
  });

  it('ignores the brief, which teaches nothing about grading', () => {
    expect(quizKey({ ...QUIZ, brief: ['a completely different brief'] })).toBe(quizKey(QUIZ));
  });

  it('degrades a corrupt or foreign entry to a fresh quiz, never to a submission', () => {
    store.setItem('gateC-quiz-4404', '{ not json');
    expect(loadProgress(4404, QUIZ).submittedAt).toBeNull();
    store.setItem('gateC-quiz-4404', JSON.stringify({ key: quizKey(QUIZ), picks: [1], submittedAt: 'now' }));
    expect(loadProgress(4404, QUIZ)).toEqual(freshProgress(quizKey(QUIZ), 2));
  });

  it('works with no storage at all rather than throwing at them', () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(() => saveProgress(4404, freshProgress('k', 2))).not.toThrow();
    expect(loadProgress(4404, QUIZ).picks).toEqual([null, null]);
  });
});

describe('What the approval carries', () => {
  it('names every question, the miss included, with what they thought and what was true', () => {
    const p = withSubmit(QUIZ, withPick(withPick(freshProgress(quizKey(QUIZ), 2), 0, 1), 1, 1), 'now');
    const r = quizRecord(QUIZ, p);
    expect(r).toEqual({
      score: 1,
      total: 2,
      lines: [
        {
          n: 1,
          right: true,
          question: 'What happens if you try to withdraw an expired quote?',
          picked: 'The button is disabled',
          correct: 'The button is disabled',
        },
        {
          n: 2,
          right: false,
          question: 'What is not proven by this gate?',
          picked: 'The expiry rule itself',
          correct: 'Anything on a phone',
        },
      ],
    });
  });
});
