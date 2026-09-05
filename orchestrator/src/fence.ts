import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

/**
 * Attaching the write fence to a worker.
 *
 * The fence itself lives in `../hooks/write-fence.mjs` and is deliberately
 * outside `src`: it is a dependency-free script spawned once per Bash call, and
 * it must not need this workspace to be built before it can refuse anything.
 *
 * WHY `--settings` AND NOT A SETTINGS FILE. Claude Code reads hooks from five
 * places. Two of them were tempting and both are wrong here:
 *
 *   - `~/.claude/settings.json` — the canonical account's own config. Adding
 *     hooks there does NOT break auth (the thing that broke login was setting
 *     CLAUDE_CONFIG_DIR, a different mechanism entirely), but that file is also
 *     the operator's interactive config, so the fence would fire in their own
 *     terminal.
 *   - `<repo>/.claude/settings.json` — a committed team file. That would push one
 *     person's console fence onto everyone working in the repo.
 *
 * `--settings` is argv only. It touches no environment variable, so the
 * canonical account still runs with CLAUDE_CONFIG_DIR unset exactly as before,
 * and it reaches only the processes this console spawns.
 *
 * VERIFIED, not assumed: a `--settings` hook MERGES with the project's own
 * hooks rather than shadowing them. Both fired in the same run on a real
 * machine, so a repo's own existing PreToolUse hooks keep working alongside this.
 *
 * WHY THE INTERPRETER IS NAMED. Pointing `command` at the `.mjs` file directly
 * works only while that file is executable. It was not, the hook failed to
 * launch, and a PreToolUse hook that fails to LAUNCH does not block the tool —
 * it lets it through. That was caught end to end, with a stub `gh` that logged
 * the breach. Naming `process.execPath` removes both the file-mode dependency
 * and any reliance on `node` being on the worker's PATH.
 */
export const WRITE_FENCE_HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'hooks',
  'write-fence.mjs',
);

/** How long the hook may take before Claude Code gives up on it. It reads one
 *  JSON object and does no I/O, so this is generous by an order of magnitude. */
const HOOK_TIMEOUT_SECONDS = 20;

/** Marker on the one hooks.json document this console owns inside a dedicated
 * Codex worker home. It is deliberately specific: a similarly-shaped user file
 * is not ours to replace. */
export const CODEX_HOOKS_DESCRIPTION = 'Worker Console write fence. Managed by scripts/link-account.sh codex.';

function codexHooksDocumentForCommand(command: string) {
  return {
    description: CODEX_HOOKS_DESCRIPTION,
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command,
              timeout: HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
}

/** Quote one argv element for the POSIX shell Codex uses to start command
 * hooks. Single quotes keep spaces, `$`, backticks and backslashes inert; the
 * five-character splice is the only safe way to carry a literal apostrophe. */
function shellQuote(value: string): string {
  return `'${value.split("'").join("'\"'\"'")}'`;
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`);
  return value;
}

/**
 * The exact hooks.json document installed into a dedicated Codex worker home.
 *
 * This is a document rather than an argv fragment because `codex exec resume`
 * has no per-invocation settings flag. Both fresh and resumed workers load this
 * same file through their CODEX_HOME. The named interpreter is non-negotiable:
 * a hook that cannot launch fails open.
 */
export function codexHooksDocument(
  hookPath: string = WRITE_FENCE_HOOK,
  nodeBin: string = process.execPath,
) {
  const hook = absolutePath(hookPath, 'Codex write-fence hook');
  const node = absolutePath(nodeBin, 'Codex hook Node interpreter');
  return codexHooksDocumentForCommand(`${shellQuote(node)} ${shellQuote(hook)}`);
}

/** Byte-canonical representation written by link-account.sh. */
export function codexHooksJson(
  hookPath: string = WRITE_FENCE_HOOK,
  nodeBin: string = process.execPath,
): string {
  return `${JSON.stringify(codexHooksDocument(hookPath, nodeBin), null, 2)}\n`;
}

/**
 * Is this exactly the hook document this console expects?
 *
 * Fail closed: malformed JSON, relative expected paths, missing fields, extra
 * handlers and changed commands all return false. Object key order and trailing
 * whitespace are irrelevant, because neither changes the JSON document.
 */
export function validateCodexHooksJson(
  raw: string,
  hookPath: string = WRITE_FENCE_HOOK,
  nodeBin: string = process.execPath,
): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(raw), codexHooksDocument(hookPath, nodeBin));
  } catch {
    return false;
  }
}

/** Exact doctor check using the already-resolved command from the production
 * document. Settings and launch preflight must reject the same extra handlers,
 * changed matchers and altered timeouts. */
export function validateCodexHooksCommandJson(raw: string, expectedCommand: string): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(raw), codexHooksDocumentForCommand(expectedCommand));
  } catch {
    return false;
  }
}

/**
 * Refuse to start or resume a Codex worker unless its selected CODEX_HOME has
 * the exact console-owned fence document. Merely configuring the intended path
 * is not enough: a missing, unreadable, malformed, or changed file would make
 * Codex run broad Bash calls without this policy.
 */
export async function assertCodexHooksReady(configDir: string): Promise<void> {
  const home = absolutePath(configDir, 'CODEX_HOME');
  const hooksPath = join(home, 'hooks.json');
  let raw: string;
  try {
    raw = await readFile(hooksPath, 'utf8');
  } catch (cause) {
    throw new Error(
      `Codex write fence is unavailable at ${hooksPath}; run scripts/link-account.sh codex for this account`,
      { cause },
    );
  }
  if (!validateCodexHooksJson(raw)) {
    throw new Error(
      `Codex write fence at ${hooksPath} does not match the Worker Console policy; ` +
        'refusing to start an unfenced worker',
    );
  }
}

/**
 * The `--settings` argv pair every worker is spawned and resumed with.
 *
 * Passed inline rather than as a path: there is no file to write, to clean up,
 * to be redirected by a test, or to go missing between a spawn and a resume.
 */
export function fenceArgs(hookPath: string = WRITE_FENCE_HOOK, nodeBin: string = process.execPath): string[] {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          // The matcher filters on TOOL NAME only, so this sees every Bash call
          // — including those a subagent makes, which is where the obvious hole
          // would otherwise be.
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: `"${nodeBin}" "${hookPath}"`,
              timeout: HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
  return ['--settings', JSON.stringify(settings)];
}
