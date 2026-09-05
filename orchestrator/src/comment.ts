import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { Addressee } from './addressee.js';

/**
 * THE ONLY GitHub-WRITES in this codebase, and there are exactly two.
 *
 * There is deliberately no general `gh(args)` write helper: edit, close, label,
 * assign, merge, create and delete have no path to a process from here. Each of
 * the two writes has its own fence, and each fence permits one shape:
 *
 *  1. `assertCommentOnly` — exactly `gh issue comment` or `gh pr comment`.
 *  2. `assertPrReadyOnly` — exactly `gh pr ready <number> --repo <repo>`, and
 *     nothing else at all: five tokens, the third all digits.
 *
 * WHY THE SECOND ONE EXISTS. The console could already SEE a draft PR and say
 * so on the card — "nobody can review it until you mark it ready" — and then
 * the repair was a trip to GitHub. Five PRs sat green, complete and
 * unreviewable that way (#5469, #5478, #5543, #5546, #5547), two of them for a
 * day. A console that reports a problem it could fix in one click is telling the
 * operator about work rather than doing it. Marking a PR ready is also the safest
 * possible write: it opens a diff for review, it merges nothing, and GitHub
 * keeps the whole history either way.
 *
 * Workers never call any of this. Only the console does, only on the operator's
 * explicit click, one act per click.
 */

export type GhWriteExec = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export type CommentTarget = {
  kind: 'issue' | 'pr';
  number: number;
};

const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ['issue', 'comment'],
  ['pr', 'comment'],
];

/** Throws unless the first two argv tokens are exactly a permitted comment write. */
export function assertCommentOnly(args: string[]): void {
  const a = args[0];
  const b = args[1];
  const ok = typeof a === 'string' && typeof b === 'string' && ALLOWED.some(([x, y]) => x === a && y === b);
  if (!ok) {
    const shown = args.slice(0, 2).join(' ') || '(nothing)';
    throw new Error(`refusing: the console may only post comments, not \`gh ${shown}\`. This is the only write it can do.`);
  }
}

/**
 * The pr-ready fence. Stricter than the comment one, because there is no body
 * and no legitimate variation: the whole argv is checked, not just its first two
 * tokens. A shape that is not exactly `pr ready <digits> --repo <repo>` throws
 * before a process exists.
 */
export function assertPrReadyOnly(args: string[]): void {
  const shaped =
    args.length === 5 &&
    args[0] === 'pr' &&
    args[1] === 'ready' &&
    typeof args[2] === 'string' &&
    /^[0-9]+$/.test(args[2]) &&
    args[3] === '--repo' &&
    typeof args[4] === 'string' &&
    args[4].length > 0;
  if (!shaped) {
    const shown = args.slice(0, 2).join(' ') || '(nothing)';
    throw new Error(
      `refusing: the only PR write the console may make is \`gh pr ready <number> --repo <repo>\`, not \`gh ${shown}\`.`,
    );
  }
}

/**
 * Mark a PR ready for review. No body, no interpolation, one act.
 *
 * A PR that is already ready comes back as an error from gh, and that is
 * reported as it is rather than smoothed into a success: the point of the button
 * is to say what actually happened to the PR.
 */
export async function markPrReady(
  pr: number,
  repo: string,
  opts?: { exec?: GhWriteExec },
): Promise<{ ok: boolean; error?: string }> {
  const args = ['pr', 'ready', String(pr), '--repo', repo];
  assertPrReadyOnly(args); // fence FIRST — before a process
  const { code, stderr, stdout } = await (opts?.exec ?? realGhExec)(args);
  if (code === 0) return { ok: true };
  return { ok: false, error: (stderr.trim() || stdout.trim() || `gh exited ${code}`).split('\n')[0] };
}

const realGhExec: GhWriteExec = (args) =>
  new Promise((resolve) => {
    execFile('gh', args, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/**
 * Write the body byte-exact to a temp file, then run the guarded gh call with
 * `--body-file` pointing at it. The body is never templated or interpolated —
 * what the operator approved is what lands on the file and what gh sends.
 */
export async function runGuardedGhWrite(
  args: string[],
  body: string,
  exec: GhWriteExec,
  tmpDir: string,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  assertCommentOnly(args); // fence FIRST — before a temp file, before a process

  const bodyFile = join(tmpDir, `wc-comment-${randomUUID()}.md`);
  await writeFile(bodyFile, body); // byte-exact, no trailing-newline munging
  const finalArgs = args.map((a) => (a === '__PLACEHOLDER__' ? bodyFile : a));
  const i = finalArgs.indexOf('--body-file');
  if (i !== -1) finalArgs[i + 1] = bodyFile;

  try {
    const { code, stdout, stderr } = await exec(finalArgs);
    if (code !== 0) return { ok: false, error: stderr.trim() || `gh exited with code ${code}` };
    const url = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    return { ok: true, url };
  } finally {
    await unlink(bodyFile).catch(() => {});
  }
}

export async function postIssueComment(
  repo: string,
  issue: number,
  body: string,
  opts?: { exec?: GhWriteExec; tmpDir?: string },
): Promise<{ ok: boolean; url?: string; error?: string }> {
  // The subcommand is hardcoded here; nothing the caller passes can change it.
  const args = ['issue', 'comment', String(issue), '--repo', repo, '--body-file', '__PLACEHOLDER__'];
  return runGuardedGhWrite(args, body, opts?.exec ?? realGhExec, opts?.tmpDir ?? tmpdir());
}

/** Post to the GitHub surface the worker named. Both paths stay comment-only. */
export async function postTargetComment(
  repo: string,
  target: CommentTarget,
  body: string,
  opts?: { exec?: GhWriteExec; tmpDir?: string },
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const args = [target.kind, 'comment', String(target.number), '--repo', repo, '--body-file', '__PLACEHOLDER__'];
  return runGuardedGhWrite(args, body, opts?.exec ?? realGhExec, opts?.tmpDir ?? tmpdir());
}

// --------------------------------------------------------------- request file

export type CommentRequest = {
  /** The issue whose work produced this request. Kept for legacy request files,
   *  where it is also the posting destination. */
  issue: number;
  /** Structured requests say what they are. Missing means a legacy free-form
   *  request written before this contract existed. */
  kind?: 'decision' | 'handoff';
  /** Where the comment belongs. Missing preserves the legacy issue target. */
  target?: CommentTarget;
  addressee: string;
  /** Whether the worker genuinely cannot continue without a reply. Missing is
   *  deliberately false: an old or malformed draft must never park work by
   *  accident. */
  blocks: boolean;
  /**
   * The handle this actually reaches, worked out from the addressee and whoever
   * raised the issue. Set on the row, not by the worker — see `addressee.ts`.
   */
  to?: Addressee;
  why: string;
  /** One optional context sentence and one direct question. For a decision the
   *  console builds draftBody from these fields, so an essay cannot be smuggled
   *  into the question card. */
  context?: string;
  question?: string;
  draftBody: string;
  sessionId: string | null;
  requestedAt: string | null;
};

/** Legacy request files posted on `issue`. New files name the destination. */
export function commentTarget(request: CommentRequest): CommentTarget {
  return request.target ?? { kind: 'issue', number: request.issue };
}

function oneLine(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && !/[\r\n]/.test(trimmed) ? trimmed : null;
}

function parseTarget(value: unknown): CommentTarget | null {
  if (typeof value !== 'object' || value === null) return null;
  const target = value as Record<string, unknown>;
  if (target.kind !== 'issue' && target.kind !== 'pr') return null;
  if (!Number.isInteger(target.number) || Number(target.number) <= 0) return null;
  return { kind: target.kind, number: Number(target.number) };
}

function decisionBody(addressee: string, context: string | undefined, question: string): string {
  const addressed = addressee.trim();
  const opening = [addressed, context].filter(Boolean).join(' — ');
  return opening ? `${opening}\n\n${question}` : question;
}

/** Parse `.comment-request.json`. Structured decisions produce their concise body here. */
export function parseCommentRequest(raw: string): CommentRequest | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.issue !== 'number') return null;

  const kind = r.kind === 'decision' || r.kind === 'handoff' ? r.kind : undefined;
  if (r.kind !== undefined && kind === undefined) return null;
  const target = r.target === undefined ? undefined : parseTarget(r.target);
  if (r.target !== undefined && target === null) return null;

  const addressee = typeof r.addressee === 'string' ? r.addressee.trim() : '';
  const why = typeof r.why === 'string' ? r.why.trim() : '';
  let context: string | undefined;
  let question: string | undefined;
  let draftBody: string;

  if (kind === 'decision') {
    // A decision is a genuine stop: somebody must answer before the work
    // can be correct or merge. It cannot simultaneously say "no reply needed".
    if (r.blocks !== true || target === undefined || !addressee || !oneLine(why)) return null;
    context = r.context === undefined ? undefined : (oneLine(r.context) ?? undefined);
    if (r.context !== undefined && context === undefined) return null;
    question = oneLine(r.question) ?? undefined;
    if (!question || !question.endsWith('?') || question.indexOf('?') !== question.lastIndexOf('?')) return null;
    draftBody = decisionBody(addressee, context, question);
  } else {
    if (typeof r.draftBody !== 'string' || !r.draftBody.trim()) return null; // never post nothing
    draftBody = r.draftBody;
    // New handoffs must name their destination. Legacy requests remain valid.
    if (kind === 'handoff' && (target === undefined || r.blocks === true)) return null;
  }

  return {
    issue: r.issue,
    ...(kind ? { kind } : {}),
    ...(target ? { target } : {}),
    addressee,
    blocks: r.blocks === true,
    why,
    ...(context ? { context } : {}),
    ...(question ? { question } : {}),
    draftBody,
    sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
    requestedAt: typeof r.requestedAt === 'string' ? r.requestedAt : null,
  };
}

/**
 * Identity of one request file's content.
 *
 * The file stays in the worktree until a worker next resumes. A successful
 * non-blocking post, or an explicit dismissal, therefore needs a durable way
 * to suppress THAT consumed request without hiding a genuinely new one. The
 * digest keeps the comment body out of state.json while every field that can
 * distinguish a later request participates in the identity.
 */
export function commentRequestKey(request: CommentRequest): string {
  // Keep the exact legacy tuple unchanged: otherwise every already-handled
  // request whose worker-owned file still lingers would reappear after upgrade.
  let raw: string;
  if (request.kind === undefined && request.target === undefined) {
    raw = JSON.stringify([
      request.issue,
      request.addressee,
      request.blocks,
      request.why,
      request.draftBody,
      request.sessionId,
      request.requestedAt,
    ]);
  } else if (request.kind === 'decision') {
    // The body is derived presentation, not worker-authored identity. A future
    // whitespace improvement must not resurrect an already-handled question.
    raw = JSON.stringify([
      request.issue,
      request.kind,
      request.target,
      request.addressee,
      request.blocks,
      request.why,
      request.context,
      request.question,
      request.sessionId,
      request.requestedAt,
    ]);
  } else {
    raw = JSON.stringify([
      request.issue,
      request.kind,
      request.target,
      request.addressee,
      request.blocks,
      request.why,
      request.draftBody,
      request.sessionId,
      request.requestedAt,
    ]);
  }
  return createHash('sha256').update(raw).digest('hex');
}

// ------------------------------------------------------------- reply tracking

/**
 * The reply we are blocked on: the first comment on the issue that lands strictly
 * after our post, authored by anyone other than the operator. Read-only — this
 * only reads `gh issue view --json comments`.
 */
export function detectReply(
  comments: unknown[],
  postedAt: string,
  me: string,
): { author: string; createdAt: string; body: string } | null {
  const postedMs = Date.parse(postedAt);
  for (const c of comments) {
    if (typeof c !== 'object' || c === null) continue;
    const r = c as { author?: { login?: unknown }; createdAt?: unknown; body?: unknown };
    const login = typeof r.author?.login === 'string' ? r.author.login : '';
    const createdAt = typeof r.createdAt === 'string' ? r.createdAt : '';
    if (!createdAt || !login) continue;
    if (login === me) continue;
    if (Date.parse(createdAt) > postedMs) {
      return { author: login, createdAt, body: typeof r.body === 'string' ? r.body : '' };
    }
  }
  return null;
}
