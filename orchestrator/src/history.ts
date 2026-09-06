import { appendFile, readFile } from 'node:fs/promises';
import { gateFileOrRefusal } from './state.js';
import { readEvidence, evidenceWarning, type EvidenceItem } from './evidence.js';
import { parseGateThreadFile, type GateThreadFileEntry } from './ask.js';
import { parseManualQa, type ManualQa } from './manual-qa.js';
import { parseQuiz, type Quiz } from './quiz.js';
import type { GateFile } from './types.js';
import type { AgentProviderId } from './providers/types.js';

/**
 * The append-only gate audit trail. Each line of `.gate-history.jsonl` is a past
 * `.gate.json` plus the decision that unblocked it — what the worker asked, and
 * what the operator answered. A corrupt line is skipped, never fatal: an audit
 * log you cannot read at all is worse than one with a hole in it.
 */

export type GateHistoryRecord = GateFile & {
  evidence: EvidenceItem[];
  /** Everything the operator asked at this gate before deciding it, and what they
   *  were told. Empty for a gate nobody asked at, and for every record written
   *  before asking existed. It is the worker's copy: the whole point of it landing
   *  in the decided `.gate.json` is that it comes here for good. */
  thread: GateThreadFileEntry[];
  /** The click-script as it stood when the gate was decided, steps, revisions
   *  and all. Without this a decided gate C loses the QA entirely — and with
   *  per-step ticks and a rework trail on those steps, that loss is the whole
   *  record of what the operator checked and what came back fixed. */
  manualQa: ManualQa | null;
  /** The comprehension quiz as it was answered. The operator's answers are not
   *  here: they ride into `decision` inside the approval they sent, which is the
   *  same trick the thread uses. */
  quiz: Quiz | null;
  decision: string | null;
  resumedAt: string | null;
  /** Which Claude account did this round of work. Null for every record written
   *  before the worker started stamping it — we do not guess it after the fact. */
  account: string | null;
  /** Runtime provenance is joined from the console-owned append-only sidecar.
   * Null means this gate predates provider support; it is never reconstructed. */
  provider: AgentProviderId | null;
  model: string | null;
  agentSessionId: string | null;
  /**
   * The lines of `.gate-history.jsonl` that could not be read, as one finished
   * sentence, filed against the round they came after. Null on a round nothing
   * unreadable followed, which is nearly all of them.
   *
   * "A corrupt line is skipped, never fatal" was only half a rule: it said what
   * not to do about the audit log and nothing about the reader. Two rounds went
   * missing on this machine because workers wrote `"gate": "B-postscript"` and
   * `"gate": "B-resume-note"` — the lines were dropped, the drawer showed one
   * round where there had been three, and nothing anywhere said a line had been
   * refused. The hole is still a hole; it is just no longer invisible.
   *
   * The one thing this cannot show is a history file with NO readable line in
   * it: there is no round to hang the sentence on and no panel to open. That is
   * the honest limit of filing by position.
   */
  quarantined: string | null;
};

/** The quarantine as the drawer says it. Server-composed, like every other
 *  sentence on a card: the page renders this string and derives nothing. */
const quarantineLine = (reasons: string[]): string =>
  `${reasons.length} unreadable ${reasons.length === 1 ? 'round' : 'rounds'} (${reasons.join('; ')})`;

export type GateProvenanceRecord = {
  issue: number;
  gate: GateFile['gate'];
  sessionId: string;
  stoppedAt: string | null;
  provider: AgentProviderId;
  account: string;
  model: string;
  agentSessionId: string | null;
  recordedAt: string;
};

function parseGateProvenance(raw: string): GateProvenanceRecord[] {
  const out: GateProvenanceRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (typeof r.issue !== 'number' || !['A', 'B', 'C', 'D', 'E'].includes(String(r.gate).toUpperCase())) continue;
      if (typeof r.sessionId !== 'string' || !r.sessionId) continue;
      if (r.provider !== 'claude' && r.provider !== 'codex') continue;
      if (typeof r.account !== 'string' || typeof r.model !== 'string') continue;
      out.push({
        issue: r.issue,
        gate: String(r.gate).toUpperCase() as GateFile['gate'],
        sessionId: r.sessionId,
        stoppedAt: typeof r.stoppedAt === 'string' ? r.stoppedAt : null,
        provider: r.provider,
        account: r.account,
        model: r.model,
        agentSessionId: typeof r.agentSessionId === 'string' ? r.agentSessionId : null,
        recordedAt: typeof r.recordedAt === 'string' ? r.recordedAt : '',
      });
    } catch {
      // A torn provenance line cannot hide the rest of the gate history.
    }
  }
  return out;
}

const provenanceKey = (r: Pick<GateProvenanceRecord, 'issue' | 'gate' | 'sessionId' | 'stoppedAt'>) =>
  `${r.issue}|${r.gate}|${r.sessionId}|${r.stoppedAt ?? ''}`;

/** Record gate runtime identity without rewriting the worker-owned history. */
export async function appendGateProvenance(file: string, record: GateProvenanceRecord): Promise<void> {
  const existing = parseGateProvenance(await readFile(file, 'utf8').catch(() => ''));
  if (existing.some((entry) => provenanceKey(entry) === provenanceKey(record))) return;
  await appendFile(file, `${JSON.stringify(record)}\n`).catch(() => {});
}

/**
 * THE DECIDED ROUND, AS THE CONSOLE CAN HONESTLY WRITE IT.
 *
 * Everything a `GateHistoryRecord` holds except the three runtime fields, which
 * are not the console's to put in a line: `provider`, `model` and
 * `agentSessionId` are joined at read time from the console-owned provenance
 * sidecar, and writing them here would be a second, divergent copy of a fact
 * that already has one home.
 *
 * `evidenceWarning` and `quarantined` are out for the same reason from the other
 * direction: they are what the READER could not make of the file, derived fresh
 * every time it is read. Writing them down would freeze one parser's opinion
 * into an append-only log that outlives it.
 */
export type DecidedRound = Omit<
  GateHistoryRecord,
  'provider' | 'model' | 'agentSessionId' | 'evidenceWarning' | 'quarantined'
>;

/**
 * ONE APPEND-ONLY LINE, WRITTEN BY THE CONSOLE INTO A WORKER-OWNED WORKTREE FILE.
 *
 * FENCE NOTE — this is a deliberate, narrow exception to "the console never
 * writes into a customer worktree", and it is the only one. The reason is that
 * the console DESTROYS the evidence for this record: it unlinks `.gate.json`
 * before it resumes, so by the time the worker comes to write its own history
 * line the file it is told to copy is gone. `stop-files.md` still promises the
 * worker that `.gate.json` will be renamed to `.gate.prev.json` for exactly this
 * reason, and it never was. So the worker writes the round from memory, and 109
 * of 126 recorded gate C rounds (87%) came back with no `manualQa` and no
 * `evidence` at all — 135 lines say so in prose, literally "RECONSTRUCTED:
 * console consumed the gate file".
 *
 * The console is the party that has the whole round in hand at the moment of the
 * decision: the parsed gate object, the evidence and click-script as they were
 * shown on the card (restored copies included), the quiz, the worker's thread,
 * and the operator's exact words. So it writes them, once, here.
 *
 * The write is as narrow as the claim: opened with `'a'`, a single line, ending
 * in a newline. Nothing in the console reads this file to decide anything it
 * could not decide from its own ledger, nothing truncates it, nothing rewrites a
 * line, and nothing deletes one. A failed write is swallowed for the same reason
 * `appendGateProvenance` swallows one — an audit line that could not be written
 * must never be the reason a decision the operator made fails.
 */
export async function appendGateHistory(file: string, round: DecidedRound): Promise<void> {
  await appendFile(file, `${JSON.stringify(round)}\n`, 'utf8').catch(() => {});
}

/**
 * A round's identity, for the one job it has: telling the console's line and the
 * worker's later line about the SAME stop apart from two genuine rounds.
 *
 * `stoppedAt` is the worker's own stamp on the gate file, so the console copies
 * it rather than inventing one, and a worker echoing the round it just resumed
 * from carries the same value. Null is deliberately never a key: a record with
 * no stop stamp cannot be told from another record with no stop stamp, and
 * collapsing two of those would delete a round that really happened —
 * `reopenGate` counts rounds per gate, so a lost one is a reversal aimed at the
 * wrong exchange. A duplicate on screen is recoverable; a missing round is not.
 */
const roundKey = (r: { issue: number; gate: GateFile['gate']; stoppedAt: string | null }): string | null =>
  r.stoppedAt ? `${r.issue}|${r.gate}|${r.stoppedAt}` : null;

/**
 * FIRST LINE WINS, and that is what makes the console's copy the one that
 * survives.
 *
 * Idempotence has to happen HERE rather than as a skip-append in
 * `appendGateHistory`, because the duplicate does not exist yet when the console
 * writes: the worker appends its reconstruction on its NEXT round, long after.
 * Nothing the writer checks can see a line that has not been written.
 *
 * Reading first-wins gets the right one for free. `#recordDecision` writes
 * before the resume that lets the worker write anything at all, so for every
 * round the console decided, the console's complete line is already above the
 * worker's remembered one. For every round it did not — a gate decided before
 * this existed, or outside the console — the worker's line is the only one there
 * and stands exactly as it always has.
 */
export function parseGateHistory(raw: string, provenanceRaw = ''): GateHistoryRecord[] {
  const provenance = parseGateProvenance(provenanceRaw);
  const seen = new Set<string>();
  const out: GateHistoryRecord[] = [];
  // `refused[i]` — the lines the parser could not read that FOLLOWED `out[i]`.
  // Position is the only fact a rejected line still has, so it is what the
  // quarantine is filed under; the ones that come before any readable round go
  // to index 0, which is the first round pushed. See `quarantined` on the record.
  const refused: string[][] = [];
  const refuse = (reason: string) => {
    const i = Math.max(out.length - 1, 0);
    (refused[i] ??= []).push(reason);
  };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const read = gateFileOrRefusal(line); // reuses the same validation as .gate.json
    if ('refused' in read) {
      refuse(read.refused);
      continue;
    }
    const gate = read.gate;
    const key = roundKey(gate);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Unreachable — `gateFileOrRefusal` parsed this same line a moment ago —
      // but a silent `continue` is the exact shape of the bug this function is
      // being fixed for, so even the impossible branch says something.
      refuse('not valid JSON');
      continue;
    }
    const directProvider = obj.provider === 'claude' || obj.provider === 'codex' ? obj.provider : null;
    const sidecar = [...provenance]
      .reverse()
      .find((entry) =>
        entry.issue === gate.issue &&
        entry.gate === gate.gate &&
        (gate.sessionId ? entry.sessionId === gate.sessionId : gate.stoppedAt !== null) &&
        (gate.stoppedAt ? entry.stoppedAt === gate.stoppedAt : gate.sessionId !== null),
      );
    const manifest = readEvidence(obj.evidence);
    out.push({
      ...gate,
      evidenceWarning: evidenceWarning(manifest.dropped),
      quarantined: null,
      evidence: manifest.items,
      thread: parseGateThreadFile(obj.thread),
      manualQa: parseManualQa(obj.manualQa),
      quiz: parseQuiz(obj.quiz),
      decision: typeof obj.decision === 'string' ? obj.decision : null,
      resumedAt: typeof obj.resumedAt === 'string' ? obj.resumedAt : null,
      account: typeof obj.account === 'string' && obj.account ? obj.account : sidecar?.account ?? null,
      provider: directProvider ?? sidecar?.provider ?? null,
      model: typeof obj.model === 'string' && obj.model ? obj.model : sidecar?.model ?? null,
      agentSessionId:
        typeof obj.agentSessionId === 'string' && obj.agentSessionId
          ? obj.agentSessionId
          : sidecar?.agentSessionId ?? null,
    });
  }
  refused.forEach((reasons, i) => {
    const rec = out[i];
    if (rec && reasons?.length) rec.quarantined = quarantineLine(reasons);
  });
  return out;
}
