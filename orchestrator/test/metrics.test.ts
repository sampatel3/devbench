import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIN_SAMPLE,
  aggregate,
  appendRun,
  joinRun,
  parseCodexUsage,
  parseResultUsage,
  parseRuns,
  readRuns,
  routerReadiness,
  workStat,
  type LateSignals,
  type RunRecord,
} from '../src/metrics.js';

/**
 * The measurement layer. Three things are being defended here: the log is
 * append-only and unbreakable by a bad line, a number we did not observe is null
 * rather than a plausible zero, and the aggregates never imply more than the
 * sample size supports.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-metrics-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  issue: 4336,
  provider: 'claude',
  segment: 'C',
  model: 'claude-opus-5',
  resolvedModel: 'claude-opus-5',
  account: 'personal',
  startedAt: '2026-08-11T10:00:00.000Z',
  endedAt: '2026-08-11T10:30:00.000Z',
  durationMs: 1_800_000,
  agentSessionId: null,
  sessionId: 'sess-1',
  exit: 'gate',
  error: null,
  stageStart: 3,
  stageEnd: 5,
  inputTokens: 100,
  outputTokens: 2000,
  reasoningOutputTokens: null,
  cacheReadTokens: 50_000,
  cacheCreationTokens: 9000,
  costUsd: 1.5,
  assistantTurns: 20,
  toolCalls: 40,
  usageSource: 'modelUsage',
  filesChanged: 6,
  insertions: 120,
  deletions: 30,
  touchedMigration: false,
  labels: ['bug'],
  gateStopsBefore: 0,
  ...over,
});

// --------------------------------------------------------- the result event

describe('parseResultUsage — the stream-json result event', () => {
  /**
   * The real shape, from the CLI's own schema: `usage` is the main agent loop
   * only, `modelUsage` covers Task subagents and sidechains as well. The CLI
   * documents "prefer modelUsage for token/cost accounting", and a issue-pipeline
   * worker is mostly subagents.
   */
  it('prefers modelUsage, and sums it across every model the run used', () => {
    const usage = parseResultUsage({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 34,
      total_cost_usd: 4.21,
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 19_477,
        cache_read_input_tokens: 1_044_213,
        output_tokens: 8123,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      },
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 12,
          outputTokens: 8123,
          cacheReadInputTokens: 1_044_213,
          cacheCreationInputTokens: 19_477,
          costUSD: 3.9,
        },
        'claude-haiku-4-5-20251001': {
          inputTokens: 4,
          outputTokens: 900,
          cacheReadInputTokens: 1000,
          cacheCreationInputTokens: 200,
          costUSD: 0.31,
        },
      },
    });
    expect(usage.source).toBe('modelUsage');
    expect(usage.inputTokens).toBe(16);
    expect(usage.outputTokens).toBe(9023);
    expect(usage.reasoningOutputTokens).toBeNull();
    expect(usage.cacheReadTokens).toBe(1_045_213);
    expect(usage.cacheCreationTokens).toBe(19_677);
    expect(usage.costUsd).toBe(4.21);
    expect(usage.numTurns).toBe(34);
  });

  it('falls back to usage when there is no modelUsage', () => {
    const usage = parseResultUsage({
      type: 'result',
      total_cost_usd: 0.5,
      num_turns: 3,
      usage: { input_tokens: 7, output_tokens: 11, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
    });
    expect(usage.source).toBe('usage');
    expect(usage.inputTokens).toBe(7);
    expect(usage.outputTokens).toBe(11);
  });

  // The rule that keeps the log honest: a field that is not there is null, so a
  // missing measurement can never be mistaken for a measured zero.
  it('records null for a field that is not there, not zero', () => {
    const usage = parseResultUsage({ type: 'result', is_error: true, result: 'auth failed' });
    expect(usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costUsd: null,
      numTurns: null,
      source: null,
    });
  });

  it('keeps the cost even when only the top-level field is present', () => {
    expect(parseResultUsage({ type: 'result', total_cost_usd: 2.5, modelUsage: {} }).costUsd).toBe(2.5);
  });

  it('keeps Codex reasoning tokens separate from visible output and never invents a dollar cost', () => {
    expect(
      parseCodexUsage(
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 120,
            cached_input_tokens: 80,
            output_tokens: 45,
            reasoning_output_tokens: 31,
          },
        },
        3,
      ),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      reasoningOutputTokens: 31,
      cacheReadTokens: 80,
      cacheCreationTokens: null,
      costUsd: null,
      numTurns: 3,
      source: 'codex',
    });
  });
});

// ------------------------------------------------------------- the log file

describe('runs.jsonl', () => {
  it('appends one line per run and never rewrites what is there', async () => {
    const file = join(dir, 'runs.jsonl');
    await appendRun(file, run({ sessionId: 'sess-1' }));
    const afterFirst = readFileSync(file, 'utf8');
    await appendRun(file, run({ sessionId: 'sess-2' }));
    const afterSecond = readFileSync(file, 'utf8');

    expect(afterSecond.startsWith(afterFirst)).toBe(true); // the first line is untouched
    expect(afterSecond.trim().split('\n')).toHaveLength(2);
    expect((await readRuns(file)).map((r) => r.sessionId)).toEqual(['sess-1', 'sess-2']);
  });

  it('skips a malformed line instead of dying on it', () => {
    const raw = [
      JSON.stringify(run({ sessionId: 'good-1' })),
      '{"issue": 4336, "segment": "C", trunca', // a crash mid-write
      '',
      'not json at all',
      JSON.stringify({ issue: 4336 }), // valid JSON, not a usable record
      JSON.stringify(run({ sessionId: 'good-2' })),
    ].join('\n');
    const parsed = parseRuns(raw);
    expect(parsed.map((r) => r.sessionId)).toEqual(['good-1', 'good-2']);
  });

  it('reads a file that does not exist as no runs, not as an error', async () => {
    expect(await readRuns(join(dir, 'nothing-here.jsonl'))).toEqual([]);
  });

  it('keeps nulls as nulls through a round trip', async () => {
    const file = join(dir, 'runs.jsonl');
    await appendRun(
      file,
      run({ outputTokens: null, reasoningOutputTokens: null, costUsd: null, touchedMigration: null }),
    );
    const [back] = await readRuns(file);
    expect(back!.outputTokens).toBeNull();
    expect(back!.reasoningOutputTokens).toBeNull();
    expect(back!.costUsd).toBeNull();
    expect(back!.touchedMigration).toBeNull();
  });
});

// ------------------------------------------------------------- git work stat

describe('workStat — how much code the segment produced', () => {
  it('counts files, lines and whether a migration was touched', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'wc-stat-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git(['init', '-b', 'dev']);
    git(['config', 'user.email', 'x@y.z']);
    git(['config', 'user.name', 'x']);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(['add', '-A']);
    git(['commit', '-m', 'base']);
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

    execFileSync('mkdir', ['-p', join(repo, 'supabase', 'migrations')]);
    writeFileSync(join(repo, 'supabase', 'migrations', '001_x.sql'), 'select 1;\n');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    git(['add', '-A']);
    git(['commit', '-m', 'work']);

    const stat = await workStat(repo, before);
    expect(stat.filesChanged).toBe(2);
    expect(stat.insertions).toBe(2);
    expect(stat.touchedMigration).toBe(true);

    // A run that committed nothing is a real zero, not an unknown.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(await workStat(repo, head)).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      touchedMigration: false,
    });
    rmSync(repo, { recursive: true, force: true });
  });

  it('gives nulls rather than zeros when it cannot read the repo', async () => {
    const stat = await workStat(join(dir, 'not-a-repo'), 'deadbeef');
    expect(stat).toEqual({ filesChanged: null, insertions: null, deletions: null, touchedMigration: null });
  });
});

// ------------------------------------------------------- the read-time join

describe('the read-time join with signals that arrive later', () => {
  const signals = (over: Partial<LateSignals> = {}): LateSignals => ({
    gateStops: {},
    openGate: {},
    reworkRequestedAt: {},
    ciRed: {},
    ...over,
  });

  it('says a gate passed first time when the live history has exactly one stop at it', () => {
    const r = run({ gateStopsBefore: 0 });
    const j = joinRun(r, [r], signals({ gateStops: { '4336': { C: 1 } } }));
    expect(j.approvedFirstTime).toBe(true);
    expect(j.feedbackRounds).toBe(0);
  });

  it('counts the rounds of feedback the gate actually took', () => {
    const r = run({ gateStopsBefore: 0 });
    const j = joinRun(r, [r], signals({ gateStops: { '4336': { C: 3 } } }));
    expect(j.approvedFirstTime).toBe(false);
    expect(j.feedbackRounds).toBe(2);
  });

  // The honesty case: a gate nobody has answered yet has not failed, and it has
  // not passed. It must contribute to neither figure.
  it('knows nothing about a gate that is still open', () => {
    const r = run({ gateStopsBefore: 0 });
    const j = joinRun(r, [r], signals({ gateStops: { '4336': { C: 0 } }, openGate: { '4336': 'C' } }));
    expect(j.approvedFirstTime).toBeNull();
    expect(j.feedbackRounds).toBeNull();
  });

  it('knows nothing when the worktree is gone, rather than guessing', () => {
    const r = run();
    expect(joinRun(r, [r], signals()).approvedFirstTime).toBeNull();
  });

  it('attributes a rework round to the run whose code the reviewer was looking at', () => {
    const first = run({ sessionId: 'a', endedAt: '2026-08-11T10:00:00.000Z' });
    const second = run({ sessionId: 'b', endedAt: '2026-08-11T14:00:00.000Z' });
    const all = [first, second];
    const late = signals({ reworkRequestedAt: { '4336': ['2026-08-11T12:00:00.000Z', '2026-08-11T15:00:00.000Z'] } });
    expect(joinRun(first, all, late).reworkRounds).toBe(1);
    expect(joinRun(second, all, late).reworkRounds).toBe(1);
  });

  // "No PR yet" and "a PR nobody asked for changes on" are different answers.
  it('separates a real zero from an unknown', () => {
    const r = run();
    expect(joinRun(r, [r], signals({ reworkRequestedAt: { '4336': [] } })).reworkRounds).toBe(0);
    expect(joinRun(r, [r], signals()).reworkRounds).toBeNull();
  });

  it('carries CI through only for an issue we could read it for', () => {
    const r = run();
    expect(joinRun(r, [r], signals({ ciRed: { '4336': true } })).ciRed).toBe(true);
    expect(joinRun(r, [r], signals()).ciRed).toBeNull();
  });
});

// -------------------------------------------------------------- aggregates

describe('aggregate', () => {
  it('groups by model and segment, and does the medians', () => {
    const runs = [
      run({ model: 'claude-opus-5', segment: 'C', durationMs: 1000, outputTokens: 100 }),
      run({ model: 'claude-opus-5', segment: 'C', durationMs: 3000, outputTokens: 300 }),
      run({ model: 'claude-opus-5', segment: 'C', durationMs: 2000, outputTokens: 200 }),
      run({ model: 'claude-haiku-4-5-20251001', segment: 'A', durationMs: 500, outputTokens: 50 }),
    ];
    const report = aggregate(runs);
    expect(report.totalRuns).toBe(4);
    expect(report.cells).toHaveLength(2);

    const opus = report.cells.find((c) => c.model === 'claude-opus-5' && c.segment === 'C')!;
    expect(opus.runs).toBe(3);
    expect(opus.medianDurationMs).toBe(2000);
    expect(opus.medianOutputTokens).toBe(200);
  });

  it('keeps the same model ID separate by provider and exposes profile, session, and reasoning provenance', () => {
    const report = aggregate([
      run({
        provider: 'claude',
        model: 'shared-model',
        account: 'claude-work',
        agentSessionId: 'claude-agent-session',
        sessionId: 'claude-session',
        reasoningOutputTokens: null,
      }),
      run({
        provider: 'codex',
        model: 'shared-model',
        account: 'codex-work',
        agentSessionId: 'codex-agent-session-a',
        sessionId: 'codex-session-a',
        reasoningOutputTokens: 30,
      }),
      run({
        provider: 'codex',
        model: 'shared-model',
        account: 'codex-work',
        agentSessionId: 'codex-agent-session-b',
        sessionId: 'codex-session-b',
        reasoningOutputTokens: 50,
      }),
    ]);

    expect(report.cells).toHaveLength(2);
    expect(report.models).toEqual(['claude:shared-model', 'codex:shared-model']);
    expect(report.cells.find((cell) => cell.provider === 'claude')).toMatchObject({
      accounts: ['claude-work'],
      sessions: ['claude-agent-session'],
      medianReasoningOutputTokens: null,
    });
    expect(report.cells.find((cell) => cell.provider === 'codex')).toMatchObject({
      accounts: ['codex-work'],
      sessions: ['codex-agent-session-a', 'codex-agent-session-b'],
      medianReasoningOutputTokens: 40,
    });
  });

  it('averages an even-sized sample rather than picking one side', () => {
    const runs = [run({ durationMs: 1000 }), run({ durationMs: 2000 })];
    expect(aggregate(runs).cells[0]!.medianDurationMs).toBe(1500);
  });

  it('leaves an empty model × segment combination out entirely', () => {
    const runs = [run({ model: 'claude-opus-5', segment: 'C' }), run({ model: 'claude-sonnet-5', segment: 'A' })];
    // Two models × two segments is four boxes, but only two were ever run.
    expect(aggregate(runs).cells).toHaveLength(2);
  });

  it('carries the n behind every rate and mean, not just the cell', () => {
    const runs = [
      run({ sessionId: 'a', gateStopsBefore: 0, endedAt: '2026-08-11T10:00:00.000Z' }),
      run({ sessionId: 'b', issue: 4342, gateStopsBefore: 0, endedAt: '2026-08-11T10:00:00.000Z' }),
    ];
    const late: LateSignals = {
      gateStops: { '4336': { C: 1 } }, // only one of the two issues can be judged
      openGate: {},
      reworkRequestedAt: { '4336': [] },
      ciRed: {},
    };
    const cell = aggregate(runs, late).cells[0]!;
    expect(cell.runs).toBe(2);
    expect(cell.firstTimeApproval).toEqual({ n: 1, value: 1 });
    expect(cell.gateFeedback).toEqual({ n: 1, value: 0 });
    expect(cell.rework).toEqual({ n: 1, value: 0 });
    expect(cell.ciRed).toBeNull(); // nothing known, so nothing claimed
  });

  it('sorts segments in gate order, with the no-gate runs last', () => {
    const runs = [
      run({ segment: 'none' }),
      run({ segment: 'D' }),
      run({ segment: 'A' }),
    ];
    expect(aggregate(runs).segments).toEqual(['A', 'D', 'none']);
  });
});

describe('the honesty threshold', () => {
  const many = (n: number, over: Partial<RunRecord> = {}) => Array.from({ length: n }, () => run(over));

  it('says outright that a thin cell cannot support a decision', () => {
    const report = aggregate(many(MIN_SAMPLE - 1));
    expect(report.cells[0]!.enough).toBe(false);
    expect(report.enough).toBe(false);
    expect(report.caveat).toContain('Not enough data');
    expect(report.caveat).toContain(`fewer than ${MIN_SAMPLE} runs`);
  });

  it('clears the caveat exactly at the threshold, not before', () => {
    expect(aggregate(many(MIN_SAMPLE - 1)).caveat).not.toBeNull();
    const atThreshold = aggregate(many(MIN_SAMPLE));
    expect(atThreshold.cells[0]!.enough).toBe(true);
    expect(atThreshold.enough).toBe(true);
    expect(atThreshold.caveat).toBeNull();
  });

  it('holds the caveat while ANY cell is thin, however good the others are', () => {
    const report = aggregate([...many(MIN_SAMPLE * 3), ...many(1, { model: 'claude-sonnet-5' })]);
    expect(report.enough).toBe(false);
    expect(report.caveat).toContain(`1 of ${report.cells.length}`);
  });

  it('says so plainly when nothing has been logged at all', () => {
    const report = aggregate([]);
    expect(report.cells).toEqual([]);
    expect(report.enough).toBe(false);
    expect(report.caveat).toContain('Nothing has been logged yet');
  });

  // The whole point of the page: it reports counts, and it does not rank.
  it('never produces a ranking, a trend or a recommendation', () => {
    const report = aggregate([...many(10), ...many(10, { model: 'claude-haiku-4-5-20251001', durationMs: 1 })]);
    const asText = JSON.stringify(report);
    for (const word of FORBIDDEN) {
      expect(asText.toLowerCase()).not.toContain(word);
    }
    expect(Object.keys(report.cells[0]!)).not.toContain('rank');
  });
});

/** The words a page at these sample sizes must never print. */
const FORBIDDEN = ['recommend', 'best', 'better', 'worse', 'rank', 'trend', 'winner'];

/**
 * The Dashboard card answers one question — *can I make the router decision
 * yet?* — and the criterion most likely to be missed is the one a grid hides:
 * while every run is under the same model there is nothing to compare, and no
 * amount of waiting changes that. Opus 5 is the default, so that is the case
 * this is most likely to actually be in.
 */
describe('routerReadiness — can the decision be made yet', () => {
  const many = (n: number, over: Partial<RunRecord> = {}) => Array.from({ length: n }, () => run(over));
  const readiness = (runs: RunRecord[]) => routerReadiness(aggregate(runs));

  it('says nothing has been logged when nothing has', () => {
    const r = readiness([]);
    expect(r.ready).toBe(false);
    expect(r.headline).toContain('no worker runs have been logged');
  });

  // THE one. Fourteen runs and a full-looking table, and still no comparison.
  it('says plainly that one model cannot be compared with itself, and what would change it', () => {
    const r = readiness(many(14, { model: 'claude-opus-5' }));
    expect(r.ready).toBe(false);
    expect(r.headline).toContain('all 14 runs');
    expect(r.headline).toContain('Opus 5');
    expect(r.headline).toContain('cannot be compared with itself');
    expect(r.next).toContain('different model');
    expect(r.next).toContain('Run on');
  });

  it('names the closest segment while two models are still thin', () => {
    const r = readiness([
      ...many(MIN_SAMPLE + 2, { segment: 'C', model: 'claude-opus-5' }),
      ...many(2, { segment: 'C', model: 'claude-sonnet-5' }),
    ]);
    expect(r.ready).toBe(false);
    expect(r.headline).toContain('2 models');
    expect(r.headline).toContain('gate C');
    expect(r.headline).toContain('2 Claude · Sonnet 5');
    expect(r.next).toContain(`about ${MIN_SAMPLE} runs per model`);
  });

  it('says two models that never met in the same segment cannot be set side by side', () => {
    const r = readiness([
      ...many(MIN_SAMPLE + 2, { segment: 'C', model: 'claude-opus-5' }),
      ...many(MIN_SAMPLE + 2, { segment: 'D', model: 'claude-sonnet-5' }),
    ]);
    expect(r.ready).toBe(false);
    expect(r.headline).toContain('no single segment');
  });

  it('says there is enough once a segment has the sample under two models', () => {
    const r = readiness([
      ...many(MIN_SAMPLE + 2, { segment: 'C', model: 'claude-opus-5' }),
      ...many(MIN_SAMPLE + 1, { segment: 'C', model: 'claude-sonnet-5' }),
    ]);
    expect(r.ready).toBe(true);
    // The verdict leads, the evidence follows. It used to read "There is enough
    // to compare now: no gate has 5 Opus 5 / 5 Sonnet 5" — a sentence whose own
    // segment label ("no gate") made it parse as its opposite.
    expect(r.headline.startsWith('Yes — enough to compare.')).toBe(true);
    expect(r.headline).toContain('gate C');
    expect(r.headline).toContain(`${MIN_SAMPLE + 2} on Claude · Opus 5`);
    expect(r.headline).toContain(`${MIN_SAMPLE + 1} on Claude · Sonnet 5`);
    expect(r.next).toBeNull();
  });

  // The same honesty rule as the table: it reports readiness, never a verdict.
  it('never ranks, trends or recommends, in any of its states', () => {
    const states = [
      readiness([]),
      readiness(many(14)),
      readiness([...many(7, { segment: 'C' }), ...many(2, { segment: 'C', model: 'claude-sonnet-5' })]),
      readiness([...many(7, { segment: 'C' }), ...many(6, { segment: 'C', model: 'claude-sonnet-5' })]),
    ];
    for (const state of states) {
      const asText = JSON.stringify(state).toLowerCase();
      for (const word of FORBIDDEN) expect(asText, state.headline).not.toContain(word);
    }
  });
});
