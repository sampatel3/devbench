import { parseGateCi } from './ci.js';
import type { GateFile, GateLetter, IssueState } from './types.js';

const GATES: GateLetter[] = ['A', 'B', 'C', 'D', 'E'];

function isGateLetter(v: unknown): v is GateLetter {
  return typeof v === 'string' && GATES.includes(v.toUpperCase() as GateLetter);
}

/**
 * Parse `.gate.json` from a worktree root. Returns null for anything we cannot
 * trust — a half-written or malformed file must not park a worker forever.
 */
export function parseGateFile(raw: string): GateFile | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const r = o as Record<string, unknown>;

  if (typeof r.issue !== 'number') return null;
  if (!isGateLetter(r.gate)) return null;

  const gate = (r.gate as string).toUpperCase() as GateLetter;

  return {
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
  };
}

const NOT_PASSED = /awaiting|pending|not yet|outstanding|todo/i;

/**
 * "Gates passed" lines mix passed and unpassed gates in one sentence — a real
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
