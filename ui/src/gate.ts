/**
 * What the gate card actually sends to the worker.
 *
 * This is a pure function because it got the answer wrong in production.
 * "Approve gate A" ignored the textarea completely: the operator typed three
 * substantive answers, pressed Approve, and the click sent only `Gate A
 * approved, proceed.` The worker then recorded that the gate had been approved
 * with no explicit answers, and took all three of its own recommendations
 * instead — one of them wider than the issue asked for. The question that
 * surfaced it was whether Approve also sent the responses, and the honest answer
 * was no.
 *
 * So the composition lives here, where it can be tested without a browser, and
 * the rule is one line long: **the operator's words always go**. Nothing here
 * summarises, reformats or truncates them, and an approval never swallows them.
 */
import type { GateLetter } from './types';

/** The canned approval, which is all an EMPTY approval has to say. */
export const approvalLine = (gate: GateLetter): string => `Gate ${gate} approved, proceed.`;

/**
 * Approve: the approval line, plus whatever you typed, verbatim, when you typed
 * anything. Approving is not a reason to drop your answers — that was the bug.
 */
export function approvePrompt(gate: GateLetter, text: string): string {
  const said = text.trim();
  return said ? `${approvalLine(gate)}\n\n${said}` : approvalLine(gate);
}

/**
 * Feedback without approval: your words and nothing else. No approval line is
 * manufactured for a message that is not one — that is the whole difference
 * between the two buttons.
 */
export function feedbackPrompt(text: string): string {
  return text.trim();
}

/**
 * THE GATE C EVIDENCE REMINDER — the same words on every message the console
 * sends to a worker parked at gate C.
 *
 * The operator asked for the agent at gate C to be reminded CONTINUALLY to
 * provide the was and after screenshot evidence, and to ensure all of it is
 * displayed. **Continually** is the load-bearing word. The skill states the rule
 * once at Stage 5; a worker three rounds deep — a question answered, a step
 * reworked, `.gate.json` rewritten whole each time — is following the message in
 * front of it, not a paragraph it read an hour ago. So the rule rides every
 * message that puts it back at this gate.
 *
 * Identical bytes every time, on purpose: a reminder paraphrased per caller
 * reads as a new instruction and gets acted on differently each round.
 *
 * The second copy lives in `orchestrator/src/evidence-reminder.ts` — the ask,
 * the rework and a reopened gate C are composed server-side, and the two halves
 * of this console share no code. `gate-c-evidence-reminder.test.ts` fails when
 * they drift.
 *
 * Not on `approveCPrompt`, deliberately: that message ENDS the gate and sends
 * the worker to Stage 6, and it is bound by the words-always-go rule that puts
 * the operator's own text last. Telling a passed gate to capture more evidence is
 * noise at best and a re-run of the QA at worst.
 */
export const EVIDENCE_REMINDER = [
  'EVIDENCE — RE-READ THIS EVERY TIME YOU STOP AT GATE C, NOT ONLY THE FIRST TIME:',
  '- Every QA step carries BOTH legs, and both are REQUIRED: the WAS shot ("beforeShot"',
  '  — what it did before this change) and the AFTER shot ("afterShot" — what it does',
  '  now). One step, one tick, two pictures.',
  '- There is ONE exception, and it is a before leg that cannot exist: genuinely new',
  '  behaviour, nothing there to photograph, written as "before": null WITH',
  '  "beforeShot": null (the card prints "New — nothing to compare"). Nothing else. A',
  '  missing "afterShot", or a missing "beforeShot" on a step that says what it used to',
  '  do, raises a WARNING on the card that the operator has to read and accept by hand',
  '  before they can approve at all — so capture it rather than explaining it, and never',
  '  fake a shot. If one genuinely cannot be captured, say which step, which leg, what',
  '  you ran and the exact error, in one "Limits:" bullet: they are deciding whether to',
  '  take it.',
  '- Every capture this issue has produced, in every round so far, is listed in',
  '  .gate.json "evidence" with a caption saying what to notice. A shot that is not in',
  '  "evidence" is not displayed on the card, and evidence that is not displayed does',
  '  not count. Check the list against the files under docs/issue-pipeline/plans/qa-<N>/',
  '  before you stop.',
  '- Carry the prior "evidence" forward complete and in order, then append the new',
  '  shots. Never remove, overwrite or delete a capture the operator has already been',
  '  shown — the old one is the record of what they saw.',
].join('\n');

/** Append the reminder to a gate C message. Always last, always verbatim. */
export function withEvidenceReminder(prompt: string): string {
  return `${prompt}\n\n${EVIDENCE_REMINDER}`;
}

/**
 * Feedback at gate C: your words, and the standing evidence rule under them.
 *
 * `feedbackPrompt` stays exactly as it is for every other gate — this is the one
 * gate with an evidence box, and feedback here always sends the worker back to
 * rewrite `.gate.json`. Your words still lead, and nothing here touches them.
 */
export function feedbackCPrompt(text: string): string {
  const said = feedbackPrompt(text);
  return said ? withEvidenceReminder(said) : said;
}

/**
 * Gate C's approval SAYS the two things gate C is for.
 *
 * The skill's rule requires BOTH: the operator states manual QA passed AND
 * confirms understanding, and it waits for explicit words for each. `Gate C
 * approved, proceed.` states neither, so the canned click was asserting less than
 * the gate needs — the worker was left to infer it. This says both out loud,
 * which is also the honest thing for the button to mean: press it when both are
 * true.
 *
 * Both are still REQUIRED. Dropping the comprehension half was considered and
 * reversed once the trade was named: the gate stays blocked on the QA and on
 * comprehension together. Only the form of the comprehension half changed.
 */
export const approvalLineC =
  'Gate C approved — I ran the manual QA myself, step by step, and I understand the change. Proceed.';

/** What the ticks came to: how many steps, how many you verified, which came back fixed. */
export type QaRecord = { total: number; verified: number; reworkedIds: number[] };

/** One graded question, as it reaches the worker. */
export type QuizResultLine = {
  n: number;
  right: boolean;
  question: string;
  /** The option you chose, as shown. */
  picked: string;
  /** The option that was correct, as shown. */
  correct: string;
};

export type QuizRecord = { score: number; total: number; lines: QuizResultLine[] };

/** Everything gate C's approval carries besides your own words. */
export type GateCRecord = {
  qa: QaRecord;
  quiz: QuizRecord | null;
  /** The warnings you ticked to get past, from `acceptedLine` — empty or absent
   *  when the gate had none. A gate approved over a warning must say so. */
  accepted?: string;
};

const list = (ids: number[]): string =>
  ids.length === 1 ? `Step ${ids[0]}` : `Steps ${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;

/** One line: what the ticks came to, and which steps had to go back. */
export function qaRecordLine(qa: QaRecord): string {
  const head = `QA record: ${qa.verified} of ${qa.total} step${qa.total === 1 ? '' : 's'} ticked verified by hand.`;
  if (qa.reworkedIds.length === 0) return head;
  const was = qa.reworkedIds.length === 1 ? 'was' : 'were';
  return `${head} ${list(qa.reworkedIds)} failed, ${was} fixed, and ${was} re-verified after the fix.`;
}

/** The graded quiz, one line per question, with the miss named rather than hidden. */
export function quizRecordLines(quiz: QuizRecord): string {
  const body = quiz.lines
    .map((l) =>
      l.right
        ? `${l.n}. right — ${l.question}`
        : `${l.n}. missed — ${l.question} (I picked "${l.picked}"; the answer was "${l.correct}")`,
    )
    .join('\n');
  return `Quiz record (${quiz.score}/${quiz.total}):\n${body}`;
}

/**
 * Approve at gate C: the approval line, the record of what was actually checked,
 * and then your words, verbatim and last.
 *
 * The record rides the prompt because the prompt is what the worker writes into
 * `.gate-history.jsonl` as the `decision` — so the ticks and the graded quiz
 * reach the permanent ledger with no new plumbing, and a missed question tells
 * the worker which concept to be careful with next time.
 *
 * Same words-always-go rule as `approvePrompt`: an approval never swallows what
 * you typed. That was a real bug once, and it is the reason this is a pure
 * function with tests instead of a string built in a click handler.
 */
export function approveCPrompt(text: string, record: GateCRecord): string {
  const said = text.trim();
  return [
    approvalLineC,
    qaRecordLine(record.qa),
    record.quiz ? quizRecordLines(record.quiz) : null,
    // What you ACCEPTED, when the gate had a warning on it. It rides above your
    // own words for the same reason the ticks do: the prompt is what the worker writes
    // into `.gate-history.jsonl` as the decision, so "approved with step 3's
    // before-shot still missing" is on the permanent record rather than being a
    // thing only the browser ever knew.
    record.accepted && record.accepted.trim() ? record.accepted.trim() : null,
    said ? `I also said:\n${said}` : null,
  ]
    .filter((s): s is string => s !== null)
    .join('\n\n');
}

/**
 * "You did not attach the quiz" — the third red block.
 *
 * The comprehension half of gate C cannot be completed without it, and an absent
 * quiz must never read as a passed half. Same resume pipe and same shape as
 * `askForScriptPrompt`: it says what it is not, names the fields the parser
 * reads, and re-parks at the same gate.
 */
export function askForQuizPrompt(): string {
  return withEvidenceReminder(
    'Gate C is missing the comprehension quiz — this is NOT an approval and NOT a change request about ' +
    'the code. Your .gate.json has no usable `quiz` object, so the understanding half of gate C cannot be ' +
    'completed. Rewrite .gate.json exactly as it is, adding `quiz` as { brief, questions }: `brief` is 3–6 ' +
    'one-line bullets of what the change DOES in behaviour terms, and `questions` is 2–4 entries of ' +
    '{ context, question, options, correct }. `options` is 2–4 of { text, why } — `text` is the option in ' +
    '12 words or fewer, `why` is 1–2 sentences saying why it is right or, for a wrong option, which real ' +
    'misunderstanding it stands for and what on this card refutes it. `correct` is the index into options ' +
    'of the one defensibly right answer. Ask about consequences, never implementation, and put every fact ' +
    'needed to answer in `context` so the question is answerable from this gate card alone. Keep the ' +
    'summary, evidence and manualQa exactly as they are, change no code, re-run no QA, and stop at gate C ' +
    'again immediately after writing the file.'
  );
}

/**
 * "You did not attach the screenshots" — the message behind the red block on a
 * gate C that arrived without any.
 *
 * This exists because of a specific failure, and it is written to disarm it by
 * name. A worker read the repo's rule to use the `/browse` skill for all web
 * browsing and never the MCP browser tools, found `/browse` unregistered in its
 * session, concluded browser QA was impossible, and OFFERED THE OPERATOR THE
 * CHOICE of writing a Playwright script or running the clicks themselves. That
 * choice must never be offered: the agent captures its own evidence. The rule it
 * tripped over governs MCP browser tools, not the repo's own Playwright tooling
 * run headless on localhost — which is the documented, sanctioned method and the
 * one that produced #4342's screenshots.
 *
 * It goes down the resume pipe, not the ask pipe: an ask must write no file and
 * change no state, and this asks for files. It is a change request against an
 * incomplete gate deliverable — which is exactly what `Send feedback` is — so it
 * says in its first line that it is not an approval.
 */
export function askForShotsPrompt(): string {
  return withEvidenceReminder(
    'Gate C is missing screenshots — this is NOT an approval and NOT a change request about the code. ' +
    "Capture them yourself with the repo's own Playwright tooling, run headless against the local dev " +
    "server: page.screenshot({ path }) writes a real file, and the documented shared local-dev account " +
    'goes in by env, per references/qa.md. The /browse rule is about MCP browser tools and has nothing ' +
    'to say about Playwright, so browser QA is not blocked — never hand the capture back to me. ' +
    'Save the script and the PNGs under docs/issue-pipeline/plans/qa-<issue>/, list every shot in ' +
    '.gate.json `evidence` with a caption saying what it shows, and stop at gate C again.'
  );
}

/**
 * "A step came back without its pictures" — the fourth red block.
 *
 * The operator's rule: an after shot and a before shot are both required, unless
 * there is no before to photograph — a genuinely new feature.
 * The card locks Approve on it (`missingShots` in gate-c.ts) and this is the
 * message that unlocks it — it names the exact steps and the exact legs, because
 * "add the missing screenshots" to a worker holding a nine-step script is an
 * invitation to re-capture all nine and overwrite the ones already read.
 *
 * It carries the exception too. A worker whose step is genuinely new must be
 * able to answer by writing the `null` pair rather than faking a picture of a
 * screen that did not exist — that is a correct answer to this message, not a
 * refusal of it.
 */
export function askForMissingShotsPrompt(
  missing: Array<{ id: number; legs: Array<'before' | 'after'>; gone?: Array<'before' | 'after'> }>,
): string {
  const one = missing.length === 1;
  const list = missing
    .map((m) => `step ${m.id} (${m.legs.map((l) => `"${l}Shot"`).join(' and ')})`)
    .join(', ');
  // THE LEGS THAT NAMED A FILE THAT IS NOT THERE, said separately and first.
  // "Add the missing screenshot" is the wrong instruction for a worker that
  // already wrote the field: it reads its own gate file, sees the path, and has
  // every reason to think it complied. The defect is the FILE, and a worker that
  // is not told so will write the same path again.
  const absent = missing.filter((m) => (m.gone?.length ?? 0) > 0);
  const absentSaid =
    absent.length === 0
      ? ''
      : `${absent
          .map((m) => `step ${m.id} (${m.gone!.map((l) => `"${l}Shot"`).join(' and ')})`)
          .join(', ')} NAMED a capture that is not in the worktree — the path is in .gate.json and no file ` +
        'exists at it, so the console renders an empty box where the evidence should be. Do not simply write ' +
        'the path again: either capture the picture and save it at that exact path, or capture it, save it ' +
        'under docs/issue-pipeline/plans/qa-<issue>/ and point the step at where it really is. Check each one ' +
        'exists on disk before you stop. ';
  return withEvidenceReminder(
    `Gate C is missing screenshot evidence on ${one ? 'a step' : `${missing.length} steps`} — this is NOT an ` +
      'approval and NOT a change request about the code. Missing: ' +
      `${list}. ${absentSaid}Both legs are required on every step: "beforeShot" is what it did before this change and ` +
      '"afterShot" is what it does now. The ONE exception is a before leg that cannot exist — genuinely new ' +
      'behaviour, nothing there to photograph — and that is written as "before": null WITH "beforeShot": null, ' +
      'which the card renders as "New — nothing to compare". If that is the honest answer for a step named ' +
      'above, write the null pair; otherwise capture the shot. Drive the app headlessly with the ' +
      "repo's own " +
      'Playwright on localhost, same account and same fixture as the rest of the script, and capture ONLY the ' +
      `${one ? 'leg' : 'legs'} named above — do not re-run the whole QA and do not re-capture a step that is ` +
      'already complete. Save new files under docs/issue-pipeline/plans/qa-<issue>/, never overwriting an existing ' +
      'capture, point the step at them, add them to "evidence" with a caption, keep every other step, its id, ' +
      'its rev and its wording exactly as they are, change no code, and stop at gate C again.',
  );
}

/**
 * "You did not attach the click-script" — the other red block.
 *
 * Names each field, because the console can only render what is structured: a
 * click-script buried in prose is the complaint this whole card answers — the
 * operator could not find the click-script at all.
 *
 * It names the v2 shape, and the two rules in it that are not obvious:
 *
 *  - before and after are ONE step. The operator asked for the before and the
 *    after to be one question rather than a point for each — a shape that cannot
 *    express them as two numbered steps is the only way to hold that.
 *  - `id` and `rev` are the join key the operator's per-step ticks hang on, so
 *    they are stated as a contract rather than left to the worker's judgement.
 *
 * This matters more than the skill text does: a worker follows the message in
 * front of it, and this is the message.
 */
export function askForScriptPrompt(): string {
  return withEvidenceReminder(
    'Gate C is missing the manual QA click-script — this is NOT an approval and NOT a change request ' +
    'about the code. Rewrite .gate.json with the `manualQa` block filled in: `appUrl` (the running local ' +
    'app — localhost only, or the console will not link it), `login` as { email, password } for the ' +
    'documented shared local-dev account and never a real credential, `start` for the state I begin ' +
    'from, and `steps` as an array of { id, rev, do, url, before, beforeShot, after, afterShot }. ' +
    '`id` is 1-based and never renumbered and `rev` starts at 1 — I tick each step verified by hand ' +
    'and those two numbers are what my ticks hang on, so changing either throws away checking I have ' +
    'already done. `do` is one action in 12 words or fewer. `before` and `after` are the SAME step, ' +
    'never one step for the before and another for the after: `before` is what it did until this change ' +
    '(both `before` and `beforeShot` null when the behaviour is genuinely new), `after` is what I should ' +
    'see now, and `beforeShot`/`afterShot` are the screenshots of each, saved under ' +
    'docs/issue-pipeline/plans/qa-<issue>/ and captured with the repo own Playwright headless on localhost. ' +
    'Put caveats in the summary Limits bullets, never inside a step. Keep the summary, questions, ' +
    'evidence and quiz exactly as they are, and stop at gate C again.'
  );
}
