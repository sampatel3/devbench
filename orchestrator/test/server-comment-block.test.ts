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
const resolveCommentBlock = vi.fn();

function fakeOrch(): Orchestrator {
  return {
    state: () => ({ issues: [] }),
    on: vi.fn(),
    off: vi.fn(),
    resolveCommentBlock,
  } as unknown as Orchestrator;
}

beforeEach(async () => {
  resolveCommentBlock.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'wc-comment-block-route-'));
  const cfg = loadConfig({ STATE_FILE: join(dir, 'state.json'), PORT: '0', UI_DIR: join(dir, 'no-ui') });
  server = await listen(createServer(cfg, fakeOrch()), { ...cfg, port: 0 });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  fetch(`${base}/api/issues/4641/comment-block/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/issues/:n/comment-block/resolve', () => {
  it('requires the postedAt token from the block being dismissed', async () => {
    const response = await post({});
    expect(response.status).toBe(400);
    expect(resolveCommentBlock).not.toHaveBeenCalled();
  });

  it('passes the issue and stale-tab token to the narrow resolve method', async () => {
    resolveCommentBlock.mockResolvedValue({ ok: true, message: '#4641 block resolved' });
    const response = await post({ postedAt: '2026-08-15T14:24:43.636Z' });
    expect(response.status).toBe(200);
    expect(resolveCommentBlock).toHaveBeenCalledWith(4641, '2026-08-15T14:24:43.636Z');
  });

  it('returns conflict when the block changed or no longer exists', async () => {
    resolveCommentBlock.mockResolvedValue({ ok: false, message: 'the block changed' });
    const response = await post({ postedAt: '2026-08-15T14:24:43.636Z' });
    expect(response.status).toBe(409);
  });
});
