import { appendFile, readFile } from 'node:fs/promises';
import type { GateLetter } from './types.js';

/**
 * What the operator decided, written down by the CONSOLE.
 *
 * Until now nothing recorded a gate decision. 54 gate resumes have happened and 29
 * worker-written history lines exist, so roughly 25 decisions left no trace
 * anywhere the console owns — and every gate fact on screen was the worker's later
 * account of an exchange it did not witness. Those accounts are invented in the
 * fields that matter: `sessionId` is null on 29 of 29 records and every `stoppedAt`
 * is a rounded five-minute value matching no real run.
 *
 * That is how a report claimed three gates had been skipped that had in fact been
 * approved. The words approving #4344's Gate D were on disk the whole time; the
 * console was reading a prose sentence in a different file that had gone stale.
 *
 * So: one append-only line per decision, written by the only party that witnesses
 * one. It is the single source for the spine ticks, the history panel and the
 * Gate D check on `gh pr create`, and it exists so that four worker-written stores
 * could be deleted rather than validated.
 *
 * Written BEFORE the gate file is unlinked and before anything spawns. If the
 * console dies between the two, the worst case is a decision recorded that did not
 * resume — visible and recoverable. The other order loses the decision entirely.
 */
export type GateDecision = {
  issue: number;
  gate: GateLetter;
  /** `approved` moves the work on; `feedback` sends it back. */
  decision: 'approved' | 'feedback';
  /** The operator's exact bytes. Never summarised, never templated. */
  message: string;
  /** Real clock, from the console. */
  at: string;
  /** The session this resumed — the console generated it, so it is always known. */
  sessionId: string | null;
  account: string | null;
  /** Gate C only: the operator's own tick counts at the instant they decided. */
  qa?: { ticked: number; total: number } | null;
  /**
   * The commit the approval was given AGAINST.
   *
   * An approval is given against a specific diff; nothing recorded which one, so
   * when a commit landed afterwards nothing could work out that the QA no longer
   * covered the code. It surfaced only because a worker chose to mention it, at
   * the next gate, in prose. With this, "5 commits since your QA" is derived.
   */
  head?: string | null;
  /**
   * Questions the operator was asked at this gate and did NOT answer.
   *
   * They used to evaporate: the worker took its own recommendation and asked
   * again at the next gate as a "last call". Recorded here, a later gate can open
   * with what was left open rather than the worker deciding on the operator's
   * behalf.
   */
  unanswered?: string[];
  /**
   * WHO passed it, when it was not the operator.
   *
   * Absent on every decision the operator made themselves — which is deliberate,
   * because it keeps every line ever written before this field the truth it
   * already was. Present only when a supercharged run passed the gate on their
   * standing instruction (`supercharge.ts`). `gatesApproved` counts it either way: the
   * gate WAS passed. What changes is that the history can say by whom, which
   * #5402 could not — two questions typed at gate D went into this ledger as
   * approvals, and nothing afterwards could tell them from the real thing.
   */
  by?: 'supercharge';
};

/** One JSON object per line, appended, never rewritten. */
export async function appendDecision(path: string, d: GateDecision): Promise<void> {
  await appendFile(path, `${JSON.stringify(d)}\n`, 'utf8');
}

/** Every decision on record. A malformed line is skipped, never fatal. */
export async function readDecisions(path: string): Promise<GateDecision[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return []; // no file yet is the same as no decisions
  }
  return parseDecisions(raw);
}

export function parseDecisions(raw: string): GateDecision[] {
  const out: GateDecision[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (typeof o.issue !== 'number' || typeof o.gate !== 'string') continue;
      if (o.decision !== 'approved' && o.decision !== 'feedback') continue;
      out.push({
        issue: o.issue,
        gate: o.gate as GateLetter,
        decision: o.decision,
        ...(o.by === 'supercharge' ? { by: 'supercharge' as const } : {}),
        message: typeof o.message === 'string' ? o.message : '',
        at: typeof o.at === 'string' ? o.at : '',
        sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
        account: typeof o.account === 'string' ? o.account : null,
        qa:
          typeof o.qa === 'object' && o.qa !== null
            ? {
                ticked: Number((o.qa as Record<string, unknown>).ticked) || 0,
                total: Number((o.qa as Record<string, unknown>).total) || 0,
              }
            : null,
        head: typeof o.head === 'string' && o.head !== '' ? o.head : null,
        unanswered: Array.isArray(o.unanswered) ? o.unanswered.filter((x): x is string => typeof x === 'string') : [],
      });
    } catch {
      // A half-written line from a kill mid-append. Skip it; the rest stand.
    }
  }
  return out;
}

/**
 * The gates this issue has been APPROVED through, in gate order.
 *
 * This replaces `gatesPassed`, which was regexed out of a prose line in the
 * worker's own `.issue-state.md`. Workers only ever append to that file, so its
 * header went stale by design and then contradicted the history drawer on the same
 * screen — on 6 of 10 worktrees.
 *
 * `feedback` never counts: sending work back is not passing a gate. A gate
 * approved, reopened and approved again appears once.
 */
const ORDER: GateLetter[] = ['A', 'B', 'C', 'D', 'E'];

export function gatesApproved(decisions: GateDecision[], issue: number): GateLetter[] {
  const seen = new Set<GateLetter>();
  for (const d of decisions) {
    if (d.issue === issue && d.decision === 'approved') seen.add(d.gate);
  }
  return ORDER.filter((g) => seen.has(g));
}

/** Has this issue been approved through a specific gate? The `gh pr create` check. */
export function approvedThrough(decisions: GateDecision[], issue: number, gate: GateLetter): boolean {
  return gatesApproved(decisions, issue).includes(gate);
}

/**
 * Every gate this issue has actually been decided through.
 *
 * Two records count, and the stale one does not:
 *   - the console's ledger above, which is authoritative from now on;
 *   - `.gate-history.jsonl`, the worker's record of rounds the operator DECIDED —
 *     it holds their exact words and is the only trace of the ~25 decisions made
 *     before the ledger existed. Dropping it would blank the spine on every
 *     current issue.
 *
 * What is deliberately NOT read is `**Gates passed**:` in `.issue-state.md`. That
 * is a prose line workers only ever append below, so its header goes stale by
 * design — it said "A, B, C" on #4344 while the history two clicks away held the
 * Gate D approval twice. One screen, two answers, and the wrong one had the ticks.
 */
export function gatesPassedFor(
  decisions: GateDecision[],
  issue: number,
  history: Array<{ gate: GateLetter; decision: string | null }>,
): GateLetter[] {
  const seen = new Set<GateLetter>(gatesApproved(decisions, issue));
  for (const h of history) {
    // A history round with no decision is a gate that was SHOWN, not one that passed.
    if (h.decision !== null && h.decision !== '') seen.add(h.gate);
  }
  return ORDER.filter((g) => seen.has(g));
}

/**
 * Has the code moved since that gate was approved?
 *
 * Null means no — or that we cannot tell, which is the same thing for display
 * purposes and must never be dressed up as "nothing changed". It reads the LATEST
 * approval of the gate, because a gate reopened and re-approved resets the clock:
 * the newest look is the one the QA covers.
 */
export function codeSince(
  decisions: GateDecision[],
  issue: number,
  gate: GateLetter,
  headNow: string | null,
): { approvedAt: string; headNow: string; at: string } | null {
  if (!headNow) return null;
  const mine = decisions
    .filter((d) => d.issue === issue && d.gate === gate && d.decision === 'approved' && d.head)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const latest = mine[mine.length - 1];
  if (!latest?.head) return null;
  if (latest.head === headNow) return null;
  return { approvedAt: latest.head, headNow, at: latest.at };
}
