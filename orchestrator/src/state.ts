import { parseGateCi } from './ci.js';
import type { GateFile, GateLetter, IssueState } from './types.js';

const GATES: GateLetter[] = ['A', 'B', 'C', 'D', 'E'];

function isGateLetter(v: unknown): v is GateLetter {
  return typeof v === 'string' && GATES.includes(v.toUpperCase() as GateLetter);
}

/** A value a worker wrote, short enough to print back at you on a card. */
function quoted(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  return `'${s.length > 40 ? `${s.slice(0, 40)}…` : s}'`;
}

/**
 * The same parse, saying WHY when it refuses.
 *
 * `parseGateFile` returns null and the caller decides what null means: for
 * `.gate.json` it means "not parked", which is the right answer and needs no
 * explanation. For a line of `.gate-history.jsonl` it means a round is gone, and
 * two of those went missing without a trace — workers wrote `"gate":
 * "B-postscript"` and `"gate": "B-resume-note"`, invented letters that no rule
 * anywhere allows, and the round each line carried simply stopped existing.
 *
 * So the refusal has a reason, in one place, worded for the operator.
 * `parseGateHistory` quarantines on it; nothing else changes. Widening
 * `isGateLetter` to accept those two strings would have been the other fix and
 * it is the wrong one: the letter decides which gate a round belongs to, and
 * guessing it from a prefix puts a round you never saw into a gate you have
 * passed.
 */
export type GateFileRead = { gate: GateFile } | { refused: string };

export function gateFileOrRefusal(raw: string): GateFileRead {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { refused: 'not valid JSON' };
  }
  if (typeof o !== 'object' || o === null) return { refused: 'not a JSON object' };
  const r = o as Record<string, unknown>;

  if (typeof r.issue !== 'number') return { refused: 'no issue number' };
  if (!isGateLetter(r.gate)) {
    return { refused: r.gate === undefined ? 'no gate letter' : `bad gate letter ${quoted(r.gate)}` };
  }

  const gate = (r.gate as string).toUpperCase() as GateLetter;

  return {
    gate: {
      issue: r.issue,
      gate,
      stage: typeof r.stage === 'number' ? r.stage : null,
      sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
      stoppedAt: typeof r.stoppedAt === 'string' ? r.stoppedAt : null,
      reportPath: typeof r.reportPath === 'string' ? r.reportPath : null,
      summary: typeof r.summary === 'string' ? r.summary : '',
      questions: Array.isArray(r.questions) ? r.questions.filter((q): q is string => typeof q === 'string') : [],
      // This parser builds its object field by field, so an unknown key vanishes
      // with no error. `ci` had to be read here explicitly or a worker writing it
      // would have had it silently discarded — and at Gate E, a worker writing
      // NOTHING must not look the same as one that checked. See ci.ts.
      ci: parseGateCi(r.ci, gate),
    },
  };
}

/**
 * Parse `.gate.json` from a worktree root. Returns null for anything we cannot
 * trust — a half-written or malformed file must not park a worker forever.
 */
export function parseGateFile(raw: string): GateFile | null {
  const r = gateFileOrRefusal(raw);
  return 'gate' in r ? r.gate : null;
}

const NOT_PASSED = /awaiting|pending|not yet|outstanding|todo/i;

/**
 * "Gates passed" lines mix passed and unpassed gates in one sentence — the real
 * #4336 line reads `A ✅, B ✅ (both approved by coordinator). C — awaiting you.`
 * So each gate letter owns the text up to the next gate letter, and a gate whose
 * own text says it is waiting has not passed.
 */
function parseGatesPassed(line: string): GateLetter[] {
  if (!line.trim() || /\bnone\b/i.test(line)) return [];
  const hits = [...line.matchAll(/\b([A-E])\b/g)];
  const passed: GateLetter[] = [];
  for (let i = 0; i < hits.length; i++) {
    const letter = hits[i]![1] as GateLetter;
    const from = hits[i]!.index!;
    const to = i + 1 < hits.length ? hits[i + 1]!.index! : line.length;
    if (!NOT_PASSED.test(line.slice(from, to)) && !passed.includes(letter)) passed.push(letter);
  }
  return GATES.filter((g) => passed.includes(g));
}

/**
 * Read what we can out of `.issue-state.md`. This is the legacy path: worktrees
 * that predate the `.gate.json` amendment only say it in prose, and #4336 on
 * this machine is exactly that.
 *
 * Only the literal "STOPPED AT GATE x" counts as a recorded stop. "awaiting
 * GATE E" is prose about what comes next — #4342 has a PR open and is not parked.
 */
export function parseIssueState(md: string): IssueState {
  const stageMatch = md.match(/\*\*Stage reached\*\*:\s*(\d+)/i) ?? md.match(/Stage reached:\s*\**(\d+)/i);
  const stoppedMatch = md.match(/STOPPED AT GATE\s+([A-E])\b/i);
  const portMatch =
    md.match(/\*\*Dev[- ]server port\*\*:\s*\**(\d{4,5})/i) ??
    md.match(/localhost:(\d{4,5})/i) ??
    md.match(/Dev server[^\n]*?(\d{4,5})/i);
  const branchMatch = md.match(/\*\*Branch\*\*:\s*`([^`]+)`/i);

  const gatesLine = md.match(/\*\*Gates passed\*\*:\s*([^\n]*)/i)?.[1] ?? '';

  return {
    stage: stageMatch ? Number(stageMatch[1]) : null,
    gatesPassed: parseGatesPassed(gatesLine),
    stoppedAtGate: stoppedMatch ? (stoppedMatch[1]!.toUpperCase() as GateLetter) : null,
    port: portMatch ? Number(portMatch[1]) : null,
    branch: branchMatch ? branchMatch[1]! : null,
  };
}
