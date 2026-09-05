/**
 * The workspace list the header's picker renders.
 *
 * The console is single-workspace today — `config.ts` carries one `repo` and one
 * `repoPath`, and nothing anywhere holds a list. A second workspace and Linear
 * tickets come later, so the CONTRACT is worth having now: the server says
 * which workspaces exist and which one is current, and the day a second one
 * appears the picker already renders it.
 *
 * What this deliberately does NOT do is ship a dropdown that silently does
 * nothing — the exact complaint that had the old Work sources panel deleted. The
 * list is what the server actually knows, never a placeholder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import * as resources from '../src/resources.js';
import { memoryOk } from './fixtures/memory.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wc-ws-'));
  execFileSync('git', ['init', '-b', 'dev'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'x@y.z'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'x'], { cwd: repo, stdio: 'ignore' });
  writeFileSync(join(repo, 'r.txt'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  vi.spyOn(resources, 'probeResources').mockResolvedValue(memoryOk());
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function orch(repoName: string) {
  return new Orchestrator(
    loadConfig({ REPO_PATH: repo, REPO: repoName, STATE_FILE: join(repo, 'state.json'), POLL_MS: '999999' }),
  );
}

describe('the workspace picker gets its list from the server', () => {
  it('reports the configured workspace, and reports it as the current one', () => {
    const s = orch('example-org/example-repo').state();
    expect(s.workspaces).toEqual(['example-org/example-repo']);
    expect(s.repo).toBe('example-org/example-repo');
  });

  /** Whatever REPO says — never a hardcoded 'example-repo' anywhere in the payload. */
  it('follows the configured repo rather than a baked-in name', () => {
    const s = orch('example-org/other-repo').state();
    expect(s.workspaces).toEqual(['example-org/other-repo']);
    expect(s.repo).toBe('example-org/other-repo');
  });

  /** The current workspace is always IN the list, or the picker would render a
   *  selection that is not one of its own options. */
  it('always includes the current workspace in the list', () => {
    const s = orch('example-org/example-repo').state();
    expect(s.workspaces).toContain(s.repo);
  });
});
