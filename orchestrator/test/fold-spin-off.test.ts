/**
 * Folding a drafted spin-off back into the issue that found it.
 *
 * The card had one exit: **File this issue**. But the skill's own rule is that
 * folding always wins: raising an issue off an issue off an issue helps nobody,
 * so folding the finding back into the original has to be on offer every time.
 * The console implemented only the filing half, so every drafted spin-off could
 * be agreed to or ignored, never absorbed.
 *
 * Fold writes NOTHING to GitHub. It marks the draft handled by the same
 * fingerprint filing uses — `.issue-request.json` is worker-owned and lingers
 * until the next resume, so without that the card comes straight back — and
 * resumes the worker with the instruction to do the work here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import * as resources from '../src/resources.js';
import { memoryOk } from './fixtures/memory.js';
import { foldPrompt } from '../src/fold.js';

let repo: string;
let worktree: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wc-fold-'));
  const git = (a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git(['init', '-b', 'dev']);
  git(['config', 'user.email', 'x@y.z']);
  git(['config', 'user.name', 'x']);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A']);
  git(['commit', '-m', 'init']);
  worktree = join(repo, '.worktrees', 'issue-4914-demo');
  git(['worktree', 'add', '-b', 'fix/issue-4914-demo', worktree, 'dev']);
  mkdirSync(join(worktree, 'docs'), { recursive: true });
  writeFileSync(
    join(worktree, '.issue-request.json'),
    JSON.stringify({
      // The worktree already identifies the base issue. A missing worker field
      // must not create an unlinked child or a misleading card.
      fromIssue: null,
      title: 'fix(product-config): the Version column always reads v1.0',
      labels: ['bug', 'area:product-config', 'env:dev'],
      identifiedHow: 'A sibling sweep found the same fixed version on the detail page.',
      relationship: 'Both surfaces read the same product version.',
      recommendation: 'fold',
      recommendationWhy: 'The same data path and fix belong in one PR.',
      draftBody: 'the whole issue body',
      requestedAt: '2026-08-19T09:00:00Z',
    }),
  );
  vi.spyOn(resources, 'probeResources').mockResolvedValue(memoryOk());
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function orch() {
  return new Orchestrator(
    loadConfig({ REPO_PATH: repo, REPO: 'example-org/example-repo', STATE_FILE: join(repo, 'state.json'), POLL_MS: '999999' }),
  );
}

describe('the brief a fold sends', () => {
  it('names the issue the work comes home to, and says not to file it', () => {
    const p = foldPrompt(4914, 'fix(product-config): the Version column always reads v1.0');
    expect(p).toContain('#4914');
    expect(p).toContain('the Version column always reads v1.0');
    expect(p).toMatch(/do not file/i);
  });

  /** Folding widens the PR, so the contract sections have to be redone rather
   *  than left describing the narrower change that was approved earlier. */
  it('tells the worker to redo the sweep and the affected-rows sections', () => {
    const p = foldPrompt(4914, 'anything');
    expect(p).toMatch(/sibling sweep/i);
    expect(p).toMatch(/affected rows/i);
  });
});

describe('folding a drafted spin-off', () => {
  it('uses the worktree issue as the authoritative base link', async () => {
    const o = orch();
    await o.start();
    const request = o.state().issues.find((r) => r.number === 4914)!.issueRequest!;
    expect(request.fromIssue).toBe(4914);
    expect(request.recommendation).toBe('fold');
    const prefilledBody = new URL(request.fileUrl).searchParams.get('body');
    expect(prefilledBody).toContain('Spun off from #4914.');
    expect(prefilledBody).toContain('**How it was identified:** A sibling sweep found');
    await o.stop();
  });

  it('writes nothing to GitHub and leaves the worker-owned file alone', async () => {
    const o = orch();
    await o.start();
    const rawBefore = readFileSync(join(worktree, '.issue-request.json'), 'utf8');

    const before = o.state().issues.find((r) => r.number === 4914)!;
    expect(before.issueRequest).not.toBeNull();

    const out = await o.foldSpinOff(4914);
    expect(out.ok).toBe(true);

    // The draft file belongs to the worker; the console never edits the worktree.
    expect(readFileSync(join(worktree, '.issue-request.json'), 'utf8')).toBe(rawBefore);

    // And the card is gone, so it cannot be filed by accident afterwards.
    const after = o.state().issues.find((r) => r.number === 4914)!;
    expect(after.issueRequest).toBeNull();
    await o.stop();
  });

  it('refuses when there is no drafted issue', async () => {
    const o = orch();
    await o.start();
    expect((await o.foldSpinOff(9999)).ok).toBe(false);
    await o.stop();
  });

  it('files with the authoritative base link even when the draft omitted it', async () => {
    const o = orch();
    await o.start();
    let filedBody = '';
    const out = await o.fileSpinOff(4914, async (args) => {
      const bodyFile = args[args.indexOf('--body-file') + 1]!;
      filedBody = readFileSync(bodyFile, 'utf8');
      return { code: 0, stdout: 'https://github.com/example-org/example-repo/issues/4999\n', stderr: '' };
    });
    expect(out.ok).toBe(true);
    expect(filedBody).toContain('Spun off from #4914.');
    expect(filedBody).toContain('**How it was identified:** A sibling sweep found');
    expect(filedBody).toContain('**How it relates to #4914:**');
    await o.stop();
  });

  /** Fold and File are mutually exclusive: once folded, filing it would raise the
   *  duplicate the fold exists to avoid. */
  it('refuses to file a draft that was folded', async () => {
    const o = orch();
    await o.start();
    await o.foldSpinOff(4914);
    const filed = await o.fileSpinOff(4914, async () => ({ code: 0, stdout: '', stderr: '' }));
    expect(filed.ok).toBe(false);
    expect(filed.message).toMatch(/folded/i);
    await o.stop();
  });
});
