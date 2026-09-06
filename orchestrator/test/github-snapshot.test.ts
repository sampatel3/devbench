import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import { memoryOk } from './fixtures/memory.js';
import type { ActionsPayload, GhBlockedNote, GhIssue } from '../src/gh.js';
import type { PullRequest } from '../src/types.js';

/**
 * The GitHub snapshot: what a restart knows before GitHub has answered.
 *
 * On 2026-09-05 a console restart landed inside an hour of exhausted GraphQL
 * quota. Every read of the first poll failed and fell back — correctly — to the
 * previous in-memory value, but the process was seconds old, so the previous
 * value of everything was empty: `lastPolledAt` stayed null and every row
 * degraded to the bare checkpoint line for up to an hour, though nothing was
 * actually wrong. These tests pin the fix: the last good poll is a file, a
 * restart seeds from it as explicitly-stale data under the old "GitHub read"
 * stamp, a good poll replaces it, and a failed poll blanks neither the board
 * nor the file.
 *
 * Nothing here touches the network or the machine: every `gh` function and
 * `probeResources` are stubbed, and the timers are set far enough out that only
 * the explicit calls in these tests ever run.
 */

let home: string;
let repoPath: string;
let stateFile: string;

const ISSUE_4700: GhIssue = {
  number: 4700,
  title: 'Retry uploads when the edge runtime restarts',
  url: 'https://github.com/example-org/example-repo/issues/4700',
  labels: ['P1', 'blocked'],
  updatedAt: '2026-09-05T08:00:00Z',
  author: 'operator',
  spunOffFrom: null,
};

const NOTE_4700: GhBlockedNote = {
  by: 'qa-alice',
  at: '2026-09-05T08:05:00Z',
  body: 'Waiting on the infra team to ship the new edge image.',
};

const PR_4700: PullRequest = {
  number: 4750,
  url: 'https://github.com/example-org/example-repo/pull/4750',
  state: 'OPEN',
  title: 'fix: retry uploads on edge-runtime restart',
  isDraft: false,
};

/** The omnibus, carrying the one field these tests seed from it: the lane. */
const payloadWithLane = (): ActionsPayload => ({
  issues: [
    {
      number: 4700,
      title: ISSUE_4700.title,
      url: ISSUE_4700.url,
      updatedAt: ISSUE_4700.updatedAt,
      labels: ISSUE_4700.labels,
      comments: [],
      lane: 'Build',
      laneAt: '2026-09-05T07:00:00Z',
      referencingPrs: [],
      mergedPrs: [],
      closed: false,
      mergedAt: null,
    },
  ],
  prs: [],
  reviewRequested: [],
  mentions: [],
  merged: [],
  quota: { cost: 2, remaining: 4000, limit: 5000, resetAt: '2026-09-05T23:59:00Z' },
  truncated: null,
});

/** Every GitHub read the poll makes, answering. */
function githubAnswers() {
  vi.mocked(gh.listIssues).mockResolvedValue([ISSUE_4700]);
  vi.mocked(gh.listOpenPrs).mockResolvedValue(new Map([['fix/issue-4700-retry-uploads', PR_4700]]));
  vi.mocked(gh.listRecentMergedPrs).mockResolvedValue(new Map());
  vi.mocked(gh.readBlockedNote).mockResolvedValue(NOTE_4700);
  vi.mocked(gh.fetchActionsOnMe).mockResolvedValue(payloadWithLane());
}

/** Every GitHub read the poll makes, refusing — the exhausted-quota hour. */
function githubRefuses() {
  const quota = new Error('API rate limit exceeded');
  vi.mocked(gh.listIssues).mockRejectedValue(quota);
  vi.mocked(gh.listOpenPrs).mockRejectedValue(quota);
  vi.mocked(gh.listRecentMergedPrs).mockRejectedValue(quota);
  vi.mocked(gh.readBlockedNote).mockRejectedValue(quota);
  vi.mocked(gh.fetchActionsOnMe).mockRejectedValue(quota);
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-snapshot-')));
  repoPath = join(home, 'repo'); // deliberately not a git repo: nothing here scans
  mkdirSync(repoPath, { recursive: true });
  stateFile = join(home, 'state.json');

  vi.spyOn(gh, 'listIssues');
  vi.spyOn(gh, 'listOpenPrs');
  vi.spyOn(gh, 'listRecentMergedPrs');
  vi.spyOn(gh, 'readBlockedNote');
  vi.spyOn(gh, 'fetchActionsOnMe');
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(gh, 'readGraphqlQuota').mockResolvedValue({
    limit: 5000,
    remaining: 4000,
    resetAt: '2026-09-05T23:59:00Z',
  });
  vi.spyOn(resources, 'probeResources').mockResolvedValue(memoryOk());
  githubAnswers();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Both timers far enough out that nothing fires on its own. */
function orch() {
  return new Orchestrator(
    loadConfig({
      REPO: 'example-org/example-repo',
      REPO_PATH: repoPath,
      STATE_FILE: stateFile,
      CANONICAL_CLAUDE_DIR: join(home, '.claude'),
      ACCOUNTS_FILE: join(home, 'accounts.json'),
      POLL_MS: '999999',
      RESOURCES_MS: '999999',
    }),
  );
}

const snapshotFile = () => join(home, 'github-snapshot.json');
const snapshotOnDisk = () =>
  JSON.parse(readFileSync(snapshotFile(), 'utf8')) as {
    at: string;
    issues: GhIssue[];
    openPrs: Record<string, PullRequest>;
    blockedNotes: Record<string, GhBlockedNote>;
    lanes: Record<string, string>;
  };

describe('a restart inside a bad GitHub hour', () => {
  it('shows the old statuses under the old timestamp instead of a blank board', async () => {
    // The console before the restart: one good poll, which writes the snapshot.
    const before = orch();
    await before.start();
    const readAt = before.state().lastPolledAt!;
    expect(readAt).not.toBeNull();
    await before.stop();

    // The whole file made it to disk, beside state.json.
    const written = snapshotOnDisk();
    expect(written.at).toBe(readAt);
    expect(written.openPrs['fix/issue-4700-retry-uploads']!.number).toBe(4750);

    // The restart, with GitHub refusing every read — the 2026-09-05 hour.
    githubRefuses();
    const after = orch();
    await after.start();
    const s = after.state();

    // The board is the one from before the restart, not a checkpoint wall: the
    // real title, the blocked note's author and words, and the board lane.
    const row = s.issues.find((r) => r.number === 4700)!;
    expect(row).toBeDefined();
    expect(row.title).toBe(ISSUE_4700.title);
    expect(row.status).toBe('blocked');
    expect(row.statusDetail).toContain('@qa-alice');
    expect(row.statusDetail).toContain('infra team');
    expect(row.lane).toBe('Build');

    // And nothing claims liveness: the header stamp is the SNAPSHOT's age, and
    // the poll error beside it says why it has stopped moving.
    expect(s.lastPolledAt).toBe(readAt);
    expect(s.pollError).toContain('rate limit');
    await after.stop();
  });

  it('replaces the seed — in memory and on disk — once GitHub answers again', async () => {
    const before = orch();
    await before.start();
    const readAt = before.state().lastPolledAt!;
    await before.stop();

    githubRefuses();
    const after = orch();
    await after.start();
    expect(after.state().lastPolledAt).toBe(readAt);

    // The hour ends. GitHub now says the issue was unblocked and its PR closed.
    githubAnswers();
    vi.mocked(gh.listIssues).mockResolvedValue([{ ...ISSUE_4700, labels: ['P1'] }]);
    vi.mocked(gh.listOpenPrs).mockResolvedValue(new Map());
    await after.poll();

    const s = after.state();
    const row = s.issues.find((r) => r.number === 4700)!;
    expect(row.status).not.toBe('blocked');
    expect(Date.parse(s.lastPolledAt!)).toBeGreaterThan(Date.parse(readAt));
    // The next restart is owed this read, not the pre-restart one.
    const written = snapshotOnDisk();
    expect(written.at).toBe(s.lastPolledAt);
    expect(written.issues[0]!.labels).toEqual(['P1']);
    expect(written.openPrs).toEqual({});
    await after.stop();
  });

  it('seeds nothing from a snapshot it cannot trust whole', async () => {
    writeFileSync(snapshotFile(), '{ "at": "2026-09-05T08:'); // a truncated write
    githubRefuses();
    const o = orch();
    await o.start();
    // The pre-snapshot startup, which is honest too: nothing read, and it says so.
    expect(o.state().issues).toHaveLength(0);
    expect(o.state().lastPolledAt).toBeNull();
    expect(o.state().pollError).toContain('rate limit');
    await o.stop();
  });
});

describe('a failed poll mid-session', () => {
  it('keeps the stale-but-honest board and does not restamp the file', async () => {
    const o = orch();
    await o.start();
    const readAt = o.state().lastPolledAt!;

    githubRefuses();
    await o.poll();

    // The board still says what the last read said, under the last read's stamp.
    const s = o.state();
    const row = s.issues.find((r) => r.number === 4700)!;
    expect(row).toBeDefined();
    expect(row.status).toBe('blocked');
    expect(row.statusDetail).toContain('@qa-alice');
    expect(s.lastPolledAt).toBe(readAt);
    expect(s.pollError).toContain('rate limit');

    // And the failed poll wrote nothing: the file still carries the good read,
    // so a restart now would seed from truth rather than from an attempt.
    expect(snapshotOnDisk().at).toBe(readAt);
    await o.stop();
  });
});
