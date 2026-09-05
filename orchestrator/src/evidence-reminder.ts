/**
 * THE GATE C EVIDENCE REMINDER — the same words on every message that sends a
 * worker back to gate C.
 *
 * The operator's standing ask: remind the agent at gate C, continually, to
 * provide the "was" and "after" screenshot evidence and to make sure all of it is
 * displayed. The word that matters there is **continually**. The skill states
 * the rule once, at the top of Stage 5, and a worker that has since answered a
 * question, taken a rework and rewritten `.gate.json` three times is following
 * the message in front of it, not a paragraph it read an hour ago. So the rule
 * rides every message: the ask, the rework, a reopened gate C, and each of the
 * console's three "you did not attach it" prompts.
 *
 * It is deliberately the SAME string in all of them. A reminder that is
 * paraphrased per caller is a reminder a worker can read as a new instruction
 * and act on differently each round; identical bytes read as the standing rule
 * they are.
 *
 * There are two copies of these words — this one and `EVIDENCE_REMINDER` in
 * `ui/src/gate.ts` — because the console's two halves share no code (the UI
 * builds through Vite, `rootDir` here is `src`). They must agree, and
 * `gate-c-evidence-reminder.test.ts` fails the build when they drift, on the
 * same rule as the priority tables in `summary.ts`.
 *
 * One caller is deliberately missing: the gate C APPROVAL. That message ends
 * the gate and sends the worker to Stage 6, and `approveCPrompt` is bound by
 * the words-always-go rule that puts the operator's own text last. Appending a
 * "capture more evidence" block to a gate they have just passed would be noise at
 * best and a re-run of the QA at worst.
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
