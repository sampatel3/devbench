import { describe, it, expect } from 'vitest';
import { waiting, type WaitingInput } from '../src/waiting.js';

/**
 * The operator, on two issues that both read "PR open" and nothing else, asked
 * what the status was — what "pending" and "awaiting" meant, where the visibility
 * was, and how they were meant to know what to follow up on.
 *
 * The console knew the answer to both and never said it. `reviewOutstanding`,
 * `handover.why` and the PR's own pre-merge checklist were all computed, and were
 * either squeezed into the chip strip as sentence-length prose or — in
 * `handover.why`'s case — gated on `row.gate === 'E'`, which is null on exactly
 * the rows that needed it.
 *
 * This builds the two answers as finished strings so the page composes nothing:
 * what is this waiting on, and is any of it mine. The split matters as much as
 * the content — "waiting on someone else" must never look like work of theirs.
 */
const BASE: WaitingInput = {
  live: false,
  closed: false,
  pr: {
    number: 4547,
    url: 'https://github.com/example-org/example-repo/pull/4547',
    state: 'OPEN',
    checklist: null,
    // #4547's real state on 13 Aug: GitHub wants the codeowner team, and the
    // bot's CHANGES_REQUESTED never moved the decision.
    reviewDecision: 'REVIEW_REQUIRED',
    reviewRequests: ['Default Reviewers'],
    latestReviews: [{ author: 'pr-swarm', state: 'CHANGES_REQUESTED' }],
  },
  atGate: false,
  reworkWaiting: false,
  reviewOutstanding: null,
  handover: null,
  openQuestion: null,
};

const SWARM = {
  reviewer: 'pr-swarm',
  why: 'the rework went back on 2026-08-13, but pr-swarm has not cleared the review',
  sentAt: '2026-08-13T06:30:54.609Z',
};

describe('what an issue is waiting on', () => {
  it('#4404 today: the CODEOWNER blocks, the bot only advises', () => {
    // The operator asked which it was waiting on — the swarm or the manual
    // approver. The card used to name the swarm, which is the one party that
    // cannot merge anything.
    const w = waiting({ ...BASE, reviewOutstanding: SWARM, handover: { ready: false, why: 'GitHub still wants an approving review from a codeowner' } });
    expect(w).not.toBeNull();
    expect(w!.on).toBe('Waiting for an approving review from Default Reviewers.');
    expect(w!.on).not.toContain('pr-swarm');
    expect(w!.note).toContain('cannot approve or block');
    expect(w!.note).toContain('Changes went back on 13 Aug');
    expect(w!.yours).toEqual([]);
  });

  it('#4344 today: the same reviewer, plus two things they own', () => {
    const w = waiting({
      ...BASE,
      pr: {
        number: 4535,
        url: 'https://github.com/example-org/example-repo/pull/4535',
        state: 'OPEN',
        checklist: { total: 2, done: 1, outstanding: ['feature_flag_surplus_lines_tax checked for Mosaic in production'] },
      },
      reviewOutstanding: SWARM,
      openQuestion: {
        askedAt: '2026-08-12T22:07:53Z',
        firstLine: 'Before this merges — could someone with production access check one flag for me?',
        url: 'https://github.com/example-org/example-repo/issues/4344#issuecomment-5273345291',
      },
    });
    expect(w!.yours).toHaveLength(2);
    // The unanswered question leads: it is the one with somebody else's clock on it.
    expect(w!.yours[0]!.text).toBe('You asked a question on 12 Aug and nobody has answered.');
    expect(w!.yours[0]!.detail).toContain('production access');
    expect(w!.yours[0]!.url).toContain('issuecomment-5273345291');
    expect(w!.yours[1]!.text).toBe(
      'Not ticked on PR #4535: feature_flag_surplus_lines_tax checked for Mosaic in production',
    );
  });

  it('lists EVERY outstanding item, never "N still open"', () => {
    // The old chip collapsed to a count the moment a second item appeared, which
    // is how a list of work turns into a number that says nothing.
    const w = waiting({
      ...BASE,
      reviewOutstanding: SWARM,
      pr: { ...BASE.pr!, checklist: { total: 3, done: 1, outstanding: ['check the flag', 'backfill the rows'] } },
    });
    expect(w!.yours).toHaveLength(2);
    expect(w!.yours.map((y) => y.text).join(' ')).toContain('backfill the rows');
  });

  it('names nobody it cannot name, rather than guessing', () => {
    const w = waiting({
      ...BASE,
      pr: { ...BASE.pr!, reviewRequests: [], latestReviews: [] },
      handover: { ready: false, why: 'GitHub still wants an approving review from a codeowner' },
    });
    expect(w!.on).toBe('Waiting for an approving review from someone with write access.');
    expect(w!.note).toBeNull();
  });

  it('says so when GitHub reported no decision at all', () => {
    const w = waiting({ ...BASE, pr: { ...BASE.pr!, reviewDecision: null, latestReviews: [] } });
    expect(w!.on).toContain('could not read');
  });

  it('says nothing at all when the PR is approved and clean', () => {
    const w = waiting({
      ...BASE,
      pr: { ...BASE.pr!, reviewDecision: 'APPROVED', latestReviews: [] },
      handover: { ready: true, why: '' },
    });
    expect(w).toBeNull();
  });

  it('says NOTHING while a rework is waiting on their click', () => {
    // The operator, on #4487: the card read "Waiting for an approving review... Nothing for
    // you to do." with "Changes requested — start the rework?" directly beneath it.
    // Same shape as the gate contradiction: both sentences true of different
    // things, and together a contradiction on one page. A rework round waiting on
    // their click IS something for them to do, and its own card says so far better.
    const w = waiting({ ...BASE, reworkWaiting: true, reviewOutstanding: SWARM });
    expect(w).toBeNull();
  });

  it('says NOTHING while a gate is open — the gate is the thing needing them', () => {
    // The operator, on #4491: the card claimed to be waiting on someone, and
    // clearly was not. The
    // card read "Waiting for an approving review... Nothing for you to do." with a
    // "Gate C — waiting for you" card directly beneath it. Both were true of
    // different things, and together they were a contradiction on one page. A gate
    // outranks a reviewer: it IS theirs, right now.
    const w = waiting({ ...BASE, atGate: true, reviewOutstanding: SWARM });
    expect(w).toBeNull();
  });

  it('stays out of the way of a live worker', () => {
    // A running worker already answers "what is this waiting on", above this card.
    expect(waiting({ ...BASE, live: true, reviewOutstanding: SWARM })).toBeNull();
  });

  it('goes silent once the issue is closed, even with a question open', () => {
    expect(waiting({ ...BASE, closed: true, openQuestion: { askedAt: '2026-08-12T22:07:53Z', firstLine: 'q?', url: 'u' } })).toBeNull();
  });

  it('drops stale pre-merge items once the PR is merged', () => {
    const w = waiting({
      ...BASE,
      pr: { ...BASE.pr!, state: 'MERGED', checklist: { total: 2, done: 1, outstanding: ['check the flag'] } },
      reviewOutstanding: SWARM,
    });
    expect(w).toBeNull();
  });

  it('#4375 and #5269: a DRAFT is THEIRS, and never "nothing for you to do"', () => {
    // The bug that kept two finished tickets parked for weeks. Both cards read
    // "Waiting for an approving review from someone with write access. Nothing
    // for you to do." on a PR GitHub had shown to nobody — every gate green,
    // every worker done, and the one click that would start a review sitting
    // behind a sentence telling them to leave it alone.
    const w = waiting({
      ...BASE,
      pr: {
        number: 5358,
        url: 'https://github.com/example-org/example-repo/pull/5358',
        state: 'OPEN',
        checklist: null,
        isDraft: true,
        // Exactly what GitHub reports on a draft: a decision with nobody asked.
        reviewDecision: 'REVIEW_REQUIRED',
        reviewRequests: [],
        latestReviews: [],
      },
    });
    expect(w).not.toBeNull();
    // Nobody else is holding it, so there is no "waiting on someone else" line.
    expect(w!.on).toBeNull();
    expect(w!.yours).toHaveLength(1);
    expect(w!.yours[0]!.text).toBe(
      'PR #5358 is still a draft — nobody can review it until you mark it ready for review.',
    );
    expect(w!.yours[0]!.url).toBe('https://github.com/example-org/example-repo/pull/5358');
  });

  it('does not let the handover line put a draft back on somebody else', () => {
    // `handoverBlock` answers a draft with "this PR is still a draft — nobody
    // merges a draft", which is true and belongs on their side of the card. Routed
    // into `on` it would have swapped one misleading sentence for another, under
    // a heading that reads "Waiting on someone else".
    const w = waiting({
      ...BASE,
      pr: { ...BASE.pr!, isDraft: true, reviewDecision: null, reviewRequests: [], latestReviews: [] },
      handover: { ready: false, why: 'this PR is still a draft — nobody merges a draft' },
    });
    expect(w!.on).toBeNull();
    expect(w!.yours.map((y) => y.text).join(' ')).toContain('mark it ready for review');
  });

  it('puts the draft ABOVE the items it is blocking', () => {
    // No reviewer ticks a pre-merge box on a PR no reviewer can see, so the
    // draft is what has to move first. It is also the cheapest item on the list.
    const w = waiting({
      ...BASE,
      pr: {
        ...BASE.pr!,
        isDraft: true,
        checklist: { total: 2, done: 1, outstanding: ['check the flag'] },
      },
      openQuestion: { askedAt: '2026-08-12T22:07:53Z', firstLine: 'q?', url: 'u' },
    });
    expect(w!.yours.map((y) => y.text)).toEqual([
      `PR #${BASE.pr!.number} is still a draft — nobody can review it until you mark it ready for review.`,
      'You asked a question on 12 Aug and nobody has answered.',
      `Not ticked on PR #${BASE.pr!.number}: check the flag`,
    ]);
  });

  it('says nothing new once the draft is marked ready', () => {
    // The fix has to disappear the moment they click. Same PR, `isDraft` off: the
    // card goes straight back to naming the codeowner team.
    const w = waiting({ ...BASE, pr: { ...BASE.pr!, isDraft: false }, reviewOutstanding: SWARM });
    expect(w!.on).toBe('Waiting for an approving review from Default Reviewers.');
    expect(w!.yours).toEqual([]);
  });

  it('reads a MISSING isDraft as not a draft', () => {
    // A rebuilt `ui/dist` in front of a console that has not restarted, and every
    // older test in this file: no `isDraft` key at all. Absent is not draft.
    const w = waiting({ ...BASE, reviewOutstanding: SWARM });
    expect(w!.on).toBe('Waiting for an approving review from Default Reviewers.');
    expect(w!.yours).toEqual([]);
  });

  it('never prints "nothing for you" as its whole content', () => {
    // A card that exists only to say there is nothing to do is noise. With
    // nobody holding it and nothing of theirs, there is no card.
    expect(waiting({ ...BASE, pr: { ...BASE.pr!, reviewDecision: 'APPROVED', latestReviews: [] } })).toBeNull();
  });
});
