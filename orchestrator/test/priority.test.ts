/**
 * The rail's ordering. It is client-side — the server sends the labels and
 * nothing else — but the rule is worth a test rather than an eyeball, because
 * the two things it is easy to get wrong (an unlabelled issue silently becoming
 * P2, and icebox floating above it) are both invisible until the wrong issue is
 * at the top of the list.
 */
import { describe, it, expect } from 'vitest';
import {
  compareIssues,
  priorityOf,
  sortIssues,
  isAside,
  isParked,
  isPriorityLabel,
  isTriageLabel,
  awaitingTriage,
  bandLabel,
  isUatFail,
  selfFiledNeedsTriage,
  waitingOnYou,
} from '../../ui/src/priority.js';
import type { Sortable } from '../../ui/src/priority.js';
import type { WorkerStatus } from '../../ui/src/types.js';

const row = (
  labels: string[],
  status: WorkerStatus,
  updatedAt: string,
  selfFiled = false,
  uatFail: Sortable['uatFail'] = null,
): Sortable => ({
  labels,
  status,
  updatedAt,
  selfFiled,
  uatFail,
});

/** The real shape, as the server stamps it: a human verdict on the ISSUE, after
 *  the merge. Modelled on the one verified example — qa-alice on #4170. */
const UAT = (
  by = 'qa-alice',
  at = '2026-08-10T09:00:00Z',
  verdict: 'Fail' | 'Partial Pass' | 'Pass' = 'Fail',
): NonNullable<Sortable['uatFail']> => ({
  by,
  at,
  verdict,
  url: 'https://github.com/example-org/example-repo/issues/4170#issuecomment-1',
});

/** The three real shapes this feature exists for, as observed on 11 Aug 2026. */
const SELF_FILED_UNTRIAGED = (labels: string[] = ['needs-triage'], at = '2026-08-11T18:01:00Z') =>
  row(labels, 'no-worker', at, true); // #4472, spun off by the #4404 worker
const TEAMMATE_UNTRIAGED = (labels: string[] = ['needs-triage'], at = '2026-08-11T18:01:00Z') =>
  row(labels, 'no-worker', at, false); // #4336, filed by qa-bob

describe('priorityOf', () => {
  it('reads the five priority labels', () => {
    expect(priorityOf(['P0'])).toBe('P0');
    expect(priorityOf(['P1'])).toBe('P1');
    expect(priorityOf(['P2'])).toBe('P2');
    expect(priorityOf(['P3'])).toBe('P3');
    expect(priorityOf(['icebox'])).toBe('icebox');
  });

  it('calls an issue with no priority label untriaged, never P2', () => {
    expect(priorityOf([])).toBe('untriaged');
    expect(priorityOf(['bug', 'area:quote', 'env:uat'])).toBe('untriaged');
  });

  it('ignores case and stray whitespace, and every non-priority label', () => {
    expect(priorityOf(['p1'])).toBe('P1');
    expect(priorityOf([' Icebox '])).toBe('icebox');
    expect(priorityOf(['needs-triage'])).toBe('untriaged');
  });

  it('takes the most urgent when triage left two on', () => {
    expect(priorityOf(['icebox', 'P2'])).toBe('P2');
    expect(priorityOf(['P3', 'P0', 'P2'])).toBe('P0');
  });

  it('knows which labels the pill already says, so they are not printed twice', () => {
    expect(isPriorityLabel('P0')).toBe(true);
    expect(isPriorityLabel('icebox')).toBe(true);
    expect(isPriorityLabel('bug')).toBe(false);
  });
});

describe('one triage signal, not two', () => {
  it('is the empty priority axis — the needs-triage label says the same thing', () => {
    expect(awaitingTriage([])).toBe(true);
    expect(awaitingTriage(['needs-triage'])).toBe(true);
    expect(awaitingTriage(['bug', 'area:quote'])).toBe(true);
    expect(awaitingTriage(['P2'])).toBe(false);
    expect(awaitingTriage(['icebox'])).toBe(false);
    expect(isTriageLabel('needs-triage')).toBe(true);
    expect(isPriorityLabel('needs-triage')).toBe(false);
  });

  it('a priority label plus a stale needs-triage reads as the priority', () => {
    // Mid-triage: the rank is the more specific, more useful fact, so it wins
    // and nothing anywhere says "needs triage" about this issue.
    expect(priorityOf(['P1', 'needs-triage'])).toBe('P1');
    expect(bandLabel(priorityOf(['P1', 'needs-triage']))).toBe('P1');
    expect(awaitingTriage(['P1', 'needs-triage'])).toBe(false);
    expect(selfFiledNeedsTriage(row(['P1', 'needs-triage'], 'no-worker', '2026-08-11T12:00:00Z', true))).toBe(false);
  });

  it('says "needs triage" to a person and "untriaged" only in the code', () => {
    expect(bandLabel('untriaged')).toBe('needs triage');
    expect(bandLabel('P0')).toBe('P0');
    expect(bandLabel('icebox')).toBe('icebox');
  });

  it('only self-filed AND awaiting triage together is the caution', () => {
    expect(selfFiledNeedsTriage(SELF_FILED_UNTRIAGED())).toBe(true); // #4472
    expect(selfFiledNeedsTriage(TEAMMATE_UNTRIAGED())).toBe(false); // #4336
    // Filed here and ranked since: nothing to caution about.
    expect(selfFiledNeedsTriage(row(['P2'], 'no-worker', '2026-08-11T12:00:00Z', true))).toBe(false);
    // Filed here with no labels at all — unranked just the same.
    expect(selfFiledNeedsTriage(row([], 'no-worker', '2026-08-11T12:00:00Z', true))).toBe(true);
  });
});

describe('compareIssues', () => {
  it('orders the bands P0 → P1 → P2 → P3 → untriaged → icebox', () => {
    const mixed = [
      row(['icebox'], 'no-worker', '2026-08-11T12:00:00Z'),
      row([], 'no-worker', '2026-08-11T12:00:00Z'),
      row(['P3'], 'no-worker', '2026-08-11T12:00:00Z'),
      row(['P1'], 'no-worker', '2026-08-11T12:00:00Z'),
      row(['P0'], 'no-worker', '2026-08-11T12:00:00Z'),
      row(['P2'], 'no-worker', '2026-08-11T12:00:00Z'),
    ];
    expect(sortIssues(mixed).map((r) => priorityOf(r.labels))).toEqual([
      'P0',
      'P1',
      'P2',
      'P3',
      'untriaged',
      'icebox',
    ]);
  });

  it('puts an untriaged issue BELOW P2 and above icebox', () => {
    const untriaged = row([], 'no-worker', '2026-08-11T12:00:00Z');
    const p2 = row(['P2'], 'no-worker', '2026-08-01T12:00:00Z');
    const icebox = row(['icebox'], 'no-worker', '2026-08-11T12:00:00Z');
    // Older P2 still beats a freshly-updated untriaged: the band wins first.
    expect(compareIssues(p2, untriaged)).toBeLessThan(0);
    expect(compareIssues(untriaged, icebox)).toBeLessThan(0);
  });

  it('leaves icebox last however recently it was touched', () => {
    // The claim this test was written for, and it is unchanged: RECENCY never
    // lifts an iceboxed issue. Six-year-old rows still beat it.
    const rows = [
      row(['icebox'], 'no-worker', '2026-08-11T23:59:00Z'),
      row(['P3'], 'no-worker', '2020-01-01T00:00:00Z'),
      row([], 'no-worker', '2020-01-01T00:00:00Z'),
    ];
    expect(sortIssues(rows).map((r) => priorityOf(r.labels))).toEqual(['P3', 'untriaged', 'icebox']);
  });

  /**
   * The one thing that CAN lift an iceboxed row, and it is not recency.
   *
   * This fixture used to be part of the test above, with an `at-gate` icebox row
   * expected last. Once the tiers went in, a person standing still outranks the
   * band — so an iceboxed issue with a worker parked at a gate now sorts above
   * an unstarted P3.
   *
   * That is the right answer, and it is worth being explicit about why: icebox
   * means "not scheduling", so a worker parked at a gate on one is an ANOMALY —
   * a slot held open on work nobody agreed to do. Burying it is how it stays
   * held. Inside its own tier icebox is still last, exactly as before.
   */
  it('lifts an iceboxed row only when a person is standing still on it', () => {
    const parked = row(['icebox'], 'at-gate', '2026-08-11T23:59:00Z');
    expect(compareIssues(parked, row(['P3'], 'no-worker', '2020-01-01T00:00:00Z'))).toBeLessThan(0);
    // ...and inside the tier, the band still puts it last.
    expect(compareIssues(row(['P3'], 'at-gate', '2020-01-01T00:00:00Z'), parked)).toBeLessThan(0);
  });

  it('puts what is waiting on you first inside a band', () => {
    // The active worker was updated more recently and still loses: within one
    // band, "needs you" outranks "just moved".
    const active = row(['P1'], 'active', '2026-08-11T18:00:00Z');
    const atGate = row(['P1'], 'at-gate', '2026-08-11T09:00:00Z');
    expect(compareIssues(atGate, active)).toBeLessThan(0);
    for (const status of ['awaiting-post', 'reply-received', 'rework'] as WorkerStatus[]) {
      expect(compareIssues(row(['P1'], status, '2026-08-01T00:00:00Z'), active)).toBeLessThan(0);
    }
  });

  it('sinks a self-filed, untriaged issue below its peers in the same band', () => {
    // Both untriaged, and the machine-raised one was touched MORE recently — it
    // still goes last, because nobody outside this laptop has agreed to it.
    const mine = SELF_FILED_UNTRIAGED(['needs-triage'], '2026-08-11T18:01:00Z');
    const theirs = row([], 'no-worker', '2026-08-01T09:00:00Z');
    expect(compareIssues(theirs, mine)).toBeLessThan(0);
    expect(sortIssues([mine, theirs])[0]).toBe(theirs);
  });

  it('sinks it inside its band only — never out of it', () => {
    // A self-filed, untriaged P1 still outranks every P2, and an untriaged one
    // still outranks icebox. The band is decided before this rule is reached.
    const mineP1 = row(['P1', 'needs-triage'], 'no-worker', '2026-08-01T09:00:00Z', true);
    const theirsP2 = row(['P2'], 'no-worker', '2026-08-11T18:00:00Z');
    expect(compareIssues(mineP1, theirsP2)).toBeLessThan(0);
    expect(compareIssues(SELF_FILED_UNTRIAGED(), row(['icebox'], 'no-worker', '2026-08-11T18:00:00Z'))).toBeLessThan(0);
  });

  it('does not outrank the needs-you rule', () => {
    // Answering a gate on a self-filed issue is still the thing to open: it has
    // already been picked up, and something is standing still waiting for you.
    const mineAtGate = row(['needs-triage'], 'at-gate', '2026-08-01T09:00:00Z', true);
    const theirsActive = row([], 'active', '2026-08-11T18:00:00Z');
    expect(compareIssues(mineAtGate, theirsActive)).toBeLessThan(0);
  });

  it('leaves a self-filed issue that HAS been ranked alone', () => {
    // A priority on it: the provenance on its own changes no ordering.
    const older = row(['P2'], 'no-worker', '2026-08-09T10:00:00Z', true);
    const newer = row(['P2'], 'no-worker', '2026-08-11T10:00:00Z', true);
    expect(compareIssues(newer, older)).toBeLessThan(0);
    expect(compareIssues(row(['P2'], 'no-worker', '2026-08-11T10:00:00Z'), newer)).toBe(0);
  });

  it('leaves a teammate’s needs-triage issue alone', () => {
    // #4336 carries needs-triage and was filed by a teammate — nothing sinks it.
    const theirs = TEAMMATE_UNTRIAGED(['needs-triage'], '2026-08-11T18:00:00Z');
    const plain = row([], 'no-worker', '2026-08-01T09:00:00Z');
    expect(compareIssues(theirs, plain)).toBeLessThan(0);
    expect(sortIssues([plain, theirs])[0]).toBe(theirs);
  });

  it('falls back to most recently updated', () => {
    const older = row(['P2'], 'active', '2026-08-09T10:00:00Z');
    const newer = row(['P2'], 'active', '2026-08-11T10:00:00Z');
    expect(compareIssues(newer, older)).toBeLessThan(0);
    expect(sortIssues([older, newer])[0]).toBe(newer);
  });

  it('sorts a mixed set the way the rail should read it', () => {
    const rows = [
      row(['P2'], 'active', '2026-08-11T10:00:00Z'),
      row(['icebox'], 'at-gate', '2026-08-11T11:00:00Z'),
      row([], 'at-gate', '2026-08-10T10:00:00Z'),
      row(['P0'], 'no-worker', '2026-08-01T10:00:00Z'),
      row(['P2'], 'at-gate', '2026-08-05T10:00:00Z'),
      row(['P1'], 'active', '2026-08-11T12:00:00Z'),
      row([], 'no-worker', '2026-08-11T12:00:00Z'),
    ];
    // The two `active` rows go to the bottom: a worker has them, so they are not
    // their. Everything they CAN act on keeps its band order exactly as before —
    // P0 leads, and the iceboxed gate is still last of them.
    expect(sortIssues(rows).map((r) => `${priorityOf(r.labels)}/${r.status}`)).toEqual([
      'P2/at-gate',
      'untriaged/at-gate',
      'icebox/at-gate',
      'P1/active',
      'P2/active',
      'P0/no-worker',
      'untriaged/no-worker',
    ]);
  });

  it('does not throw the order away when a timestamp is unreadable', () => {
    const bad = row(['P2'], 'active', 'not a date');
    const good = row(['P2'], 'active', '2026-08-11T10:00:00Z');
    expect(compareIssues(good, bad)).toBeLessThan(0);
    expect(sortIssues([bad, good])[0]).toBe(good);
  });

  it('does not mutate the array it was given', () => {
    const rows = [row(['P3'], 'no-worker', '2026-08-11T10:00:00Z'), row(['P0'], 'no-worker', '2026-08-11T10:00:00Z')];
    const first = rows[0];
    sortIssues(rows);
    expect(rows[0]).toBe(first);
  });
});

/**
 * The band above every band.
 *
 * The whole feature turns on one distinction, and these tests are where it is
 * pinned: the pre-merge `changes-requested` round from `pr-swarm[bot]` — 142
 * of 142 feature PRs — is NOT this. It arrives as status `rework` with `uatFail`
 * null and stays inside its priority band, exactly as it always has. What
 * outranks P0 is a person, after the merge, saying the shipped thing is wrong.
 */
describe('sent back from UAT', () => {
  it('puts a send-back above P0, however stale it is and however fresh the P0', () => {
    const sentBack = row([], 'no-worker', '2026-08-01T09:00:00Z', false, UAT());
    const p0 = row(['P0'], 'at-gate', '2026-08-11T18:00:00Z');
    expect(compareIssues(sentBack, p0)).toBeLessThan(0);
    expect(sortIssues([p0, sentBack])[0]).toBe(sentBack);
  });

  it('a pre-merge BOT round is not a send-back: status rework stays inside its band', () => {
    // Both rows are in the same tier, so this isolates the thing under test —
    // that `rework` with no `uatFail` gets no promotion above its band. (The
    // comparison row used to be `no-worker`, which now sits a tier lower and
    // would have made this pass for the wrong reason.)
    const botRound = row(['P2'], 'rework', '2026-08-11T18:00:00Z'); // uatFail null
    const p1 = row(['P1'], 'at-gate', '2026-08-01T09:00:00Z');
    expect(compareIssues(p1, botRound)).toBeLessThan(0);
    // ...and the human verdict does NOT stay in its band: it beats the P1 from
    // two tiers down, which is the whole point of the send-back key.
    const human = row(['P2'], 'no-worker', '2026-08-01T09:00:00Z', false, UAT());
    expect(compareIssues(human, p1)).toBeLessThan(0);
  });

  it('orders several send-backs by triage band first, then oldest verdict first', () => {
    const oldP2 = row(['P2'], 'no-worker', '2026-08-11T12:00:00Z', false, UAT('qa-alice', '2026-08-09T09:00:00Z'));
    const newP2 = row(['P2'], 'no-worker', '2026-08-11T12:00:00Z', false, UAT('qa-bob', '2026-08-11T09:00:00Z'));
    const p0Fail = row(['P0'], 'no-worker', '2026-08-11T12:00:00Z', false, UAT('qa-alice', '2026-08-11T10:00:00Z'));
    expect(sortIssues([newP2, oldP2, p0Fail])).toEqual([p0Fail, oldP2, newP2]);
  });

  it('outranks a gate and updatedAt both', () => {
    const sentBack = row(['P3'], 'no-worker', '2020-01-01T00:00:00Z', false, UAT());
    const atGate = row(['P0'], 'at-gate', '2026-08-11T18:00:00Z');
    expect(compareIssues(sentBack, atGate)).toBeLessThan(0);
  });

  it('self-filed never sinks a send-back', () => {
    const mine = row(['needs-triage'], 'no-worker', '2026-08-01T09:00:00Z', true, UAT());
    const theirs = row(['P0'], 'no-worker', '2026-08-11T18:00:00Z');
    expect(compareIssues(mine, theirs)).toBeLessThan(0);
  });

  it('a Partial Pass is a send-back too', () => {
    const partial = row(['P3'], 'no-worker', '2026-08-01T09:00:00Z', false, UAT('qa-alice', '2026-08-10T09:00:00Z', 'Partial Pass'));
    expect(isUatFail(partial)).toBe(true);
    expect(compareIssues(partial, row(['P0'], 'no-worker', '2026-08-11T18:00:00Z'))).toBeLessThan(0);
  });

  it('a PASS is not a send-back — it is the good news that retires one', () => {
    const passed = row(['P2'], 'no-worker', '2026-08-11T12:00:00Z', false, UAT('qa-alice', '2026-08-10T09:00:00Z', 'Pass'));
    const p1 = row(['P1'], 'no-worker', '2026-08-01T09:00:00Z');
    expect(isUatFail(passed)).toBe(false);
    expect(compareIssues(p1, passed)).toBeLessThan(0);
  });

  it('a cleared verdict is an ordinary row again', () => {
    const cleared = row(['P2'], 'no-worker', '2026-08-11T12:00:00Z', false, null);
    const p1 = row(['P1'], 'no-worker', '2026-08-01T09:00:00Z');
    expect(compareIssues(p1, cleared)).toBeLessThan(0);
  });

  it('an unreadable verdict date sorts last IN the group, never out of it', () => {
    const bad = row(['P2'], 'no-worker', '2026-08-11T12:00:00Z', false, UAT('x', 'not a date'));
    const good = row(['P2'], 'no-worker', '2026-08-11T12:00:00Z', false, UAT('y', '2026-08-10T09:00:00Z'));
    const p0 = row(['P0'], 'at-gate', '2026-08-11T18:00:00Z');
    expect(sortIssues([bad, p0, good])).toEqual([good, bad, p0]);
  });

  /**
   * The one that would have taken the whole list down. A rebuilt `ui/dist` in
   * front of a console that has not restarted sends rows with no `uatFail` field
   * at all — and `undefined !== null` is true, so a naive check would put every
   * issue in the repo into the top band simultaneously and destroy the ordering
   * exactly when the stale-bundle banner is already up.
   */
  it('a row from an OLDER console, with no uatFail field at all, is not a send-back', () => {
    const legacy = { labels: ['P3'], status: 'no-worker', updatedAt: '2026-08-01T09:00:00Z', selfFiled: false } as unknown as Sortable;
    const p0 = row(['P0'], 'no-worker', '2026-08-11T18:00:00Z');
    expect(isUatFail(legacy)).toBe(false);
    expect(compareIssues(p0, legacy)).toBeLessThan(0);
  });

  it('leaves every band below it byte-identical', () => {
    // The regression guard: with nothing sent back, the order is whatever the
    // ordinary rules say — which is now the whose-court sink then the band.
    const rows = [
      row(['P2'], 'active', '2026-08-11T10:00:00Z'),
      row(['icebox'], 'at-gate', '2026-08-11T11:00:00Z'),
      row([], 'at-gate', '2026-08-10T10:00:00Z'),
      row(['P0'], 'no-worker', '2026-08-01T10:00:00Z'),
      row(['P2'], 'at-gate', '2026-08-05T10:00:00Z'),
      row(['P1'], 'active', '2026-08-11T12:00:00Z'),
      row([], 'no-worker', '2026-08-11T12:00:00Z'),
    ];
    expect(sortIssues(rows).map((r) => `${priorityOf(r.labels)}/${r.status}`)).toEqual([
      'P2/at-gate',
      'untriaged/at-gate',
      'icebox/at-gate',
      'P1/active',
      'P2/active',
      'P0/no-worker',
      'untriaged/no-worker',
    ]);
  });
});

/**
 * The operator asked for closed issues to be greyed and put at the bottom.
 *
 * `done` means the ISSUE is closed on GitHub — QA signed it off and there is
 * nothing left to ask for. It was sorting inside the priority bands like live
 * work, so three finished worktrees sat above open issues purely because they
 * had been touched recently. Finished work is the one category that has earned
 * the bottom of the list.
 */
describe('finished work sinks', () => {
  it('puts a closed issue below every open one, whatever its priority', () => {
    const closedP0 = row(['P0'], 'done', '2026-08-13T12:00:00Z');
    const openP3 = row(['P3'], 'no-worker', '2026-08-01T00:00:00Z');
    expect(sortIssues([closedP0, openP3]).map((r) => r.status)).toEqual(['no-worker', 'done']);
  });

  it('keeps closed issues in a sensible order among themselves', () => {
    // Most recently finished first — the one they are most likely to look back at.
    const older = row([], 'done', '2026-08-01T00:00:00Z');
    const newer = row([], 'done', '2026-08-13T00:00:00Z');
    expect(sortIssues([older, newer]).map((r) => r.updatedAt)).toEqual([
      '2026-08-13T00:00:00Z',
      '2026-08-01T00:00:00Z',
    ]);
  });

  /**
   * This test used to be called "does not sink a MERGED PR — that still has
   * Stage 9 left", on the reasoning that Stage 9 step 3 hands QA a verification
   * script and only the operator can post it. The operator does not consider
   * chasing QA their job — and the record agrees. QA closed six issues with NO
   * handover comment on any of them, 17.7–22.5 hours after merge every time. The
   * comment has never been posted in this repo.
   *
   * So a merged PR now sinks with the rest of the work that moves on its own.
   * It still sits ABOVE `done`, which is what this test really guards: merged is
   * not finished, and a UAT send-back on it outranks everything.
   */
  it('sinks a merged PR below open work, but never below a CLOSED one', () => {
    const merged = row([], 'pr-merged', '2026-08-13T00:00:00Z');
    const open = row([], 'no-worker', '2026-08-01T00:00:00Z');
    const closed = row([], 'done', '2026-08-13T00:00:00Z');
    expect(sortIssues([merged, open]).map((r) => r.status)).toEqual(['no-worker', 'pr-merged']);
    expect(sortIssues([closed, merged]).map((r) => r.status)).toEqual(['pr-merged', 'done']);
  });

  it('a UAT send-back still outranks everything, and is never "done"', () => {
    const closed = row(['P0'], 'done', '2026-08-13T12:00:00Z');
    const sentBack = row(['P2'], 'pr-merged', '2026-08-10T00:00:00Z', false, UAT());
    expect(sortIssues([closed, sentBack])[0]!.uatFail).not.toBeNull();
  });
});

/**
 * The operator asked that issues which are not with them go towards the bottom of
 * the list, and move back up when they are back on them.
 *
 * Note the shape of the request: it is a SINK, not a promotion. Nothing rises
 * above its band — things that are not theirs DESCEND below it. That distinction is
 * the whole design, because promoting "on me" above the band would have lifted an
 * ICEBOX issue sitting at a gate above an unstarted P0, and icebox is the one
 * band a human has already given a verdict on. `leaves icebox last however
 * recently it was touched` above still passes for exactly that reason.
 *
 * So the key sits beside the `done` sink and works the same way: finished sinks,
 * then in-flight sinks, and the band still orders everything within each group.
 *
 * The set is CLOSED and exhaustive over WorkerStatus, checked at compile time.
 * `ORANGE` and `STOPPED` are open partial lists with no such guard, which is how
 * `paused` and `pr-merged` came to be in neither of them. Anything not named
 * `elsewhere` keeps exactly the order it has today — the fail-safe direction.
 */
describe('work that is not with the operator sinks below the work that is', () => {
  const AT = '2026-08-11T12:00:00Z';

  it('sinks the six statuses where something other than the operator will move it', () => {
    // A worker is running it, a provisioner is building it, the dispatcher will
    // start it, a named person owes a reply, reviewers and CI hold the PR — or
    // it is merged and QA will pick it up themselves (see below).
    for (const status of ['preparing', 'active', 'queued', 'blocked', 'pr-open', 'pr-merged'] as WorkerStatus[]) {
      const theirs = row(['P0'], status, AT);
      const yours = row(['P3'], 'checkpoint', '2020-01-01T00:00:00Z');
      // Across bands and against a much staler row: the sink beats both.
      expect(compareIssues(yours, theirs)).toBeLessThan(0);
    }
  });

  it('does NOT sink the eight where nothing moves until they act', () => {
    // Each of these sits exactly where it is over a week away from the desk.
    // `paused` is the one the console gets wrong elsewhere: it is in neither
    // ORANGE nor STOPPED, so the header counts it as nothing, while summary.ts
    // calls it "waiting on you to resume it". It must not sink with the workers
    // it superficially resembles.
    const stays: WorkerStatus[] = [
      'paused',
      'at-gate',
      'awaiting-post',
      'reply-received',
      'rework',
      'detached',
      'checkpoint',
      'failed',
    ];
    for (const status of stays) {
      const yours = row(['P2'], status, AT);
      const running = row(['P2'], 'active', AT);
      expect(compareIssues(yours, running)).toBeLessThan(0);
    }
  });

  it('moves it back up the moment it is theirs again', () => {
    // The round trip in the operator's sentence, on one issue: it sinks when the worker
    // picks it up and returns when the worker parks at a gate.
    const p2 = (status: WorkerStatus) => row(['P2'], status, AT);
    const otherWork = row(['P3'], 'checkpoint', AT);
    expect(compareIssues(p2('at-gate'), otherWork)).toBeLessThan(0); // yours: above
    expect(compareIssues(p2('active'), otherWork)).toBeGreaterThan(0); // running: below
    expect(compareIssues(p2('at-gate'), otherWork)).toBeLessThan(0); // parked: back above
  });

  it('keeps the band inside each group, so triage still decides the order', () => {
    const rows = [
      row(['P3'], 'active', AT),
      row(['P0'], 'active', AT),
      row(['P3'], 'checkpoint', AT),
      row(['P0'], 'checkpoint', AT),
    ];
    expect(sortIssues(rows).map((r) => `${priorityOf(r.labels)}/${r.status}`)).toEqual([
      'P0/checkpoint',
      'P3/checkpoint',
      'P0/active',
      'P3/active',
    ]);
  });

  it('never sinks a row below a CLOSED one — done stays the floor', () => {
    const running = row(['P0'], 'active', AT);
    const closed = row(['P0'], 'done', AT);
    expect(compareIssues(running, closed)).toBeLessThan(0);
  });

  it('never outranks a UAT send-back, which still beats everything', () => {
    const sentBack = row(['icebox'], 'active', AT, false, UAT());
    expect(compareIssues(sentBack, row(['P0'], 'checkpoint', AT))).toBeLessThan(0);
  });

  it('leaves icebox at the bottom of everything in its own tier', () => {
    // Both the gate and the checkpoint are asking them something, so the band
    // orders them and icebox goes last of the two. The unstarted P0 is a tier
    // below: nobody is waiting on it, so its band cannot lift it past rows that
    // are standing still. See "unstarted work is available, not asking".
    const rows = [
      row(['icebox'], 'at-gate', '2026-08-11T23:59:00Z'),
      row(['P0'], 'no-worker', '2020-01-01T00:00:00Z'),
      row(['P3'], 'checkpoint', '2020-01-01T00:00:00Z'),
    ];
    expect(sortIssues(rows).map((r) => priorityOf(r.labels))).toEqual(['P3', 'icebox', 'P0']);
  });

  /**
   * An open PR is the one sunk status that can still be holding something of
   * their. `waiting.yours` is the server's own list of those items — the same one
   * the card prints — so a row whose card reads "You asked a question on 7 Aug
   * and nobody has answered" cannot also be filed under "not with me". Two
   * panels on one screen must not answer that question differently.
   */
  it('does not sink an open PR that the console says has items of theirs', () => {
    const mine = {
      ...row(['P2'], 'pr-open', AT),
      waiting: { on: null, note: null, yours: [{ text: 'Not ticked on PR #4547: screenshots', detail: null, url: null }] },
    };
    const theirs = { ...row(['P2'], 'pr-open', AT), waiting: { on: 'the codeowner team', note: null, yours: [] } };
    // It stays in the group they can act on: above the sunk rows, and above an
    // identical PR that has nothing of theirs outstanding.
    expect(compareIssues(mine, row(['P2'], 'active', AT))).toBeLessThan(0);
    expect(compareIssues(mine, theirs)).toBeLessThan(0);
  });

  it('sinks an open PR with nothing of theirs on it', () => {
    // An empty `yours` is the server saying it checked and found none — the
    // opposite of the exemption above, and it must sink like any other PR out
    // for review. Even a P0 one goes below a P3 they have to restart.
    const theirs = { ...row(['P0'], 'pr-open', AT), waiting: { on: 'Waiting for the codeowner team.', note: null, yours: [] } };
    expect(compareIssues(theirs, row(['P3'], 'checkpoint', AT))).toBeGreaterThan(0);
  });

  it('treats a row with no waiting field at all as sinkable, not as an exemption', () => {
    // An older console, or a rebuilt ui/dist talking to a server that has not
    // restarted, sends no `waiting`. Absent must mean "nothing of theirs is
    // recorded", or every open PR in the repo would stop sinking at once —
    // the same failure the `!= null` guard on `uatFail` exists to prevent.
    const bare = row(['P2'], 'pr-open', AT);
    expect(compareIssues(bare, row(['P2'], 'checkpoint', AT))).toBeGreaterThan(0);
  });
});

/**
 * The operator asked why something being actively worked on sits at the bottom of
 * the priority list: a worker in flight means the issue is with them, so they
 * expect it prioritised up the queue.
 *
 * They are right, and the fault was a two-way split where three was the honest
 * number. The original test — "will this row move on its own over a week away?"
 * — put a worker running on THEIR machine, on THEIR issue, likely to come back to
 * them within the hour, in the same bucket as a PR that has been sitting with the
 * codeowner team for days. Both answer "yes, it moves", and that is where the
 * question stopped being useful.
 *
 * The second question is WHOSE machine. So:
 *
 *   yours      nothing happens until you act        gates, stopped, failed,
 *                                                   unstarted, paused
 *   live       your worker is on it right now       active, preparing
 *   elsewhere  other people or other queues have it  queued, blocked, pr-open,
 *                                                   pr-merged
 *   done       closed                                (sunk one key higher)
 *
 * Which is also, exactly, the colour order shipped alongside it: orange, then
 * green, then grey, then faint. The rail now explains its own sort.
 */
describe('work your own worker is doing sits above work other people have', () => {
  const AT = '2026-08-11T12:00:00Z';

  it('lifts a running worker above every status somebody else holds', () => {
    for (const theirs of ['queued', 'blocked', 'pr-open', 'pr-merged'] as WorkerStatus[]) {
      // Even a P3 running beats a P0 parked with someone else: the tier decides
      // first, exactly as it does for the rest of the sort.
      expect(compareIssues(row(['P3'], 'active', AT), row(['P0'], theirs, AT))).toBeLessThan(0);
    }
  });

  it('still keeps it below anything actually asking you a question', () => {
    // "Up the queue", not "to the top". A gate is a person waiting; a running
    // worker is something to watch.
    for (const mine of ['at-gate', 'checkpoint', 'failed', 'rework'] as WorkerStatus[]) {
      expect(compareIssues(row(['P3'], mine, AT), row(['P0'], 'active', AT))).toBeLessThan(0);
    }
  });

  it('treats provisioning as live too — the machine is doing something', () => {
    expect(compareIssues(row(['P3'], 'preparing', AT), row(['P0'], 'pr-open', AT))).toBeLessThan(0);
  });

  it('does NOT lift a queued row: nothing is happening to it yet', () => {
    // The distinction they drew is "actively worked on". A queued issue is waiting
    // for a slot — real, but not work in progress, and it rises on its own the
    // moment the dispatcher starts it.
    expect(compareIssues(row(['P0'], 'queued', AT), row(['P3'], 'active', AT))).toBeGreaterThan(0);
  });

  it('orders by band inside the live tier, like every other tier', () => {
    const rows = [row(['P3'], 'active', AT), row(['P0'], 'active', AT), row(['P2'], 'preparing', AT)];
    expect(sortIssues(rows).map((r) => priorityOf(r.labels))).toEqual(['P0', 'P2', 'P3']);
  });

  it('leaves the three tiers in order on a realistic board', () => {
    const rows = [
      row(['P2'], 'pr-open', AT),
      row(['P3'], 'active', AT),
      row(['P1'], 'at-gate', AT),
      row(['P0'], 'pr-merged', AT),
      row(['P2'], 'checkpoint', AT),
      row(['P1'], 'done', AT),
    ];
    expect(sortIssues(rows).map((r) => r.status)).toEqual([
      'at-gate', // yours
      'checkpoint', // yours
      'active', // live
      'pr-merged', // elsewhere — P0 and still below a P3 running on their machine
      'pr-open', // elsewhere
      'done', // closed
    ]);
  });

  it('a UAT send-back still beats all three tiers', () => {
    const sentBack = row(['icebox'], 'pr-open', AT, false, UAT());
    expect(compareIssues(sentBack, row(['P0'], 'at-gate', AT))).toBeLessThan(0);
  });
});

/**
 * The operator, seeing the three-tier list, asked why the active issue was so far
 * down it — below tickets with no worker at all — when they expected it at the top.
 *
 * `no-worker` was in `yours` because only they can start one — true, and the wrong
 * conclusion. An issue nobody has touched is AVAILABLE, not asking: nothing is
 * standing still waiting on an answer, and it has no more claim on the top of
 * the list than the backlog it came from. A worker running on their machine is
 * more theirs than an issue they have never opened.
 *
 * So unstarted work gets its own tier below live. It stays above `elsewhere`,
 * because picking it up is still their move and nobody else's.
 */
describe('unstarted work is available, not asking', () => {
  const AT = '2026-08-11T12:00:00Z';

  it('puts a running worker above the unstarted backlog', () => {
    // Even a P3 running beats a P0 nobody has started: one is in flight on their
    // machine, the other is a row in a list.
    expect(compareIssues(row(['P3'], 'active', AT), row(['P0'], 'no-worker', AT))).toBeLessThan(0);
  });

  it('still keeps unstarted work above what other people hold', () => {
    // Starting it is their move and nobody else's, so it does not sink all the way.
    expect(compareIssues(row(['P3'], 'no-worker', AT), row(['P0'], 'pr-open', AT))).toBeLessThan(0);
  });

  it('leaves the four tiers in order on the real board', () => {
    const rows = [
      row(['P0'], 'pr-open', AT),
      row(['P0'], 'no-worker', AT),
      row(['P3'], 'active', AT),
      row(['P3'], 'at-gate', AT),
    ];
    expect(sortIssues(rows).map((r) => r.status)).toEqual(['at-gate', 'active', 'no-worker', 'pr-open']);
  });

  it('does not disturb anything else that is theirs', () => {
    // A checkpoint is still asking; it stays above a running worker.
    expect(compareIssues(row(['P3'], 'checkpoint', AT), row(['P0'], 'active', AT))).toBeLessThan(0);
  });
});

/**
 * PARKED — the operator puts a ticket down.
 *
 * The operator asked to pause some tickets: they stay at their gate, they leave
 * the top of the queue, and the row says plainly that it is paused — the same
 * treatment as blocked, so it is clear which tickets are neither complete nor
 * awaiting something. That is a different state from awaiting external review or
 * input, such as a PR that is open and waiting to be reviewed and merged.
 *
 * Three requirements, and this file owns two of them: the row leaves the top of
 * the list, and it does not take an open PR down with it. The third — that it
 * keeps its gate — is guarded by what this file does NOT do: nothing here reads
 * or writes a status, so `parked` cannot displace `at-gate`.
 */
const PARKED = (reason: string | null = 'waiting for the design call') => ({ at: '2026-08-17T10:00:00Z', reason });

/** A parked variant of the `row` helper above. */
const parked = (
  labels: string[],
  status: WorkerStatus,
  updatedAt: string,
  reason: string | null = 'waiting for the design call',
): Sortable => ({ ...row(labels, status, updatedAt), parked: PARKED(reason) });

describe('a parked ticket leaves the top of the queue', () => {
  const AT = '2026-08-11T12:00:00Z';

  it('sinks a parked P0 at a gate below an untouched P3 nobody has started', () => {
    // The headline case, and the one the operator described: it is at a gate, it is P0,
    // and they still does not want to see it first.
    const set = parked(['P0'], 'at-gate', AT);
    const open = row(['P3'], 'no-worker', '2020-01-01T00:00:00Z');
    expect(sortIssues([set, open]).map((r) => priorityOf(r.labels))).toEqual(['P3', 'P0']);
  });

  it('sinks it below a live worker and below an open PR', () => {
    for (const theirs of ['active', 'pr-open', 'pr-merged', 'queued'] as WorkerStatus[]) {
      expect(compareIssues(parked(['P0'], 'at-gate', AT), row(['icebox'], theirs, AT))).toBeGreaterThan(0);
    }
  });

  it('sinks it even when UAT sent the work back — parking is the newer decision', () => {
    // The send-back is the one key that otherwise beats every band. They parked
    // the row WITH that verdict already on screen, so their act is the later word.
    // A parked ticket that still shouted from the top would fail on exactly the
    // rows the lever is most needed for.
    const shouting = { ...parked(['P2'], 'pr-merged', AT), uatFail: UAT() };
    expect(compareIssues(shouting, row(['P3'], 'no-worker', '2020-01-01T00:00:00Z'))).toBeGreaterThan(0);
  });

  it('never sinks below a CLOSED one — done is still the floor', () => {
    // The two sinks are ONE key precisely so this ordering is expressible.
    expect(compareIssues(parked(['P0'], 'at-gate', AT), row(['P0'], 'done', AT))).toBeLessThan(0);
  });

  it('stays ordered inside its own group, so the group is still readable', () => {
    // It sinks; it does not turn into a heap. Band first, exactly as everywhere
    // else — the way they find one again three weeks later.
    const rows = [parked(['P3'], 'at-gate', AT), parked(['P0'], 'at-gate', AT), parked(['icebox'], 'at-gate', AT)];
    expect(sortIssues(rows).map((r) => priorityOf(r.labels))).toEqual(['P0', 'P3', 'icebox']);
  });

  it('comes straight back when un-parked — nothing was moved, so nothing moves back', () => {
    const before = row(['P0'], 'at-gate', AT);
    const after = { ...before, parked: null };
    const other = row(['P1'], 'at-gate', AT);
    expect(sortIssues([other, after]).map((r) => priorityOf(r.labels))).toEqual(['P0', 'P1']);
  });

  it('stops counting as "waiting on you" — the header number and the card both', () => {
    // `waitingOnYou` is the header count, the Dashboard's own card and the rail
    // edge. A ticket deliberately set aside must stop adding itself to the one
    // number they read the console for.
    expect(waitingOnYou(row(['P0'], 'at-gate', AT))).toBe(true);
    expect(waitingOnYou(parked(['P0'], 'at-gate', AT))).toBe(false);
    expect(waitingOnYou(parked(['P0'], 'checkpoint', AT))).toBe(false);
  });

  it('counts an open PR holding items of theirs — the count, the edge and the order agree', () => {
    // The last surface reading status alone. `courtOf` promotes a row with a
    // non-empty `waiting.yours` out of `elsewhere` and `edgeClass` edges it
    // orange, so a draft PR could sit at the top of the rail, edged orange, its
    // card headed "For you to follow up" — and be missing from the "N waiting on
    // you" count in the header directly above it. #4375 and #5269 were exactly
    // that for weeks: two rows nobody was reviewing and the count never saw.
    const draft = {
      ...row([], 'pr-open', AT),
      waiting: {
        on: null,
        note: null,
        yours: [
          {
            text: 'PR #5358 is still a draft — nobody can review it until you mark it ready for review.',
            detail: null,
            url: 'https://github.com/example-org/example-repo/pull/5358',
          },
        ],
      },
    };
    expect(waitingOnYou(draft)).toBe(true);
    // And parking it still silences it, above everything, as it does for a gate.
    expect(waitingOnYou({ ...draft, parked: PARKED() })).toBe(false);
  });

  it('does not count an open PR that is holding nothing of theirs', () => {
    // The healthy case, and most open PRs: a codeowner has it, and the count
    // must not swell with rows that need nothing. An ABSENT `waiting` — a
    // rebuilt `ui/dist` in front of a console that has not restarted — is the
    // same answer, on the same rule `isParked` and `isUatFail` already keep.
    expect(waitingOnYou({ ...row([], 'pr-open', AT), waiting: { on: 'Waiting for a review.', note: null, yours: [] } })).toBe(
      false,
    );
    expect(waitingOnYou(row([], 'pr-open', AT))).toBe(false);
  });

  it('reads a MISSING parked field as not parked', () => {
    // A rebuilt `ui/dist` in front of a console that has not restarted sends
    // rows with no `parked` key. `undefined != null` is false — the same guard
    // `uatFail` carries, and the same disaster avoided: every row sinking at once.
    const old = row(['P0'], 'at-gate', AT);
    expect(isParked(old)).toBe(false);
    expect(compareIssues(old, row(['P1'], 'at-gate', AT))).toBeLessThan(0);
  });
});

describe('two tickets in the line are drawn in the order they will be served', () => {
  const AT = '2026-08-11T12:00:00Z';
  const queued = (labels: string[], position: number | null, updatedAt = AT): Sortable => ({
    ...row(labels, 'queued', updatedAt),
    queuePosition: position,
  });

  it('draws the sent-back P2 above the untouched P1, exactly as the line serves them', () => {
    // `queue.ts` key 2 puts a ticket they sent back above every band. The rail
    // used to draw the P1 first and print "2 in line" on it — one screen, two
    // answers to "what runs next".
    const sentBack = queued(['P2'], 1);
    const untouched = queued(['P1'], 2);
    expect(sortIssues([untouched, sentBack])).toEqual([sentBack, untouched]);
  });

  it('is FIFO inside a band, like the line — not newest-first', () => {
    // The line is stable over arrival order; the rail's last key is `updatedAt`,
    // descending. On two queued tickets of the same band that is close to the
    // reverse of the order they run in.
    const first = queued(['P1'], 1, '2026-08-11T09:00:00Z');
    const second = queued(['P1'], 2, '2026-08-11T18:00:00Z'); // touched later
    expect(sortIssues([second, first])).toEqual([first, second]);
  });

  it('says nothing about a row that is not in the line', () => {
    // The guard that keeps this from becoming a second priority scheme: an
    // unstarted P0 is still above a queued icebox ticket, because the two are
    // never compared on position.
    const icebox = queued(['icebox'], 1);
    const fresh = row(['P0'], 'no-worker', AT);
    expect(sortIssues([icebox, fresh])).toEqual([fresh, icebox]);
  });

  it('leaves the band deciding when neither row has a position', () => {
    // A rebuilt `ui/dist` in front of a console that has not restarted sends no
    // `queuePosition` at all. Absent is "not in the line", and the ordering is
    // exactly what it was.
    const p1 = row(['P1'], 'queued', AT);
    const p3 = row(['P3'], 'queued', AT);
    expect(sortIssues([p3, p1])).toEqual([p1, p3]);
  });

  it('does not reorder rows the line has no opinion about', () => {
    // One in the line, one at a gate: the court key above this has already
    // decided, and it stays decided.
    const atGate = row(['P3'], 'at-gate', AT);
    const inLine = queued(['P0'], 1);
    expect(sortIssues([inLine, atGate])).toEqual([atGate, inLine]);
  });
});

describe('blocked shares the sink, and an open PR does not', () => {
  const AT = '2026-08-11T12:00:00Z';

  it('sinks a blocked row below the open PR it used to sort beside', () => {
    // Both were `elsewhere` and both rendered plain grey, so a comment nobody
    // has answered and a PR under active review were indistinguishable in
    // position AND in colour. The operator draws the line between them explicitly.
    expect(compareIssues(row(['P0'], 'blocked', AT), row(['icebox'], 'pr-open', AT))).toBeGreaterThan(0);
  });

  it('leaves the open PR exactly where it was, above the sink', () => {
    // The requirement as the operator stated it: awaiting external review is
    // slightly different. It is not stalled — it is progressing without them.
    expect(isAside(row(['P0'], 'pr-open', AT))).toBe(false);
    expect(isAside(row(['P0'], 'pr-merged', AT))).toBe(false);
    expect(isAside(row(['P0'], 'queued', AT))).toBe(false);
  });

  it('does not flatten an open PR that is holding something of THEIRS', () => {
    // `waiting.yours` still lifts it out of `elsewhere` (see `courtOf`), and the
    // new sink must not have swallowed that: it is the one rule waiting.ts
    // exists to enforce.
    const mine: Sortable = {
      ...row(['P2'], 'pr-open', AT),
      waiting: { on: null, note: null, yours: [{ text: 'Not ticked on PR #4547: screenshots', detail: null, url: null }] },
    };
    expect(isAside(mine)).toBe(false);
    expect(compareIssues(mine, row(['P2'], 'pr-open', AT))).toBeLessThan(0);
  });

  it('puts the two members of the class together, above closed work', () => {
    const rows = [
      row(['P1'], 'done', AT),
      row(['P2'], 'blocked', AT),
      parked(['P0'], 'at-gate', AT),
      row(['P3'], 'at-gate', AT),
      row(['P2'], 'pr-open', AT),
    ];
    expect(sortIssues(rows).map((r) => (isParked(r) ? 'parked' : r.status))).toEqual([
      'at-gate', // yours, and asking
      'pr-open', // somebody else is moving it — NOT in the sink
      'parked', // set aside
      'blocked', // stalled on a named person
      'done', // the floor
    ]);
  });

  it('never claims a CLOSED issue is merely "awaiting"', () => {
    // `done` is excluded from `isAside` on purpose: it has its own, lower sink,
    // and calling finished work "not complete" would be wrong twice over.
    expect(isAside(row([], 'done', AT))).toBe(false);
    expect(isAside({ ...row([], 'done', AT), parked: PARKED() })).toBe(false);
  });
});
