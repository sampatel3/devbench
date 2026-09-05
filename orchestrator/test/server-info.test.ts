import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer, listen } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Orchestrator } from '../src/orchestrator.js';

/**
 * GET /api/info hands over `docs/INFO.md` — the console's own manual — read at
 * request time so an edit shows up on the next refresh. Nothing is cached and
 * nothing else is served from this route.
 */
let dir: string;
let server: Server;
let base: string;

async function serve(infoFile: string) {
  const cfg = loadConfig({ PORT: '0', INFO_FILE: infoFile, STATE_FILE: join(dir, 'state.json'), POLL_MS: '999999' });
  // The route reads the file itself; the orchestrator is never polled here.
  server = await listen(createServer(cfg, new Orchestrator(cfg)), cfg);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-info-'));
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/info', () => {
  it('returns the markdown file as { markdown }', async () => {
    const file = join(dir, 'INFO.md');
    writeFileSync(file, '# How this works\n\n## The map\n\nissue → worker → PR → merged.\n');
    await serve(file);

    const res = await fetch(`${base}/api/info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { markdown: string };
    expect(body.markdown).toContain('## The map');
    expect(body.markdown).toContain('issue → worker → PR → merged.');
  });

  it('re-reads the file on every request, so an edit shows up on refresh', async () => {
    const file = join(dir, 'INFO.md');
    writeFileSync(file, '## Before\n');
    await serve(file);

    expect(((await (await fetch(`${base}/api/info`)).json()) as { markdown: string }).markdown).toContain('## Before');
    writeFileSync(file, '## After\n');
    const second = (await (await fetch(`${base}/api/info`)).json()) as { markdown: string };
    expect(second.markdown).toContain('## After');
    expect(second.markdown).not.toContain('## Before');
  });

  it('404s when there is no manual to serve', async () => {
    const missing = join(dir, 'nope.md');
    await serve(missing);

    const res = await fetch(`${base}/api/info`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain(missing);
  });
});

/** The shipped manual is the deliverable, so its nine sections are asserted. */
describe('docs/INFO.md', () => {
  it('carries all nine sections', () => {
    const markdown = readFileSync(loadConfig({}).infoFile, 'utf8');
    for (const heading of [
      '## The map',
      '## The GitHub issue lifecycle',
      '## The worker',
      '## The nine stages and five gates',
      '## The review layer',
      '## The status summary',
      '## What the console will and will not touch',
      '## Claude accounts',
      '## Porting this to a new project',
    ]) {
      expect(markdown).toContain(heading);
    }
  });
});
