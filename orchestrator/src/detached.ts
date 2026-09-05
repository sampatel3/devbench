/**
 * The operator can always take a session over in their own terminal with
 * `claude --resume <id>`.
 * Two owners on one session fork it, so the console has to notice and stop
 * treating that worker as its own.
 *
 * Signal: OUR OWN session transcript's mtime. When our child exits we remember
 * the mtime it left behind. Detached only fires when that same session's
 * transcript grows after our exit while we are running nothing — that is a
 * takeover. A newer transcript belonging to a DIFFERENT session id in the same
 * worktree is unrelated work (a stray one-off `claude` smoke-test in the
 * worktree), not a takeover, and must never trip this — that false positive is
 * what stuck #4329 in "detached" forever.
 */
const JITTER_MS = 2000;

export function decideDetached(input: {
  weAreRunning: boolean;
  transcriptMtimeMs: number | null;
  mtimeAtOurExit: number | null;
  /** The session id `transcriptMtimeMs` belongs to (the worktree's newest). */
  newestSessionId: string | null;
  /** The session id the console spawned for this issue. */
  ourSessionId: string | null;
}): boolean {
  const { weAreRunning, transcriptMtimeMs, mtimeAtOurExit, newestSessionId, ourSessionId } = input;
  if (weAreRunning) return false;
  if (transcriptMtimeMs === null) return false;
  // Never ran it ourselves: it is somebody's earlier work, not a takeover.
  if (mtimeAtOurExit === null) return false;
  // The grown transcript must be OUR OWN session's. A different session id is
  // unrelated work in the same worktree, not a takeover of what we spawned.
  if (ourSessionId === null || newestSessionId !== ourSessionId) return false;
  return transcriptMtimeMs - mtimeAtOurExit > JITTER_MS;
}
