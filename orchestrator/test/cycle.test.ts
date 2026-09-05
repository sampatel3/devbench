import { describe, it, expect } from 'vitest';
import {
  compare,
  humanMinutes,
  legsOf,
  MIN_SAMPLE,
  summarise,
  summariseSince,
  trendOf,
  type Legs,
} from '../src/cycle.js';

/**
 * The ask: minutes between ticket assigned and PR raised, PR raised and PR
 * merged, PR merged and PR closed — as an average, and per ticket, so a ticket
 * can be read against the average it belongs to.
 *
 * The arithmetic is easy; the honesty is the part worth testing. A missing end
 * is not a zero, an out-of-order pair is not a negative duration, and a verdict
 * against an average of two is noise wearing a number's clothes.
 */
const at = (h: number): string => new Date(Date.UTC(2026, 8, 4, h, 0, 0)).toISOString();

describe('legsOf', () => {
  it('measures the three legs in minutes', () => {
    expect(
      legsOf({ issue: 1, startedAt: at(1), raisedAt: at(3), mergedAt: at(6), closedAt: at(10) }),
    ).toEqual({ toRaise: 120, toMerge: 180, toClose: 240 });
  });

  it('leaves a leg null when either end is unknown — never zero', () => {
    const legs = legsOf({ issue: 1, startedAt: null, raisedAt: at(3), mergedAt: at(6), closedAt: null });
    expect(legs.toRaise).toBeNull();
    expect(legs.toMerge).toBe(180);
    expect(legs.toClose).toBeNull();
  });

  it('drops an out-of-order pair rather than recording a negative duration', () => {
    // Branch reuse can stamp a merge before the gate D of the PR that followed.
    expect(legsOf({ issue: 1, startedAt: null, raisedAt: at(6), mergedAt: at(3), closedAt: null }).toMerge).toBeNull();
  });

  it('is null for an unparseable stamp rather than NaN', () => {
    expect(legsOf({ issue: 1, startedAt: 'not a date', raisedAt: at(3), mergedAt: null, closedAt: null }).toRaise).toBeNull();
  });
});

describe('summarise', () => {
  const legs = (toRaise: number | null): Legs => ({ toRaise, toMerge: null, toClose: null });

  it('reports the median, the mean, and how many it is an average OF', () => {
    const out = summarise([legs(10), legs(20), legs(30)]);
    expect(out.toRaise).toEqual({ n: 3, medianMin: 20, meanMin: 20 });
  });

  it('takes the median across an even count', () => {
    expect(summarise([legs(10), legs(20), legs(30), legs(40)]).toRaise.medianMin).toBe(25);
  });

  it('shows why the median is the headline: one long weekend does not move it', () => {
    const ordinary = [legs(60), legs(70), legs(80), legs(90), legs(100)];
    const withTail = [...ordinary, legs(60 * 24 * 3)];
    expect(summarise(withTail).toRaise.medianMin).toBe(85);
    // The mean is dragged past every ordinary ticket in the set.
    expect(summarise(withTail).toRaise.meanMin!).toBeGreaterThan(100);
  });

  it('counts nothing when nothing is measurable', () => {
    expect(summarise([legs(null), legs(null)]).toRaise).toEqual({ n: 0, medianMin: null, meanMin: null });
  });
});

describe('compare — is this ticket quicker or slower', () => {
  const stat = (n: number, medianMin: number) => ({ n, medianMin, meanMin: medianMin });

  it('says nothing when the sample is too small to judge by', () => {
    expect(compare(10, stat(MIN_SAMPLE - 1, 100))).toBeNull();
  });

  it('calls it faster, slower, or typical against the median', () => {
    expect(compare(50, stat(10, 100))).toBe('faster');
    expect(compare(200, stat(10, 100))).toBe('slower');
    expect(compare(100, stat(10, 100))).toBe('typical');
  });

  it('has a band, so a minute either side is not a verdict', () => {
    expect(compare(96, stat(10, 100))).toBe('typical');
    expect(compare(104, stat(10, 100))).toBe('typical');
  });

  it('says nothing about a ticket with no measurement', () => {
    expect(compare(null, stat(10, 100))).toBeNull();
  });
});

describe('humanMinutes', () => {
  it('reads as a person would say it', () => {
    expect(humanMinutes(45)).toBe('45m');
    expect(humanMinutes(60)).toBe('1h');
    expect(humanMinutes(150)).toBe('2h 30m');
    expect(humanMinutes(60 * 24)).toBe('1d');
    expect(humanMinutes(60 * 26)).toBe('1d 2h');
  });

  it('is an em dash when there is nothing to say', () => {
    expect(humanMinutes(null)).toBe('—');
  });
});

/**
 * Progress is what the operator watches, so an overall average is kept beside a
 * recent-week one — a level says nothing about whether things are improving; the
 * pair does.
 */
describe('summariseSince — the recent window', () => {
  const row = (issue: number, mergedAt: string | null, toMerge: number | null) => ({
    issue,
    startedAt: null,
    raisedAt: null,
    mergedAt,
    closedAt: null,
    legs: { toRaise: null, toMerge, toClose: null },
  });
  const week = Date.UTC(2026, 8, 1);

  it('counts a leg by when it FINISHED, not when it started', () => {
    // Both merged inside the window; how long they had been open is irrelevant
    // to which window they belong to.
    const out = summariseSince(
      [row(1, new Date(week + 3600_000).toISOString(), 5000), row(2, new Date(week + 7200_000).toISOString(), 10)],
      week,
    );
    expect(out.toMerge.n).toBe(2);
  });

  it('leaves out a leg that finished before the window', () => {
    const out = summariseSince([row(1, new Date(week - 86_400_000).toISOString(), 99)], week);
    expect(out.toMerge).toEqual({ n: 0, medianMin: null, meanMin: null });
  });

  it('leaves out a leg with no end stamp, rather than assuming it is recent', () => {
    expect(summariseSince([row(1, null, 99)], week).toMerge.n).toBe(0);
  });
});

describe('trendOf', () => {
  const stat = (n: number, medianMin: number) => ({ n, medianMin, meanMin: medianMin });

  it('calls a shorter recent median BETTER — these are durations, so down is good', () => {
    expect(trendOf(stat(10, 50), stat(80, 100))).toBe('better');
    expect(trendOf(stat(10, 200), stat(80, 100))).toBe('worse');
    expect(trendOf(stat(10, 100), stat(80, 100))).toBe('flat');
  });

  it('says nothing when either side is too small to be a trend', () => {
    // A fast week of two against a month of eighty is not a trend.
    expect(trendOf(stat(2, 10), stat(80, 100))).toBeNull();
    expect(trendOf(stat(10, 10), stat(3, 100))).toBeNull();
  });

  it('says nothing when either median is missing', () => {
    expect(trendOf({ n: 9, medianMin: null, meanMin: null }, stat(80, 100))).toBeNull();
  });
});
