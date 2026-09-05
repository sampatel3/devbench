/**
 * The operator's half of the comprehension quiz: their picks, and whether they
 * have submitted.
 *
 * The worker's half — the questions, the answer key and every option's reasoning
 * — is in `.gate.json` and reaches the page with the rest of the row. So grading
 * is `picked === correct`, a pure comparison in the browser: no resume, no
 * session, no tokens. That is the only way the card can say immediately whether a
 * pick was right or wrong.
 *
 * Their answers live in `localStorage`, not in the gate file. The gate file is
 * rewritten whole every time the worker stops, so anything of theirs stored there
 * dies by design; and the permanent record of the result does not need a file at
 * all, because it rides the approval prompt into `.gate-history.jsonl` (see
 * `approveCPrompt`). One entry per issue, overwritten when the quiz changes.
 *
 * `quizKey` is what makes staleness self-correcting. It hashes only what grading
 * depends on, so a targeted rework that rewrites a question mints a new key and
 * the stored picks stop matching — the operator retakes exactly when the
 * questions changed, and a quiz carried forward byte for byte keeps their
 * submission. It is a deliberate second copy of the orchestrator's `quizKey`:
 * this one is a cache key for a browser store, and a mismatch costs a retake,
 * never a false tick.
 */
import type { Quiz } from './types';
import type { QuizRecord, QuizResultLine } from './gate';

export type QuizProgress = {
  /** The `quizKey` these picks belong to. */
  key: string;
  /** picks[i] is the option index chosen for question i; null is unanswered. */
  picks: Array<number | null>;
  /** ISO-8601 once Submit is pressed. Null while in progress — and this, not the
   *  score, is the half of the gate lock the quiz owns. */
  submittedAt: string | null;
};

export function quizKey(quiz: Quiz): string {
  const s = JSON.stringify(quiz.questions.map((q) => [q.question, q.options.map((o) => o.text), q.correct]));
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export const freshProgress = (key: string, count: number): QuizProgress => ({
  key,
  picks: Array<number | null>(count).fill(null),
  submittedAt: null,
});

const storageKey = (issue: number): string => `gateC-quiz-${issue}`;

/** The browser store, or nothing. Absent storage is a quiz to retake, never a crash. */
const store = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/**
 * The operator's progress on THIS quiz, or a fresh one.
 *
 * Anything that does not match — a different key, a different question count, a
 * value that will not parse — degrades to fresh. The safe direction is always
 * "they answer again", never "a submission they never made".
 */
export function loadProgress(issue: number, quiz: Quiz): QuizProgress {
  const key = quizKey(quiz);
  const count = quiz.questions.length;
  const s = store();
  if (!s) return freshProgress(key, count);
  try {
    const raw = s.getItem(storageKey(issue));
    if (raw) {
      const p = JSON.parse(raw) as QuizProgress;
      if (p && p.key === key && Array.isArray(p.picks) && p.picks.length === count) {
        return { key, picks: p.picks, submittedAt: typeof p.submittedAt === 'string' ? p.submittedAt : null };
      }
    }
  } catch {
    /* a corrupt entry is a fresh quiz, not an error message */
  }
  return freshProgress(key, count);
}

export function saveProgress(issue: number, p: QuizProgress): void {
  try {
    store()?.setItem(storageKey(issue), JSON.stringify(p));
  } catch {
    /* a full or blocked store costs one retake, and nothing else */
  }
}

/**
 * Pick an option — write-once, and never after submit.
 *
 * There is no un-pick and no retake. The score has no authority over the gate,
 * so a redo affordance would only invite the operator to game themselves; a
 * misclick costs nothing, because a miss reveals the reasoning, which is the
 * point.
 */
export function withPick(p: QuizProgress, question: number, option: number): QuizProgress {
  if (p.submittedAt !== null) return p;
  if (p.picks[question] !== null && p.picks[question] !== undefined) return p;
  return { ...p, picks: p.picks.map((v, i) => (i === question ? option : v)) };
}

export const answeredCount = (p: QuizProgress): number => p.picks.filter((v) => v !== null).length;

export const allAnswered = (quiz: Quiz, p: QuizProgress): boolean =>
  quiz.questions.length > 0 && answeredCount(p) === quiz.questions.length;

/** Submit — the only thing about this quiz that has any authority over the gate. */
export function withSubmit(quiz: Quiz, p: QuizProgress, now: string): QuizProgress {
  if (p.submittedAt !== null || !allAnswered(quiz, p)) return p;
  return { ...p, submittedAt: now };
}

export type QuestionVerdict = 'right' | 'missed' | null;

export function verdictOf(quiz: Quiz, p: QuizProgress, i: number): QuestionVerdict {
  const picked = p.picks[i];
  if (picked === null || picked === undefined) return null;
  return picked === quiz.questions[i]?.correct ? 'right' : 'missed';
}

export const scoreOf = (quiz: Quiz, p: QuizProgress): number =>
  quiz.questions.reduce((n, q, i) => (p.picks[i] === q.correct ? n + 1 : n), 0);

/** The graded quiz as the approval carries it — every question, the miss named. */
export function quizRecord(quiz: Quiz, p: QuizProgress): QuizRecord {
  const lines: QuizResultLine[] = quiz.questions.map((q, i) => {
    const picked = p.picks[i];
    return {
      n: i + 1,
      right: picked === q.correct,
      question: q.question,
      picked: picked === null || picked === undefined ? '(unanswered)' : (q.options[picked]?.text ?? '(unknown)'),
      correct: q.options[q.correct]?.text ?? '(unknown)',
    };
  });
  return { score: scoreOf(quiz, p), total: quiz.questions.length, lines };
}
