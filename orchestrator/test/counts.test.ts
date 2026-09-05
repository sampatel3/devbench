/**
 * The status summary's high-level counts, and the day boundaries they use.
 *
 * The summary was three fixed windows (24h / 7d / 30d counted back from the
 * click) and a long Slack post. The numbers come first — started, raised,
 * merged, closed — over a day or a range the operator picks, and the prose is
 * kept behind a button.
 *
 * A "day" is an EASTERN day, because that is the timezone the console is read
 * in. Counting back 24 hours from the click is not the same question and never
 * was.
 */
import { describe, it, expect } from 'vitest';
import { etDayRange, countsIn, laneMovesFromLedger, prsRaisedFrom, mergedPrsFromLedger } from '../src/counts.js';

describe('Eastern day boundaries', () => {
  /** August is EDT, UTC-4: the day opens at 04:00Z. */
  it('opens an EDT day at 04:00Z and closes it at 03:59:59.999Z the next day', () => {
    const r = etDayRange('2026-08-19', '2026-08-19');
    expect(r.sinceIso).toBe('2026-08-19T04:00:00.000Z');
    expect(r.untilIso).toBe('2026-08-20T03:59:59.999Z');
  });

  /** January is EST, UTC-5. Hardcoding -4 would silently shift every winter
   *  count by an hour, which is exactly the kind of bug nobody reports. */
  it('follows the DST change rather than assuming a fixed offset', () => {
    const r = etDayRange('2026-01-15', '2026-01-15');
    expect(r.sinceIso).toBe('2026-01-15T05:00:00.000Z');
    expect(r.untilIso).toBe('2026-01-16T04:59:59.999Z');
  });

  it('spans a range from the first day open to the last day close', () => {
    const r = etDayRange('2026-08-17', '2026-08-19');
    expect(r.sinceIso).toBe('2026-08-17T04:00:00.000Z');
    expect(r.untilIso).toBe('2026-08-20T03:59:59.999Z');
  });

  /** Handed the days backwards, it still returns a real range rather than an
   *  empty one that would read as "nothing happened". */
  it('orders the two dates however they arrive', () => {
    expect(etDayRange('2026-08-19', '2026-08-17')).toEqual(etDayRange('2026-08-17', '2026-08-19'));
  });
});

/**
 * The lane audit. This was wrong first time: "tickets started" was called a
 * floor and nothing more, because the row carries only its CURRENT lane. But
 * there is an audit log, and it answers where a ticket was and when — the
 * notification ledger keys every lane change it has seen as
 * `lane-change:issue#<n>:<lane>:<when>`, so a ticket that has since moved on is
 * still on the record with the moment it started.
 */
describe('lane moves read back out of the notification ledger', () => {
  const ledger = {
    'lane-change:issue#4487:In progress:2026-08-12T06:22:30Z': {},
    'lane-change:issue#4344:In progress:2026-08-11T13:14:56Z': {},
    'lane-change:issue#4342:QA:2026-08-11T18:44:03Z': {},
    'assigned:issue#4329': {},
    'uat-fail:issue#4619:2026-08-18T18:00:50Z': {},
  };

  it('reads the issue, the lane and the moment out of each key', () => {
    const moves = laneMovesFromLedger(ledger);
    expect(moves).toContainEqual({ issue: 4487, lane: 'In progress', at: '2026-08-12T06:22:30Z' });
    expect(moves).toContainEqual({ issue: 4342, lane: 'QA', at: '2026-08-11T18:44:03Z' });
  });

  /** A lane name with a space in it must survive — and the timestamp's own
   *  colons must not be mistaken for field separators. */
  it('keeps multi-word lane names and does not split on the timestamp colons', () => {
    const moves = laneMovesFromLedger(ledger);
    expect(moves.filter((m) => m.lane === 'In progress')).toHaveLength(2);
  });

  it('ignores every other kind of ledger entry', () => {
    expect(laneMovesFromLedger(ledger)).toHaveLength(3);
    expect(laneMovesFromLedger({})).toEqual([]);
  });
});

describe('the four counts', () => {
  const range = etDayRange('2026-08-18', '2026-08-18'); // 2026-08-18T04:00Z .. 2026-08-19T03:59:59.999Z

  const input = {
    ...range,
    laneMoves: [
      { issue: 1, lane: 'In progress', at: '2026-08-18T12:00:00Z' }, // in
      { issue: 2, lane: 'In progress', at: '2026-08-17T12:00:00Z' }, // before
      { issue: 3, lane: 'QA', at: '2026-08-18T12:00:00Z' }, // wrong lane
      // The same ticket started twice in one day is ONE ticket started.
      { issue: 1, lane: 'In progress', at: '2026-08-18T20:00:00Z' },
    ],
    prsRaised: [{ number: 10, createdAt: '2026-08-18T09:00:00Z' }, { number: 11, createdAt: '2026-08-19T09:00:00Z' }],
    prsMerged: [{ number: 20, mergedAt: '2026-08-18T22:00:00Z' }],
    issuesClosed: [
      { number: 30, closedAt: '2026-08-18T05:00:00Z' },
      { number: 31, closedAt: '2026-08-19T05:00:00Z' }, // next ET day
    ],
  };

  it('counts only what falls inside the Eastern range', () => {
    const c = countsIn(input);
    expect(c.ticketsStarted).toBe(1);
    expect(c.prsRaised).toBe(1);
    expect(c.prsMerged).toBe(1);
    expect(c.issuesClosed).toBe(1);
  });

  /** Distinct tickets, not moves: starting the same one twice is one ticket. */
  it('counts a ticket once however many times it entered the lane', () => {
    expect(countsIn(input).ticketsStarted).toBe(1);
  });

  it('is all zeroes on an empty range rather than throwing', () => {
    const c = countsIn({ ...range, laneMoves: [], prsRaised: [], prsMerged: [], issuesClosed: [] });
    expect([c.ticketsStarted, c.prsRaised, c.prsMerged, c.issuesClosed]).toEqual([0, 0, 0, 0]);
  });

  it('ignores an unparseable timestamp instead of counting it', () => {
    const c = countsIn({ ...range, laneMoves: [], prsRaised: [{ number: 9, createdAt: 'not a date' }], prsMerged: [], issuesClosed: [] });
    expect(c.prsRaised).toBe(0);
  });
});

/**
 * "PRs raised" comes out of the audit, not GitHub.
 *
 * Raising a PR is a gate, so the console already knows when it happened and
 * needs no `gh` call to find out — the audit holds it. Gate D IS the approval to
 * raise the PR, and every one is already on the decisions log with
 * its issue and its moment — 26 of them today. No extra read, and no dependence
 * on a PR search that would miss one raised outside the console.
 */
describe('PRs raised are read off the gate D decisions', () => {
  const decisions = [
    { gate: 'D', decision: 'approved', issue: 4303, at: '2026-08-18T18:21:18.828Z' },
    { gate: 'D', decision: 'approved', issue: 4666, at: '2026-08-18T18:34:54.499Z' },
    { gate: 'C', decision: 'approved', issue: 4701, at: '2026-08-18T18:40:00.000Z' },
    { gate: 'D', decision: 'feedback', issue: 4702, at: '2026-08-18T18:45:00.000Z' },
  ];

  it('takes gate D approvals and nothing else', () => {
    const raised = prsRaisedFrom(decisions);
    expect(raised.map((r) => r.number).sort()).toEqual([4303, 4666]);
  });

  it('carries the approval moment as the raise time', () => {
    expect(prsRaisedFrom(decisions)[0]).toEqual({ number: 4303, createdAt: '2026-08-18T18:21:18.828Z' });
  });

  it('feeds countsIn directly', () => {
    const range = etDayRange('2026-08-18', '2026-08-18');
    const c = countsIn({ ...range, laneMoves: [], prsRaised: prsRaisedFrom(decisions), prsMerged: [], issuesClosed: [] });
    expect(c.prsRaised).toBe(2);
  });
});

/** Merged PRs are audited too: `merged:pr#4446:2026-08-11T18:49:13Z`. */
describe('merged PRs read back out of the ledger', () => {
  const ledger = {
    'merged:pr#4446:2026-08-11T18:49:13Z': {},
    'merged:pr#4368:2026-08-11T18:43:38Z': {},
    'lane-change:issue#4487:In progress:2026-08-12T06:22:30Z': {},
  };

  it('reads the PR number and the moment it merged', () => {
    const merged = mergedPrsFromLedger(ledger);
    expect(merged).toContainEqual({ number: 4446, mergedAt: '2026-08-11T18:49:13Z' });
    expect(merged).toHaveLength(2);
  });

  it('ignores lane changes and anything else', () => {
    expect(mergedPrsFromLedger({ 'assigned:issue#1': {} })).toEqual([]);
  });
});
