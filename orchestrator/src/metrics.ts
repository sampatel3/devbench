import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { modelLabel } from './models.js';
import type { AgentProviderId } from './providers/types.js';

const git = promisify(execFile);

/**
 * Per-run measurement, collected so that ONE question can be answered later with
 * evidence instead of taste: *for this segment of work, would a cheaper model
 * have done as well?* The router that question implies is deliberately NOT built
 * — building it now would mean guessing the answer and then measuring against
 * the guess.
 *
 * The unit of observation is a SEGMENT, not a stage. A worker runs from spawn
 * (or resume) until it stops at a gate and exits, and that is the only stretch
 * where one model was in force from end to end. Stages are the worker's own
 * bookkeeping inside a segment; a segment is where the switch points are.
 *
 * Three rules this file exists to keep:
 *
 *  - `runs.jsonl` is APPEND-ONLY. Nothing here rewrites, prunes or deletes it.
 *  - a field we did not actually observe is `null`, never a plausible zero.
 *    A fabricated number would be indistinguishable from a measured one exactly
 *    when it mattered.
 *  - a malformed line is skipped, not fatal. A log you cannot read at all is
 *    worse than one with a hole in it (the same rule as `.gate-history.jsonl`).
 */

/** Below this many runs in a cell, the numbers cannot support a decision. */
export const MIN_SAMPLE = 5;

// --------------------------------------------------------------- usage

/**
 * What one run cost, read off the `result` event of `--output-format stream-json`.
 *
 * The event really looks like this (from the CLI's own schema, claude-code
 * 2.x — `type:"result", subtype:"success", duration_ms, duration_api_ms,
 * is_error, num_turns, result, stop_reason, total_cost_usd, usage, modelUsage,
 * permission_denials, session_id, uuid`):
 *
 * ```json
 * {"type":"result","subtype":"success","is_error":false,"num_turns":34,
 *  "total_cost_usd":4.21,
 *  "usage":{"input_tokens":12,"cache_creation_input_tokens":19477,
 *           "cache_read_input_tokens":1044213,"output_tokens":8123,
 *           "server_tool_use":{"web_search_requests":0,"web_fetch_requests":0}},
 *  "modelUsage":{"claude-opus-5":{"inputTokens":12,"outputTokens":8123,
 *           "cacheReadInputTokens":1044213,"cacheCreationInputTokens":19477,
 *           "webSearchRequests":0,"costUSD":4.21,"contextWindow":200000,
 *           "maxOutputTokens":64000}}}
 * ```
 *
 * `modelUsage` is preferred and `usage` is the fallback, on the CLI's own
 * instruction: it documents `usage` as "MAIN AGENT LOOP ONLY — excludes Task
 * subagent, sidechain, and auxiliary model calls", while `modelUsage` covers
 * "main loop, Task subagents, sidechains, and internal calls". A console worker
 * is mostly subagents, so `usage` alone would undercount it badly.
 */
export type RunUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Provider-reported reasoning tokens. Codex exposes these separately; older
   * records and providers that do not report them stay null. */
  reasoningOutputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  /** the CLI's own turn count for the run */
  numTurns: number | null;
  /** which field the token numbers came out of, so a reader can tell */
  source: 'modelUsage' | 'usage' | 'codex' | null;
};

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Sum that stays null when nothing contributed a real number. */
function addUp(values: Array<number | null>): number | null {
  let total: number | null = null;
  for (const v of values) {
    if (v === null) continue;
    total = (total ?? 0) + v;
  }
  return total;
}

export function parseResultUsage(msg: Record<string, unknown>): RunUsage {
  const costUsd = numOrNull(msg.total_cost_usd);
  const numTurns = numOrNull(msg.num_turns);

  const modelUsage = msg.modelUsage;
  if (typeof modelUsage === 'object' && modelUsage !== null && Object.keys(modelUsage).length > 0) {
    const entries = Object.values(modelUsage as Record<string, unknown>).filter(
      (e): e is Record<string, unknown> => typeof e === 'object' && e !== null,
    );
    if (entries.length > 0) {
      return {
        inputTokens: addUp(entries.map((e) => numOrNull(e.inputTokens))),
        outputTokens: addUp(entries.map((e) => numOrNull(e.outputTokens))),
        reasoningOutputTokens: addUp(entries.map((e) => numOrNull(e.reasoningOutputTokens))),
        cacheReadTokens: addUp(entries.map((e) => numOrNull(e.cacheReadInputTokens))),
        cacheCreationTokens: addUp(entries.map((e) => numOrNull(e.cacheCreationInputTokens))),
        // costUSD per model is the same accounting total_cost_usd reports; take
        // the top-level number when it is there, and add the per-model ones up
        // only when it is not.
        costUsd: costUsd ?? addUp(entries.map((e) => numOrNull(e.costUSD))),
        numTurns,
        source: 'modelUsage',
      };
    }
  }

  const usage = msg.usage;
  if (typeof usage === 'object' && usage !== null) {
    const u = usage as Record<string, unknown>;
    return {
      inputTokens: numOrNull(u.input_tokens),
      outputTokens: numOrNull(u.output_tokens),
      reasoningOutputTokens: numOrNull(u.reasoning_output_tokens),
      cacheReadTokens: numOrNull(u.cache_read_input_tokens),
      cacheCreationTokens: numOrNull(u.cache_creation_input_tokens),
      costUsd,
      numTurns,
      source: 'usage',
    };
  }

  return {
    inputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd,
    numTurns,
    source: null,
  };
}

/** Codex reports token accounting on `turn.completed`, but no subscription
 * dollar cost. Keep the missing price null: zero would be a fabricated fact. */
export function parseCodexUsage(msg: Record<string, unknown>, numTurns: number): RunUsage {
  const usage = msg.usage;
  if (typeof usage !== 'object' || usage === null) {
    return {
      inputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costUsd: null,
      numTurns,
      source: 'codex',
    };
  }
  const u = usage as Record<string, unknown>;
  return {
    inputTokens: numOrNull(u.input_tokens),
    outputTokens: numOrNull(u.output_tokens),
    reasoningOutputTokens: numOrNull(u.reasoning_output_tokens),
    cacheReadTokens: numOrNull(u.cached_input_tokens),
    cacheCreationTokens: numOrNull(u.cache_write_input_tokens),
    costUsd: null,
    numTurns,
    source: 'codex',
  };
}

// ---------------------------------------------------------------- record

/** Why the run ended. A gate stop is the normal, healthy one. */
export type RunExit = 'gate' | 'exited-no-gate' | 'error';

export type RunRecord = {
  issue: number;
  /** Missing on records written before provider support: those runs are Claude. */
  provider?: AgentProviderId;
  /** The gate this segment ended at — 'A'…'E' — or 'none' when it exited without
   *  reaching one. This is the unit everything is grouped by. */
  segment: string;
  model: string;
  /** What `system.init` said the CLI actually resolved. Null if we never saw it. */
  resolvedModel: string | null;
  account: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Provider-owned conversation id. Missing on records written before provider support. */
  agentSessionId?: string | null;
  sessionId: string;
  exit: RunExit;
  error: string | null;

  /** The stage range this segment covered, as the worker's own files recorded it. */
  stageStart: number | null;
  stageEnd: number | null;

  inputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  /** assistant events we counted off the stream */
  assistantTurns: number | null;
  /** tool_use blocks we counted off the stream */
  toolCalls: number | null;
  usageSource: 'modelUsage' | 'usage' | 'codex' | null;

  /** How much work landed, so quality can be normalised against difficulty. */
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
  touchedMigration: boolean | null;
  labels: string[];

  /** How many times this issue had ALREADY stopped at this gate when the run
   *  ended, from `.gate-history.jsonl`. 0 = this was the first attempt at it. */
  gateStopsBefore: number | null;

  /** How long this run spent PAUSED (SIGSTOP, to give the machine its memory
   *  back). `durationMs` is wall-clock and stays that way; this is what has to
   *  be subtracted from it before a duration says anything about the model.
   *  Null on every record written before pausing existed — which reads as
   *  "unknown", not as zero. */
  pausedMs?: number | null;
};

/**
 * One run's identity. A segment can now be finalised down two different paths —
 * the console watching it end, or the console finding it already over after a
 * restart — and the same segment counted twice would be a fabricated run.
 * Issue, session and start time together name exactly one of them.
 */
export function runKey(r: { issue: number; sessionId: string; startedAt: string }): string {
  return `${r.issue}|${r.sessionId}|${r.startedAt}`;
}

/** Append one line, unless that exact run is already in there. Never rewrites the
 *  file; a failure is swallowed, because losing a measurement must never take a
 *  worker down with it. */
export async function appendRun(file: string, record: RunRecord): Promise<void> {
  const key = runKey(record);
  if ((await readRuns(file)).some((r) => runKey(r) === key)) return;
  await appendFile(file, JSON.stringify(record) + '\n').catch(() => {});
}

/**
 * Defensive parse: every line that is not a usable record is skipped. A
 * half-written line from a crash, or a field from a future version, cannot stop
 * the metrics page from rendering the rest.
 */
export function parseRuns(raw: string): RunRecord[] {
  const out: RunRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o !== 'object' || o === null) continue;
    const r = o as Record<string, unknown>;
    if (typeof r.issue !== 'number' || typeof r.model !== 'string' || !r.model) continue;
    if (typeof r.segment !== 'string' || !r.segment) continue;
    out.push({
      issue: r.issue,
      provider: r.provider === 'codex' ? 'codex' : 'claude',
      segment: r.segment,
      model: r.model,
      resolvedModel: typeof r.resolvedModel === 'string' ? r.resolvedModel : null,
      account: typeof r.account === 'string' ? r.account : '',
      startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
      endedAt: typeof r.endedAt === 'string' ? r.endedAt : '',
      durationMs: numOrNull(r.durationMs) ?? 0,
      agentSessionId: typeof r.agentSessionId === 'string' && r.agentSessionId ? r.agentSessionId : null,
      sessionId: typeof r.sessionId === 'string' ? r.sessionId : '',
      exit: r.exit === 'gate' || r.exit === 'exited-no-gate' || r.exit === 'error' ? r.exit : 'error',
      error: typeof r.error === 'string' ? r.error : null,
      stageStart: numOrNull(r.stageStart),
      stageEnd: numOrNull(r.stageEnd),
      inputTokens: numOrNull(r.inputTokens),
      outputTokens: numOrNull(r.outputTokens),
      reasoningOutputTokens: numOrNull(r.reasoningOutputTokens),
      cacheReadTokens: numOrNull(r.cacheReadTokens),
      cacheCreationTokens: numOrNull(r.cacheCreationTokens),
      costUsd: numOrNull(r.costUsd),
      assistantTurns: numOrNull(r.assistantTurns),
      toolCalls: numOrNull(r.toolCalls),
      usageSource:
        r.usageSource === 'modelUsage' || r.usageSource === 'usage' || r.usageSource === 'codex'
          ? r.usageSource
          : null,
      filesChanged: numOrNull(r.filesChanged),
      insertions: numOrNull(r.insertions),
      deletions: numOrNull(r.deletions),
      touchedMigration: typeof r.touchedMigration === 'boolean' ? r.touchedMigration : null,
      labels: Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === 'string') : [],
      gateStopsBefore: numOrNull(r.gateStopsBefore),
      // Absent on every record written before pausing existed, and null is the
      // honest reading of that: unknown, not zero.
      pausedMs: numOrNull(r.pausedMs),
    });
  }
  return out;
}

export async function readRuns(file: string): Promise<RunRecord[]> {
  return parseRuns(await readFile(file, 'utf8').catch(() => ''));
}

// ------------------------------------------------------------------ git

/** How much code a segment produced. Read-only git; nulls when we cannot tell. */
export type WorkStat = {
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
  touchedMigration: boolean | null;
};

const NO_WORK_STAT: WorkStat = {
  filesChanged: null,
  insertions: null,
  deletions: null,
  touchedMigration: null,
};

export async function gitHead(worktree: string): Promise<string | null> {
  return git('git', ['-C', worktree, 'rev-parse', 'HEAD'], { timeout: 10_000 })
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null);
}

/** Files touched by migrations are the riskiest work this repo does, so they get
 *  their own flag rather than hiding inside a file count. */
export const MIGRATION_PATH = 'supabase/migrations/';

/**
 * What landed between `fromSha` and HEAD — the commits this segment made. Read
 * only: `git diff --numstat`, nothing that writes. An unreadable repo, or a
 * commit that has since been rebased away, gives nulls rather than zeros.
 */
export async function workStat(worktree: string, fromSha: string | null): Promise<WorkStat> {
  if (!fromSha) return NO_WORK_STAT;
  const head = await gitHead(worktree);
  if (!head) return NO_WORK_STAT;
  if (head === fromSha) return { filesChanged: 0, insertions: 0, deletions: 0, touchedMigration: false };

  const stdout = await git('git', ['-C', worktree, 'diff', '--numstat', `${fromSha}..${head}`], {
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  })
    .then((r) => r.stdout)
    .catch(() => null);
  if (stdout === null) return NO_WORK_STAT;

  let files = 0;
  let insertions = 0;
  let deletions = 0;
  let migration = false;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split('\t');
    const path = rest.join('\t');
    files += 1;
    // A binary file is reported as `-\t-\t<path>`; it counts as a file, not lines.
    insertions += Number(add) || 0;
    deletions += Number(del) || 0;
    if (path.includes(MIGRATION_PATH)) migration = true;
  }
  return { filesChanged: files, insertions, deletions, touchedMigration: migration };
}

// ------------------------------------------------------- the read-time join

/**
 * The quality signals that are NOT known when a run ends, joined in at READ
 * time against live state rather than back-written into the log:
 *
 *  - whether the gate was approved first time, and how many rounds of feedback
 *    it took, is only settled once the operator has answered it;
 *  - a rework round arrives days after the run that caused it;
 *  - CI can go red long after the worker exited.
 *
 * Back-writing them would mean rewriting an append-only file, so the log stays
 * as written and this is where the later story gets attached.
 */
export type LateSignals = {
  /** issue -> gate letter -> how many RESOLVED stops at it are in the live gate
   *  history. A missing issue means we cannot tell (no worktree any more). */
  gateStops: Record<string, Record<string, number>>;
  /** issue -> the gate it is parked at right now, if any. That stop has not been
   *  decided yet, so nothing about its approval is knowable. */
  openGate: Record<string, string>;
  /** issue -> when each rework round was requested. An issue with a PR and no
   *  rework belongs here as an empty array; a missing issue means "no PR, so we
   *  cannot tell", which is a different answer from zero. */
  reworkRequestedAt: Record<string, string[]>;
  /** issue -> is CI red on its open PR right now. Missing = we could not tell. */
  ciRed: Record<string, boolean>;
};

export const EMPTY_SIGNALS: LateSignals = { gateStops: {}, openGate: {}, reworkRequestedAt: {}, ciRed: {} };

export type JoinedRun = {
  /** null = not knowable yet (the gate is still open, or this run was not the
   *  first attempt at it, or the worktree is gone). */
  approvedFirstTime: boolean | null;
  /** rounds of feedback before that gate passed. Null on the same terms. */
  feedbackRounds: number | null;
  /** rework rounds attributed to this run. Null when the issue has no PR. */
  reworkRounds: number | null;
  ciRed: boolean | null;
};

/**
 * A rework round belongs to the run that produced the code it criticises: the
 * last run of that issue to END before the round was requested. Without that,
 * every run on a much-reviewed issue would carry every round.
 */
function reworkFor(run: RunRecord, allRuns: RunRecord[], requestedAt: string[] | undefined): number | null {
  if (!requestedAt) return null;
  const mine = allRuns
    .filter((r) => r.issue === run.issue && Date.parse(r.endedAt))
    .sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
  const myEnd = Date.parse(run.endedAt);
  if (!Number.isFinite(myEnd)) return null;
  const nextEnd = mine.find((r) => Date.parse(r.endedAt) > myEnd)?.endedAt;
  const upper = nextEnd ? Date.parse(nextEnd) : Infinity;
  return requestedAt.filter((iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= myEnd && t < upper;
  }).length;
}

export function joinRun(run: RunRecord, allRuns: RunRecord[], late: LateSignals): JoinedRun {
  const key = String(run.issue);
  const ciRed = key in late.ciRed ? late.ciRed[key]! : null;
  const reworkRounds = reworkFor(run, allRuns, late.reworkRequestedAt[key]);

  const stops = late.gateStops[key]?.[run.segment];
  const stillOpen = late.openGate[key] === run.segment;
  // Only the FIRST attempt at a gate can be "approved first time", and only once
  // the gate has actually been decided.
  if (run.exit !== 'gate' || stops === undefined || stillOpen || run.gateStopsBefore !== 0) {
    return { approvedFirstTime: null, feedbackRounds: null, reworkRounds, ciRed };
  }
  return { approvedFirstTime: stops === 1, feedbackRounds: Math.max(0, stops - 1), reworkRounds, ciRed };
}

// ------------------------------------------------------------- aggregates

/** A rate or a mean, always carried WITH the number of runs behind it. A figure
 *  without its n is the thing this whole page exists not to print. */
export type Measure = { n: number; value: number };

export type Cell = {
  provider: AgentProviderId;
  model: string;
  /** Profiles and provider sessions represented in this aggregate cell. The raw
   * append-only records remain authoritative; these make provenance visible. */
  accounts: string[];
  sessions: string[];
  segment: string;
  /** runs in this cell — the sample count shown on every figure */
  runs: number;
  medianDurationMs: number | null;
  medianOutputTokens: number | null;
  medianReasoningOutputTokens: number | null;
  medianCostUsd: number | null;
  /** median files changed — the difficulty this cell's runs were actually up against */
  medianFilesChanged: number | null;
  firstTimeApproval: Measure | null;
  gateFeedback: Measure | null;
  rework: Measure | null;
  ciRed: Measure | null;
  /** false when this cell has fewer than MIN_SAMPLE runs */
  enough: boolean;
};

export type MetricsReport = {
  cells: Cell[];
  models: string[];
  segments: string[];
  totalRuns: number;
  minSample: number;
  /** true only when EVERY cell clears the threshold */
  enough: boolean;
  /** The one line the page must print when it cannot support a conclusion. */
  caveat: string | null;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const SEGMENT_ORDER = ['A', 'B', 'C', 'D', 'E', 'none'];

function rate(flags: Array<boolean | null>): Measure | null {
  const known = flags.filter((f): f is boolean => f !== null);
  if (known.length === 0) return null;
  return { n: known.length, value: known.filter(Boolean).length / known.length };
}

function mean(values: Array<number | null>): Measure | null {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) return null;
  return { n: known.length, value: known.reduce((a, b) => a + b, 0) / known.length };
}

/**
 * Per model × per segment, with the sample count on every cell. Deliberately
 * absent: rankings, trends, arrows and any "recommended model" — none of those
 * are supportable at the sample sizes this console produces (MAX_ACTIVE = 1,
 * one issue at a time), and a page that implies a conclusion it cannot support
 * is worse than no page.
 */
export function aggregate(runs: RunRecord[], late: LateSignals = EMPTY_SIGNALS): MetricsReport {
  const joined = runs.map((r) => ({ run: r, late: joinRun(r, runs, late) }));

  const models = [...new Set(runs.map((r) => `${r.provider ?? 'claude'}:${r.model}`))].sort();
  const segments = [...new Set(runs.map((r) => r.segment))].sort(
    (a, b) =>
      (SEGMENT_ORDER.indexOf(a) === -1 ? 99 : SEGMENT_ORDER.indexOf(a)) -
      (SEGMENT_ORDER.indexOf(b) === -1 ? 99 : SEGMENT_ORDER.indexOf(b)),
  );

  const cells: Cell[] = [];
  for (const modelKey of models) {
    const separator = modelKey.indexOf(':');
    const provider = modelKey.slice(0, separator) as AgentProviderId;
    const model = modelKey.slice(separator + 1);
    for (const segment of segments) {
      const mine = joined.filter(
        (j) => (j.run.provider ?? 'claude') === provider && j.run.model === model && j.run.segment === segment,
      );
      if (mine.length === 0) continue; // an empty cell is not a measurement
      const nums = (pick: (r: RunRecord) => number | null) =>
        mine.map((j) => pick(j.run)).filter((v): v is number => v !== null);
      cells.push({
        provider,
        model,
        accounts: [...new Set(mine.map((j) => j.run.account).filter(Boolean))].sort(),
        sessions: [
          ...new Set(mine.map((j) => j.run.agentSessionId ?? j.run.sessionId).filter(Boolean)),
        ].sort(),
        segment,
        runs: mine.length,
        medianDurationMs: median(nums((r) => r.durationMs)),
        medianOutputTokens: median(nums((r) => r.outputTokens)),
        medianReasoningOutputTokens: median(nums((r) => r.reasoningOutputTokens)),
        medianCostUsd: median(nums((r) => r.costUsd)),
        medianFilesChanged: median(nums((r) => r.filesChanged)),
        firstTimeApproval: rate(mine.map((j) => j.late.approvedFirstTime)),
        gateFeedback: mean(mine.map((j) => j.late.feedbackRounds)),
        rework: rate(mine.map((j) => (j.late.reworkRounds === null ? null : j.late.reworkRounds > 0))),
        ciRed: rate(mine.map((j) => j.late.ciRed)),
        enough: mine.length >= MIN_SAMPLE,
      });
    }
  }

  const thin = cells.filter((c) => !c.enough).length;
  const caveat =
    runs.length === 0
      ? 'Nothing has been logged yet. Every worker run from now on appends one line, and this table fills in from that.'
      : thin > 0
        ? `Not enough data to conclude anything: ${thin} of ${cells.length} ` +
          `${cells.length === 1 ? 'cell has' : 'cells have'} fewer than ${MIN_SAMPLE} runs. ` +
          `Nothing here can support a routing decision yet — read the counts, not the differences.`
        : null;

  return {
    cells,
    models,
    segments,
    totalRuns: runs.length,
    minSample: MIN_SAMPLE,
    enough: cells.length > 0 && thin === 0,
    caveat,
  };
}

// ------------------------------------------------------- router readiness

/**
 * The question the table cannot answer by being read: *can I make the router
 * decision yet?* One sentence, and the thing that would change the answer.
 *
 * The criterion that matters most is the one a grid hides: **a comparison is
 * impossible while every run is on the same model.** Opus 5 is the default, so
 * without saying this plainly you could accumulate a year of single-model runs
 * that can never answer the question. Everything else — sample size, which
 * segment — comes second to that.
 *
 * It reports readiness and nothing else: no ranking, no trend, no model
 * suggested as the answer. Which model wins is exactly the question the data is
 * being collected to settle.
 */
export type RouterReadiness = {
  /** True only when some segment has MIN_SAMPLE runs under two or more models. */
  ready: boolean;
  /** The whole answer, in one plain sentence. */
  headline: string;
  /** What would change it. Null once it is already yes. */
  next: string | null;
};

/**
 * Never label a segment with a word that can start a sentence as a negation.
 * 'none' used to render as "no gate", which turned the ready verdict into
 * "There is enough to compare now: no gate has 5 Opus 5 / 5 Sonnet 5" — a
 * sentence that reads as its own opposite — the operator could not tell from it
 * whether there was enough data or not enough.
 */
const segmentLabel = (segment: string) => (segment === 'none' ? 'ungated work' : `gate ${segment}`);
const providerModelLabel = (provider: AgentProviderId, model: string) =>
  `${provider === 'codex' ? 'Codex' : 'Claude'} · ${modelLabel(model)}`;
const modelIdentityLabel = (identity: string) => {
  const match = identity.match(/^(claude|codex):(.*)$/s);
  return match ? providerModelLabel(match[1] as AgentProviderId, match[2]!) : modelLabel(identity);
};

export function routerReadiness(report: MetricsReport): RouterReadiness {
  const { cells, models, totalRuns, minSample } = report;

  if (totalRuns === 0 || models.length === 0) {
    return {
      ready: false,
      headline: 'Not yet — no worker runs have been logged, so there is nothing to compare.',
      next: 'Every run a worker finishes appends one line to runs.jsonl, and this fills in from that.',
    };
  }

  // THE criterion. One model is not a comparison, however many runs it has.
  if (models.length === 1) {
    const only = modelIdentityLabel(models[0]!);
    return {
      ready: false,
      headline:
        `Not yet — all ${totalRuns} run${totalRuns === 1 ? '' : 's'} so far are under ${only}, ` +
        `and one model cannot be compared with itself.`,
      next:
        `Pick a different model on a couple of issues — the "Run on" control at preflight — to start the ` +
        `other side of the comparison. Until then this number cannot move, however long you wait.`,
    };
  }

  // Two models is not enough on its own: they have to meet in the same segment,
  // because a segment is the only stretch with one model in force end to end.
  const comparable = report.segments
    .map((segment) => ({
      segment,
      enoughCells: cells.filter((c) => c.segment === segment && c.runs >= minSample),
      cells: cells.filter((c) => c.segment === segment),
    }))
    .filter((s) => s.enoughCells.length >= 2);

  if (comparable.length > 0) {
    const where = comparable
      .map((s) =>
        `${segmentLabel(s.segment)} — ${s.enoughCells
          .map((c) => `${c.runs} on ${providerModelLabel(c.provider, c.model)}`)
          .join(' vs ')}`,
      )
      .join('; ');
    return {
      ready: true,
      // "Yes" first, so the answer survives even if nothing else is read. The
      // evidence follows the verdict; it never leads, because a segment name at
      // the front of the clause is what made this sentence unreadable before.
      headline: `Yes — enough to compare. ${where}.`,
      next: null,
    };
  }

  // Not there yet. Name the segment that is closest, so the next few runs can be
  // aimed at it rather than spread thin.
  const closest = report.segments
    .map((segment) => {
      const mine = cells.filter((c) => c.segment === segment).sort((a, b) => b.runs - a.runs);
      return { segment, mine, second: mine[1]?.runs ?? 0 };
    })
    .filter((s) => s.mine.length >= 2)
    .sort((a, b) => b.second - a.second)[0];

  if (!closest) {
    return {
      ready: false,
      headline:
        `Not yet — ${totalRuns} runs across ${models.length} models, but no single segment has runs under ` +
        `two of them, so there is nothing that can be set side by side.`,
      next: `Aim for about ${minSample} runs per model within the same segment.`,
    };
  }

  const spread = closest.mine
    .map((c) => `${c.runs} ${providerModelLabel(c.provider, c.model)}`)
    .join(' / ');
  return {
    ready: false,
    headline:
      `Not yet — ${totalRuns} runs across ${models.length} models, but the closest segment ` +
      `(${segmentLabel(closest.segment)}) has only ${spread}.`,
    next: `Aim for about ${minSample} runs per model within one segment; ${segmentLabel(closest.segment)} is nearest.`,
  };
}
