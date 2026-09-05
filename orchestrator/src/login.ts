import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { canonicalDir, loginCommandFor, type AccountHealth, type AgentProviderId } from './accounts.js';
import { codexWorkerEnv } from './providers/env.js';
import { claudeEnv } from './worker.js';

/**
 * "Is this account actually signed in?" — asked through its own CLI.
 *
 * The doctor's `loggedIn` reads files and is honest but not very useful: on this
 * Mac the canonical account's credentials are in the Keychain, so it can only
 * ever say `unknown`. That is exactly the account most workers are started on,
 * and "I found out when the worker died" is not an answer.
 *
 * So there are two signals and they are different things:
 *  - the file check is the cheap, always-on HINT;
 *  - this is the definitive ANSWER. Claude answers a tiny prompt and Codex uses
 *    its free `login status` command, but both only happen on an explicit click.
 *
 * The one rule that must not be broken: each probe uses its worker's profile
 * boundary. Claude goes through `claudeEnv`, including the canonical no-variable
 * rule; Codex strips inherited selectors and sets only the selected CODEX_HOME.
 */

export type LoginVerdict = 'signed-in' | 'not-signed-in' | 'unknown';

export type LoginProbe = {
  account: string;
  provider: AgentProviderId;
  verdict: LoginVerdict;
  /** One line of plain English. Never a reassurance we did not earn. */
  detail: string;
  /** What to type if it is not signed in — the same helper everything else uses. */
  loginCommand: string;
  checkedAt: string;
};

/** An account's health as the Settings tab sees it: the cheap file signal, plus
 *  the last definitive answer if one has been asked for. */
export type AccountReport = AccountHealth & { probe: LoginProbe | null };

/** The smallest thing worth asking a model. */
export const PROBE_PROMPT = 'reply exactly: OK';
export const PROBE_TIMEOUT_MS = 20_000;
/** A probe has no session. This id exists only to go through the same env helper
 *  a worker's does, so the two environments cannot drift apart. */
export const PROBE_SESSION_ID = 'login-probe';

/** Authentication failures emitted by either CLI. */
const NOT_SIGNED_IN =
  /not logged in|please run \/login|invalid api key|authentication (?:required|failed)|unauthenticated|no (?:auth|credentials)/i;

function firstLine(s: string, max = 200): string {
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  return line.trim().slice(0, max);
}

/**
 * Read the run. The asymmetry is deliberate: `signed-in` needs a clean exit AND
 * something that looks like an answer, while anything unexplained is `unknown`.
 * A false green here would send the operator off to start a worker that cannot
 * run.
 */
export function classifyLogin(
  input: {
    exitedCleanly: boolean;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    spawnError: string | null;
  },
  program: AgentProviderId = 'claude',
): { verdict: LoginVerdict; detail: string } {
  const said = `${input.stdout}\n${input.stderr}`;
  if (NOT_SIGNED_IN.test(said)) {
    const line = firstLine(said.split('\n').filter((l) => NOT_SIGNED_IN.test(l))[0] ?? said);
    return { verdict: 'not-signed-in', detail: line || 'it says it is not logged in' };
  }
  if (input.spawnError) return { verdict: 'unknown', detail: `could not run ${program} — ${input.spawnError}` };
  if (input.timedOut) return { verdict: 'unknown', detail: 'no answer within the time allowed, so this proves nothing' };
  // `codex login status` currently prints its successful status line to stderr.
  // For that status-only command, a clean exit plus either output channel is a
  // definitive answer. Claude still has to answer its probe on stdout: generic
  // stderr noise must not become a false green there.
  const successfulOutput = program === 'codex' ? said : input.stdout;
  if (input.exitedCleanly && successfulOutput.trim()) {
    return { verdict: 'signed-in', detail: `it answered: ${firstLine(successfulOutput)}` };
  }
  const noise = firstLine(input.stderr) || firstLine(input.stdout);
  return {
    verdict: 'unknown',
    detail: noise ? `it did not answer as expected — ${noise}` : 'it exited without saying anything',
  };
}

/**
 * Isolate `codex login status` to the selected profile. Inherited Codex/OpenAI
 * selectors could otherwise make a healthy host login masquerade as this
 * account, so only the chosen CODEX_HOME is put back.
 */
export function codexLoginEnv(base: NodeJS.ProcessEnv, configDir: string): NodeJS.ProcessEnv {
  return codexWorkerEnv({ base, sessionId: PROBE_SESSION_ID, configDir });
}

/**
 * Run the probe. It never throws: an account that cannot be checked reports
 * `unknown` with the reason, because a thrown error on this path would take the
 * Settings tab down over a question about configuration.
 */
export async function checkLogin(opts: {
  /** Missing means Claude for callers and registries from before Codex. */
  provider?: AgentProviderId;
  name: string;
  bin: string;
  configDir: string;
  canonicalConfigDir?: string;
  timeoutMs?: number;
  /** Somewhere neutral by default: a probe should not drag a project's context
   *  (and its tokens) in to answer a yes/no question. */
  cwd?: string;
}): Promise<LoginProbe> {
  const provider = opts.provider ?? 'claude';
  const canonicalConfigDir = opts.canonicalConfigDir ?? canonicalDir();
  const env =
    provider === 'codex'
      ? codexLoginEnv(process.env, opts.configDir)
      : claudeEnv(process.env, PROBE_SESSION_ID, opts.configDir, canonicalConfigDir);
  const args = provider === 'codex' ? ['login', 'status'] : ['-p', PROBE_PROMPT];
  const ran = await new Promise<{
    exitedCleanly: boolean;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    spawnError: string | null;
  }>((resolve) => {
    execFile(
      opts.bin,
      args,
      { env, cwd: opts.cwd ?? tmpdir(), timeout: opts.timeoutMs ?? PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ exitedCleanly: true, timedOut: false, stdout, stderr, spawnError: null });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        resolve({
          exitedCleanly: false,
          // A timeout kill, not a refusal — the difference between "no answer"
          // and "an answer we did not like".
          timedOut: e.killed === true || e.signal === 'SIGTERM',
          stdout,
          stderr,
          // A string code is the spawn itself failing (ENOENT); a number is the
          // program running and exiting unhappily, which is not the same news.
          spawnError: typeof e.code === 'string' ? `${e.code} (${opts.bin})` : null,
        });
      },
    );
  });

  return {
    account: opts.name,
    provider,
    ...classifyLogin(ran, provider),
    loginCommand: loginCommandFor(opts.configDir, canonicalConfigDir, provider),
    checkedAt: new Date().toISOString(),
  };
}
