/**
 * The GitHub-quota brake, and the honest words for when it bites.
 *
 * Two measured facts shape this file:
 *
 *  1. `GET /rate_limit` is FREE on every bucket — `core.used` stayed at 4 across
 *     three consecutive calls and the graphql counter never moved. So the brake
 *     reads the number fresh, every poll, instead of trusting the `rateLimit`
 *     rider off the last successful omnibus.
 *  2. The bucket this guards is not drained by the console. A poll costs 2
 *     points; the Claude worker sessions on the same token burned ~3,600 in 52
 *     minutes. A rider up to fifteen minutes old about a bucket someone else is
 *     draining at 13–70 points a minute is worthless: "900 left" can be 0 by the
 *     next poll.
 *
 * And because the graphql bucket is a FIXED HOURLY WINDOW, the pause has to know
 * about `reset`. A bare floor with no window awareness keeps the feed dark for up
 * to 59 minutes on a number that expired the instant the hour rolled over — the
 * feed going dark for exactly the hour the actions arrive in.
 *
 * Nothing here calls the network. `readGraphqlQuota` in gh.ts does that.
 */

export type QuotaReading = { remaining: number; limit: number; resetAt: string };

export type BrakeInput = {
  /** The reading from `GET /rate_limit`, or null when it could not be read. */
  quota: QuotaReading | null;
  floor: number;
  now: Date;
  /** True when the operator pressed Refresh. They outrank the brake, always. */
  manual: boolean;
};

export type Brake = { paused: boolean; reason: string | null };

const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '??:??'
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function quotaBrake({ quota, floor, now, manual }: BrakeInput): Brake {
  if (manual) return { paused: false, reason: null };
  // A reading we could not get is a network blip, not an exhausted budget.
  // Failing closed here would take the feed down for the wrong reason.
  if (!quota) return { paused: false, reason: null };
  // The window has already rolled: whatever the number said, it is spent.
  const resetMs = Date.parse(quota.resetAt);
  if (Number.isFinite(resetMs) && now.getTime() > resetMs) return { paused: false, reason: null };
  if (quota.remaining >= floor) return { paused: false, reason: null };
  return {
    paused: true,
    reason:
      `GitHub quota low (${quota.remaining} of ${quota.limit} left, resets ${hhmm(quota.resetAt)}) — ` +
      'automatic action reads paused until then. Refresh still forces one.',
  };
}

export type BannerInput = {
  /** When the rows on screen were READ. Null = GitHub has never answered. */
  fetchedAt: string | null;
  /** Why the last attempt failed, in a few words. Null = it did not. */
  error: string | null;
  resetAt: string | null;
  empty: boolean;
  /** Which list GitHub cut short, with both numbers. Null = none was. */
  truncated?: string | null;
};

/**
 * The console's existing convention: say what is stale, never pretend it is
 * fresh. The age shown is the age of the DATA, never of the attempt — the same
 * rule as the "GitHub read HH:MM" stamp in the header.
 */
export function staleBanner({ fetchedAt, error, resetAt, empty, truncated }: BannerInput): string | null {
  // A SHORT list is not a failed read, so it does not go through the stale
  // wording — but it must never render as a complete one either. It outranks
  // nothing: if the read also failed, that is the more urgent sentence.
  if (!error && truncated) {
    return `Showing part of the list — GitHub returned ${truncated}. Anything past that is not on this page.`;
  }
  if (!error) return null;
  if (fetchedAt === null) return 'GitHub has not been read yet — the feed fills after the first read.';
  if (empty) return `Nothing needed you as of ${hhmm(fetchedAt)} — GitHub has not answered since (${error}).`;
  const again = resetAt ? ` — reading again after ${hhmm(resetAt)}` : '';
  return (
    `Stale — actions as of ${hhmm(fetchedAt)}. GitHub did not answer (${error})${again}. ` +
    'Rows below may already be handled.'
  );
}

/**
 * What a read that took the OTHER road says for itself. Null when the poll went
 * the usual way, which is almost every poll.
 *
 * The rule this file already keeps, pointed the other way. `staleBanner` exists
 * so a stale page never looks fresh; this exists so a DEGRADED read never looks
 * like the full one — and, when it IS the full one, so it never looks like a
 * failure either. Those are two different sentences in two different registers,
 * and the line carries its own, because the page cannot tell them apart from the
 * words alone. A whole read renders quiet: the map is complete, every row below
 * knows where its PR stands, and a warning over a correct board teaches the
 * operator to ignore warnings. A CAPPED read renders as a warning, because the
 * board below it has rows that have gone to "cannot say" — and styling that like
 * the "GitHub read HH:MM" stamp is how the one case worth acting on gets read as
 * furniture.
 *
 * It says how many it found because that number is the whole claim. On
 * 2026-09-05 the map the console needed held 21 PRs, and "REST answered" without
 * a count would have been true of an empty map too.
 */
export type FallbackInput = {
  /** Why the usual read was refused, in a few words. */
  because: string;
  /** How many merged PRs the other road found. */
  found: number;
  /** It ran out of pages before it ran out of window. */
  capped: boolean;
};

/** The finished line and the register to say it in. The page renders, it does
 *  not decide. */
export type FallbackBanner = { text: string; warn: boolean };

export function fallbackBanner(read: FallbackInput | null): FallbackBanner | null {
  if (!read) return null;
  const found = `${read.found} merged PR${read.found === 1 ? '' : 's'}`;
  const how = `The merged-PR list came from GitHub's REST API this poll — the usual GraphQL read was refused (${read.because}).`;
  // The cap is the one thing this read can lose, so it is the one thing the
  // line has to admit. It loses the OLD end of the window, and it says what the
  // board did about it — otherwise the rows reading "cannot say where its PR
  // stands" have no explanation anywhere on the page. No page count in the
  // wording: the cap lives in gh.ts, and a number repeated across two files is a
  // number that goes stale in one of them.
  return read.capped
    ? {
        text:
          `${how} It read ${found} and then stopped at its page limit, so a PR merged early in the window may be ` +
          'missing — rows it could not account for say so rather than guess.',
        warn: true,
      }
    : { text: `${how} It read ${found}, the whole window.`, warn: false };
}
