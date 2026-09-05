/**
 * The issues a pull request DECLARES it closes.
 *
 * The console adopts a PR that merely REFERENCES an issue, because that is how a
 * fix folded into another issue's PR finds its row — #4562's fix rode inside PR
 * #4535 on #4344's branch and has no PR of its own. See `inheritPr`.
 *
 * A cross-reference is created by any mention at all, though, and on 2026-08-21
 * that adopted PR #5006 onto #5002. #5006 is #5000's work, on #5000's branch,
 * and names #5002 once in prose as deferred out-of-scope work. #5002 had never
 * been started: the console drew it at stage 7 with "nothing for you to do", and
 * moved its board card from `Ready` to `In review`.
 *
 * The closing keyword is what tells a fold-in from a mention, and both PRs word
 * it plainly on their first line — #4535 opens `Closes #4562.`, #5006 opens
 * `Closes #5000.`
 *
 * GitHub's own `closingIssuesReferences` cannot answer this here. It registers
 * only against the default branch, and this repo's PRs base on `dev`, so it
 * comes back empty for #4535 and #5006 alike. The keyword is read from the body
 * instead — which the console already has in hand: `listOpenPrs` fetches `body`
 * for the pre-merge checklist.
 *
 * Deliberately narrow, in the same spirit as `spunOffFrom`: only GitHub's own
 * keywords count, and only immediately before the number, so an honest null
 * beats a plausible wrong link. `Fixed by #5006`, `**FIXED HERE (#4562)**` and a
 * bare `#5002` are all mentions, and none of them is a declaration.
 */
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;

export function closesIssues(body: string | null | undefined): number[] {
  if (!body) return [];
  const out = new Set<number>();
  for (const m of body.matchAll(CLOSES)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out];
}
