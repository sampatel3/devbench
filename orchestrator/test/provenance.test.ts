import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { GhIssue } from '../src/gh.js';
import type { ResourceReport } from '../src/types.js';

/**
 * WHERE AN ASSIGNED ISSUE CAME FROM, carried from `gh issue list` onto the row.
 *
 * The repo's `issue-dev-autoassign` workflow assigns the filer, so an issue a
 * worker on this laptop spun off lands in the assigned queue looking exactly like
 * work the team handed over. `author` is the only thing that tells them apart,
 * and `selfFiled` is that comparison made once, against the account this console
 * runs as, so the UI and the status summary cannot disagree about it.
 *
 * Nothing here spawns a worker or reaches GitHub: every gh call is stubbed, and
 * the repo path is an ordinary empty directory.
 */

let home: string;
let stateFile: string;
let repoPath: string;

/** The three real shapes, as seen in the operator's queue on 11 Aug 2026, plus one edge. */
const ISSUES: GhIssue[] = [
  // Spun off by the #4404 worker, then auto-assigned back to them.
  {
    number: 4472,
    title: 'tech-debt(reporting)',
    url: 'u',
    labels: ['needs-triage'],
    updatedAt: 'z',
    author: 'operator',
  },
  // A real teammate's issue that ALSO carries needs-triage.
  {
    number: 4336,
    title: 'Organizations Sysadmin Filter Pills Bug',
    url: 'u',
    labels: ['needs-triage'],
    updatedAt: 'z',
    author: 'qa-bob',
  },
  // Filed here, but triage has since ranked it and dropped the label.
  { number: 4342, title: 'Quote Preview Notice Pills', url: 'u', labels: ['P2'], updatedAt: 'z', author: 'operator' },
  // No author to read at all — a deleted account. Never "self-filed".
  { number: 4400, title: 'An issue with no author', url: 'u', labels: ['needs-triage'], updatedAt: 'z', author: '' },
];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-provenance-')));
  stateFile = join(home, 'state.json');
  repoPath = join(home, 'repo'); // deliberately not a git repo: nothing here scans
  mkdirSync(repoPath, { recursive: true });

  vi.spyOn(gh, 'listIssues').mockResolvedValue(ISSUES);
  // Merged PRs are read on every poll now (a merged PR used to vanish from the
  // console and the row lied). Stubbed empty so no test reaches the network.
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(gh, 'listAuthoredOpenPrs').mockResolvedValue([]);
  vi.spyOn(resources, 'probeResources').mockResolvedValue({
    ok: true,
    reason: 'memory ok',
    freePct: 90,
    headroomBytes: 0,
    headroomLabel: '9 GB',
    minFreePct: 25,
    footprintBytes: 0,
    footprintLabel: '0 GB',
    ceilingBytes: 1,
    ceilingLabel: '1 GB',
    totalBytes: 2,
    edgeRuntimeLabel: null,
    checkedAt: new Date().toISOString(),
  } as ResourceReport);
});

afterEach(() => {
  // FIRST, and unconditionally: nothing here should spawn a worker, and if
  // anything ever does, a failed assertion must not leave a real process behind.
  killSpawnedWorkers(stateFile);
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function orch(assignee = 'operator') {
  return new Orchestrator(
    loadConfig({
      REPO: 'example-org/example-repo',
      REPO_PATH: repoPath,
      STATE_FILE: stateFile,
      ACCOUNTS_FILE: join(home, 'accounts.json'),
      CANONICAL_CLAUDE_DIR: join(home, '.claude'),
      ASSIGNEE: assignee,
      POLL_MS: '999999',
    }),
  );
}

const rowsOf = (o: Orchestrator) => new Map(o.state().issues.map((r) => [r.number, r]));

describe('who filed the issue', () => {
  it('carries the author onto the row, and calls only our own account self-filed', async () => {
    const o = orch();
    await o.start();
    const rows = rowsOf(o);

    expect(rows.get(4472)).toMatchObject({ author: 'operator', selfFiled: true, labels: ['needs-triage'] });
    expect(rows.get(4336)).toMatchObject({ author: 'qa-bob', selfFiled: false, labels: ['needs-triage'] });
    expect(rows.get(4342)).toMatchObject({ author: 'operator', selfFiled: true, labels: ['P2'] });
    // An empty author is not a match, however the assignee is configured.
    expect(rows.get(4400)).toMatchObject({ author: '', selfFiled: false });

    await o.stop();
  });

  it('asks GitHub for the assignee’s open issues and nothing else', async () => {
    const o = orch();
    await o.start();
    expect(gh.listIssues).toHaveBeenCalledWith('example-org/example-repo', 'operator');
    await o.stop();
  });

  it('is a comparison against the configured account, not a hard-coded login', async () => {
    const o = orch('qa-bob');
    await o.start();
    const rows = rowsOf(o);
    expect(rows.get(4472)?.selfFiled).toBe(false);
    expect(rows.get(4336)?.selfFiled).toBe(true);
    await o.stop();
  });
});
