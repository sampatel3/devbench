import { describe, it, expect } from 'vitest';
import { openQuestion } from '../src/question.js';
import type { GhActionsComment } from '../src/gh.js';

/**
 * The operator, looking at #4344, asked where the visibility was: the issue had
 * open items — one a comment, one a task — and nothing on the console told them
 * what they had to follow up on.
 *
 * A real question of theirs had been sitting unanswered on that issue for fifteen
 * hours and the console knew nothing about it. `commentBlock` — the only comment
 * tracking there was — has exactly one writer (a worker drafts
 * `.comment-request.json`, the operator clicks Post) and is deleted unconditionally on any
 * resume, so even a question asked THROUGH the console would have been wiped by
 * the next rework. This reads the comments GitHub already sends every poll and
 * asks a narrower question that nothing can erase: is the newest comment on this
 * issue mine, and has nobody answered it?
 *
 * The predicate is deliberately strict. Measured against every thread the operator has
 * commented on in this repo, the loose version fired on five `@claude review`
 * triggers; requiring a question mark and scoping to issues removed all five and
 * left exactly one row — #4344, the right one.
 */
const c = (over: Partial<GhActionsComment> & { login: string }): GhActionsComment => ({
  id: over.id ?? '1',
  author: { login: over.login, typename: over.author?.typename ?? 'User' },
  createdAt: over.createdAt ?? '2026-08-12T22:07:53Z',
  body: over.body ?? 'anything',
  url: over.url ?? 'https://github.com/example-org/example-repo/issues/4344#issuecomment-5273345291',
});

const THE_REAL_ONE = c({
  login: 'operator',
  createdAt: '2026-08-12T22:07:53Z',
  body:
    'Before this merges — could someone with production access check one flag for me?\n\n' +
    '**What to check:** the value of `feature_flag_surplus_lines_tax` for Mosaic.',
});

describe('a question of mine that nobody has answered', () => {
  it('finds it, with when it was asked, its opening line and its link', () => {
    const q = openQuestion([THE_REAL_ONE], 'operator');
    expect(q).not.toBeNull();
    expect(q!.askedAt).toBe('2026-08-12T22:07:53Z');
    expect(q!.firstLine).toBe(
      'Before this merges — could someone with production access check one flag for me?',
    );
    expect(q!.url).toContain('issuecomment-5273345291');
  });

  it('goes quiet once a person replies', () => {
    const reply = c({ id: '2', login: 'reviewer-one', createdAt: '2026-08-13T08:00:00Z', body: 'it is off' });
    expect(openQuestion([THE_REAL_ONE, reply], 'operator')).toBeNull();
  });

  it('a BOT commenting afterwards is not an answer', () => {
    // github-actions and the review bots post constantly on these threads. If a
    // bot counted, the question would vanish the moment CI spoke.
    const bot = c({
      id: '2',
      login: 'github-actions',
      createdAt: '2026-08-13T08:00:00Z',
      body: 'needs-triage applied',
    });
    bot.author.typename = 'Bot';
    expect(openQuestion([THE_REAL_ONE, bot], 'operator')).not.toBeNull();
  });

  it('ignores my own comments that do not ask anything', () => {
    // The five false positives in the real data were all of this shape.
    const trigger = c({ id: '2', login: 'operator', createdAt: '2026-08-13T09:00:00Z', body: '@claude re-review' });
    expect(openQuestion([THE_REAL_ONE, trigger], 'operator')).toBeNull();
  });

  it('says nothing when the newest comment is somebody else’s', () => {
    const theirs = c({ id: '2', login: 'reviewer-one', createdAt: '2026-08-13T09:00:00Z', body: 'any update?' });
    expect(openQuestion([THE_REAL_ONE, theirs], 'operator')).toBeNull();
  });

  it('handles an empty thread', () => {
    expect(openQuestion([], 'operator')).toBeNull();
  });

  it('matches my login whatever its case', () => {
    expect(openQuestion([c({ ...THE_REAL_ONE, login: 'Operator' })], 'operator')).not.toBeNull();
  });

  it('reads the NEWEST comment, not the last one in the array', () => {
    // GitHub returns them in order today. Depending on that is how a predicate
    // quietly starts answering a different question than the one it documents.
    const older = c({ id: '9', login: 'reviewer-one', createdAt: '2026-08-01T00:00:00Z', body: 'thoughts?' });
    expect(openQuestion([THE_REAL_ONE, older], 'operator')).not.toBeNull();
  });
});
