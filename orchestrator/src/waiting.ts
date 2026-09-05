import type { Checklist } from './checklist.js';
import type { OpenQuestion } from './question.js';
import { mergeBlocker } from './blocker.js';

/**
 * The answer to "what is this waiting on, and is any of it mine".
 *
 * The operator opened two issues that both read "PR open" and could not tell
 * them apart — pending, awaiting and waiting all read the same. One was waiting
 * purely on a reviewer; the other also had an unanswered question of theirs and
 * an unticked pre-merge item. The console had computed every one of those facts
 * and shown none of them usefully — `reviewOutstanding` and the checklist were
 * sentence-long chips in a strip meant for badges, and `handover.why` was gated
 * on the row being at Gate E, which is null on exactly the rows that needed it.
 *
 * Every string here is finished, so the page composes nothing. The split into
 * `on` and `yours` is the load-bearing part: work waiting on other people must
 * never render as work of yours, which is a standing rule for this whole
 * console.
 */
export type WaitingItem = {
  /** The follow-up, as a sentence. */
  text: string;
  /** Optional supporting line — what was asked, in your own words. */
  detail: string | null;
  /** Where to go to deal with it. */
  url: string | null;
  /**
   * THE REPAIR, when the console can make it itself.
   *
   * A follow-up item used to be a sentence and a link — "here is a problem, go
   * to GitHub". For the ones the console could fix in one call that is a report
   * about work rather than the work, and the draft PRs proved the cost: five of
   * them, complete and unreviewable, two for a day. An item that carries a
   * `fix` gets a button beside it that does exactly that thing.
   *
   * Absent on every item the console genuinely cannot act on, which is most of
   * them — a question somebody else has not answered has no button.
   */
  fix?: { kind: 'pr-ready'; pr: number } | null;
};

export type Waiting = {
  /** Waiting on somebody else. A status. Null when nobody is holding it. */
  on: string | null;
  /**
   * A review that cannot block the merge, named so you do not chase it. The
   * operator asked which of the two was actually holding the PR — the advisory
   * bot or the approver who can merge it — and the card used to answer that
   * wrongly. See blocker.ts.
   */
  note: string | null;
  /** Yours to chase. Empty is the good case, and says so. */
  yours: WaitingItem[];
};

export type WaitingInput = {
  live: boolean;
  closed: boolean;
  /** A gate is open — it is yours, right now, and it outranks any reviewer. */
  atGate: boolean;
  /** A review round is waiting on your click to start the rework. Also yours. */
  reworkWaiting: boolean;
  pr: {
    number: number;
    url: string;
    state: string;
    checklist: Checklist | null;
    reviewDecision?: string | null;
    reviewRequests?: string[];
    latestReviews?: Array<{ author: string; state: string }>;
    /** Nobody reviews a draft and nobody merges one — so it is YOURS, not theirs. */
    isDraft?: boolean;
  } | null;
  reviewOutstanding: { reviewer: string; why: string; sentAt: string | null } | null;
  handover: { ready: boolean; why: string } | null;
  openQuestion: OpenQuestion | null;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "13 Aug", read in UTC — the same slice `reviewOutstanding.why` already takes, so
 * the card and the sentence behind it can never disagree by a day.
 */
function dayLabel(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const sentence = (s: string): string => {
  const t = s.trim();
  if (t === '') return t;
  const capped = `${t[0]!.toUpperCase()}${t.slice(1)}`;
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
};

export function waiting(input: WaitingInput): Waiting | null {
  // A running worker already answers this question, louder and above this card.
  if (input.live) return null;
  if (input.closed) return null;

  // A GATE OUTRANKS A REVIEWER. On #4491 the card said "Waiting for an approving
  // review ... Nothing for you to do." directly above a "Gate C — waiting for
  // you" card, and the operator reported it as waiting on nobody. Both sentences
  // were true of different things and together they were a contradiction on one
  // page. While a gate is open the answer to "what is this waiting on" is you,
  // and the gate card says so far better than this can.
  if (input.atGate) return null;

  // Same rule, second trigger. #4487 read "Waiting for an approving review ...
  // Nothing for you to do." with "Changes requested — start the rework?" directly
  // beneath it. A card that has a button on it is a thing for you to do, and it
  // says so better than this can.
  if (input.reworkWaiting) return null;

  // Only an OPEN pull request has anyone waiting on it. Once it is merged the
  // pre-merge items are stale by definition, and nobody is holding anything.
  const pr = input.pr && input.pr.state === 'OPEN' ? input.pr : null;

  // A DRAFT IS HIS, AND IT IS THE WHOLE REASON THIS FIX EXISTS. #4375 and #5269
  // sat at Stage 7 for weeks with every gate green, because the console read
  // GitHub's `REVIEW_REQUIRED` on a draft as a reviewer holding the PR. Nobody
  // was: GitHub requests no codeowner and fires no review workflow until a draft
  // is marked ready. Held as its own fact here because it splits two ways — it
  // must not become an `on` (nobody else is involved) and it must land in
  // `yours` (one click, and only you can make it).
  const draft = pr?.isDraft === true;

  // WHO CAN ACTUALLY UNBLOCK THIS. Asked of GitHub's own decision rather than
  // of the loudest reviewer: a read-only bot's CHANGES_REQUESTED never moves
  // `reviewDecision`, so naming it as the blocker is naming somebody powerless.
  const blocker = pr
    ? mergeBlocker({
        state: pr.state,
        reviewDecision: pr.reviewDecision,
        reviewRequests: pr.reviewRequests ?? [],
        latestReviews: pr.latestReviews ?? [],
        isDraft: draft,
      })
    : null;

  let on: string | null = blocker ? blocker.who : null;
  let note: string | null = blocker ? blocker.advisory : null;

  if (pr && !draft && on === null && input.handover && !input.handover.ready) {
    // Only when GitHub gave no usable decision at all.
    //
    // `!draft` because `handoverBlock` answers a draft with "this PR is still a
    // draft — nobody merges a draft", which is TRUE and is the wrong side of the
    // card: `on` is the "waiting on somebody else" line, and the only person a
    // draft waits on is you. Without this guard the draft case simply moved from
    // one misleading sentence to another. It goes into `yours` below instead.
    on = sentence(input.handover.why);
  }

  // The rework date, appended to whichever line is about that reviewer — it is
  // the difference between "they have not looked" and "they have not looked
  // since we pushed", and only the second is worth waiting quietly through.
  if (input.reviewOutstanding?.sentAt) {
    const day = dayLabel(input.reviewOutstanding.sentAt);
    const target = note !== null && note.includes(input.reviewOutstanding.reviewer) ? 'note' : null;
    if (day && target === 'note') note = `${note} Changes went back on ${day} and it has not re-reviewed.`;
  }

  const yours: WaitingItem[] = [];

  // THE DRAFT LEADS, above even the unanswered question, because it gates
  // everything under it: no codeowner is asked, no review workflow fires, no
  // reviewer ticks a pre-merge box, and no answer to any question changes that
  // while the PR is a draft. It is also the cheapest item on the list — one
  // click — which is precisely why sitting on it for weeks was so expensive.
  if (draft) {
    yours.push({
      text: `PR #${pr!.number} is still a draft — nobody can review it until you mark it ready for review.`,
      detail: null,
      url: pr!.url,
      // One click, here, rather than a trip to GitHub. This is the cheapest
      // repair on the list and it was the one that went unmade for longest.
      fix: { kind: 'pr-ready', pr: pr!.number },
    });
  }

  // The question leads the rest: it is the one with somebody else's clock on it.
  if (input.openQuestion) {
    const day = dayLabel(input.openQuestion.askedAt);
    yours.push({
      text: day
        ? `You asked a question on ${day} and nobody has answered.`
        : 'You asked a question and nobody has answered.',
      detail: input.openQuestion.firstLine,
      url: input.openQuestion.url,
    });
  }

  // Every outstanding item, in full. The chip this replaces collapsed to
  // "N still open" the moment a second one appeared, which turns a list of real
  // work into a number that says nothing. No cap: a long list IS the news.
  for (const item of pr?.checklist?.outstanding ?? []) {
    yours.push({ text: `Not ticked on PR #${pr!.number}: ${item}`, detail: null, url: pr!.url });
  }

  // Nothing to report is not a card. A panel that exists to say "all clear" is
  // noise on every healthy issue, and there are more healthy issues than not.
  if (on === null && note === null && yours.length === 0) return null;
  return { on, note, yours };
}
