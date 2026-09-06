/**
 * What a row LOOKS like: the chip's colour class, and the rail's left edge.
 *
 * The operator asked for colour coding on the pills and the issue cards, so that
 * opening the console makes it obvious what the status of each row is, and which
 * of them something is actively happening on.
 *
 * TWO BUGS, not a redesign. The palette in `styles.css` was already deliberate
 * and each colour already carried a stated meaning; it was simply not applied to
 * most of the page:
 *
 *   1. SEVEN of the sixteen statuses fell through the Chip's ternary to `''`.
 *      Two of them — `checkpoint` and `detached` — are work that STOPPED and
 *      will never restart itself, and they rendered pixel-identical to `queued`
 *      and `pr-open`, which need nothing from the operator. A dead worker and a
 *      healthy PR under review were the same colour.
 *   2. The rail's orange edge was `.rail-item.on.gate`, requiring the row to be
 *      SELECTED. The mark that says "this one is asking you something" only
 *      appeared once the operator had already clicked it.
 *
 * So: no new hues. One hue, one meaning, everywhere.
 *
 *   orange  a question is being held for you, or work stopped and is waiting
 *   ice     a worktree exists and nothing is running in it
 *   green   a machine is moving RIGHT NOW  (tinted, with a pulse)
 *   violet  the work is done and somebody else has to merge it
 *   --ok    it landed                       (outline only, no tint, no pulse)
 *   red     it broke, or a person sent it back
 *   grey    somebody else is moving it
 *   faint   nothing here yet, or nothing left
 *
 * The two greens are close enough to read as one colour (ΔE 6.4, and no better
 * under any form of colour blindness), so hue is deliberately NOT the channel
 * separating them: `active` is tinted and pulses, `merged` is a bare outline.
 * Motion and fill carry that distinction, and both survive colour blindness
 * entirely.
 */
import type { IssueRow, WorkerStatus } from './types';
import { ORANGE, isAside, isUatFail, waitingOnYou } from './priority';

/** Everything either function reads. Keeps both testable without a browser. */
export type Lookable = Pick<IssueRow, 'status' | 'uatFail' | 'waiting' | 'parked'>;

/**
 * The chip's colour class. `''` is a DECISION now, not a leftover default: it
 * is the grey that means "somebody else is moving this on", and exactly three
 * statuses get it.
 */
export function chipClass(row: Pick<Lookable, 'status' | 'parked'>): string {
  const s: WorkerStatus = row.status;
  // FIRST, above everything including the orange gates. The operator parked this
  // row, or a named person owes a reply on it: either way nothing is going to
  // happen and it must stop shouting. The chip's TEXT is untouched — a parked row
  // at gate C still reads "AT GATE C", because it is still at gate C — so what
  // this removes is the volume, not the fact. See `isAside`.
  if (isAside(row)) return 'aside';
  if (ORANGE.includes(s)) return 'gate';
  // Its own look. Paused must never read as active (it is not working) and never
  // as orange (nothing is being asked of you) — a held state with one button.
  if (s === 'paused') return 'paused';
  // `preparing` joins `active`: a script IS running. It only lasts seconds now
  // that `npm install` has gone from that path, so this is honesty rather than a
  // headline — but a row doing something should never look like a row doing
  // nothing.
  if (s === 'active' || s === 'preparing') return 'active';
  // The gap that mattered most. Both are STOPPED — priority.ts: "nobody is
  // working these any more, so they are on the operator again" — and both used
  // to render as plain grey. They share `--ice` with `paused` but NOT its class:
  // the paused chip carries a solid square meaning "frozen with SIGSTOP, nothing
  // lost, one click resumes", and neither a checkpoint nor a dead worker holds a
  // frozen process. Same colour, one fewer false implication.
  if (s === 'checkpoint' || s === 'detached') return 'held';
  // Ice too, and for the one thing about this row that WAS read: there is a
  // worktree on disk and nothing is running in it. It is not `held`'s other
  // meaning — nobody has established that this work stopped — but ice is the
  // only colour here that states a local fact rather than a claim about GitHub,
  // and the grey below would say "somebody else is moving it", which is exactly
  // the assertion the console has just failed to make.
  if (s === 'unreadable') return 'held';
  // A fact read off GitHub, so it keeps its own colour. `pr-merged` sinks in the
  // ORDER because QA picks merged work up unasked — six for six, no handover
  // comment ever posted — but that is an inference about a team's habit, and the
  // sort is the right place to spend it. The chip states what is verified: it
  // landed. If the habit ever changes, one surface is still telling the truth.
  if (s === 'pr-merged') return 'merged';
  if (s === 'failed') return 'failed';
  // Nothing started yet, or nothing left to do.
  if (s === 'no-worker' || s === 'done') return 'none';
  // AWAITING MERGE, and now its own colour. The operator asked for PR Open to
  // get its own colour on the overview page too, because those rows are now
  // awaiting merge.
  //
  // It shared the grey with `queued` under one true sentence — somebody else is
  // moving it — which turned out to cover two states that are nothing alike.
  // `queued` is work that has not begun, waiting for a slot on THIS machine and
  // entirely in the operator's gift; `pr-open` is work that is finished, out of
  // their hands, and waiting on the team lead. On a grid scanned for "what is
  // nearly done", those are the two rows that most need separating.
  //
  // WHY A NEW HUE rather than a shade of the two already on the PR path. `--ok`
  // is "it landed" and `--live` is "moving right now", and the note above is
  // explicit that hue is NOT what separates those two — they are 6.4 ΔE apart
  // and rely on fill and motion instead. A third green would have to be told
  // apart from both on the same two channels, and a tinted green with no pulse
  // is exactly what `active` looks like when its animation is off (see the
  // reduced-motion rule in styles.css). Violet is the nearest hue that collides
  // with nothing: not the orange gate, not either green, not the red, and not
  // the slate `--ice`.
  //
  // It applies EVERYWHERE, not only on the grid it was asked about. "One hue, one
  // meaning, everywhere" is the whole point of this file; a colour that meant
  // "awaiting merge" on the Overview tab and nothing on the ticket list would be
  // two answers to one question on one screen.
  if (s === 'pr-open') return 'handover';
  // What is left in the grey: work that has not started, waiting for a slot
  // here. `blocked` used to be in this list and is now `aside` above — which is
  // the correction the operator asked for. A comment sitting unanswered by a
  // named person and a pull request under review rendered PIXEL-IDENTICAL, and
  // they are opposites: one is stalled, the other is progressing without you.
  return '';
}

/**
 * The rail's left edge, which answers ONE question: is this row asking
 * something of me right now?
 *
 * It reads the same inputs the list ORDER reads, deliberately. `isElsewhere` in
 * priority.ts exempts an open PR whose `waiting.yours` is non-empty, so such a
 * row does not sink and can sit high in the list while its own card reads "Not
 * ticked on PR #4547". If the edge keyed on status alone, the row's position
 * would say "yours" and its colour would say "not yours" — two panels on one
 * screen answering the same question differently, which is the exact complaint
 * `waiting.ts` was written to end.
 *
 * `no-worker` is left unmarked on purpose: it is every newly assigned issue in
 * the repo, and edging the whole backlog would turn the signal into wallpaper.
 * Available is not the same as asking.
 */
export function edgeClass(row: Lookable): string {
  // FIRST, and above the red — for the same reason the sink in `compareIssues`
  // is above the UAT key. The edge must read the same inputs the ORDER reads or
  // the two disagree on one screen, and the order has already decided this row
  // is out of the running. A parked row shouting in red from the bottom of the
  // list would be the worst of both. Its own cold edge says where it is.
  if (isAside(row)) return 'aside';
  // A person tested shipped work and sent it back. Louder than anything else,
  // and already the only 3px edge on the page.
  if (isUatFail(row)) return 'uat';
  // Both halves of "is this asking something of me": the statuses that stop on
  // the operator, and an open or merged PR still holding items of theirs — the
  // server's own `waiting.yours`, the same list the card prints. That second
  // half used to be a separate check here, which is how it came to be the ONLY
  // surface reading it: the header count next to this edge kept its own
  // status-only answer. It now lives inside `waitingOnYou`, so the edge, the
  // count and the order cannot drift apart again.
  if (waitingOnYou(row)) return 'gate';
  return '';
}
