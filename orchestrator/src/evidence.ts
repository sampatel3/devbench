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
 */

export const EVIDENCE_ROOT = 'docs/issue-pipeline/plans';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const KINDS = new Set(['screenshot', 'transcript', 'sql', 'report']);

export type EvidenceItem = {
  kind: 'screenshot' | 'transcript' | 'sql' | 'report';
  path: string;
  caption: string;
  isImage: boolean;
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

export function parseEvidence(raw: unknown): EvidenceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: EvidenceItem[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.path !== 'string' || !r.path) continue;
    if (typeof r.caption !== 'string') continue;
    if (!isUnderPlansRoot(r.path)) continue; // drop escapes at manifest time too
    const kind = typeof r.kind === 'string' && KINDS.has(r.kind) ? (r.kind as EvidenceItem['kind']) : 'report';
    out.push({ kind, path: r.path, caption: r.caption, isImage: IMAGE_EXT.test(r.path) });
  }
  return out;
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
