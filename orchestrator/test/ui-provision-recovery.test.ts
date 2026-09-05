import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProvisionFailure, RecoveryConfirmation } from '../../ui/src/App.js';
import type { ContinuationPlan, IssueRow } from '../../ui/src/types.js';

function row(code: 'branch-exists' | null): IssueRow {
  return {
    number: 5015,
    provision: {
      phase: 'failed',
      branch: 'fix/issue-5015-existing-work',
      worktreePath: '/repo/.worktrees/issue-5015-existing-work',
      port: 8083,
      startedAt: '2026-08-25T07:20:58.230Z',
      error:
        code === 'branch-exists'
          ? 'refusing: branch fix/issue-5015-existing-work already exists.'
          : 'scaffolding the new worktree failed: permission denied',
      code,
      logTail: [],
    },
  } as unknown as IssueRow;
}

const render = (code: 'branch-exists' | null): string =>
  renderToStaticMarkup(createElement(ProvisionFailure, { row: row(code), onDone: () => {} }));

describe('failed worktree recovery card', () => {
  it('offers to restore the exact existing branch without resetting it', () => {
    const html = render('branch-exists');
    expect(html).toContain('Continue from the existing branch');
    expect(html).toContain('fix/issue-5015-existing-work');
    expect(html).toContain('/repo/.worktrees/issue-5015-existing-work');
    expect(html).toMatch(/not (?:be )?reset|without resetting/);
    expect(html).toContain('Review the recovery');
    expect(html).not.toContain('git worktree add');
  });

  it('shows the exact head, command and cancel action before writing', () => {
    const plan: ContinuationPlan = {
      issue: 5015,
      title: 'Existing work',
      branch: 'fix/issue-5015-existing-work',
      worktreePath: '/repo/.worktrees/issue-5015-existing-work',
      port: 8083,
      head: '24ad5071e16c1b82006306c6d12041b3a1ce6a31',
      mode: 'restore',
      commands: [
        'cd /repo',
        'git worktree add /repo/.worktrees/issue-5015-existing-work fix/issue-5015-existing-work',
      ],
    };
    const html = renderToStaticMarkup(
      createElement(RecoveryConfirmation, { plan, busy: false, onConfirm: () => {}, onCancel: () => {} }),
    );
    expect(html).toContain(plan.head);
    expect(html).toContain('git worktree add');
    expect(html).toContain('Yes, restore this worktree');
    expect(html).toContain('Cancel');
    expect(html).toContain('will not be reset');
    expect(html).toContain('supabase/');
    expect(html).toContain('.env');
    expect(html).toContain('supabase/.env.local');
    expect(html).toContain('.issue-state.md');
    expect(html).toContain('Existing entries are preserved');
  });

  it('does not offer branch recovery for a scaffolding failure', () => {
    const html = render(null);
    expect(html).toContain('permission denied');
    expect(html).not.toContain('Restore this worktree');
  });
});
