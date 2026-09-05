import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer, listen } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Orchestrator } from '../src/orchestrator.js';

/**
 * The stale-bundle problem, and why this route reads the file exactly once.
 *
 * `npm run build` overwrites `ui/dist` under a console that is already running.
 * The browser then loads a NEW page that talks to the OLD API it was not built
 * for; nothing errors, the buttons just quietly do nothing — which is what
 * happened to the operator's Approve button. The page carries its build id, the server
 * reports the id it STARTED with, and the mismatch becomes a banner.
 *
 * Re-reading the file per request would report the newly built id and the
 * mismatch would disappear exactly when it matters, so the test that matters
 * here is the second one.
 */
let dir: string;
let uiDir: string;
let server: Server;
let base: string;

async function serve(env: Record<string, string> = {}) {
  const cfg = loadConfig({ PORT: '0', STATE_FILE: join(dir, 'state.json'), POLL_MS: '999999', ...env });
  server = await listen(createServer(cfg, new Orchestrator(cfg)), cfg);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const version = async () => (await (await fetch(`${base}/api/version`)).json()) as { buildId: string | null };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-version-'));
  uiDir = join(dir, 'dist');
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html>');
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/version', () => {
  it('reports the build id of the UI the console started with', async () => {
    writeFileSync(join(uiDir, 'build-id.txt'), '2026-08-11T17:00:00.000Z\n');
    await serve({ UI_DIR: uiDir });

    expect((await version()).buildId).toBe('2026-08-11T17:00:00.000Z');
  });

  // The whole point: a rebuild under a running console must still report the
  // old id, because that IS the mismatch the page has to notice.
  it('keeps reporting the OLD id after ui/dist is rebuilt underneath it', async () => {
    writeFileSync(join(uiDir, 'build-id.txt'), '2026-08-11T17:00:00.000Z\n');
    await serve({ UI_DIR: uiDir });

    writeFileSync(join(uiDir, 'build-id.txt'), '2026-08-11T18:30:00.000Z\n');
    expect((await version()).buildId).toBe('2026-08-11T17:00:00.000Z');
  });

  it('reports null when there is no built UI to compare against', async () => {
    await serve({ UI_DIR: uiDir }); // index.html, but no build-id.txt
    expect((await version()).buildId).toBeNull();
  });
});
