import { withEvidenceReminder } from './evidence-reminder.js';
import type { GateLetter } from './types.js';

/**
 * ASKING at a gate, without deciding it.
 *
 * A gate used to have exactly two answers: approve, or send feedback. Both of
 * them END the gate — the worker takes the message and moves on. So the only way
 * to ask "what does this actually change for a user?" was to spend the gate on
 * the question, which is precisely backwards: the gate exists so the operator
 * understands the work BEFORE deciding it.
 *
 * An ask is therefore a resume that must come back to the same place: the worker
 * answers, rewrites `.gate.json` with the SAME gate letter, and stops again. The
 * gate stays open, the thread grows, and the decision is still the operator's to
 * make.
 *
 * The failure mode this module is shaped around is the worker reading "somebody
 * wrote back at gate C" as "gate C passed" and charging on to build. That is not a
 * hypothetical: the console's other gate-message bug (see ui/src/gate.ts) was
 * exactly a message at a gate being read as more than it was. The defences are
 * layered — the wording here, the skill's own rule, structural detection when
 * the run ends, and one-click reopen — and this file owns the first of them.
 */

/**
 * One question the operator asked at a gate, and its answer when it lands.
 *
 * The console owns this record even though the worker also echoes the exchange
 * into `.gate.json`: a question asked while the worker was mid-answer, or one
 * overtaken by a decision before it was ever delivered, exists nowhere else.
 */
export type GateThreadEntry = {
  /** 1-based within this gate stop. It is the join key with the gate file. */
  id: number;
  /** The operator's words, verbatim — never reformatted, on the same rule as gate.ts. */
  question: string;
  askedAt: string;
  /** Stamped when the worker's answer lands. Write-once. */
  answer: string | null;
  answeredAt: string | null;
  /** Set when the operator decided the gate before this was answered. It stays on the
   *  card so a question that will never be answered is never silently dropped. */
  supersededAt: string | null;
};

/** The whole exchange at ONE gate stop, per issue. */
export type GateThreadRecord = {
  gate: GateLetter;
  entries: GateThreadEntry[];
  /** Ids currently held in `pendingResume` AS AN ASK. Empty means the held
   *  prompt, if there is one, is a decision — this is the flag that tells
   *  dispatch which of the two it is about to deliver. */
  pendingAskIds: number[];
  /** Set when an ask-run failed to re-park at this gate: the worker charged past
   *  a gate the operator had not decided. Shown until the gate is genuinely resolved. */
  violation: string | null;
  /** When a DECISION went out for this gate. The record is kept past that point
   *  (the superseded stamps have to stay visible) and cleared once the worker
   *  reaches its next stop — which is what stops a second round at the same
   *  gate letter inheriting the first round's questions. */
  closedAt: string | null;
  /** The `stoppedAt` of the gate file this thread belongs to, for the record. */
  stoppedAt: string | null;
};

/** The worker's half, as read back out of `.gate.json`'s `thread` array. */
export type GateThreadFileEntry = { id: number; q: string; a: string; at: string | null };

/**
 * Compose the message an ask sends.
 *
 * Every property here is deliberate and tested in ask-prompt.test.ts:
 *
 *  - the sentinel is the FIRST line, so a worker skimming the head of the
 *    message cannot mistake what it is;
 *  - the word "approved" appears nowhere, so the skill's own "wait for the
 *    explicit approval words" match cannot fire on a question;
 *  - the re-stop instruction is given twice, in the write step and again as its
 *    own numbered step;
 *  - the operator's words go through verbatim.
 *
 * `open` are the questions still waiting for an answer — all of them, so a
 * follow-up asked while the first was still held carries both rather than
 * replacing it. `answered` is the prior exchange, embedded as JSON for the
 * worker to carry forward so the whole thread lands in `.gate-history.jsonl`
 * when the gate is finally decided.
 */
export function askPrompt(gate: GateLetter, open: GateThreadEntry[], answered: GateThreadEntry[]): string {
  const asked = open.map((e) => `  ${e.id}. ${e.question}`).join('\n');
  const prior = JSON.stringify(
    answered.map((e) => ({ id: e.id, q: e.question, a: e.answer, at: e.answeredAt })),
    null,
    2,
  );
  const body = [
    `GATE ${gate} QUESTION — NOT A DECISION`,
    '',
    `The operator is asking at gate ${gate} before deciding it. Gate ${gate} is still OPEN. This message`,
    'does not pass the gate, and nothing in it is feedback to build from.',
    '',
    open.length === 1 ? 'The question:' : 'The questions:',
    asked,
    '',
    'Do exactly this and nothing else:',
    '1. Answer each question in plain English, following the comprehension rules in',
    '   the skill: define every term inline, consequences over implementation.',
    '2. Rewrite .gate.json exactly as it was when you stopped — same "issue",',
    `   "gate": "${gate}", same "stage", "sessionId", "summary", "questions", "evidence",`,
    '   "manualQa" and "quiz". Carry every QA step forward with the SAME "id" and',
    '   the SAME "rev": those two numbers are what the operator\'s per-step ticks hang',
    '   on, so changing either throws away verification already done by hand. Add a',
    '   top-level "thread" array holding the whole exchange:',
    '   the prior entries below carried forward verbatim, then one new entry per',
    '   question: { "id": <the id above>, "q": <the question verbatim>, "a": <your',
    '   answer>, "at": "<ISO-8601 now>" }.',
    '   Prior thread to carry forward verbatim (empty if none):',
    prior,
    '3. Write no other file, run nothing that changes state, and do NOT append to',
    '   .gate-history.jsonl — this round is not decided yet.',
    `4. Stop immediately after writing .gate.json. Do NOT proceed to the next stage.`,
    '   The gate passes only when a later message from the operator explicitly passes it.',
  ].join('\n');
  // Gate C is the only gate with an evidence box, and an ask is the message most
  // likely to cost it one: the worker rewrites `.gate.json` WHOLE to add its
  // answer, so every screenshot in it is being re-typed by a worker thinking
  // about a question. The standing rule rides along, at gate C and nowhere else.
  return gate === 'C' ? withEvidenceReminder(body) : body;
}

/**
 * Read the `thread` array out of a raw `.gate.json`.
 *
 * Tolerant on exactly the same principle as `parseEvidence`: a half-written or
 * malformed field must cost the console nothing. An entry it cannot trust is
 * dropped, and there is no input that makes this throw — a scan that dies on a
 * bad gate file would take every other worktree's row down with it.
 */
export function parseGateThreadFile(raw: unknown): GateThreadFileEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: GateThreadFileEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'number' || !Number.isFinite(r.id)) continue;
    if (typeof r.q !== 'string' || typeof r.a !== 'string') continue;
    out.push({ id: r.id, q: r.q, a: r.a, at: typeof r.at === 'string' ? r.at : null });
  }
  return out;
}

/**
 * Stamp the worker's answers onto the questions the console is holding.
 *
 * Joined BY ID, and write-once. That split is what makes the two copies safe:
 * the console is authoritative for what was asked (a worker that paraphrases or
 * forgets a question cannot rewrite history), the gate file is authoritative for
 * the answer, and an answer to an id nobody asked is ignored rather than turned
 * into a phantom entry.
 *
 * Returns whether anything changed, so the caller only writes state when it did.
 */
export function mergeThreadAnswers(record: GateThreadRecord, file: GateThreadFileEntry[]): boolean {
  let changed = false;
  for (const item of file) {
    const entry = record.entries.find((e) => e.id === item.id);
    if (!entry) continue; // an id nobody asked
    if (entry.answer !== null) continue; // write-once: the first answer stands
    if (entry.supersededAt !== null) continue; // the operator has already moved past it
    entry.answer = item.a;
    entry.answeredAt = item.at ?? new Date().toISOString();
    changed = true;
  }
  return changed;
}

/** The questions still waiting: not answered, and not overtaken by a decision. */
export function openEntries(record: GateThreadRecord): GateThreadEntry[] {
  return record.entries.filter((e) => e.answer === null && e.supersededAt === null);
}

/** The questions that have been answered — the thread the worker carries forward. */
export function answeredEntries(record: GateThreadRecord): GateThreadEntry[] {
  return record.entries.filter((e) => e.answer !== null);
}

/** What the card says when a worker walked past a gate it was only asked about. */
export function chargedPastMessage(gate: GateLetter): string {
  return (
    `the worker moved past gate ${gate} while you were only asking a question — nothing you sent ` +
    `passed the gate. Its answer, if any, is in the transcript. Use "Reopen gate ${gate}" to bring ` +
    `the gate back; your question is still on this card.`
  );
}

/**
 * What the card says when the worker came back to the right gate but did not
 * only answer.
 *
 * The gate LETTER is the one thing the console can prove, and the ask prompt
 * itself instructs the worker to write the same letter back — so satisfying the
 * only structural check was a mandated step of the run. A worker could answer,
 * build the feature, commit it, re-park at the same gate, and the row would read
 * `at-gate` as though nothing had happened. Committing is the half of that the
 * console CAN see, because it already records the head at the start of every run.
 *
 * Stated as a fact rather than an accusation: the operator may have committed in
 * that worktree themselves while the worker was thinking, and either way what
 * they need is to know a commit landed on a gate they have not decided.
 */
export function committedWhileAnsweringMessage(gate: GateLetter): string {
  return (
    `a commit landed in the worktree while the worker was only answering your question at gate ${gate}. ` +
    `You asked; you did not approve — so nothing built there was authorised by this gate. The gate is ` +
    `still open and still yours to decide; look at what landed before you decide it.`
  );
}
