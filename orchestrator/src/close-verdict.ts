/**
 * WHAT QA HAD SAID AT THE MOMENT THE TICKET WAS CLOSED.
 *
 * A close is the console's own end of the line — `deriveStatus` returns `done`
 * for it, the rail sinks the row to the floor and every card stops asking for
 * anything. That ending was inferred rather than read: the row said *"closed —
 * PR #N merged and QA signed it off"* because it was closed, not because
 * anybody had signed anything off. Over 105 closures, 28 carried no QA
 * verification at all and four were closed while a human's `Fail` or
 * `Partial Pass` still stood (#4619, #5019, #5139, #4344) — and a bot promotion
 * closing a ticket rendered identically to a tester closing one they had
 * verified.
 *
 * So the verdict is READ at the close and written down, and the row says which
 * of the four it was.
 *
 * **Record-once, never rewritten.** The whole value is in the tense. A `Pass`
 * posted a week after the close must not retroactively make the close look
 * verified, and a fail cleared later does not un-close a ticket that was closed
 * over it. The first sighting is the record, exactly as `boardMoves` and
 * `reopenings` beside it are facts rather than current state.
 *
 * **What the console arriving late can and cannot claim.** The record is written
 * the first time a poll sees the issue closed, which is usually within a poll of
 * the close and occasionally days after it — a console that was down, or a fresh
 * `state.json`. That gap is not modelled, because the three verdicts that are
 * ever said out loud survive it:
 *
 *  - `none` read late is if anything STRONGER evidence. Reading later means
 *    seeing more comments, so "nobody has ever posted a verdict" said on Friday
 *    covers Tuesday's close too;
 *  - `fail` and `partial` read late are verdicts that STILL stand right now, and
 *    the newest verdict wins — a later `Pass` would have displaced them;
 *  - `pass` read late is the only one that could flatter a close, and it is the
 *    one the row says nothing loud about.
 *
 * **Absence is not `none`.** An issue the console could not read a verdict for
 * gets no record at all, and its row goes on saying exactly what it said before.
 * `none` means "the console looked at the comments and there was no verdict";
 * a missing record means "it never looked". Same rule as `OrphanIssue`'s
 * `unread`: the console does not fill a hole with a comfortable answer.
 *
 * Pure — sightings in, records out. `orchestrator.ts` owns the reading and the
 * writing, and the verdict itself is resolved by `newestUatVerdict` in
 * actions.ts, so there is exactly one implementation of "is this a human UAT
 * verdict" in this console.
 */

import type { UatVerdictKind } from './uat.js';

/**
 * What QA had said. Four states, and `none` is the one the retrospective is
 * about — it is a finding, not a missing value.
 */
export type CloseVerdictKind = 'pass' | 'fail' | 'partial' | 'none';

export type CloseVerdict = {
  /** GitHub's own close stamp. Null when GitHub gave none. */
  closedAt: string | null;
  verdict: CloseVerdictKind;
  /** The human who gave that verdict. Null on `none`: nobody gave one. */
  by: string | null;
  /** When the console wrote this down — which is not the close time. See the
   *  preamble on what a late reading can and cannot claim. */
  at: string;
};

/** One issue a poll has just read as closed, with the newest human UAT verdict
 *  the same poll could see on it. */
export type ClosedSighting = {
  issue: number;
  closedAt: string | null;
  /** Null when there is no human verdict on the issue — which is the finding. */
  verdict: { verdict: UatVerdictKind; by: string } | null;
};

const KIND: Record<UatVerdictKind, CloseVerdictKind> = {
  Pass: 'pass',
  Fail: 'fail',
  'Partial Pass': 'partial',
};

/** The record one sighting produces. Exported for the tests and for the one
 *  caller; `recordCloses` is what the poll uses. */
export function verdictAtClose(sighting: ClosedSighting, now: Date): CloseVerdict {
  const v = sighting.verdict;
  return {
    closedAt: sighting.closedAt,
    verdict: v ? KIND[v.verdict] : 'none',
    by: v ? v.by : null,
    at: now.toISOString(),
  };
}

/**
 * Write down every close this poll is the first to see.
 *
 * `added` is what the caller logs and what tells it whether the state file needs
 * writing — an unchanged poll must not rewrite `state.json` for nothing.
 */
export function recordCloses(
  held: Readonly<Record<string, CloseVerdict>>,
  sightings: readonly ClosedSighting[],
  now: Date,
): { verdicts: Record<string, CloseVerdict>; added: number[] } {
  const verdicts: Record<string, CloseVerdict> = { ...held };
  const added: number[] = [];
  for (const s of sightings) {
    const key = String(s.issue);
    if (verdicts[key]) continue; // record-once: the first sighting is the record
    verdicts[key] = verdictAtClose(s, now);
    added.push(s.issue);
  }
  return { verdicts, added };
}

/** How a verdict is named in a sentence, in the tester's own vocabulary. */
const SAID: Record<CloseVerdictKind, string> = {
  pass: 'Pass',
  fail: 'Fail',
  partial: 'Partial Pass',
  none: '',
};

/**
 * The whole `statusDetail` for a closed row.
 *
 * Here rather than in status.ts so the row's card and the status line beside it
 * cannot word one fact two ways — the same reason `sentBackDetail` is a function
 * and not four string literals.
 *
 * A null record keeps the sentence the row has always had. That default is an
 * inference — a close is not a sign-off — but it is the inference absence has
 * overwhelmingly meant, and it is only ever reached now when the console has not
 * looked. Where it HAS looked, it says what it saw.
 */
export function closedDetail(v: CloseVerdict | null, pr: number | null): string {
  const merged = pr === null ? null : `PR #${pr} merged`;
  if (v === null) {
    return merged ? `closed — ${merged} and QA signed it off` : 'closed on GitHub';
  }
  if (v.verdict === 'none') {
    // The exact words the row is read for. 28 of 105 closures were this.
    return merged ? `closed — ${merged}, with no QA verdict recorded` : 'closed with no QA verdict recorded';
  }
  if (v.verdict === 'pass') {
    const who = v.by ? `${v.by} passed it in QA` : 'QA passed it';
    return merged ? `closed — ${merged} and ${who}` : `closed — ${who}`;
  }
  // Fail or Partial Pass still standing. The louder `sentBack` sentence usually
  // gets here first — it names the verdict off the live feed — so this is the
  // reading for a feed that is empty or stale, and it must not read as milder.
  const who = v.by ? `${v.by}'s ${SAID[v.verdict]}` : `a ${SAID[v.verdict]}`;
  return `closed while ${who} still stood — nothing has re-verified it`;
}

/**
 * One finished sentence for the closed row's card, under "Closed on GitHub".
 *
 * Composed here and rendered by the page, on the standing rule that the server
 * writes the words — the same shape `CaptureReport.line` uses.
 */
export function closeLine(v: CloseVerdict): string {
  if (v.verdict === 'none') {
    return 'No QA verdict was recorded — nobody posted a Test Result on it before it was closed.';
  }
  if (v.verdict === 'pass') {
    return v.by ? `${v.by} passed it in QA before it was closed.` : 'QA passed it before it was closed.';
  }
  const who = v.by ? `${v.by}'s ${SAID[v.verdict]}` : `a ${SAID[v.verdict]}`;
  return `Closed while ${who} still stood — nothing has re-verified it since.`;
}
