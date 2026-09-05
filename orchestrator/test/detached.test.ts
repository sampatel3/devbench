import { describe, it, expect } from 'vitest';
import { decideDetached } from '../src/detached.js';

/**
 * "Detached" means the operator took the session over in a terminal with
 * `claude --resume <id>`. Two owners on one session fork it, so the console has
 * to notice and back off.
 *
 * The signal is OUR OWN session transcript's mtime: when our own child exits we
 * record the mtime we left behind. If that same session's file grows after that
 * while we are not running anything, somebody else is driving. A newer transcript
 * belonging to a DIFFERENT session id in the worktree is unrelated work, not a
 * takeover.
 */
describe('decideDetached', () => {
  const t0 = 1_700_000_000_000;
  const ours = 'sess-ours';

  it('is not detached while we are the one running it', () => {
    expect(
      decideDetached({
        weAreRunning: true,
        transcriptMtimeMs: t0 + 9999,
        mtimeAtOurExit: t0,
        newestSessionId: ours,
        ourSessionId: ours,
      }),
    ).toBe(false);
  });

  it('is detached when OUR OWN session transcript grows after our child exited', () => {
    expect(
      decideDetached({
        weAreRunning: false,
        transcriptMtimeMs: t0 + 5000,
        mtimeAtOurExit: t0,
        newestSessionId: ours,
        ourSessionId: ours,
      }),
    ).toBe(true);
  });

  it('is not detached when the transcript has not moved since our child exited', () => {
    expect(
      decideDetached({
        weAreRunning: false,
        transcriptMtimeMs: t0,
        mtimeAtOurExit: t0,
        newestSessionId: ours,
        ourSessionId: ours,
      }),
    ).toBe(false);
  });

  it('ignores sub-second jitter so a filesystem timestamp rounding is not a takeover', () => {
    expect(
      decideDetached({
        weAreRunning: false,
        transcriptMtimeMs: t0 + 900,
        mtimeAtOurExit: t0,
        newestSessionId: ours,
        ourSessionId: ours,
      }),
    ).toBe(false);
  });

  it('is not detached for a session this console has never run — that is just old work', () => {
    // No recorded exit mtime: the worktree was there before the console started.
    // Crash recovery adopts it as a checkpoint; it only becomes detached once it
    // moves under our nose.
    expect(
      decideDetached({
        weAreRunning: false,
        transcriptMtimeMs: t0,
        mtimeAtOurExit: null,
        newestSessionId: ours,
        ourSessionId: null,
      }),
    ).toBe(false);
  });

  it('is not detached when there is no transcript at all', () => {
    expect(
      decideDetached({
        weAreRunning: false,
        transcriptMtimeMs: null,
        mtimeAtOurExit: t0,
        newestSessionId: null,
        ourSessionId: ours,
      }),
    ).toBe(false);
  });

  it('#4329 regression: a newer transcript from a DIFFERENT session id is not a takeover', () => {
    // A stray one-off `claude` smoke-test in the worktree wrote its own session
    // transcript, newer than our recorded exit by a mile. It is not our session,
    // so it must not read as detached — this is the bug that stuck #4329.
    expect(
      decideDetached({
        weAreRunning: false,
        transcriptMtimeMs: t0 + 3_600_000,
        mtimeAtOurExit: t0,
        newestSessionId: 'sess-stray-smoke-test',
        ourSessionId: ours,
      }),
    ).toBe(false);
  });

  it('is not detached when we never pinned a session id, even if a transcript grew', () => {
    expect(
      decideDetached({
        weAreRunning: false,
        transcriptMtimeMs: t0 + 5000,
        mtimeAtOurExit: t0,
        newestSessionId: 'sess-someone-else',
        ourSessionId: null,
      }),
    ).toBe(false);
  });
});
