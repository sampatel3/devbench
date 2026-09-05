import { describe, it, expect } from 'vitest';
import { parseChecklist } from '../src/checklist.js';

/**
 * Workers write a "Pre-merge checklist" into the PR body and the console has
 * never looked at it. The operator, reading PR #4535, asked how they were meant
 * to know the status of a checklist the agent wrote and the console tracks
 * nowhere, or what it left them waiting on.
 *
 * A checklist the agent invents and then leaves somewhere nobody watches is
 * worse than none: it looks like tracking. The console fetches the PR body
 * anyway, so the outstanding items are free to read.
 */
describe('the pre-merge checklist, read off the PR body', () => {
  const body = `## What changed

Some prose.

## Pre-merge checklist

- [x] Surplus-lines tax interaction filed as a tracked, owned, laned issue — #4562
- [ ] \`feature_flag_surplus_lines_tax\` checked for Mosaic in **production** before
      they are told they can enable leveling

## Decisions
`;

  it('finds both items and knows which is outstanding — the #4535 case', () => {
    const c = parseChecklist(body);
    expect(c.total).toBe(2);
    expect(c.done).toBe(1);
    expect(c.outstanding).toHaveLength(1);
    expect(c.outstanding[0]).toContain('feature_flag_surplus_lines_tax');
  });

  it('strips the markdown so the console can show it as a line', () => {
    const c = parseChecklist(body);
    // Backticks and bold markers are noise on a card; the words are the point.
    expect(c.outstanding[0]).not.toContain('`');
    expect(c.outstanding[0]).not.toContain('**');
  });

  it('folds a wrapped item into one line rather than losing the tail', () => {
    // The second item wraps across two lines in the real body. Reading only the
    // first line would drop "before they are told they can enable leveling",
    // which is the entire point of the item.
    expect(parseChecklist(body).outstanding[0]).toContain('enable leveling');
  });

  it('accepts the * bullet and odd casing of [X]', () => {
    const c = parseChecklist('* [X] done thing\n* [ ] undone thing\n');
    expect(c.total).toBe(2);
    expect(c.done).toBe(1);
    expect(c.outstanding[0]).toBe('undone thing');
  });

  it('is empty for a body with no checklist — not every PR has one', () => {
    const c = parseChecklist('## What changed\n\nJust prose.\n');
    expect(c.total).toBe(0);
    expect(c.outstanding).toEqual([]);
  });

  it('is empty for a null body rather than throwing', () => {
    expect(parseChecklist(null).total).toBe(0);
  });

  it('ignores a checkbox inside a fenced code block', () => {
    // A PR body that documents markdown, or pastes a template, must not have its
    // example counted as real outstanding work.
    const c = parseChecklist('```\n- [ ] not a real item\n```\n- [ ] a real one\n');
    expect(c.total).toBe(1);
    expect(c.outstanding[0]).toBe('a real one');
  });
});
