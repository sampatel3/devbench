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

/**
 * WHAT THE BOX WAS ACTUALLY USED FOR — read from the bytes, not taken on trust.
 *
 * `POST /api/issues/:n/resume` carries an optional `decision`, and an absent one
 * defaults to `approved` because that is what the first caller meant. Every
 * caller written since inherits that default whether or not it is approving
 * anything: the console's four "your gate C deliverable is incomplete" prompts
 * go down the same pipe with no `decision` at all, so 110 send-backs are sitting
 * in the ledger as approvals of the gate they were sent back from. `gatesApproved`
 * then ticks a gate that is still open, `codeSince` resets its clock at the
 * moment the code is about to change, and `leftUnanswered` reads the send-back's
 * own empty list as the newest approval.
 *
 * The page cannot be the authority on this — a fresh bundle talks to an old
 * server and an old bundle talks to this one — so the console classifies the
 * message itself, the same way `approveGateC` recomputes the gate C lock from
 * disk rather than rendering the page's copy of it.
 *
 * Both functions below only ever DEMOTE. An approval wrongly read as a send-back
 * stalls work that was passed; a send-back wrongly read as an approval ticks a
 * gate nobody passed and cannot be seen afterwards. So each one keys on bytes
 * the console itself composed, never on a guess about English.
 */

/**
 * The console's own send-backs, which say so in their first line.
 *
 * `askForShotsPrompt`, `askForMissingShotsPrompt`, `askForScriptPrompt` and
 * `askForQuizPrompt` (`ui/src/gate.ts`) and `decideSupercharge`'s evidence
 * send-back (`supercharge.ts`) all open by telling the worker, in capitals, that
 * the message is not an approval. That sentence is written for the worker, but
 * it is just as true of the ledger, and it is the one part of these prompts that
 * is fixed: they are composed strings, not typed ones.
 *
 * Cased on purpose. `NOT` in capitals is the console's own convention for the
 * line and no one types it by accident; matching case-insensitively would start
 * reading the operator's prose, which is exactly the guess this must not make.
 *
 * The prompts are the page's and the classifier is the server's, and the two
 * halves of this console share no code — so `decision-intent.test.ts` runs this
 * over every one of them and fails the build when they drift, on the same rule
 * `gate-c-evidence-reminder.test.ts` applies to the two copies of the reminder.
 */
const CONSOLE_SEND_BACK = 'NOT an approval';

export function sentBackByTheConsole(message: string): boolean {
  return message.includes(CONSOLE_SEND_BACK);
}

/**
 * THE OPERATOR'S OWN WORDS, with the canned line the page wraps them in taken
 * back off.
 *
 * `approvePrompt` (`ui/src/gate.ts`) sends `Gate D approved, proceed.` followed
 * by whatever is in the textarea, and that composition is why the #5402 guard
 * has never once fired: `readsAsQuestion` was handed the whole composed message,
 * found `approved` and `proceed` in the line the PAGE wrote, and passed the two
 * questions underneath it straight through as an approval of gate D. The
 * heuristic was right and was reading the wrong bytes.
 *
 * Only the exact canned line is removed, and only from the front. Gate C's
 * approval is a different string (`approvalLineC`) carrying the quiz record —
 * question marks and all — and is deliberately left whole: it is machine-written
 * and its own words say yes.
 */
export function saidInTheApproveBox(gate: GateLetter, message: string): string {
  const canned = `Gate ${gate} approved, proceed.`;
  const said = message.trimStart();
  return said.startsWith(canned) ? said.slice(canned.length).trim() : message;
}

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
 *
 * A HISTORY ROUND CANNOT SAY WHICH WAY IT WENT. Its `decision` is the operator's
 * own words, and "step 3 is still wrong, redo it" is the same shape as "proceed" — so a
 * round that was sent BACK has always ticked the gate here, the moment the round
 * was recorded. The ledger is the half that knows, and the two records share a
 * join: the console writes the identical bytes into both, `message` here and
 * `decision` there. So a history round whose words this console recorded as a
 * send-back is skipped, and every other round counts exactly as it always has.
 */
export function gatesPassedFor(
  decisions: GateDecision[],
  issue: number,
  history: Array<{ gate: GateLetter; decision: string | null }>,
): GateLetter[] {
  const seen = new Set<GateLetter>(gatesApproved(decisions, issue));
  const sentBack = new Set(
    decisions.filter((d) => d.issue === issue && d.decision === 'feedback').map((d) => `${d.gate}|${d.message}`),
  );
  for (const h of history) {
    // A history round with no decision is a gate that was SHOWN, not one that passed.
    if (h.decision === null || h.decision === '') continue;
    if (sentBack.has(`${h.gate}|${h.decision}`)) continue;
    seen.add(h.gate);
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
