import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer, listen } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Orchestrator } from '../src/orchestrator.js';
import type { SummaryPayload } from '../src/summary.js';
import * as gh from '../src/gh.js';

/**
 * GET /api/summary: the window is the whole input, so junk is a 400 rather than a
 * quietly-defaulted answer; a gh call that fails becomes a warning the post
 * carries, not a silently empty section; and repeated clicks inside the TTL are
 * served from the cache instead of asking GitHub again.
 */
let dir: string;
let server: Server;
let base: string;

async function serve(env: Record<string, string> = {}) {
  const cfg = loadConfig({ PORT: '0', STATE_FILE: join(dir, 'state.json'), POLL_MS: '999999', ...env });
  // Never polled: every gh call this test cares about is made by /api/summary.
  server = await listen(createServer(cfg, new Orchestrator(cfg)), cfg);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-summary-'));
  vi.spyOn(gh, 'listClosedIssues').mockResolvedValue([
    { number: 4103, title: 'STP Auto-Send Quote Resend Bug', url: 'u', closedAt: '2026-08-11T09:00:00Z' },
  ]);
  vi.spyOn(gh, 'listMergedPrs').mockResolvedValue([]);
  vi.spyOn(gh, 'listAuthoredOpenPrs').mockResolvedValue([]);
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('the window parameter', () => {
  it('answers for each of the three windows', async () => {
    await serve();
    for (const window of ['daily', 'weekly', 'monthly']) {
      const res = await fetch(`${base}/api/summary?window=${window}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SummaryPayload;
      expect(body.window).toBe(window);
      expect(body.markdown).toContain('Issues Closed');
      expect(Date.parse(body.generatedAt)).not.toBeNaN();
    }
  });

  it('400s on anything else, and on nothing at all', async () => {
    await serve();
    for (const query of ['?window=yearly', '?window=', '', '?window[]=daily']) {
      const res = await fetch(`${base}/api/summary${query}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain('daily, weekly or monthly');
    }
  });
});

describe('a fetch that fails', () => {
  it('becomes a warning and a section that says so, not an empty section', async () => {
    vi.mocked(gh.listMergedPrs).mockRejectedValue(new Error('HTTP 403: Bad credentials\nsecond line ignored'));
    await serve();

    const body = (await (await fetch(`${base}/api/summary?window=weekly`)).json()) as SummaryPayload;
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toBe('gh pr list --state merged: HTTP 403: Bad credentials');
    expect(body.markdown).toContain('PRs Merged\n• could not fetch — gh pr list --state merged: HTTP 403');
    // The sections that DID read are unaffected.
    expect(body.markdown).toContain('• #4103 — STP Auto-Send Quote Resend Bug');
  });
});

describe('the cache', () => {
  it('serves the same payload within the TTL, without asking GitHub again', async () => {
    await serve({ SUMMARY_TTL_MS: '60000' });

    const first = (await (await fetch(`${base}/api/summary?window=daily`)).json()) as SummaryPayload;
    const second = (await (await fetch(`${base}/api/summary?window=daily`)).json()) as SummaryPayload;

    expect(second).toEqual(first);
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(gh.listClosedIssues).toHaveBeenCalledTimes(1);
  });

  it('caches per window, so another window is built fresh', async () => {
    await serve({ SUMMARY_TTL_MS: '60000' });

    await fetch(`${base}/api/summary?window=daily`);
    await fetch(`${base}/api/summary?window=weekly`);
    expect(gh.listClosedIssues).toHaveBeenCalledTimes(2);
  });

  it('with no TTL, a second click asks again', async () => {
    await serve({ SUMMARY_TTL_MS: '0' });

    await fetch(`${base}/api/summary?window=daily`);
    await fetch(`${base}/api/summary?window=daily`);
    expect(gh.listClosedIssues).toHaveBeenCalledTimes(2);
  });
});
