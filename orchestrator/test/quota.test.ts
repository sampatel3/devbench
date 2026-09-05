import { describe, it, expect } from 'vitest';
import { quotaBrake, staleBanner } from '../src/quota.js';

/**
 * The brake. The bucket it guards is not drained by this console — measured, the
 * Claude worker sessions burned ~3,600 graphql points in 52 minutes while a poll
 * costs 2. So the brake exists to stop the console making a bad hour worse, and
 * it must never latch the feed dark for the rest of an hour.
 */

const RESET = '2026-08-12T11:26:24Z';

/** These strings are shown to the operator, so they are in the LOCAL clock, not
 *  UTC — the same rule as the header's "GitHub read HH:MM". Computed, never pinned, so the
 *  suite does not depend on the machine's timezone. */
const local = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const RESET_HHMM = local(RESET);
const READ_HHMM = local('2026-08-12T09:12:00Z');

describe('quotaBrake — free, real-time, and WINDOW-aware', () => {
  it('lets a timer poll through when there is plenty left', () => {
    const b = quotaBrake({
      quota: { remaining: 4000, limit: 5000, resetAt: RESET },
      floor: 500,
      now: new Date('2026-08-12T11:00:00Z'),
      manual: false,
    });
    expect(b.paused).toBe(false);
    expect(b.reason).toBeNull();
  });

  it('stops a timer poll under the floor, and says when it will try again', () => {
    const b = quotaBrake({
      quota: { remaining: 412, limit: 5000, resetAt: RESET },
      floor: 500,
      now: new Date('2026-08-12T11:00:00Z'),
      manual: false,
    });
    expect(b.paused).toBe(true);
    expect(b.reason).toBe(
      `GitHub quota low (412 of 5000 left, resets ${RESET_HHMM}) — automatic action reads paused until then. Refresh still forces one.`,
    );
  });

  it('UNPAUSES the moment the window resets, without a fresh reading', () => {
    // A floor with no window awareness pauses for up to 59 minutes on a number
    // that expired the instant the hour rolled.
    const b = quotaBrake({
      quota: { remaining: 12, limit: 5000, resetAt: RESET },
      floor: 500,
      now: new Date('2026-08-12T11:26:25Z'),
      manual: false,
    });
    expect(b.paused).toBe(false);
  });

  it('the operator outranks the brake — a manual Refresh always reads', () => {
    const b = quotaBrake({
      quota: { remaining: 0, limit: 5000, resetAt: RESET },
      floor: 500,
      now: new Date('2026-08-12T11:00:00Z'),
      manual: true,
    });
    expect(b.paused).toBe(false);
  });

  it('a quota it could not read is not a reason to stop reading', () => {
    // /rate_limit failing is a network blip, not an exhausted budget. Failing
    // closed here would take the feed down for the wrong reason.
    const b = quotaBrake({ quota: null, floor: 500, now: new Date(), manual: false });
    expect(b.paused).toBe(false);
  });

  it('at exactly the floor it still reads; below it stops', () => {
    const arg = (remaining: number) => ({
      quota: { remaining, limit: 5000, resetAt: RESET },
      floor: 500,
      now: new Date('2026-08-12T11:00:00Z'),
      manual: false,
    });
    expect(quotaBrake(arg(500)).paused).toBe(false);
    expect(quotaBrake(arg(499)).paused).toBe(true);
  });
});

describe('staleBanner — say what is stale, never pretend', () => {
  it('names the age of the DATA and the reason, and warns the rows may be handled', () => {
    expect(
      staleBanner({ fetchedAt: '2026-08-12T09:12:00Z', error: 'rate limited', resetAt: RESET, empty: false }),
    ).toBe(
      `Stale — actions as of ${READ_HHMM}. GitHub did not answer (rate limited) — reading again after ${RESET_HHMM}. Rows below may already be handled.`,
    );
  });

  it('an empty-and-stale feed does not read as "nothing needs you"', () => {
    expect(staleBanner({ fetchedAt: '2026-08-12T09:12:00Z', error: 'rate limited', resetAt: null, empty: true })).toBe(
      `Nothing needed you as of ${READ_HHMM} — GitHub has not answered since (rate limited).`,
    );
  });

  it('says so plainly when GitHub has never been read', () => {
    expect(staleBanner({ fetchedAt: null, error: 'rate limited', resetAt: null, empty: true })).toBe(
      'GitHub has not been read yet — the feed fills after the first read.',
    );
  });

  it('is null when the last read worked', () => {
    expect(staleBanner({ fetchedAt: '2026-08-12T09:12:00Z', error: null, resetAt: null, empty: false })).toBeNull();
  });
});

/**
 * A SHORT list is a different failure from a FAILED read, and the page had no
 * way to say either. Every `first:` in the omnibus is a silent cap; nothing
 * asked GitHub how many rows there really were, so thirty-of-sixty rendered
 * identically to sixty-of-sixty — under the words "Nothing on GitHub needs you."
 */
describe('the banner when GitHub gave a short list', () => {
  it('says so, names the list, and gives both numbers', () => {
    expect(
      staleBanner({ fetchedAt: '2026-08-12T09:00:00Z', error: null, resetAt: null, empty: false, truncated: 'assigned issues (30 of 64 read)' }),
    ).toBe('Showing part of the list — GitHub returned assigned issues (30 of 64 read). Anything past that is not on this page.');
  });

  it('is silent when nothing was cut, exactly as before', () => {
    expect(staleBanner({ fetchedAt: '2026-08-12T09:00:00Z', error: null, resetAt: null, empty: false, truncated: null })).toBeNull();
    expect(staleBanner({ fetchedAt: '2026-08-12T09:00:00Z', error: null, resetAt: null, empty: false })).toBeNull();
  });

  it('yields to a failed read — that is the more urgent sentence', () => {
    const b = staleBanner({
      fetchedAt: '2026-08-12T09:00:00Z',
      error: 'API rate limit exceeded',
      resetAt: null,
      empty: false,
      truncated: 'assigned issues (30 of 64 read)',
    });
    expect(b).toContain('Stale');
    expect(b).toContain('rate limit');
  });
});
