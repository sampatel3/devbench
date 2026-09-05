import { describe, it, expect } from 'vitest';
import { detectChangeRequest } from '../src/review.js';

/**
 * detectChangeRequest is the read-only signal behind the rework loop: the newest
 * review that REQUESTS CHANGES, after a cutoff, by someone other than the operator (so bot
 * reviewers count). It writes nothing — it only decides whether there is a fresh
 * change-request to surface.
 */
describe('detectChangeRequest — a change-request after the cutoff, by someone else', () => {
  const since = '2026-08-11T10:00:00Z';
  const me = 'operator';

  const review = (login: string, state: string, submittedAt: string, body = '') => ({
    author: { login },
    state,
    submittedAt,
    body,
  });

  it('finds a CHANGES_REQUESTED review that lands after the cutoff', () => {
    const cr = detectChangeRequest(
      [review('pr-swarm[bot]', 'CHANGES_REQUESTED', '2026-08-11T11:30:00Z', 'Tighten the null check')],
      since,
      me,
    );
    expect(cr).not.toBeNull();
    expect(cr!.reviewer).toBe('pr-swarm[bot]');
    expect(cr!.body).toBe('Tighten the null check');
  });

  it('ignores APPROVED and COMMENTED reviews — only changes-requested is rework', () => {
    expect(
      detectChangeRequest(
        [review('someone', 'APPROVED', '2026-08-11T12:00:00Z'), review('other', 'COMMENTED', '2026-08-11T12:30:00Z')],
        since,
        me,
      ),
    ).toBeNull();
  });

  it('ignores a change-request from before the cutoff', () => {
    expect(
      detectChangeRequest([review('bot', 'CHANGES_REQUESTED', '2026-08-10T09:00:00Z', 'old')], since, me),
    ).toBeNull();
  });

  it('ignores the operator’s own change-requests — those are not the reviewer we wait on', () => {
    expect(
      detectChangeRequest([review('operator', 'CHANGES_REQUESTED', '2026-08-11T13:00:00Z', 'note to self')], since, me),
    ).toBeNull();
  });

  it('returns the NEWEST qualifying change-request when several land', () => {
    const cr = detectChangeRequest(
      [
        review('bot', 'CHANGES_REQUESTED', '2026-08-11T11:00:00Z', 'first'),
        review('bot', 'CHANGES_REQUESTED', '2026-08-11T12:00:00Z', 'second'),
      ],
      since,
      me,
    );
    expect(cr!.body).toBe('second');
  });

  it('treats a review exactly at the cutoff as not-after', () => {
    expect(detectChangeRequest([review('bot', 'CHANGES_REQUESTED', since, 'same instant')], since, me)).toBeNull();
  });

  it('is null when there are no reviews', () => {
    expect(detectChangeRequest([], since, me)).toBeNull();
  });

  it('a reviewer who later approved (latest state APPROVED) does not read as requesting changes', () => {
    // The caller passes latestReviews — the latest review per reviewer — so a
    // superseded CHANGES_REQUESTED never surfaces once that reviewer approves.
    expect(
      detectChangeRequest([review('bot', 'APPROVED', '2026-08-11T14:00:00Z', 'looks good now')], since, me),
    ).toBeNull();
  });
});
