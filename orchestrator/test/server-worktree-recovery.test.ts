import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, listen } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import type { Orchestrator } from '../src/orchestrator.js';

let dir: string;
let server: Awaited<ReturnType<typeof listen>>;
let base: string;
const continueExistingWorktree = vi.fn();
const existingWorktreePlan = vi.fn();

function fakeOrch(): Orchestrator {
  return {
    state: () => ({ issues: [] }),
    on: vi.fn(),
    off: vi.fn(),
    continueExistingWorktree,
    existingWorktreePlan,
  } as unknown as Orchestrator;
}

beforeEach(async () => {
  continueExistingWorktree.mockReset();
  existingWorktreePlan.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'wc-worktree-recovery-route-'));
  const cfg = loadConfig({ STATE_FILE: join(dir, 'state.json'), PORT: '0', UI_DIR: join(dir, 'no-ui') });
  server = await listen(createServer(cfg, fakeOrch()), { ...cfg, port: 0 });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const post = () =>
  fetch(`${base}/api/issues/5015/worktree/continue-existing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ head: '24ad5071', port: 8083, mode: 'restore' }),
  });

describe('POST /api/issues/:n/worktree/continue-existing', () => {
  it('derives the recovery target from the issue number and returns success', async () => {
    continueExistingWorktree.mockResolvedValue({ ok: true, message: 'restored existing branch' });
    const response = await post();
    expect(response.status).toBe(200);
    expect(continueExistingWorktree).toHaveBeenCalledWith(5015, '24ad5071', 8083, 'restore');
  });

  it('returns conflict when the recorded failure is not safely recoverable', async () => {
    continueExistingWorktree.mockResolvedValue({ ok: false, message: 'not recoverable' });
    const response = await post();
    expect(response.status).toBe(409);
  });

  it('refuses a write that did not come from the reviewed plan', async () => {
    const response = await fetch(`${base}/api/issues/5015/worktree/continue-existing`, { method: 'POST' });
    expect(response.status).toBe(400);
    expect(continueExistingWorktree).not.toHaveBeenCalled();
  });
});

describe('GET /api/issues/:n/worktree/continue-existing-plan', () => {
  it('returns the read-only recovery plan before the POST', async () => {
    existingWorktreePlan.mockResolvedValue({
      ok: true,
      message: 'ready',
      plan: { branch: 'fix/issue-5015-existing', head: '24ad5071', commands: ['git worktree add ...'] },
    });
    const response = await fetch(`${base}/api/issues/5015/worktree/continue-existing-plan`);
    expect(response.status).toBe(200);
    expect(existingWorktreePlan).toHaveBeenCalledWith(5015);
    expect((await response.json()).plan.head).toBe('24ad5071');
  });
});
