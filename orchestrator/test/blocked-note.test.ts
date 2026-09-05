import { describe, it, expect } from 'vitest';
import { parseBlockedNote } from '../src/gh.js';

/**
 * #5674's real timeline, trimmed to the events that matter and with the logins
 * neutralised. The shape is GitHub's: a `labeled` event carries `actor` and
 * `label`, a `commented` event carries `user` and `body`, and both are in one
 * chronological list — which is why one read answers the question.
 *
 * Note the two seconds between the label and the comment explaining it. That is
 * the normal case, and it is the one the console could not see.
 */
const TIMELINE = JSON.stringify([
  { event: 'labeled', label: { name: 'bug' }, actor: { login: 'dev-dave' }, created_at: '2026-09-03T13:47:30Z' },
  { event: 'labeled', label: { name: 'P1' }, actor: { login: 'dev-dave' }, created_at: '2026-09-03T13:47:30Z' },
  {
    event: 'commented',
    user: { login: 'dev-carol' },
    created_at: '2026-09-03T19:45:13Z',
    body: '## Investigated while shipping #5676 (PR #5721) — this is already fixed on `dev`',
  },
  {
    event: 'labeled',
    label: { name: 'blocked' },
    actor: { login: 'dev-carol' },
    created_at: '2026-09-04T00:53:05Z',
  },
  {
    event: 'commented',
    user: { login: 'dev-carol' },
    created_at: '2026-09-04T00:53:07Z',
    body: 'Labelled `blocked`, same reason as #5673. Unblocks when the fix reaches `main`.',
  },
  {
    event: 'commented',
    user: { login: 'operator' },
    created_at: '2026-09-04T01:01:48Z',
    body: '**The guard this issue asks for already exists on `dev`.**',
  },
]);

describe('parseBlockedNote', () => {
  it('takes the comment the LABELLER left, nearest the moment they labelled it', () => {
    expect(parseBlockedNote(TIMELINE)).toEqual({
      by: 'dev-carol',
      at: '2026-09-04T00:53:05Z',
      body: 'Labelled `blocked`, same reason as #5673. Unblocks when the fix reaches `main`.',
    });
  });

  it('ignores comments by anybody else, however recent', () => {
    // The operator's is the last comment on the issue and says the most; it is not
    // the answer to "who blocked this and what are they waiting for".
    expect(parseBlockedNote(TIMELINE)?.body).not.toContain('The guard this issue asks for');
  });

  it('takes a comment written just BEFORE the label — people do it in both orders', () => {
    const before = JSON.stringify([
      { event: 'commented', user: { login: 'dev-dave' }, created_at: '2026-09-04T09:00:00Z', body: 'Waiting on AWS.' },
      { event: 'labeled', label: { name: 'blocked' }, actor: { login: 'dev-dave' }, created_at: '2026-09-04T09:00:20Z' },
    ]);
    expect(parseBlockedNote(before)?.body).toBe('Waiting on AWS.');
  });

  it('answers for the LAST application — a label removed and put back is a new reason', () => {
    const again = JSON.stringify([
      { event: 'labeled', label: { name: 'blocked' }, actor: { login: 'dev-dave' }, created_at: '2026-08-01T09:00:00Z' },
      { event: 'commented', user: { login: 'dev-dave' }, created_at: '2026-08-01T09:00:05Z', body: 'Waiting on AWS.' },
      { event: 'unlabeled', label: { name: 'blocked' }, actor: { login: 'dev-dave' }, created_at: '2026-08-02T09:00:00Z' },
      { event: 'labeled', label: { name: 'blocked' }, actor: { login: 'dev-carol' }, created_at: '2026-09-04T09:00:00Z' },
      { event: 'commented', user: { login: 'dev-carol' }, created_at: '2026-09-04T09:00:05Z', body: 'Waiting on the cut.' },
    ]);
    expect(parseBlockedNote(again)).toMatchObject({ by: 'dev-carol', body: 'Waiting on the cut.' });
  });

  it('is null when the label was applied and never explained', () => {
    const silent = JSON.stringify([
      { event: 'labeled', label: { name: 'blocked' }, actor: { login: 'dev-dave' }, created_at: '2026-09-04T09:00:00Z' },
      { event: 'commented', user: { login: 'dev-carol' }, created_at: '2026-09-04T09:30:00Z', body: 'Any update?' },
    ]);
    expect(parseBlockedNote(silent)).toBeNull();
  });

  it('is null when the label is not there at all', () => {
    expect(parseBlockedNote(JSON.stringify([]))).toBeNull();
    expect(
      parseBlockedNote(
        JSON.stringify([
          { event: 'labeled', label: { name: 'P1' }, actor: { login: 'dev-dave' }, created_at: '2026-09-04T09:00:00Z' },
        ]),
      ),
    ).toBeNull();
  });

  it('is null rather than a guess when the actor is missing', () => {
    const headless = JSON.stringify([
      { event: 'labeled', label: { name: 'blocked' }, created_at: '2026-09-04T09:00:00Z' },
    ]);
    expect(parseBlockedNote(headless)).toBeNull();
  });
});
