/**
 * The comprehension half of gate C, as a checkable object.
 *
 * The operator asked for the QA to be part information — what was done — and part
 * simple multiple-choice questions rather than free text, so that the answers can
 * be given directly, marked right or wrong on the spot, and explained on submit.
 *
 * So the worker writes the questions AND the answer key AND every option's
 * reasoning into `.gate.json` before it stops. By the time the card renders, the
 * console already holds everything grading needs: `picked === correct` is a pure
 * comparison in the browser. No resume, no session, no tokens — which is the
 * only way "tell me immediately" can be true.
 *
 * That ships the answer key to the page, deliberately. The key is in a file in
 * the operator's own worktree, openable in any editor, and the quiz's authority
 * over the gate is SUBMITTED, never SCORED — a wrong answer blocks nothing, so
 * peeking wins nothing a wrong answer would have cost. Withholding it would buy
 * a round-trip and a worker call to protect the operator from themselves.
 *
 * What has NOT changed: comprehension still blocks the gate. Dropping it — basing
 * the approval on the QA alone — was considered and reversed once the trade was
 * named: the gate is blocked by BOTH the QA and comprehension. The operator does
 * not ship what they have not understood. Only the FORM changed, not the
 * authority.
 */

export type QuizOption = {
  /** The option as shown. One line. */
  text: string;
  /** Why this option is right — or, for a wrong one, the real misunderstanding
   *  it stands for and the evidence on this card that refutes it. Shown only
   *  after submit, which is what makes a miss worth having. */
  why: string;
};

export type QuizQuestion = {
  /** Teaching setup: every fact needed to answer, terms defined inline. May be
   *  empty when the question genuinely stands alone. */
  context: string;
  /** One sentence. Consequences, never implementation. */
  question: string;
  /** 2–4 options. The array index IS the option id and the display order. */
  options: QuizOption[];
  /** Index into `options` of the single defensibly-correct answer. */
  correct: number;
};

export type Quiz = {
  /** "What was done" — behaviour-level bullets, one line each. The shared ground
   *  the questions build on, and never a repeat of the gate summary. */
  brief: string[];
  questions: QuizQuestion[];
  /**
   * How many questions this parser had to void.
   *
   * A voided question is invisible: the operator takes the two that survived,
   * scores 2/2 and the comprehension half passes. The question most likely to be
   * malformed
   * is the "honest limits" one — the one that says what the gate does NOT prove —
   * so a silent drop is the worst shape this can take. The count leaves with the
   * quiz and the card locks on it.
   */
  dropped: number;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * One question, or null.
 *
 * A malformed OPTION voids the whole question rather than being dropped on its
 * own. `correct` is an index: silently dropping option B renumbers the answer
 * key under the author's feet and turns a typo into a confidently wrong lesson.
 * An option set is authored as a unit, so it is validated as one.
 */
function parseQuestion(raw: unknown): QuizQuestion | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const question = str(obj.question);
  if (!question) return null; // a question with no question is not a question
  if (!Array.isArray(obj.options)) return null;
  const options: QuizOption[] = [];
  for (const o of obj.options) {
    if (typeof o !== 'object' || o === null) return null;
    const text = str((o as Record<string, unknown>).text);
    const why = str((o as Record<string, unknown>).why);
    if (!text || !why) return null;
    options.push({ text, why });
  }
  if (options.length < 2 || options.length > 4) return null;
  const correct = obj.correct;
  if (typeof correct !== 'number' || !Number.isInteger(correct)) return null;
  if (correct < 0 || correct >= options.length) return null;
  return { context: str(obj.context) ?? '', question, options, correct };
}

/**
 * Parse the `quiz` block out of a raw `.gate.json`. Tolerant on the same
 * principle as `parseManualQa` and `parseEvidence`: never throws, and a quiz
 * with one bad question still shows the good ones.
 *
 * No usable question at all returns null, which is not a silent failure: the
 * card shows the red "no quiz" block, the gate stays locked, and one click asks
 * the worker for it. An absent quiz must never read as a passed half.
 */
export function parseQuiz(raw: unknown): Quiz | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const questions: QuizQuestion[] = [];
  let dropped = 0;
  if (Array.isArray(obj.questions)) {
    for (const q of obj.questions) {
      const parsed = parseQuestion(q);
      if (parsed) questions.push(parsed);
      else dropped += 1;
    }
  }
  if (questions.length === 0) return null;
  const brief = Array.isArray(obj.brief)
    ? obj.brief.map(str).filter((b): b is string => b !== null)
    : [];
  return { brief, questions, dropped };
}

/**
 * A stable key over everything grading depends on.
 *
 * The operator's answers live in the browser, not the gate file, so they need to
 * know which quiz they belong to. A targeted rework that rewrites a question
 * changes this key and the stored submission stops matching — the operator
 * retakes exactly when the questions changed. A quiz carried forward byte for byte
 * keeps its key and the submission stands. No worker discipline is required beyond
 * "don't touch what the fix didn't change".
 */
export function quizKey(quiz: Quiz): string {
  const s = JSON.stringify(quiz.questions.map((q) => [q.question, q.options.map((o) => o.text), q.correct]));
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
