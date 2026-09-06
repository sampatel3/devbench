import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { codexHooksJson } from '../src/fence.js';
import * as gh from '../src/gh.js';
import { Orchestrator } from '../src/orchestrator.js';
import { pidAlive } from '../src/reattach.js';
import * as resources from '../src/resources.js';
import type { ResourceReport } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const STUB_CODEX = join(here, 'fixtures', 'stub-codex.mjs');
const ISSUE = 4336;
const THREAD = '019-codex-orchestrator-parity';

let repo: string;
let worktree: string;
let home: string;
let canonicalClaude: string;
let codexHome: string;
let accountsFile: string;
let stateFile: string;
let current: Orchestrator | null;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function persisted(): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, Record<string, unknown>>;
}

/**
 * The gate C capture, landed on disk.
 *
 * The console takes the screenshots itself on the poll that first sees a gate C
 * stop, and files what happened under `captures` — so the state file gains a key
 * on the console's own account, some time after the row has settled at the gate.
 * Every byte-for-byte snapshot in this file has to let that land first, or it
 * fences the capture instead of the mutation it was written to catch. Keyed on
 * the gate file's bytes, so it happens once and then stays put.
 */
const captureLanded = (): boolean => persisted().captures?.[String(ISSUE)] !== undefined;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wc-orch-codex-home-')));
  canonicalClaude = join(home, '.claude');
  codexHome = join(home, '.codex-worker');
  mkdirSync(canonicalClaude, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  // The orchestrator's real Codex adapter validates this exact document before
  // both start and resume. A shape-only test would bypass the production fence.
  writeFileSync(join(codexHome, 'hooks.json'), codexHooksJson());

  accountsFile = join(home, 'accounts.json');
  stateFile = join(home, 'state.json');
  writeFileSync(
    accountsFile,
    JSON.stringify({
      default: 'personal',
      accounts: [
        { name: 'personal', provider: 'claude', configDir: canonicalClaude },
        { name: 'codex-work', provider: 'codex', configDir: codexHome, model: 'gpt-5.6-sol' },
      ],
    }),
  );

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'wc-orch-codex-repo-')));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  worktree = join(repo, '.worktrees', `issue-${ISSUE}-demo`);
  git(['worktree', 'add', '-b', `fix/issue-${ISSUE}-demo`, worktree, 'dev'], repo);

  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    {
      number: ISSUE,
      title: 'Codex orchestrator parity',
      url: 'u',
      labels: ['feature'],
      updatedAt: 'z',
      author: 'operator',
    },
  ]);
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  vi.spyOn(gh, 'listAuthoredOpenPrs').mockResolvedValue([]);
  vi.spyOn(resources, 'probeResources').mockResolvedValue({
    ok: true,
    reason: 'memory ok',
    freePct: 90,
    headroomBytes: 0,
    headroomLabel: '9 GB',
    minFreePct: 12,
    footprintBytes: 0,
    footprintLabel: '0 GB',
    ceilingBytes: 1,
    ceilingLabel: '1 GB',
    totalBytes: 2,
    edgeRuntimeLabel: null,
    checkedAt: new Date().toISOString(),
  } as ResourceReport);

  process.env.STUB_CODEX_THREAD = THREAD;
  current = null;
});

afterEach(async () => {
  delete process.env.STUB_CODEX_THREAD;
  delete process.env.STUB_WAIT_FOR;
  await current?.stop();
  current = null;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function orchestrator(): Orchestrator {
  current = new Orchestrator(
    loadConfig({
      REPO: 'example-org/example-repo',
      REPO_PATH: repo,
      STATE_FILE: stateFile,
      ACCOUNTS_FILE: accountsFile,
      CANONICAL_CLAUDE_DIR: canonicalClaude,
      CANONICAL_CODEX_DIR: join(home, '.codex'),
      CODEX_BIN: STUB_CODEX,
      CODEX_WORKER_MODEL: 'gpt-5.6-sol',
      CODEX_SANDBOX: 'danger-full-access',
      STREAM_POLL_MS: '20',
      POLL_MS: '999999',
    }),
  );
  return current;
}

const gateFile = () => join(worktree, '.gate.json');
const row = (o: Orchestrator) => o.state().issues.find((issue) => issue.number === ISSUE)!;

describe('Codex through the orchestrator', () => {
  it('rejects a known Claude model for a Codex profile before it stamps any identity', async () => {
    const o = orchestrator();
    await o.start();

    const out = o.enqueue(ISSUE, 'codex-work', 'claude-opus-5');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('Claude model');
    expect(row(o).account).toBeNull();
    expect(row(o).provider).toBe('claude');

    const accountDefault = await o.setAccountModel('codex-work', 'claude-sonnet-5');
    expect(accountDefault.ok).toBe(false);
    expect(accountDefault.message).toContain('cannot run under Codex profile');
  });

  it('normalizes a foreign stored account default to the Codex console default', async () => {
    const registry = JSON.parse(readFileSync(accountsFile, 'utf8')) as {
      accounts: Array<{ name: string; model?: string }>;
    };
    registry.accounts.find((account) => account.name === 'codex-work')!.model = 'claude-opus-5';
    writeFileSync(accountsFile, JSON.stringify(registry));

    const o = orchestrator();
    await o.start();
    expect(o.state().accounts.find((account) => account.name === 'codex-work')?.model).toBeNull();

    expect(o.enqueue(ISSUE, 'codex-work').ok).toBe(true);
    await waitFor('Codex to write a gate with its normalized default', () => existsSync(gateFile()));
    const rawGate = JSON.parse(readFileSync(gateFile(), 'utf8')) as Record<string, unknown>;
    expect(rawGate.model_arg).toBe('gpt-5.6-sol');
  });

  it('selects the Codex profile/model, persists its learned thread, gates, and resumes that same thread', async () => {
    const o = orchestrator();
    await o.start();

    const before = o.state();
    expect(before.accounts.map(({ name, provider }) => ({ name, provider }))).toEqual([
      { name: 'personal', provider: 'claude' },
      { name: 'codex-work', provider: 'codex' },
    ]);
    expect(before.defaultsByProvider).toEqual({ claude: 'claude-opus-5', codex: 'gpt-5.6-sol' });
    expect(before.models.some((model) => model.provider === 'codex' && model.id === 'gpt-5.6-terra')).toBe(true);
    expect(row(o).provider).toBe('claude');

    expect(o.enqueue(ISSUE, 'codex-work', 'gpt-5.6-terra')).toEqual({ ok: true, message: `#${ISSUE} queued` });
    await waitFor('Codex to write Gate C', () => existsSync(gateFile()));
    await waitFor('the orchestrator row to settle at Gate C', () => row(o).status === 'at-gate');

    const rawGate = JSON.parse(readFileSync(gateFile(), 'utf8')) as Record<string, unknown>;
    expect(rawGate.prompt).toContain(`$issue-pipeline ${ISSUE}`);
    expect(rawGate.env_codex_home).toBe(codexHome);
    expect(rawGate.model_arg).toBe('gpt-5.6-terra');
    expect(rawGate.provider_thread_id).toBe(THREAD);

    const atGate = row(o);
    expect(atGate.provider).toBe('codex');
    expect(atGate.account).toBe('codex-work');
    expect(atGate.accountLocked).toBe(true);
    expect(atGate.model).toBe('gpt-5.6-terra');
    expect(atGate.modelResolved).toBe('gpt-5.6-terra');
    expect(atGate.gate?.gate).toBe('C');
    expect(atGate.resumeCommand).toContain(THREAD);

    await waitFor('the Codex run provenance to reach metrics', () => existsSync(join(home, 'runs.jsonl')));
    const report = await o.metrics();
    const cell = report.cells.find(
      (candidate) => candidate.provider === 'codex' && candidate.model === 'gpt-5.6-terra' && candidate.segment === 'C',
    );
    expect(cell).toMatchObject({
      accounts: ['codex-work'],
      sessions: [THREAD],
      medianOutputTokens: 11,
      medianReasoningOutputTokens: 2,
      medianCostUsd: null,
    });

    await waitFor('the learned Codex thread to reach state.json', () => {
      try {
        return persisted().agentSessions?.[String(ISSUE)] === THREAD;
      } catch {
        return false;
      }
    });
    const saved = persisted();
    expect(saved.providerByIssue?.[String(ISSUE)]).toBe('codex');
    expect(saved.accountByIssue?.[String(ISSUE)]).toBe('codex-work');
    expect(saved.modelByIssue?.[String(ISSUE)]).toBe('gpt-5.6-terra');
    expect(saved.agentSessions?.[String(ISSUE)]).toBe(THREAD);

    const resumed = await o.resume(ISSUE, 'Gate C approved, proceed.');
    expect(resumed).toEqual({ ok: true, message: `resumed #${ISSUE}` });
    const resumeFile = join(worktree, 'resumed-codex.txt');
    await waitFor('the Codex resume to finish', () => existsSync(resumeFile));
    await waitFor('the resumed run to settle', () => o.state().activeCount === 0);
    const resumeRecord = readFileSync(resumeFile, 'utf8');
    expect(resumeRecord).toContain(`thread: ${THREAD}`);
    expect(resumeRecord).toContain(`codex home: ${codexHome}`);
    expect(resumeRecord).toContain('model: gpt-5.6-terra');
    expect(persisted().agentSessions?.[String(ISSUE)]).toBe(THREAD);
  });

  it('refuses restart-fresh before changing the gate or session when the Codex profile is no longer fenced', async () => {
    const o = orchestrator();
    await o.start();
    expect(o.enqueue(ISSUE, 'codex-work', 'gpt-5.6-sol').ok).toBe(true);
    await waitFor('Codex to stop at its gate', () => row(o).status === 'at-gate' && o.state().activeCount === 0);
    await waitFor('the learned Codex thread to be saved', () => persisted().agentSessions?.[String(ISSUE)] === THREAD);

    await waitFor('the gate C capture to land on disk', captureLanded);

    writeFileSync(join(codexHome, 'hooks.json'), '{}\n');
    const gateBefore = readFileSync(gateFile(), 'utf8');
    const stateBefore = readFileSync(stateFile, 'utf8');
    const rowBefore = row(o);

    const out = await o.restartFresh(ISSUE, 'codex-work', 'gpt-5.6-terra');

    expect(out.ok).toBe(false);
    expect(out.message).toContain("Codex profile 'codex-work' is not ready");
    expect(out.message).toContain('does not match the Worker Console policy');
    expect(readFileSync(gateFile(), 'utf8')).toBe(gateBefore);
    expect(readFileSync(stateFile, 'utf8')).toBe(stateBefore);
    expect(row(o)).toMatchObject({
      sessionId: rowBefore.sessionId,
      account: 'codex-work',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      status: 'at-gate',
    });
  });

  it('refuses immediate questions and decisions without mutating any actionable gate artifact', async () => {
    const first = orchestrator();
    await first.start();
    expect(first.enqueue(ISSUE, 'codex-work', 'gpt-5.6-sol').ok).toBe(true);
    await waitFor('Codex to stop at its gate', () => row(first).status === 'at-gate' && first.state().activeCount === 0);
    await waitFor('the learned Codex thread to be saved', () => persisted().agentSessions?.[String(ISSUE)] === THREAD);
    await first.stop();
    current = null;

    // Seed every artifact an immediate resume used to mutate before the adapter
    // discovered that its profile was unsafe: an unanswered exchange, a comment
    // block, an actionable review round, and the append-only decision ledger.
    const key = String(ISSUE);
    const seeded = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, Record<string, unknown>>;
    seeded.gateThreads[key] = {
      gate: 'C',
      entries: [
        {
          id: 1,
          question: 'Which edge case is still open?',
          askedAt: '2026-08-18T10:00:00.000Z',
          answer: null,
          answeredAt: null,
          supersededAt: null,
        },
      ],
      pendingAskIds: [],
      violation: null,
      closedAt: null,
      stoppedAt: '2026-08-18T09:59:00.000Z',
    };
    seeded.commentBlocks[key] = {
      addressee: '@reviewer',
      onIssue: ISSUE,
      postedAt: '2026-08-18T09:00:00.000Z',
      commentUrl: 'https://example.test/comment',
      reply: null,
    };
    seeded.reviewBlocks[key] = {
      pr: 7336,
      rounds: [
        {
          round: 1,
          reviewer: 'reviewer',
          requestedAt: '2026-08-18T09:30:00.000Z',
          requestedChanges: 'Keep the gate intact.',
          decision: null,
          resumedAt: null,
        },
      ],
    };
    writeFileSync(stateFile, JSON.stringify(seeded, null, 2));
    const decisionsFile = join(home, 'decisions.jsonl');
    writeFileSync(
      decisionsFile,
      `${JSON.stringify({
        issue: 999,
        gate: 'A',
        decision: 'approved',
        message: 'existing decision',
        at: '2026-08-17T00:00:00.000Z',
        sessionId: 'existing-session',
        account: 'personal',
        qa: null,
        head: null,
        unanswered: [],
      })}\n`,
    );

    const second = orchestrator();
    await second.start();
    await waitFor('the startup metrics snapshot to settle on disk', () => {
      try {
        return (persisted().metricsSnapshot as { totalRuns?: number } | undefined)?.totalRuns === 1;
      } catch {
        return false;
      }
    });
    const actionableBefore = structuredClone({
      gateThread: row(second).gateThread,
      commentBlock: row(second).commentBlock,
      reviewBlock: row(second).reviewBlock,
    });
    await waitFor('the gate C capture to land on disk', captureLanded);
    writeFileSync(join(codexHome, 'hooks.json'), '{}\n');
    const gateBefore = readFileSync(gateFile(), 'utf8');
    const stateBefore = readFileSync(stateFile, 'utf8');
    const decisionsBefore = readFileSync(decisionsFile, 'utf8');

    const asked = await second.ask(ISSUE, 'Can you explain the remaining risk?');
    const decided = await second.resume(ISSUE, 'Gate C approved, proceed.');

    expect(asked.ok).toBe(false);
    expect(asked.message).toContain("Codex profile 'codex-work' is not ready");
    expect(decided.ok).toBe(false);
    expect(decided.message).toContain("Codex profile 'codex-work' is not ready");
    expect(readFileSync(gateFile(), 'utf8')).toBe(gateBefore);
    expect(readFileSync(stateFile, 'utf8')).toBe(stateBefore);
    expect(readFileSync(decisionsFile, 'utf8')).toBe(decisionsBefore);
    expect({
      gateThread: row(second).gateThread,
      commentBlock: row(second).commentBlock,
      reviewBlock: row(second).reviewBlock,
    }).toEqual(actionableBefore);
    expect(second.state().activeCount).toBe(0);
  });

  it('keeps a held question byte-exact and queued when dispatch finds an unsafe Codex profile', async () => {
    const first = orchestrator();
    await first.start();
    expect(first.enqueue(ISSUE, 'codex-work', 'gpt-5.6-sol').ok).toBe(true);
    await waitFor('Codex to stop at its gate', () => row(first).status === 'at-gate' && first.state().activeCount === 0);
    await waitFor('the learned Codex thread to be saved', () => persisted().agentSessions?.[String(ISSUE)] === THREAD);
    await first.stop();
    current = null;

    const key = String(ISSUE);
    const heldPrompt = 'GATE C QUESTION — answer without advancing\n\n1. Is the fence still intact?';
    const seeded = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, Record<string, unknown>>;
    seeded.pendingResume[key] = heldPrompt;
    seeded.gateThreads[key] = {
      gate: 'C',
      entries: [
        {
          id: 1,
          question: 'Is the fence still intact?',
          askedAt: '2026-08-18T11:00:00.000Z',
          answer: null,
          answeredAt: null,
          supersededAt: null,
        },
      ],
      pendingAskIds: [1],
      violation: null,
      closedAt: null,
      stoppedAt: '2026-08-18T10:59:00.000Z',
    };
    writeFileSync(stateFile, JSON.stringify(seeded, null, 2));
    const decisionsFile = join(home, 'decisions.jsonl');
    writeFileSync(decisionsFile, '{"sentinel":"unchanged"}\n');
    writeFileSync(join(codexHome, 'hooks.json'), '{}\n');

    const second = orchestrator();
    await second.start();
    await waitFor('the startup metrics snapshot to settle on disk', () => {
      try {
        return (persisted().metricsSnapshot as { totalRuns?: number } | undefined)?.totalRuns === 1;
      } catch {
        return false;
      }
    });
    await waitFor('the gate C capture to land on disk', captureLanded);
    const gateBefore = readFileSync(gateFile(), 'utf8');
    const stateBefore = readFileSync(stateFile, 'utf8');
    const decisionsBefore = readFileSync(decisionsFile, 'utf8');

    // Dispatch already refused once during startup. Run the ordinary resource
    // tick after the byte snapshot to prove every subsequent retry is equally
    // non-consuming while the profile remains broken.
    await second.resourceTick();

    expect(second.state().activeCount).toBe(0);
    expect(second.state().queue).toContain(ISSUE);
    expect(second.state().dispatchReason).toContain("Codex profile 'codex-work' is not ready");
    expect(readFileSync(gateFile(), 'utf8')).toBe(gateBefore);
    expect(readFileSync(stateFile, 'utf8')).toBe(stateBefore);
    expect(readFileSync(decisionsFile, 'utf8')).toBe(decisionsBefore);
    expect(persisted().pendingResume?.[key]).toBe(heldPrompt);
    expect((persisted().gateThreads?.[key] as { pendingAskIds: number[] }).pendingAskIds).toEqual([1]);
    expect(existsSync(join(worktree, 'resumed-codex.txt'))).toBe(false);
  });

  it('leaves a live Codex process running and reattaches to it after a console restart', async () => {
    const release = join(home, 'release-codex-worker');
    process.env.STUB_WAIT_FOR = release;
    const first = orchestrator();
    await first.start();
    expect(first.enqueue(ISSUE, 'codex-work', 'gpt-5.6-sol').ok).toBe(true);
    await waitFor('the Codex process to start', () => first.state().activeCount === 1);
    await waitFor('the Codex thread to be persisted', () => {
      try {
        return persisted().agentSessions?.[String(ISSUE)] === THREAD;
      } catch {
        return false;
      }
    });

    expect(await first.stop()).toEqual({ leftRunning: 1 });
    current = null;

    const second = orchestrator();
    const recovery = await second.start();
    expect(recovery).toEqual({ reattached: [ISSUE], reconciled: [] });
    expect(row(second).provider).toBe('codex');
    expect(row(second).live?.reattached).toBe(true);
    expect(row(second).resumeCommand).toContain(THREAD);

    writeFileSync(release, 'continue');
    await waitFor('the reattached worker to reach Gate C', () => row(second).status === 'at-gate');
    expect(row(second).gate?.gate).toBe('C');
    expect(persisted().agentSessions?.[String(ISSUE)]).toBe(THREAD);
  });

  it('reconciles a Codex turn that reached its gate while the console was down', async () => {
    const release = join(home, 'finish-while-down');
    process.env.STUB_WAIT_FOR = release;
    const first = orchestrator();
    await first.start();
    expect(first.enqueue(ISSUE, 'codex-work', 'gpt-5.6-sol').ok).toBe(true);
    await waitFor('the Codex worker row', () => {
      try {
        return persisted().runningRuns?.[String(ISSUE)] !== undefined;
      } catch {
        return false;
      }
    });
    const pid = Number((persisted().runningRuns?.[String(ISSUE)] as Record<string, unknown>).pid);
    expect(await first.stop()).toEqual({ leftRunning: 1 });
    current = null;

    writeFileSync(release, 'finish');
    await waitFor('the unattended Codex gate', () => existsSync(gateFile()));
    await waitFor('the unattended Codex process to exit', () => !pidAlive(pid));

    const second = orchestrator();
    const recovery = await second.start();
    expect(recovery).toEqual({ reattached: [], reconciled: [ISSUE] });
    expect(row(second).provider).toBe('codex');
    expect(row(second).status).toBe('at-gate');
    expect(row(second).gate?.gate).toBe('C');
    expect(row(second).live).toBeNull();
  });
});
