import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createServer, listen } from '../src/server.js';
import type { WorkSourceApi, WorkSourcesSnapshot } from '../src/sources.js';

const snapshot: WorkSourcesSnapshot = {
  sources: [
    {
      id: 'github',
      name: 'GitHub Issues',
      connected: true,
      account: 'ada',
      detail: '1 open issue assigned to Ada.',
      error: null,
      itemCount: 1,
      connectCommand: null,
      managedBy: 'gh',
    },
    {
      id: 'linear',
      name: 'Linear',
      connected: false,
      account: null,
      detail: 'Connect Linear.',
      error: null,
      itemCount: 0,
      connectCommand: null,
      managedBy: null,
    },
  ],
  items: [],
  refreshedAt: '2026-08-18T10:00:00Z',
};

let dir: string;
let server: Server;
let base: string;
let sources: WorkSourceApi;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wc-server-sources-'));
  sources = {
    snapshot: vi.fn(async () => snapshot),
    connectLinear: vi.fn(async () => snapshot),
    disconnectLinear: vi.fn(async () => snapshot),
  };
  const cfg = loadConfig({ PORT: '0', STATE_FILE: join(dir, 'state.json'), POLL_MS: '999999' });
  server = await listen(createServer(cfg, new Orchestrator(cfg), sources), cfg);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('work-source routes', () => {
  it('reads cached sources and refreshes them explicitly', async () => {
    expect(await (await fetch(`${base}/api/sources`)).json()).toEqual(snapshot);
    await fetch(`${base}/api/sources/refresh`, { method: 'POST' });
    expect(sources.snapshot).toHaveBeenNthCalledWith(1, false);
    expect(sources.snapshot).toHaveBeenNthCalledWith(2, true);
  });

  it('passes a Linear key only into the source service and never echoes it', async () => {
    const response = await fetch(`${base}/api/sources/linear`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'lin_secret' }),
    });
    expect(response.status).toBe(200);
    expect(sources.connectLinear).toHaveBeenCalledWith('lin_secret');
    expect(JSON.stringify(await response.json())).not.toContain('lin_secret');
  });

  it('disconnects Linear with an explicit DELETE', async () => {
    const response = await fetch(`${base}/api/sources/linear`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(sources.disconnectLinear).toHaveBeenCalledOnce();
  });

  it('turns a rejected key into a 400 with a usable message', async () => {
    vi.mocked(sources.connectLinear).mockRejectedValueOnce(new Error('Linear rejected that API key'));
    const response = await fetch(`${base}/api/sources/linear`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'wrong' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, message: 'Linear rejected that API key' });
  });
});

