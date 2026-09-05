/**
 * Finding one ticket in a rail of fourteen.
 *
 * The operator could not always find what they were looking for — and the two
 * numbers they actually hold in their head are the issue number and the PR
 * number. A PR
 * number was not on the rail at all and matched nothing, so the only way to get
 * from "PR #4623" to its row was to remember it was #4619.
 */
import { describe, it, expect } from 'vitest';
import { matchesQuery } from '../../ui/src/search.js';

const row = (number: number, title: string, pr: number | null) => ({
  number,
  title,
  pr: pr === null ? null : { number: pr },
});

const R4619 = row(4619, 'Coverage Table alignment off when multiple columns present', 4623);
const R4562 = row(4562, 'fix(rating): surplus-lines taxable base uses the per-option admin fee', null);

describe('rail search', () => {
  it('an empty query matches everything — the rail is not filtered until they type', () => {
    expect(matchesQuery(R4619, '')).toBe(true);
    expect(matchesQuery(R4619, '   ')).toBe(true);
  });

  it('finds a row by its ISSUE number, with or without the hash', () => {
    expect(matchesQuery(R4619, '4619')).toBe(true);
    expect(matchesQuery(R4619, '#4619')).toBe(true);
    expect(matchesQuery(R4562, '4619')).toBe(false);
  });

  /** The one that did not work at all before. */
  it('finds a row by its PR number, with or without the PR prefix', () => {
    expect(matchesQuery(R4619, '4623')).toBe(true);
    expect(matchesQuery(R4619, 'PR #4623')).toBe(true);
    expect(matchesQuery(R4619, 'pr4623')).toBe(true);
    expect(matchesQuery(R4562, '4623')).toBe(false);
  });

  it('falls back to the title, case-insensitively', () => {
    expect(matchesQuery(R4619, 'coverage table')).toBe(true);
    expect(matchesQuery(R4619, 'COVERAGE')).toBe(true);
    expect(matchesQuery(R4562, 'surplus-lines')).toBe(true);
    expect(matchesQuery(R4562, 'coverage table')).toBe(false);
  });

  /**
   * A number query is matched as a WHOLE number, not a substring: typing 619
   * must not drag in 4619, or the search is noisier than the list it filters.
   */
  it('matches numbers whole, so 619 is not 4619', () => {
    expect(matchesQuery(R4619, '619')).toBe(false);
    expect(matchesQuery(R4619, '461')).toBe(false);
  });

  it('a row with no PR is simply not matched by a PR-shaped query', () => {
    expect(matchesQuery(R4562, 'PR #4623')).toBe(false);
  });
});
