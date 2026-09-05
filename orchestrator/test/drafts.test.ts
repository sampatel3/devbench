import { describe, it, expect } from 'vitest';
import { parseIssueRequest, parseBoardRequest, newIssueUrl, boardUrl } from '../src/drafts.js';

/**
 * The two writes a worker is now fenced out of, given a way back to the operator.
 *
 * The fence denies `gh issue create` and every board move. That is right — an
 * issue a worker files is stamped with the operator's name by the repo's
 * autoassign workflow and lands in their queue looking like work the team asked
 * for, which is exactly what happened with example-repo#4562. But a denial with
 * no path forward just costs a round trip, which is the other half of the
 * problem.
 *
 * So the worker drafts, and the console turns the draft into ONE CLICK. The
 * console still writes nothing: `newIssueUrl` opens GitHub's own new-issue form
 * with everything filled in, and the operator presses Submit there. gh.ts stays
 * read-only and comment.ts stays the only writer.
 */
describe('.issue-request.json — a spin-off the operator can file in one click', () => {
  const good = JSON.stringify({
    fromIssue: 4336,
    title: 'Rating engine ignores tenant overrides',
    labels: ['bug', 'area:rating'],
    boardLane: 'Ready',
    identifiedHow: 'The sibling sweep found the same unchecked override path in the rating worker.',
    relationship: 'It shares the base issue\'s override lookup but fails in a separate service.',
    recommendation: 'separate',
    recommendationWhy: 'The worker change needs its own migration and rollout.',
    draftBody: 'Full body.\n\nFound while fixing #4336.',
    sessionId: 'sess-1',
  });

  it('parses a complete draft', () => {
    const r = parseIssueRequest(good)!;
    expect(r.title).toBe('Rating engine ignores tenant overrides');
    expect(r.labels).toEqual(['bug', 'area:rating']);
    expect(r.body).toContain('Found while fixing #4336.');
    expect(r.fromIssue).toBe(4336);
    expect(r.identifiedHow).toContain('sibling sweep');
    expect(r.relationship).toContain('override lookup');
    expect(r.recommendation).toBe('separate');
    expect(r.recommendationWhy).toContain('migration and rollout');
  });

  it('keeps an older draft neutral instead of inventing a file recommendation', () => {
    const r = parseIssueRequest(
      JSON.stringify({ title: 'Legacy finding', draftBody: 'Full body.', why: 'Old separate-issue rationale.' }),
    )!;
    expect(r.recommendation).toBeNull();
    expect(r.identifiedHow).toBe('');
    expect(r.relationship).toBe('');
    expect(r.recommendationWhy).toBe('Old separate-issue rationale.');
  });

  it('keeps an unknown recommendation neutral rather than guessing an action', () => {
    const r = parseIssueRequest(
      JSON.stringify({ title: 'Finding', draftBody: 'Full body.', recommendation: 'later' }),
    )!;
    expect(r.recommendation).toBeNull();
  });

  it('preserves an explicit fold recommendation', () => {
    const r = parseIssueRequest(
      JSON.stringify({
        title: 'Related finding',
        draftBody: 'Full body.',
        recommendation: 'fold',
        recommendationWhy: 'The same fix and verification cover both findings.',
      }),
    )!;
    expect(r.recommendation).toBe('fold');
    expect(r.recommendationWhy).toContain('same fix and verification');
  });

  it('refuses a draft with no title or no body — there is nothing to file', () => {
    expect(parseIssueRequest(JSON.stringify({ title: '', draftBody: 'x' }))).toBeNull();
    expect(parseIssueRequest(JSON.stringify({ title: 'x', draftBody: '  ' }))).toBeNull();
    expect(parseIssueRequest('{not json')).toBeNull();
  });

  it('drops non-string labels rather than rendering rubbish into the URL', () => {
    const r = parseIssueRequest(JSON.stringify({ title: 't', draftBody: 'b', labels: ['ok', 3, null] }))!;
    expect(r.labels).toEqual(['ok']);
  });

  it('builds a prefilled GitHub new-issue URL — the console files nothing itself', () => {
    const url = newIssueUrl('example-org/example-repo', parseIssueRequest(good)!);
    expect(url.startsWith('https://github.com/example-org/example-repo/issues/new?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('title')).toBe('Rating engine ignores tenant overrides');
    expect(q.get('body')).toContain('Found while fixing #4336.');
    expect(q.get('body')).toContain('Spun off from #4336.');
    expect(q.get('body')).toContain('**How it was identified:** The sibling sweep found');
    expect(q.get('body')).toContain('**Worker recommendation:** File separately.');
    expect(q.get('labels')).toBe('bug,area:rating');
  });

  it('keeps the URL short enough for GitHub to accept, and says so when it trims', () => {
    const huge = JSON.stringify({ title: 't', draftBody: 'x'.repeat(9000) });
    const url = newIssueUrl('example-org/example-repo', parseIssueRequest(huge)!);
    expect(url.length).toBeLessThan(8000);
    // A silently truncated body would be worse than a link that admits it.
    expect(new URL(url).searchParams.get('body')).toContain('.issue-request.json');
  });
});

describe('.board-request.json — a card move the operator can make in one click', () => {
  it('parses a complete draft', () => {
    const r = parseBoardRequest(
      JSON.stringify({ issue: 4336, lane: 'QA', currentLane: 'In progress', why: 'merged', sessionId: null }),
    )!;
    expect(r.lane).toBe('QA');
    expect(r.currentLane).toBe('In progress');
  });

  it('refuses a draft that does not name an issue and a lane', () => {
    expect(parseBoardRequest(JSON.stringify({ lane: 'QA' }))).toBeNull();
    expect(parseBoardRequest(JSON.stringify({ issue: 4336, lane: '' }))).toBeNull();
  });

  it('keeps an unreadable current lane as null instead of inventing one', () => {
    const r = parseBoardRequest(JSON.stringify({ issue: 1, lane: 'QA', currentLane: 'unknown' }))!;
    expect(r.currentLane).toBeNull();
  });

  it('points at the board, which is where the move is actually made', () => {
    expect(boardUrl('example-org', 3)).toBe('https://github.com/orgs/example-org/projects/3');
  });

  it('points at the org project list when no board is configured, rather than inventing a number', () => {
    expect(boardUrl('example-org', null)).toBe('https://github.com/orgs/example-org/projects');
  });
});
