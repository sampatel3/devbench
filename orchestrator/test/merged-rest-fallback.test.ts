import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { fallbackBanner } from '../src/quota.js';
import { listRecentMergedPrs, recentMergedPrsArgs, restMergedPrsArgs, type MergedPrsFallback } from '../src/gh.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { PullRequest, ResourceReport } from '../src/types.js';

/**
 * THE SECOND HALF OF 2026-09-05: the console had ONE road to a merged PR.
 *
 * GitHub refused the GraphQL query behind `listRecentMergedPrs` — "API rate limit
 * already exceeded" — for hours, while every documented counter read full
 * (`graphql 5000/5000`) and a cheap GraphQL query answered fine. A query-COST
 * limit, which `GET /rate_limit` does not show.
 *
 * `unreadable.test.ts` pins what the rows say when that happens. This file pins
 * the console not having to say it: `gh pr list` is GraphQL, and REST is a
 * separate budget that was healthy the whole time (measured the same hour,
 * `core 4822/5000`). One refused read should degrade the console, not blind it.
 *
 * Nothing here touches the network. Both roads go through an injected `read`,
 * which is the only thing either of them can do.
 *
 * AND THIS FILE OPTS OUT OF ANY SUITE-WIDE STUB OF ITS SUBJECT, which is the one
 * thing it must do that no other file does. `test/setup/no-github.ts` holds the
 * reads a poll makes inert for every test in the suite, so that a fixture which
 * never mentions a merged PR cannot spend a round trip on one — a real guard,
 * and right everywhere else. Here it would mock out the subject: this whole file
 * is about which road the REAL function takes, driven through an injected `read`
 * that cannot reach a network either way. So the stub is lifted per test, and
 * the console block below re-applies its own `vi.spyOn` inside each test, which
 * is the convention `no-github.ts` names for a test that wants a read back.
 *
 * Guarded rather than assumed, because whether the suite stubs this particular
 * read is not this file's business to depend on — it only needs the real one.
 */
beforeEach(() => {
  if (vi.isMockFunction(gh.listRecentMergedPrs)) gh.listRecentMergedPrs.mockRestore();
});

const AUTHOR = 'operator';
const REPO = 'example-org/example-repo';
const ISSUE = 4336;
const BRANCH = `fix/issue-${ISSUE}-demo`;
const PR = 4446;
const MERGED_AT = '2026-09-04T22:04:00Z';
/**
 * THE CLOCK, PINNED, and late enough in the UTC day to have an opinion.
 *
 * The window edge is the one thing the two roads compute rather than read, so a
 * test of it cannot float: at 19:47 UTC the primary's `merged:>=` date names a
 * midnight nearly twenty hours before the naive instant, and that gap is the
 * whole subject of `mergedSinceDate`. Every row below is dated against this
 * rather than against `Date.now()`, so the block says the same thing next month
 * as it does today.
 */
const NOW = new Date('2026-09-05T19:47:11Z');
const daysBefore = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

/** The exact GitHub answer that caused it: a rejection with the quota full. */
const RATE_LIMITED = () => new Error('API rate limit already exceeded for installation ID 12345.');

/** One row of `GET /repos/{repo}/pulls?state=closed`, as the live endpoint
 *  returns it — verified field for field against the repo on 2026-09-05. */
const restRow = (over: Record<string, unknown> = {}) => ({
  number: PR,
  html_url: `https://github.com/example-org/example-repo/pull/${PR}`,
  title: 'fix(pills): org sysadmin filter',
  draft: false,
  // The endpoint says `closed` for everything on it, merged or not.
  state: 'closed',
  merged_at: MERGED_AT,
  updated_at: '2026-09-04T22:05:00Z',
  body: `Closes #${ISSUE}.`,
  user: { login: AUTHOR },
  head: { ref: BRANCH },
  ...over,
});

/** What `gh pr list --json ...` returns for the same PR, for the primary road. */
const graphqlRow = (over: Record<string, unknown> = {}) => ({
  number: PR,
  url: `https://github.com/example-org/example-repo/pull/${PR}`,
  state: 'MERGED',
  title: 'fix(pills): org sysadmin filter',
  headRefName: BRANCH,
  isDraft: false,
  mergedAt: MERGED_AT,
  body: `Closes #${ISSUE}.`,
  ...over,
});

type Call = { args: string[]; road: 'graphql' | 'rest' | 'whoami' };

/**
 * The exec seam, with a road per answer. `gh pr list` is the GraphQL road and
 * `gh api` is the REST one, which is the whole distinction this file is about.
 * `gh api user` is neither: it is the REST road expanding `@me` before it can
 * filter, and it gets its own name so a test can count pages without counting it.
 */
function fakeGh(answer: {
  graphql?: () => unknown;
  rest?: (page: number) => unknown;
  user?: () => unknown;
}): { read: (args: string[]) => Promise<string>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    read: async (args: string[]) => {
      const path = args[args.length - 1] ?? '';
      const road = args[0] !== 'api' ? 'graphql' : path === 'user' ? 'whoami' : 'rest';
      calls.push({ args, road });
      if (road === 'graphql') {
        if (!answer.graphql) throw new Error('gh: no graphql answer in this test');
        return JSON.stringify(answer.graphql());
      }
      if (road === 'whoami') {
        if (!answer.user) throw new Error('gh: HTTP 401 Bad credentials');
        return JSON.stringify(answer.user());
      }
      if (!answer.rest) throw new Error('gh: no rest answer in this test');
      return JSON.stringify(answer.rest(Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '1')));
    },
  };
}

describe('the road the merged-PR read takes', () => {
  it('is GraphQL when GraphQL answers, and REST is never called at all', async () => {
    const { read, calls } = fakeGh({ graphql: () => [graphqlRow()] });
    const map = await listRecentMergedPrs(REPO, AUTHOR, { read, now: NOW });

    expect(map.get(BRANCH)!.number).toBe(PR);
    // The fallback is a fallback. A healthy console pays for one cheap request.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.road).toBe('graphql');
  });

  it('is REST when GraphQL is refused, and the map is the same map', async () => {
    const { read, calls } = fakeGh({ graphql: () => { throw RATE_LIMITED(); }, rest: () => [restRow()] });
    const map = await listRecentMergedPrs(REPO, AUTHOR, { read, now: NOW });

    // Same key — the head branch — because that is how a worktree finds its own.
    expect([...map.keys()]).toEqual([BRANCH]);
    expect(map.get(BRANCH)).toEqual({
      number: PR,
      url: `https://github.com/example-org/example-repo/pull/${PR}`,
      // Read off `merged_at`, not assumed from the endpoint, which said `closed`.
      state: 'MERGED',
      title: 'fix(pills): org sysadmin filter',
      isDraft: false,
      mergedAt: MERGED_AT,
      closes: [ISSUE],
    } satisfies PullRequest);
    expect(calls.map((c) => c.road)).toEqual(['graphql', 'rest']);
  });

  it('throws when BOTH roads are shut, naming both — the caller still records it', async () => {
    const { read } = fakeGh({
      graphql: () => { throw RATE_LIMITED(); },
      rest: () => { throw new Error('gh: HTTP 502 Bad Gateway'); },
    });
    // It must still reject: a console that cannot read a PR list may not let a
    // row say "there is no pull request". See `#prsUnreadable`.
    await expect(listRecentMergedPrs(REPO, AUTHOR, { read, now: NOW })).rejects.toThrow(/rate limit already exceeded/);
    await expect(listRecentMergedPrs(REPO, AUTHOR, { read, now: NOW })).rejects.toThrow(
      /REST fallback failed too: gh: HTTP 502 Bad Gateway/,
    );
  });

  it('asks REST for a GET list of closed PRs, newest activity first', async () => {
    const args = restMergedPrsArgs(REPO, 3);
    expect(args[0]).toBe('api');
    expect(args[args.indexOf('--method') + 1]).toBe('GET');
    const path = args[args.length - 1]!;
    expect(path).toContain(`repos/${REPO}/pulls`);
    expect(path).toContain('state=closed');
    // Sorted by `updated` descending is what makes the paging bounded: the first
    // row outside the window ends it.
    expect(path).toContain('sort=updated');
    expect(path).toContain('direction=desc');
    expect(path).toContain('per_page=100');
    expect(path).toContain('page=3');
  });
});

/**
 * WHAT REST HANDS BACK IS NOT WHAT REST IS ASKED FOR. The endpoint is repo-wide
 * and has no `author:` filter, so every test the GraphQL search did server-side
 * is applied here, on the row.
 */
describe('what the REST road keeps, and what it drops', () => {
  const viaRest = async (rows: unknown[]) => {
    const { read } = fakeGh({ graphql: () => { throw RATE_LIMITED(); }, rest: () => rows });
    return listRecentMergedPrs(REPO, AUTHOR, { read, now: NOW });
  };

  it('drops a merge older than the window', async () => {
    const old = restRow({
      head: { ref: 'fix/issue-9999-ancient' },
      merged_at: daysBefore(30),
      // Updated yesterday — somebody commented on it. `updated` sorting brings
      // it back onto page one long after the merge, and it is still out.
      updated_at: daysBefore(1),
    });
    const map = await viaRest([old, restRow()]);
    expect([...map.keys()]).toEqual([BRANCH]);
  });

  /**
   * THE EDGE ITSELF, which the two roads compute rather than read.
   *
   * `merged:>=2026-08-22` is a DATE: GitHub matches it from 00:00 UTC, so the
   * primary keeps a PR merged at 02:00 that morning. A fallback measuring 14
   * days back from the exact instant would start at 19:47 and drop it — and drop
   * it in the worst possible way, since nothing failed and no page was capped:
   * the banner would say "the whole window" over a row that had quietly reverted
   * to the checkpoint line. The gap is as wide as the time of day.
   */
  it('keeps a merge the PRIMARY would keep, on the far edge of the window', async () => {
    // Read off the primary's own query, so the two roads are compared rather
    // than each checked against a number written down here.
    const search = recentMergedPrsArgs(REPO, AUTHOR, NOW, 14).find((a) => a.startsWith('merged:>='))!;
    const since = search.slice('merged:>='.length);
    expect(since).toBe('2026-08-22');

    const dawn = restRow({
      head: { ref: 'fix/issue-4200-dawn' },
      // Inside `merged:>=2026-08-22`, and nineteen hours older than an instant
      // measured from now.
      merged_at: `${since}T02:00:00Z`,
      updated_at: `${since}T02:05:00Z`,
    });
    const map = await viaRest([restRow(), dawn]);
    expect([...map.keys()].sort()).toEqual([BRANCH, 'fix/issue-4200-dawn'].sort());
  });

  it('drops a PR somebody else opened', async () => {
    const theirs = restRow({ head: { ref: 'feat/someone-else' }, user: { login: 'pr-swarm' } });
    const map = await viaRest([theirs, restRow()]);
    expect([...map.keys()]).toEqual([BRANCH]);
  });

  /**
   * GITHUB LOGINS ARE CASE-INSENSITIVE, and the primary never has to know it —
   * it hands `--author` to the search API. A literal compare here would drop
   * every PR the console's own worker opened, on the poll GitHub is already
   * refusing the other road: an EMPTY map, no error, no cap, and a banner
   * claiming a complete read of a repo where nothing merged.
   */
  it('keeps our own PR when the login is cased differently', async () => {
    const shouty = restRow({ user: { login: 'Operator' } });
    const map = await viaRest([shouty]);
    expect(map.get(BRANCH)!.number).toBe(PR);
  });

  /**
   * NO PR WITHOUT AN IDENTITY. `number` and `html_url` are required on the map
   * entry and optional on the wire, and a defaulted row renders as "PR #0"
   * linking nowhere — a claim, and a false one. An unanswered branch is not.
   */
  it('drops a row with no number or no url rather than inventing one', async () => {
    const noNumber = restRow({ number: undefined, head: { ref: 'fix/issue-1-nameless' } });
    const noUrl = restRow({ html_url: undefined, head: { ref: 'fix/issue-2-placeless' } });
    const map = await viaRest([noNumber, noUrl, restRow()]);
    expect([...map.keys()]).toEqual([BRANCH]);
  });

  it('drops a closed PR that never merged — closed is not merged', async () => {
    const abandoned = restRow({ head: { ref: 'fix/issue-1234-abandoned' }, merged_at: null });
    const map = await viaRest([abandoned, restRow()]);
    expect([...map.keys()]).toEqual([BRANCH]);
  });

  it('keeps the NEWEST merge when a branch was reused, same rule as GraphQL', async () => {
    const older = restRow({ number: 4000, merged_at: '2026-08-30T10:00:00Z' });
    const map = await viaRest([older, restRow()]);
    expect(map.get(BRANCH)!.number).toBe(PR);
    expect(map.get(BRANCH)!.mergedAt).toBe(MERGED_AT);
  });

  /**
   * The fields REST cannot give, and why leaving them out is the honest answer
   * rather than the lazy one. `reviewDecision`, `changesRequested`,
   * `reviewRequests` and `latestReviews` are not on a REST list row — and they
   * are not on the GraphQL merged map either, because `recentMergedPrsArgs`
   * never asks for them. A merged PR is closed; a review that can no longer
   * block anything is not a fact the board acts on. `checklist` is absent from
   * both too, though `body` is right there on the REST row: a fallback that
   * quietly knows MORE than the primary makes a row's content depend on which
   * read answered.
   */
  it('produces exactly the fields the GraphQL road produces — no more, no less', async () => {
    const { read: goodRead } = fakeGh({ graphql: () => [graphqlRow()] });
    const viaGraphql = await listRecentMergedPrs(REPO, AUTHOR, { read: goodRead, now: NOW });
    const rest = await viaRest([restRow()]);

    expect(Object.keys(rest.get(BRANCH)!).sort()).toEqual(Object.keys(viaGraphql.get(BRANCH)!).sort());
    expect(rest.get(BRANCH)).toEqual(viaGraphql.get(BRANCH));
    for (const field of ['reviewDecision', 'changesRequested', 'checklist', 'reviewRequests', 'latestReviews'] as const) {
      expect(rest.get(BRANCH)![field]).toBeUndefined();
    }
  });
});

/**
 * `@me` IS NOT A LOGIN, and it is a configured value (`ASSIGNEE`, config.ts).
 *
 * The primary hands it to gh, which expands it server-side. The REST list has no
 * author filter, so this road compares against `user.login` — never literally
 * `@me`. Left alone, the fallback would match nothing and return an empty map
 * with nothing failed and nothing capped: the shape that looks exactly like a
 * complete read of a repo where nothing merged.
 */
describe('the author the REST road filters on', () => {
  it('expands @me before filtering, and keeps our PR', async () => {
    const { read, calls } = fakeGh({
      graphql: () => { throw RATE_LIMITED(); },
      user: () => ({ login: AUTHOR }),
      rest: () => [restRow()],
    });
    const map = await listRecentMergedPrs(REPO, '@me', { read, now: NOW });

    expect(map.get(BRANCH)!.number).toBe(PR);
    // Once, before the paging — not once per page.
    expect(calls.filter((c) => c.road === 'whoami')).toHaveLength(1);
  });

  it('does not pay for the expansion when the author is already a login', async () => {
    const { read, calls } = fakeGh({ graphql: () => { throw RATE_LIMITED(); }, rest: () => [restRow()] });
    await listRecentMergedPrs(REPO, AUTHOR, { read, now: NOW });
    expect(calls.filter((c) => c.road === 'whoami')).toEqual([]);
  });

  /**
   * And when it cannot be expanded, the read FAILS rather than filtering on a
   * value that cannot match. An empty map here would be the 2026-09-05 board
   * with a banner claiming everything was read; a throw is both roads down,
   * which is what has actually happened.
   */
  it('fails the whole fallback rather than filter on a value that cannot match', async () => {
    const { read } = fakeGh({ graphql: () => { throw RATE_LIMITED(); }, rest: () => [restRow()] });
    await expect(listRecentMergedPrs(REPO, '@me', { read, now: NOW })).rejects.toThrow(
      /REST fallback failed too: gh: HTTP 401/,
    );
  });

  it('fails when the expansion answers with no login at all', async () => {
    const { read } = fakeGh({
      graphql: () => { throw RATE_LIMITED(); },
      user: () => ({}),
      rest: () => [restRow()],
    });
    await expect(listRecentMergedPrs(REPO, '@me', { read, now: NOW })).rejects.toThrow(/could not expand @me/);
  });
});

describe('how far the REST road walks', () => {
  const fullPage = (page: number, ageDays: number) =>
    Array.from({ length: 100 }, (_, i) =>
      restRow({
        number: page * 1000 + i,
        head: { ref: `fix/issue-${page}-${i}` },
        merged_at: daysBefore(ageDays),
        updated_at: daysBefore(ageDays),
      }),
    );

  it('stops at the window edge rather than walking the whole repo', async () => {
    // Page 1 is inside the 14-day window and full, so it asks for page 2. Page 2
    // is outside it, so there is nothing after it that can be inside.
    const { read, calls } = fakeGh({
      graphql: () => { throw RATE_LIMITED(); },
      rest: (page) => (page === 1 ? fullPage(1, 2) : fullPage(2, 40)),
    });
    const map = await listRecentMergedPrs(REPO, AUTHOR, { read, now: NOW });

    expect(calls.filter((c) => c.road === 'rest')).toHaveLength(2);
    expect(map.size).toBe(100);
  });

  it('stops on a short page too — the repo ended before the window did', async () => {
    const { read, calls } = fakeGh({ graphql: () => { throw RATE_LIMITED(); }, rest: () => [restRow()] });
    await listRecentMergedPrs(REPO, AUTHOR, { read, now: NOW });
    expect(calls.filter((c) => c.road === 'rest')).toHaveLength(1);
  });

  it('caps its paging, and SAYS the read is short rather than looking whole', async () => {
    // Every page full and every row inside the window: the cap is the only thing
    // that ends this, and a map that stops early must not pass for a complete one.
    const { read, calls } = fakeGh({ graphql: () => { throw RATE_LIMITED(); }, rest: (page) => fullPage(page, 1) });
    const notes: MergedPrsFallback[] = [];
    await listRecentMergedPrs(REPO, AUTHOR, { read, now: NOW, onFallback: (n) => notes.push(n) });

    expect(calls.filter((c) => c.road === 'rest')).toHaveLength(10);
    expect(notes[0]!.capped).toBe(true);
  });

  /**
   * THE CAP IS SPENT ON THE REPO, NOT ON US, which is the thing that makes it
   * bite. The endpoint is repo-wide and has no author filter, so other people's
   * closed PRs, closed-and-never-merged PRs and old PRs dragged back up the
   * `sort=updated` list all cost pages. Every page here is a stranger's, and
   * ours is past the cap.
   *
   * The map comes back EMPTY and the read still resolves — which is exactly why
   * `capped` has to reach the rows. See the console block below.
   */
  it('can run out of pages on somebody else’s traffic, and says so', async () => {
    const theirs = (page: number) =>
      Array.from({ length: 100 }, (_, i) =>
        restRow({
          number: page * 1000 + i,
          head: { ref: `feat/theirs-${page}-${i}` },
          user: { login: 'pr-swarm' },
          merged_at: daysBefore(1),
          updated_at: daysBefore(1),
        }),
      );
    const { read } = fakeGh({ graphql: () => { throw RATE_LIMITED(); }, rest: theirs });
    const notes: MergedPrsFallback[] = [];
    const map = await listRecentMergedPrs(REPO, AUTHOR, { read, now: NOW, onFallback: (n) => notes.push(n) });

    expect(map.size).toBe(0);
    expect(notes[0]).toEqual({ because: expect.stringContaining('rate limit'), found: 0, capped: true });
  });
});

describe('what the operator is told', () => {
  it('says which road answered, why, and how much it found', async () => {
    const { read } = fakeGh({ graphql: () => { throw RATE_LIMITED(); }, rest: () => [restRow()] });
    const notes: MergedPrsFallback[] = [];
    await listRecentMergedPrs(REPO, AUTHOR, { read, now: NOW, onFallback: (n) => notes.push(n) });

    expect(notes).toHaveLength(1);
    expect(notes[0]!.because).toContain('API rate limit already exceeded');
    expect(notes[0]!.found).toBe(1);
    expect(notes[0]!.capped).toBe(false);
  });

  it('says NOTHING when the usual read worked — a quiet poll stays quiet', async () => {
    const { read } = fakeGh({ graphql: () => [graphqlRow()] });
    const notes: MergedPrsFallback[] = [];
    await listRecentMergedPrs(REPO, AUTHOR, { read, now: NOW, onFallback: (n) => notes.push(n) });
    expect(notes).toEqual([]);
  });

  it('words the whole-window case as a fact, not a warning', () => {
    const line = fallbackBanner({ because: 'API rate limit already exceeded', found: 21, capped: false })!;
    expect(line.text).toContain('REST API');
    expect(line.text).toContain('API rate limit already exceeded');
    expect(line.text).toContain('21 merged PRs');
    expect(line.text).toContain('the whole window');
    // Quiet. Nothing failed and the board below is right — a warning over a
    // correct board teaches you to ignore warnings.
    expect(line.warn).toBe(false);
  });

  /**
   * And the short read is a WARNING, because it is the one version of this line
   * there is something to do about: rows below it have gone to "cannot say".
   * Styling it like the "GitHub read HH:MM" stamp is how the poll worth acting
   * on gets skimmed past.
   */
  it('admits the short read when the cap bit, and raises its voice', () => {
    const line = fallbackBanner({ because: 'API rate limit already exceeded', found: 500, capped: true })!;
    expect(line.text).toContain('page limit');
    expect(line.text).toContain('may be missing');
    // It explains the rows, which otherwise have no explanation on the page.
    expect(line.text).toContain('rather than guess');
    expect(line.warn).toBe(true);
  });

  it('is silent on an ordinary poll', () => {
    expect(fallbackBanner(null)).toBeNull();
  });
});

/**
 * THE CONSOLE ITSELF. A fallback that succeeds must not leave the operator
 * reading a failed read, and a degraded read must not pass for the full one.
 */
describe('a poll the REST road answered', () => {
  let repo: string;
  let home: string;
  let stateFile: string;

  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' });

  const mergedPr = (): PullRequest => ({
    number: PR,
    url: `https://github.com/example-org/example-repo/pull/${PR}`,
    state: 'MERGED',
    title: 'fix(pills): org sysadmin filter',
    isDraft: false,
    mergedAt: MERGED_AT,
  });

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-rest-home-')));
    mkdirSync(join(home, '.claude'), { recursive: true });
    stateFile = join(home, 'state.json');

    repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-rest-')));
    git(['init', '-b', 'dev'], repo);
    git(['config', 'user.email', 'x@y.z'], repo);
    git(['config', 'user.name', 'x'], repo);
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
    const worktree = join(repo, '.worktrees', `issue-${ISSUE}-demo`);
    git(['worktree', 'add', '-b', BRANCH, worktree, 'dev'], repo);
    writeFileSync(join(worktree, '.issue-state.md'), `# Issue ${ISSUE}\n\n**Stage reached**: 8\n`);

    vi.spyOn(gh, 'listIssues').mockResolvedValue([
      { number: ISSUE, title: 'Org sysadmin filter pills', url: 'u', labels: [], updatedAt: 'z', author: AUTHOR, spunOffFrom: null },
    ]);
    vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
    vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
    vi.spyOn(gh, 'listPrReviews').mockResolvedValue({ reviews: [], latestReviews: [], labels: [], commits: [] });
    vi.spyOn(resources, 'probeResources').mockResolvedValue({
      ok: true,
      reason: 'memory ok',
      freePct: 90,
      headroomBytes: 8 * 1024 ** 3,
      headroomLabel: '8 GB',
      minFreePct: 25,
      footprintBytes: 0,
      footprintLabel: '0 GB',
      ceilingBytes: 11 * 1024 ** 3,
      ceilingLabel: '11 GB',
      totalBytes: 16 * 1024 ** 3,
      edgeRuntimeLabel: null,
      checkedAt: new Date().toISOString(),
    } as ResourceReport);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const orch = () =>
    new Orchestrator(
      loadConfig({
        REPO,
        REPO_PATH: repo,
        STATE_FILE: stateFile,
        RUNS_FILE: join(home, 'runs.jsonl'),
        STREAM_DIR: join(home, 'runs'),
        CANONICAL_CLAUDE_DIR: join(home, '.claude'),
        ACCOUNTS_FILE: join(home, 'accounts.json'),
        POLL_MS: '999999',
        RESOURCES_MS: '999999',
      }),
    );

  /** GraphQL refused; REST answered WHOLE. The console gets its map and its note. */
  const answeredByRest = () =>
    vi.spyOn(gh, 'listRecentMergedPrs').mockImplementation(async (_repo, _author, opts = {}) => {
      opts.onFallback?.({ because: 'API rate limit already exceeded', found: 1, capped: false });
      return new Map([[BRANCH, mergedPr()]]);
    });

  /**
   * GraphQL refused; REST answered SHORT, and this branch's PR is in the tail it
   * never reached — the map comes back without it, exactly as it does when 500
   * rows of somebody else's traffic eat the page budget.
   */
  const answeredShortByRest = () =>
    vi.spyOn(gh, 'listRecentMergedPrs').mockImplementation(async (_repo, _author, opts = {}) => {
      opts.onFallback?.({ because: 'API rate limit already exceeded', found: 0, capped: true });
      return new Map<string, PullRequest>();
    });

  it('reads the row correctly — this is the 2026-09-05 board, un-broken', async () => {
    answeredByRest();
    const o = orch();
    await o.start();

    const r = o.state().issues.find((row) => row.number === ISSUE)!;
    expect(r.status).toBe('pr-merged');
    expect(r.statusDetail).toContain(`PR #${PR} merged`);
    await o.stop();
  });

  it('does not claim a read failed, because none did', async () => {
    answeredByRest();
    const o = orch();
    await o.start();

    const s = o.state();
    expect(s.pollError).toBeNull();
    // The stamp is the age of the DATA, and this data is this minute's.
    expect(s.lastPolledAt).not.toBeNull();
    await o.stop();
  });

  it('says out loud that it came the other way, with the count and the reason', async () => {
    answeredByRest();
    const o = orch();
    await o.start();

    const note = o.state().pollNote!;
    expect(note).toContain("REST API");
    expect(note).toContain('API rate limit already exceeded');
    expect(note).toContain('1 merged PR,');
    // Quiet: the map is whole and the row above reads `pr-merged`.
    expect(o.state().pollNoteWarn).toBe(false);
    await o.stop();
  });

  it('clears the note the moment the usual road comes back', async () => {
    answeredByRest();
    const o = orch();
    await o.start();
    expect(o.state().pollNote).not.toBeNull();

    vi.mocked(gh.listRecentMergedPrs).mockResolvedValue(new Map([[BRANCH, mergedPr()]]));
    await o.poll();
    expect(o.state().pollNote).toBeNull();
    expect(o.state().pollError).toBeNull();
    await o.stop();
  });

  /**
   * THE 2026-09-05 BOARD, REACHED THROUGH A SUCCESS.
   *
   * A capped REST read resolves. Nothing joins `failed`, `pollError` stays null,
   * the stamp moves. If `capped` stopped at the banner, this row would fall
   * through to `checkpoint` and read "stopped after stage 8" — verbatim the
   * sentence this branch exists to delete — under a quiet grey line saying the
   * read may have missed something. A short read is a read we could not
   * complete, and the row says so.
   */
  it('sends the row to "cannot say" when the REST read came back short', async () => {
    answeredShortByRest();
    const o = orch();
    await o.start();

    const r = o.state().issues.find((row) => row.number === ISSUE)!;
    expect(r.status).toBe('unreadable');
    expect(r.statusDetail).toContain('not read in full');
    expect(r.status).not.toBe('checkpoint');
    expect(r.statusDetail).not.toContain('stopped after stage 8');
    await o.stop();
  });

  it('says the short read out loud, in the register you act on', async () => {
    answeredShortByRest();
    const o = orch();
    await o.start();

    const s = o.state();
    expect(s.pollNoteWarn).toBe(true);
    expect(s.pollNote).toContain('may be missing');
    // Still not a failure: nothing was refused that was not answered another
    // way, and calling it one would send the operator hunting a read that ran.
    expect(s.pollError).toBeNull();
    await o.stop();
  });

  it('recovers the row and the register the moment a whole read lands', async () => {
    answeredShortByRest();
    const o = orch();
    await o.start();
    expect(o.state().issues.find((row) => row.number === ISSUE)!.status).toBe('unreadable');

    vi.mocked(gh.listRecentMergedPrs).mockResolvedValue(new Map([[BRANCH, mergedPr()]]));
    await o.poll();

    const s = o.state();
    expect(s.issues.find((row) => row.number === ISSUE)!.status).toBe('pr-merged');
    expect(s.pollNote).toBeNull();
    expect(s.pollNoteWarn).toBe(false);
    await o.stop();
  });

  it('still reports a failure — and both reasons — when neither road answered', async () => {
    vi.spyOn(gh, 'listRecentMergedPrs').mockRejectedValue(
      new Error('API rate limit already exceeded — and the REST fallback failed too: gh: HTTP 502'),
    );
    const o = orch();
    await o.start();

    const s = o.state();
    expect(s.pollError).toContain('gh pr list (merged) failed');
    expect(s.pollError).toContain('REST fallback failed too');
    // And nothing quiet beside it: there is no degraded read to report.
    expect(s.pollNote).toBeNull();
    // The row admits it cannot see, exactly as `unreadable.test.ts` pins.
    expect(o.state().issues.find((row) => row.number === ISSUE)!.status).toBe('unreadable');
    await o.stop();
  });
});
