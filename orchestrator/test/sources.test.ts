import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkSourceService, parseGithubItems, parseLinearItems } from '../src/sources.js';

const githubRows = JSON.stringify([
  {
    number: 42,
    title: 'Finish the export flow',
    url: 'https://github.com/acme/app/issues/42',
    updatedAt: '2026-08-18T08:00:00Z',
    repository: { nameWithOwner: 'acme/app' },
    labels: [{ name: 'P1' }, { name: 'feature' }],
  },
]);

const linearPayload = (hasNextPage = false) => ({
  data: {
    viewer: {
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
      assignedIssues: {
        nodes: [
          {
            id: 'issue-1',
            identifier: 'ENG-7',
            title: 'Ship the onboarding story',
            url: 'https://linear.app/acme/issue/ENG-7',
            priority: 2,
            updatedAt: '2026-08-18T09:00:00Z',
            state: { name: 'In Progress', type: 'started' },
            team: { name: 'Engineering', key: 'ENG' },
            project: { name: 'New user setup' },
            labels: { nodes: [{ name: 'frontend' }] },
          },
        ],
        pageInfo: { hasNextPage, endCursor: hasNextPage ? 'next' : null },
      },
    },
  },
});

describe('work-item normalisation', () => {
  it('gives GitHub items a provider-qualified identity', () => {
    expect(parseGithubItems(githubRows)).toEqual([
      expect.objectContaining({
        source: 'github',
        id: 'github:acme/app#42',
        key: 'acme/app#42',
        repository: 'acme/app',
        number: 42,
        labels: ['P1', 'feature'],
      }),
    ]);
  });

  it('keeps a Linear identifier non-numeric and maps its display fields', () => {
    const rows = linearPayload().data.viewer.assignedIssues.nodes;
    expect(parseLinearItems(rows)).toEqual([
      expect.objectContaining({
        source: 'linear',
        id: 'linear:issue-1',
        key: 'ENG-7',
        number: null,
        status: 'In Progress',
        priority: 'High',
        project: 'New user setup',
      }),
    ]);
  });
});

describe('provider discovery and credentials', () => {
  it('discovers assigned GitHub and Linear work without ever returning the Linear key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-sources-'));
    const file = join(dir, 'connections.json');
    const command = async (_file: string, args: string[]) =>
      args[0] === 'api' ? JSON.stringify({ login: 'ada', name: 'Ada Lovelace' }) : githubRows;
    const http = async () => new Response(JSON.stringify(linearPayload()), { status: 200 });
    const service = new WorkSourceService({ credentialsFile: file, command, fetch: http as typeof fetch });

    const snapshot = await service.connectLinear('lin_api_secret');
    expect(snapshot.sources).toEqual([
      expect.objectContaining({ id: 'github', connected: true, account: 'ada', itemCount: 1 }),
      expect.objectContaining({ id: 'linear', connected: true, account: 'Ada', itemCount: 1, managedBy: 'file' }),
      // Sentry is a third source now, and an unconnected one has to be REPORTED
      // rather than absent: the chip is what tells them it exists and is off.
      expect.objectContaining({ id: 'sentry', connected: false, itemCount: 0, managedBy: null }),
    ]);
    expect(snapshot.items.map((item) => item.id)).toEqual(['linear:issue-1', 'github:acme/app#42']);
    expect(JSON.stringify(snapshot)).not.toContain('lin_api_secret');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('lin_api_secret');

    rmSync(dir, { recursive: true, force: true });
  });

  it('validates a Linear key before replacing the local connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-sources-bad-'));
    const file = join(dir, 'connections.json');
    const service = new WorkSourceService({
      credentialsFile: file,
      command: async () => {
        throw new Error('no github login');
      },
      fetch: (async () =>
        new Response(JSON.stringify({ errors: [{ message: 'Authentication required' }] }), { status: 200 })) as typeof fetch,
    });

    await expect(service.connectLinear('wrong-key')).rejects.toThrow('Authentication required');
    expect(() => readFileSync(file, 'utf8')).toThrow();

    rmSync(dir, { recursive: true, force: true });
  });

  it('redacts Linear credentials from transport errors and rejects header controls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-sources-redact-'));
    const secret = 'lin_api_do_not_echo';
    const service = new WorkSourceService({
      credentialsFile: join(dir, 'connections.json'),
      command: async () => {
        throw new Error('no github login');
      },
      fetch: (async () => {
        throw new Error(`request rejected Authorization: ${secret}`);
      }) as typeof fetch,
    });

    await expect(service.connectLinear(secret)).rejects.toThrow('Authorization: [redacted]');
    await expect(service.connectLinear(`${secret}\nsecond-header`)).rejects.toThrow('invalid characters');
    try {
      await service.connectLinear(secret);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }

    rmSync(dir, { recursive: true, force: true });
  });

  it('does not let an older in-flight refresh overwrite a newly connected source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-sources-race-'));
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let profileCalls = 0;
    const service = new WorkSourceService({
      credentialsFile: join(dir, 'connections.json'),
      command: async (_file, args) => {
        if (args[0] === 'api') {
          profileCalls += 1;
          if (profileCalls === 1) {
            enterFirst();
            await firstRelease;
          }
          return JSON.stringify({ login: 'ada', name: 'Ada' });
        }
        return githubRows;
      },
      fetch: (async () => new Response(JSON.stringify(linearPayload()), { status: 200 })) as typeof fetch,
    });

    const oldRefresh = service.snapshot(true);
    await firstEntered;
    const connected = await service.connectLinear('lin_api_new_connection');
    expect(connected.sources.find((source) => source.id === 'linear')?.connected).toBe(true);

    releaseFirst();
    const oldResponse = await oldRefresh;
    expect(oldResponse.sources.find((source) => source.id === 'linear')?.connected).toBe(true);
    const cached = await service.snapshot(false);
    expect(cached.sources.find((source) => source.id === 'linear')?.connected).toBe(true);
    expect(profileCalls).toBe(2);

    rmSync(dir, { recursive: true, force: true });
  });

  it('gives every Linear request an abort timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-sources-timeout-'));
    let signal: AbortSignal | null = null;
    const service = new WorkSourceService({
      credentialsFile: join(dir, 'connections.json'),
      linearApiKey: 'from-env',
      requestTimeoutMs: 10,
      command: async () => {
        throw new Error('no github login');
      },
      fetch: ((_url, init) => {
        signal = init?.signal instanceof AbortSignal ? init.signal : null;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
        });
      }) as typeof fetch,
    });

    const snapshot = await service.snapshot(true);
    expect(signal).not.toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(snapshot.sources.find((source) => source.id === 'linear')).toEqual(
      expect.objectContaining({ connected: false, error: expect.any(String) }),
    );

    rmSync(dir, { recursive: true, force: true });
  });

  it('paginates Linear assignments but caps the inbox at two API pages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-sources-pages-'));
    let calls = 0;
    const service = new WorkSourceService({
      credentialsFile: join(dir, 'connections.json'),
      linearApiKey: 'from-env',
      command: async () => {
        throw new Error('no github login');
      },
      fetch: (async () => {
        calls += 1;
        return new Response(JSON.stringify(linearPayload(true)), { status: 200 });
      }) as typeof fetch,
    });

    const snapshot = await service.snapshot(true);
    expect(calls).toBe(2);
    expect(snapshot.sources.find((source) => source.id === 'linear')).toEqual(
      expect.objectContaining({ connected: true, managedBy: 'environment' }),
    );

    rmSync(dir, { recursive: true, force: true });
  });

  it('will not pretend an environment-managed Linear connection was disconnected', async () => {
    const service = new WorkSourceService({ credentialsFile: '/unused/connections.json', linearApiKey: 'from-env' });
    await expect(service.disconnectLinear()).rejects.toThrow('managed by LINEAR_API_KEY');
  });
});
