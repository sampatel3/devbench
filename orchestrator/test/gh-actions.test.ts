import { describe, it, expect } from 'vitest';
import { parseActionsPayload, parseRateLimit, ACTIONS_QUERY, buildActionsSearchArgs, recentMergedPrsArgs } from '../src/gh.js';
import { RAW_OMNIBUS } from './fixtures/actions-payload.js';

/**
 * The omnibus read. One GraphQL document, measured at **cost 2, nodeCount 2480**
 * against the live repo — every action on the operator in one request, with no
 * per-PR or per-issue loop anywhere.
 *
 * These tests never touch the network: they run the real response through the
 * parser.
 */

describe('the query document itself', () => {
  it('asks each issue for its OWN board lane, never the project board', () => {
    // project 3 has 2019 items and `items(first:100)` returns a NONDETERMINISTIC
    // page — two runs came back with disjoint sets. Per-issue projectItems is
    // the only way to read the lane truthfully.
    expect(ACTIONS_QUERY).toContain('projectItems(');
    expect(ACTIONS_QUERY).not.toContain('items(first');
  });

  it('asks for __typename on every comment author — gate 1 of the verdict predicate', () => {
    expect(ACTIONS_QUERY).toMatch(/author \{ login __typename \}/);
  });

  it('carries the free rateLimit rider so every read reports its own cost', () => {
    expect(ACTIONS_QUERY).toContain('rateLimit { cost remaining resetAt limit used nodeCount }');
  });

  it('is a query and contains no mutation — gh.ts is read-only, permanently', () => {
    expect(ACTIONS_QUERY).not.toMatch(/\bmutation\b/);
    expect(ACTIONS_QUERY.trim().startsWith('query')).toBe(true);
  });

  it('scopes every alias to the one repo and the one assignee', () => {
    const args = buildActionsSearchArgs('example-org/example-repo', 'operator', new Date('2026-08-12T10:00:00Z'), 7);
    expect(args.assignedQ).toBe('repo:example-org/example-repo is:issue is:open assignee:operator');
    expect(args.prsQ).toBe('repo:example-org/example-repo is:pr is:open author:operator');
    expect(args.revReqQ).toBe('repo:example-org/example-repo is:pr is:open review-requested:operator');
    expect(args.mentionsQ).toBe('repo:example-org/example-repo is:open mentions:operator');
    // The merged window is day-granular, the same qualifier listMergedPrs uses.
    expect(args.mergedQ).toBe('repo:example-org/example-repo is:pr is:merged author:operator merged:>=2026-08-05');
  });
});

describe('parseActionsPayload — the live response, field for field', () => {
  const p = parseActionsPayload(RAW_OMNIBUS);

  it('reports the cost GitHub charged, so the console never has to guess', () => {
    expect(p.quota).toEqual({ cost: 2, remaining: 836, limit: 5000, resetAt: '2026-08-12T11:26:24Z' });
  });

  it('reads each issue’s board lane off its own projectItems', () => {
    expect(p.issues.find((i) => i.number === 4334)!.lane).toBe('QA');
    expect(p.issues.find((i) => i.number === 4336)!.lane).toBe('In review');
  });

  it('reads the earliest merged PR referencing the issue — when the work shipped', () => {
    const i = p.issues.find((i) => i.number === 4334)!;
    expect(i.mergedAt).toBe('2026-08-11T18:45:31Z');
    expect(i.mergedPrs).toEqual([
      {
        number: 4466,
        mergedAt: '2026-08-11T18:45:31Z',
        createdAt: '2026-08-10T12:00:00Z',
        state: 'MERGED',
        url: 'https://github.com/example-org/example-repo/pull/4466',
        // The real head-commit date off PR #4466, read live. It is what lets a
        // fix pushed to an EXISTING PR decay a standing verdict.
        lastCommitAt: '2026-08-11T17:23:00Z',
        // Already in the query, now kept: it is the only field in the set that
        // says whether the PR is this issue's OWN work rather than a PR that
        // merely mentioned `#4334` in its body.
        headRefName: 'fix/issue-4334-branded-auth-email-links',
      },
    ]);
  });

  it('every cross-referenced PR carries its branch', () => {
    // Every `CROSS_REFERENCED_EVENT` lands in `referencingPrs`, whoever opened
    // it and whatever it was about — a PR whose body merely says `#4334` is in
    // there too. The branch name is the only field that tells them apart, so it
    // has to survive the parse on every row, not just the ones that happen to
    // be the issue's own work.
    const all = p.issues.flatMap((i) => i.referencingPrs);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((r) => typeof r.headRefName === 'string')).toBe(true);
  });

  it('an issue with nothing merged has mergedAt null — not a guess, an answer', () => {
    expect(p.issues.find((i) => i.number === 4491)!.mergedAt).toBeNull();
  });

  it('keeps the comment author’s __typename so the predicate can see the Bot', () => {
    const c = p.issues.find((i) => i.number === 4336)!.comments[0]!;
    expect(c.author).toEqual({ login: 'github-actions', typename: 'Bot' });
    expect(c.id).toBe('5551');
  });

  it('reads the operator’s open PR’s review decision, labels and CI rollup in the same request', () => {
    const pr = p.prs[0]!;
    expect(pr.number).toBe(4501);
    expect(pr.reviewDecision).toBe('CHANGES_REQUESTED');
    expect(pr.labels).toEqual(['changes-requested', 'human-review-needed']);
    expect(pr.checkState).toBe('FAILURE');
    expect(pr.headOid).toBe('abc123');
    expect(pr.latestReviews[0]!.author).toEqual({ login: 'pr-swarm[bot]', typename: 'Bot' });
  });

  it('survives a partial response — a missing alias is empty, never a throw', () => {
    const p2 = parseActionsPayload({ data: { rateLimit: null } });
    expect(p2.issues).toEqual([]);
    expect(p2.prs).toEqual([]);
    expect(p2.quota).toBeNull();
  });
});

describe('parseRateLimit — the free, real-time brake input', () => {
  it('reads the graphql bucket out of GET /rate_limit', () => {
    // Verified free: core.used stayed 4 across three consecutive calls.
    const q = parseRateLimit(
      JSON.stringify({ resources: { graphql: { limit: 5000, remaining: 833, used: 4167, reset: 1786533984 } } }),
    );
    expect(q).toEqual({ limit: 5000, remaining: 833, resetAt: new Date(1786533984 * 1000).toISOString() });
  });

  it('is null on junk rather than reporting a quota it does not have', () => {
    expect(parseRateLimit('not json')).toBeNull();
    expect(parseRateLimit('{}')).toBeNull();
  });
});

/**
 * BLOCK — `listRecentMergedPrs` truncated its own window, silently.
 *
 * Measured against the live repo on 2026-08-12:
 *
 *     repo:example-org/example-repo is:pr is:merged merged:>=<14d ago>                337
 *     ...the same, author:operator                                        3
 *
 * The call asked for a 14-day window with `--limit 100`, repo-wide. 337 PRs
 * merged in that window, so the 100 that came back were the newest — an
 * effective SIX-day window, with nothing anywhere saying the list was cut. A
 * worktree whose PR merged 7–14 days ago was simply absent from `#mergedPrs`,
 * `effectiveStage` fell back to the stale `.issue-state.md`, and the row read
 * "checkpoint — stopped after stage 7" — the exact bug this function's
 * docstring says it was written to kill. Worse, `#checkReviews` does
 * `if (!pr) continue`, so a rework round on that PR never resolved and the row
 * stayed orange for ever.
 *
 * The map is keyed by head branch and read only for branches this console has a
 * worktree for, and every one of those PRs is opened by the account the console
 * runs as — verified on the three the docstring names (#4368, #4446, #4466: all
 * `operator`). Scoping to the author is therefore not a narrowing of meaning,
 * it is the meaning; and it takes the window from 3.4x over the page limit to
 * 33x under it.
 */
describe('the merged-PR window is actually the window it claims', () => {
  it('scopes to the console’s own author, so 100 rows really do cover 14 days', () => {
    const args = recentMergedPrsArgs('example-org/example-repo', 'operator', new Date('2026-08-12T10:00:00Z'), 14);
    expect(args).toContain('--author');
    expect(args[args.indexOf('--author') + 1]).toBe('operator');
    expect(args).toContain('--search');
    expect(args[args.indexOf('--search') + 1]).toBe('merged:>=2026-07-29');
  });

  it('still reads only merged PRs on the one repo, and is still a list', () => {
    const args = recentMergedPrsArgs('example-org/example-repo', 'operator', new Date('2026-08-12T10:00:00Z'), 14);
    expect(args.slice(0, 2)).toEqual(['pr', 'list']);
    expect(args[args.indexOf('--repo') + 1]).toBe('example-org/example-repo');
    expect(args[args.indexOf('--state') + 1]).toBe('merged');
  });
});

/**
 * FIX — every list cap was silent, and two of them disagreed about the same
 * population.
 *
 * `ACTIONS_QUERY` takes `assigned: first: 30` while `listIssues` takes
 * `--limit 50`, so at 31+ assigned issues the row list would show work the
 * actions feed omitted, with no marker anywhere. And because `issueCount` was
 * never requested on any of the five search connections, the console was
 * STRUCTURALLY incapable of noticing: a shortened list rendered exactly like a
 * complete one, under "Nothing on GitHub needs you."
 *
 * `issueCount` is free — measured on the live repo, `cost 1 / nodeCount 330`
 * with and without it, byte for byte. There is no reason not to ask.
 */
describe('the feed knows when GitHub gave it a short list', () => {
  it('asks every search how many rows there really were', () => {
    // Six since `closedRecently` joined them — see the #4914 block below.
    expect(ACTIONS_QUERY.match(/issueCount/g) ?? []).toHaveLength(6);
  });

  it('reports nothing when every list came back whole', () => {
    const p = parseActionsPayload(RAW_OMNIBUS);
    expect(p.truncated).toBeNull();
  });

  it('names the list and both numbers when one was cut', () => {
    const cut = structuredClone(RAW_OMNIBUS) as typeof RAW_OMNIBUS & {
      data: { assigned: { issueCount?: number } };
    };
    cut.data.assigned.issueCount = 64;
    expect(parseActionsPayload(cut).truncated).toBe('assigned issues (30 of 64 read)');
  });
});

/**
 * READING THE ISSUES THAT CLOSED.
 *
 * Every search here was `is:open`, on a measurement that found zero Fail
 * verdicts posted to already-closed issues in 60 issues. #4914 produced the
 * first one on 2026-08-21 — a tester who failed the work and closed the issue in
 * the same second.
 *
 * It is NOT what hid #4914: GitHub's search index still served that issue as
 * `state: OPEN` two hours later, so it stayed in `assignedQ` throughout, and the
 * defect was downstream in `uatFailFor`. The hole is real all the same, because
 * the index does catch up — after which a send-back on a closed issue would be
 * unreachable. The window matches `mergedQ`, because a send-back older than the
 * merged-PR window has nothing left to join to.
 */
describe('recently closed issues are read too', () => {
  const args = buildActionsSearchArgs('example-org/example-repo', 'operator', new Date('2026-08-21T18:00:00Z'), 7);

  it('asks for the issues assigned to the operator that closed inside the window', () => {
    expect(args.closedQ).toBe('repo:example-org/example-repo is:issue is:closed assignee:operator closed:>=2026-08-14');
  });

  it('leaves the open search exactly as it was', () => {
    expect(args.assignedQ).toBe('repo:example-org/example-repo is:issue is:open assignee:operator');
  });

  /** Unbounded without `is:open` — every issue that ever named the operator — and a
   *  mention on an issue they are not assigned to is not the #4914 failure. */
  it('does not widen mentions, which has no window to bound it', () => {
    expect(args.mentionsQ).toContain('is:open');
  });

  it('reads both searches through ONE fragment, so they cannot drift', () => {
    expect(ACTIONS_QUERY).toContain('fragment IssueForActions on Issue');
    expect(ACTIONS_QUERY.match(/\.\.\.IssueForActions/g) ?? []).toHaveLength(2);
    expect(ACTIONS_QUERY).toContain('closedRecently: search(query: $closedQ');
  });

  it('carries the closed state on the issue, rather than inferring it later', () => {
    const raw = JSON.parse(JSON.stringify(RAW_OMNIBUS)) as Record<string, unknown>;
    const data = (raw as { data: Record<string, unknown> }).data;
    const one = JSON.parse(JSON.stringify((data.assigned as { nodes: unknown[] }).nodes[0]));
    one.number = 4914;
    one.state = 'CLOSED';
    data.closedRecently = { issueCount: 1, nodes: [one] };
    const p = parseActionsPayload(raw);
    const closed = p.issues.find((i) => i.number === 4914)!;
    expect(closed).toBeDefined();
    expect(closed.closed).toBe(true);
    // And an OPEN issue from the same parse says so, so the flag is read from
    // the payload rather than from which search it happened to arrive on.
    expect(p.issues.filter((i) => i.number !== 4914).every((i) => i.closed === false)).toBe(true);
  });
});
