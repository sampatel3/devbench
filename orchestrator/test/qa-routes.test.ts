/**
 * The two gate-C v2 routes, driven over real HTTP.
 *
 * They exist as routes of their own rather than as client-composed `/resume`
 * calls for the same reason `/ask` does: only the console can know a tick is a
 * tick, and only the console can snapshot the evidence before a rework rewrites
 * the gate file. A page cannot be trusted to compose either.
 *
 * What is tested here is the wiring and the refusals — a mistyped route or a
 * validation that lets nonsense through is a dead button at a gate, which is
 * precisely the class of failure this console keeps being bitten by. The
 * behaviour behind them is covered in qa-rework.test.ts.
 *
 * Neither route writes to GitHub, and neither touches a worktree file. That is
 * not incidental: comment.ts is still the only writer.
 *
 * `probeResources` is stubbed: nothing here reads or restarts anything on the operator's
 * actual machine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer, listen } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Orchestrator } from '../src/orchestrator.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ResourceReport } from '../src/types.js';

const ISSUE = 4404;
const QA = 'docs/issue-pipeline/plans/qa-4404';

let repo: string;
let worktree: string;
let home: string;
let stateFile: string;
let server: Server;
let base: string;
let orch: Orchestrator;

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' });

const post = (path: string, body?: unknown) =>
  fetch(`${base}/api/issues/${ISSUE}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-qaroute-home-')));
  stateFile = join(home, 'state.json');
  mkdirSync(join(home, '.claude'), { recursive: true });

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-qaroute-repo-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-withdraw`);
  git(['worktree', 'add', '-b', `fix/issue-${ISSUE}-withdraw`, worktree, 'dev'], repo);
  writeFileSync(
    join(worktree, '.gate.json'),
    JSON.stringify({
      issue: ISSUE,
      gate: 'C',
      stage: 5,
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      stoppedAt: '2026-08-12T09:00:00.000Z',
      summary: 'Did: drove the app headlessly on 8106.',
      questions: [],
      evidence: [{ kind: 'screenshot', path: `${QA}/s1-after.png`, caption: 'step 1 — asks first' }],
      manualQa: {
        appUrl: 'http://localhost:8106',
        start: 'a quote in Sent',
        steps: [
          // Both legs on both steps: a step short of a capture now locks the
          // gate on its own, and this fixture is about the ticks.
          {
            id: 1,
            rev: 1,
            do: 'Withdraw a sent quote',
            before: 'no warning',
            beforeShot: `${QA}/s1-before.png`,
            after: 'it asks first',
            afterShot: `${QA}/s1-after.png`,
          },
          {
            id: 2,
            rev: 1,
            do: 'Try to accept it',
            before: 'Accept worked',
            beforeShot: `${QA}/s2-before.png`,
            after: 'Accept is gone',
            afterShot: `${QA}/s2-after.png`,
          },
        ],
      },
    }),
  );

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: ISSUE, title: 'Withdraw', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
  ]);
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
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

  const cfg = loadConfig({
    PORT: '0',
    REPO: 'example-org/example-repo',
    REPO_PATH: repo,
    STATE_FILE: stateFile,
    RUNS_FILE: join(home, 'runs.jsonl'),
    STREAM_DIR: join(home, 'runs'),
    CANONICAL_CLAUDE_DIR: join(home, '.claude'),
    POLL_MS: '999999',
  });
  orch = new Orchestrator(cfg);
  await orch.poll(); // the scan binds the issue number to that worktree
  server = await listen(createServer(cfg, orch), cfg);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  killSpawnedWorkers(stateFile);
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('POST /api/issues/:n/qa-verdict', () => {
  it('records a tick and shows it on the row', async () => {
    const res = await post('qa-verdict', { stepId: 1, rev: 1, status: 'verified' });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });

    const row = orch.state().issues.find((r) => r.number === ISSUE)!;
    expect(row.qaVerdicts).toHaveLength(1);
    expect(row.qaVerdicts[0]).toMatchObject({ stepId: 1, rev: 1, status: 'verified' });
  });

  it('refuses a fail with no words — the worker builds the fix from them', async () => {
    const res = await post('qa-verdict', { stepId: 1, rev: 1, status: 'failed' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toMatch(/say what you saw/i);
  });

  it('refuses a body that names no step, and a status that is not a tick', async () => {
    expect((await post('qa-verdict', { status: 'verified' })).status).toBe(400);
    expect((await post('qa-verdict', { stepId: 1, rev: 1, status: 'passed' })).status).toBe(400);
    expect((await post('qa-verdict', { stepId: 1.5, rev: 1, status: 'verified' })).status).toBe(400);
    const row = orch.state().issues.find((r) => r.number === ISSUE)!;
    expect(row.qaVerdicts).toEqual([]);
  });

  it('does not write into the worktree — the gate file is the worker', async () => {
    const before = readGate();
    await post('qa-verdict', { stepId: 1, rev: 1, status: 'failed', note: 'no dialog appeared' });
    expect(readGate()).toBe(before);
  });
});

describe('POST /api/issues/:n/qa-rework', () => {
  it('refuses when nothing is failed, and says what to do instead', async () => {
    const res = await post('qa-rework');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toMatch(/tick a step Failed/i);
  });

  it('is reachable and takes no body — the ticks decide what goes back', async () => {
    await post('qa-verdict', { stepId: 2, rev: 1, status: 'failed', note: 'Accept was still there' });
    const res = await post('qa-rework');
    // 200 or 409 from the orchestrator, never a 404 from the router: a mistyped
    // route is a dead button, and that is the bug this test exists for.
    expect([200, 409]).toContain(res.status);
    expect(res.status).not.toBe(404);
    const body = (await res.json()) as { ok: boolean; message: string };
    if (body.ok) expect(body.message).toMatch(/step 2/);
  });
});

/**
 * THE LOCK IS NOT ONLY A RENDERING.
 *
 * `approveLockC` runs in the page, over a row that arrived by SSE, and a row can
 * be a moment old — a rework returning between the paint and the click resets a
 * tick under a button that still reads "Approve gate C". So the QA half is
 * recomputed here, from the state on disk at the instant of the decision.
 *
 * This is NOT a security boundary and nothing below should be read as one: the
 * server binds loopback with no auth by design and workers hold unrestricted
 * Bash as the same user. The check earns its place against staleness and against
 * a mistake in the page.
 */
describe('POST /api/issues/:n/approve-c', () => {
  const approve = (message = 'Gate C approved — I ran the manual QA myself.') => post('approve-c', { message });

  it('refuses an approval with steps still unticked, and sends nothing', async () => {
    const res = await approve();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/2 step\(s\) are not ticked verified/);
    expect(body.message).toMatch(/Nothing was sent/);
  });

  it('refuses while a step is ticked Failed, and names it', async () => {
    await post('qa-verdict', { stepId: 1, rev: 1, status: 'verified' });
    await post('qa-verdict', { stepId: 2, rev: 1, status: 'failed', note: 'Accept was still there' });
    const body = (await (await approve()).json()) as { message: string };
    expect(body.message).toMatch(/step 2 is still ticked Failed/);
  });

  it('refuses an empty message, and refuses a gate that is not C', async () => {
    expect((await post('approve-c', { message: '   ' })).status).toBe(400);
    writeFileSync(
      join(worktree, '.gate.json'),
      JSON.stringify({ issue: ISSUE, gate: 'D', stage: 7, sessionId: 'x', stoppedAt: '2026-08-12T10:00:00.000Z' }),
    );
    await orch.poll();
    const body = (await (await approve()).json()) as { message: string };
    expect(body.message).toMatch(/not parked at gate C/);
  });

  /**
   * A step short of a capture is a WARNING they take by hand on the card, not a
   * refusal here: the operator asked for a warning rather than a degraded gate,
   * with the gate still explicitly approved by hand. Refusing it
   * server-side would make an honest report of a failed capture a gate nobody
   * can pass — so this route stays out of it, and the acceptance rides in the
   * approval message the page composes.
   */
  it('does NOT refuse a gate whose step is short of a capture — that call is theirs', async () => {
    const gate = JSON.parse(readGate()) as {
      manualQa: { steps: Array<Record<string, unknown>> };
    };
    gate.manualQa.steps[1]!.afterShot = null;
    writeFileSync(join(worktree, '.gate.json'), JSON.stringify(gate));
    await orch.poll();
    await post('qa-verdict', { stepId: 1, rev: 1, status: 'verified' });
    await post('qa-verdict', { stepId: 2, rev: 1, status: 'verified' });

    const body = (await (await approve()).json()) as { message: string };
    expect(body.message).not.toMatch(/not passable/);
  });

  /** Every step ticked by hand: the QA half is satisfied and the resume is the
   *  only thing left to fail on (there is no worker to resume in this fixture). */
  it('lets a fully ticked gate through to the resume', async () => {
    await post('qa-verdict', { stepId: 1, rev: 1, status: 'verified' });
    await post('qa-verdict', { stepId: 2, rev: 1, status: 'verified' });
    const body = (await (await approve()).json()) as { message: string };
    expect(body.message).not.toMatch(/not passable/);
  });
});

const readGate = (): string => readFileSync(join(worktree, '.gate.json'), 'utf8');
