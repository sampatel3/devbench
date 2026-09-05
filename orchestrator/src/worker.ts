import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { readFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseGateFile } from './state.js';
import { pidAlive } from './reattach.js';
import {
  StreamTail,
  applyAgentStreamLine,
  emptyTotals,
  lastMessageFileFor,
  readTotals,
  stderrFileFor,
  streamFileFor,
  tailFile,
  type StreamTotals,
} from './stream.js';
import type { RunUsage } from './metrics.js';
import type { GateFile, LiveRun, RunningRun } from './types.js';
import {
  ClaudeProvider,
  claudeSessionDir,
  claudeTranscriptPath,
  claudeWorkerEnv,
  cleanWorkerEnv,
  type AgentProvider,
  type AgentProviderId,
  type AgentProviderRegistry,
  type ProviderLaunchSpec,
} from './providers/index.js';

/**
 * A worker is `claude` running headless in an issue's worktree. It exits when it
 * stops at a gate — that is the whole trick. A parked worker is not a process.
 *
 * And a RUNNING worker is not the console's process either. It is spawned
 * DETACHED, with its stdout going to a file rather than down a pipe, so it
 * outlives the console that started it. Restarting the console used to kill
 * every worker mid-run; now the console simply stops reading, and picks the same
 * file up again from the same byte offset next time it starts.
 */

export const GATE_FILE = '.gate.json';

/** How much of a failed run's stderr is worth keeping in the error message. */
const STDERR_TAIL_BYTES = 2000;

/**
 * Claude Code keeps a session transcript per working directory, at
 * <configDir>/projects/<cwd with every non-alphanumeric turned into a dash>/<id>.jsonl
 *
 * `configDir` is the account's dir — transcripts live inside the account that
 * wrote them, so anything that reads them has to be told which account to look in.
 */
export function sessionDir(cwd: string, configDir: string): string {
  return claudeSessionDir(cwd, configDir);
}

export function transcriptPath(cwd: string, sessionId: string, configDir: string): string {
  return claudeTranscriptPath(cwd, sessionId, configDir);
}

export async function mtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

function fileSizeOr(path: string, fallback: number): number {
  try {
    return statSync(path).size;
  } catch {
    return fallback;
  }
}

export async function readGateFile(worktree: string): Promise<GateFile | null> {
  try {
    return parseGateFile(await readFile(join(worktree, GATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export async function deleteGateFile(worktree: string): Promise<void> {
  await unlink(join(worktree, GATE_FILE)).catch(() => {});
}

/**
 * A child spawned from inside a Claude Code session inherits env vars that tell
 * it to ask its host process for an OAuth token, and it then cannot authenticate
 * on its own. Workers must boot as if from a clean shell.
 *
 * Order matters: every CLAUDE* var is stripped FIRST, and only then is the
 * account's CLAUDE_CONFIG_DIR set. Setting it before the strip would delete it
 * again, and the worker would silently run under whatever account is default.
 *
 * `configDir` NULL means "set nothing", which is not the same as setting the
 * default path — see `configDirEnv` in accounts.ts. The canonical account must
 * be run with the variable absent, or it cannot find its Keychain credentials.
 */
export function cleanEnv(
  base: NodeJS.ProcessEnv,
  sessionId: string,
  configDir?: string | null,
  gate?: { issue: number; decisionsFile: string },
): NodeJS.ProcessEnv {
  const env = cleanWorkerEnv(base, sessionId, gate);
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

/**
 * The environment EVERY `claude` this console runs gets — the worker spawn and
 * the Settings login probe alike.
 *
 * There is one function because there was once nearly two: a probe that built
 * its own environment could report an account as signed in while every real
 * worker on it failed, which is the exact shape of the canonical-account bug
 * this rule exists for. Same helper, same answer, always.
 */
export function claudeEnv(
  base: NodeJS.ProcessEnv,
  sessionId: string,
  configDir: string,
  canonicalConfigDir: string,
  gate?: { issue: number; decisionsFile: string },
): NodeJS.ProcessEnv {
  return claudeWorkerEnv({ base, sessionId, configDir, canonicalConfigDir, gate });
}

export type RunResult = {
  provider: AgentProviderId;
  /** Provider-owned id recovered from the stream, if the provider yielded one. */
  agentSessionId: string | null;
  /** Two of these are NOT endings, and nothing may be concluded from either —
   *  no run record, no error, and the state.json row must survive both:
   *
   *  - `left-running`: the console stopped watching (it is shutting down) and
   *    the worker carried on.
   *  - `refused`: this spawn never happened, because a worker for the issue was
   *    already running. There is no run here to conclude anything about, and the
   *    row and context belong to the worker that IS live — treating it as a
   *    failed run deleted them and orphaned that worker. */
  outcome: 'gate' | 'finished' | 'failed' | 'stopped' | 'left-running' | 'refused';
  gate: GateFile | null;
  error: string | null;
  turns: number;
  transcriptMtimeMs: number | null;
  /** tool_use blocks seen on the stream — how much the worker actually did */
  toolCalls: number;
  /** the `result` event's own accounting, or null when we never saw one */
  usage: RunUsage | null;
  /** what `system.init` said the CLI resolved our --model to */
  resolvedModel: string | null;
};

/** What the console must write down the moment a worker exists, so it can find
 *  it again after a restart. */
export type SpawnInfo = {
  issue: number;
  provider: AgentProviderId;
  sessionId: string;
  agentSessionId: string | null;
  processIdentityToken: string;
  pid: number;
  worktree: string;
  streamFile: string;
  stderrFile: string;
  lastMessageFile: string;
  /** Where THIS run's output begins in a file the whole session appends to. */
  startOffset: number;
  startedAt: string;
};

type Running = {
  issue: number;
  /** Null when we are only watching a pid: a worker re-attached after a restart. */
  child: ChildProcess | null;
  pid: number;
  provider: AgentProviderId;
  adapter: AgentProvider;
  sessionId: string;
  agentSessionId: string | null;
  processIdentityToken: string;
  worktree: string;
  configDir: string;
  streamFile: string;
  stderrFile: string;
  lastMessageFile: string;
  startOffset: number;
  tail: StreamTail;
  timer: NodeJS.Timeout | null;
  live: LiveRun;
  /** The live view only — the run record is read from the file when it ends. */
  seen: StreamTotals;
  /** We asked it to stop, so the exit that follows is not a failure. */
  stopping: boolean;
  /** Bytes already present when a console re-attached. Codex events before this
   *  fence are replay, so their read time must not be presented as event time. */
  replayUntilOffset: number;
  /** The tail has consumed everything that predates this watcher. */
  observingLive: boolean;
  pumping: boolean;
  settled: boolean;
  spawnError: string | null;
  finish: (r: RunResult) => void;
};

export type WorkerRunnerOptions = {
  /** Provider registry for production. Omitted by legacy Claude-only tests. */
  providers?: Partial<AgentProviderRegistry>;
  bin?: string;
  permissionMode?: string;
  /** `~/.claude`. An account pointing here is run with CLAUDE_CONFIG_DIR UNSET,
   *  because naming it stops Claude Code finding its Keychain credentials. */
  canonicalConfigDir?: string;
  /** Where the per-session stream files live. */
  streamDir: string;
  /** How often the tail reads (and, for a re-attached worker, how often we ask
   *  whether its pid is still there). */
  pollMs?: number;
  /** The console's decision ledger, handed to the worker's environment so the
   *  write fence can check Gate D before letting `gh pr create` through. */
  decisionsFile?: string;
  extraArgs?: string[];
  onChange: () => void;
  /** Called the instant a worker exists, before anything can go wrong with it. */
  onSpawn?: (info: SpawnInfo) => void;
  /** The tail moved. Cheap and frequent: it updates the number in memory and
   *  leaves saving to whoever owns the state file. */
  onProgress?: (issue: number, offset: number) => void;
  /** Called the first time a provider-owned conversation id is observed. */
  onAgentSession?: (issue: number, provider: AgentProviderId, agentSessionId: string) => void;
  log?: (line: string) => void;
};

export class WorkerRunner {
  #running = new Map<number, Running>();
  #providers: Partial<AgentProviderRegistry>;

  constructor(private opts: WorkerRunnerOptions) {
    this.#providers = opts.providers ?? {
      claude: new ClaudeProvider({
        bin: opts.bin ?? 'claude',
        permissionMode: opts.permissionMode ?? 'bypassPermissions',
        canonicalConfigDir: opts.canonicalConfigDir ?? join(process.env.HOME ?? '', '.claude'),
        extraArgs: opts.extraArgs,
      }),
    };
  }

  #provider(id: AgentProviderId): AgentProvider {
    const provider = this.#providers[id];
    if (!provider) throw new Error(`worker provider '${id}' is not configured`);
    return provider;
  }

  isRunning(issue: number): boolean {
    return this.#running.has(issue);
  }
  activeCount(): number {
    return this.#running.size;
  }
  live(issue: number): LiveRun | null {
    return this.#running.get(issue)?.live ?? null;
  }
  sessionIdOf(issue: number): string | null {
    return this.#running.get(issue)?.sessionId ?? null;
  }
  agentSessionIdOf(issue: number): string | null {
    return this.#running.get(issue)?.agentSessionId ?? null;
  }

  /** First run for an issue: a fresh session id we choose, so we can always resume it.
   *  `configDir` is the account this issue runs under and `model` the model it was
   *  resolved to — every invocation for an issue, spawn and resume alike, uses the
   *  same account, and the model is passed explicitly rather than assumed. */
  async start(
    issue: number,
    worktree: string,
    sessionId: string,
    prompt: string,
    configDir: string,
    model: string,
    providerId: AgentProviderId = 'claude',
  ): Promise<RunResult> {
    if (this.#running.has(issue)) return this.#refused(`worker for #${issue} is already running`, providerId);
    const adapter = this.#provider(providerId);
    const lastMessageFile = lastMessageFileFor(this.opts.streamDir, issue, sessionId);
    let spec: ProviderLaunchSpec;
    try {
      spec = await adapter.start({
        issue,
        worktree,
        sessionId,
        agentSessionId: null,
        prompt,
        model,
        configDir,
        lastMessageFile,
        baseEnv: process.env,
        gate: { issue, decisionsFile: this.opts.decisionsFile ?? '' },
      });
    } catch (error) {
      return this.#failedToStart(error instanceof Error ? error.message : String(error), providerId);
    }
    return this.#run(issue, worktree, sessionId, spec, configDir, adapter, lastMessageFile);
  }

  /** Resume after a gate. Deletes the gate file first so a crash mid-resume does not park it again. */
  async resume(
    issue: number,
    worktree: string,
    sessionId: string,
    message: string,
    configDir: string,
    model: string,
    providerId: AgentProviderId = 'claude',
    agentSessionId: string = sessionId,
  ): Promise<RunResult> {
    if (this.#running.has(issue)) return this.#refused(`worker for #${issue} is already running`, providerId);
    const adapter = this.#provider(providerId);
    const lastMessageFile = lastMessageFileFor(this.opts.streamDir, issue, sessionId);
    let spec: ProviderLaunchSpec;
    try {
      spec = await adapter.resume({
        issue,
        worktree,
        sessionId,
        agentSessionId,
        prompt: message,
        model,
        configDir,
        lastMessageFile,
        baseEnv: process.env,
        gate: { issue, decisionsFile: this.opts.decisionsFile ?? '' },
      });
    } catch (error) {
      return this.#failedToStart(error instanceof Error ? error.message : String(error), providerId);
    }
    // Only consume the gate after the provider has validated everything needed
    // to launch (notably Codex's fail-closed hook). A configuration refusal must
    // leave the user's decision point intact.
    await deleteGateFile(worktree);
    return this.#run(issue, worktree, sessionId, spec, configDir, adapter, lastMessageFile);
  }

  /**
   * Pick a worker back up that is still running from before a console restart.
   * Nothing is spawned and nothing is signalled: we open its stream file at the
   * offset we had reached and carry on reading, and we watch its pid for the
   * exit we would otherwise have been told about.
   */
  async attach(entry: RunningRun, configDir: string): Promise<RunResult> {
    const providerId = entry.provider ?? 'claude';
    if (this.#running.has(entry.issue)) {
      return this.#refused(`worker for #${entry.issue} is already running`, providerId);
    }
    const adapter = this.#provider(providerId);
    let agentSessionId = entry.agentSessionId ?? (providerId === 'claude' ? entry.sessionId : null);
    if (!agentSessionId && providerId === 'codex') {
      agentSessionId = (await readTotals(entry.streamFile, entry.startOffset, providerId)).agentSessionId;
      if (agentSessionId) this.opts.onAgentSession?.(entry.issue, providerId, agentSessionId);
    }
    return new Promise<RunResult>((resolve) => {
      this.#watch({
        issue: entry.issue,
        child: null,
        pid: entry.pid,
        provider: providerId,
        adapter,
        sessionId: entry.sessionId,
        agentSessionId,
        processIdentityToken: entry.processIdentityToken ?? entry.sessionId,
        worktree: entry.worktree,
        configDir,
        streamFile: entry.streamFile,
        stderrFile: entry.stderrFile,
        lastMessageFile: lastMessageFileFor(this.opts.streamDir, entry.issue, entry.sessionId),
        startOffset: entry.startOffset,
        tailFrom: entry.offset,
        replayUntilOffset: fileSizeOr(entry.streamFile, entry.offset),
        startedAt: entry.startedAt,
        reattached: true,
        finish: resolve,
      });
      this.opts.onChange();
    });
  }

  /**
   * Deliberate, and the only thing in the console that kills a worker. Shutting
   * the console down does NOT come through here — see `detachAll`.
   */
  stop(issue: number): boolean {
    const r = this.#running.get(issue);
    if (!r) return false;
    r.stopping = true;
    try {
      // `detached: true` makes the worker a process-group leader (pgid === pid),
      // and every ordinary descendant inherits that group. Stopping only the
      // CLI pid orphaned npm, test runners and dev tools it had launched.
      process.kill(-r.pid, 'SIGTERM');
    } catch {
      // Already gone. The pump notices on its next pass and finishes the run.
    }
    return true;
  }

  /**
   * Shutdown: stop WATCHING every worker, kill none of them.
   *
   * Each run's promise settles as `left-running`, which its tracker treats as
   * "nothing happened" — no run record, no error, and the state.json row stays
   * put, because that row is what re-attaches the worker next time. The child's
   * listeners are dropped so a later exit cannot reach a console that has
   * stopped caring.
   *
   * Returns how many workers were left running, for the shutdown log.
   */
  async detachAll(): Promise<number> {
    const runs = [...this.#running.values()];
    let left = 0;
    for (const r of runs) {
      // One last read, so the offset that gets persisted is the true one. If the
      // worker happens to have just exited, this finishes it properly instead.
      await this.#pump(r);
      if (r.settled) continue;
      r.settled = true;
      if (r.timer) clearInterval(r.timer);
      r.child?.removeAllListeners();
      this.#running.delete(r.issue);
      left += 1;
      r.finish({
        provider: r.provider,
        agentSessionId: r.agentSessionId,
        outcome: 'left-running',
        gate: null,
        error: null,
        turns: r.seen.turns,
        transcriptMtimeMs: null,
        toolCalls: r.seen.toolCalls,
        usage: null,
        resolvedModel: null,
      });
    }
    this.opts.onChange();
    return left;
  }

  /**
   * A spawn that never happened, because this issue already has a worker.
   *
   * Deliberately NOT `failed`. A failure is an ending and gets the full ending
   * treatment — the running row deleted, a line in runs.jsonl, an error on the
   * card — and every one of those belongs to the worker that is actually alive.
   */
  #refused(error: string, provider: AgentProviderId = 'claude'): RunResult {
    return { ...this.#nonResult(provider), outcome: 'refused', error };
  }

  /** A spawn that WAS attempted and did not start. That is a real ending. */
  #failedToStart(error: string, provider: AgentProviderId = 'claude'): RunResult {
    return { ...this.#nonResult(provider), outcome: 'failed', error };
  }

  #nonResult(provider: AgentProviderId): Omit<RunResult, 'outcome' | 'error'> {
    return {
      provider,
      agentSessionId: null,
      gate: null,
      turns: 0,
      transcriptMtimeMs: null,
      toolCalls: 0,
      usage: null,
      resolvedModel: null,
    };
  }

  #run(
    issue: number,
    worktree: string,
    sessionId: string,
    spec: ProviderLaunchSpec,
    configDir: string,
    adapter: AgentProvider,
    lastMessageFile: string,
  ): Promise<RunResult> {
    if (this.#running.has(issue)) {
      return Promise.resolve(this.#refused(`worker for #${issue} is already running`, adapter.id));
    }

    const streamFile = streamFileFor(this.opts.streamDir, issue, sessionId);
    const stderrFile = stderrFileFor(this.opts.streamDir, issue, sessionId);
    mkdirSync(this.opts.streamDir, { recursive: true });
    // The file belongs to the SESSION and every segment appends to it, so this
    // run's own output starts wherever the last one left off.
    const startOffset = existsSync(streamFile) ? statSync(streamFile).size : 0;
    const out = openSync(streamFile, 'a');
    const err = openSync(stderrFile, 'a');

    let child: ChildProcess;
    try {
      child = spawn(spec.bin, spec.args, {
        cwd: worktree,
        env: spec.env,
        // Files, not pipes: a pipe would tie this worker's life to ours.
        stdio: ['ignore', out, err],
        detached: true,
      });
    } finally {
      // The child has its own copies of both descriptors now.
      closeSync(out);
      closeSync(err);
    }
    // Nothing about our event loop should keep us waiting on it, or it on us.
    child.unref();

    // Attached HERE, before anything can return. A spawn that cannot resolve the
    // binary reports it asynchronously on this emitter, and an unhandled 'error'
    // event is a process exit — so a missing or unrunnable `claude`, much the
    // likeliest thing to be wrong on a fresh machine, took the whole console
    // down instead of failing one run. Registering it after the `child.pid`
    // check below was too late: that path returns first.
    let running: Running | null = null;
    child.on('error', (e) => {
      if (running) running.spawnError = e.message;
    });

    if (!child.pid) {
      return Promise.resolve(this.#failedToStart(`could not start ${spec.bin}`, adapter.id));
    }

    const startedAt = new Date().toISOString();
    return new Promise<RunResult>((resolve) => {
      running = this.#watch({
        issue,
        child,
        pid: child.pid!,
        provider: adapter.id,
        adapter,
        sessionId,
        agentSessionId: spec.initialAgentSessionId,
        processIdentityToken: spec.processIdentityToken,
        worktree,
        configDir,
        streamFile,
        stderrFile,
        lastMessageFile,
        startOffset,
        tailFrom: startOffset,
        replayUntilOffset: startOffset,
        startedAt,
        reattached: false,
        finish: resolve,
      });

      child.on('close', (code) => void this.#finish(running!, code));

      this.opts.onSpawn?.({
        issue,
        provider: adapter.id,
        sessionId,
        agentSessionId: spec.initialAgentSessionId,
        processIdentityToken: spec.processIdentityToken,
        pid: child.pid!,
        worktree,
        streamFile,
        stderrFile,
        lastMessageFile,
        startOffset,
        startedAt,
      });
      this.opts.onChange();
    });
  }

  #watch(input: {
    issue: number;
    child: ChildProcess | null;
    pid: number;
    provider: AgentProviderId;
    adapter: AgentProvider;
    sessionId: string;
    agentSessionId: string | null;
    processIdentityToken: string;
    worktree: string;
    configDir: string;
    streamFile: string;
    stderrFile: string;
    lastMessageFile: string;
    startOffset: number;
    tailFrom: number;
    replayUntilOffset: number;
    startedAt: string;
    reattached: boolean;
    finish: (r: RunResult) => void;
  }): Running {
    const running: Running = {
      issue: input.issue,
      child: input.child,
      pid: input.pid,
      provider: input.provider,
      adapter: input.adapter,
      sessionId: input.sessionId,
      agentSessionId: input.agentSessionId,
      processIdentityToken: input.processIdentityToken,
      worktree: input.worktree,
      configDir: input.configDir,
      streamFile: input.streamFile,
      stderrFile: input.stderrFile,
      lastMessageFile: input.lastMessageFile,
      startOffset: input.startOffset,
      tail: new StreamTail(input.streamFile, input.tailFrom),
      timer: null,
      live: {
        startedAt: input.startedAt,
        turns: 0,
        lastText: null,
        lastTool: null,
        lastToolCommand: null,
        lastToolAt: null,
        toolRunning: false,
        reattached: input.reattached,
      },
      seen: emptyTotals(),
      stopping: false,
      replayUntilOffset: input.replayUntilOffset,
      observingLive: input.tailFrom === input.replayUntilOffset,
      pumping: false,
      settled: false,
      spawnError: null,
      finish: input.finish,
    };
    running.timer = setInterval(() => void this.#pump(running), this.opts.pollMs ?? 250);
    // The tail must never be the reason this process stays up.
    running.timer.unref();
    this.#running.set(input.issue, running);
    return running;
  }

  /** One pass of the tail: whatever complete lines have appeared, plus — for a
   *  worker we are only watching — the question of whether it is still there. */
  async #pump(r: Running): Promise<void> {
    if (r.settled || r.pumping) return;
    r.pumping = true;
    try {
      // Codex item events have no vendor timestamp. Events read from bytes that
      // were not present before this console started watching can be timed by
      // local observation. A re-attached backlog cannot: stamping it now would
      // turn replay time into a false tool-start time. If one read straddles the
      // fence, the whole batch stays untimestamped — a safe false negative.
      const observingLiveAtRead = r.observingLive;
      const lines = await r.tail.read();
      if (!r.observingLive && r.tail.offset >= r.replayUntilOffset) r.observingLive = true;
      if (lines.length > 0) {
        const observedAt = r.provider === 'codex' && observingLiveAtRead ? new Date().toISOString() : null;
        for (const line of lines) {
          const label = applyAgentStreamLine(r.provider, r.seen, line, { observedAt });
          if (label) this.opts.log?.(`#${r.issue} ${label}`);
        }
        if (r.seen.agentSessionId && r.seen.agentSessionId !== r.agentSessionId) {
          r.agentSessionId = r.seen.agentSessionId;
          this.opts.onAgentSession?.(r.issue, r.provider, r.agentSessionId);
        }
        r.live.turns = r.seen.turns;
        r.live.lastText = r.seen.lastText;
        r.live.lastTool = r.seen.lastTool;
        r.live.lastToolCommand = r.seen.lastToolCommand;
        r.live.lastToolAt = r.seen.lastToolAt;
        r.live.toolRunning = r.seen.toolRunning;
        this.opts.onChange();
      }
      this.opts.onProgress?.(r.issue, r.tail.offset);
      // A re-attached worker has no 'close' event to tell us it is over.
      if (r.child === null && !pidAlive(r.pid)) await this.#finish(r, null);
    } finally {
      r.pumping = false;
    }
  }

  async #finish(r: Running, code: number | null): Promise<void> {
    if (r.settled) return;
    r.settled = true;
    if (r.timer) clearInterval(r.timer);
    this.#running.delete(r.issue);

    const result = await runResultFrom({
      streamFile: r.streamFile,
      startOffset: r.startOffset,
      stderrFile: r.stderrFile,
      worktree: r.worktree,
      sessionId: r.sessionId,
      agentSessionId: r.agentSessionId,
      configDir: r.configDir,
      provider: r.provider,
      adapter: r.adapter,
      exitCode: code,
      stopping: r.stopping,
      spawnError: r.spawnError,
    });
    // A very short turn can exit before the first polling tick. The final file
    // parse still learns its provider session, and persistence must not depend
    // on winning that timer race.
    if (result.agentSessionId && result.agentSessionId !== r.agentSessionId) {
      r.agentSessionId = result.agentSessionId;
      this.opts.onAgentSession?.(r.issue, r.provider, result.agentSessionId);
    }
    this.opts.onChange();
    r.finish(result);
  }
}

/**
 * Turn a finished run's FILES into a RunResult. Every ending goes through here —
 * the child exiting under us, a re-attached worker's pid disappearing, and a run
 * the console finds already over after a restart — so all three produce the same
 * state and the same run record. That equivalence is the point: a worker that
 * ended while the console was down must be indistinguishable afterwards from one
 * that ended while it was up.
 */
export async function runResultFrom(input: {
  streamFile: string;
  startOffset: number;
  stderrFile: string;
  worktree: string;
  sessionId: string;
  agentSessionId?: string | null;
  configDir: string;
  provider?: AgentProviderId;
  adapter?: AgentProvider;
  /** Null when nobody was there to read it — a reconciled or re-attached run. */
  exitCode: number | null;
  stopping: boolean;
  spawnError: string | null;
}): Promise<RunResult> {
  const provider = input.provider ?? 'claude';
  const totals = await readTotals(input.streamFile, input.startOffset, provider);
  const agentSessionId = totals.agentSessionId ?? input.agentSessionId ?? (provider === 'claude' ? input.sessionId : null);
  const gate = await readGateFile(input.worktree);
  const transcript = input.adapter && agentSessionId
    ? await input.adapter.sessionActivity({
        worktree: input.worktree,
        configDir: input.configDir,
        agentSessionId,
      })
    : provider === 'claude'
      ? await mtimeMs(transcriptPath(input.worktree, agentSessionId ?? input.sessionId, input.configDir))
      : null;
  const stderr = (await tailFile(input.stderrFile, STDERR_TAIL_BYTES)).trim();

  // With no exit code, the absence of a `result` event is the only evidence we
  // have that the run did not finish — so it is what we go on, rather than
  // calling an unfinished run clean.
  const brokeOff = input.exitCode === null && !totals.sawResult;
  let outcome: RunResult['outcome'];
  if (input.stopping) outcome = 'stopped';
  else if (gate) outcome = 'gate';
  else if (
    input.spawnError ||
    totals.resultError ||
    (provider === 'codex' && agentSessionId === null) ||
    (input.exitCode !== null && input.exitCode !== 0) ||
    brokeOff
  ) {
    outcome = 'failed';
  } else outcome = 'finished';

  const error =
    outcome === 'failed'
      ? input.spawnError ||
        totals.resultError ||
        (provider === 'codex' && agentSessionId === null ? 'Codex exited without yielding a thread id' : '') ||
        stderr ||
        (input.exitCode !== null
          ? `worker exited with code ${input.exitCode}`
          : 'the worker ended without finishing, while the console was down')
      : null;

  return {
    provider,
    agentSessionId,
    outcome,
    gate,
    error,
    turns: totals.turns,
    transcriptMtimeMs: transcript,
    toolCalls: totals.toolCalls,
    usage: totals.usage,
    resolvedModel: totals.resolvedModel,
  };
}
