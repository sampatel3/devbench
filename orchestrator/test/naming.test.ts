import { describe, it, expect } from 'vitest';
import { slugFromTitle, branchNameFor, worktreeDirFor } from '../src/naming.js';

describe('slugFromTitle', () => {
  it('kebab-cases a normal title', () => {
    expect(slugFromTitle('Organizations Sysadmin Filter Pills Bug')).toBe('organizations-sysadmin-filter-pills-bug');
  });

  it('drops punctuation and collapses the gaps it leaves', () => {
    expect(slugFromTitle('Quote Preview: Notice Pills + 100% Default Zoom')).toBe(
      'quote-preview-notice-pills-100-default-zoom',
    );
  });

  it('trims to a sensible length at a word boundary, never mid-word', () => {
    const s = slugFromTitle('Stale version detection and reload banner for every authenticated surface');
    expect(s.length).toBeLessThanOrEqual(48);
    expect(s.endsWith('-')).toBe(false);
    expect(s).toBe('stale-version-detection-and-reload-banner-for');
  });

  it('never starts or ends with a dash', () => {
    expect(slugFromTitle('  --- Weird --- ')).toBe('weird');
  });

  it('falls back to "issue" when a title has nothing usable in it', () => {
    expect(slugFromTitle('!!! ???')).toBe('issue');
    expect(slugFromTitle('')).toBe('issue');
  });
});

describe('branchNameFor', () => {
  it('uses fix/ for a bug', () => {
    expect(branchNameFor({ number: 4336, title: 'Organizations Sysadmin Filter Pills Bug', labels: ['bug', 'env:dev'] })).toBe(
      'fix/issue-4336-organizations-sysadmin-filter-pills-bug',
    );
  });

  it('uses feat/ for a feature', () => {
    expect(
      branchNameFor({ number: 4342, title: 'Quote Preview Notice Pills', labels: ['feature', 'area:quote'] }),
    ).toBe('feat/issue-4342-quote-preview-notice-pills');
  });

  it('defaults to fix/ when the labels say nothing about the type', () => {
    expect(branchNameFor({ number: 1, title: 'Something', labels: ['needs-triage'] })).toBe('fix/issue-1-something');
  });

  it('never produces feature/ — wip-preview ignores that prefix', () => {
    const b = branchNameFor({ number: 9, title: 'x', labels: ['feature'] });
    expect(b.startsWith('feature/')).toBe(false);
    expect(b.startsWith('feat/')).toBe(true);
  });

  it('always embeds the issue number, because board automation parses it', () => {
    expect(branchNameFor({ number: 4329, title: 'Stale Version Detection', labels: [] })).toContain('issue-4329-');
  });

  it('treats enhancement as a feature too', () => {
    expect(branchNameFor({ number: 7, title: 'Nicer thing', labels: ['enhancement'] })).toBe('feat/issue-7-nicer-thing');
  });
});

describe('worktreeDirFor', () => {
  it('is the last path segment of the branch — that is what the repo script does', () => {
    expect(worktreeDirFor('fix/issue-4336-organizations-sysadmin-filter-pills-bug')).toBe(
      'issue-4336-organizations-sysadmin-filter-pills-bug',
    );
  });

  it('produces a directory the worktree scanner can read the issue number back out of', () => {
    const dir = worktreeDirFor(branchNameFor({ number: 4342, title: 'Quote Preview Notice Pills', labels: ['feature'] }));
    expect(dir).toMatch(/^issue-4342-/);
  });
});
