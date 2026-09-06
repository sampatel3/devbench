import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import { memoryOk } from './fixtures/memory.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { GhIssueFacts } from '../src/gh.js';
import type { ResourceReport } from '../src/types.js';

/**
 * THE SENTENCE THAT SAID THREE THINGS AT ONCE.
 *
 * A worktree outlives its issue leaving the console's list, and the list is
 * narrow — open, assigned to or raised by them, fifty long — so it leaves for
 * three unrelated reasons. Every one of them produced the same row: "#5697 —
 * worktree with no matching open issue", which identifies nothing, names no
 * cause, and reads as a fault in the console.
 *
 * On 2026-09-04 it was read as exactly that. #5697 had closed the day before,
 * QA had signed it off, and a worker had been restarted fresh on it and reached
 * stage 2 — work nobody was waiting for, behind a row that could not say so.
 */

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');
const ISSUE = 5697;
const BRANCH = `fix/issue-${ISSUE}-critical-p75`;
const TITLE = 'Critical: p75(measurements.lcp) in the last hour above 4000.0';
const CLOSED_AT = '2026-09-03T18:03:37Z';

let repo: string;
let home: string;
let canonical: string;
let stateFile: string;

const facts = (over: Partial<GhIssueFacts> = {}): GhIssueFacts => ({
  number: ISSUE,
  title: TITLE,
  url: `https://github.com/example-org/example-repo/issues/${ISSUE}`,
  labels: ['P2', 'needs-triage'],
  updatedAt: CLOSED_AT,
  author: 'app/sentry',
  state: 'CLOSED',
  closedAt: CLOSED_AT,
  assignees: ['operator'],
  ...over,
});

const describes = (f: GhIssueFacts | null) =>
  vi.spyOn(gh, 'describeIssues').mockResolvedValue(f ? new Map([[f.number, f]]) : new Map());

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-home-')));
  canonical = join(home, '.claude');
  mkdirSync(canonical, { recursive: true });
  stateFile = join(home, 'state.json');

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-orphan-')));
  execFileSync('git', ['init', '-b', 'dev'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'x@y.z'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'x'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  const worktree = join(repo, '.worktrees', `issue-${ISSUE}-critical-p75`);
  execFileSync('git', ['worktree', 'add', '-b', BRANCH, worktree, 'dev'], { cwd: repo, stdio: 'ignore' });
  writeFileSync(join(worktree, '.issue-state.md'), `# Issue ${ISSUE}\n\nStage: 2\nPort: 8141\n`);

  // The whole premise: a worktree on disk, and NOTHING in the open issue list.
  vi.spyOn(gh, 'listIssues').mockResolvedValue([]);
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
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
  killSpawnedWorkers(stateFile);
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function orch(deps: { log?: (line: string) => void } = {}) {
  return new Orchestrator(
    loadConfig({
      REPO: 'example-org/example-repo',
      REPO_PATH: repo,
      // Named rather than defaulted: there is no ASSIGNEE default any more, and
      // "is this issue still theirs?" is exactly what these cases turn on.
      ASSIGNEE: 'operator',
      STATE_FILE: stateFile,
      RUNS_FILE: join(home, 'runs.jsonl'),
      STREAM_DIR: join(home, 'runs'),
      STREAM_POLL_MS: '25',
      CANONICAL_CLAUDE_DIR: canonical,
      CLAUDE_BIN: STUB,
      POLL_MS: '999999',
    }),
    deps,
  );
}

const row = (o: Orchestrator) => o.state().issues.find((r) => r.number === ISSUE)!;

describe('a worktree whose issue is not in the open list says WHICH case it is', () => {
  it('names a CLOSED issue, and carries the title the work is actually about', async () => {
    describes(facts());
    const o = orch();
    await o.start();

    const r = row(o);
    // The title identifies the work. "worktree with no matching open issue" is
    // not a title; the operator could not tell from the row what #5697 even was.
    expect(r.title).toBe(TITLE);
    expect(r.labels).toEqual(['P2', 'needs-triage']);
    expect(r.orphan).toEqual({ reason: 'closed', closedAt: CLOSED_AT, assignees: [] });
    // Unchanged, and the reason this branch exists: a closed issue is done.
    expect(r.status).toBe('done');
    expect(r.waiting).toBeNull();
    await o.stop();
  });

  it('does NOT call a REASSIGNED issue closed — it is open, it is just not theirs', async () => {
    describes(facts({ state: 'OPEN', closedAt: null, author: 'teammate-three', assignees: ['teammate-two'] }));
    const o = orch();
    await o.start();

    const r = row(o);
    expect(r.orphan).toEqual({ reason: 'not-yours', closedAt: null, assignees: ['teammate-two'] });
    // The old code reached `done` on absence alone and said "closed on GitHub"
    // over an issue GitHub still has open.
    expect(r.status).not.toBe('done');
    expect(r.statusDetail).not.toContain('closed on GitHub');
    // Still nothing to ask them for: work that left them is not work to hand back.
    expect(r.waiting).toBeNull();
    await o.stop();
  });

  it('says an issue that fell off the fifty-issue page is still open, and still theirs', async () => {
    describes(facts({ state: 'OPEN', closedAt: null, author: 'operator', assignees: ['operator'] }));
    const o = orch();
    await o.start();

    const r = row(o);
    expect(r.orphan).toEqual({ reason: 'still-open', closedAt: null, assignees: ['operator'] });
    expect(r.status).not.toBe('done');
    await o.stop();
  });

  it('keeps the placeholder for an issue GitHub could not be read for, and admits it', async () => {
    describes(null);
    const o = orch();
    await o.start();

    const r = row(o);
    expect(r.title).toContain('worktree with no matching open issue');
    expect(r.orphan).toEqual({ reason: 'unread', closedAt: null, assignees: [] });
    // The old assumption is kept — absence has overwhelmingly meant a close —
    // and it is the CARD that says the reason was never established.
    expect(r.status).toBe('done');
    await o.stop();
  });

  it('drops a stale answer when the issue stops being orphaned', async () => {
    describes(facts());
    const o = orch();
    await o.start();
    expect(row(o).orphan?.reason).toBe('closed');

    // Reopened, and back in the list. The row is an ordinary one again.
    vi.mocked(gh.listIssues).mockResolvedValue([
      { number: ISSUE, title: TITLE, url: 'u', labels: [], updatedAt: 'z', author: 'app/sentry', spunOffFrom: null },
    ]);
    await o.poll();

    const r = row(o);
    expect(r.orphan ?? null).toBeNull();
    expect(r.status).not.toBe('done');
    await o.stop();
  });
});

describe('the reason a blocked row gives', () => {
  it('is the labeller`s, reaching the row through the poll', async () => {
    // Open and theirs, so this is an ordinary row wearing the label — the shape
    // #5674 is in. The worktree's own history says nothing, so the only reason
    // available is the one the poll reads.
    describes(facts({ state: 'OPEN', closedAt: null, labels: ['P1', 'blocked'], assignees: ['operator'] }));
    vi.spyOn(gh, 'readBlockedNote').mockResolvedValue({
      by: 'teammate-two',
      at: '2026-09-04T00:53:05Z',
      body: 'Already carries `assertServiceRole` on `dev`. Unblocks when the fix reaches `main`.',
    });
    const o = orch();
    await o.start();

    const r = row(o);
    expect(r.status).toBe('blocked');
    expect(r.statusDetail).toBe(
      'blocked, per @teammate-two — Already carries assertServiceRole on dev.',
    );
    await o.stop();
  });

  it('asks only about issues that carry the label', async () => {
    describes(facts({ state: 'OPEN', closedAt: null, labels: ['P1'], assignees: ['operator'] }));
    const spy = vi.spyOn(gh, 'readBlockedNote').mockResolvedValue(null);
    const o = orch();
    await o.start();

    expect(spy).not.toHaveBeenCalled();
    await o.stop();
  });
});

/**
 * #5554 — TWELVE INSTANT EXITS, ABOUT £30, ON A TICKET THAT WAS ALREADY CLOSED.
 *
 * The line was drawn in the wrong place. `restartFresh` refused a closed issue;
 * a queued dispatch does not go through it. So the queue went on serving #5554
 * from its head, a worker started, found nothing to do and exited, the console
 * queued it again, and it looped — twelve times.
 *
 * The guard is at HEAD (0bca1b6). These are the variants of "already closed" it
 * has to hold for, and the one thing it must not do instead: fail silently.
 */
describe('nothing starts a closed issue off the queue', () => {
  /** Every way the console can be looking at a closed ticket. */
  const seed = async (deps: { log?: (line: string) => void } = {}) => {
    describes(facts());
    const o = orch(deps);
    await o.start();
    return o;
  };

  it('refuses a row whose STATUS is `done`', async () => {
    const o = await seed();
    // The status is the thing a person reads, and `done` is the end of the line.
    expect(row(o).status).toBe('done');

    o.enqueue(ISSUE, o.state().defaultAccount);
    await wait(200);

    expect(o.state().queue).not.toContain(ISSUE);
    expect(row(o).live ?? null).toBeNull();
    await o.stop();
  });

  it('refuses a row whose ORPHAN REASON is `closed`', async () => {
    const o = await seed();
    // The fact underneath the status: GitHub says CLOSED, with the stamp.
    expect(row(o).orphan).toEqual({ reason: 'closed', closedAt: CLOSED_AT, assignees: [] });

    o.enqueue(ISSUE, o.state().defaultAccount);
    await wait(200);

    expect(o.state().queue).not.toContain(ISSUE);
    expect(row(o).live ?? null).toBeNull();
    await o.stop();
  });

  it('refuses one that closes WHILE it is queued', async () => {
    // The dangerous one, and the one the incident actually was: it was open and
    // theirs when it went into the line, and by the time a slot freed it had been
    // signed off. Nothing re-asks the question between the queueing and the
    // start except this guard.
    describes(facts({ state: 'OPEN', closedAt: null, author: 'operator', assignees: ['operator'] }));
    // The desk is full, so the ticket waits — the ordinary reason a dispatch is
    // minutes or hours after the queueing. Under vitest the watcher's probes are
    // inert, so this poll reading is the whole verdict and nothing overrides it.
    const probe = vi.spyOn(resources, 'probeResources');
    probe.mockResolvedValue(memoryOk({ ok: false, reason: 'memory is tight' }));

    const o = orch();
    await o.start();
    o.enqueue(ISSUE, o.state().defaultAccount);
    await wait(100);
    // Held on the machine, not started, and still open at this point.
    expect(o.state().queue).toContain(ISSUE);
    expect(row(o).orphan?.reason).toBe('still-open');

    // QA closes it. The desk frees at the same moment — which is exactly the
    // shape that used to start it.
    describes(facts());
    probe.mockResolvedValue(memoryOk());
    await o.poll();

    expect(o.state().queue).not.toContain(ISSUE);
    expect(row(o).live ?? null).toBeNull();
    expect(row(o).status).toBe('done');
    await o.stop();
  });

  it('drops it with a reason, and does not mark the row failed', async () => {
    // NOT SILENTLY. A queued row that disappears with nothing saying why is the
    // shape of a bug, and the reason is the entire point of taking it out.
    const lines: string[] = [];
    const o = await seed({ log: (l) => lines.push(l) });

    o.enqueue(ISSUE, o.state().defaultAccount);
    await wait(200);

    expect(lines.join('\n')).toContain('the issue is closed on GitHub');
    expect(lines.join('\n')).toContain('Reopen it there to queue it again');
    // And in the console's own state, so the last decision it reports making is
    // not "starting #5697" over a start it declined.
    expect(o.state().dispatchReason).toContain(`#${ISSUE} is closed on GitHub`);
    expect(o.state().dispatchReason).toContain('taken out of the line');
    // A closed issue is not a failed run: a `failed` row would outrank the
    // `done` the close has earned, and there is nothing here to retry.
    expect(row(o).status).toBe('done');
    expect(row(o).lastError).toBeNull();
    await o.stop();
  });

  it('takes the held answer out with it, rather than leaving it to be replayed', async () => {
    // The incident's own shape: a decision taken while the desk was full, held
    // on disk, and put back in the line by the next restart. It was about work
    // that has since been signed off, so it goes when the queue entry goes —
    // exactly as a dequeue by hand drops it.
    writeFileSync(
      stateFile,
      JSON.stringify({ pendingResume: { [String(ISSUE)]: 'approved — ship it' }, sentBackResumes: {} }),
    );
    describes(facts());
    const lines: string[] = [];
    const o = orch({ log: (l) => lines.push(l) });
    // `start()` puts every held decision back in the line and then polls, so the
    // refusal happens inside it — which is precisely the incident: the console
    // was restarted, and #5697 was at the head of the queue the next evening.
    await o.start();

    expect(lines.join('\n')).toContain('the issue is closed on GitHub');
    expect(o.state().queue).not.toContain(ISSUE);
    expect(row(o).live ?? null).toBeNull();
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as { pendingResume: Record<string, string> };
    expect(saved.pendingResume[String(ISSUE)]).toBeUndefined();
    await o.stop();
  });

  it('dispatches an OPEN issue normally — the guard is about closed, not absent', async () => {
    describes(facts({ state: 'OPEN', closedAt: null, author: 'operator', assignees: ['operator'] }));
    const o = orch();
    await o.start();

    o.enqueue(ISSUE, o.state().defaultAccount);
    await waitFor('the worker to start', () => o.state().issues.find((r) => r.number === ISSUE)?.live != null);
    await o.stop();
  });
});

describe('restarting fresh on a closed issue', () => {
  it('refuses, and says to reopen it', async () => {
    describes(facts());
    const o = orch();
    await o.start();

    const out = await o.restartFresh(ISSUE, o.state().defaultAccount);
    expect(out.ok).toBe(false);
    expect(out.message).toContain('closed on GitHub');
    expect(out.message).toContain('Reopen it');
    // The refusal is about the ticket, never about the work: nothing on disk is
    // touched, so reopening on GitHub is all it takes to carry on.
    expect(out.message).toContain('untouched');
    await o.stop();
  });

  it('lets an OPEN issue through — absence from the list is not a close', async () => {
    describes(facts({ state: 'OPEN', closedAt: null, author: 'operator', assignees: ['operator'] }));
    const o = orch();
    await o.start();

    const out = await o.restartFresh(ISSUE, o.state().defaultAccount);
    expect(out.ok).toBe(true);
    await o.stop();
  });
});
