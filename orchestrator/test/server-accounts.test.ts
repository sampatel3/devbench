import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer, listen } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Orchestrator } from '../src/orchestrator.js';
import type { AccountHealth } from '../src/accounts.js';

/**
 * The Settings tab's four routes over real HTTP: the verbs, the params, and the
 * fresh doctor report every write comes back with — that report is what makes the
 * tab show the truth without a second round trip. The orchestrator is never
 * polled here; these routes do not need it.
 */
type Reply = { ok: boolean; message: string; output?: string; accounts: AccountHealth[] };

let dir: string;
let canonical: string;
let accountsFile: string;
let linkScript: string;
let server: Server;
let base: string;

const call = async (path: string, method: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Reply };
};

const registry = () => JSON.parse(readFileSync(accountsFile, 'utf8')) as { default: string; accounts: unknown[] };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wc-srv-acct-'));
  canonical = join(dir, '.claude');
  mkdirSync(canonical, { recursive: true });
  accountsFile = join(dir, 'accounts.json');
  linkScript = join(dir, 'stub-link.sh');
  writeFileSync(linkScript, '#!/bin/sh\necho "ok   skills: linked $1/skills"\n', { mode: 0o755 });

  const cfg = loadConfig({
    PORT: '0',
    STATE_FILE: join(dir, 'state.json'),
    ACCOUNTS_FILE: accountsFile,
    CANONICAL_CLAUDE_DIR: canonical,
    LINK_ACCOUNT_SCRIPT: linkScript,
    POLL_MS: '999999',
  });
  server = await listen(createServer(cfg, new Orchestrator(cfg)), cfg);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('the account routes', () => {
  it('POST adds an account and replies with the fresh doctor report', async () => {
    const { status, body } = await call('/api/accounts', 'POST', { name: 'work', configDir: join(dir, '.claude-work') });
    expect(status).toBe(200);
    expect(body.accounts.map((a) => a.name)).toEqual(['personal', 'work']);
    expect(body.accounts[1]!.configDirExists).toBe(false); // adding creates no directory
    expect(registry().accounts).toHaveLength(2);
  });

  it('POST refuses a duplicate with 409 and changes nothing', async () => {
    await call('/api/accounts', 'POST', { name: 'work', configDir: '~/.claude-work' });
    const { status, body } = await call('/api/accounts', 'POST', { name: 'work', configDir: '~/.claude-other' });
    expect(status).toBe(409);
    expect(body.message).toContain('already an account');
    expect(registry().accounts).toHaveLength(2);
  });

  it('PUT moves the default', async () => {
    await call('/api/accounts', 'POST', { name: 'work', configDir: '~/.claude-work' });
    const { status, body } = await call('/api/accounts/default', 'PUT', { name: 'work' });
    expect(status).toBe(200);
    expect(registry().default).toBe('work');
    expect(body.accounts.find((a) => a.isDefault)!.name).toBe('work');
  });

  it('DELETE removes the entry by name, and no directory with it', async () => {
    const workDir = join(dir, '.claude-work');
    mkdirSync(workDir, { recursive: true });
    await call('/api/accounts', 'POST', { name: 'work', configDir: workDir });

    const { status, body } = await call('/api/accounts/work', 'DELETE');
    expect(status).toBe(200);
    expect(body.accounts.map((a) => a.name)).toEqual(['personal']);
    expect(existsSync(workDir)).toBe(true);
  });

  it('PUT /model sets that account default model, and an empty string clears it', async () => {
    await call('/api/accounts', 'POST', { name: 'work', configDir: '~/.claude-work' });

    const set = await call('/api/accounts/work/model', 'PUT', { model: 'claude-sonnet-5' });
    expect(set.status).toBe(200);
    expect(set.body.accounts.find((a) => a.name === 'work')!.model).toBe('claude-sonnet-5');
    expect(registry().accounts).toContainEqual({
      name: 'work',
      provider: 'claude',
      configDir: '~/.claude-work',
      model: 'claude-sonnet-5',
    });

    const cleared = await call('/api/accounts/work/model', 'PUT', { model: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.accounts.find((a) => a.name === 'work')!.model).toBeNull();
    // Cleared means the key is GONE, not written as null: this file is the operator's to read.
    expect(registry().accounts).toContainEqual({ name: 'work', provider: 'claude', configDir: '~/.claude-work' });
  });

  it('GET /api/metrics answers before anything has ever run, and says so', async () => {
    const res = await fetch(`${base}/api/metrics`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalRuns: number; cells: unknown[]; caveat: string };
    expect(body.totalRuns).toBe(0);
    expect(body.cells).toEqual([]);
    expect(body.caveat).toContain('Nothing has been logged yet');
  });

  it('POST /link runs the script for that account and returns its output', async () => {
    const workDir = join(dir, '.claude-work');
    await call('/api/accounts', 'POST', { name: 'work', configDir: workDir });

    const { status, body } = await call('/api/accounts/work/link', 'POST');
    expect(status).toBe(200);
    expect(body.output).toBe(`ok   skills: linked ${workDir}/skills`);
  });
});
