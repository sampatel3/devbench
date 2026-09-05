/**
 * The closing keyword is the only thing separating a fold-in from a mention, and
 * both live in the same PR body a few lines apart.
 *
 * Both strings here are lifted from the real PRs: #4535 opens `Closes #4562.`
 * and mentions #4562 nine more times in prose; #5006 opens `Closes #5000.` and
 * names #5002 three times, each one saying it did NOT do that work.
 */
import { describe, it, expect } from 'vitest';
import { closesIssues } from '../src/closes.js';

describe('what a PR says it closes', () => {
  it('reads the declaration and ignores the prose around it — PR #4535', () => {
    const body = [
      'Closes #4562.',
      '',
      '| `...surplusLinesPricingWriter.ts:141` | **FIXED HERE (#4562)** — was the one real gap |',
      'booking sheet, and drive the #4562 tax recompute off a $0 base.',
    ].join('\n');
    expect(closesIssues(body)).toEqual([4562]);
  });

  it('does not adopt an issue a PR only mentions — PR #5006 and #5002', () => {
    const body = [
      'Closes #5000.',
      '',
      '- **The `LIM-*` band precedence** — #5002, filed with its own measured exposure.',
      '| same precedence | **Different consumer** and **already tracked as #5002** |',
    ].join('\n');
    expect(closesIssues(body)).toEqual([5000]);
    expect(closesIssues(body)).not.toContain(5002);
  });

  it('takes every keyword GitHub takes, in any case, and each issue once', () => {
    expect(closesIssues('fixes #1, resolved #2 and Close #3')).toEqual([1, 2, 3]);
    expect(closesIssues('Fixed: #7')).toEqual([7]);
    expect(closesIssues('Closes #9. Also closes #9.')).toEqual([9]);
  });

  it('is empty for a body with no declaration at all', () => {
    expect(closesIssues('Related to #4502. Fixed by #5006.')).toEqual([]);
    expect(closesIssues('')).toEqual([]);
    expect(closesIssues(null)).toEqual([]);
  });
});
