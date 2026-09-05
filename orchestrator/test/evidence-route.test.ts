/**
 * THE SCREENSHOT ROUTE, ATTACKED.
 *
 * `GET /api/issues/:n/evidence?path=…` is the only thing in this console that
 * hands a file out of a worktree, and gate C is the whole reason it exists: the
 * agent's own Playwright screenshots have to be on screen, at the gate, before
 * anything is pushed. A path parameter that reaches the filesystem is a
 * traversal vector, so every guard below is named after the attack it stops and
 * every test asserts the attack FAILS.
 *
 * evidence.test.ts covers the resolver in isolation. This file drives the real
 * express route against a real orchestrator holding a real git worktree, because
 * the response shaping — the content type, the nosniff, the cache header, the
 * status codes — is half of the fence and none of it is in the resolver.
 *
 * `probeResources` is stubbed, unconditionally: nothing in a test may read or
 * restart anything on the operator's actual machine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, chmodSync } from 'node:fs';
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

const ISSUE = 4351;
const PLANS = 'docs/issue-pipeline/plans';

let repo: string;
let worktree: string;
let home: string;
let stateFile: string;
let server: Server;
let base: string;

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** GET the route, with the path sent exactly as given (no helpful escaping). */
const get = (path: string, issue = ISSUE) =>
  fetch(`${base}/api/issues/${issue}/evidence?path=${encodeURIComponent(path)}`);

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-evi-home-')));
  stateFile = join(home, 'state.json');
  mkdirSync(join(home, '.claude'), { recursive: true });

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-evi-repo-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-evidence`);
  git(['worktree', 'add', '-b', `fix/issue-${ISSUE}-evidence`, worktree, 'dev'], repo);

  // The evidence a worker leaves, and the secrets that live beside it.
  mkdirSync(join(worktree, PLANS, 'qa-4351'), { recursive: true });
  writeFileSync(join(worktree, PLANS, 'qa-4351', 'after.png'), 'PNGDATA');
  writeFileSync(join(worktree, PLANS, 'qa-4351', 'rows.txt'), '849 rows');
  writeFileSync(join(worktree, '.env'), 'SUPABASE_SERVICE_ROLE_KEY=do-not-serve-me');

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: ISSUE, title: 'Evidence', url: 'u', labels: [], updatedAt: 'z', author: 'operator' },
  ]);
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(gh, 'listAuthoredOpenPrs').mockResolvedValue([]);
  // NEVER the real machine: this probe reads memory pressure and docker.
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
  const orch = new Orchestrator(cfg);
  await orch.poll(); // the scan is what binds this issue number to that worktree
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

describe('serving the agent evidence', () => {
  it('serves a declared screenshot as an image the browser will render', async () => {
    const res = await get(`${PLANS}/qa-4351/after.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-length')).toBe('7');
    expect(await res.text()).toBe('PNGDATA');
  });

  it('sends no-cache, so round 2 never shows round 1 screenshot', async () => {
    // Rounds reuse filenames — after.png is after.png every time — so the <img>
    // src is byte-identical between rounds. Without this header the browser
    // shows the OLD screenshot as proof of the NEW work, which is precisely the
    // lie this whole feature exists to prevent.
    const first = await get(`${PLANS}/qa-4351/after.png`);
    expect(first.headers.get('cache-control')).toContain('no-cache');
    writeFileSync(join(worktree, PLANS, 'qa-4351', 'after.png'), 'ROUND-TWO');
    expect(await (await get(`${PLANS}/qa-4351/after.png`)).text()).toBe('ROUND-TWO');
  });

  it('serves declared text evidence too, and always with nosniff', async () => {
    const res = await get(`${PLANS}/qa-4351/rows.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves a path that walks up and back INSIDE the plans tree — the fence is not over-broad', async () => {
    const res = await get('docs/issue-pipeline/../issue-pipeline/plans/qa-4351/after.png');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PNGDATA');
  });
});

describe('the attacks that must fail', () => {
  it('REFUSES ../ traversal to the worktree .env', async () => {
    const res = await get(`${PLANS}/../../../.env`);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('outside');
  });

  it('REFUSES an absolute path', async () => {
    const res = await get('/etc/passwd');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('outside');
  });

  it('REFUSES a SYMLINKED FILE inside plans that points at a secret outside it', async () => {
    symlinkSync(join(worktree, '.env'), join(worktree, PLANS, 'qa-4351', 'notes.txt'));
    const res = await get(`${PLANS}/qa-4351/notes.txt`);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('outside');
  });

  it('REFUSES a SYMLINKED DIRECTORY inside plans that tunnels to the worktree root', async () => {
    symlinkSync(worktree, join(worktree, PLANS, 'out'));
    const res = await get(`${PLANS}/out/.env`);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('outside');
  });

  it('REFUSES the plans root itself — there is no directory listing here', async () => {
    const res = await get(PLANS);
    expect(res.status).toBe(403);
  });

  it('REFUSES a directory inside plans — not a regular file', async () => {
    const res = await get(`${PLANS}/qa-4351`);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('not a regular file');
  });

  it('REFUSES a NUL byte cleanly, rather than throwing a 500 out of fs', async () => {
    const res = await get(`${PLANS}/qa-4351/after.png\0.txt`);
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(500);
    expect(await res.text()).toContain('bad path');
  });

  it('REFUSES a file over the size cap', async () => {
    writeFileSync(join(worktree, PLANS, 'qa-4351', 'huge.png'), Buffer.alloc(26 * 1024 * 1024));
    const res = await get(`${PLANS}/qa-4351/huge.png`);
    expect(res.status).toBe(413);
    expect(await res.text()).toContain('cap');
  });

  it('serves smuggled markup as INERT TEXT — no .html or .svg ever executes', async () => {
    writeFileSync(join(worktree, PLANS, 'qa-4351', 'evil.html'), '<script>fetch("/api/state")</script>');
    const res = await get(`${PLANS}/qa-4351/evil.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-type')).not.toContain('html');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('REFUSES an issue with no worktree — the path can only resolve against ITS OWN tree', async () => {
    const res = await get(`${PLANS}/qa-4351/after.png`, 9999);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('no worktree');
  });

  it('answers 404 for a missing file under plans — honest, and not confusable with a refusal', async () => {
    const res = await get(`${PLANS}/qa-4351/never-captured.png`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('not found');
  });
});

/**
 * A file the console can STAT but cannot READ used to take the whole process
 * down: `.pipe()` does not forward a source error, nothing listened for one, and
 * there is no `uncaughtException` handler anywhere in the orchestrator — so the
 * unhandled 'error' event killed the console mid-gate.
 *
 * The window is not exotic. The worker rewrites `after.png` in place every round
 * and `Cache-Control: no-cache` makes the browser re-fetch on every gate render,
 * so the gap between deciding to serve a file and actually reading it is entered
 * during precisely the activity this endpoint exists for.
 */
describe('a file that cannot be read must not kill the console', () => {
  it('answers an error and STAYS UP when the evidence file cannot be opened', async () => {
    const unreadable = join(worktree, PLANS, 'qa-4351', 'locked.png');
    writeFileSync(unreadable, 'PNGDATA');
    chmodSync(unreadable, 0o000);

    const res = await get(`${PLANS}/qa-4351/locked.png`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('could not open');

    // The real assertion: the server is still answering. Before the fix this
    // line was never reached — the process was gone.
    const after = await get(`${PLANS}/qa-4351/after.png`);
    expect(after.status).toBe(200);
    expect(await after.text()).toBe('PNGDATA');
  });

  it('declares the length of the bytes it is ACTUALLY sending, not of an earlier stat', async () => {
    // Content-Length came from one stat and the read re-opened the path, so a
    // file that shrank in between under-delivered against its own header and the
    // browser hung on a half-drawn screenshot. One open, one fstat, one read.
    const res = await get(`${PLANS}/qa-4351/rows.txt`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
  });
});
