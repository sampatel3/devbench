import { execFile } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexHooksJson, validateCodexHooksJson, WRITE_FENCE_HOOK } from '../src/fence.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'scripts', 'link-account.sh');

type Result = { code: number; stdout: string; stderr: string };

function runLink(
  args: string[],
  canonical: string,
  withCodexEnv = false,
  canonicalCodex = join(dirname(canonical), 'interactive-codex'),
): Promise<Result> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CANONICAL_CLAUDE_DIR: canonical,
    CANONICAL_CODEX_DIR: canonicalCodex,
  };
  delete env.WORKER_NODE_BIN;
  delete env.WORKER_WRITE_FENCE_HOOK;
  if (withCodexEnv) {
    env.WORKER_NODE_BIN = process.execPath;
    env.WORKER_WRITE_FENCE_HOOK = WRITE_FENCE_HOOK;
  }

  return new Promise((resolve) => {
    execFile(SCRIPT, args, { env, timeout: 15_000 }, (error, stdout, stderr) => {
      const errorCode = (error as { code?: unknown } | null)?.code;
      resolve({
        code: error ? (typeof errorCode === 'number' ? errorCode : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

describe('link-account.sh provider contracts', () => {
  let root: string;
  let canonical: string;
  let target: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wc-link-account-'));
    canonical = join(root, 'canonical-claude');
    target = join(root, 'worker-home');
    mkdirSync(join(canonical, 'skills'), { recursive: true });
    writeFileSync(join(canonical, 'CLAUDE.md'), '# Canonical instructions\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keeps the original one-argument Claude contract unchanged', async () => {
    const result = await runLink([target], canonical);

    expect(result.code).toBe(0);
    expect(readlinkSync(join(target, 'skills'))).toBe(join(canonical, 'skills'));
    expect(readlinkSync(join(target, 'CLAUDE.md'))).toBe(join(canonical, 'CLAUDE.md'));
    expect(existsSync(join(target, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(target, 'hooks.json'))).toBe(false);
    expect(result.stdout).toContain(`CLAUDE_CONFIG_DIR=${target} claude /login`);
  });

  it('keeps Claude conflict reporting non-destructive and backward-compatible', async () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'CLAUDE.md'), '# Local instructions\n');

    const result = await runLink([target], canonical);

    // The legacy script reported a conflict but returned success; callers may
    // already depend on that behavior, so only the new Codex mode is strict.
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/STOP CLAUDE\.md.*refusing to replace/);
    expect(readFileSync(join(target, 'CLAUDE.md'), 'utf8')).toBe('# Local instructions\n');
  });

  it('links Codex skills/instructions and writes the exact owned hooks.json', async () => {
    const result = await runLink(['codex', target], canonical, true);

    expect(result.code).toBe(0);
    expect(lstatSync(join(target, 'skills')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(target, 'skills'))).toBe(join(canonical, 'skills'));
    expect(lstatSync(join(target, 'AGENTS.md')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(target, 'AGENTS.md'))).toBe(join(canonical, 'CLAUDE.md'));

    const rawHooks = readFileSync(join(target, 'hooks.json'), 'utf8');
    expect(rawHooks).toBe(codexHooksJson(WRITE_FENCE_HOOK, process.execPath));
    expect(validateCodexHooksJson(rawHooks, WRITE_FENCE_HOOK, process.execPath)).toBe(true);
    expect(statSync(join(target, 'hooks.json')).mode & 0o077).toBe(0);
    expect(result.stdout).toContain(`CODEX_HOME=${target} codex login`);
  });

  it('is idempotent only for the exact links and owned hooks document', async () => {
    const first = await runLink(['codex', target], canonical, true);
    const original = readFileSync(join(target, 'hooks.json'), 'utf8');
    const second = await runLink(['codex', target], canonical, true);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('already linked');
    expect(second.stdout).toContain('already the Worker Console hook document');
    expect(readFileSync(join(target, 'hooks.json'), 'utf8')).toBe(original);
  });

  it('never overwrites a conflicting real hooks.json', async () => {
    mkdirSync(target, { recursive: true });
    const foreign = '{"hooks":{"PreToolUse":[]},"owner":"user"}\n';
    writeFileSync(join(target, 'hooks.json'), foreign);

    const result = await runLink(['codex', target], canonical, true);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/hooks\.json.*different content.*refusing to replace/);
    expect(readFileSync(join(target, 'hooks.json'), 'utf8')).toBe(foreign);
  });

  it('never overwrites conflicting real files or foreign symlinks', async () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'AGENTS.md'), '# My instructions\n');
    const foreignSkills = join(root, 'foreign-skills');
    mkdirSync(foreignSkills);
    // A foreign link is preserved just as carefully as a real directory.
    symlinkSync(foreignSkills, join(target, 'skills'));

    const result = await runLink(['codex', target], canonical, true);

    expect(result.code).toBe(1);
    expect(readFileSync(join(target, 'AGENTS.md'), 'utf8')).toBe('# My instructions\n');
    expect(readlinkSync(join(target, 'skills'))).toBe(foreignSkills);
  });

  it('fails before touching the target when absolute hook inputs are absent', async () => {
    const result = await runLink(['codex', target], canonical);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/WORKER_NODE_BIN.*WORKER_WRITE_FENCE_HOOK/);
    expect(existsSync(target)).toBe(false);
  });

  it('refuses to install worker-only hooks into the interactive Codex home', async () => {
    mkdirSync(target, { recursive: true });
    const result = await runLink(['codex', target], canonical, true, target);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('interactive Codex home');
    expect(existsSync(join(target, 'hooks.json'))).toBe(false);
  });

  it('refuses an uncreated target that is the interactive Codex home before mkdir', async () => {
    const uncreatedCodexHome = join(root, 'not-created-yet', '..', 'interactive-codex');
    const normalizedCodexHome = join(root, 'interactive-codex');

    const result = await runLink(
      ['codex', uncreatedCodexHome],
      canonical,
      true,
      normalizedCodexHome,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('interactive Codex home');
    expect(existsSync(normalizedCodexHome)).toBe(false);
  });
});
