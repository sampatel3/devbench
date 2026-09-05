/**
 * Issues the operator RAISED but has not been assigned.
 *
 * The console listed `--assignee me` and nothing else, so a spin-off filed out
 * of an issue already in flight sat on GitHub invisible to the tool it was filed
 * from — #4914, authored by `operator`, `assignees: []`, never appeared. The
 * repo's own filing rules make this the normal case, not an edge one: the
 * autoassign workflow only assigns engineers on its allowlist, and never on any
 * event but `opened`.
 *
 * `selfFiled` was already derived from the author, so the row renders correctly
 * the moment the issue is in the list at all. The bug was purely the query.
 */
import { describe, it, expect } from 'vitest';
import { dedupeIssueLists } from '../src/gh.js';

const issue = (number: number, author: string) => ({
  number,
  title: `issue ${number}`,
  url: `https://github.com/example-org/example-repo/issues/${number}`,
  updatedAt: '2026-08-19T00:00:00Z',
  labels: [],
  author,
  spunOffFrom: null,
});

describe('the issue list covers assigned AND authored', () => {
  it('includes an issue the operator raised but was never assigned — the #4914 case', () => {
    const merged = dedupeIssueLists([issue(4619, 'reviewer-two')], [issue(4914, 'operator')]);
    expect(merged.map((i) => i.number).sort()).toEqual([4619, 4914]);
  });

  /** Assigned AND authored is one row, not two. */
  it('deduplicates by issue number', () => {
    const merged = dedupeIssueLists([issue(4562, 'operator')], [issue(4562, 'operator'), issue(4914, 'operator')]);
    expect(merged.map((i) => i.number).sort()).toEqual([4562, 4914]);
  });

  /** The assigned copy wins: it is the one the console already reasoned about,
   *  and a duplicate must never replace it with a differently-shaped record. */
  it('keeps the assigned copy when both lists carry the issue', () => {
    const assigned = { ...issue(4562, 'operator'), title: 'from the assigned call' };
    const authored = { ...issue(4562, 'operator'), title: 'from the authored call' };
    expect(dedupeIssueLists([assigned], [authored])[0]?.title).toBe('from the assigned call');
  });

  it('handles either list being empty', () => {
    expect(dedupeIssueLists([], [issue(4914, 'operator')])).toHaveLength(1);
    expect(dedupeIssueLists([issue(4619, 'x')], [])).toHaveLength(1);
    expect(dedupeIssueLists([], [])).toEqual([]);
  });
});
