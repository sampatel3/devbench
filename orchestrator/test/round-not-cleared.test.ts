import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { reviewOutstanding } from '../src/review.js';
import type { ReviewRound } from '../src/review.js';

/**
 * `resolvedBy: 'operator'` means THE OPERATOR ANSWERED — they pressed the button that sent the
 * rework back. It has never meant the reviewer accepted anything, and treating
 * it as "this round is done" is how #4344 walked to Gate E with two standing
 * CHANGES_REQUESTED reviews on PR #4535.
 *
 * Gate E now refuses that handover on GitHub's own verdict (see handover.ts), so
 * the dangerous half is already closed. This is the other half: the round should
 * not simply VANISH from the card when they answer it. "Sent back, waiting on the
 * reviewer" is a real state and they should be able to see it, rather than the
 * console going quiet and looking finished.
 */
const answered = (): ReviewRound => ({
  round: 1,
  reviewer: 'pr-swarm',
  requestedAt: '2026-08-12T23:27:32Z',
  requestedChanges: 'fix the thing',
  decision: 'go and fix it',
  resumedAt: '2026-08-13T00:10:00Z',
  resolvedBy: 'operator',
  resolvedAt: '2026-08-13T00:10:00Z',
  resolution: 'you started the rework from the console',
});

describe('the ROW carries it — the wiring, not just the function', () => {
  it('reads the full round history, not the actionable block', () => {
    // The bug this pins: the row was built with `reviewBlock?.rounds ?? []`.
    // reviewBlock is the ACTIONABLE block and is null the moment the operator answers a
    // round — which is the only case reviewOutstanding exists for. So it was
    // wired to the one collection guaranteed to be empty when it mattered, and
    // shipped inert. Every unit test below passed the entire time, because they
    // tested the function and nobody tested that anything called it with real data.
    const src = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');
    expect(src).toContain('reviewOutstanding(reviewHistory');
    expect(src).not.toContain('reviewOutstanding(reviewBlock');
  });
});

describe('a round the operator answered is not a review the reviewer cleared', () => {
  it('stays OUTSTANDING while the reviewer still requests changes — the #4344 case', () => {
    const out = reviewOutstanding([answered()], { reviewDecision: 'CHANGES_REQUESTED', changesRequested: true });
    expect(out).not.toBeNull();
    expect(out!.reviewer).toBe('pr-swarm');
    expect(out!.why).toContain('has not cleared');
  });

  it('stays OUTSTANDING on the label alone, even once the decision moved on', () => {
    expect(reviewOutstanding([answered()], { reviewDecision: 'REVIEW_REQUIRED', changesRequested: true })).not.toBeNull();
  });

  it('CLEARS once the reviewer approves — only the reviewer can do that', () => {
    expect(reviewOutstanding([answered()], { reviewDecision: 'APPROVED', changesRequested: false })).toBeNull();
  });

  it('is null when no round was ever answered — nothing was sent back', () => {
    expect(reviewOutstanding([], { reviewDecision: 'CHANGES_REQUESTED', changesRequested: true })).toBeNull();
  });

  it('does not fire on a round still waiting on THE OPERATOR — that is the gate card’s job, not this', () => {
    const waiting = { ...answered(), decision: null, resolvedBy: null, resolvedAt: null };
    expect(reviewOutstanding([waiting], { reviewDecision: 'CHANGES_REQUESTED', changesRequested: true })).toBeNull();
  });

  it('says nothing when GitHub could not be read — an unread field invents no state', () => {
    expect(reviewOutstanding([answered()], { reviewDecision: null, changesRequested: false })).toBeNull();
  });
});
