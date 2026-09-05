/**
 * The status summary's high-level counts, over an EASTERN day or range.
 *
 * The summary used to offer three fixed windows counted back from the click —
 * "last 24 hours", "last 7 days", "last 30 days" — and answer with a long Slack
 * post. That is the wrong shape for "what happened yesterday": a rolling 24
 * hours straddles two days, and what the operator wants is four counts, not nine
 * paragraphs. The prose still exists behind a button; this is what the panel
 * leads with.
 *
 * Eastern, not UTC and not this laptop's zone, because that is the working day
 * these numbers are read against — and computed through the IANA database rather
 * than a fixed offset, so the winter half of the year is not quietly an hour out.
 * Change the zone here if the team's day runs on another one.
 */

export type DayRange = { sinceIso: string; untilIso: string };

/** The UTC instant of a wall-clock time in `America/New_York`. */
function etWallClockToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number): number {
  // Start from the same wall clock read as UTC, then correct by whatever offset
  // New York was actually on at that instant. One correction is enough except
  // within the DST transition hour, where a second pass settles it.
  let guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  for (let i = 0; i < 2; i += 1) {
    const offset = etOffsetMs(guess);
    const next = Date.UTC(y, mo - 1, d, h, mi, s, ms) - offset;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** How far ahead of UTC New York is at this instant (negative — it is behind). */
function etOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour12: false` renders midnight as 24 in some ICU versions.
  const hour = get('hour') % 24;
  // `formatToParts` has no millisecond field, so the milliseconds of the instant
  // are carried across by hand. Without this the offset is short by up to 999ms
  // and the end of a day landed at 04:00:00.997Z instead of 03:59:59.999Z.
  const ms = ((utcMs % 1000) + 1000) % 1000;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'), ms);
  return asUtc - utcMs;
}

/**
 * WHICH EASTERN DAY an instant falls in, as `YYYY-MM-DD`.
 *
 * The graph buckets by this rather than by UTC date for the same reason the
 * range does: these numbers are read in Eastern days, and a PR merged at
 * 21:00 in New York is that day's, not the next one's.
 */
export function etDayOf(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
  // en-CA renders as YYYY-MM-DD, which is the shape the range inputs use.
  return parts;
}

/** Every Eastern day from `from` to `to`, inclusive, as `YYYY-MM-DD`. */
export function etDaysBetween(from: string, to: string): string[] {
  const [a, b] = from <= to ? [from, to] : [to, from];
  const days: string[] = [];
  // Walked at noon UTC so a daylight-saving shift cannot skip or repeat a day.
  let cursor = Date.parse(`${a}T12:00:00Z`);
  const end = Date.parse(`${b}T12:00:00Z`);
  if (!Number.isFinite(cursor) || !Number.isFinite(end)) return [];
  while (cursor <= end && days.length < 400) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return days;
}

/**
 * The UTC bounds of one or more Eastern days, inclusive of both ends.
 *
 * `from` and `to` are plain `YYYY-MM-DD` — what a date input hands over — and
 * arrive in either order, because a range picker lets you choose the end first.
 */
export function etDayRange(from: string, to: string): DayRange {
  const [a, b] = from <= to ? [from, to] : [to, from];
  const parse = (ymd: string): [number, number, number] => {
    const [y, m, d] = ymd.split('-').map(Number);
    return [y ?? 1970, m ?? 1, d ?? 1];
  };
  const [y1, m1, d1] = parse(a);
  const [y2, m2, d2] = parse(b);
  return {
    sinceIso: new Date(etWallClockToUtc(y1, m1, d1, 0, 0, 0, 0)).toISOString(),
    untilIso: new Date(etWallClockToUtc(y2, m2, d2, 23, 59, 59, 999)).toISOString(),
  };
}

export type LaneMove = { issue: number; lane: string; at: string };

/**
 * Every lane change the console has on record, read back out of the
 * notification ledger.
 *
 * The row only carries its CURRENT lane, which is why the first cut of this
 * reported "tickets started" as a floor. It is not: the ledger keys one entry
 * per lane change it has ever announced —
 * `lane-change:issue#4487:In progress:2026-08-12T06:22:30Z` — so a ticket that
 * started on Monday and is in QA by Friday is still on the record, with the
 * moment it started.
 *
 * Parsed with a regex rather than `split(':')` for two reasons the ledger keys
 * make unavoidable: the timestamp carries its own colons, and a lane name is
 * "In progress", with a space, not a single token.
 *
 * The one real limit is retention, and it is bounded rather than vague:
 * `prunedLedger` drops settled entries after `LEDGER_TTL_DAYS` (30), so a range
 * older than a month under-reports. Anything inside a month is a true count.
 */
const LANE_KEY = /^lane-change:issue#(\d+):(.+):(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)$/;

export function laneMovesFromLedger(ledger: Readonly<Record<string, unknown>>): LaneMove[] {
  const out: LaneMove[] = [];
  for (const key of Object.keys(ledger)) {
    const m = LANE_KEY.exec(key);
    if (!m) continue;
    out.push({ issue: Number(m[1]), lane: m[2] as string, at: m[3] as string });
  }
  return out;
}

export type CountsInput = DayRange & {
  /** Every lane change on record — see `laneMovesFromLedger`. */
  laneMoves: readonly LaneMove[];
  prsRaised: readonly { number: number; createdAt: string }[];
  prsMerged: readonly { number: number; mergedAt: string }[];
  issuesClosed: readonly { number: number; closedAt: string }[];
};

export type Counts = {
  ticketsStarted: number;
  prsRaised: number;
  prsMerged: number;
  issuesClosed: number;
};

const within = (iso: string | null, since: number, until: number): boolean => {
  if (iso === null) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= since && t <= until;
};

/** One day of the four numbers, plus the day it belongs to. */
export type DayCounts = Counts & { day: string };

/**
 * THE SAME FOUR NUMBERS, PER DAY.
 *
 * One pass over the lists `countsIn` already takes, so a month of days costs
 * exactly what one range costs — importantly including the single GitHub read
 * for closed issues, which is the only expensive input. Asking `counts()` once
 * per day would have made a 26-day graph 26 GitHub calls.
 *
 * `ticketsStarted` is DISTINCT TICKETS PER DAY, matching `countsIn`: a ticket
 * bounced back and restarted on the same day is one start. Across days it can
 * legitimately count twice, which is what "started that day" means and is why
 * the cumulative line can exceed the number of distinct tickets.
 */
export function dailyCounts(input: CountsInput, days: string[], dayOf: (iso: string) => string): DayCounts[] {
  const since = Date.parse(input.sinceIso);
  const until = Date.parse(input.untilIso);
  const blank = (): { started: Set<number>; prsRaised: number; prsMerged: number; issuesClosed: number } => ({
    started: new Set<number>(),
    prsRaised: 0,
    prsMerged: 0,
    issuesClosed: 0,
  });
  const buckets = new Map(days.map((d) => [d, blank()]));
  const put = (at: string | null | undefined, fn: (b: ReturnType<typeof blank>) => void): void => {
    if (typeof at !== 'string' || !within(at, since, until)) return;
    const bucket = buckets.get(dayOf(at));
    if (bucket) fn(bucket);
  };
  for (const m of input.laneMoves) if (m.lane === 'In progress') put(m.at, (b) => b.started.add(m.issue));
  for (const p of input.prsRaised) put(p.createdAt, (b) => (b.prsRaised += 1));
  for (const p of input.prsMerged) put(p.mergedAt, (b) => (b.prsMerged += 1));
  for (const i of input.issuesClosed) put(i.closedAt, (b) => (b.issuesClosed += 1));
  return days.map((day) => {
    const b = buckets.get(day)!;
    return {
      day,
      ticketsStarted: b.started.size,
      prsRaised: b.prsRaised,
      prsMerged: b.prsMerged,
      issuesClosed: b.issuesClosed,
    };
  });
}

export function countsIn(input: CountsInput): Counts {
  const since = Date.parse(input.sinceIso);
  const until = Date.parse(input.untilIso);
  // DISTINCT tickets, not moves: a ticket bounced back and restarted in the same
  // range is one ticket started, not two.
  const started = new Set(
    input.laneMoves.filter((m) => m.lane === 'In progress' && within(m.at, since, until)).map((m) => m.issue),
  );
  return {
    ticketsStarted: started.size,
    prsRaised: input.prsRaised.filter((p) => within(p.createdAt, since, until)).length,
    prsMerged: input.prsMerged.filter((p) => within(p.mergedAt, since, until)).length,
    issuesClosed: input.issuesClosed.filter((i) => within(i.closedAt, since, until)).length,
  };
}

/**
 * "PRs raised", read off the gate decisions rather than asked of GitHub.
 *
 * Gate D IS the approval to raise the PR, and the console writes every one to
 * `decisions.jsonl` with its issue and its moment — so the number is already on
 * disk and costs no read. It is also the more faithful source: a PR search
 * would count PRs raised outside this console and miss the gate that actually
 * happened here.
 *
 * The approval time is the raise time. Exact to the second it is not — the
 * push and `gh pr create` follow it by a minute or two — and it does not need
 * to be: these are day and range counts.
 */
export function prsRaisedFrom(
  decisions: readonly { gate: string; decision: string; issue: number; at: string }[],
): { number: number; createdAt: string }[] {
  return decisions
    .filter((d) => d.gate === 'D' && d.decision === 'approved')
    .map((d) => ({ number: d.issue, createdAt: d.at }));
}

/**
 * Merged PRs, read back out of the ledger — `merged:pr#4446:<when>`.
 *
 * Same reasoning as the lane audit: the console already announced every one of
 * these, so the record is on disk and needs no read. Bounded by the same 30-day
 * ledger retention.
 */
const MERGED_KEY = /^merged:pr#(\d+):(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)$/;

export function mergedPrsFromLedger(
  ledger: Readonly<Record<string, unknown>>,
): { number: number; mergedAt: string }[] {
  const out: { number: number; mergedAt: string }[] = [];
  for (const key of Object.keys(ledger)) {
    const m = MERGED_KEY.exec(key);
    if (m) out.push({ number: Number(m[1]), mergedAt: m[2] as string });
  }
  return out;
}
