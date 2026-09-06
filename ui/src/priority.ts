/**
 * Which issue is looked at first.
 *
 * The repo's priority axis is exactly five labels — P0, P1, P2, P3, icebox —
 * and every one of them is set by a human at triage. An issue with none of them
 * is **untriaged**, which is a different thing from P2: P2 is the stated default
 * for real work, but nobody has said so about this issue yet, and a list that
 * quietly files the un-ranked under "normal" hides exactly the issues triage
 * still owes an answer on.
 *
 * **There is exactly ONE triage signal, and it is that band.** The repo applies
 * the `needs-triage` label *because* priority was left off — its own CLAUDE.md
 * says to leave priority off and let triage set it — so the label and an empty
 * priority axis are the same fact said twice. The console says it once, in the
 * pill, and calls it **needs triage** wherever a person can read it. An issue
 * carrying a priority label AND a stale `needs-triage` shows its priority: that
 * is the more specific, more useful answer.
 *
 * The second, genuinely separate fact is **self-filed** (`row.selfFiled`): the
 * issue was raised from this machine and the repo's autoassign workflow handed it
 * straight back. Provenance, not worth — a teammate's issue is never marked with
 * it, however untriaged it is.
 *
 * The two TOGETHER are the only combination the ordering acts on: an issue this
 * laptop raised that nobody outside it has ranked is the least likely thing to be
 * the right next piece of work. It sinks inside its band — never out of its band,
 * and never hidden.
 *
 * All of this is read off the row the state already carries — the server does no
 * ordering and needs no change.
 */
import type { IssueRow, ParkedStamp, WorkerStatus } from './types';

export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'untriaged' | 'icebox';

/** Most urgent first. `icebox` sits BELOW `untriaged`: not-yet-ranked still
 *  wants an answer, whereas iceboxed has had one — "not scheduling". */
export const BANDS: readonly Priority[] = ['P0', 'P1', 'P2', 'P3', 'untriaged', 'icebox'];

const FROM_LABEL: Record<string, Priority> = { p0: 'P0', p1: 'P1', p2: 'P2', p3: 'P3', icebox: 'icebox' };

const rank = (p: Priority): number => BANDS.indexOf(p);

export function isPriorityLabel(label: string): boolean {
  return label.trim().toLowerCase() in FROM_LABEL;
}

/** The repo's own label for "triage has not set a priority on this one". It is
 *  never a chip of its own — the pill already says it. */
export const NEEDS_TRIAGE = 'needs-triage';

export function isTriageLabel(label: string): boolean {
  return label.trim().toLowerCase() === NEEDS_TRIAGE;
}

/**
 * The band an issue sits in. Two priority labels on one issue is a triage
 * mistake rather than a state to model, so the most urgent of them wins — that
 * way `P2` + `icebox` reads as P2 and never disappears down the list.
 */
export function priorityOf(labels: string[]): Priority {
  let found: Priority | null = null;
  for (const label of labels) {
    const p = FROM_LABEL[label.trim().toLowerCase()];
    if (p && (found === null || rank(p) < rank(found))) found = p;
  }
  return found ?? 'untriaged';
}

/**
 * Nobody has ranked this yet — the one triage question, asked once.
 *
 * It is the empty priority axis, not the label: the label exists because the
 * axis is empty, and an issue that has been ranked has been triaged whatever
 * labels are still hanging off it.
 *
 * A QUESTION ABOUT LABELS ONLY. Whether the console should still be ASKING it is
 * `needsTriage` below, which is the one every surface reads.
 */
export function awaitingTriage(labels: string[]): boolean {
  return priorityOf(labels) === 'untriaged';
}

/**
 * The issue is CLOSED on GitHub.
 *
 * Two ways to know, and both are needed. `status === 'done'` is the ordinary
 * one, and it covers the row GitHub could not be read for as well — absence has
 * overwhelmingly meant a close. `orphan.reason === 'closed'` is the one that
 * catches the case the status cannot: `deriveStatus` returns the gate, the
 * queue place or the failure BEFORE it ever reaches its closed branch, so a
 * worker parked at gate C on a ticket QA closed yesterday reads `at-gate` — and
 * #5697 was exactly that, closed and signed off with a worker still on it.
 *
 * `orphan` is optional on the wire, so an older server's rows fall back to the
 * status alone rather than reading as open. Same rule `isParked` and `isUatFail`
 * keep: a field that is not there decides nothing.
 */
export function isClosedIssue(row: Pick<Sortable, 'status' | 'orphan'>): boolean {
  return row.status === 'done' || row.orphan?.reason === 'closed';
}

/**
 * IS THERE STILL A TRIAGE QUESTION HERE? The predicate every triage surface
 * reads — the priority pill, the caution above the start button, and the sink
 * inside a band.
 *
 * A closed issue is excluded, whatever its labels say. 33 of 105 closed issues
 * still carried `needs-triage` at the close, because nothing ever takes the
 * label off — and the console cannot take it off either: it never writes labels
 * to GitHub, by a fence that is not being loosened for a tidy-up. So it stops
 * ASKING instead. Ranking work that is finished is not a question anybody can
 * answer, and a pill reading "needs triage" over a signed-off ticket is the list
 * lying about what is left to do.
 *
 * This is exclusion from the QUESTION, never from the record: the label itself
 * still shows in the row's own label line, and the issue on GitHub is untouched.
 */
export function needsTriage(row: Pick<Sortable, 'labels' | 'status' | 'orphan'>): boolean {
  return !isClosedIssue(row) && awaitingTriage(row.labels);
}

/** What the pill SAYS. The band is called `untriaged` in the code and reads
 *  "needs triage" on screen, so there is one vocabulary in front of a person. */
export function bandLabel(p: Priority): string {
  return p === 'untriaged' ? 'needs triage' : p;
}

/** Orange (needs you) for a gate, a comment to post, a reply landed, and a review
 *  requesting changes. Everything else is quiet. */
export const ORANGE: WorkerStatus[] = ['at-gate', 'awaiting-post', 'reply-received', 'rework'];

/**
 * Nobody is working these any more, so they are on the operator again.
 *
 * Separate from ORANGE on purpose: ORANGE is "the console is holding a question
 * for you", these are "the work stopped and nothing will move it on its own".
 * Both belong on the list of what needs the operator; only these mean something
 * went wrong. `blocked` is deliberately in neither — it is waiting on somebody
 * other than the operator. If that ever changes it goes into ORANGE at this
 * definition, never into the card that reads it.
 */
export const STOPPED: WorkerStatus[] = ['checkpoint', 'failed', 'detached'];

/**
 * SET ASIDE BY YOU. The operator asked to be able to pause a ticket: it can stay
 * at its gate, but it must not appear at the top of the queue, and the row has to
 * say plainly that it is paused.
 *
 * `!= null` rather than `!== null`, on the same rule as `isUatFail`: a rebuilt
 * `ui/dist` talking to a server that has not restarted sends rows with NO
 * `parked` field, and `undefined !== null` would park every issue on the board
 * at once. Absent is not parked.
 */
export function isParked(row: { parked?: ParkedStamp | null }): boolean {
  return row.parked != null;
}

/**
 * NOT COMPLETE, AND AWAITING — the one class the operator asked for, with two
 * members.
 *
 * The same UI has to cover blocked, so it is clear which rows are not complete
 * and awaiting. Parked and blocked are different CAUSES with the same
 * consequence: nothing is going to happen on this row, and it is not going to
 * happen for a reason nobody is currently acting on. The operator parked it, or a
 * named person owes a reply that has not come. Either way it should not be at the
 * top of the list, and either way it has to stay findable.
 *
 * What is deliberately NOT in here is the third state, and it is the one that
 * makes the class mean anything: `pr-open` — a pull request with a reviewer or a
 * codeowner team holding it — is PROGRESSING WITHOUT THE OPERATOR. It is not
 * stalled.
 * `waiting.ts` already draws that line between `on` (other people) and `yours`,
 * and `blocker.ts` works out which named party actually holds the merge. This
 * predicate must never be widened to `isElsewhere`, which would swallow
 * `pr-open` and `pr-merged` and flatten the exact distinction those two files
 * exist to make.
 *
 * `done` is excluded because it has its OWN, lower sink one line down in
 * `sunk()`: a closed issue is not "awaiting", it is finished, and it must stay
 * the floor of the list. Without this exclusion a parked ticket and a closed one
 * would swap places in the two-key comparison.
 */
export function isAside(row: Pick<Sortable, 'status' | 'parked'>): boolean {
  if (row.status === 'done') return false;
  return isParked(row) || row.status === 'blocked';
}

/**
 * How far DOWN the list a row is pushed before anything else is considered.
 * Three levels, and this is the whole of the operator's "not at the top of the
 * queue".
 *
 *   0  in the list, ordered by everything below
 *   1  set aside or stalled — parked, or blocked on a named person
 *   2  finished — closed on GitHub
 *
 * A SORT KEY, not a section and not a fold, and the choice is worth stating.
 * The rail is one flat scroll with exactly one ordering, and the `done` sink
 * beside this already works this way: closed rows fall to the bottom and are
 * drawn compact and faded (`.rail-item.finished`), with no header over them and
 * nothing to expand. Adding a titled section or a collapsible fold would put a
 * second navigation idiom into a list that has one, for a group that is usually
 * two or three rows long. And a fold HIDES: the operator has to be able to find a
 * parked ticket weeks later, and a state you cannot see is a state that rots.
 * Sinking keeps every parked row in the same scroll, in the same list, one flick
 * away, with its gate and its priority still printed on it.
 *
 * Note this sits ABOVE the UAT send-back key, which is otherwise the one thing
 * that beats every band. That is deliberate: parking is the most recent explicit
 * statement the operator has made about the row, made with the send-back already
 * on screen. A parked ticket that still shouted from the top would be the feature
 * failing on exactly the rows it is most needed for.
 */
function sunk(row: Pick<Sortable, 'status' | 'parked'>): number {
  if (row.status === 'done') return 2;
  if (isAside(row)) return 1;
  return 0;
}

/** Everything on the list of what needs you: a question the console is holding,
 *  or work that stopped and will not restart itself.
 *
 *  A PARKED row is not on that list, whatever its status. This is the header
 *  count, the Dashboard's "Waiting on you" card and the rail's orange edge, all
 *  three, and a ticket you deliberately set aside must not go on adding itself
 *  to the number you read the console for. It has not stopped being at its gate
 *  — it has stopped being an answer to "what should I do next", which is the
 *  only question this predicate is asked.
 *
 *  `waiting.yours` IS ON THE LIST TOO, and it was the last surface that did not
 *  read it. `courtOf` promotes such a row out of `elsewhere` and `edgeClass`
 *  gives it the orange edge — so a draft PR could sit at the top of the rail,
 *  edged orange, its own card headed "For you to follow up", and be absent from
 *  the "N waiting on you" count in the header directly above it. Three surfaces,
 *  two answers. The status alone cannot see these: `pr-open` is the same status
 *  whether GitHub has a codeowner reading the diff or has shown it to nobody.
 *
 *  It stays a NON-EMPTY check on the server's own list, not a status of its own:
 *  `waiting()` already decides what counts (it returns null for a live worker,
 *  and stays silent for a gate or a rework round, both of which have louder
 *  cards), so this cannot double-count what those surfaces already say. An
 *  ABSENT `waiting` — a rebuilt `ui/dist` in front of a console that has not
 *  restarted — adds nothing, the same way `courtOf` reads it. */
export function waitingOnYou(row: {
  status: WorkerStatus;
  parked?: ParkedStamp | null;
  waiting?: Sortable['waiting'];
}): boolean {
  if (isParked(row)) return false;
  if (ORANGE.includes(row.status) || STOPPED.includes(row.status)) return true;
  return (row.waiting?.yours.length ?? 0) > 0;
}

export function needsYou(row: { status: WorkerStatus }): boolean {
  return ORANGE.includes(row.status);
}

/** Everything the ordering reads. Anything with these fields can be sorted,
 *  which is what lets the comparator be tested without a browser. */
export type Sortable = Pick<
  IssueRow,
  'labels' | 'status' | 'updatedAt' | 'selfFiled' | 'uatFail' | 'waiting' | 'parked' | 'orphan'
> & {
  /** 1-based place in the dispatch line, or null when it is not in it. The
   *  server computes it from `queue.list()` — see the key that reads it. */
  queuePosition?: number | null;
};

/**
 * Whose hands the row is in. Three tiers, and the middle one was a correction.
 *
 * The operator asked, first, that issues NOT with them sink towards the bottom of
 * the list and move back up when they are back on them. That gave one question —
 * **if the operator goes away for a week, does this row move on its own?** — and
 * a binary answer.
 *
 * Then, on seeing it: work being ACTIVELY worked on should be prioritised UP the
 * queue, because actively worked on means it is with them. That is right, and the
 * binary was the bug: it put a worker running on the operator's OWN machine, on
 * the operator's OWN issue, likely to come back within the hour, in the same
 * bucket as a PR that has sat with the codeowner team for days. Both answer "yes,
 * it moves" — which is where the first question stops being useful.
 *
 * The second question is WHOSE machine. And a third, after the operator saw the
 * result — an active issue drawn far down the list, below even the tickets with
 * no workers on them — separates work nobody has touched from work that is
 * standing still waiting for an answer:
 *
 *   yours      nothing happens until you act    gates, stopped, failed,
 *                                               detached, paused
 *   live       your worker is on it right now   active, preparing
 *   unstarted  available to pick up             no-worker
 *   elsewhere  other people, other queues       queued, blocked, pr-open,
 *                                               pr-merged
 *
 * `no-worker` was in `yours` because only the operator can start one. True, and
 * the wrong conclusion: an issue nobody has opened is AVAILABLE, not asking.
 * Nothing is standing still waiting on an answer, and it has no more claim on the
 * top of the list than the backlog it came from. It stays above `elsewhere`
 * because picking it up is still the operator's move and nobody else's.
 *
 * `queued` stays in `elsewhere` on purpose: the ask was about work being ACTIVELY
 * worked on, and a queued issue is waiting for a slot, not being worked. It lifts
 * itself the moment the dispatcher starts it.
 *
 * This is also, exactly, the colour order: orange, then green, then grey, then
 * the faded closed rows. The rail explains its own sort.
 *
 * The set is CLOSED, and `EXHAUSTIVE` below makes the compiler say so. `ORANGE`
 * and `STOPPED` are open partial lists with no such guard, which is precisely
 * how `paused` ended up in neither of them — a floor-paused worker only ever
 * restarts on a click (`unpauseWorker`: "Always a click — the automation never
 * resumes anything"), so it must not sink.
 *
 * `pr-merged` SINKS, and it is the one worth explaining, because the obvious
 * reading is wrong. Stage 9 exists and its step 3 says to hand QA a ready
 * verification script on the issue — which makes a merged PR look like it is
 * waiting on the operator to post something. It is not: telling QA to pick merged
 * work up is not the operator's job, and the record agrees six times out of six.
 * #4334, #4336, #4342, #4487, #4491 and #4546 were all found, tested and closed
 * by QA (qa-alice, qa-bob) with NO handover comment from anyone, on a strikingly
 * regular 17.7–22.5 hour cycle from merge. The handover comment has never once
 * been posted in this repo. A merged PR moves on its own.
 *
 * The one thing that genuinely does not move on its own after a merge is the
 * 1.2 GB of `node_modules` Stage 9 clears — housekeeping, not a decision, and
 * not a reason to hold a row at the top of the list. And if QA sends the work
 * back, that arrives as `uatFail`, which already outranks everything including
 * P0 two keys above this one.
 *
 * `yours` is the DEFAULT, deliberately: a status added later and forgotten here
 * keeps its place in the list rather than silently dropping off the bottom.
 */
export type Court = 'yours' | 'live' | 'unstarted' | 'elsewhere';

/**
 * Which tier each of the 17 statuses is in. Exhaustive by type, so adding a
 * status to `WorkerStatus` without deciding its tier breaks the build, on
 * purpose — `ORANGE` and `STOPPED` are open partial lists with no such guard,
 * which is exactly how `paused` came to be in neither of them.
 */
const COURT: Record<WorkerStatus, Court> = {
  // Your worker is on it right now.
  active: 'live',
  preparing: 'live',

  // Other people, or other queues. Nothing here is being worked on by you.
  queued: 'elsewhere', // waiting for a slot — the dispatcher starts it, not you
  blocked: 'elsewhere', // a named person owes a reply
  'pr-open': 'elsewhere', // reviewers and CI
  // QA finds merged work themselves, next day, without being told. Six for six,
  // with no handover comment ever posted in this repo.
  'pr-merged': 'elsewhere',

  // Nothing happens until the operator acts.
  'at-gate': 'yours',
  'awaiting-post': 'yours',
  'reply-received': 'yours',
  rework: 'yours',
  checkpoint: 'yours',
  failed: 'yours',
  detached: 'yours',
  // A floor-paused worker only ever restarts on a click — `unpauseWorker`:
  // "Always a click — the automation never resumes anything".
  paused: 'yours',

  // Available to pick up. Only the operator can start one, but nothing is waiting
  // on an answer, so it does not belong among the rows that are.
  'no-worker': 'unstarted',

  // THE CONSOLE COULD NOT READ IT, and the tier is decided by this file's own
  // test — if the operator goes away for a week, does this row move on its own?
  // Yes: the next successful poll replaces it with whatever the row actually is,
  // and nothing here is holding a question for them. That rules `yours` out even
  // though `yours` is the default, and it is the only tier that would repeat the
  // incident — 21 rows shouting from the top of the list with nothing to do
  // about any of them. The degraded poll says so ONCE, in the banner.
  //
  // Not `unstarted` either: "available to pick up" is an invitation to start a
  // worker on an issue whose PR may already have merged, which is the one costly
  // thing a row in this state could get somebody to do.
  unreadable: 'elsewhere',

  // Finished, and sunk by its own rule one key earlier. Never reached here.
  done: 'yours',
};

/** Sort order of the tiers. Only the relative order matters. */
const COURT_RANK: Record<Court, number> = { yours: 0, live: 1, unstarted: 2, elsewhere: 3 };

/**
 * Whose hands is this row in?
 *
 * The status decides it, with one exception: an open or merged PR can still be
 * holding something of YOURS. `waiting.yours` is the server's own list of those
 * items — the same list the card prints — and a row whose card reads "You asked
 * a question on 7 Aug and nobody has answered" must not also be filed under "not
 * with me". Two panels on one screen giving opposite answers to "is this mine"
 * is the exact complaint `waiting.ts` was written to end.
 *
 * An ABSENT `waiting` is not an exemption. An older console, or a rebuilt
 * `ui/dist` talking to a server that has not restarted, sends no `waiting` at
 * all; treating that as "there are items" would pull every open PR in the repo
 * back up at once — the same trap the `!= null` guard on `uatFail` avoids.
 *
 * A LIVE row is never promoted this way. A running worker holds no question for
 * the operator — `waiting()` suppresses its card for that very reason — so there
 * is nothing there to rescue, and reading a stale `waiting` on a row a worker has
 * since picked up would put it back in their group while it is mid-flight.
 */
export function courtOf(row: Pick<Sortable, 'status' | 'waiting'>): Court {
  const court = COURT[row.status];
  if (court === 'elsewhere' && (row.waiting?.yours.length ?? 0) > 0) return 'yours';
  return court;
}

/** Kept as its own name because it reads better at the call sites that only care
 *  whether the row has left the operator: `elsewhere` is the only tier that has. */
export function isElsewhere(row: Pick<Sortable, 'status' | 'waiting'>): boolean {
  return courtOf(row) === 'elsewhere';
}

/**
 * The one fact that outranks every band: a human tested the shipped work in UAT
 * and sent it back. The work already merged, a person has already tested it, and
 * QA is standing still until the fix lands.
 *
 * It reads the SERVER'S stamp and nothing else. `row.uatFail` is set by one
 * predicate (`orchestrator/src/uat.ts`) that requires a real person, not this
 * console's own account, posting the QA template on the ISSUE after the merge.
 * The page must never key this off a label: `changes-requested` belongs to the
 * pre-merge review bot and lands on essentially every feature PR, and
 * `human-review-needed` is never removed at all — either would put the top of
 * the list permanently on fire.
 *
 * Deliberately NOT a sixth `Priority`. `priorityOf` maps labels to a band, and
 * there is no label for this; a fake band would make the priority pill lie about
 * what triage decided. It is a tier above the bands, and the bands still order
 * everything below it — and break ties inside it.
 */
export function isUatFail(row: Pick<Sortable, 'uatFail'>): boolean {
  const f = row.uatFail;
  // `!= null` on purpose, not `!== null`: an older console — or a rebuilt
  // `ui/dist` talking to a server that has not restarted yet — sends a row with
  // no `uatFail` at all, and `undefined !== null` would put every issue in the
  // repo into the top band at once.
  // A `Pass` verdict is the good news that RETIRES a fail; it is never fix-first.
  return f != null && f.verdict !== 'Pass';
}

/**
 * Raised from this machine AND still unranked — the one combination that means
 * nobody but this laptop has said this is worth doing. It is the caution shown
 * on the start card, and the only thing the ordering does with either fact.
 *
 * Through `needsTriage`, so a closed issue is out of it: the caution sits above
 * a button that would start work, and there is no work to start on a ticket QA
 * has signed off.
 */
export function selfFiledNeedsTriage(row: Pick<Sortable, 'labels' | 'selfFiled' | 'status' | 'orphan'>): boolean {
  return row.selfFiled && needsTriage(row);
}

/** An unreadable timestamp sorts last within its band rather than throwing the
 *  whole comparison into NaN, which would leave the order arbitrary. */
const at = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** Oldest-first needs the opposite guard: an unreadable verdict date sorts LAST
 *  inside the send-back group, where `at()`'s 0 would jump it to the very top. */
const askedAt = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
};

/**
 * The two sinks first — finished at the floor, parked and blocked just above it
 * — then sent back from UAT, then priority band, then whatever is waiting on
 * you inside that band, then self-filed-and-untriaged last inside what is left,
 * then most recently updated.
 *
 * The sinks come first because they answer a question that comes before "how
 * urgent is this": is this row in the running at all. Everything after them is
 * exactly as it was, and still orders each group internally.
 *
 * The UAT rule is the only thing left in this file that beats P0, and it is not
 * a rank — it is a verdict.
 *
 * The second rule is the one that earns its place: a P1 sitting at a gate is the
 * thing to open, not the P1 a worker is still chewing. The third is a tiebreak
 * and nothing more — machine-raised backlog nobody has agreed to sinks to the
 * bottom of ITS OWN band, and never below the band beneath it. An answered gate
 * on a self-filed issue still comes first: it is already picked up.
 */
export function compareIssues(a: Sortable, b: Sortable): number {
  // THE TWO SINKS, FIRST AND TOGETHER — see `sunk()`. Finished work is the
  // floor; parked and blocked sit just above it. They are one key rather than
  // two because their relative order is the point: a closed issue must stay
  // below a parked one, and two independent boolean keys cannot express that.
  //
  // The operator's rule: a set-aside row must not appear at the top of the queue.
  // Everything below this line still applies INSIDE each of the three groups, so
  // a parked P0 is still above a parked P3 and a parked send-back is still first
  // among parked rows — the group is ordered, it has simply left the top.
  const sinks = sunk(a) - sunk(b);
  if (sinks !== 0) return sinks;

  // Above every band, P0 included. A pre-merge bot round is NOT this: it arrives
  // as status 'rework' with `uatFail` null and stays inside its band.
  const sentBack = Number(isUatFail(b)) - Number(isUatFail(a));
  if (sentBack !== 0) return sentBack;
  if (isUatFail(a) && isUatFail(b) && a.uatFail && b.uatFail) {
    // Several at once: triage's own rank first — a P0 send-back before a P2 one
    // — then the verdict that has kept QA waiting longest.
    const uatBand = rank(priorityOf(a.labels)) - rank(priorityOf(b.labels));
    if (uatBand !== 0) return uatBand;
    return askedAt(a.uatFail.at) - askedAt(b.uatFail.at);
  }
  // The `done` sink used to be here, as its own key. It has moved to the top of
  // this function and joined the parked/blocked sink in `sunk()`, because the
  // two have to be ranked against each other and two booleans cannot do that.
  // Its rule is unchanged: closed is the floor — closed issues are greyed and at
  // the bottom of the list.

  // Whose hands it is in: yours, then your worker's, then other people's. The
  // operator asked that issues NOT with them sink towards the bottom of the list
  // and move back up when they are back on them — then, on seeing it, that work
  // being ACTIVELY worked on be prioritised UP the queue, because actively worked
  // on means it is with them.
  //
  // Deliberately a SINK beside the `done` sink, and NOT a promotion above the
  // band — the difference is load-bearing. Promoting "on me" above the band
  // would lift an ICEBOX issue sitting at a gate over an unstarted P0, and icebox
  // is the one band a human has already ruled on ("not scheduling"). As a sink,
  // the band still decides the order inside each tier, exactly as today.
  // `leaves icebox last however recently it was touched` still holds because of
  // this choice.
  const court = COURT_RANK[courtOf(a)] - COURT_RANK[courtOf(b)];
  if (court !== 0) return court;

  /**
   * TWO TICKETS IN THE LINE ARE DRAWN IN THE ORDER THEY WILL BE SERVED.
   *
   * Only ever consulted when BOTH are in it, which is what makes this safe to
   * sit above the band: for those two rows the queue has already applied the
   * band, and the send-back key above it, and arrival — so this is not a second
   * opinion about priority, it is the same opinion, read off the line itself
   * (`queue.list()`, via the server's `queuePosition`).
   *
   * Without it the rail contradicted the line on exactly the rows where the line
   * is the authority. A P2 the operator had sent back is served before an
   * untouched P1 (`queue.ts`, key 2) and the rail drew the P1 first; two queued
   * P1s are served FIFO by arrival and the rail drew them newest-first, which is
   * close to the reverse. Both rows printed the position that contradicted their
   * own order.
   *
   * A row NOT in the line has no position and no opinion here, so nothing else
   * moves: an unstarted P0 is still above a queued icebox ticket, because the
   * comparison never happens between them. An ABSENT field — a rebuilt
   * `ui/dist` in front of a console that has not restarted — reads as not in the
   * line, on the same rule `parked` and `uatFail` already keep.
   */
  const pa = a.queuePosition ?? null;
  const pb = b.queuePosition ?? null;
  if (pa !== null && pb !== null && pa !== pb) return pa - pb;

  const band = rank(priorityOf(a.labels)) - rank(priorityOf(b.labels));
  if (band !== 0) return band;
  const waiting = Number(needsYou(b)) - Number(needsYou(a));
  if (waiting !== 0) return waiting;
  const unvouched = Number(selfFiledNeedsTriage(a)) - Number(selfFiledNeedsTriage(b));
  if (unvouched !== 0) return unvouched;
  return at(b.updatedAt) - at(a.updatedAt);
}

export function sortIssues<T extends Sortable>(rows: readonly T[]): T[] {
  return [...rows].sort(compareIssues);
}
