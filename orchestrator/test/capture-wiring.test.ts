/**
 * THE CAPTURE RUNS BY ITSELF, BEFORE THE CARD.
 *
 * capture.test.ts proves the runner: the fences, the selection, the stamp, the
 * failure lines. This file proves the only thing that makes any of that answer
 * the operator's actual complaint — that no human intervention should be needed
 * to get the screenshots generated — which is WHEN it runs.
 *
 * A capture that has to be asked for is the round trip being deleted. So the
 * assertions here are about timing and about restraint, in equal measure:
 *
 *  - a gate C that arrives short of a drivable capture is captured DURING the
 *    poll that first sees it, and the state the console then serves already has
 *    the pictures on the row;
 *  - it happens exactly ONCE per gate round, so a console polling every fifteen
 *    minutes does not re-drive a browser at an open gate for ever;
 *  - it does not happen at gates A, B, D or E, and not while a worker is
 *    running — that worker owns `.gate.json` until it stops;
 *  - the button re-runs it on demand, and is refused while a worker is running.
 *
 * The browser is a fake and the port probe is a fixture. The Orchestrator
 * refuses to open a real one under vitest unless a test wires it, which is the
 * same rule the kill, the container restart and the watcher already follow.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Orchestrator } from '../src/orchestrator.js';
import { createServer, listen } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { parseManualQa } from '../src/manual-qa.js';
import type { CaptureDeps } from '../src/capture.js';
import type { GateLetter } from '../src/types.js';
import { killSpawnedWorkers } from './fixtures/spawned.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import type { ResourceReport } from '../src/types.js';

const ISSUE = 4404;
const PORT = 8093;
const BASELINE = 8080;
const PLANS = 'docs/issue-pipeline/plans';

let repo: string;
let worktree: string;
let home: string;
let stateFile: string;
let visited: string[];
let logs: string[];

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** Stands in for `claude`. With STUB_WAIT_FOR pointed at a file that never
 *  appears, it is a worker that stays running for as long as the test needs. */
const STUB = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stub-worker.mjs');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(() => {
  visited = [];
  logs = [];
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-cap-home-')));
  stateFile = join(home, 'state.json');

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-cap-repo-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-withdraw`);
  git(['worktree', 'add', '-b', `fix/issue-${ISSUE}-withdraw`, worktree, 'dev'], repo);

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
    headroomBytes: 8 * 1024 ** 3,
    headroomLabel: '8 GB',
    minFreePct: 25,
    footprintBytes: 0,
    footprintLabel: '0 GB',
    ceilingBytes: 11 * 1024 ** 3,
    ceilingLabel: '11 GB',
    totalBytes: 16 * 1024 ** 3,
    edgeRuntimeLabel: null,
    edgeRuntimeBytes: null,
    workerHeadroomBytes: 0,
    swapUsedPct: 10,
    swapLabel: '1.6 GB of 16.0 GB (10%)',
    maxSwapPct: 85,
    checkedAt: new Date().toISOString(),
  } as ResourceReport);
});

afterEach(() => {
  killSpawnedWorkers(stateFile);
  delete process.env.STUB_WAIT_FOR;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The worktree as a worker leaves it: a port in prose and a gate with one
 *  drivable step whose captures were never wired. */
function park(gate: GateLetter = 'C', over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(worktree, '.issue-state.md'),
    `# Issue #${ISSUE}\n\n- **Dev-server port**: **${PORT}** — running\n- **Stage reached**: 5\n`,
  );
  writeFileSync(
    join(worktree, '.gate.json'),
    JSON.stringify({
      issue: ISSUE,
      gate,
      stage: 5,
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      stoppedAt: '2026-08-12T09:00:00.000Z',
      summary: 'Did: drove the app headlessly.',
      questions: [],
      evidence: [],
      manualQa: {
        appUrl: `http://localhost:${PORT}`,
        steps: [
          {
            id: 1,
            rev: 1,
            do: 'Withdraw a sent quote',
            route: '/quotes/1234',
            before: 'no warning',
            beforeShot: null,
            after: 'it asks first',
            afterShot: null,
          },
        ],
      },
      ...over,
    }),
  );
}

const fake: CaptureDeps = {
  listens: async () => true,
  open: async () => ({
    async shot({ url, file }) {
      visited.push(url);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `png-for-${url}`);
    },
    async close() {},
  }),
};

const config = (env: Record<string, string> = {}) =>
  loadConfig({
    PORT: '0',
    REPO: 'example-org/example-repo',
    REPO_PATH: repo,
    STATE_FILE: stateFile,
    RUNS_FILE: join(home, 'runs.jsonl'),
    STREAM_DIR: join(home, 'runs'),
    CANONICAL_CLAUDE_DIR: join(home, '.claude'),
    POLL_MS: '999999',
    BASELINE_PORT: String(BASELINE),
    MAX_ACTIVE: '0',
    ...env,
  });

function orch(captureDeps: CaptureDeps | undefined = fake, env: Record<string, string> = {}) {
  return new Orchestrator(config(env), { captureDeps, log: (line) => logs.push(line) });
}

const row = (o: Orchestrator) => o.state().issues.find((i) => i.number === ISSUE)!;
const gateOnDisk = () => JSON.parse(readFileSync(join(worktree, '.gate.json'), 'utf8')) as Record<string, unknown>;

describe('the console captures the missing screenshots by itself', () => {
  /**
   * THE WHOLE POINT. The operator has pressed nothing, asked for nothing and
   * sent nothing back, and the first card they are shown already carries both
   * pictures.
   */
  it('captures during the poll that first sees the gate, so the first card has the pictures', async () => {
    const o = orch();
    park();
    await o.poll();

    const qa = row(o).gateManualQa!;
    expect(qa.steps[0]!.beforeShot).toBe(`${PLANS}/qa-${ISSUE}/auto/s1r1-before.png`);
    expect(qa.steps[0]!.afterShot).toBe(`${PLANS}/qa-${ISSUE}/auto/s1r1-after.png`);
    expect(row(o).captureReport?.ok).toBe(true);
    expect(row(o).captureReport?.wrote.sort()).toEqual(['1/after', '1/before']);
  });

  it('files them in the evidence manifest too, so the evidence box shows them', async () => {
    const o = orch();
    park();
    await o.poll();
    expect(row(o).gateEvidence.map((e) => e.path).sort()).toEqual([
      `${PLANS}/qa-${ISSUE}/auto/s1r1-after.png`,
      `${PLANS}/qa-${ISSUE}/auto/s1r1-before.png`,
    ]);
  });

  it('drives the worktree port for the after and the configured baseline for the before', async () => {
    const o = orch();
    park();
    await o.poll();
    expect(visited.sort()).toEqual([
      `http://127.0.0.1:${BASELINE}/quotes/1234`,
      `http://127.0.0.1:${PORT}/quotes/1234`,
    ]);
  });

  /** A console polls for as long as a gate is open. Re-driving a browser every
   *  fifteen minutes over a gate it already captured is not "consistent". */
  it('runs ONCE per gate round, however many times it polls', async () => {
    const o = orch();
    park();
    await o.poll();
    await o.poll();
    await o.poll();
    expect(visited).toHaveLength(2); // the two legs of the one round
  });

  it('runs again when the worker comes back with a new round', async () => {
    const o = orch();
    park();
    await o.poll();
    expect(visited).toHaveLength(2);
    // A new round: the step was reworked and both legs are unwired again.
    park('C', { stoppedAt: '2026-08-12T11:00:00.000Z' });
    await o.poll();
    expect(visited).toHaveLength(4);
  });

  it('leaves a step that already has both captures alone', async () => {
    const o = orch();
    park();
    mkdirSync(join(worktree, PLANS, `qa-${ISSUE}`), { recursive: true });
    writeFileSync(join(worktree, PLANS, `qa-${ISSUE}`, 'b.png'), 'b');
    writeFileSync(join(worktree, PLANS, `qa-${ISSUE}`, 'a.png'), 'a');
    const gate = gateOnDisk() as { manualQa: { steps: Array<Record<string, unknown>> } };
    gate.manualQa.steps[0]!.beforeShot = `${PLANS}/qa-${ISSUE}/b.png`;
    gate.manualQa.steps[0]!.afterShot = `${PLANS}/qa-${ISSUE}/a.png`;
    writeFileSync(join(worktree, '.gate.json'), JSON.stringify(gate));

    await orch().poll().then(() => {});
    expect(visited).toEqual([]);
  });

  it.each(['A', 'B', 'D', 'E'] as const)('does not capture at gate %s', async (gate) => {
    const o = orch();
    park(gate);
    await o.poll();
    expect(visited).toEqual([]);
  });

  /** The console must not rewrite a file its worker still owns. Without a
   *  baseline the before leg is not driven, and the card says which setting. */
  it('takes no before with no BASELINE_PORT, and names the setting on the card', async () => {
    const o = orch(fake, { BASELINE_PORT: '' });
    park();
    await o.poll();
    expect(visited).toEqual([`http://127.0.0.1:${PORT}/quotes/1234`]);
    expect(row(o).captureReport?.notes.join(' ')).toContain('BASELINE_PORT');
    expect(row(o).gateManualQa!.steps[0]!.beforeShot).toBeNull();
  });

  it('does not drive a step with no route, and says so rather than going quiet', async () => {
    const o = orch();
    park();
    const gate = gateOnDisk() as { manualQa: { steps: Array<Record<string, unknown>> } };
    gate.manualQa.steps[0]!.route = null;
    writeFileSync(join(worktree, '.gate.json'), JSON.stringify(gate));
    await o.poll();
    expect(visited).toEqual([]);
    expect(row(o).captureReport?.notes.join(' ')).toContain('no "route"');
  });

  /**
   * FAILURE IS ON THE CARD, NEVER SILENT — and it claims the round, so a
   * machine with no browser does not relaunch one on every poll for the whole
   * time a gate sits open.
   */
  it('puts a failure on the row with the command that fixes it, once', async () => {
    let opens = 0;
    const o = orch({
      listens: async () => true,
      open: async () => {
        opens += 1;
        throw new Error('Chromium is not installed for Playwright — run `npx playwright install chromium` and capture again.');
      },
    });
    park();
    await o.poll();
    await o.poll();
    expect(opens).toBe(1);
    const report = row(o).captureReport!;
    expect(report.ok).toBe(false);
    expect(report.line).toContain('npx playwright install chromium');
  });

  /**
   * A test that has not wired a browser gets neither a browser nor a probe of
   * this machine's ports. It is the same rule the kill, the container restart
   * and the watcher already follow, and it is structural rather than a
   * convention: a capture is a real Chromium pointed at whatever is listening
   * on the operator's laptop, which is one short step from acting on it.
   *
   * The port probe refuses first, so that is the sentence that lands. What
   * matters is that both refuse and nothing at all is driven or written.
   */
  it('drives nothing and writes nothing from a test that has not wired it', async () => {
    const o = new Orchestrator(config(), { log: (line) => logs.push(line) });
    park();
    await o.poll();
    expect(visited).toEqual([]);
    expect(existsSync(join(worktree, PLANS, `qa-${ISSUE}`))).toBe(false);
    expect(row(o).captureReport?.ok).toBe(false);
    expect(row(o).captureReport?.notes.join(' ')).toContain('Nothing is listening');
  });
});

describe('the Capture shots button', () => {
  let server: Server;
  let base: string;
  let o: Orchestrator;

  const start = async (deps: CaptureDeps | undefined = fake) => {
    const cfg = config();
    o = new Orchestrator(cfg, { captureDeps: deps, log: (line) => logs.push(line) });
    server = await listen(createServer(cfg, o), cfg);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  /**
   * THE CASE THE BUTTON EXISTS FOR. The automatic run happened and could not
   * take a picture — the dev server was not up yet. The operator starts it and
   * presses the button; the once-per-round guard does not stand in the way,
   * because the round has not changed and the reason it failed has.
   */
  it('re-runs the capture on demand once the reason it failed is gone', async () => {
    let up = false;
    await start({ ...fake, listens: async () => up });
    park();
    await o.poll();
    expect(visited).toEqual([]);
    expect(row(o).captureReport?.line).toContain('No capture could be run');

    up = true;
    const res = await fetch(`${base}/api/issues/${ISSUE}/capture`, { method: 'POST' });
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(visited).toHaveLength(2);
    expect(row(o).gateManualQa!.steps[0]!.afterShot).toBe(`${PLANS}/qa-${ISSUE}/auto/s1r1-after.png`);
  });

  /** Pressed on a gate that is already complete, it says so rather than
   *  overwriting captures somebody already has. */
  it('takes nothing when every step already has its captures, and says so', async () => {
    await start();
    park();
    await o.poll();
    visited.length = 0;

    const res = await fetch(`${base}/api/issues/${ISSUE}/capture`, { method: 'POST' });
    expect(visited).toEqual([]);
    expect(((await res.json()) as { message: string }).message).toContain('already has the captures it owes');
  });

  it('refuses an issue that is not at gate C', async () => {
    await start();
    park('B');
    await o.poll();
    const res = await fetch(`${base}/api/issues/${ISSUE}/capture`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain('not at gate C');
  });

  it('refuses an issue with no worktree', async () => {
    await start();
    const res = await fetch(`${base}/api/issues/9999/capture`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain('no worktree');
  });

  /**
   * THE WRITE FENCE, at the one moment it can be violated. `.gate.json` is the
   * worker's file until it stops, and a capture stamps it — so a live worker is
   * a refusal, not a race. The automatic pass skips a busy issue for the same
   * reason; this is the half a person can reach with a button.
   */
  it('refuses while that worktree\'s worker is running — the file is the worker\'s', async () => {
    process.env.STUB_WAIT_FOR = join(home, 'never-appears');
    const cfg = config({ CLAUDE_BIN: STUB, STREAM_POLL_MS: '25', MAX_ACTIVE: '1' });
    o = new Orchestrator(cfg, { captureDeps: fake, log: (line) => logs.push(line) });
    server = await listen(createServer(cfg, o), cfg);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    park();
    await o.start();
    await o.poll();
    visited.length = 0;
    // A resume rather than a fresh start: this issue is parked at a gate, and
    // answering the gate is exactly what puts a worker back on the file.
    void o.resume(ISSUE, 'have another look at step 1');
    await waitFor('the worker to be running', () => row(o).status === 'active');

    const res = await fetch(`${base}/api/issues/${ISSUE}/capture`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain('the worker is running');
    expect(visited).toEqual([]);
  });
});

describe('what lands in the gate file', () => {
  it('is the canonical shape the parsers read back, with everything else untouched', async () => {
    const o = orch();
    park();
    const before = gateOnDisk();
    await o.poll();
    const after = gateOnDisk();

    expect(after.summary).toBe(before.summary);
    expect(after.stoppedAt).toBe(before.stoppedAt);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.gate).toBe('C');
    expect(after.evidence).toEqual([
      {
        kind: 'screenshot',
        path: `${PLANS}/qa-${ISSUE}/auto/s1r1-before.png`,
        caption: 'Withdraw a sent quote — before',
      },
      {
        kind: 'screenshot',
        path: `${PLANS}/qa-${ISSUE}/auto/s1r1-after.png`,
        caption: 'Withdraw a sent quote — after',
      },
    ]);
    // and the real parser reads its own steps back
    expect(parseManualQa(after.manualQa)!.steps[0]!.afterShot).toBe(`${PLANS}/qa-${ISSUE}/auto/s1r1-after.png`);
  });
});
