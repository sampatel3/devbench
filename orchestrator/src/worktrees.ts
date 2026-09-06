import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseIssueState } from './state.js';
import { readGateFile, sessionDir } from './worker.js';
import { readEvidence, evidenceWarning, type EvidenceItem } from './evidence.js';
import { parseGateHistory, type GateHistoryRecord } from './history.js';
import { parseCommentRequest, type CommentRequest } from './comment.js';
import { parseGateThreadFile, type GateThreadFileEntry } from './ask.js';
import { parseManualQa, type ManualQa, type ManualQaStep } from './manual-qa.js';
import { parseQuiz, type Quiz } from './quiz.js';
import { parseGateCi } from './ci.js';
import { parseIssueRequest, parseBoardRequest, type IssueRequest, type BoardRequest } from './drafts.js';
import type { GateFile, IssueState } from './types.js';

const run = promisify(execFile);

export type WorktreeScan = {
  issue: number;
  path: string;
  branch: string | null;
  state: IssueState;
  gate: GateFile | null;
  /**
   * A hash of the raw `.gate.json` bytes, or null when there is no file.
   *
   * The console's own discriminator for "has this file been rewritten since I
   * looked". `stoppedAt` cannot be that, because a worker writes it: the rework
   * prompt lists the fields to carry forward unchanged, and one that reads the
   * stop stamp as part of the header is being obedient. When it did not move,
   * the whole return check — dropped evidence, dropped steps, charged past —
   * simply never ran.
   */
  gateHash: string | null;
  /** `.gate.json` is authoritative; the prose fallback covers worktrees that
   *  predate the skill amendment — #4336 on this machine is exactly that. */
  gateReport: string | null;
  /** Evidence the current gate points at (empty when there is no live gate). */
  gateEvidence: EvidenceItem[];
  /** The worker's half of the gate's question thread: the answers it wrote back.
   *  The console holds the questions; these are joined onto them by id. */
  gateThreadFile: GateThreadFileEntry[];
  /** The structured manual-QA click-script, when the worker wrote one. */
  gateManualQa: ManualQa | null;
  /** The comprehension quiz — brief, questions, options and the answer key.
   *  Null when the worker wrote none, which locks the gate rather than passing
   *  a half nobody was offered. */
  gateQuiz: Quiz | null;
  /** Every past gate + how you decided it. Append-only, chronological. */
  history: GateHistoryRecord[];
  /** A worker's drafted third-party comment, waiting for you to post it. */
  commentRequest: CommentRequest | null;
  /** A spin-off issue the worker drafted instead of filing (the fence denies
   *  `gh issue create`). You file it from GitHub's own form in one click. */
  issueRequest: IssueRequest | null;
  /** A board move the worker drafted instead of making. */
  boardRequest: BoardRequest | null;
  sessionId: string | null;
  transcriptMtimeMs: number | null;
  /** Whose transcript `transcriptMtimeMs` belongs to — the newest session's id.
   *  Detached detection needs to know this is OUR session, not a stray one. */
  newestSessionId: string | null;
  lastActivityAt: string | null;
  /** The commit this worktree is on, from `git worktree list`. Free. */
  head: string | null;
};

/** djb2, the same one `stepHash` and `quizKey` use. Not a checksum — a cheap
 *  "did these bytes change" over content the console already has in hand. */
/**
 * The scan's own content key for a gate file. Exported so anything that reads
 * `.gate.json` fresh off the disk can ask ONE question the scan cannot answer
 * for it: are we looking at the same bytes the scan enriched? See
 * `Orchestrator.#autoDecideSuperchargedGates`, which needs it for gate C.
 */
export function gateHashOf(s: string): string {
  return hashOf(s);
}

function hashOf(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * A fingerprint of the bytes behind a step's two captures, or null when neither
 * is on disk.
 *
 * Size and mtime rather than the content: these are screenshots, this runs once
 * per step per poll, and the only question being asked is "did this file move
 * under a tick". A false POSITIVE costs you a re-tick, which is the safe
 * direction and the direction every other mismatch in `stepHash` already fails
 * in. A false negative would be a green tick against a picture you never saw.
 */
async function stampShots(
  worktree: string,
  step: ManualQaStep,
): Promise<{ stamp: string | null; gone: Array<'before' | 'after'> }> {
  const parts: string[] = [];
  const gone: Array<'before' | 'after'> = [];
  for (const [leg, rel] of [
    ['before', step.beforeShot],
    ['after', step.afterShot],
  ] as const) {
    if (rel === null) continue;
    const s = await stat(join(worktree, rel)).catch(() => null);
    // WHICH LEG IS NOT THERE, kept as its own answer rather than left inside the
    // fingerprint. One `stat` already knew this and the console spent it only on
    // invalidating a tick — so a step could declare a capture, never write it,
    // and reach you as the browser's broken-image icon with nothing said. See
    // `ManualQaStep.goneShots`.
    //
    // `isFile` is asked HERE and deliberately not in the stamp below: the
    // evidence route refuses a directory (403, "not a regular file"), so a
    // directory in a capture's place is just as unviewable as no file at all —
    // but folding that into the stamp would change the hash of any step already
    // in that state and reset a tick you have given. This fix cannot invalidate
    // a single existing tick, and the line below is why.
    if (s === null || !s.isFile()) gone.push(leg);
    parts.push(s === null ? `${rel}:gone` : `${rel}:${s.size}:${Math.round(s.mtimeMs)}`);
  }
  return { stamp: parts.length === 0 ? null : parts.join('|'), gone };
}

/** Worktree directories are named `issue-<N>-<slug>` by scripts/git-new-worktree.sh. */
export function issueFromWorktreePath(path: string): number | null {
  const m = basename(path).match(/^issue-(\d+)-/);
  return m ? Number(m[1]) : null;
}

async function gitWorktrees(
  repoPath: string,
): Promise<Array<{ path: string; branch: string | null; head: string | null }>> {
  const { stdout } = await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], { timeout: 15_000 });
  const out: Array<{ path: string; branch: string | null; head: string | null }> = [];
  let current: { path: string; branch: string | null; head: string | null } | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) out.push(current);
      current = { path: line.slice('worktree '.length).trim(), branch: null, head: null };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch refs/heads/'.length).trim();
    } else if (line.startsWith('HEAD ') && current) {
      // Free — this line was already in the output and being skipped. It is what
      // lets the console say "code landed after your QA" without a git call.
      current.head = line.slice('HEAD '.length).trim();
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Crash recovery: after an orchestrator restart we do not know which session a
 * worktree belongs to. `.gate.json` says so when it is there; otherwise the
 * most recently written transcript in that worktree's session directory is the
 * session you would resume by hand, which is the same one we want.
 *
 * Transcripts live inside the ACCOUNT that wrote them, so this is given the
 * config dirs to look in: one, for an issue stamped with its account, or all of
 * them (newest wins) for an issue that predates the stamp.
 */
export async function newestSession(
  cwd: string,
  configDirs: string[],
): Promise<{ id: string; mtimeMs: number } | null> {
  let best: { id: string; mtimeMs: number } | null = null;
  for (const configDir of configDirs) {
    const dir = sessionDir(cwd, configDir);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const s = await stat(join(dir, name));
        if (!best || s.mtimeMs > best.mtimeMs) best = { id: name.replace(/\.jsonl$/, ''), mtimeMs: s.mtimeMs };
      } catch {
        /* raced with a delete */
      }
    }
  }
  return best;
}

/**
 * `configDirsFor` answers "which account(s) do this issue's transcripts live in".
 * The caller owns that decision because only it knows what the issue was stamped
 * with; scanning is otherwise unchanged.
 */
export async function scanWorktrees(
  repoPath: string,
  configDirsFor: (issue: number) => string[],
  gateProvenanceRaw = '',
): Promise<WorktreeScan[]> {
  const trees = await gitWorktrees(repoPath);
  const out: WorktreeScan[] = [];

  for (const t of trees) {
    const issue = issueFromWorktreePath(t.path);
    if (issue === null) continue; // the primary checkout

    const md = await readFile(join(t.path, '.issue-state.md'), 'utf8').catch(() => '');
    const state = parseIssueState(md);
    const gateJson = await readGateFile(t.path);

    // Evidence, the question thread and the click-script all live in the raw
    // .gate.json next to the fields parseGateFile reads. They are read from the
    // raw object rather than added to parseGateFile on purpose: that parser is
    // the thing that decides whether a worker is PARKED, and a new field must
    // never be able to change that answer.
    let gateEvidence: EvidenceItem[] = [];
    let gateEvidenceWarning: string | null = null;
    let gateThreadFile: GateThreadFileEntry[] = [];
    let gateManualQa: ManualQa | null = null;
    let gateQuiz: Quiz | null = null;
    let gateHash: string | null = null;
    if (gateJson) {
      const rawGate = await readFile(join(t.path, '.gate.json'), 'utf8').catch(() => '');
      gateHash = rawGate === '' ? null : hashOf(rawGate);
      try {
        const obj = JSON.parse(rawGate) as {
          evidence?: unknown;
          thread?: unknown;
          manualQa?: unknown;
          quiz?: unknown;
        };
        const manifest = readEvidence(obj.evidence);
        gateEvidence = manifest.items;
        // What the manifest listed and the console would not serve. It travels
        // with the gate, not beside it — see `GateFile.evidenceWarning`.
        gateEvidenceWarning = evidenceWarning(manifest.dropped);
        gateThreadFile = parseGateThreadFile(obj.thread);
        gateManualQa = parseManualQa(obj.manualQa);
        gateQuiz = parseQuiz(obj.quiz);
      } catch {
        gateEvidence = [];
      }
      // The captures, stamped where a file can actually be read. `parseManualQa`
      // is pure and stays that way — it is also unit-tested against raw objects
      // with no worktree behind them.
      if (gateManualQa) {
        for (const step of gateManualQa.steps) {
          const { stamp, gone } = await stampShots(t.path, step);
          step.shotStamp = stamp;
          step.goneShots = gone;
        }
      }
    }

    const historyRaw = await readFile(join(t.path, '.gate-history.jsonl'), 'utf8').catch(() => '');
    const history = parseGateHistory(historyRaw, gateProvenanceRaw);

    const commentRaw = await readFile(join(t.path, '.comment-request.json'), 'utf8').catch(() => '');
    const commentRequest = commentRaw ? parseCommentRequest(commentRaw) : null;

    // The two writes the fence denies, drafted for your click. Read exactly
    // like the comment request they are modelled on.
    const issueReqRaw = await readFile(join(t.path, '.issue-request.json'), 'utf8').catch(() => '');
    const issueRequest = issueReqRaw ? parseIssueRequest(issueReqRaw) : null;
    const boardReqRaw = await readFile(join(t.path, '.board-request.json'), 'utf8').catch(() => '');
    const boardRequest = boardReqRaw ? parseBoardRequest(boardReqRaw) : null;

    // NO RECONSTRUCTION. A gate is the file a worker wrote when it stopped, or it
    // is nothing. The block that used to stand here rebuilt one from a
    // `STOPPED AT GATE x` match in `.issue-state.md` — unanchored, first match
    // wins — and on 2026-08-13 it put #4491 at the top of the needs-you band,
    // orange, from a hit at line 156 in the middle of a Stage-5 narrative, four
    // lines above that file's own `## Stage 7 — PR opened` heading. The row was a
    // dead end: Approve locked, Start hidden, the GitHub waiting card suppressed,
    // and the status you paste for your team reading "waiting on you — gate C".
    // Its stated purpose was worktrees older than `.gate.json`; that was #4336,
    // long closed.
    const gate: GateFile | null = gateJson && { ...gateJson, evidenceWarning: gateEvidenceWarning };

    const session = await newestSession(t.path, configDirsFor(issue));
    const sessionId = gate?.sessionId ?? commentRequest?.sessionId ?? session?.id ?? null;

    let gateReport: string | null = null;
    if (gate?.reportPath) {
      gateReport = await readFile(join(t.path, gate.reportPath), 'utf8').catch(() => null);
    }
    if (!gateReport && md) gateReport = md;

    const stateMtime = await stat(join(t.path, '.issue-state.md'))
      .then((s) => s.mtimeMs)
      .catch(() => null);
    const lastMs = Math.max(session?.mtimeMs ?? 0, stateMtime ?? 0);

    out.push({
      issue,
      path: t.path,
      branch: t.branch ?? state.branch,
      state,
      gate,
      gateHash,
      gateReport,
      gateEvidence,
      gateThreadFile,
      gateManualQa,
      gateQuiz,
      history,
      commentRequest,
      issueRequest,
      boardRequest,
      sessionId,
      transcriptMtimeMs: session?.mtimeMs ?? null,
      newestSessionId: session?.id ?? null,
      lastActivityAt: lastMs ? new Date(lastMs).toISOString() : null,
      head: t.head,
    });
  }
  return out;
}
