import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeLine, closedDetail, recordCloses, verdictAtClose } from '../src/close-verdict.js';
import { deriveActions, metaFor, uatFailFor, type DeriveContext } from '../src/actions.js';
import { planNotifications, DEFAULT_PREFS } from '../src/notify.js';
import { deriveStatus } from '../src/status.js';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import { memoryOk } from './fixtures/memory.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ActionsPayload, GhIssueFacts } from '../src/gh.js';

/**
 * WHAT QA HAD SAID WHEN THE TICKET WAS CLOSED.
 *
 * Measured over 105 closures: 28 carried no QA verification at all, four were
 * closed while a human's `Fail` or `Partial Pass` still stood (#4619, #5019,
 * #5139, #4344), and a bot promotion closing a ticket rendered exactly like a
 * tester closing one they had verified. Every closed row said the same thing —
 * "closed — PR #N merged and QA signed it off" — because it was closed, not
 * because anybody had signed anything off.
 *
 * So the verdict is read at the close, written down once, and said out loud.
 */

const ME = 'operator';
const NOW = new Date('2026-09-04T12:00:00Z');

/* --------------------------------------------------------------- the record */

describe('the record written at the close', () => {
  it('maps each human verdict, and keeps who gave it', () => {
    const at = (v: 'Pass' | 'Fail' | 'Partial Pass') =>
      verdictAtClose({ issue: 4619, closedAt: '2026-09-03T18:03:37Z', verdict: { verdict: v, by: 'qa-bob' } }, NOW);
    expect(at('Pass').verdict).toBe('pass');
    expect(at('Fail').verdict).toBe('fail');
    expect(at('Partial Pass').verdict).toBe('partial');
    expect(at('Fail').by).toBe('qa-bob');
    expect(at('Fail').closedAt).toBe('2026-09-03T18:03:37Z');
    // Not the close time. The gap between them is the whole reason it is stamped.
    expect(at('Fail').at).toBe(NOW.toISOString());
  });

  it('records `none` with nobody attached — a bot promotion close is this shape', () => {
    const v = verdictAtClose({ issue: 5697, closedAt: '2026-09-03T18:03:37Z', verdict: null }, NOW);
    expect(v.verdict).toBe('none');
    // Never an empty string standing in for a person nobody can name.
    expect(v.by).toBeNull();
  });

  it('is written ONCE — a Pass posted after the close does not rewrite it', () => {
    const first = recordCloses({}, [{ issue: 4619, closedAt: 'c', verdict: null }], NOW);
    expect(first.added).toEqual([4619]);
    expect(first.verdicts['4619']!.verdict).toBe('none');

    const later = new Date('2026-09-10T12:00:00Z');
    const second = recordCloses(
      first.verdicts,
      [{ issue: 4619, closedAt: 'c', verdict: { verdict: 'Pass', by: 'qa-bob' } }],
      later,
    );
    // The whole value is the tense: a verdict given a week later did not exist
    // when the ticket was closed, and must not make the close look verified.
    expect(second.verdicts['4619']!.verdict).toBe('none');
    expect(second.verdicts['4619']!.at).toBe(NOW.toISOString());
    // And nothing is reported as new, so nothing is logged or saved for it.
    expect(second.added).toEqual([]);
  });

  it('adds only the closes it has not seen', () => {
    const held = recordCloses({}, [{ issue: 1, closedAt: null, verdict: null }], NOW).verdicts;
    const next = recordCloses(
      held,
      [
        { issue: 1, closedAt: null, verdict: null },
        { issue: 2, closedAt: null, verdict: { verdict: 'Fail', by: 'qa-alice' } },
      ],
      NOW,
    );
    expect(next.added).toEqual([2]);
    expect(Object.keys(next.verdicts).sort()).toEqual(['1', '2']);
  });
});

/* ------------------------------------------------------- what the row says */

describe('the sentence a closed row gives', () => {
  const rec = (verdict: 'pass' | 'fail' | 'partial' | 'none', by: string | null = 'qa-bob') => ({
    closedAt: '2026-09-03T18:03:37Z',
    verdict,
    by,
    at: NOW.toISOString(),
  });

  it('says nobody verified it, in those words', () => {
    expect(closedDetail(rec('none', null), null)).toBe('closed with no QA verdict recorded');
    expect(closedDetail(rec('none', null), 4976)).toBe('closed — PR #4976 merged, with no QA verdict recorded');
  });

  it('names the person who passed it, instead of asserting "QA signed it off"', () => {
    expect(closedDetail(rec('pass'), 4976)).toBe('closed — PR #4976 merged and qa-bob passed it in QA');
    expect(closedDetail(rec('pass'), null)).toBe('closed — qa-bob passed it in QA');
  });

  it('says a standing verdict was never answered', () => {
    expect(closedDetail(rec('fail'), 4976)).toBe("closed while qa-bob's Fail still stood — nothing has re-verified it");
    expect(closedDetail(rec('partial'), 4976)).toContain("qa-bob's Partial Pass still stood");
  });

  it('keeps the old sentence when the console never established one', () => {
    // Absence is "never looked", not "nobody verified it" — the same rule
    // `OrphanIssue.unread` keeps. A row the console cannot speak about must not
    // be given the loudest possible reading of its silence.
    expect(closedDetail(null, 4976)).toBe('closed — PR #4976 merged and QA signed it off');
    expect(closedDetail(null, null)).toBe('closed on GitHub');
  });

  it('writes the card line for each, and only calls a pass quiet', () => {
    expect(closeLine(rec('none', null))).toContain('No QA verdict was recorded');
    expect(closeLine(rec('pass'))).toBe('qa-bob passed it in QA before it was closed.');
    expect(closeLine(rec('fail'))).toContain("Closed while qa-bob's Fail still stood");
  });

  it('reaches deriveStatus, so the status line and the card cannot disagree', () => {
    const base = {
      hasWorktree: true,
      isRunning: false,
      gate: null,
      detached: false,
      queuePosition: null,
      lastError: null,
      pr: null,
      stage: 9,
      issueClosed: true,
    };
    expect(deriveStatus({ ...base, closeVerdict: rec('none', null) }).statusDetail).toBe(
      'closed with no QA verdict recorded',
    );
    expect(deriveStatus({ ...base, closeVerdict: rec('pass') }).statusDetail).toContain('qa-bob passed it in QA');
    // Unchanged where nothing was recorded — every existing closed row.
    expect(deriveStatus(base).statusDetail).toBe('closed on GitHub');
    // And the live feed's own send-back still outranks the record: it names the
    // person off the actions the page is showing, in the same words as the chip.
    expect(
      deriveStatus({
        ...base,
        closeVerdict: rec('fail'),
        sentBack: { by: 'qa-alice', verdict: 'Fail', inflight: false },
      }).statusDetail,
    ).toBe('closed on GitHub, but qa-alice marked it Fail after the merge — not signed off');
  });
});

/* ----------------------------------------------- the tier-1 notice, derived */

const SHIPPED = {
  number: 4976,
  url: 'https://github.com/example-org/example-repo/pull/4976',
  state: 'MERGED',
  createdAt: '2026-08-20T12:00:00Z',
  // AFTER the verdict below: this is the fix, and it is what `fixProgress`
  // reads as 'shipped'.
  mergedAt: '2026-08-22T18:45:31Z',
  headRefName: 'fix/issue-4619-exclusions',
  lastCommitAt: '2026-08-22T18:40:00Z',
};

const ctx = (over: Partial<DeriveContext> = {}): DeriveContext => ({
  me: ME,
  now: new Date('2026-08-25T12:00:00Z'),
  seenAt: null,
  lookbackMs: 7 * 86_400_000,
  trackedIssues: new Set<number>(),
  atGate: new Set<number>(),
  reworkIssues: new Set<number>(),
  branchActivity: new Map<number, string>(),
  knownAssigned: new Set<number>([4619]),
  inFlight: new Set<number>(),
  ...over,
});

const failComment = () => ({
  id: '5373268785',
  author: { login: 'qa-bob', typename: 'User' },
  createdAt: '2026-08-21T09:00:00Z',
  body: '**Test Result:** Fail\n\nPublishing an exclusion shows it as Archived.',
  url: 'https://github.com/example-org/example-repo/issues/4619#issuecomment-5373268785',
});

const issue = (over: Partial<ActionsPayload['issues'][number]> = {}): ActionsPayload['issues'][number] => ({
  number: 4619,
  title: 'Exclusions publish as Archived',
  url: 'https://github.com/example-org/example-repo/issues/4619',
  updatedAt: '2026-08-23T09:00:00Z',
  labels: ['P1'],
  comments: [failComment()],
  lane: 'QA',
  laneAt: '2026-08-20T18:44:03Z',
  referencingPrs: [SHIPPED],
  mergedPrs: [SHIPPED],
  // The FIRST merge — when the work shipped — which is what makes the verdict
  // post-merge and therefore readable at all.
  mergedAt: '2026-08-20T18:45:31Z',
  closed: false,
  ...over,
});

const payload = (over: Partial<ActionsPayload> = {}): ActionsPayload => ({
  issues: [],
  prs: [],
  reviewRequested: [],
  mentions: [],
  merged: [],
  quota: null,
  truncated: null,
  ...over,
});

describe('a ticket closed over a send-back nothing answered', () => {
  it('is tier 1, and says the fix shipped without being re-tested', () => {
    const a = deriveActions(payload({ issues: [issue({ closed: true })] }), ctx());
    const over = a.find((x) => x.kind === 'closed-over-fail')!;
    expect(over).toBeDefined();
    expect(over.tier).toBe(1);
    expect(over.actor).toBe('qa-bob');
    expect(over.verdict).toBe('Fail');
    expect(over.reason).toContain("closed while qa-bob's Fail still stood");
    expect(over.reason).toContain('nothing re-tested it');
    // GitHub's own comment id, so notify-once survives a restart.
    expect(over.id).toBe('closed-over-fail:issue#4619:5373268785');
  });

  it('is the one row for the verdict, never two', () => {
    const kinds = deriveActions(payload({ issues: [issue({ closed: true })] }), ctx()).map((x) => x.kind);
    expect(kinds).toContain('closed-over-fail');
    expect(kinds).not.toContain('uat-fail');
    expect(kinds).not.toContain('uat-fail-inflight');
  });

  it('says nothing while the issue is still OPEN — a shipped fix is QA`s ball', () => {
    const kinds = deriveActions(payload({ issues: [issue({ closed: false })] }), ctx()).map((x) => x.kind);
    expect(kinds).not.toContain('closed-over-fail');
    // Unchanged: 'shipped' has always meant the row goes quiet while it is open.
    expect(kinds).not.toContain('uat-fail');
  });

  it('leaves #4914 alone — a close with NO fix shipped is still the pushing kind', () => {
    // The tester posted `Test Result: Fail` and closed the issue in the same
    // second. Nothing merged after the verdict, so it is a live send-back and it
    // must keep the one kind that reaches the operator's phone.
    const same = issue({ closed: true, referencingPrs: [], mergedPrs: [] });
    const kinds = deriveActions(payload({ issues: [same] }), ctx()).map((x) => x.kind);
    expect(kinds).toContain('uat-fail');
    expect(kinds).not.toContain('closed-over-fail');
  });

  it('is not raised over a Pass', () => {
    const passed = issue({
      closed: true,
      comments: [{ ...failComment(), body: '**Test Result:** Pass' }],
    });
    expect(deriveActions(payload({ issues: [passed] }), ctx()).map((x) => x.kind)).not.toContain('closed-over-fail');
  });

  it('puts the verdict back on the row it was closed off', () => {
    const a = deriveActions(payload({ issues: [issue({ closed: true })] }), ctx());
    const stamp = uatFailFor(a, 4619)!;
    expect(stamp).not.toBeNull();
    expect(stamp.by).toBe('qa-bob');
    expect(stamp.verdict).toBe('Fail');
    // A close is an ending, never a fix somebody is visibly working on.
    expect(stamp.inflight).toBe(false);
  });

  it('never buzzes the phone on its own — only `uat-fail` does that', () => {
    expect(metaFor('closed-over-fail').tier).toBe(1);
    expect(metaFor('closed-over-fail').push).toBe(false);
    expect(metaFor('uat-fail').push).toBe(true);

    const a = deriveActions(payload({ issues: [issue({ closed: true })] }), ctx());
    const plan = planNotifications(a, {}, { ...DEFAULT_PREFS, phone: true }, NOW);
    // In-app it is loud — it is tier 1, and it toasts.
    expect(plan.toasts.map((t) => t.kind)).toContain('closed-over-fail');
    // On the phone it is not a push of its own, and one alone is below the
    // bundle floor, so nothing goes out at all.
    expect(plan.pushes).toEqual([]);
  });
});

/* -------------------------------------------------- the record, in the poll */

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const ISSUE = 5697;
const CLOSED_AT = '2026-09-03T18:03:37Z';

let repo: string;
let home: string;
let stateFile: string;

const facts = (over: Partial<GhIssueFacts> = {}): GhIssueFacts => ({
  number: ISSUE,
  title: 'Critical: p75(measurements.lcp) in the last hour above 4000.0',
  url: `https://github.com/example-org/example-repo/issues/${ISSUE}`,
  labels: ['P2', 'needs-triage'],
  updatedAt: CLOSED_AT,
  author: 'app/sentry',
  state: 'CLOSED',
  closedAt: CLOSED_AT,
  assignees: ['operator'],
  ...over,
});

/** The closed issue as `closedQ` returns it: comments and all. */
const closedIssue = (comments: ActionsPayload['issues'][number]['comments'] = []) => ({
  number: ISSUE,
  title: 'Critical: p75(measurements.lcp) in the last hour above 4000.0',
  url: `https://github.com/example-org/example-repo/issues/${ISSUE}`,
  updatedAt: CLOSED_AT,
  labels: ['P2', 'needs-triage'],
  comments,
  lane: 'QA',
  laneAt: '2026-09-02T18:44:03Z',
  referencingPrs: [],
  mergedPrs: [],
  mergedAt: '2026-09-02T10:00:00Z',
  closed: true,
});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-home-')));
  mkdirSync(join(home, '.claude'), { recursive: true });
  stateFile = join(home, 'state.json');

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-close-')));
  execFileSync('git', ['init', '-b', 'dev'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'x@y.z'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'x'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  const worktree = join(repo, '.worktrees', `issue-${ISSUE}-lcp`);
  execFileSync('git', ['worktree', 'add', '-b', `fix/issue-${ISSUE}-lcp`, worktree, 'dev'], {
    cwd: repo,
    stdio: 'ignore',
  });
  writeFileSync(join(worktree, '.issue-state.md'), `# Issue ${ISSUE}\n\nStage: 9\nPort: 8141\n`);

  // A worktree on disk and nothing in the open issue list — the orphan shape.
  vi.spyOn(gh, 'listIssues').mockResolvedValue([]);
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(gh, 'listPrReviews').mockResolvedValue({ reviews: [], latestReviews: [], labels: [], commits: [] });
  vi.spyOn(gh, 'describeIssues').mockResolvedValue(new Map([[ISSUE, facts()]]));
  vi.spyOn(gh, 'readGraphqlQuota').mockResolvedValue({ limit: 5000, remaining: 4000, resetAt: CLOSED_AT });
  vi.spyOn(resources, 'probeResources').mockResolvedValue(memoryOk());
});

afterEach(() => {
  killSpawnedWorkers(stateFile);
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function orch() {
  return new Orchestrator(
    loadConfig({
      REPO: 'example-org/example-repo',
      REPO_PATH: repo,
      STATE_FILE: stateFile,
      RUNS_FILE: join(home, 'runs.jsonl'),
      STREAM_DIR: join(home, 'runs'),
      CANONICAL_CLAUDE_DIR: join(home, '.claude'),
      CLAUDE_BIN: STUB,
      POLL_MS: '999999',
      RESOURCES_MS: '999999',
    }),
  );
}

const row = (o: Orchestrator) => o.state().issues.find((r) => r.number === ISSUE)!;

describe('the console writing the verdict down at the close', () => {
  it('records `none` and says so on the row', async () => {
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(payload({ issues: [closedIssue()] }));
    const o = orch();
    await o.poll();

    const r = row(o);
    expect(r.status).toBe('done');
    expect(r.statusDetail).toBe('closed with no QA verdict recorded');
    expect(r.closeVerdict?.verdict).toBe('none');
    expect(r.closeVerdict?.closedAt).toBe(CLOSED_AT);
    expect(r.closeVerdict?.by).toBeNull();
    // The card's own sentence, written by the server.
    expect(r.closeVerdict?.line).toContain('No QA verdict was recorded');
    await o.stop();
  });

  it('records the pass, and names the tester instead of asserting a sign-off', async () => {
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(
      payload({
        issues: [
          closedIssue([
            {
              id: '9001',
              author: { login: 'qa-bob', typename: 'User' },
              createdAt: '2026-09-03T18:03:00Z',
              body: '**Test Result:** Pass',
              url: 'u',
            },
          ]),
        ],
      }),
    );
    const o = orch();
    await o.poll();

    expect(row(o).closeVerdict?.verdict).toBe('pass');
    expect(row(o).statusDetail).toBe('closed — qa-bob passed it in QA');
    await o.stop();
  });

  it('does not rewrite the record when a verdict lands after the close', async () => {
    const fetch = vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(payload({ issues: [closedIssue()] }));
    const o = orch();
    await o.poll();
    expect(row(o).closeVerdict?.verdict).toBe('none');

    // A Pass arrives the next day. It is true, and it is not what was true when
    // the ticket was closed.
    fetch.mockResolvedValue(
      payload({
        issues: [
          closedIssue([
            {
              id: '9002',
              author: { login: 'qa-bob', typename: 'User' },
              createdAt: '2026-09-04T09:00:00Z',
              body: '**Test Result:** Pass',
              url: 'u',
            },
          ]),
        ],
      }),
    );
    await o.poll();
    expect(row(o).closeVerdict?.verdict).toBe('none');
    expect(row(o).statusDetail).toBe('closed with no QA verdict recorded');
    await o.stop();
  });

  it('records NOTHING for a close it could not read a verdict for', async () => {
    // `closedQ` reaches back only so far and its page can be cut short, so a
    // closed issue is routinely absent from the payload. Absence is "never
    // established" — the row must not be told nobody verified it.
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(payload({ issues: [] }));
    const o = orch();
    await o.poll();

    const r = row(o);
    expect(r.closeVerdict ?? null).toBeNull();
    expect(r.statusDetail).toBe('closed on GitHub');
    await o.stop();
  });

  it('survives a restart — the record is on disk, not in the process', async () => {
    vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue(payload({ issues: [closedIssue()] }));
    const first = orch();
    await first.poll();
    await first.stop();

    const second = orch();
    await second.start();
    expect(row(second).closeVerdict?.verdict).toBe('none');
    expect(row(second).statusDetail).toBe('closed with no QA verdict recorded');
    await second.stop();
  });
});
