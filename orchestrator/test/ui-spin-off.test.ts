/**
 * The decision the operator sees before a related finding becomes another issue.
 *
 * This is the public UI seam: render the real card, without a browser or mocked
 * collaborators, and assert the words and action emphasis a person can see.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DraftedWrites } from '../../ui/src/App.js';
import type { IssueRow } from '../../ui/src/types.js';

function row(recommendation: 'fold' | 'separate' | null): IssueRow {
  return {
    number: 5018,
    url: 'https://github.com/example-org/example-repo/issues/5018',
    spinOffs: [],
    issueRequest: {
      fromIssue: 5018,
      title: 'tech-debt(uw-workbench): remove anonymous RPC grants',
      body: 'Full drafted issue body.',
      labels: ['tech-debt', 'area:uw-workbench'],
      boardLane: 'Ready',
      identifiedHow: 'The Stage 2 ACL sweep found four anonymous EXECUTE grants.',
      relationship: 'The grants sit beside the RPC permissions changed for the base issue.',
      recommendation,
      recommendationWhy:
        recommendation === 'fold'
          ? 'The same permission sweep and verification can cover both changes.'
          : 'The grant removal has a different rollout and verification boundary.',
      why: '',
      fileUrl: 'https://github.com/example-org/example-repo/issues/new',
    },
  } as unknown as IssueRow;
}

const render = (recommendation: 'fold' | 'separate' | null): string =>
  renderToStaticMarkup(createElement(DraftedWrites, { row: row(recommendation) }));

describe('related-issue decision card', () => {
  it('shows how the finding was identified and how it relates to a clickable base issue', () => {
    const html = render('fold');
    expect(html).toContain('Related issue identified');
    expect(html).toContain('Identified while working on');
    expect(html).toContain('Base issue #5018');
    expect(html).toContain('How it was identified');
    expect(html).toContain('Stage 2 ACL sweep found four anonymous EXECUTE grants');
    expect(html).toContain('How it relates to');
    expect(html).toContain('permissions changed for the base issue');
    expect(html).toContain('href="https://github.com/example-org/example-repo/issues/5018"');
  });

  it('makes Fold primary when the worker recommends folding', () => {
    const html = render('fold');
    expect(html).toContain('Worker recommendation');
    expect(html).toContain('Fold into #5018');
    expect(html).toContain('<button class="btn-primary">Fold into #5018</button>');
  });

  it('makes File primary when the worker recommends a separate issue', () => {
    const html = render('separate');
    expect(html).toContain('File separately');
    expect(html).toContain('<button class="btn-primary">File separately</button>');
  });

  it('keeps legacy drafts neutral instead of inventing a recommendation', () => {
    const html = render(null);
    expect(html).toContain('No structured recommendation recorded');
    expect(html).not.toContain('class="btn-primary"');
  });
});
