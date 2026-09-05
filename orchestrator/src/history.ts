import { appendFile, readFile } from 'node:fs/promises';
import { parseGateFile } from './state.js';
import { parseEvidence, type EvidenceItem } from './evidence.js';
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
};

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

export function parseGateHistory(raw: string, provenanceRaw = ''): GateHistoryRecord[] {
  const provenance = parseGateProvenance(provenanceRaw);
  const out: GateHistoryRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const gate = parseGateFile(line); // reuses the same validation as .gate.json
    if (!gate) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
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
    out.push({
      ...gate,
      evidence: parseEvidence(obj.evidence),
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
  return out;
}
