/**
 * A board move to `Revisit` IS a UAT send-back.
 *
 * #4847 is the case that proved the gap. QA failed it in UAT and said so twice:
 * a comment, in prose, naming what was still broken — and a board move to
 * `Revisit`. The console announced both as
 * low-tier news ("new comment", "board moved") and graded neither, because
 * `parseTestResult` only recognises the `Test Result:` template and that comment
 * is prose. A P1 customer-reported regression sat un-prioritised.
 *
 * Widening the text parser was the wrong answer: the template anchor exists to
 * stop "the customer said Test Result: Fail" counting as a verdict, and prose is
 * unbounded. The lane is the better signal and it was already there:
 *
 *  - `board.ts` calls `Revisit` a verdict in as many words ("`Done` and
 *    `Revisit` are verdicts");
 *  - the console NEVER moves a lane — that is a documented invariant — so a lane
 *    change is always somebody else's act, which is gate 1 and 2 for free;
 *  - it carries its own timestamp, so "after the merge" still applies.
 *
 * What it cannot tell us is Fail vs Partial Pass, or who moved it. Those are
 * reported as unknown rather than guessed, which is why the source is carried.
 */
import { describe, it, expect } from 'vitest';
import { revisitSendBack } from '../src/uat.js';

const MERGED = '2026-08-19T17:51:50Z';

describe('a post-merge move to Revisit is a send-back', () => {
  it('reads the #4847 shape: Revisit, stamped after the merge', () => {
    const out = revisitSendBack({ lane: 'Revisit', laneAt: '2026-08-19T19:53:00Z' }, { mergedAt: MERGED });
    expect(out).toEqual({ verdict: 'Fail', at: '2026-08-19T19:53:00Z', source: 'board-revisit' });
  });

  /** Before the merge it is not a UAT verdict — nothing has reached UAT yet. */
  it('ignores a Revisit that predates the merge', () => {
    expect(revisitSendBack({ lane: 'Revisit', laneAt: '2026-08-18T09:00:00Z' }, { mergedAt: MERGED })).toBeNull();
  });

  it('ignores every other lane', () => {
    for (const lane of ['QA', 'Done', 'In progress', 'Ready', 'In review', 'Backlog', null]) {
      expect(revisitSendBack({ lane, laneAt: '2026-08-19T19:53:00Z' }, { mergedAt: MERGED })).toBeNull();
    }
  });

  /** Nothing merged means nothing to send back. */
  it('is null when there is no merge to be after', () => {
    expect(revisitSendBack({ lane: 'Revisit', laneAt: '2026-08-19T19:53:00Z' }, { mergedAt: null })).toBeNull();
  });

  it('is null on an unstamped or unparseable lane time rather than assuming it is recent', () => {
    expect(revisitSendBack({ lane: 'Revisit', laneAt: null }, { mergedAt: MERGED })).toBeNull();
    expect(revisitSendBack({ lane: 'Revisit', laneAt: 'not a date' }, { mergedAt: MERGED })).toBeNull();
  });

  /**
   * The lane says a send-back happened; it does not say Fail vs Partial Pass,
   * and it names nobody. Reporting `Fail` is the safe read — it is the one that
   * prioritises the row — but the source is carried so a card can word it as
   * "moved to Revisit" instead of putting words in a person's mouth.
   */
  it('marks its source, so no card claims a named person said Fail', () => {
    const out = revisitSendBack({ lane: 'Revisit', laneAt: '2026-08-19T19:53:00Z' }, { mergedAt: MERGED });
    expect(out?.source).toBe('board-revisit');
  });
});
