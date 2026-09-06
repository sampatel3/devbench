import { realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';

/**
 * QA evidence — the artifacts a worker writes under docs/issue-pipeline/plans/qa-<N>/
 * and lists in .gate.json so the operator can review them at the gate, before the PR.
 *
 * Serving these files out of a worktree is a path-traversal vector, so this
 * module is the fence. Nothing outside `docs/issue-pipeline/plans/` of the specific
 * worktree is ever resolvable, checked with realpath so a symlink cannot tunnel
 * out either.
 *
 * The fence and the manifest parser are two different jobs and this file used to
 * blur them: the parser refused a malformed entry the same silent way it refused
 * an escape, so a worker's typo and an attempted traversal both rendered as an
 * empty evidence box. They are separated now. The parser COERCES anything it can
 * read losslessly, and hands back what it still cannot as `EvidenceDrop` —
 * visible on the card. The fence itself is unchanged and unmoved.
 */

export const EVIDENCE_ROOT = 'docs/issue-pipeline/plans';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const SQL_EXT = /\.sql$/i;
const KINDS = new Set(['screenshot', 'transcript', 'sql', 'report']);

export type EvidenceItem = {
  kind: 'screenshot' | 'transcript' | 'sql' | 'report';
  path: string;
  caption: string;
  isImage: boolean;
};

/**
 * An entry this parser could not keep, and why.
 *
 * It exists because the silent version of it cost a gate. Read across 13 live
 * worktrees, `parseEvidence` was dropping 130 entries: 100 of them a real,
 * in-tree path written as a bare string instead of an object, 18 an object
 * whose only sin was a missing caption, 2 a path outside the plans root. Every
 * one vanished between the file and the card, and #4698 stopped at Gate C with
 * twelve real screenshots on disk, an empty evidence box, and an approval given
 * without them.
 *
 * The first two of those are now COERCED — nothing is lost by guessing a kind
 * from a file extension or by showing a caption-less picture. The rest cannot
 * be coerced without weakening the fence, so they come back as this instead:
 * a refusal the operator reads, rather than a hole they cannot see.
 */
export type EvidenceDrop = {
  /** The path as the worker wrote it, or '' when the entry had none to name. */
  path: string;
  /** Why it could not be shown, in the operator's words, not the parser's. */
  reason: string;
};

/** True only when `child` sits strictly inside `parent` (no `..`, not equal). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** A repo-relative path that is safe on its face: relative, and under the plans root.
 *  Exported because the click-script's own screenshots are served through the same
 *  route and must pass the same fence — one rule, in one place. */
export function isUnderPlansRoot(p: string): boolean {
  if (isAbsolute(p)) return false;
  // Resolve against a virtual root so `..` segments are collapsed before we test.
  const virtualRoot = '/__repo__';
  const full = resolve(virtualRoot, p);
  return isInside(resolve(virtualRoot, EVIDENCE_ROOT), full);
}

/**
 * The kind of a file we were told nothing about. Two rules and a default: a
 * picture is a screenshot, `.sql` is sql, everything else is a report — which is
 * the same default an unrecognised `kind` string already fell to. `kind` decides
 * only the label on a text item; `isImage` decides how it renders, and that is
 * read off the extension either way.
 */
function kindFromPath(path: string): EvidenceItem['kind'] {
  if (IMAGE_EXT.test(path)) return 'screenshot';
  if (SQL_EXT.test(path)) return 'sql';
  return 'report';
}

/**
 * The manifest, with what it could not keep.
 *
 * Coercion is lossless or it does not happen. A bare string IS the path — a
 * worker that writes `"docs/issue-pipeline/plans/qa-4698/s1-after.png"` has told us
 * everything except a caption and a kind, and both of those are recoverable from
 * the path itself. A missing caption is an empty caption, not a missing picture.
 *
 * What is NOT coerced is the fence. `isUnderPlansRoot` refuses exactly what it
 * refused before — the evidence route re-checks it against the real filesystem,
 * so this is the cheap half of a two-part guard and it does not move. The only
 * change is that a refusal now leaves with a reason attached.
 */
export function readEvidence(raw: unknown): { items: EvidenceItem[]; dropped: EvidenceDrop[] } {
  if (!Array.isArray(raw)) return { items: [], dropped: [] };
  const items: EvidenceItem[] = [];
  const dropped: EvidenceDrop[] = [];
  for (const item of raw) {
    // A bare string is a path with the object left off around it — the single
    // most common way this manifest is written wrong, and 100 of the 130 losses.
    const object = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
    const r: Record<string, unknown> = typeof item === 'string' ? { path: item } : object;
    if (typeof r.path !== 'string' || !r.path) {
      dropped.push({ path: '', reason: 'no path' });
      continue;
    }
    if (!isUnderPlansRoot(r.path)) {
      dropped.push({ path: r.path, reason: `outside ${EVIDENCE_ROOT}/` });
      continue;
    }
    const kind = typeof r.kind === 'string' && KINDS.has(r.kind) ? (r.kind as EvidenceItem['kind']) : kindFromPath(r.path);
    // A caption that is missing, or is not a string, is an absent caption. It
    // costs the "what to notice" line and nothing else, and the picture is worth
    // more than the sentence about it.
    const caption = typeof r.caption === 'string' ? r.caption : '';
    items.push({ kind, path: r.path, caption, isImage: IMAGE_EXT.test(r.path) });
  }
  return { items, dropped };
}

/** The manifest alone. Every caller that only renders evidence uses this one. */
export function parseEvidence(raw: unknown): EvidenceItem[] {
  return readEvidence(raw).items;
}

/**
 * The refusals as ONE finished line for the gate card, or null when nothing was
 * refused. Composed here rather than in the browser on the standing rule: the
 * server writes the sentence, the page renders it.
 */
export function evidenceWarning(dropped: EvidenceDrop[]): string | null {
  if (dropped.length === 0) return null;
  const n = dropped.length;
  const each = dropped.map((d) => (d.path ? `${d.reason} (${d.path})` : d.reason)).join('; ');
  return `${n} evidence ${n === 1 ? 'entry' : 'entries'} could not be shown — ${each}`;
}

/**
 * Resolve a requested evidence path against ONE worktree, or refuse. The order
 * matters: reject absolute/`..` on the face first, then realpath both the root
 * and the target and require the real target to still sit inside the real root —
 * that last check is what a symlink cannot get past.
 */
export function resolveEvidencePath(
  worktree: string | null,
  requested: string,
): { ok: boolean; reason: string; absPath?: string } {
  if (!worktree) return { ok: false, reason: 'no worktree for this issue' };
  if (typeof requested !== 'string' || !requested) return { ok: false, reason: 'no path given' };
  // A NUL byte truncates the path at the C level and is caught today only
  // because `realpathSync` happens to throw on it — which reports a refusal as
  // "not found" and leaves the guard depending on how fs behaves. Say it here.
  if (requested.includes('\0')) return { ok: false, reason: 'refusing: bad path' };
  if (isAbsolute(requested)) return { ok: false, reason: 'refusing: path is outside the plans tree (absolute)' };
  if (!isUnderPlansRoot(requested)) return { ok: false, reason: 'refusing: path is outside the plans tree' };

  const plansRoot = join(worktree, EVIDENCE_ROOT);
  const target = join(worktree, requested);

  // The real (symlink-resolved) root must exist; if it does not there is nothing to serve.
  let realRoot: string;
  try {
    realRoot = realpathSync(plansRoot);
  } catch {
    return { ok: false, reason: 'not found: no plans directory in this worktree' };
  }

  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    return { ok: false, reason: 'not found: no such evidence file' };
  }

  // The load-bearing check: after following every symlink, are we still inside?
  if (realTarget !== realRoot && !isInside(realRoot, realTarget)) {
    return { ok: false, reason: 'refusing: resolved path is outside the plans tree' };
  }
  return { ok: true, reason: 'ok', absPath: realTarget };
}
