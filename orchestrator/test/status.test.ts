import { describe, it, expect } from 'vitest';
import { deriveStatus, effectiveStage, needsOperator } from '../src/status.js';
import type { GateFile, PullRequest } from '../src/types.js';

const base = {
  hasWorktree: false,
  isRunning: false,
  gate: null as GateFile | null,
  detached: false,
  queuePosition: null as number | null,
  lastError: null as string | null,
  pr: null as PullRequest | null,
  stage: null as number | null,
};

const gateC: GateFile = {
  issue: 4336,
  gate: 'C',
  stage: 4,
  sessionId: null,
  stoppedAt: null,
  reportPath: null,
  summary: '',
  questions: [],
};

const pr: PullRequest = { number: 4368, url: 'u', state: 'OPEN', title: 't', isDraft: false };

describe('deriveStatus — the three worktrees that exist on this machine', () => {
  it('#4336 (stopped at gate C) shows AT GATE C', () => {
    const s = deriveStatus({ ...base, hasWorktree: true, gate: gateC, stage: 4 });
    expect(s.status).toBe('at-gate');
    expect(s.statusDetail).toBe('at gate C');
  });

  it('#4334 (stage 2, no gate file, no PR) shows a checkpoint', () => {
    const s = deriveStatus({ ...base, hasWorktree: true, stage: 2 });
    expect(s.status).toBe('checkpoint');
    expect(s.statusDetail).toBe('stopped after stage 2');
  });

  it('says WHY when the last run exited cleanly and stopped at no gate', () => {
    // The operator asked why #5402 was on a checkpoint. Four gates passed, no PR, no
    // gate file — a worker that ended its turn at Stage 7 without raising one.
    // The row printed "stopped after stage 6" and nothing else, which is the
    // same sentence a worktree nobody has ever started work in prints.
    const s = deriveStatus({ ...base, hasWorktree: true, stage: 6, endedWithoutGate: true });
    expect(s.status).toBe('checkpoint');
    expect(s.statusDetail).toBe('stopped after stage 6 — the worker ended its turn without stopping at a gate');
  });

  it('keeps the bare line when nothing is known about the ending', () => {
    // An older state file, or a worktree scaffolded and never run. The console
    // does not invent an ending it has no record of.
    const s = deriveStatus({ ...base, hasWorktree: true, stage: 2 });
    expect(s.statusDetail).toBe('stopped after stage 2');
  });

  it('lets "while the console was down" win — it is the stronger caveat', () => {
    // Both can be true of one ending: a clean exit, unattended. Whatever else is
    // said, the console was not watching, so that is the half they need first.
    const s = deriveStatus({ ...base, hasWorktree: true, stage: 3, endedWhileDown: true, endedWithoutGate: true });
    expect(s.statusDetail).toBe('stopped after stage 3 — it ended while the console was down');
  });

  it('says it even when the worker never recorded a stage', () => {
    const s = deriveStatus({ ...base, hasWorktree: true, stage: null, endedWithoutGate: true });
    expect(s.statusDetail).toBe('stopped part-way — the worker ended its turn without stopping at a gate');
  });

  it('#4342 (stage 7 with PR #4368 open) shows PR open', () => {
    const s = deriveStatus({ ...base, hasWorktree: true, stage: 7, pr });
    expect(s.status).toBe('pr-open');
    expect(s.statusDetail).toBe('PR #4368 open');
  });

  it('an issue with no worktree shows no worker', () => {
    expect(deriveStatus(base).status).toBe('no-worker');
  });
});

describe('deriveStatus — precedence', () => {
  it('a running worker beats everything else', () => {
    const s = deriveStatus({ ...base, hasWorktree: true, isRunning: true, gate: gateC, pr, stage: 4 });
    expect(s.status).toBe('active');
  });

  it('a gate beats an open PR, because a gate is a person waiting', () => {
    expect(deriveStatus({ ...base, hasWorktree: true, gate: gateC, pr }).status).toBe('at-gate');
  });

  it('detached beats queued, so we never start a second owner of one session', () => {
    expect(deriveStatus({ ...base, hasWorktree: true, detached: true, queuePosition: 1 }).status).toBe('detached');
  });

  it('a failed run beats an open PR, because a failure is news', () => {
    const s = deriveStatus({ ...base, hasWorktree: true, lastError: 'auth expired', pr });
    expect(s.status).toBe('failed');
    expect(s.statusDetail).toBe('auth expired');
  });

  it('queued says where in the line', () => {
    expect(deriveStatus({ ...base, queuePosition: 1 }).statusDetail).toBe('next up');
    expect(deriveStatus({ ...base, queuePosition: 3 }).statusDetail).toBe('3 in line');
  });

  /**
   * "2 in line" says where, never how long. #4687 sat second in the queue for
   * over eight hours behind two long-running workers and the row said the same
   * thing the whole time, so there was no way to tell a fresh queue entry from
   * an overnight one without reading runs.jsonl by hand.
   */
  it('queued also says HOW LONG it has been waiting, once stamped', () => {
    const now = Date.parse('2026-08-19T03:36:00Z');
    expect(
      deriveStatus({ ...base, queuePosition: 2, queuedAt: '2026-08-18T19:19:54Z' }, now).statusDetail,
    ).toBe('2 in line · queued 8 h ago');
    expect(
      deriveStatus({ ...base, queuePosition: 1, queuedAt: '2026-08-19T03:30:00Z' }, now).statusDetail,
    ).toBe('next up · queued 6 min ago');
  });

  /** An unstamped entry — every row already in the queue when this shipped —
   *  says what it always said rather than inventing a time. */
  it('says only the position when nothing stamped it', () => {
    expect(deriveStatus({ ...base, queuePosition: 2 }).statusDetail).toBe('2 in line');
    expect(deriveStatus({ ...base, queuePosition: 2, queuedAt: null }).statusDetail).toBe('2 in line');
  });
});

describe('deriveStatus — a worktree being built', () => {
  it('shows preparing while the worktree is being created', () => {
    const s = deriveStatus({ ...base, provision: { phase: 'creating', error: null } });
    expect(s.status).toBe('preparing');
    expect(s.statusDetail).toBe('creating the worktree');
  });

  /** `preparing` is no longer entered — provisioning is create + scaffold and
   *  nothing installs — but a row persisted or on screen under it must still
   *  read as something, and it must not promise an npm install that no longer
   *  happens. */
  it('reads a lingering preparing phase without claiming an install is running', () => {
    const s = deriveStatus({ ...base, hasWorktree: true, provision: { phase: 'preparing', error: null } });
    expect(s.status).toBe('preparing');
    expect(s.statusDetail).toBe('setting the worktree up');
    expect(s.statusDetail).not.toMatch(/npm install/);
  });

  it('a failed install shows as failed with its reason, never as ready', () => {
    const s = deriveStatus({
      ...base,
      hasWorktree: true,
      provision: { phase: 'failed', error: 'npm install failed with code 1' },
    });
    expect(s.status).toBe('failed');
    expect(s.statusDetail).toBe('npm install failed with code 1');
  });

  it('falls through to the normal statuses once the build is ready', () => {
    const s = deriveStatus({ ...base, hasWorktree: true, stage: 0, provision: { phase: 'ready', error: null } });
    expect(s.status).toBe('checkpoint');
  });

  it('a half-built worktree never reads as "no worker"', () => {
    expect(deriveStatus({ ...base, provision: { phase: 'creating', error: null } }).status).not.toBe('no-worker');
  });
});

describe('deriveStatus — third-party comment flow', () => {
  it('shows awaiting-post while a worker has drafted a comment for the operator to send', () => {
    const s = deriveStatus({ ...base, hasWorktree: true, commentRequest: { addressee: '@teammate-one' } });
    expect(s.status).toBe('awaiting-post');
    expect(s.statusDetail).toBe('drafted a comment for @teammate-one — needs your OK to post');
  });

  it('calls a real decision a product question in plain English', () => {
    const s = deriveStatus({
      ...base,
      hasWorktree: true,
      commentRequest: { addressee: '@teammate-one', kind: 'decision' },
    });
    expect(s.status).toBe('awaiting-post');
    expect(s.statusDetail).toBe('drafted a product question for @teammate-one — needs your OK to post');
    expect(s.statusDetail).not.toMatch(/injunction|comment request|decision artifact/i);
  });

  it('calls a workflow handoff a comment rather than a product question', () => {
    const s = deriveStatus({
      ...base,
      hasWorktree: true,
      commentRequest: { addressee: '@qa-owner', kind: 'handoff' },
    });
    expect(s.statusDetail).toBe('drafted a comment for @qa-owner — needs your OK to post');
    expect(s.statusDetail).not.toContain('product question');
  });

  it('shows blocked·awaiting once the comment is posted and no reply yet', () => {
    const s = deriveStatus({
      ...base,
      hasWorktree: true,
      commentBlock: { addressee: '@teammate-one', postedAt: 'x', commentUrl: 'u', reply: null },
    });
    expect(s.status).toBe('blocked');
    expect(s.statusDetail).toBe('awaiting @teammate-one');
  });

  it('flips to reply-received (orange) when a reply lands', () => {
    const s = deriveStatus({
      ...base,
      hasWorktree: true,
      commentBlock: {
        addressee: '@teammate-one',
        postedAt: 'x',
        commentUrl: 'u',
        reply: { author: 'teammate-one', createdAt: 'y', body: 'use dev.example' },
      },
    });
    expect(s.status).toBe('reply-received');
    expect(s.statusDetail).toBe('teammate-one replied');
  });

  it('a live gate still outranks a comment block', () => {
    const s = deriveStatus({
      ...base,
      hasWorktree: true,
      gate: gateC,
      commentBlock: { addressee: '@teammate-one', postedAt: 'x', commentUrl: null, reply: null },
    });
    expect(s.status).toBe('at-gate');
  });

  it('once posted, the block wins even though the request file lingers on disk until resume', () => {
    const s = deriveStatus({
      ...base,
      hasWorktree: true,
      commentRequest: { addressee: '@X' },
      commentBlock: { addressee: '@X', reply: null },
    });
    expect(s.status).toBe('blocked');
  });
});

/**
 * The bug: only the GATE card knew about being answered at capacity. Answering a
 * rework, a landed reply or a drafted comment while the desk was full was
 * accepted and queued too — but the row kept saying `rework` / `reply-received`
 * / `awaiting-post`, so the card stayed actionable and clicking it again only
 * replaced the answer that was already promised. Every card that asks the operator
 * something has to step aside once they have answered it.
 */
describe('deriveStatus — answered, and waiting for a slot rather than for the operator', () => {
  const queued = { ...base, hasWorktree: true, answered: true, queuePosition: 1 };

  it('an answered gate stops claiming the row', () => {
    expect(deriveStatus({ ...queued, gate: gateC }).status).toBe('queued');
  });

  it('an answered rework stops claiming the row', () => {
    expect(deriveStatus({ ...queued, pr, reviewBlock: { reviewer: 'claude' } }).status).toBe('queued');
  });

  it('an answered reply stops claiming the row', () => {
    const block = { addressee: '@teammate-one', reply: { author: 'teammate-one' } };
    expect(deriveStatus({ ...queued, commentBlock: block }).status).toBe('queued');
  });

  it('an answered issue with a drafted comment still on disk stops claiming the row', () => {
    expect(deriveStatus({ ...queued, commentRequest: { addressee: '@teammate-one' } }).status).toBe('queued');
  });

  it('says where in the line, not what it was asking', () => {
    const s = deriveStatus({ ...queued, queuePosition: 3, reviewBlock: { reviewer: 'claude' } });
    expect(s.statusDetail).toBe('3 in line');
  });

  it('changes nothing when they have NOT answered — every card still asks', () => {
    const waiting = { ...base, hasWorktree: true };
    expect(deriveStatus({ ...waiting, gate: gateC }).status).toBe('at-gate');
    expect(deriveStatus({ ...waiting, reviewBlock: { reviewer: 'claude' } }).status).toBe('rework');
    expect(deriveStatus({ ...waiting, commentRequest: { addressee: '@X' } }).status).toBe('awaiting-post');
    expect(deriveStatus({ ...waiting, commentBlock: { addressee: '@X', reply: { author: 'X' } } }).status).toBe(
      'reply-received',
    );
  });

  it('a RUNNING worker still outranks it — answered means queued, not active', () => {
    expect(deriveStatus({ ...queued, isRunning: true, gate: gateC }).status).toBe('active');
  });
});

describe('needsOperator', () => {
  it('is true at a gate, a drafted comment, and a received reply — the things that need the operator', () => {
    for (const s of ['at-gate', 'awaiting-post', 'reply-received'] as const) {
      expect(needsOperator(s)).toBe(true);
    }
    for (const s of ['active', 'queued', 'blocked', 'detached', 'pr-open', 'checkpoint', 'failed', 'no-worker', 'preparing'] as const) {
      expect(needsOperator(s)).toBe(false);
    }
  });
});

describe('effectiveStage — evidence outranks the worker note', () => {
  const pr = (state: string) => ({ number: 4446, url: 'u', state, title: 't', isDraft: false });

  it('an open PR means stage 7 even when the file still says 5 (the #4336 case)', () => {
    expect(effectiveStage({ fileStage: 5, pr: pr('OPEN') })).toBe(7);
  });

  it('a merged PR means post-merge', () => {
    expect(effectiveStage({ fileStage: 5, pr: pr('MERGED') })).toBe(9);
  });

  it('never drags a further-along worker backwards', () => {
    expect(effectiveStage({ fileStage: 8, pr: pr('OPEN') })).toBe(8);
  });

  it('falls back to the file when there is no PR', () => {
    expect(effectiveStage({ fileStage: 3, pr: null })).toBe(3);
    expect(effectiveStage({ fileStage: null, pr: null })).toBeNull();
  });

  it('works with a PR but no file stage at all', () => {
    expect(effectiveStage({ fileStage: null, pr: pr('OPEN') })).toBe(7);
  });
});

/**
 * A paused worker and a merged PR: two states the console could not previously
 * express, and both of them failed in the same direction — a row that said
 * something untrue about work that was fine.
 */
describe('paused', () => {
  const base = {
    hasWorktree: true,
    gate: null,
    detached: false,
    queuePosition: null,
    lastError: null,
    pr: null,
    stage: 3,
  };
  const stamp = { at: '2026-08-11T23:12:00Z', by: 'floor' as const, reason: '4% free — the memory floor' };

  it('outranks active — a paused worker is still in the runner, so this must be read first', () => {
    const out = deriveStatus({ ...base, isRunning: true, paused: stamp });
    expect(out.status).toBe('paused');
    expect(out.statusDetail).toContain('paused by the memory floor');
    expect(out.statusDetail).toContain('4% free');
    // It must never read as stuck: the row says what to do about it.
    expect(out.statusDetail).toContain('Resume');
  });

  it('distinguishes a pause you asked for from one the floor took', () => {
    const mine = deriveStatus({ ...base, isRunning: true, paused: { ...stamp, by: 'you' } });
    expect(mine.statusDetail).toContain('paused by you');
  });

  it('goes straight back to active when the stamp is cleared', () => {
    expect(deriveStatus({ ...base, isRunning: true, paused: null }).status).toBe('active');
  });

  it('is not one of the things asking you for an answer', () => {
    expect(needsOperator('paused')).toBe(false);
  });
});

describe('a merged PR', () => {
  const merged = { number: 4446, url: 'u', state: 'MERGED', title: 't', isDraft: false, mergedAt: 'z' };

  it('reads as merged and names the PR, instead of falling through to a checkpoint', () => {
    const out = deriveStatus({
      hasWorktree: true,
      isRunning: false,
      gate: null,
      detached: false,
      queuePosition: null,
      lastError: null,
      pr: merged,
      stage: 9,
    });
    expect(out.status).toBe('pr-merged');
    expect(out.statusDetail).toBe('PR #4446 merged — stage 9 post-merge');
  });

  it('still lets a gate, a failure or a queue place outrank it — those are news', () => {
    const at = (over: Record<string, unknown>) =>
      deriveStatus({
        hasWorktree: true,
        isRunning: false,
        gate: null,
        detached: false,
        queuePosition: null,
        lastError: null,
        pr: merged,
        stage: 9,
        ...over,
      }).status;
    expect(at({ lastError: 'it blew up' })).toBe('failed');
    expect(at({ queuePosition: 1 })).toBe('queued');
  });
});

/**
 * A closed issue is closed, whoever was driving it.
 *
 * `detached` sat ABOVE `issueClosed`, and `exitMtimes` — the stamp that decides
 * it — is persisted and only cleared by restart-fresh or reset. So an issue the operator
 * took over in a terminal, drove to a merged PR, and QA then closed would read
 * "detached — you took this one over in a terminal" forever: never `done`, never
 * faded, holding a live-looking row for finished work indefinitely.
 *
 * That was survivable while `detached` had no colour. It is not now that it
 * carries one, so the order is fixed here rather than papered over in the CSS.
 * The existing rule this must not break is narrow and still holds: "detached
 * beats queued, so we never start a second owner of one session" — a closed
 * issue is not one we would start.
 */
describe('deriveStatus — closed beats detached', () => {
  const base = {
    hasWorktree: true,
    isRunning: false,
    gate: null as GateFile | null,
    detached: false,
    queuePosition: null as number | null,
    lastError: null as string | null,
    pr: null as PullRequest | null,
    stage: null as number | null,
  };

  it('reads DONE once QA has closed it, even after a terminal takeover', () => {
    const s = deriveStatus({ ...base, detached: true, issueClosed: true });
    expect(s.status).toBe('done');
  });

  it('keeps an explicit true-style comment wait above inferred closure', () => {
    const s = deriveStatus({
      ...base,
      issueClosed: true,
      commentRequest: { addressee: '@teammate-two' },
      commentBlock: { addressee: '@teammate-two', reply: null },
    });
    expect(s.status).toBe('blocked');
    expect(s.statusDetail).toBe('awaiting @teammate-two');
  });

  it('keeps a real gate above the closed fallback', () => {
    expect(deriveStatus({ ...base, issueClosed: true, gate: gateC }).status).toBe('at-gate');
  });

  it('keeps an already-answered comment queued instead of claiming DONE before dispatch', () => {
    const s = deriveStatus({
      ...base,
      issueClosed: true,
      answered: true,
      queuePosition: 1,
      commentBlock: { addressee: '@teammate-two', reply: null },
    });
    expect(s.status).toBe('queued');
  });

  it('still reads detached while the issue is open', () => {
    expect(deriveStatus({ ...base, detached: true }).status).toBe('detached');
  });

  it('keeps the rule that made detached rank high in the first place', () => {
    // Never start a second owner of one session.
    expect(deriveStatus({ ...base, detached: true, queuePosition: 1 }).status).toBe('detached');
  });
});

/**
 * #4914 — "QA SIGNED IT OFF" WAS AN INFERENCE, AND IT WAS WRONG.
 *
 * The closed branch read the sentence off the close alone. On 2026-08-21 the
 * tester posted `Test Result: Fail`, closed the issue as COMPLETED in the same
 * second, and moved the card to `Revisit` twelve seconds later — so the one row
 * that most needed to say the work had come back was the row asserting that it
 * had been signed off.
 *
 * The send-back comes from the same feed the UAT chip and card are drawn from,
 * so the sentence cannot contradict what is rendered beside it.
 */
describe('a closed issue that was sent back does not claim a sign-off', () => {
  const merged: PullRequest = {
    number: 4976,
    url: 'https://github.com/example-org/example-repo/pull/4976',
    state: 'MERGED',
    title: 'page the exclusion catalog reads',
    isDraft: false,
    mergedAt: '2026-08-20T23:41:01Z',
  };
  const closed = { ...base, hasWorktree: true, issueClosed: true, pr: merged };

  it('names who sent it back, and says it is not signed off', () => {
    const out = deriveStatus({ ...closed, sentBack: { by: 'qa-alice', verdict: 'Fail', inflight: false } });
    expect(out.statusDetail).toContain('qa-alice');
    expect(out.statusDetail).toContain('Fail');
    expect(out.statusDetail).toContain('not signed off');
    expect(out.statusDetail).not.toContain('QA signed it off');
  });

  it('still reads as signed off when nothing came back', () => {
    expect(deriveStatus(closed).statusDetail).toContain('QA signed it off');
    expect(deriveStatus({ ...closed, sentBack: null }).statusDetail).toContain('QA signed it off');
  });

  /** The row #4914 actually reached: the PR merged, the issue read open, and the
   *  sentence invited a QA hand-off for work QA had just failed. */
  it('does not offer stage 9 on a merged PR that was sent back', () => {
    const out = deriveStatus({ ...base, hasWorktree: true, pr: merged, sentBack: { by: 'qa-alice', verdict: 'Fail', inflight: false } });
    expect(out.status).toBe('pr-merged');
    expect(out.statusDetail).not.toContain('stage 9');
    expect(out.statusDetail).toContain('qa-alice');
  });

  it('says a fix is in flight when one is, on either ending', () => {
    const inflight = { by: 'qa-alice', verdict: 'Fail', inflight: true };
    expect(deriveStatus({ ...base, hasWorktree: true, pr: merged, sentBack: inflight }).statusDetail).toContain(
      'a fix is in flight',
    );
    expect(deriveStatus({ ...closed, sentBack: inflight }).statusDetail).toContain('a fix is in flight');
  });

  it('still says stage 9 when nothing was sent back', () => {
    expect(deriveStatus({ ...base, hasWorktree: true, pr: merged }).statusDetail).toContain('stage 9 post-merge');
  });
});
