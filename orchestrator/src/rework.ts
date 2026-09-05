/**
 * TARGETED REWORK — one failed QA step back to Build, and nothing else redone.
 *
 * The operator's ask, in two halves: feedback from the manual QA has to be worked
 * on and fixed by the agent — but the agent must NOT redo the full QA to do it,
 * because that is a huge waste of tokens, time and resources. It has to address
 * the one failed point and show it fixed, while the gate C box still carries the
 * full evidence for the whole issue.
 *
 * Both halves of that are constraints, and they pull against each other. Redoing
 * everything is the waste the operator named; redoing only the one step means the
 * OTHER steps' evidence has to survive a file the worker rewrites whole. So:
 *
 *  - the prompt carries the prior `evidence` and `manualQa` verbatim and orders
 *    them carried forward byte for byte, the same contract `askPrompt` already
 *    proves for the question thread;
 *  - the console snapshots both before it sends, and puts back anything the
 *    worker drops. The worker owns the file; the console owns the proof.
 *
 * Why the worker merges rather than the console: `.gate.json` has exactly one
 * writer today, and two writers would race a live run. Worse, the worker appends
 * `.gate.json` to `.gate-history.jsonl` at the start of its next resume — so a
 * console-side merge landing after the worker wrote would put the evidence-poor
 * copy into the permanent audit trail. Worker-side merge keeps the file right at
 * every point anything reads it.
 *
 * Same four tested properties as `askPrompt`: the sentinel leads, the word
 * "approved" appears nowhere, the re-stop instruction is given twice, and the
 * operator's words go through verbatim.
 */
import { EVIDENCE_REMINDER } from './evidence-reminder.js';
import type { EvidenceItem } from './evidence.js';
import type { ManualQa } from './manual-qa.js';

/** One step the operator ticked Failed, with the words they ticked it with. */
export type FailedStep = { id: number; rev: number; do: string; note: string };

/**
 * The console's own copy of what the gate held when a rework went out.
 *
 * It is the verification baseline AND the render fallback: if the worker comes
 * back having dropped a screenshot or a whole step, the card shows the console's
 * copy. Nothing the operator has already looked at disappears because a worker
 * fumbled a merge — and because the next snapshot is taken from the CARD rather
 * than from the file, that stays true across any number of rounds. It only ever
 * grows while one gate C stop is open.
 *
 * Stated exactly, because the difference matters at the moment it bites: what is
 * kept is the manifest ENTRY, not the bytes. The evidence route reads the image
 * live out of the worktree, so a worker that DELETES a capture defeats the
 * restore — the card would show a broken image. That case is detected and named
 * separately (`deletedEvidenceMessage`) rather than reported as a restore.
 */
export type QaSnapshot = {
  takenAt: string;
  /** The gate stop this was taken from, so a check never fires on the old file. */
  stoppedAt: string | null;
  /**
   * A hash of the raw `.gate.json` this was taken from — the console's OWN
   * discriminator for "the file has been rewritten since".
   *
   * `stoppedAt` cannot carry that alone, because the worker writes it. The
   * prompt lists the header fields to keep unchanged and a worker that reads the
   * stop stamp as one of them is being obedient — and when it did not move, the
   * whole return check never ran: nothing was compared, no drop was named, the
   * round sat at `sent` for ever and the card said "with Build now" underneath
   * a fix that was already on screen. Null only for a snapshot written before
   * this field existed, which reads as "fall back to the stamp".
   */
  gateHash: string | null;
  evidence: EvidenceItem[];
  /**
   * path -> a fingerprint of the bytes, for every evidence path that was a real
   * FILE when this baseline was taken.
   *
   * Absent from this map means "there was nothing on disk at that path either",
   * which is a manifest the worker never backed with an image — a different
   * complaint, and not one to accuse it of deleting anything over. Only a path
   * that was here and is now gone, or here and now different, is the worker
   * having moved something out from under a picture the operator was already
   * shown.
   */
  evidenceStamps: Record<string, string>;
  manualQa: ManualQa;
};

/** One dispatched rework. Append-only; a status moves, a record never dies. */
export type QaReworkEntry = {
  stepIds: number[];
  /** stepId -> the operator's words, kept so the card can show what was sent. */
  notes: Record<string, string>;
  sentAt: string;
  /** `queued` while it waits for a slot, `sent` once it is with the worker,
   *  `returned` once a new gate stop has been checked against the snapshot, and
   *  `cancelled` when a later message from the operator replaced it before it
   *  ever left. A cancelled round is not outstanding and is never checked for. */
  status: 'queued' | 'sent' | 'returned' | 'cancelled';
  /** Plain English, when the returned file dropped something it was told to
   *  carry. Null when the worker did as it was asked. */
  violation: string | null;
  /** Evidence paths the console had to put back from its own snapshot. */
  restored: string[];
};

/** The two markers the prior state rides behind. Asserted in the tests, and the
 *  only structure the payload has — everything after them is JSON. */
export const PRIOR_EVIDENCE_MARK = 'Prior "evidence" to carry forward verbatim, then append your new capture(s):';
export const PRIOR_MANUAL_QA_MARK =
  'Prior "manualQa" to carry forward verbatim — same ids, same order, same wording on every step you did not fix:';

/**
 * Compose the message a rework sends.
 *
 * The payload goes LAST, behind the two markers, so the instructions stay
 * readable at the head of the message and the JSON cannot be mistaken for part
 * of them.
 */
export function reworkPrompt(failed: FailedStep[], prior: QaSnapshot): string {
  const one = failed.length === 1;
  const blocks = failed.map((f) =>
    [
      `Step ${f.id} (rev ${f.rev}) — "${f.do}"`,
      `What the operator saw instead, their words verbatim:`,
      `  "${f.note}"`,
    ].join('\n'),
  );
  return [
    'GATE C QA REWORK — FAILED STEP(S) ONLY, NOT A FULL QA',
    '',
    `The operator ran the manual QA at gate C themselves. ${one ? 'One step' : `${failed.length} steps`} failed. Every`,
    'other step passed and its evidence STANDS — you will carry it forward untouched,',
    `byte for byte. Fix the named point${one ? '' : 's'} and come straight back to gate C. Gate C is`,
    'still OPEN and this message decides nothing.',
    '',
    ...blocks.flatMap((b) => [b, '']),
    'Do exactly this and nothing else:',
    '1. Fix the cause of what the operator saw. Build rules apply: a failing check first',
    '   where one fits, then the fix. Touch only what this fix needs.',
    `2. Re-capture evidence for the failed step${one ? '' : 's'} ONLY. Drive the app headlessly with`,
    "   the repo's own Playwright on localhost, same account, same fixture, and",
    '   screenshot the fixed step. Do NOT re-run the full manual QA. Do NOT',
    '   re-capture any passing step. Redoing the whole thing is a huge',
    '   waste of tokens and time and resources.',
    '3. Blast radius, RUN not photographed. From the diff of your own fix, list every',
    '   other QA step that exercises a file, route or component the fix changed.',
    '   Re-drive each of those headlessly and confirm its "after" still holds. No new',
    '   screenshots for those — say it in one "Confirmed:" bullet of the summary. If',
    '   a check fails, that step joins this rework: fix it, re-capture ITS evidence,',
    '   bump ITS rev, and run this step again from the new diff.',
    '4. Rewrite .gate.json: same "issue", "gate": "C", "stage": 5, same "sessionId",',
    '   "questions", "thread" and "quiz", and a FRESH "stoppedAt" for this stop —',
    '   it is a new stop, not the old one edited. The quiz only changes where this fix',
    "   changed an answer, or the operator's submitted answers stop matching for nothing.",
    '   - "summary": the same labelled bullets, edited only where a line stopped',
    '     being true. It is bullets, never a paragraph.',
    '   - "evidence": the prior array below FIRST, complete and verbatim — every',
    '     path, every caption — then your new capture(s) appended. Remove nothing:',
    '     the old failing screenshot stays, it is the before.',
    '   - "manualQa": the prior block below verbatim, same step ids in the same',
    '     order, same wording on every step you did not fix. Each FIXED step keeps',
    '     its id, bumps "rev" by exactly 1, sets "fix" (<= 15 words: what you',
    '     changed) and gets a NEW "afterShot" filename. Never overwrite or delete',
    '     an old capture.',
    '5. Stop at gate C again. Do NOT proceed to the next stage and do NOT touch the',
    '   PR. The gate passes only when a later message from the operator explicitly passes it.',
    '',
    // Before the payload, not after it: the JSON has to be the last thing in the
    // message (a worker reading from the end must find the array, and the tests
    // parse the tail), and a standing rule buried under two blobs of JSON is a
    // rule nobody reads.
    EVIDENCE_REMINDER,
    '',
    PRIOR_EVIDENCE_MARK,
    JSON.stringify(prior.evidence, null, 2),
    '',
    PRIOR_MANUAL_QA_MARK,
    JSON.stringify(prior.manualQa, null, 2),
  ].join('\n');
}

/**
 * What the card says when the returned gate file dropped evidence it was told to
 * carry forward.
 *
 * Stated as a fact with the remedy already applied: the console is showing its
 * own copy, so nothing is lost — but a silent repair would teach the worker
 * nothing and tell the operator nothing about the file their PR will be built
 * from.
 */
export function droppedEvidenceMessage(missing: string[]): string {
  const n = missing.length;
  return (
    `the rework dropped ${n === 1 ? 'a screenshot' : `${n} screenshots`} it was told to carry forward — ` +
    `the console is showing its own copy, so nothing you have already seen is missing from this card. ` +
    `The gate file itself is short of ${missing.join(', ')}.`
  );
}

/** What the card says when a rework dropped steps out of the click-script. */
export function droppedStepsMessage(missing: number[]): string {
  return (
    `the rework came back without step${missing.length === 1 ? '' : 's'} ${missing.join(', ')} — those steps were ` +
    `not the ones you failed, and dropping them takes their evidence and your ticks with them. Send feedback ` +
    `asking for the whole click-script back before you approve.`
  );
}

/**
 * What the card says when the returned file still LISTS a capture but the file
 * itself is gone.
 *
 * The distinction is the whole of it. A `QaSnapshot` holds `{kind, path,
 * caption}` — a path, not the bytes — and the evidence route reads live from the
 * worktree, so "the console is showing its own copy" is true of a dropped
 * manifest ENTRY and false of a deleted FILE. That case has to say so instead of
 * claiming a restore that will render as a broken image.
 */
export function deletedEvidenceMessage(gone: string[]): string {
  const n = gone.length;
  return (
    `the rework DELETED ${n === 1 ? 'a capture' : `${n} captures`} you have already been shown — ${gone.join(', ')}. ` +
    `The console keeps the manifest, not the image, so ${n === 1 ? 'it is' : 'they are'} gone from disk and cannot be ` +
    `put back. Ask for ${n === 1 ? 'it' : 'them'} to be re-captured before you approve.`
  );
}

/**
 * What the card says when a capture was REWRITTEN under its own filename.
 *
 * The evidence route serves `no-cache` and rounds reuse filenames, so this is a
 * different picture in the same frame — the card would show it under the caption
 * and the position of the one the operator already looked at, with nothing to
 * notice.
 */
/**
 * Name the file AND what happened to it. The first version of this said only
 * that a file had changed, and the operator had to go and diff it by hand to find
 * out that 95 lines had been added and none removed — a rework writing up its own
 * finding, which is the wanted outcome. A guard that cannot say what it saw makes
 * a person do its work.
 *
 * Pure additions to text no longer reach here at all (see #movedEvidence); what
 * does reach here is a rewrite, a mid-file edit, or a re-captured picture.
 */
export function rewrittenEvidenceMessage(changed: Array<{ path: string; added: number; removed: number }>): string {
  const n = changed.length;
  const detail = changed
    .map((c) => (c.added || c.removed ? `${c.path} (+${c.added} −${c.removed})` : c.path))
    .join(', ');
  return (
    `the rework rewrote evidence it was told to leave alone, under the same ` +
    `${n === 1 ? 'filename' : 'filenames'} — ${detail}. What is on the card at ${n === 1 ? 'that path' : 'those paths'} ` +
    `is no longer what you were shown, so a tick above it is vouching for something else. ` +
    `Only the step it was fixing should have moved. (Text that was only ADDED to does not ` +
    `land here — appending what it found is the outcome we want.)`
  );
}

/** What the card says when a queued rework was replaced before it ever left. */
export function cancelledReworkMessage(stepIds: number[]): string {
  const which = stepIds.length === 1 ? `step ${stepIds[0]}` : `steps ${stepIds.join(', ')}`;
  return (
    `. Your queued rework of ${which} is CANCELLED with it — that message was the only thing carrying the failed ` +
    `${stepIds.length === 1 ? 'step' : 'steps'} and the prior evidence forward, so send it again when you are ready.`
  );
}

/** What the card says when a rework walked past the gate it was sent to fix. */
export function chargedPastReworkMessage(): string {
  return (
    'the worker moved past gate C while it was only fixing a QA step you failed — nothing you sent passed ' +
    'the gate. Use "Reopen gate C" to bring the gate back; your ticks and the evidence are still on this card.'
  );
}
