import { describe, it, expect } from 'vitest';
import {
  parseTestResult,
  verdictGates,
  isHumanUatVerdict,
  isPostMergeHumanComment,
  type UatComment,
} from '../src/uat.js';

/**
 * THE ONE PREDICATE. Two features hang off this file — the fix-first band on the
 * issue list and the phone notification — and the whole reason it is a file is
 * that the two designs had already drifted before a line was written: one
 * required four gates, the other required a regex. A bot comment, or the
 * operator's own worker running `gh` under the operator's handle, would have lit
 * up top priority AND pushed to their phone.
 *
 * So each gate is tested on its own, and the two cases that must NEVER match —
 * the bot and their own worker — are tested by name.
 */

const ME = 'operator';
const MERGED = '2026-08-11T18:45:31Z'; // PR #4466's real mergedAt

const comment = (over: Partial<UatComment> = {}): UatComment => ({
  id: '9001',
  author: { login: 'qa-alice', typename: 'User' },
  createdAt: '2026-08-12T09:00:00Z',
  body: '**Test Result:** Fail\n**Description:**\nThe pill still shows 100%.',
  url: 'https://github.com/example-org/example-repo/issues/4334#issuecomment-9001',
  ...over,
});

describe('parseTestResult — explicit verdict headings, and only explicit verdict headings', () => {
  it('reads the verified #4170 shape: **Test Result:** Pass', () => {
    expect(parseTestResult('**Test Result:** Pass\n**Description:**\n…')).toBe('Pass');
  });

  it('reads Fail and Partial Pass', () => {
    expect(parseTestResult('**Test Result:** Fail')).toBe('Fail');
    expect(parseTestResult('**Test Result:** Partial Pass\nsteps…')).toBe('Partial Pass');
  });

  it('reads the standalone headings now posted by QA', () => {
    expect(parseTestResult('**Partial Pass:**\n@operator\n---\nBroker search is broken')).toBe('Partial Pass');
    expect(parseTestResult('**Pass:**\nEverything passed')).toBe('Pass');
  });

  it('does not turn prose beginning with a verdict word into a verdict', () => {
    expect(parseTestResult('Partial Pass: broker search is broken')).toBeNull();
    expect(parseTestResult('**Pass:** except for paging')).toBeNull();
    expect(parseTestResult('The result was Partial Pass: broker search is broken')).toBeNull();
  });

  it('tolerates the near-misses a human types: **Test Result**: Failed, no bold, lower case', () => {
    // F1: the regex is the only gate that FINDS anything; every other gate only
    // excludes. Widening it here is cheap, and what it still misses is caught by
    // the FYI valve rather than lost.
    expect(parseTestResult('**Test Result**: Failed')).toBe('Fail');
    expect(parseTestResult('Test Result: fail')).toBe('Fail');
    expect(parseTestResult('test result:   PARTIAL')).toBe('Partial Pass');
  });

  it('skips leading blank lines but not leading prose', () => {
    expect(parseTestResult('\n\n**Test Result:** Pass')).toBe('Pass');
    expect(parseTestResult('Hi there,\n**Test Result:** Fail')).toBeNull();
  });

  it('skips a leading @mention line — the #4619 shape QA now posts', () => {
    expect(parseTestResult('@operator \n\nTest Result: Fail')).toBe('Fail');
    expect(parseTestResult('@operator @reviewer-two\n**Test Result:** Pass')).toBe('Pass');
    // Prose that merely CONTAINS a mention is still prose, not a skippable line.
    expect(parseTestResult('@operator please look at this\nTest Result: Fail')).toBeNull();
  });

  it('is null for an ordinary comment', () => {
    expect(parseTestResult('Looks good so far, will finish testing tomorrow')).toBeNull();
    expect(parseTestResult('')).toBeNull();
  });

  /**
   * THE CORPUS. Every distinct verdict first-line on this repo, read live on
   * 2026-08-12 (`repo:example-org/example-repo "Test Result" in:comments`, 60 issue nodes,
   * 78 verdict-shaped first lines).
   *
   * The count that made this a BLOCK rather than a nicety:
   *
   *     qa-alice   matched 54   missed  0
   *     qa-carol   matched  0   missed 24
   *
   * One of the two QA testers on this repo writes `_Pass_`, not `**Pass**`, and
   * the emphasis marker sat outside the character class. Every one of their
   * verdicts — including every Fail — was invisible to the whole feature: no
   * tier-1 row, no `row.uatFail` stamp, no push. Half the QA function.
   */
  it('reads BOTH testers on this repo — underscore emphasis is not optional', () => {
    expect(parseTestResult('Test Result: _Pass_')).toBe('Pass');
    expect(parseTestResult('Test Result: _Fail_')).toBe('Fail');
    expect(parseTestResult('Test Result: _Partial Pass_')).toBe('Partial Pass');
  });

  it('reads the Re- prefix: a re-test is still a verdict', () => {
    expect(parseTestResult('Re-test Result: _Pass_')).toBe('Pass');
    expect(parseTestResult('Retest Result: Fail')).toBe('Fail');
  });

  it('reads the whole observed corpus, and still refuses prose', () => {
    const corpus: Array<[string, string | null]> = [
      ['**Test Result:** Fail', 'Fail'],
      ['**Test Result:** Pass', 'Pass'],
      ['**Test result:** Pass', 'Pass'],
      ['**Test Result:  Fail**', 'Fail'],
      ['**Test Result**: Failed', 'Fail'],
      ['Test Result: Pass', 'Pass'],
      ['Test Result: _Fail_', 'Fail'],
      ['Test Result: _Partial Pass_', 'Partial Pass'],
      ['Test Result: _Pass_', 'Pass'],
      ['Re-test Result: _Pass_', 'Pass'],
      // Still not verdicts, and the reason each one is not:
      ['the customer said Test Result: Fail', null], // mid-sentence
      ['Test Results — it fails on step 3', null], // no colon: prose
      ['Test Result: still going', null], // no verdict word
    ];
    for (const [line, want] of corpus) expect([line, parseTestResult(line)]).toEqual([line, want]);
  });
});

/**
 * THE BOILERPLATE HEADER OVER A FAILED BODY.
 *
 * `qa-carol` posts from a saved template whose first line already reads
 * `Test Result: _Pass_` and fills the real outcome into the template's own
 * `Actual:` field below it — the same field this repo's Stage 9 handoff prints
 * as `**Actual:** (QA to fill)`. Reading the first line alone does worse than
 * miss a verdict: it reports a FAIL as a pass, on the row, on the phone and in
 * the priority band. 14 of 27 UAT comments came back wrong or blank.
 *
 * The rule is one-directional and that is the whole safety argument: the body
 * can only make the verdict WORSE. A stray `Result: Pass` further down can
 * never demote a stated Fail.
 */
describe('parseTestResult — the body outranks a header nobody edited', () => {
  it('reads the FAIL under an unedited `Test Result: _Pass_` header', () => {
    const body = [
      'Test Result: _Pass_',
      '**Description:** Totals should show the customer count',
      '**Steps to Recreate:** 1. open the dashboard on UAT',
      '**Expected:** _849_',
      '**Actual:** _Fail — still shows 0_',
    ].join('\n');
    expect(parseTestResult(body)).toBe('Fail');
  });

  it('takes Partial Pass from the body under a Pass header, and Fail over Partial Pass', () => {
    expect(parseTestResult('Test Result: _Pass_\n**Actual:** Partial Pass — paging is still wrong')).toBe(
      'Partial Pass',
    );
    expect(parseTestResult('**Test Result:** Partial Pass\nRe-test Result: Fail')).toBe('Fail');
  });

  it('NEVER lets the body talk a stated Fail back up to a Pass', () => {
    expect(parseTestResult('**Test Result:** Fail\n**Actual:** Pass on the second attempt')).toBe('Fail');
    expect(parseTestResult('**Test Result:** Partial Pass\n**Actual:** Pass')).toBe('Partial Pass');
  });

  it('leaves an ordinary verdict exactly where it was — the body says nothing, so nothing moves', () => {
    expect(parseTestResult('**Test Result:** Pass\n**Description:**\nThe fail case now shows a message.')).toBe('Pass');
    expect(parseTestResult('**Test Result:** Pass\n**Expected:** Fail message shown\n**Actual:** it is')).toBe('Pass');
  });

  it('still refuses a quoted or mid-sentence line in the body — the line-start anchor holds', () => {
    expect(parseTestResult('**Test Result:** Pass\n> Test Result: Fail\nthat was last round')).toBe('Pass');
    expect(parseTestResult('**Test Result:** Pass\nPreviously the Actual: Fail line said otherwise')).toBe('Pass');
    expect(parseTestResult('**Test Result:** Pass\n**Actual:** Passes every step')).toBe('Pass');
  });

  it('does not turn a body verdict into a verdict on its own — gate 4 is unmoved', () => {
    // A comment that does not OPEN with the template is still not a verdict; it
    // goes to the FYI safety valve, exactly as it did before.
    expect(parseTestResult('Hi there,\n**Actual:** Fail')).toBeNull();
    expect(parseTestResult('Thanks — Actual: Fail on step 3')).toBeNull();
  });

  it('reads a standalone **Fail:** heading, the third member of a family whose other two it already read', () => {
    expect(parseTestResult('**Fail:**\n@operator\nBroker search is broken')).toBe('Fail');
    // …and the both-ends anchor still keeps prose out of it.
    expect(parseTestResult('**Fail:** except for paging')).toBeNull();
  });
});

describe('verdictGates — four gates, each one on its own', () => {
  const ctx = { me: ME, mergedAt: MERGED };

  it('passes all four for the real shape: a human, not the operator, the template, after the merge', () => {
    expect(verdictGates(comment(), ctx)).toEqual({ verdict: 'Fail' });
  });

  it('GATE 1 — a Bot never gives a UAT verdict, however perfect its template', () => {
    // pr-swarm[bot] and github-actions are both __typename Bot on this repo.
    const bot = comment({ author: { login: 'pr-swarm[bot]', typename: 'Bot' } });
    expect(verdictGates(bot, ctx)).toEqual({ failed: 'not-a-user' });
    expect(isHumanUatVerdict(bot, ctx)).toBeNull();
  });

  it('GATE 1 — github-actions posting the exact template is still not a verdict', () => {
    const actions = comment({
      author: { login: 'github-actions', typename: 'Bot' },
      body: '**Test Result:** Fail\nautomated',
    });
    expect(isHumanUatVerdict(actions, ctx)).toBeNull();
  });

  it('GATE 2 — the operator’s own worker runs gh under their handle; not a verdict', () => {
    // This is the one that would have fired on the console's own output.
    const ownWorker = comment({ author: { login: 'operator', typename: 'User' } });
    expect(verdictGates(ownWorker, ctx)).toEqual({ failed: 'own-comment' });
    expect(isHumanUatVerdict(ownWorker, ctx)).toBeNull();
  });

  it('GATE 2 — the login compare is case-insensitive, because GitHub logins are', () => {
    expect(isHumanUatVerdict(comment({ author: { login: 'Operator', typename: 'User' } }), ctx)).toBeNull();
  });

  it('GATE 3 — a human’s ordinary comment after the merge is not a verdict', () => {
    const chat = comment({ body: 'Thanks, testing this on Thursday' });
    expect(verdictGates(chat, ctx)).toEqual({ failed: 'no-template' });
  });

  it('GATE 4 — a verdict-shaped comment from BEFORE the merge is not a UAT verdict', () => {
    const early = comment({ createdAt: '2026-08-10T09:00:00Z' });
    expect(verdictGates(early, ctx)).toEqual({ failed: 'not-after-merge' });
  });

  it('GATE 4 — nothing has merged, so nothing can be a post-UAT verdict', () => {
    // F2 demanded this be defined rather than left to compare against NaN.
    expect(verdictGates(comment(), { me: ME, mergedAt: null })).toEqual({ failed: 'not-after-merge' });
  });

  it('GATE 4 — a comment at exactly the merge instant is not after it', () => {
    expect(verdictGates(comment({ createdAt: MERGED }), ctx)).toEqual({ failed: 'not-after-merge' });
  });

  it('an unparseable mergedAt fails closed rather than throwing', () => {
    expect(verdictGates(comment(), { me: ME, mergedAt: 'whenever' })).toEqual({ failed: 'not-after-merge' });
  });
});

describe('isPostMergeHumanComment — the safety valve for what the regex misses', () => {
  const ctx = { me: ME, mergedAt: MERGED };

  it('is true for a human comment after the merge that did NOT parse', () => {
    // Correction 2: false negatives on the verdict are undetectable, so this
    // becomes a quiet FYI row instead of silence.
    expect(isPostMergeHumanComment(comment({ body: 'Test Results — it fails on step 3' }), ctx)).toBe(true);
  });

  it('is FALSE for the same comment from a bot — the valve never re-admits bots', () => {
    expect(
      isPostMergeHumanComment(comment({ author: { login: 'github-actions', typename: 'Bot' }, body: 'hi' }), ctx),
    ).toBe(false);
  });

  it('is FALSE for the operator’s own comment, and FALSE before the merge', () => {
    expect(isPostMergeHumanComment(comment({ author: { login: ME, typename: 'User' }, body: 'hi' }), ctx)).toBe(false);
    expect(isPostMergeHumanComment(comment({ body: 'hi', createdAt: '2026-08-01T00:00:00Z' }), ctx)).toBe(false);
  });

  it('is FALSE for a comment that DID parse — that one is a verdict, not a miss', () => {
    expect(isPostMergeHumanComment(comment(), ctx)).toBe(false);
  });
});
