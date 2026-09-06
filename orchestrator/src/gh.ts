import { spunOffFrom } from './parent.js';
import { parseChecklist } from './checklist.js';
import { closesIssues } from './closes.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PullRequest } from './types.js';

const run = promisify(execFile);

/**
 * READ ONLY. Every gh call in this file is a `list`. The console never writes to
 * GitHub — no comments, no labels, no PRs, no merges. Gate E stays human, and so
 * does everything else that leaves this laptop.
 *
 * TWO BUDGETS, deliberately. Almost every read here is `gh pr list` / `gh issue
 * list` / `gh api graphql`, and all of those are GraphQL — one bucket, one
 * query-cost limiter. On 2026-09-05 that limiter refused the merged-PR read for
 * hours while its own counter read 5000/5000, and the console, having no other
 * road, could not learn which PRs had merged. `listRecentMergedPrs` now falls
 * back to `GET /repos/{repo}/pulls`, which is charged to the REST bucket and was
 * healthy throughout. Both are GETs; the fallback narrows nothing about what
 * this file is allowed to do.
 */

export type GhIssue = {
  number: number;
  title: string;
  url: string;
  labels: string[];
  updatedAt: string;
  /**
   * Who FILED it — which is not the same question as who it is assigned to. The
   * repo's `issue-dev-autoassign` workflow assigns the filer, so an issue a
   * worker on this laptop spun off arrives in the assigned queue looking exactly
   * like work the team handed over. This field is the only thing that tells them
   * apart. Empty when GitHub has no author for it (a deleted account).
   */
  author: string;
  /** The issue this was spun off from, when its body says so. See parent.ts. */
  spunOffFrom: number | null;
};

async function gh(args: string[]): Promise<string> {
  const { stdout } = await run('gh', args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

// ------------------------------------------------------- actions on the operator

/**
 * THE OMNIBUS. Every "action on the operator" in ONE read-only GraphQL request.
 *
 * Measured against the live repo on 2026-08-12: **cost 2, nodeCount 2480**. It
 * is a `query` document — `gh api graphql` will happily run a mutation, and this
 * file will never contain one.
 *
 * Two things about it are deliberate and load-bearing:
 *
 *  - **Per-issue `projectItems`, never the project board.** Project 3 holds 2019
 *    items and `items(first: 100)` returns a nondeterministic page: two runs came
 *    back with disjoint sets. The board lane (`QA` is the post-merge marker) can
 *    only be read truthfully by asking each issue for its own item.
 *  - **`__typename` on every comment author.** Gate 1 of the verdict predicate is
 *    "the author is a User", and `github-actions` posts the needs-triage
 *    explainer on the operator's issues daily. Without this field the predicate
 *    cannot run.
 *
 * `timelineItems(CROSS_REFERENCED_EVENT)` is how an issue learns when its work
 * shipped: the PRs that reference it, with their `mergedAt`. That is the input to
 * gate 4 and to the decay rule, and it works for issues this console never built
 * (where there is no tracked PR to read `mergedAt` off).
 *
 * Cost is charged on the `first:` values requested, not on rows returned, so this
 * is a constant 2 points whatever the repo is doing. Review threads are
 * deliberately NOT fetched: `reviewThreads(first: 50)` inside `myPrs` was 1,500
 * of the charged nodes on its own, for a signal with no live instances.
 */
export const ACTIONS_QUERY = `query ActionsOnMe(
  $assignedQ: String!
  $prsQ: String!
  $revReqQ: String!
  $mentionsQ: String!
  $mergedQ: String!
  $closedQ: String!
) {
  assigned: search(query: $assignedQ, type: ISSUE, first: 30) {
    issueCount
    nodes { ... on Issue { ...IssueForActions } }
  }
  closedRecently: search(query: $closedQ, type: ISSUE, first: 20) {
    issueCount
    nodes { ... on Issue { ...IssueForActions } }
  }
  myPrs: search(query: $prsQ, type: ISSUE, first: 20) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url isDraft reviewDecision createdAt updatedAt baseRefName headRefName
        labels(first: 20) { nodes { name } }
        latestReviews(first: 10) { nodes { author { login __typename } state submittedAt body } }
        comments(last: 5) {
          totalCount
          nodes { databaseId author { login __typename } createdAt body url }
        }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
      }
    }
  }
  reviewRequested: search(query: $revReqQ, type: ISSUE, first: 20) {
    issueCount
    nodes { ... on PullRequest { number title url updatedAt author { login } } }
  }
  mentions: search(query: $mentionsQ, type: ISSUE, first: 20) {
    issueCount
    nodes {
      ... on Issue { number title url updatedAt }
      ... on PullRequest { number title url updatedAt }
    }
  }
  mergedRecently: search(query: $mergedQ, type: ISSUE, first: 20) {
    issueCount
    nodes { ... on PullRequest { number title url mergedAt headRefName } }
  }
  rateLimit { cost remaining resetAt limit used nodeCount }
}

fragment IssueForActions on Issue {
  number title url state createdAt updatedAt
  author { login }
  labels(first: 20) { nodes { name } }
  comments(last: 10) {
    totalCount
    nodes { databaseId author { login __typename } createdAt body url }
  }
  projectItems(first: 5) {
    nodes {
      project { number title }
      fieldValueByName(name: "Status") {
        ... on ProjectV2ItemFieldSingleSelectValue { name updatedAt }
      }
    }
  }
  timelineItems(last: 20, itemTypes: [CROSS_REFERENCED_EVENT]) {
    nodes {
      ... on CrossReferencedEvent {
        createdAt
        source { ... on PullRequest { number url state createdAt mergedAt headRefName commits(last: 1) { nodes { commit { committedDate } } } } }
      }
    }
  }
}`;

export type ActionsSearchArgs = {
  assignedQ: string;
  prsQ: string;
  revReqQ: string;
  mentionsQ: string;
  mergedQ: string;
  closedQ: string;
};

/**
 * The six search strings, built from one repo and one login. `merged:>=` and
 * `closed:>=` are day-granular — the same qualifier `listMergedPrs` already uses.
 *
 * `assignedQ` stays `is:open`, and `closedQ` is the second half of that pair.
 * The measurement behind the split: a Pass CLOSES the issue in the same act — of
 * 68 Pass verdicts read live on 2026-08-12, **47 closed their issue within one
 * second of the comment**. Passes leaving the feed is benign; nothing is owed on
 * a pass.
 *
 * THE CASE THAT IS NOT BENIGN NOW HAS AN INSTANCE — though not the one this
 * comment predicted. **#4914, 2026-08-21.** The tester posted `Test Result:
 * Fail`, closed the issue as COMPLETED in the same second, and moved the card to
 * `Revisit` twelve seconds later. Note where the close came from: the TESTER,
 * not the promotion train the old note assumed. Nobody has to auto-close
 * anything for this to happen.
 *
 * AND THE SEARCH DID NOT LOSE IT. Measured 2026-08-21T19:45Z, two hours after
 * the close: `search(is:issue is:open assignee:<operator>)` still returned #4914,
 * and the node itself still read `state: OPEN`, while asking for the issue by
 * number returned CLOSED. GitHub's search index lags its own object store, so
 * the issue never left `assignedQ` — what went wrong on #4914 went wrong further
 * down, in `uatFailFor`, and is fixed there.
 *
 * `closedQ` stays, because the hole is real even though it is not the one that
 * bit: a close DOES eventually reach the index, and after it does, a send-back
 * on that issue would be unreachable. Two honest limits on it, both measured:
 *
 *  - the same lag applies here. A just-closed issue is in NEITHER search for a
 *    while — it reads open in one and has not arrived in the other — so this
 *    buys the days after the lag, not the minutes during it;
 *  - `first: 20` against 29 issues closed in seven days on this repo. The
 *    `truncated` line says so when it bites, which is the honest failure.
 *
 * Closed issues ride through `deriveActions` carrying `closed: true`, which
 * suppresses `assigned`, `comment`, `lane-change` and `uat-pass` — the four that
 * would turn a week of finished work into a feed full of noise. What survives is
 * the send-back, which is the whole reason they are here.
 *
 * `mentionsQ` is deliberately NOT widened. Dropping its `is:open` makes it
 * unbounded — every issue that has ever named the operator — and a mention on an
 * issue they are not assigned to is not the reported failure. #4914 was assigned
 * to them.
 */
export function buildActionsSearchArgs(repo: string, me: string, now: Date, mergedWindowDays = 7): ActionsSearchArgs {
  const since = new Date(now.getTime() - mergedWindowDays * 86_400_000).toISOString().slice(0, 10);
  return {
    assignedQ: `repo:${repo} is:issue is:open assignee:${me}`,
    prsQ: `repo:${repo} is:pr is:open author:${me}`,
    revReqQ: `repo:${repo} is:pr is:open review-requested:${me}`,
    mentionsQ: `repo:${repo} is:open mentions:${me}`,
    mergedQ: `repo:${repo} is:pr is:merged author:${me} merged:>=${since}`,
    closedQ: `repo:${repo} is:issue is:closed assignee:${me} closed:>=${since}`,
  };
}

export type GhActionsComment = {
  id: string;
  author: { login: string; typename: string };
  createdAt: string;
  body: string;
  url: string;
};

export type GhReferencingPr = {
  number: number;
  url: string;
  state: string;
  createdAt: string;
  mergedAt: string | null;
  /**
   * When this PR was last PUSHED to. Null when GitHub gave no commit.
   *
   * The decay rule needs it: `createdAt` only catches a fix that opened a NEW
   * PR after the verdict, and the other signal (`branchActivity`) needs a live
   * worktree, which a post-merge UAT fail usually no longer has. A fix pushed
   * to a PR that already existed had no signal at all and the row stayed red.
   * Free — measured `cost 1 / nodeCount 630` with and without.
   */
  lastCommitAt: string | null;
  /**
   * The PR's branch. Free — it is already in the omnibus.
   *
   * `referencingPrs` is every `CROSS_REFERENCED_EVENT`, which any PR whose body
   * merely says `#4502` creates. The branch name is the only thing in the set
   * that says whether the PR is that issue's OWN work, and it is the same test
   * the `changes-requested` row already uses to find its console row.
   */
  headRefName: string;
};

export type GhActionsIssue = {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  labels: string[];
  comments: GhActionsComment[];
  /** The `Status` single-select on the project board, e.g. `QA`. Null when the
   *  issue is on no board. */
  lane: string | null;
  /** When that lane value last changed — a GitHub-side event stamp, which is
   *  what makes a lane change notifiable more than once. */
  laneAt: string | null;
  /** Every PR that references this issue, merged or not. */
  referencingPrs: GhReferencingPr[];
  /** Just the merged ones, ascending by merge time. */
  mergedPrs: GhReferencingPr[];
  /**
   * The issue is CLOSED on GitHub. Closed issues are read for one reason — a
   * send-back that arrived on or after the close, which #4914 proved is a real
   * event — so everything else about them is suppressed downstream.
   */
  closed: boolean;
  /** When the work first SHIPPED — the earliest merge. Null when nothing has. */
  mergedAt: string | null;
};

export type GhActionsPr = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string;
  updatedAt: string;
  baseRefName: string;
  headRefName: string;
  labels: string[];
  latestReviews: Array<{ author: { login: string; typename: string }; state: string; submittedAt: string; body: string }>;
  comments: GhActionsComment[];
  /** The rollup state of the newest commit, and that commit's oid — the oid is
   *  what keeps "CI is red" one event rather than one per poll. */
  checkState: string;
  headOid: string;
};

export type GhSubjectRef = { number: number; title: string; url: string; updatedAt: string; actor: string };

export type ActionsPayload = {
  issues: GhActionsIssue[];
  prs: GhActionsPr[];
  reviewRequested: GhSubjectRef[];
  mentions: GhSubjectRef[];
  merged: Array<{ number: number; title: string; url: string; mergedAt: string; headRefName: string }>;
  /** What GitHub charged for this exact read, and what is left. Free to ask for. */
  quota: { cost: number; remaining: number; limit: number; resetAt: string } | null;
  /**
   * The first list GitHub had to cut short, named, with both numbers. Null when
   * everything came back whole.
   *
   * Every `first:` here is a silent cap, and `assigned: first: 30` disagrees
   * with `listIssues --limit 50` about the same population — so past 30 assigned
   * issues the row list would show work the feed omitted, and the feed would
   * still print "Nothing on GitHub needs you." `issueCount` costs nothing
   * (measured: `cost 1 / nodeCount 330` with and without) and is the only thing
   * that makes a short list distinguishable from a complete one.
   */
  truncated: string | null;
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const nodes = (v: unknown): unknown[] => arr(obj(v).nodes);

function parseComments(raw: unknown): GhActionsComment[] {
  return nodes(raw)
    .map(obj)
    .map((c) => ({
      id: c.databaseId === undefined || c.databaseId === null ? '' : String(c.databaseId),
      author: { login: str(obj(c.author).login), typename: str(obj(c.author).__typename) },
      createdAt: str(c.createdAt),
      body: str(c.body),
      url: str(c.url),
    }))
    .filter((c) => c.id !== '');
}

/**
 * The response, turned into plain data. Every alias is optional: GitHub answers a
 * partial document with `data` plus `errors`, and a missing alias must read as
 * "nothing there", never as a throw that empties the whole feed.
 */
/** First sighting of each number wins. The open search is passed first, so an
 *  issue that closed between the two searches reads as open for this poll. */
function dedupeByNumber(issues: readonly GhActionsIssue[]): GhActionsIssue[] {
  const byNumber = new Map<number, GhActionsIssue>();
  for (const i of issues) if (!byNumber.has(i.number)) byNumber.set(i.number, i);
  return [...byNumber.values()];
}

export function parseActionsPayload(raw: unknown): ActionsPayload {
  const d = obj(obj(raw).data);

  // Open and recently-closed, through ONE mapping — they come from one GraphQL
  // fragment, so the two can never drift apart on what an issue carries. Open
  // first: `dedupe` keeps the first sighting, and an issue closed between the two
  // searches must read as the open one the rest of the poll already believes in.
  const issues: GhActionsIssue[] = dedupeByNumber([...nodes(d.assigned), ...nodes(d.closedRecently)]
    .map(obj)
    .filter((i) => typeof i.number === 'number')
    .map((i) => {
      const lane = nodes(i.projectItems)
        .map(obj)
        .map((p) => obj(p.fieldValueByName))
        .find((f) => typeof f.name === 'string');
      const referencingPrs = nodes(i.timelineItems)
        .map(obj)
        .map((t) => obj(t.source))
        .filter((s) => typeof s.number === 'number')
        .map((s) => ({
          number: s.number as number,
          url: str(s.url),
          state: str(s.state),
          createdAt: str(s.createdAt),
          mergedAt: typeof s.mergedAt === 'string' ? s.mergedAt : null,
          headRefName: str(s.headRefName),
          lastCommitAt: (() => {
            const c = str(obj(nodes(s.commits)[0]).commit && obj(obj(nodes(s.commits)[0]).commit).committedDate);
            return c === '' ? null : c;
          })(),
        }));
      const mergedPrs = referencingPrs
        .filter((p): p is GhReferencingPr & { mergedAt: string } => typeof p.mergedAt === 'string' && p.mergedAt !== '')
        .sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
      return {
        number: i.number as number,
        title: str(i.title),
        url: str(i.url),
        updatedAt: str(i.updatedAt),
        labels: nodes(i.labels).map((l) => str(obj(l).name)),
        comments: parseComments(i.comments),
        lane: lane ? str(lane.name) : null,
        laneAt: lane && typeof lane.updatedAt === 'string' ? lane.updatedAt : null,
        referencingPrs,
        mergedPrs,
        // The EARLIEST merge: when the work shipped. A later fix PR must not push
        // the post-merge boundary forward and disqualify the verdict that asked
        // for the fix.
        mergedAt: mergedPrs[0]?.mergedAt ?? null,
        // Carried, not inferred from which search it arrived on, so one field
        // answers it wherever the issue is read. See `deriveActions`.
        closed: str(i.state).toUpperCase() === 'CLOSED',
      };
    }));

  const prs: GhActionsPr[] = nodes(d.myPrs)
    .map(obj)
    .filter((p) => typeof p.number === 'number')
    .map((p) => {
      const commit = obj(obj(nodes(p.commits)[0]).commit);
      return {
        number: p.number as number,
        title: str(p.title),
        url: str(p.url),
        isDraft: p.isDraft === true,
        reviewDecision: str(p.reviewDecision),
        updatedAt: str(p.updatedAt),
        baseRefName: str(p.baseRefName),
        headRefName: str(p.headRefName),
        labels: nodes(p.labels).map((l) => str(obj(l).name)),
        latestReviews: nodes(p.latestReviews)
          .map(obj)
          .map((r) => ({
            author: { login: str(obj(r.author).login), typename: str(obj(r.author).__typename) },
            state: str(r.state),
            submittedAt: str(r.submittedAt),
            body: str(r.body),
          })),
        comments: parseComments(p.comments),
        checkState: str(obj(commit.statusCheckRollup).state),
        headOid: str(commit.oid),
      };
    });

  const refs = (v: unknown): GhSubjectRef[] =>
    nodes(v)
      .map(obj)
      .filter((n) => typeof n.number === 'number')
      .map((n) => ({
        number: n.number as number,
        title: str(n.title),
        url: str(n.url),
        updatedAt: str(n.updatedAt),
        actor: str(obj(n.author).login),
      }));

  const rl = obj(d.rateLimit);
  const quota =
    typeof rl.remaining === 'number'
      ? {
          cost: typeof rl.cost === 'number' ? rl.cost : 0,
          remaining: rl.remaining,
          limit: typeof rl.limit === 'number' ? rl.limit : 0,
          resetAt: str(rl.resetAt),
        }
      : null;

  /** Each alias, what it asked for, and what it says it was called. Read in the
   *  order the feed cares about, so the first name is the one worth saying. */
  const caps: Array<[key: string, asked: number, what: string]> = [
    ['assigned', 30, 'assigned issues'],
    ['closedRecently', 20, 'recently closed issues'],
    ['myPrs', 20, 'your open PRs'],
    ['reviewRequested', 20, 'reviews asked of you'],
    ['mentions', 20, 'mentions'],
    ['mergedRecently', 20, 'recently merged PRs'],
  ];
  const truncated =
    caps
      .map(([key, asked, what]) => {
        const total = obj(d[key]).issueCount;
        return typeof total === 'number' && total > asked ? `${what} (${asked} of ${total} read)` : null;
      })
      .find((x) => x !== null) ?? null;

  return {
    issues,
    prs,
    reviewRequested: refs(d.reviewRequested),
    mentions: refs(d.mentions),
    merged: nodes(d.mergedRecently)
      .map(obj)
      .filter((p) => typeof p.number === 'number')
      .map((p) => ({
        number: p.number as number,
        title: str(p.title),
        url: str(p.url),
        mergedAt: str(p.mergedAt),
        headRefName: str(p.headRefName),
      })),
    quota,
    truncated,
  };
}

/** Run the omnibus. Read-only: one `gh api graphql` with a query document. */
export async function fetchActionsOnMe(
  repo: string,
  me: string,
  now = new Date(),
  mergedWindowDays = 7,
): Promise<ActionsPayload> {
  const a = buildActionsSearchArgs(repo, me, now, mergedWindowDays);
  const out = await gh([
    'api', 'graphql',
    '-f', `query=${ACTIONS_QUERY}`,
    '-f', `assignedQ=${a.assignedQ}`,
    '-f', `prsQ=${a.prsQ}`,
    '-f', `revReqQ=${a.revReqQ}`,
    '-f', `mentionsQ=${a.mentionsQ}`,
    '-f', `closedQ=${a.closedQ}`,
    '-f', `mergedQ=${a.mergedQ}`,
  ]);
  return parseActionsPayload(JSON.parse(out));
}

export type GraphqlQuota = { limit: number; remaining: number; resetAt: string };

/** The graphql bucket out of `GET /rate_limit`. */
export function parseRateLimit(raw: string): GraphqlQuota | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  const g = obj(obj(obj(o).resources).graphql);
  if (typeof g.remaining !== 'number' || typeof g.reset !== 'number') return null;
  return {
    limit: typeof g.limit === 'number' ? g.limit : 0,
    remaining: g.remaining,
    resetAt: new Date(g.reset * 1000).toISOString(),
  };
}

/**
 * What the graphql bucket has left, RIGHT NOW.
 *
 * `GET /rate_limit` is free on every bucket — verified: `core.used` stayed at 4
 * across three consecutive calls, and the graphql counter did not move. That
 * matters because the alternative was the `rateLimit` rider off the last
 * successful omnibus, which is up to fifteen minutes old about a bucket the
 * Claude worker sessions drain at 13–70 points a minute (measured: ~3,600 points
 * in 52 minutes). A reading of "900 left" can be 0 by the next poll.
 */
export async function readGraphqlQuota(): Promise<GraphqlQuota | null> {
  try {
    return parseRateLimit(await gh(['api', '/rate_limit']));
  } catch {
    return null;
  }
}

/**
 * Assigned first, then authored, deduplicated by number with the ASSIGNED copy
 * winning. Named `dedupe`, not `merge`: `actions-poll.test.ts` guards this module
 * against ever exporting a GitHub WRITER by matching names against
 * /^(post|create|update|delete|add|remove|merge|close)/, and a blunt guard with
 * teeth is worth more than an in-memory array helper's preferred name — it is the record the rest of the console already reasons about.
 */
export function dedupeIssueLists(assigned: readonly GhIssue[], authored: readonly GhIssue[]): GhIssue[] {
  const byNumber = new Map<number, GhIssue>();
  for (const i of assigned) byNumber.set(i.number, i);
  for (const i of authored) if (!byNumber.has(i.number)) byNumber.set(i.number, i);
  return [...byNumber.values()];
}

/**
 * Open issues that are THEIRS: assigned to the operator, or raised by them.
 *
 * It was `--assignee` alone, and that hid a whole normal category of work: a
 * spin-off filed out of an issue they are working is not assigned to anybody
 * unless the repo's autoassign workflow recognises the filer, and that workflow
 * only ever writes an assignee on `opened`. #4914 — authored by the operator,
 * `assignees: []` — was on GitHub and not in the console.
 *
 * Two calls rather than one search: GitHub's issue search has no dependable
 * `OR`, and `involves:` would drag in everything they have ever commented on.
 */
async function listIssuesBy(repo: string, flag: '--assignee' | '--author', who: string): Promise<GhIssue[]> {
  const out = await gh([
    'issue', 'list',
    '--repo', repo,
    flag, who,
    '--state', 'open',
    '--limit', '50',
    // `body` is free on a list call and carries the one fact the operator asked
    // for: which issue a spin-off came out of. See parent.ts.
    '--json', 'number,title,url,labels,updatedAt,author,body',
  ]);
  const raw = JSON.parse(out) as Array<{
    number: number;
    title: string;
    url: string;
    updatedAt: string;
    body?: string | null;
    labels: Array<{ name: string }>;
    author?: { login?: string };
  }>;
  return raw.map((i) => ({
    number: i.number,
    title: i.title,
    url: i.url,
    updatedAt: i.updatedAt,
    labels: i.labels.map((l) => l.name),
    author: i.author?.login ?? '',
    spunOffFrom: spunOffFrom(i.body),
  }));
}

export async function listIssues(repo: string, assignee: string): Promise<GhIssue[]> {
  const [assigned, authored] = await Promise.all([
    listIssuesBy(repo, '--assignee', assignee),
    listIssuesBy(repo, '--author', assignee),
  ]);
  return dedupeIssueLists(assigned, authored);
}

export type GhClosedIssue = { number: number; title: string; url: string; closedAt: string };

/**
 * Issues assigned to us that CLOSED inside a window — the status summary's
 * "Issues Closed". The `closed:>=` search qualifier does the work because
 * `gh issue list` pages by creation date: an issue filed months ago and closed
 * yesterday would fall off a plain `--limit` page entirely. The qualifier is
 * day-granular, so the exact cutoff is applied here. Read-only.
 */
export async function listClosedIssues(repo: string, assignee: string, sinceIso: string): Promise<GhClosedIssue[]> {
  const out = await gh([
    'issue', 'list',
    '--repo', repo,
    '--assignee', assignee,
    '--state', 'closed',
    '--search', `closed:>=${sinceIso.slice(0, 10)}`,
    '--limit', '100',
    '--json', 'number,title,url,closedAt',
  ]);
  const raw = JSON.parse(out) as Array<{ number: number; title: string; url: string; closedAt?: string }>;
  const sinceMs = Date.parse(sinceIso);
  return raw
    .map((i) => ({ number: i.number, title: i.title, url: i.url, closedAt: i.closedAt ?? '' }))
    .filter((i) => Date.parse(i.closedAt) >= sinceMs);
}

export type GhMergedPr = { number: number; title: string; url: string; mergedAt: string; headRefName: string };

/** Our PRs MERGED inside a window. Same day-granular search, same exact cutoff
 *  applied here. Read-only. */
export async function listMergedPrs(repo: string, author: string, sinceIso: string): Promise<GhMergedPr[]> {
  const out = await gh([
    'pr', 'list',
    '--repo', repo,
    '--author', author,
    '--state', 'merged',
    '--search', `merged:>=${sinceIso.slice(0, 10)}`,
    '--limit', '100',
    '--json', 'number,title,url,mergedAt,headRefName',
  ]);
  const raw = JSON.parse(out) as Array<{
    number: number;
    title: string;
    url: string;
    mergedAt?: string;
    headRefName?: string;
  }>;
  const sinceMs = Date.parse(sinceIso);
  return raw
    .map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      mergedAt: p.mergedAt ?? '',
      headRefName: p.headRefName ?? '',
    }))
    .filter((p) => Date.parse(p.mergedAt) >= sinceMs);
}

export type GhAuthoredPr = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  isDraft: boolean;
  reviewDecision: string;
  labels: string[];
  checks: Array<{ status: string; conclusion: string; state: string }>;
};

/**
 * Our own OPEN PRs, with where their review and their CI stand. An open PR is a
 * state rather than a window event, so this one is not date-bounded. Read-only.
 */
export async function listAuthoredOpenPrs(repo: string, author: string): Promise<GhAuthoredPr[]> {
  const out = await gh([
    'pr', 'list',
    '--repo', repo,
    '--author', author,
    '--state', 'open',
    '--limit', '50',
    '--json', 'number,title,url,headRefName,isDraft,reviewDecision,labels,statusCheckRollup',
  ]);
  const raw = JSON.parse(out) as Array<{
    number: number;
    title: string;
    url: string;
    headRefName?: string;
    isDraft?: boolean;
    reviewDecision?: string;
    labels?: Array<{ name?: string }>;
    statusCheckRollup?: Array<{ status?: string; conclusion?: string; state?: string }>;
  }>;
  return raw.map((p) => ({
    number: p.number,
    title: p.title,
    url: p.url,
    headRefName: p.headRefName ?? '',
    isDraft: p.isDraft ?? false,
    reviewDecision: p.reviewDecision ?? '',
    labels: (p.labels ?? []).map((l) => l.name ?? ''),
    checks: (p.statusCheckRollup ?? []).map((c) => ({
      status: c.status ?? '',
      conclusion: c.conclusion ?? '',
      state: c.state ?? '',
    })),
  }));
}

export type GhComment = { author: { login: string }; createdAt: string; body: string };

/** Comments on one issue — used to detect a third party's reply. Read-only. */
export async function viewIssueComments(repo: string, issue: number): Promise<GhComment[]> {
  const out = await gh(['issue', 'view', String(issue), '--repo', repo, '--json', 'comments']);
  const raw = JSON.parse(out) as { comments?: Array<{ author?: { login?: string }; createdAt?: string; body?: string }> };
  return (raw.comments ?? []).map((c) => ({
    author: { login: c.author?.login ?? '' },
    createdAt: c.createdAt ?? '',
    body: c.body ?? '',
  }));
}

export type GhReview = { author: { login: string }; state: string; submittedAt: string; body: string };
export type GhCommit = { committedDate: string };

/**
 * One PR's review signals — used to detect a change-request that needs rework,
 * and to tell whether a round has since been dealt with. The labels and commits
 * ride along on the same `gh pr view` so a poll is still one call per PR: the
 * `changes-requested` label and a commit that postdates the ask are how rework
 * done outside the console shows up. Read-only.
 */
export async function listPrReviews(
  repo: string,
  prNumber: number,
): Promise<{ reviews: GhReview[]; latestReviews: GhReview[]; labels: string[]; commits: GhCommit[] }> {
  const out = await gh([
    'pr', 'view', String(prNumber),
    '--repo', repo,
    '--json', 'reviews,latestReviews,labels,commits',
  ]);
  const raw = JSON.parse(out) as {
    reviews?: Array<{ author?: { login?: string }; state?: string; submittedAt?: string; body?: string }>;
    latestReviews?: Array<{ author?: { login?: string }; state?: string; submittedAt?: string; body?: string }>;
    labels?: Array<{ name?: string }>;
    commits?: Array<{ committedDate?: string }>;
  };
  const map = (arr: typeof raw.reviews): GhReview[] =>
    (arr ?? []).map((r) => ({
      author: { login: r.author?.login ?? '' },
      state: r.state ?? '',
      submittedAt: r.submittedAt ?? '',
      body: r.body ?? '',
    }));
  return {
    reviews: map(raw.reviews),
    latestReviews: map(raw.latestReviews),
    labels: (raw.labels ?? []).map((l) => l.name ?? ''),
    commits: (raw.commits ?? []).map((c) => ({ committedDate: c.committedDate ?? '' })),
  };
}

/** Open PRs keyed by head branch, so a worktree can find its own. */
export async function listOpenPrs(repo: string): Promise<Map<string, PullRequest>> {
  const out = await gh([
    'pr', 'list',
    '--repo', repo,
    '--state', 'open',
    '--limit', '100',
    // reviewDecision and labels are the two facts that say whether this PR can
    // be handed to a codeowner at all. They cost nothing extra on a list call.
    // reviewRequests + latestReviews answer "who is actually holding this" —
    // a read-only bot's CHANGES_REQUESTED is NOT the blocker, and naming it as
    // one sent the operator chasing a review bot on #4547. Both are free on a
    // list call.
    '--json', 'number,url,state,title,headRefName,isDraft,reviewDecision,labels,body,reviewRequests,latestReviews',
  ]);
  const raw = JSON.parse(out) as Array<{
    number: number;
    url: string;
    state: string;
    title: string;
    headRefName: string;
    isDraft: boolean;
    reviewDecision?: string | null;
    labels?: Array<{ name?: string }>;
    body?: string | null;
    reviewRequests?: Array<{ name?: string; login?: string }>;
    latestReviews?: Array<{ author?: { login?: string }; state?: string }>;
  }>;
  const map = new Map<string, PullRequest>();
  for (const p of raw) {
    map.set(p.headRefName, {
      number: p.number,
      url: p.url,
      state: p.state,
      title: p.title,
      isDraft: p.isDraft,
      mergedAt: null,
      reviewDecision: p.reviewDecision ?? null,
      changesRequested: (p.labels ?? []).some((l) => l?.name === 'changes-requested'),
      // The pre-merge checklist lives in the body and had never been read.
      checklist: parseChecklist(p.body),
      // And neither had the closing keyword beside it, which is the only thing
      // that says whether a PR referencing an issue is that issue's work.
      closes: closesIssues(p.body),
      // A team request has `name`, a person has `login`.
      reviewRequests: (p.reviewRequests ?? []).map((r) => r?.name ?? r?.login ?? '').filter((r) => r !== ''),
      latestReviews: (p.latestReviews ?? [])
        .map((r) => ({ author: r?.author?.login ?? '', state: r?.state ?? '' }))
        .filter((r) => r.author !== ''),
    });
  }
  return map;
}

/**
 * ONE EDGE TO THE WINDOW, because two roads that disagree about it lose PRs.
 *
 * `merged:>=YYYY-MM-DD` is a DATE qualifier: GitHub matches from 00:00 UTC that
 * day, so the primary's window runs WIDER than `sinceDaysAgo` by however far
 * into the day it is now — up to 24 hours. A fallback that dropped on the exact
 * instant instead would lose merges the primary keeps, and lose them silently:
 * no page is capped, nothing throws, the banner says "the whole window" and the
 * row quietly reverts to the checkpoint line. Worked through at 19:47 UTC on
 * 2026-09-05 — the primary asks for `merged:>=2026-08-22`, and a PR merged
 * 02:00 that day is inside its window and outside a naive one.
 *
 * So the date is computed once and the fallback drops on the instant that date
 * MEANS. Same reason `keepNewestMerge` is shared: a rule the two roads each
 * implement separately is a rule they eventually disagree about.
 */
function mergedSinceDate(now: Date, sinceDaysAgo: number): string {
  return new Date(now.getTime() - sinceDaysAgo * 86_400_000).toISOString().slice(0, 10);
}

/** The instant `mergedSinceDate` names: midnight UTC on that day. */
function mergedSinceMs(now: Date, sinceDaysAgo: number): number {
  return Date.parse(`${mergedSinceDate(now, sinceDaysAgo)}T00:00:00Z`);
}

/**
 * Recently-MERGED PRs, keyed by head branch — the other half of the picture.
 *
 * `listOpenPrs` is the only place the console learned about a PR, so the moment
 * one merged it vanished: the row's `pr` went null, `effectiveStage` fell back to
 * the stale `.issue-state.md` number, and finished work rendered as
 * "checkpoint — stopped after stage 7". Verified on 2026-08-11 for the issues
 * behind PRs #4368, #4446 and #4466 — all merged, all three rows lying.
 *
 * One extra read-only list per poll, not a `gh pr view` per tracked
 * branch (which would be N calls). `merged:>=` is day-granular, same qualifier
 * `listMergedPrs` already uses. Read-only, like everything else in this file.
 *
 * SCOPED TO THE AUTHOR, and that is the fix for a second instance of the very
 * bug above. Measured on 2026-08-12: **337** PRs merged on this repo inside the
 * 14-day window, against `--limit 100`. The hundred that came back were the
 * newest — an effective SIX-day window, silently, with the repo's merge rate
 * rising and the window shrinking as it does. Any worktree whose PR merged 7–14
 * days ago was missing from the map, so its row fell back to the stale
 * `.issue-state.md` and printed "checkpoint — stopped after stage 7" again.
 *
 * Scoping to the account the console runs as is not a narrowing of meaning: the
 * map is keyed by head branch and read ONLY for branches this console has a
 * worktree for, and those PRs are opened by its own workers — verified on the
 * three this docstring names (#4368, #4446, #4466 were all authored by the
 * console's own account). Same window, same one point, **3** rows instead of 337.
 */
export function recentMergedPrsArgs(repo: string, author: string, now: Date, sinceDaysAgo: number): string[] {
  return [
    'pr', 'list',
    '--repo', repo,
    '--author', author,
    '--state', 'merged',
    '--search', `merged:>=${mergedSinceDate(now, sinceDaysAgo)}`,
    '--limit', '100',
    // `body` for the closing keyword: a fix folded into another issue's PR is
    // usually read AFTER that PR merged, so the merged map needs it as much as
    // the open one does. See closes.ts.
    '--json', 'number,url,state,title,headRefName,isDraft,mergedAt,body',
  ];
}

/**
 * Branch reuse is real, and the newest merge on a branch is the one that
 * matters: an older merged PR on the same branch must not outrank it.
 *
 * ONE rule, shared by both readers below, for the reason the omnibus shares one
 * fragment between its two issue searches — the GraphQL path and the REST
 * fallback build the same map, and a tie-break they each implemented separately
 * is a tie-break they would eventually disagree about. A row would then answer
 * differently depending on which read answered, which is exactly the confusion
 * the fallback exists to remove.
 */
function keepNewestMerge(map: Map<string, PullRequest>, branch: string, pr: PullRequest): void {
  const held = map.get(branch);
  if (held && Date.parse(held.mergedAt ?? '') >= Date.parse(pr.mergedAt ?? '')) return;
  map.set(branch, pr);
}

/** `gh` itself, as a seam. Both readers take one so a test can answer them
 *  without a network, and so the fallback can be driven through the same fake
 *  that made the primary throw. Nothing here can do anything `gh` cannot. */
type GhRead = (args: string[]) => Promise<string>;

/** What the primary read produced, turned into the map. Pure. */
function parseMergedPrList(out: string): Map<string, PullRequest> {
  const raw = JSON.parse(out) as Array<{
    number: number;
    url: string;
    state: string;
    title: string;
    headRefName?: string;
    isDraft?: boolean;
    mergedAt?: string;
    body?: string | null;
  }>;
  const map = new Map<string, PullRequest>();
  for (const p of raw) {
    if (!p.headRefName) continue;
    keepNewestMerge(map, p.headRefName, {
      number: p.number,
      url: p.url,
      state: p.state || 'MERGED',
      title: p.title,
      isDraft: p.isDraft ?? false,
      mergedAt: p.mergedAt ?? null,
      closes: closesIssues(p.body),
    });
  }
  return map;
}

// ------------------------------------------ the same read, off the REST budget

/**
 * THE REST FALLBACK, and the day the console went blind.
 *
 * On 2026-09-05 GitHub rejected `recentMergedPrsArgs` with "API rate limit
 * already exceeded" while every documented counter read FULL — `graphql
 * 5000/5000` — and a cheap GraphQL query (`{viewer{login}}`) answered fine. That
 * is a query-COST / secondary limit, and `GET /rate_limit` never shows it. It
 * held for hours.
 *
 * `gh pr list` is GraphQL, so it was the console's only road to which PRs had
 * merged, and one cost limit closed it: 21 issues whose PRs had merged and were
 * sitting in the QA lane lost their PR, and the board went wrong all at once.
 *
 * REST is a SEPARATE budget and it was healthy the whole time — measured the same
 * hour, `core 4822/5000`. This is that road:
 *
 *     GET /repos/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100
 *
 * WHAT IT COSTS IN HONESTY, field by field, against what the primary builds:
 *
 *  - `number`, `title`, `html_url`, `draft`, `merged_at`, `head.ref` and `body`
 *    are all on the list row — every input the primary map is built from, so the
 *    entries are the SAME shape with the same key. Verified live on 2026-09-05.
 *  - `state` arrives as the literal `closed` for everything on this endpoint,
 *    merged or not. It is normalised to `MERGED` only for rows this filter kept,
 *    and the filter keeps a row on `merged_at` being non-null — so `MERGED` is
 *    read off GitHub, never assumed from the endpoint.
 *  - `reviewDecision`, labels/`changesRequested`, `reviewRequests` and
 *    `latestReviews` are NOT on a REST list row. They are not on the primary's
 *    map either — `recentMergedPrsArgs` never asks for them — so the fallback
 *    loses nothing here. It is the right call twice over: a merged PR is closed,
 *    and a review that can no longer block anything is not a fact the board acts
 *    on. They stay absent rather than being filled with a plausible value.
 *  - `checklist` is likewise absent on both, though `body` is right there. The
 *    fallback deliberately does NOT read it: the two paths have to produce the
 *    same map, and a fallback that quietly knows MORE than the primary makes a
 *    row's content depend on which read answered.
 *
 *  - `number` and `html_url` are typed optional here and required on the map
 *    entry, so a row missing either is DROPPED rather than defaulted. `#0`
 *    linking nowhere is a claim, and a wrong one; an unanswered branch is not.
 *
 * WHAT IT COSTS IN CALLS. REST has no `author:` filter, so the author test is
 * applied here, on rows the repo returns whole — case-insensitively, and after
 * expanding `@me`, because those are two things GitHub was doing for the primary
 * that a literal string compare would not. Sorting by `updated` descending makes
 * the walk bounded rather than a walk of history: `updated_at` is never older
 * than `merged_at`, so the first row whose `updated_at` falls outside the window
 * ends the paging — nothing after it can be inside. A quiet repo answers in one
 * page.
 *
 * WHAT IT CANNOT PROMISE. The walk is bounded by pages as well as by the window
 * (see `REST_PAGE_CAP`), and the page cap can bite first. When it does, the map
 * is short and `capped` says so all the way up: the banner reads as a warning
 * and every row the short map could not answer for says it cannot say, rather
 * than falling through to "checkpoint — stopped after stage 8". A degraded read
 * that stands in for a whole one is the 2026-09-05 board again, arrived at from
 * the other direction.
 */
const REST_PAGE_SIZE = 100;

/**
 * TEN PAGES, and what that number is and is NOT.
 *
 * It is a bound on COST, not a measurement of the repo. The population it walks
 * is every closed PR the repo touched inside the window — other people's, the
 * closed-and-never-merged, and old PRs that one comment dragged back to the top
 * of a `sort=updated` list. The only number this repo has ever measured is
 * **337** PRs merged repo-wide in 14 days (2026-08-12), and closed-and-touched
 * is strictly larger than that by two categories nobody has counted. An earlier
 * draft of this file put the cap at 500 rows and cited the 337 as headroom; that
 * was the merged count doing work it cannot do, so the number is set on the
 * other side of the trade instead: ten pages is ten REST points out of ~5000 an
 * hour on a budget the console barely touches, and it only ever spends them on
 * the rare poll the primary road is shut.
 *
 * When the cap does fire the read is SHORT, short at the old end of the window,
 * and — this is the part that matters — the console treats it as a read it could
 * not complete. It does not quietly stand in for a whole one: see
 * `#prsUnreadable` in orchestrator.ts, where a capped map sends every row it
 * could not answer for to `unreadable` rather than to the checkpoint line. The
 * alternative to a cap is worse than a short read: an uncapped loop against the
 * second budget is how a fallback turns one blinded read into two.
 */
const REST_PAGE_CAP = 10;

export function restMergedPrsArgs(repo: string, page: number): string[] {
  return [
    'api',
    // Explicit, though `gh api` already defaults to it. Every call in this file
    // is a list, and the method is the one word that says so out loud.
    '--method', 'GET',
    `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${REST_PAGE_SIZE}&page=${page}`,
  ];
}

type RestPage = {
  /** Merged, ours, inside the window — ready for the map. */
  entries: Array<[string, PullRequest]>;
  /** A row on this page is older than the window. Sorted by `updated`
   *  descending, so nothing after it can be inside: stop. */
  pastWindow: boolean;
  /** How many rows the page held at all, window or not. A short page is the
   *  last page. */
  rows: number;
};

/** One page, turned into map entries and a verdict on whether to ask for the
 *  next. Pure — every judgement it makes is on the row in front of it. */
function parseRestMergedPage(out: string, author: string, sinceMs: number): RestPage {
  const raw = JSON.parse(out) as Array<{
    number?: number;
    html_url?: string;
    title?: string;
    draft?: boolean;
    merged_at?: string | null;
    updated_at?: string | null;
    body?: string | null;
    user?: { login?: string } | null;
    head?: { ref?: string } | null;
  }>;
  const entries: Array<[string, PullRequest]> = [];
  let pastWindow = false;
  for (const p of raw) {
    const updatedMs = Date.parse(p.updated_at ?? '');
    // A row we cannot date does not end the paging: unreadable is not old.
    if (Number.isFinite(updatedMs) && updatedMs < sinceMs) pastWindow = true;
    const branch = p.head?.ref ?? '';
    const mergedAt = p.merged_at ?? null;
    const mergedMs = Date.parse(mergedAt ?? '');
    // Closed and never merged is not a merge. A stranger's PR is not ours. A
    // merge older than the window is not in the window — and the endpoint sorts
    // by `updated`, so one can ride in on a comment long after the fact.
    if (!branch || mergedAt === null) continue;
    // Case-insensitively, because the primary does not compare at all: it hands
    // `--author` to GitHub, whose logins are case-insensitive. A row that the
    // search road keeps and this road drops is a PR that vanishes on the poll
    // GitHub is already having a bad day.
    if ((p.user?.login ?? '').toLowerCase() !== author.toLowerCase()) continue;
    if (!Number.isFinite(mergedMs) || mergedMs < sinceMs) continue;
    // NO PR WITHOUT AN IDENTITY. A row missing `number` or `html_url` cannot be
    // rendered as anything true — `#0`, linking nowhere — and a map entry is a
    // positive claim that this branch's work merged as that PR. Dropping the row
    // leaves the branch unanswered, which is the honest shape of not knowing.
    if (typeof p.number !== 'number' || !p.html_url) continue;
    entries.push([
      branch,
      {
        number: p.number,
        url: p.html_url,
        // Measured, not assumed: this row has a `merged_at`.
        state: 'MERGED',
        title: p.title ?? '',
        isDraft: p.draft ?? false,
        mergedAt,
        closes: closesIssues(p.body),
      },
    ]);
  }
  return { entries, pastWindow, rows: raw.length };
}

/**
 * `@me` IS NOT A LOGIN, and the fallback is the only road that has to know it.
 *
 * `--author @me` is gh's own token for the account the token belongs to, and the
 * primary never has to expand it — GitHub does, server-side. The REST list has
 * no author filter, so this road compares against `user.login`, which is never
 * literally `@me`. Configured as `ASSIGNEE=@me` (see config.ts) the primary
 * would keep working and the fallback would match nothing: an EMPTY map, no
 * error, no cap — the worst shape there is, because it looks like a complete
 * read of a repo where nothing merged.
 *
 * So it is expanded, with a read, on the healthy budget, and only when it has
 * to be. A failure to expand it throws rather than filtering on a value that
 * cannot match: the caller then reports both roads down, and no row claims to
 * know where its PR stands. Read-only, like everything else here.
 */
async function resolveRestAuthor(author: string, read: GhRead): Promise<string> {
  if (author !== '@me') return author;
  const login = (JSON.parse(await read(['api', '--method', 'GET', 'user'])) as { login?: string }).login ?? '';
  if (!login) throw new Error('could not expand @me to a login');
  return login;
}

/** The merged map off the REST budget. Read-only: `GET`, and nothing else. */
async function listMergedPrsViaRest(
  repo: string,
  configuredAuthor: string,
  sinceDaysAgo: number,
  now: Date,
  read: GhRead,
): Promise<{ prs: Map<string, PullRequest>; capped: boolean }> {
  const author = await resolveRestAuthor(configuredAuthor, read);
  // The same instant the primary's `merged:>=` date means, not a fresh one:
  // see `mergedSinceDate`.
  const sinceMs = mergedSinceMs(now, sinceDaysAgo);
  const map = new Map<string, PullRequest>();
  let capped = true;
  for (let page = 1; page <= REST_PAGE_CAP; page++) {
    const { entries, pastWindow, rows } = parseRestMergedPage(await read(restMergedPrsArgs(repo, page)), author, sinceMs);
    for (const [branch, pr] of entries) keepNewestMerge(map, branch, pr);
    // Either the window ended or the repo did. Both mean the read is WHOLE, and
    // only running out of pages leaves it short.
    if (pastWindow || rows < REST_PAGE_SIZE) {
      capped = false;
      break;
    }
  }
  return { prs: map, capped };
}

/**
 * What the console did instead of the read it wanted, when it could not have it.
 * Handed to `onFallback` and to nobody else — a degraded read that says nothing
 * is the 2026-09-05 incident with a happier ending and the same silence.
 */
export type MergedPrsFallback = {
  /** Why the primary read was refused, first line only. */
  because: string;
  /** How many merged PRs REST put in the map. */
  found: number;
  /** The paging ran out of pages before it ran out of window, so a merge early
   *  in the window may be missing. */
  capped: boolean;
};

/** A `gh` failure's one useful line. The rest is the CLI's own noise. */
const firstLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? 'no reason given';

export type MergedPrsOptions = {
  sinceDaysAgo?: number;
  /** Called when, and only when, REST answered a read GraphQL refused. */
  onFallback?: (note: MergedPrsFallback) => void;
  /** The exec seam. Tests pass a fake; nothing in the console does. */
  read?: GhRead;
  /** The clock, so a test can stand on the window edge. Both roads read the
   *  same one — the whole point of `mergedSinceDate`. */
  now?: Date;
};

/**
 * GraphQL first, REST second, and a throw only when both are gone.
 *
 * The order is not a preference between two equals. `gh pr list` is one cheap
 * request that GitHub filters by author server-side; REST is up to five requests
 * the console filters itself. The fallback is for the hours the first road is
 * closed, and it stays a fallback so a healthy console never pays for it.
 *
 * A caller that passes `onFallback` learns which road answered. One that does
 * not gets the map either way, which is the point — every read downstream of
 * this is about PRs, not about GitHub's rate limiter.
 */
export async function listRecentMergedPrs(
  repo: string,
  author: string,
  opts: MergedPrsOptions = {},
): Promise<Map<string, PullRequest>> {
  const { sinceDaysAgo = 14, onFallback, read = gh, now = new Date() } = opts;
  try {
    return parseMergedPrList(await read(recentMergedPrsArgs(repo, author, now, sinceDaysAgo)));
  } catch (primary) {
    const because = firstLine(primary);
    let viaRest;
    try {
      viaRest = await listMergedPrsViaRest(repo, author, sinceDaysAgo, now, read);
    } catch (fallback) {
      // BOTH ROADS SHUT. It throws, exactly as it did before this fallback
      // existed, so the caller still records a failed read and no row claims to
      // know where its PR stands. Both reasons ride on the message: which one is
      // down is the diagnosis, and "rate limited, and the other budget 404s" is
      // a different morning from "rate limited".
      throw new Error(`${because} — and the REST fallback failed too: ${firstLine(fallback)}`);
    }
    onFallback?.({ because, found: viaRest.prs.size, capped: viaRest.capped });
    return viaRest.prs;
  }
}

// ----------------------------------------------- one issue's project board card

/**
 * The card for ONE issue on ONE named board, read fresh.
 *
 * Separate from the omnibus poll's project parse on purpose: that one takes the
 * first project item carrying any Status and discards which project it came from,
 * which is fine for a display string and wrong for aiming a write. An issue can sit
 * on several boards. This matches the project NUMBER and returns null otherwise.
 *
 * Read-only. Its whole job is to be the value board.ts writes against, taken close
 * enough to the write that a lane cannot have gone stale in between.
 */
export type BoardItem = {
  itemId: string;
  projectId: string;
  fieldId: string;
  /** The lane right now, as GitHub spells it. */
  lane: string;
  optionIdByName: Record<string, string>;
};

/** Exported for its tests: the parse, with no I/O. */
export function parseBoardItem(raw: unknown, projectNumber: number): BoardItem | null {
  const items = nodes(obj(obj(obj(obj(raw).data).repository).issue).projectItems);
  for (const node of items) {
    const n = obj(node);
    const project = obj(n.project);
    if (project.number !== projectNumber) continue;

    const value = obj(n.fieldValueByName);
    const field = obj(value.field);
    const lane = str(value.name);
    const itemId = str(n.id);
    const projectId = str(project.id);
    const fieldId = str(field.id);
    // Half a card is not a card: anything missing means we cannot aim a write.
    if (!lane || !itemId || !projectId || !fieldId) return null;

    const optionIdByName: Record<string, string> = {};
    for (const o of arr(field.options)) {
      const opt = obj(o);
      const name = str(opt.name);
      const id = str(opt.id);
      if (name && id) optionIdByName[name] = id;
    }
    return { itemId, projectId, fieldId, lane, optionIdByName };
  }
  return null;
}

const BOARD_ITEM_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ issue(number:$number){
    projectItems(first:10){ nodes {
      id
      project { number id }
      fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue {
        name field { ... on ProjectV2SingleSelectField { id options { id name } } } } }
    } } } } }`;

/**
 * Null on any failure — a write that cannot read its target must not proceed.
 *
 * A null `projectNumber` is one of those failures and the cheapest one: it is
 * `BOARD_PROJECT_NUMBER` unset, which means there is no board (see config.ts).
 * Answering it here rather than at the call site keeps the "no board" case on
 * the same road as every other unreadable card — `decideBoardMove` fails closed
 * on a null card — instead of asking every caller to remember the setting.
 */
export async function readBoardItem(repo: string, issue: number, projectNumber: number | null): Promise<BoardItem | null> {
  if (projectNumber === null) return null;
  const [owner, name] = repo.split('/');
  if (!owner || !name) return null;
  try {
    const out = await gh([
      'api', 'graphql',
      '-f', `query=${BOARD_ITEM_QUERY}`,
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '-F', `number=${issue}`,
    ]);
    return parseBoardItem(JSON.parse(out), projectNumber);
  } catch {
    return null;
  }
}

// ------------------------------------------------- issues behind an orphan worktree

/**
 * What GitHub says about an issue we are NOT holding in the open list.
 *
 * `listIssues` is deliberately narrow — open, and assigned to or raised by the
 * operator — so an issue can drop out of it for three unrelated reasons: it
 * closed, it was reassigned, or it simply fell off the fifty-issue page. A
 * worktree outlives all three, and the row the console synthesizes for it used to
 * say the same sentence for every one: "worktree with no matching open issue".
 * The operator read that on #5697, which had closed the day before, as a fault in
 * the console.
 *
 * One `gh issue view` per number, in parallel, each swallowing its own failure:
 * a number that cannot be read is simply absent from the map, and the caller
 * falls back to the sentence that admits it does not know. Read-only.
 */
export type GhIssueFacts = {
  number: number;
  title: string;
  url: string;
  labels: string[];
  updatedAt: string;
  author: string;
  state: 'OPEN' | 'CLOSED';
  /** Null while it is open. */
  closedAt: string | null;
  /** Logins, so the caller can ask whether it is still the operator's. */
  assignees: string[];
};

export async function describeIssues(
  repo: string,
  numbers: readonly number[],
): Promise<Map<number, GhIssueFacts>> {
  const read = await Promise.all(
    numbers.map(async (number): Promise<GhIssueFacts | null> => {
      try {
        const out = await gh([
          'issue', 'view', String(number),
          '--repo', repo,
          '--json', 'number,title,url,labels,updatedAt,author,state,closedAt,assignees',
        ]);
        const i = JSON.parse(out) as {
          number: number;
          title: string;
          url: string;
          updatedAt: string;
          state: string;
          closedAt?: string | null;
          labels: Array<{ name: string }>;
          author?: { login?: string };
          assignees?: Array<{ login?: string }>;
        };
        return {
          number: i.number,
          title: i.title,
          url: i.url,
          labels: i.labels.map((l) => l.name),
          updatedAt: i.updatedAt,
          author: i.author?.login ?? '',
          // Anything that is not the word GitHub uses for open is closed. A
          // state we do not recognise must not read as "still open" on a row
          // whose whole point is to say the issue has gone.
          state: i.state.toUpperCase() === 'OPEN' ? 'OPEN' : 'CLOSED',
          closedAt: i.closedAt ?? null,
          assignees: (i.assignees ?? []).map((a) => a.login ?? '').filter((l) => l !== ''),
        };
      } catch {
        return null;
      }
    }),
  );
  return new Map(read.filter((i): i is GhIssueFacts => i !== null).map((i) => [i.number, i]));
}

// ------------------------------------------------------ why an issue is blocked

/**
 * The comment the person who labelled an issue `blocked` left to say WHY.
 *
 * The label's own description on the tracker repo requires the labeller to name
 * the external dependency in a comment — so the answer is guaranteed by policy to
 * be in a comment, and the console was reading the one place it never is: the
 * worker's gate history. On #5674 the row read "blocked —
 * Ready to hand over, and there is no pull request to hand over", the worker's
 * account of where IT stopped, while the human's comment two seconds after the
 * label said the fix already exists on `dev` and unblocks when it reaches `main`.
 *
 * ONE read, because the issue timeline carries both halves in one chronological
 * list: `labeled` events with the actor, and `commented` events with the body.
 * The comment is matched by AUTHOR and taken nearest in time to the label in
 * either direction — people write the sentence just before labelling about as
 * often as just after. Read-only.
 */
export type GhBlockedNote = { by: string; at: string; body: string };

export async function readBlockedNote(repo: string, issue: number): Promise<GhBlockedNote | null> {
  return parseBlockedNote(await gh(['api', `repos/${repo}/issues/${issue}/timeline`, '--paginate']));
}

/** The parsing half, kept separate so it can be tested against a real timeline
 *  without shelling out — the convention `parseBoardItem` already follows. */
export function parseBlockedNote(raw: string): GhBlockedNote | null {
  const events = JSON.parse(raw) as Array<{
    event?: string;
    created_at?: string;
    body?: string;
    label?: { name?: string };
    actor?: { login?: string };
    user?: { login?: string };
  }>;
  // The LAST application. A label can be removed and put back, and it is the
  // current one the row is wearing that has to be explained.
  const labelled = events.filter((e) => e.event === 'labeled' && e.label?.name === 'blocked').pop();
  const by = labelled?.actor?.login ?? '';
  const at = Date.parse(labelled?.created_at ?? '');
  if (by === '' || !Number.isFinite(at)) return null;

  const said = events
    .filter((e) => e.event === 'commented' && (e.user?.login ?? '') === by && (e.body ?? '').trim() !== '')
    .map((e) => ({ body: (e.body ?? '').trim(), at: Date.parse(e.created_at ?? '') }))
    .filter((c) => Number.isFinite(c.at))
    .sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
  // Labelled and never explained. The row falls back to what the worker said,
  // which is what it had before this read existed.
  if (!said) return null;
  return { by, at: labelled?.created_at ?? '', body: said.body };
}
