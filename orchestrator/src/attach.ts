/**
 * Handing a worker a screenshot — the naming and fencing half.
 *
 * Evidence only ever travelled one way. A worker wrote files under
 * `docs/issue-pipeline/plans/` and the console served them read-only
 * (`resolveEvidencePath`); nothing could go the other way. So when QA failed
 * #4847 with two screenshots, the worker could not look at them: it stopped at a
 * gate asking which surface the screenshot came from — a question a picture
 * answers instantly — and the answer had to be typed by hand.
 *
 * The write is more dangerous than the read it mirrors, so it is stricter in
 * four ways rather than symmetrical:
 *
 *  - the FILENAME IS GENERATED. Nothing the client sends becomes a path
 *    component, so traversal is not something to defend against — it is absent
 *    by construction.
 *  - ONE FIXED DIRECTORY. Not a caller-chosen subtree, so there is no path to
 *    validate beyond the one this module builds.
 *  - AN EXTENSION ALLOWLIST, never a denylist. `.svg` is refused despite being
 *    an image, because it carries script; anything unnamed is refused by
 *    default, which is the safe direction for a list that will be added to.
 *  - A SIZE CAP, because the browser will happily hand over a 40 MB paste.
 */
import { isAbsolute, join } from 'node:path';

/** Where an attachment lands, relative to the worktree root. Deliberately under
 *  the plans tree the read fence already serves, so a worker can be pointed at it
 *  by repo-relative path and the gate card can render it with no new plumbing. */
export const ATTACH_DIR = 'docs/issue-pipeline/plans/attachments';

/** 25 MB. A screenshot is under 5; a multi-page PDF can be more. */
export const MAX_ATTACH_BYTES = 25 * 1024 * 1024;

/** What a screenshot or a document actually arrives as. `.svg` is NOT here and
 *  must not be added: it is markup, it can carry script, and the gate card
 *  renders attachments inline. */
const ALLOWED = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf']);

const stamp = (at: Date): string =>
  `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}${String(at.getUTCDate()).padStart(2, '0')}` +
  `-${String(at.getUTCHours()).padStart(2, '0')}${String(at.getUTCMinutes()).padStart(2, '0')}`;

/**
 * A stored name built from a timestamp and a slug of what the client called it.
 *
 * The original name is used ONLY as a hint for the stem — it never contributes a
 * separator, a dot-segment or a NUL, because everything outside `[a-z0-9-]` is
 * replaced before it is used.
 */
export function attachmentName(original: string, at: Date): string {
  const raw = typeof original === 'string' ? original : '';
  // `dot >= 0`, not `> 0`: a dotfile-shaped name like `.png` is an extension with
  // no stem, and reading it as a stem produced `…-png.bin` — the wrong extension,
  // which the allowlist would then refuse for the wrong reason.
  const dot = raw.lastIndexOf('.');
  const rawExt = dot >= 0 && dot < raw.length - 1 ? raw.slice(dot + 1) : '';
  const ext = /^[A-Za-z0-9]+$/.test(rawExt) ? rawExt.toLowerCase() : 'bin';
  const stem =
    (dot >= 0 ? raw.slice(0, dot) : raw)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'attachment';
  return `${stamp(at)}-${stem}.${ext}`;
}

export type AttachTarget =
  | { ok: true; reason: 'ok'; absPath: string; repoRelative: string; name: string }
  | { ok: false; reason: string };

/**
 * Where this attachment may be written, or why it may not be.
 *
 * `bytes` is checked here rather than at the route so the cap and the allowlist
 * are refused by the same function that names the file — a caller cannot get a
 * path back and then write something else to it.
 */
export function resolveAttachmentTarget(
  worktree: string | null,
  originalName: string,
  bytes: number,
  at: Date = new Date(),
): AttachTarget {
  if (!worktree) return { ok: false, reason: 'no worktree for this issue' };
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, reason: 'refusing: empty file' };
  if (bytes > MAX_ATTACH_BYTES) {
    return { ok: false, reason: `refusing: too large (${bytes} bytes, cap ${MAX_ATTACH_BYTES})` };
  }

  const name = attachmentName(originalName, at);
  const ext = name.slice(name.lastIndexOf('.') + 1);
  if (!ALLOWED.has(ext)) {
    return { ok: false, reason: `refusing: unsupported type .${ext} — allowed: ${[...ALLOWED].join(', ')}` };
  }

  // Belt and braces. The name is generated above, so neither of these can fire —
  // they are here so that a future edit to `attachmentName` cannot quietly turn
  // this into a path the caller controls.
  if (name.includes('/') || name.includes('\\') || name.includes('\0') || isAbsolute(name)) {
    return { ok: false, reason: 'refusing: bad name' };
  }

  const repoRelative = `${ATTACH_DIR}/${name}`;
  return { ok: true, reason: 'ok', absPath: join(worktree, repoRelative), repoRelative, name };
}
