/**
 * THE post-UAT verdict predicate. One implementation, imported by everything.
 *
 * What actually happens on this repo — verified, and it is not what it looks
 * like from the outside:
 *
 *  - `changes-requested` is a PRE-MERGE label on feature PRs into `dev`. All 142
 *    PRs that have ever carried it are base `dev`; `pr-swarm[bot]` applies it
 *    and the author removes it on push. `review.ts` already owns that loop. It is
 *    NOT the post-UAT signal and nothing in this file looks at it.
 *  - Promotion PRs (base `test` = UAT, base `main`) get no reviews at all.
 *  - The post-UAT human verdict lands on the ISSUE, as a free-text comment, with
 *    NO label. Both `**Test Result:** Partial Pass` and standalone `**Pass:**`
 *    / `**Partial Pass:**` headings are observed. The board lane `QA` is the
 *    state marker.
 *
 * So "was this comment a genuine human UAT verdict" is a question with four
 * gates, and this file is the only place that answers it. It exists as a file
 * because the two designs that needed it had already drifted: one specified four
 * gates, the other a bare regex. A bare regex lets `github-actions` (a Bot that
 * posts on this repo daily) and the console's OWN worker — which runs `gh` as
 * the operator — light up top priority and push to your phone.
 *
 * Read-only, pure, no I/O.
 */

export type UatVerdictKind = 'Pass' | 'Fail' | 'Partial Pass';

/** One comment, in the shape the omnibus query returns it. */
export type UatComment = {
  /** GitHub's own id (`databaseId`), as a string. Never a poll timestamp: it is
   *  what makes notify-once survive a console restart. */
  id: string;
  author: {
    login: string;
    /** GraphQL `__typename` — `User` or `Bot`. Gate 1 is this field. */
    typename: string;
  };
  createdAt: string;
  body: string;
  url: string;
};

export type UatContext = {
  /** The gh viewer — the account the console and its workers run as. */
  me: string;
  /**
   * When the work SHIPPED: the earliest merge of any PR referencing this issue.
   * Earliest, not latest, because the question is "has this comment arrived after
   * the work went out", and a later fix PR must not push the boundary forward and
   * silently disqualify the verdict that asked for the fix.
   *
   * Null when nothing has merged — which is an answer, not a gap: there can be no
   * post-UAT verdict on work that has not shipped. F2 asked for this to be
   * defined rather than left to compare against NaN.
   */
  mergedAt: string | null;
};

/** Which gate said no. Useful in tests and in the reason string. */
export type VerdictGateFailure = 'not-a-user' | 'own-comment' | 'no-template' | 'not-after-merge';

/**
 * The template, on the FIRST non-empty line.
 *
 * Written against the WHOLE corpus, not one comment. Read live on 2026-08-12
 * (`repo:example-org/example-repo "Test Result" in:comments`, 78 verdict-shaped
 * first lines) this repo has two QA testers and they do not write the same thing:
 *
 *     qa-alice  `**Test Result:** Pass`     54 of 54 parsed
 *     qa-bob    `Test Result: _Pass_`        0 of 24 parsed
 *
 * The first version of this regex allowed `*` emphasis and not `_`, so every
 * verdict from one of the two testers — every Fail included — was invisible to
 * the entire feature. That is why the emphasis markers are a character class
 * and not a literal, and why `Re-test Result:` is in here: both are observed,
 * neither was guessed.
 *
 * The verdict word ends on `(?![A-Za-z0-9])`, NOT on `\b`. `_` is a word
 * character, so `\b` does not exist between the `s` of `Pass` and the closing
 * `_` of `_Pass_` — a `\b` here silently reintroduces exactly the bug above on
 * the tester whose verdicts are wrapped in underscores.
 *
 * Every gate other than this one only EXCLUDES things; this is the only gate
 * that finds anything. What it still misses is caught by
 * `isPostMergeHumanComment` and shown as a low-tier FYI row, so a miss is
 * visible rather than silent.
 *
 * Anchored to the line start on purpose: "the customer said Test Result: Fail"
 * quoted mid-sentence is not a verdict.
 *
 * This line decides WHETHER a comment is a verdict. It no longer decides WHICH
 * one: a tester whose saved template opens `Test Result: _Pass_` states the real
 * outcome further down, so `BODY_VERDICT` reads the rest and the worse of the
 * two wins. Gate 4 is unmoved — a comment that does not open with this is still
 * not a verdict.
 */
const TEMPLATE =
  /^\s*[*_]*\s*(?:Re-?\s*)?Test\s+Results?\s*[*_]*\s*:\s*[*_]*\s*(Partial\s+Pass|Partial|Failed|Fail|Pass)(?![A-Za-z0-9])/i;

/**
 * The newer QA headings seen live on #5019 and 18 recent passes, with the detail
 * on following lines. Unlike `TEMPLATE`, this form is anchored at BOTH ends.
 * That strictness is load-bearing: `Partial Pass: the search page is broken` is
 * prose, not a machine-readable verdict, and must stay in the safety valve.
 *
 * `Fail` is in the alternation even though only `Pass` and `Partial Pass` have
 * been seen in this form. It is the third member of a family whose other two are
 * observed, `BARE_VERDICT_LABEL` below already anticipated it, and the cost of
 * the two spellings disagreeing is that the one verdict that must never be
 * missed is the one that is. The both-ends anchor is what keeps it safe.
 */
const BARE_VERDICT_HEADING =
  /^\s*\*\*(Partial\s+Pass|Failed|Fail|Pass):\*\*\s*$/i;

/**
 * THE BODY'S OWN VERDICT, which outranks the header when the header is a
 * template the tester did not edit.
 *
 * `qa-bob` posts from a saved template whose first line already reads
 * `Test Result: _Pass_`. The outcome is filled in below, in the template's own
 * `Actual:` field — the same field this repo's Stage 9 handoff prints as
 * `**Actual:** (QA to fill)`. Reading only the first line therefore does worse
 * than miss a verdict: it reports a FAIL as a pass, on the row, on the phone,
 * and in the priority band. 14 of 27 UAT comments read live came back wrong or
 * blank, which is the majority of the QA function.
 *
 * The labels are the template's, not invented: `Test Result` (and its `Re-`
 * form), `Result`, and `Actual`. Same verdict words and the same
 * `(?![A-Za-z0-9])` terminator as `TEMPLATE`, so "Passes on step 3" is not a
 * Pass — and the same line-start anchor, so a quoted `> Test Result: Fail` from
 * an earlier round and a mid-sentence mention are both still prose.
 *
 * The emphasis runs are `[\s*_]*` rather than `TEMPLATE`'s `\s*[*_]*\s*`
 * because both orders are written live: `Test Result: _Pass_` puts the space
 * first, `**Actual:** _Fail_` puts the marker first, and a class that admits
 * only one order reads one tester and not the other. That is the same bug the
 * underscore fix already cost this file once.
 */
const BODY_VERDICT =
  /^[\s*_]*(?:(?:Re-?\s*)?Test\s+Results?|Actual|Result)[\s*_]*:[\s*_]*(Partial\s+Pass|Partial|Failed|Fail|Pass)(?![A-Za-z0-9])/i;

/**
 * Which verdict wins when a comment states two.
 *
 * ONE DIRECTION ONLY: the body can make the verdict worse, never better. A
 * header of unedited boilerplate can hide a Fail, so the body has to be able to
 * overturn it; the reverse — a stray `Result: Pass` further down demoting a
 * stated Fail — is the failure this whole file exists to prevent, and it is not
 * possible here. It is the same asymmetry `revisitSendBack` settles the same
 * way: Fail is the safe read, because Fail is the one that puts the row in front
 * of the operator.
 */
const SEVERITY: Record<UatVerdictKind, number> = { Pass: 0, 'Partial Pass': 1, Fail: 2 };

const wordToVerdict = (raw: string): UatVerdictKind => {
  const word = raw.toLowerCase().replace(/\s+/g, ' ');
  if (word === 'pass') return 'Pass';
  if (word === 'fail' || word === 'failed') return 'Fail';
  return 'Partial Pass';
};

/**
 * The LABEL alone — "this comment is trying to be a verdict" — without requiring
 * a verdict word the parser recognises.
 *
 * `Test Result: needs another look` is not a verdict and must not become a
 * tier-1 row. But it is also not chat, and the difference between the two is the
 * entire job of the safety valve: it is how a template that drifts again shows
 * up as something rather than as silence. Same emphasis class and same `Re-`
 * prefix as `TEMPLATE`, so the two cannot drift apart.
 */
const TEMPLATE_LABEL = /^\s*[*_]*\s*(?:Re-?\s*)?Test\s+Results?(?![A-Za-z0-9])/i;

/** A malformed member of the bare-heading family still belongs in the quiet
 * safety valve — `**Fail:** and here is why` has the words but not the shape. */
const BARE_VERDICT_LABEL = /^\s*\*\*(?:Partial\s+Pass|Fail|Pass):\*\*/i;

/** A line that is nothing but @mentions, with nothing else on it. */
const MENTION_ONLY = /^\s*(?:@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?[ \t]*)+$/;

/**
 * The first line that could carry the verdict — leading @mention-only lines
 * skipped.
 *
 * On 2026-08-18 qa-alice's Fail on #4619 (P1, customer-reported) opened with an
 * @mention of the operator on its own line and `Test Result: Fail` beneath it.
 * The first non-empty line was the mention, TEMPLATE did not match it, and gate 4 failed
 * `no-template` — so a QA Fail landed as a low-tier FYI row, the lane went to
 * `Revisit` while the card kept offering the pre-QA Stage 9 prompt ("draft the
 * QA ready-to-verify comment"), and nothing said the verdict had arrived.
 *
 * Only mention-ONLY lines are skipped, so the line-start anchor still does its
 * job: `Hi there,` / `@operator please look at this` are prose, and a verdict
 * quoted after prose is still not a verdict.
 */
const firstNonEmptyLine = (body: string): string | undefined =>
  body.split('\n').find((l) => l.trim() !== '' && !MENTION_ONLY.test(l));

/**
 * The comment's verdict, or null.
 *
 * Gate 4 is unchanged and it is still the first line that opens it: a comment
 * that does not BEGIN with the template is not a verdict, so prose that quotes
 * one stays prose and the safety valve keeps catching what this misses. What is
 * new is what happens after the first line matches — every later line is read
 * too, and the most severe verdict any of them states is the answer. See
 * `BODY_VERDICT`.
 */
export function parseTestResult(body: string): UatVerdictKind | null {
  const firstLine = firstNonEmptyLine(body);
  if (firstLine === undefined) return null;
  const m = TEMPLATE.exec(firstLine) ?? BARE_VERDICT_HEADING.exec(firstLine);
  if (!m) return null;
  let verdict = wordToVerdict(m[1]!);
  for (const line of body.split('\n')) {
    const found = BODY_VERDICT.exec(line);
    if (!found) continue;
    const stated = wordToVerdict(found[1]!);
    if (SEVERITY[stated] > SEVERITY[verdict]) verdict = stated;
  }
  return verdict;
}

/** Does this comment open with a known verdict-label family, whatever follows it? */
export function mentionsVerdictHeading(body: string): boolean {
  const firstLine = firstNonEmptyLine(body);
  return firstLine !== undefined && (TEMPLATE_LABEL.test(firstLine) || BARE_VERDICT_LABEL.test(firstLine));
}

/** Strictly after, and false rather than throwing on anything unparseable —
 *  same convention as `after()` in review.ts. */
function after(iso: string, thanIso: string | null): boolean {
  if (thanIso === null) return false;
  const a = Date.parse(iso);
  const b = Date.parse(thanIso);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

/**
 * The four gates, in order, with the one that failed named.
 *
 *  1. `__typename === 'User'` — the swarm and github-actions are `Bot`. This
 *     gate alone excludes every bot on the repo.
 *  2. author is not us — the console's own worker runs `gh` as the operator, so
 *     its output would otherwise be a verdict about itself.
 *  3. posted strictly after the work merged.
 *  4. the template, on the first non-empty line.
 *
 * A comment must pass all four, so the order would be arbitrary but for one
 * thing: the template is checked LAST so that `no-template` means "human, not
 * us, after the merge — and it did not parse", which is exactly the safety
 * valve below. Checking it earlier made a pre-merge chat message look like a
 * missed verdict, which the valve then reported as one.
 */
export function verdictGates(c: UatComment, ctx: UatContext): { verdict: UatVerdictKind } | { failed: VerdictGateFailure } {
  if (c.author.typename !== 'User') return { failed: 'not-a-user' };
  if (c.author.login.toLowerCase() === ctx.me.toLowerCase()) return { failed: 'own-comment' };
  if (!after(c.createdAt, ctx.mergedAt)) return { failed: 'not-after-merge' };
  const verdict = parseTestResult(c.body);
  if (verdict === null) return { failed: 'no-template' };
  return { verdict };
}

/** The predicate itself: the verdict, or null. Every caller uses this one. */
export function isHumanUatVerdict(c: UatComment, ctx: UatContext): UatVerdictKind | null {
  const r = verdictGates(c, ctx);
  return 'verdict' in r ? r.verdict : null;
}

/**
 * The safety valve. A human, not us, commented after the merge — and it did not
 * parse as a verdict.
 *
 * False positives on the verdict are well defended by gates 1, 2 and 4. False
 * NEGATIVES are wide open (`Test Results:`, a markdown table, QA replying in
 * prose) and completely undetectable — the failure mode is silence, and the
 * design's answer to a miss was "widen the regex", which requires the operator
 * to notice the thing that did not happen. So the same gates minus the template
 * become a quiet FYI row: never tier 1, never a push, but visible.
 */
export function isPostMergeHumanComment(c: UatComment, ctx: UatContext): boolean {
  const r = verdictGates(c, ctx);
  return 'failed' in r && r.failed === 'no-template';
}

/**
 * A post-merge board move to `Revisit` — a send-back, said on the board instead
 * of in a comment.
 *
 * It says a send-back happened. It does NOT say which environment was tested:
 * a merge lands on `dev`, and a card can return to `Revisit` from dev testing
 * or from UAT. Callers must not word this as "failed in UAT" — and when the
 * comment does not say, dev is the one to replicate on first, because the fix
 * IS there and a defect that still reproduces is a real defect rather than a
 * promotion gap.
 *
 * #4847 is why this exists. QA failed a P1 customer-reported regression in UAT
 * and said so twice: a prose comment naming what was still broken, and a move
 * to `Revisit`. The template parser above recognised neither, so the console
 * announced "new comment" and "board moved" as low-tier news and the row was
 * never prioritised.
 *
 * Widening the text parser is the wrong answer — the line-start anchor exists so
 * that quoting a verdict is not giving one, and prose is unbounded. The lane is
 * the better signal and was already on hand:
 *
 *  - `board.ts` calls `Revisit` a verdict in as many words;
 *  - the console NEVER moves a lane, which is a documented invariant, so a lane
 *    change is always somebody else's act — gates 1 and 2 for free;
 *  - it carries its own timestamp, so "strictly after the merge" still applies.
 *
 * What the lane cannot say is Fail vs Partial Pass, or who moved it. `Fail` is
 * the safe read because it is the one that prioritises the row, and `source`
 * carries the provenance so a card can word it as "moved to Revisit" rather than
 * putting a verdict in a named person's mouth.
 */
export function revisitSendBack(
  issue: { lane: string | null; laneAt: string | null },
  ctx: { mergedAt: string | null },
): { verdict: UatVerdictKind; at: string; source: 'board-revisit' } | null {
  if (issue.lane !== 'Revisit') return null;
  if (issue.laneAt === null) return null;
  if (!after(issue.laneAt, ctx.mergedAt)) return null;
  return { verdict: 'Fail', at: issue.laneAt, source: 'board-revisit' };
}
