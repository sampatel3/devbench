import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODEX_HOOKS_DESCRIPTION,
  assertCodexHooksReady,
  codexHooksDocument,
  codexHooksJson,
  fenceArgs,
  validateCodexHooksCommandJson,
  validateCodexHooksJson,
  WRITE_FENCE_HOOK,
} from '../src/fence.js';
import { WorkerRunner } from '../src/worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-worker.mjs');

/**
 * The fence is only real if it is actually ATTACHED to every worker. These tests
 * guard the wiring, not the parsing — write-fence.test.ts owns the parsing.
 *
 * The regression that matters most here was found by running the thing end to
 * end rather than by reasoning about it. The first working version pointed the
 * hook at `write-fence.mjs` directly. The file was not executable, so the hook
 * failed to launch — and a PreToolUse hook that fails to LAUNCH does not block
 * the tool, it lets it through. The fake `gh` ran. Claude Code's own contract
 * says so: only exit code 2 (or a deny on stdout) blocks; every other non-zero
 * exit shows stderr to the user and RUNS THE COMMAND ANYWAY.
 *
 * So the fence must never depend on a file mode, and never on `node` being
 * found on the worker's PATH. It names the interpreter by absolute path.
 */
describe('the fence is attached to the worker, not just written down', () => {
  it('names an absolute node interpreter — a bare .mjs path fails OPEN', () => {
    const args = fenceArgs('/hooks/write-fence.mjs', '/abs/bin/node');
    const settings = JSON.parse(args[1]!);
    const command: string = settings.hooks.PreToolUse[0].hooks[0].command;

    // The exact bug: `command` was the .mjs path alone, the file was not +x,
    // the hook never ran, and the write went through.
    expect(command.startsWith('/hooks/write-fence.mjs')).toBe(false);
    expect(command).toContain('/abs/bin/node');
    expect(command).toContain('write-fence.mjs');
  });

  it('defaults the interpreter to the node already running the console', () => {
    const settings = JSON.parse(fenceArgs('/hooks/write-fence.mjs')[1]!);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(process.execPath);
  });

  it('matches every Bash call, because the matcher filters on tool name only', () => {
    const settings = JSON.parse(fenceArgs('/hooks/write-fence.mjs')[1]!);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash');
  });

  it('passes the settings inline, so there is no file to go missing', () => {
    const args = fenceArgs('/hooks/write-fence.mjs');
    expect(args[0]).toBe('--settings');
    expect(() => JSON.parse(args[1]!)).not.toThrow();
  });

  it('quotes paths, so a directory with a space does not split the command', () => {
    const settings = JSON.parse(fenceArgs('/Users/My Code/hooks/write-fence.mjs', '/usr/bin/node')[1]!);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('"/Users/My Code/hooks/write-fence.mjs"');
  });

  it('ships a hook file that exists and is executable on this machine', () => {
    expect(existsSync(WRITE_FENCE_HOOK)).toBe(true);
    // Belt and braces: the settings name node explicitly, but if anything ever
    // runs this file directly it must not fail open.
    expect(statSync(WRITE_FENCE_HOOK).mode & 0o111).toBeGreaterThan(0);
  });
});

describe('the Codex hooks.json contract', () => {
  const hookPath = '/opt/worker-console/orchestrator/hooks/write-fence.mjs';
  const nodeBin = '/opt/node/bin/node';

  it('produces the exact owned PreToolUse/Bash document', () => {
    expect(codexHooksDocument(hookPath, nodeBin)).toEqual({
      description: CODEX_HOOKS_DESCRIPTION,
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: "'/opt/node/bin/node' '/opt/worker-console/orchestrator/hooks/write-fence.mjs'",
                timeout: 20,
              },
            ],
          },
        ],
      },
    });
  });

  it('has one byte-canonical JSON representation and validates it', () => {
    const raw = codexHooksJson(hookPath, nodeBin);
    expect(raw).toBe(`${JSON.stringify(codexHooksDocument(hookPath, nodeBin), null, 2)}\n`);
    expect(validateCodexHooksJson(raw, hookPath, nodeBin)).toBe(true);
  });

  it('quotes shell metacharacters in both absolute paths', () => {
    const doc = codexHooksDocument("/hooks/worker's fence.mjs", "/Node Builds/node's bin");
    expect(doc.hooks.PreToolUse[0]!.hooks[0]!.command).toBe(
      "'/Node Builds/node'\"'\"'s bin' '/hooks/worker'\"'\"'s fence.mjs'",
    );
  });

  it('fails closed for malformed, incomplete, changed, or extended documents', () => {
    const expected = codexHooksDocument(hookPath, nodeBin);
    expect(validateCodexHooksJson('{not json', hookPath, nodeBin)).toBe(false);
    expect(validateCodexHooksJson('{}', hookPath, nodeBin)).toBe(false);
    expect(validateCodexHooksJson(JSON.stringify({ ...expected, extra: true }), hookPath, nodeBin)).toBe(false);

    const changed = structuredClone(expected);
    changed.hooks.PreToolUse[0]!.hooks[0]!.command = "'/tmp/node' '/tmp/foreign-hook.mjs'";
    expect(validateCodexHooksJson(JSON.stringify(changed), hookPath, nodeBin)).toBe(false);
  });

  it('keeps the doctor command check on the same exact document shape', () => {
    const expected = codexHooksDocument(hookPath, nodeBin);
    const command = expected.hooks.PreToolUse[0]!.hooks[0]!.command;
    expect(validateCodexHooksCommandJson(JSON.stringify(expected), command)).toBe(true);
    expect(validateCodexHooksCommandJson(JSON.stringify({ ...expected, extra: true }), command)).toBe(false);
  });

  it('rejects relative interpreter or hook paths instead of installing a fail-open hook', () => {
    expect(() => codexHooksDocument('hooks/write-fence.mjs', nodeBin)).toThrow(/absolute/);
    expect(() => codexHooksDocument(hookPath, 'node')).toThrow(/absolute/);
    expect(validateCodexHooksJson('{}', 'hooks/write-fence.mjs', nodeBin)).toBe(false);
  });
});

describe('the Codex fence preflight', () => {
  let codexHome: string;

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'wc-codex-fence-'));
  });

  afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('accepts the exact fence installed in the selected CODEX_HOME', async () => {
    writeFileSync(join(codexHome, 'hooks.json'), codexHooksJson());
    await expect(assertCodexHooksReady(codexHome)).resolves.toBeUndefined();
  });

  it('fails closed when hooks.json is missing', async () => {
    await expect(assertCodexHooksReady(codexHome)).rejects.toThrow(/write fence is unavailable.*hooks\.json/);
  });

  it('fails closed when hooks.json cannot be read as a file', async () => {
    mkdirSync(join(codexHome, 'hooks.json'));
    await expect(assertCodexHooksReady(codexHome)).rejects.toThrow(/write fence is unavailable.*hooks\.json/);
  });

  it('fails closed when hooks.json is malformed or belongs to another hook', async () => {
    writeFileSync(join(codexHome, 'hooks.json'), '{not json');
    await expect(assertCodexHooksReady(codexHome)).rejects.toThrow(/does not match.*refusing to start/);

    writeFileSync(join(codexHome, 'hooks.json'), codexHooksJson('/tmp/another-hook.mjs', process.execPath));
    await expect(assertCodexHooksReady(codexHome)).rejects.toThrow(/does not match.*refusing to start/);
  });

  it('rejects a relative CODEX_HOME instead of inspecting the process cwd', async () => {
    await expect(assertCodexHooksReady('.codex-worker')).rejects.toThrow(/CODEX_HOME must be an absolute path/);
  });
});

describe('every worker invocation carries it — start AND resume', () => {
  let worktree: string;
  let canonical: string;
  let streamDir: string;
  let argvFile: string;
  const spawned: Array<{ runner: WorkerRunner; issue: number }> = [];

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'wc-fence-wt-'));
    canonical = mkdtempSync(join(tmpdir(), 'wc-fence-canon-'));
    streamDir = mkdtempSync(join(tmpdir(), 'wc-fence-stream-'));
    argvFile = join(streamDir, 'argv.json');
    process.env.STUB_ARGV_FILE = argvFile;
  });
  afterEach(() => {
    // Nothing this test started may outlive it. The stub exits on its own, so
    // these calls are usually no-ops — but a failed assertion skips the rest of
    // a test, and a leaked worker polling a deleted temp dir is exactly what
    // gets found later.
    for (const { runner, issue } of spawned.splice(0)) runner.stop(issue);
    delete process.env.STUB_ARGV_FILE;
    rmSync(worktree, { recursive: true, force: true });
    rmSync(canonical, { recursive: true, force: true });
    rmSync(streamDir, { recursive: true, force: true });
  });

  const runner = (extraArgs: string[]) => {
    const r: WorkerRunner = new WorkerRunner({
      bin: STUB,
      permissionMode: 'bypassPermissions',
      canonicalConfigDir: canonical,
      streamDir,
      pollMs: 20,
      extraArgs,
      onChange: () => {},
      onSpawn: (info) => spawned.push({ runner: r, issue: info.issue }),
    });
    return r;
  };

  /** The stub records the argv it was handed. */
  const argvOf = (): string[] =>
    existsSync(argvFile) ? (JSON.parse(readFileSync(argvFile, 'utf8')) as string[]) : [];

  it('start() hands the fence to the child', async () => {
    const args = fenceArgs(WRITE_FENCE_HOOK);
    await runner(args).start(1, worktree, 'sess-fence-1', 'go', canonical, 'sonnet');
    const argv = argvOf();
    expect(argv).toContain('--settings');
    expect(argv[argv.indexOf('--settings') + 1]).toContain('write-fence.mjs');
  });

  it('resume() hands the fence to the child too — a gate must not unfence it', async () => {
    const args = fenceArgs(WRITE_FENCE_HOOK);
    const r = runner(args);
    await r.start(2, worktree, 'sess-fence-2', 'go', canonical, 'sonnet');
    await r.resume(2, worktree, 'sess-fence-2', 'carry on', canonical, 'sonnet');
    const argv = argvOf();
    expect(argv).toContain('--resume');
    expect(argv).toContain('--settings');
    expect(argv[argv.indexOf('--settings') + 1]).toContain('write-fence.mjs');
  });
});
