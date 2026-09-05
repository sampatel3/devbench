import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import { memoryOk } from './fixtures/memory.js';

/**
 * PARKING — the operator sets a ticket aside.
 *
 * The operator asked to pause some tickets: they stay at their gate, they leave
 * the top of the queue, and the row says plainly that it is paused — the same
 * treatment as blocked, so it is clear which tickets are neither complete nor
 * awaiting something. That is a different state from awaiting external review or
 * input, such as a PR that is open and waiting to be reviewed and merged.
 *
 * The ordering and the look are proved in `priority.test.ts` and `look.test.ts`,
 * which need no orchestrator. What needs one is the half those two cannot see:
 *
 *   - it PERSISTS. It is their decision, so it must survive a refresh and a
 *     restart, on the same principle as everything else in `state.json` —
 *     "state in a process is state you lose";
 *   - it MOVES NOTHING. A parked ticket keeps its gate, its stage, its worktree,
 *     its session and its status. That is not a nice-to-have, it is the feature:
 *     a parked ticket remains at its gate. The assertions below are mostly
 *     assertions about things that did NOT change.
 */
let repo: string;
let worktree: string;

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

const stateFile = () => join(repo, 'state.json');

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wc-park-'));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  worktree = join(repo, '.worktrees', 'issue-4491-demo');
  git(['worktree', 'add', '-b', 'fix/issue-4491-demo', worktree, 'dev'], repo);
  // A real, open gate. This is what must still be there afterwards.
  writeFileSync(
    join(worktree, '.gate.json'),
    JSON.stringify({
      issue: 4491,
      gate: 'C',
      stage: 5,
      sessionId: 'sess-4491',
      stoppedAt: '2026-08-17T09:00:00Z',
      summary: 'Understanding: the reset link builder now reads the branded domain.',
      questions: ['Should the old domain keep redirecting?'],
    }),
  );

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: 4491, title: 'Branded reset links', url: 'u', labels: ['P0'], updatedAt: 'z', author: 'someone-else' },
  ]);
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(resources, 'probeResources').mockResolvedValue(memoryOk());
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function orch() {
  return new Orchestrator(
    loadConfig({ REPO_PATH: repo, REPO: 'example-org/example-repo', STATE_FILE: stateFile(), POLL_MS: '999999' }),
  );
}

const rowOf = (o: Orchestrator) => o.state().issues.find((r) => r.number === 4491)!;

describe('parking keeps the gate — it moves nothing at all', () => {
  it('leaves the status, the gate, the stage and the gate file exactly as they were', async () => {
    const o = orch();
    await o.start();

    const before = rowOf(o);
    expect(before.status).toBe('at-gate');
    expect(before.gate?.gate).toBe('C');
    expect(before.parked).toBeNull();

    const gateFileBefore = readFileSync(join(worktree, '.gate.json'), 'utf8');

    const out = await o.parkIssue(4491, 'waiting for the design call on 3 Sep');
    expect(out.ok).toBe(true);

    const after = rowOf(o);
    // The parked stamp is the ONLY thing that changed on this row.
    expect(after.parked?.reason).toBe('waiting for the design call on 3 Sep');
    expect(after.status).toBe('at-gate');
    expect(after.statusDetail).toBe(before.statusDetail);
    expect(after.gate?.gate).toBe('C');
    expect(after.gate?.questions).toEqual(before.gate?.questions);
    expect(after.stage).toBe(before.stage);
    expect(after.worktree).toBe(before.worktree);
    expect(after.gatesPassed).toEqual(before.gatesPassed);
    // And nothing wrote to the worktree. The console never does; this proves it.
    expect(readFileSync(join(worktree, '.gate.json'), 'utf8')).toBe(gateFileBefore);
    await o.stop();
  });

  it('is not a WorkerStatus, so it can never displace the gate it sits beside', async () => {
    // The design decision this test guards. Had `parked` been a status,
    // `deriveStatus` would have had to return it INSTEAD of `at-gate` — and the
    // one rule of the feature is that the ticket keeps its gate.
    const o = orch();
    await o.start();
    await o.parkIssue(4491, '');
    const row = rowOf(o);
    expect(row.status).not.toBe('parked');
    expect(row.status).toBe('at-gate');
    await o.stop();
  });
});

describe('parking is their decision, so it is written down', () => {
  it('survives a console restart, reason and all', async () => {
    const first = orch();
    await first.start();
    await first.parkIssue(4491, 'blocked on the domain answer from teammate-one');
    await first.stop();

    // A second orchestrator over the same state file — a real restart.
    const second = orch();
    await second.start();
    const row = rowOf(second);
    expect(row.parked?.reason).toBe('blocked on the domain answer from teammate-one');
    expect(row.parked?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row.status).toBe('at-gate');
    await second.stop();
  });

  it('goes into state.json, not into the gate ledger', async () => {
    // `decisions.jsonl` is append-only and every entry in it is a GATE decision
    // that `gatesApproved` counts. Parking decides nothing about the work and is
    // reversible, which an append-only ledger models badly.
    const o = orch();
    await o.start();
    await o.parkIssue(4491, 'later');
    await o.stop();

    const persisted = JSON.parse(readFileSync(stateFile(), 'utf8')) as { parked: Record<string, unknown> };
    expect(persisted.parked['4491']).toEqual({ at: expect.any(String), reason: 'later' });
  });

  it('records no reason rather than an empty one when they do not say', async () => {
    // A parked ticket with no reason is fine. `''` and "they gave no reason" must
    // be the same fact on the row, or the card has to decide which to believe.
    const o = orch();
    await o.start();
    await o.parkIssue(4491, '   ');
    expect(rowOf(o).parked?.reason).toBeNull();
    await o.stop();
  });

  it('un-parks, and the row comes back with everything it had', async () => {
    const o = orch();
    await o.start();
    await o.parkIssue(4491, 'later');
    expect(rowOf(o).parked).not.toBeNull();

    const out = await o.unparkIssue(4491);
    expect(out.ok).toBe(true);
    const row = rowOf(o);
    expect(row.parked).toBeNull();
    expect(row.status).toBe('at-gate');
    expect(row.gate?.gate).toBe('C');
    await o.stop();
  });

  it('refuses the second park and the un-park of something that is not parked', async () => {
    // Not politeness: a second park would overwrite the date and the reason they
    // wrote the first time, which is the one thing worth having weeks later.
    const o = orch();
    await o.start();
    expect((await o.unparkIssue(4491)).ok).toBe(false);
    expect((await o.parkIssue(4491, 'first')).ok).toBe(true);
    const second = await o.parkIssue(4491, 'second');
    expect(second.ok).toBe(false);
    expect(rowOf(o).parked?.reason).toBe('first');
    await o.stop();
  });
});
