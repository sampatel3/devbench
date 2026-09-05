/**
 * HOW LONG EACH LEG TAKES, and whether one ticket is quicker or slower than the
 * rest.
 *
 * What the operator asked for: the minutes between ticket assigned and PR
 * raised, PR raised and PR merged, PR merged and PR closed — averaged, and
 * monitored per ticket so one can be seen to be running below or above them.
 *
 * THE THREE LEGS, and what each end actually is — because every one of these is
 * the nearest honest thing the console holds rather than the words themselves:
 *
 *   start → raise   The board card moving to `In progress`, to gate D being
 *                   approved. "Assigned" is not recorded anywhere; the move to
 *                   In progress is when work began, and gate D IS the approval
 *                   to raise the PR (`prsRaisedFrom`), which lands a minute or
 *                   two before the PR itself.
 *   raise → merge   Gate D to the merge the console announced.
 *   merge → close   The merge to the issue being closed on GitHub, which is
 *                   after QA has signed it off. The ask said "PR merged, PR
 *                   closed"; a merged PR is already closed, so the only interval
 *                   with anything in it is the one that ends the pipeline.
 *
 * MEDIAN IS THE HEADLINE, not the mean. These are durations with a long tail —
 * one ticket that sat over a weekend drags a mean far enough to make every
 * ordinary ticket look fast. Both are computed and both are shown; the
 * faster/slower verdict is against the median.
 *
 * A LEG IS ONLY COUNTED WHEN BOTH ENDS EXIST AND ARE IN ORDER. An end that is
 * missing is not a zero, and an out-of-order pair — a merge stamped before its
 * gate D, which branch reuse can produce — is dropped rather than recorded as a
 * negative duration.
 */

/** The four moments, per issue. Any of them may be unknown. */
export type Milestones = {
  issue: number;
  startedAt: string | null;
  raisedAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
};

/** The three legs, in whole minutes. Null when it cannot honestly be measured. */
export type Legs = {
  toRaise: number | null;
  toMerge: number | null;
  toClose: number | null;
};

export type LegKey = keyof Legs;

export const LEG_KEYS: LegKey[] = ['toRaise', 'toMerge', 'toClose'];

/** What each leg is called where a person reads it. */
export const LEG_LABEL: Record<LegKey, string> = {
  toRaise: 'start → PR raised',
  toMerge: 'PR raised → merged',
  toClose: 'merged → issue closed',
};

export type Stat = {
  /** How many tickets this is the average OF. Shown, always: an average of two is not one. */
  n: number;
  medianMin: number | null;
  meanMin: number | null;
};

export type CycleSummary = Record<LegKey, Stat>;

/** Minutes between two instants, or null when either end is missing or they are out of order. */
function minutesBetween(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // Out of order is DROPPED, not negated. Branch reuse can stamp a merge before
  // the gate D of the PR that followed it, and a negative duration in an
  // average is worse than a missing one.
  if (b < a) return null;
  return Math.round((b - a) / 60_000);
}

export function legsOf(m: Milestones): Legs {
  return {
    toRaise: minutesBetween(m.startedAt, m.raisedAt),
    toMerge: minutesBetween(m.raisedAt, m.mergedAt),
    toClose: minutesBetween(m.mergedAt, m.closedAt),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * The floor under every comparison in this file — a ticket against the pack,
 * and a week against the month.
 *
 * Fewer than this many measured legs and nothing is said at all. A ticket
 * called "slower than average" against an average of two is being judged by
 * noise, and the console says nothing rather than that.
 */
export const MIN_SAMPLE = 5;

/** Within this much of the median counts as neither faster nor slower. */
export const NEAR_PCT = 0.15;

/**
 * WHICH MOMENT ENDS EACH LEG.
 *
 * A leg belongs to the week it FINISHED in, not the week it started: a PR
 * merged on Monday is Monday's raised → merged however long it had been open.
 * Bucketing by the start would put a leg in a week before it had a length.
 */
const LEG_END: Record<LegKey, keyof Pick<Milestones, 'raisedAt' | 'mergedAt' | 'closedAt'>> = {
  toRaise: 'raisedAt',
  toMerge: 'mergedAt',
  toClose: 'closedAt',
};

/**
 * The same three averages, over only the legs that FINISHED since `sinceMs`.
 *
 * The operator asked for a week's average beside the overall one, to monitor
 * progress. A level on its own says nothing about whether things are getting
 * better; the pair does.
 *
 * Each leg is filtered by its OWN end, so a window can contain a merge
 * without containing the start of the work that produced it — which is the
 * ordinary case and must not silently drop the leg.
 */
export function summariseSince(
  rows: readonly (Milestones & { legs: Legs })[],
  sinceMs: number,
): CycleSummary {
  const out = {} as CycleSummary;
  for (const key of LEG_KEYS) {
    const values: number[] = [];
    for (const row of rows) {
      const value = row.legs[key];
      if (value === null) continue;
      const end = row[LEG_END[key]];
      if (end === null) continue;
      const at = Date.parse(end);
      if (Number.isFinite(at) && at >= sinceMs) values.push(value);
    }
    out[key] = { n: values.length, medianMin: median(values), meanMin: mean(values) };
  }
  return out;
}

/**
 * Is the recent window better or worse than the whole range?
 *
 * Withheld unless BOTH sides clear `MIN_SAMPLE`: a fast week of two tickets
 * against a month of eighty is not a trend, and calling it one is the kind of
 * number that starts a conversation about nothing.
 *
 * `better` means SHORTER. These are durations, so down is good — the one place
 * a rising line would be the bad news.
 */
export type Trend = 'better' | 'worse' | 'flat';

export function trendOf(recent: Stat, overall: Stat): Trend | null {
  if (recent.medianMin === null || overall.medianMin === null) return null;
  if (recent.n < MIN_SAMPLE || overall.n < MIN_SAMPLE) return null;
  const band = Math.max(1, overall.medianMin * NEAR_PCT);
  if (recent.medianMin < overall.medianMin - band) return 'better';
  if (recent.medianMin > overall.medianMin + band) return 'worse';
  return 'flat';
}

export function summarise(all: readonly Legs[]): CycleSummary {
  const out = {} as CycleSummary;
  for (const key of LEG_KEYS) {
    const values = all.map((l) => l[key]).filter((v): v is number => v !== null);
    out[key] = { n: values.length, medianMin: median(values), meanMin: mean(values) };
  }
  return out;
}


export type Verdict = 'faster' | 'slower' | 'typical';

export function compare(value: number | null, stat: Stat): Verdict | null {
  if (value === null || stat.medianMin === null || stat.n < MIN_SAMPLE) return null;
  const band = Math.max(1, stat.medianMin * NEAR_PCT);
  if (value < stat.medianMin - band) return 'faster';
  if (value > stat.medianMin + band) return 'slower';
  return 'typical';
}

/**
 * Minutes as something a person reads at a glance.
 *
 * Minutes up to an hour, then hours, then days — because "4,317 minutes" is a
 * number nobody converts in their head, and these legs routinely run to days.
 */
export function humanMinutes(min: number | null): string {
  if (min === null) return '—';
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  const d = Math.floor(min / (60 * 24));
  const h = Math.round((min % (60 * 24)) / 60);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}
