import { describe, it, expect } from 'vitest';
import { buildSummary, waitingOnAPerson, windowStart, isSummaryWindow, type OpenPr } from '../src/summary.js';
import type { IssueRow } from '../src/types.js';

/**
 * The status summary is a formatter, so it is tested as one: data in, the exact
 * post the operator pastes into Slack out. The two rules that matter are the ordering
 * ("Waiting on a person" leads, because it is the part somebody has to act on)
 * and the honesty rule (a section we could not READ says so; a section with
 * nothing in it is left out).
 */

const NOW = '2026-08-11T12:30:00Z';

/** A console row with everything switched off; each test turns on what it needs. */
function row(over: Partial<IssueRow>): IssueRow {
  return {
    number: 4336,
    title: 'Organizations Sysadmin Filter Pills Bug',
    url: 'https://github.com/example-org/example-repo/issues/4336',
    labels: [],
    updatedAt: NOW,
    author: 'qa-bob',
    selfFiled: false,
    worktree: null,
    branch: null,
    port: null,
    stage: null,
    gatesPassed: [],
    gate: null,
    gateSource: null,
    gateReport: null,
    gateEvidence: [],
    history: [],
    commentRequest: null,
    commentBlock: null,
    reviewBlock: null,
    reviewHistory: [],
    sessionId: null,
    resumeCommand: null,
    account: null,
    accountLocked: false,
    status: 'checkpoint',
    statusDetail: '',
    queuePosition: null,
    pr: null,
    live: null,
    lastError: null,
    lastActivityAt: null,
    provision: null,
    ...over,
  };
}

function openPr(over: Partial<OpenPr> = {}): OpenPr {
  return {
    number: 4446,
    title: 'fix(orgs): system-admin Organizations filter pills return the right orgs (#4336)',
    url: 'https://github.com/example-org/example-repo/pull/4446',
    headRefName: 'fix/issue-4336-org-sysadmin-filter-pills',
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    labels: ['human-review-needed'],
    checks: [{ status: 'COMPLETED', conclusion: 'SUCCESS', state: '' }],
    ...over,
  };
}

const EMPTY = {
  window: 'weekly' as const,
  generatedAt: NOW,
  rows: [] as IssueRow[],
  openIssues: [] as Array<{ number: number; title: string }>,
  closedIssues: { items: [], error: null },
  mergedPrs: { items: [], error: null },
  openPrs: { items: [], error: null },
};

describe('the window', () => {
  it('accepts only the three windows', () => {
    expect(isSummaryWindow('daily')).toBe(true);
    expect(isSummaryWindow('weekly')).toBe(true);
    expect(isSummaryWindow('monthly')).toBe(true);
    expect(isSummaryWindow('yearly')).toBe(false);
    expect(isSummaryWindow(undefined)).toBe(false);
  });

  it('counts back from now: 1, 7 and 30 days', () => {
    expect(windowStart('daily', NOW)).toBe('2026-08-10T12:30:00.000Z');
    expect(windowStart('weekly', NOW)).toBe('2026-08-04T12:30:00.000Z');
    expect(windowStart('monthly', NOW)).toBe('2026-07-12T12:30:00.000Z');
  });

  it('names the window and the moment in the header line', () => {
    expect(buildSummary({ ...EMPTY, window: 'weekly' }).markdown).toContain('Status — last 7 days (11 Aug 2026');
    expect(buildSummary({ ...EMPTY, window: 'daily' }).markdown).toContain('Status — last 24 hours (11 Aug 2026');
    expect(buildSummary({ ...EMPTY, window: 'monthly' }).markdown).toContain('Status — last 30 days (11 Aug 2026');
  });
});

describe('section ordering', () => {
  it('puts "Waiting on a person" first when it has anything in it', () => {
    const out = buildSummary({
      ...EMPTY,
      rows: [
        row({ number: 4400, title: 'Nothing started', status: 'no-worker' }),
        row({
          number: 4336,
          status: 'at-gate',
          gate: {
            issue: 4336,
            gate: 'C',
            stage: 5,
            sessionId: null,
            stoppedAt: null,
            reportPath: null,
            summary: '',
            questions: [],
          },
        }),
      ],
      closedIssues: { items: [{ number: 4103, title: 'STP Auto-Send Quote Resend Bug', closedAt: NOW }], error: null },
    });
    expect(out.sections.map((s) => s.heading)).toEqual([
      'Waiting on a person',
      'Issues Closed',
      'No worker / not started',
    ]);
    expect(out.markdown.indexOf('Waiting on a person')).toBeLessThan(out.markdown.indexOf('Issues Closed'));
  });

  it('skips every empty section, and says so when there is nothing at all', () => {
    const out = buildSummary(EMPTY);
    expect(out.sections).toEqual([]);
    expect(out.markdown).toContain('Nothing to report in this window.');
    expect(out.markdown).not.toContain('Issues Closed');
  });
});

describe('waiting on a person — one line per reason', () => {
  const reasonFor = (r: IssueRow, prs: OpenPr[] = []) => waitingOnAPerson([r], prs)[0]?.reason ?? null;

  it('a worker stopped at a gate is waiting on you, and says which gate', () => {
    const reason = reasonFor(
      row({
        status: 'at-gate',
        gate: {
          issue: 4336,
          gate: 'C',
          stage: 5,
          sessionId: null,
          stoppedAt: null,
          reportPath: null,
          summary: '',
          questions: [],
        },
      }),
    );
    expect(reason).toBe('waiting on you — gate C (QA + comprehension)');
  });

  it('an actionable rework round names the reviewer and links the PR', () => {
    const reason = reasonFor(
      row({
        status: 'rework',
        pr: {
          number: 4368,
          url: 'https://github.com/example-org/example-repo/pull/4368',
          state: 'OPEN',
          title: 't',
          isDraft: false,
        },
        reviewBlock: {
          pr: 4368,
          rounds: [
            {
              round: 1,
              reviewer: 'pr-swarm[bot]',
              requestedAt: NOW,
              requestedChanges: 'handle the empty array',
              decision: null,
              resumedAt: null,
            },
          ],
        },
      }),
    );
    expect(reason).toBe(
      'changes requested by pr-swarm[bot] — rework not started — https://github.com/example-org/example-repo/pull/4368',
    );
  });

  it('an open PR nobody has approved is a codeowner’s turn', () => {
    const reason = reasonFor(row({ number: 4336, status: 'pr-open' }), [openPr()]);
    expect(reason).toBe('awaiting approving review (codeowner) — https://github.com/example-org/example-repo/pull/4446');
  });

  it('a DRAFT PR is waiting on you, not on a codeowner', () => {
    // This section gets pasted into Slack. Filed under "awaiting approving
    // review (codeowner)", #4375 and #5269 read as work the team owed them, week
    // after week, while GitHub had asked nobody and never would.
    const reason = reasonFor(row({ number: 4336, status: 'pr-open' }), [openPr({ isDraft: true })]);
    expect(reason).toBe(
      'waiting on you — PR #4446 is still a draft, so nobody can review it — https://github.com/example-org/example-repo/pull/4446',
    );
  });

  it('a draft that is APPROVED is still waiting on you', () => {
    // Approval does not merge a draft, and the approved-PR exit below must not
    // swallow the one thing that has to happen first.
    const reason = reasonFor(row({ number: 4336, status: 'pr-open' }), [
      openPr({ isDraft: true, reviewDecision: 'APPROVED', labels: [] }),
    ]);
    expect(reason).toContain('still a draft');
  });

  it('an approved PR with no label is nobody’s turn any more', () => {
    expect(reasonFor(row({ number: 4336, status: 'pr-open' }), [openPr({ reviewDecision: 'APPROVED', labels: [] })])).toBeNull();
  });

  it('a posted comment with no reply is blocked on its addressee', () => {
    const reason = reasonFor(
      row({
        status: 'blocked',
        commentBlock: { addressee: 'teammate-one', postedAt: NOW, commentUrl: null, reply: null },
      }),
    );
    expect(reason).toBe('blocked — awaiting reply from teammate-one');
  });

  it('a session taken over in a terminal says so', () => {
    expect(reasonFor(row({ status: 'detached' }))).toBe('taken over in a terminal');
  });

  it('a quiet checkpoint with no PR is waiting on nobody', () => {
    expect(reasonFor(row({ status: 'checkpoint' }))).toBeNull();
  });

  it('a running worker is the machine’s turn, PR or no PR', () => {
    expect(reasonFor(row({ number: 4336, status: 'active' }), [openPr()])).toBeNull();
  });
});

describe('the house format', () => {
  const built = () =>
    buildSummary({
      ...EMPTY,
      rows: [row({ number: 4405, title: 'Organizations search is scoped within the pill', status: 'no-worker' })],
      openIssues: [{ number: 4342, title: 'Quote Preview Notice Pills + 100% Default Zoom' }],
      closedIssues: {
        items: [
          { number: 4088, title: 'New-business submissions misclassified as "Renewal"', closedAt: NOW },
          { number: 4103, title: 'STP Auto-Send Quote Resend Bug', closedAt: NOW },
        ],
        error: null,
      },
      mergedPrs: {
        items: [
          {
            number: 4296,
            title: 'reconcile application_form_coverages with coverage assignments',
            url: 'https://github.com/example-org/example-repo/pull/4296',
            mergedAt: NOW,
            headRefName: 'fix/issue-4342-quote-preview-notice-pills',
          },
        ],
        error: null,
      },
      openPrs: { items: [openPr()], error: null },
    });

  it('bullets with •, an em-dash between the parts, and a bare URL at the end', () => {
    const md = built().markdown;
    expect(md).toContain(
      '• #4296 — reconcile application_form_coverages with coverage assignments (#4342) — https://github.com/example-org/example-repo/pull/4296',
    );
    expect(md).toContain('• #4103 — STP Auto-Send Quote Resend Bug');
  });

  it('cites the issue a PR closes, and does not cite it twice when the title already does', () => {
    const md = built().markdown;
    // The merged PR's title does not name its issue, so `(#4342)` is added.
    expect(md).toContain('coverage assignments (#4342)');
    // The open PR's title already ends in (#4336), so nothing is appended.
    expect(md).toContain('the right orgs (#4336) — awaiting a human reviewer, CI green');
    expect(md).not.toContain('(#4336) (#4336)');
  });

  it('an issue whose PR merged but which is still open lands in QA limbo', () => {
    const section = built().sections.find((s) => s.heading === 'In QA (awaiting verification, open)');
    expect(section?.items).toEqual(['#4342 — Quote Preview Notice Pills + 100% Default Zoom']);
  });

  it('lists newest first, and never drops an issue with no worker', () => {
    const out = built();
    expect(out.sections.find((s) => s.heading === 'Issues Closed')?.items[0]).toContain('#4103');
    expect(out.sections.find((s) => s.heading === 'No worker / not started')?.items).toEqual([
      '#4405 — Organizations search is scoped within the pill',
    ]);
  });
});

describe('nothing assigned falls out of the post', () => {
  const headings = (rows: IssueRow[]) => buildSummary({ ...EMPTY, rows }).sections.map((s) => s.heading);
  const inProgress = (rows: IssueRow[]) =>
    buildSummary({ ...EMPTY, rows }).sections.find((s) => s.heading === 'In progress')?.items ?? [];

  it('a stalled worktree — checkpoint or failed — is in progress, not missing', () => {
    const items = inProgress([
      row({ number: 4334, title: 'Save & Exit', status: 'checkpoint', statusDetail: 'stopped after stage 0', stage: 0 }),
      row({ number: 4329, title: 'Quote zoom', status: 'failed', statusDetail: 'npm install failed with code 1', stage: 2 }),
    ]);
    expect(items).toEqual([
      '#4334 — Save & Exit — stopped after stage 0',
      '#4329 — Quote zoom — npm install failed with code 1 — stage 2',
    ]);
  });

  it('a status nobody has thought of yet still comes out somewhere', () => {
    const novel = row({ number: 4501, title: 'Something new', status: 'hibernating' as IssueRow['status'], statusDetail: 'parked by a future feature' });
    const out = buildSummary({ ...EMPTY, rows: [novel] });
    expect(out.markdown).toContain('#4501');
    expect(out.sections.find((s) => s.items.some((i) => i.includes('#4501')))?.heading).toBe('In progress');
  });

  it('leaves the rows the other sections already speak for alone', () => {
    const gate = {
      issue: 4336,
      gate: 'C' as const,
      stage: 5,
      sessionId: null,
      stoppedAt: null,
      reportPath: null,
      summary: '',
      questions: [],
    };
    const rows = [
      row({ number: 4336, status: 'at-gate', gate }),
      row({ number: 4344, status: 'detached', statusDetail: 'you took this one over in a terminal' }),
      row({ number: 4405, status: 'no-worker' }),
      row({ number: 4334, status: 'checkpoint', statusDetail: 'stopped after stage 0', stage: 0 }),
    ];
    // Gate-waiting and detached stay where they were; only the stalled one is new.
    expect(inProgress(rows).map((i) => i.slice(0, 5))).toEqual(['#4334']);
    expect(headings(rows)).toEqual(['Waiting on a person', 'In progress', 'No worker / not started']);
  });

  it('sits after the review and QA sections and before "No worker / not started"', () => {
    const out = buildSummary({
      ...EMPTY,
      rows: [
        row({ number: 4334, status: 'checkpoint', statusDetail: 'stopped after stage 0' }),
        row({ number: 4405, status: 'no-worker' }),
      ],
      openIssues: [{ number: 4342, title: 'Quote Preview Notice Pills' }],
      mergedPrs: {
        items: [
          {
            number: 4296,
            title: 'reconcile coverages',
            url: 'https://github.com/example-org/example-repo/pull/4296',
            mergedAt: NOW,
            headRefName: 'fix/issue-4342-quote-preview-notice-pills',
          },
        ],
        error: null,
      },
      openPrs: { items: [openPr()], error: null },
    });
    expect(out.sections.map((s) => s.heading)).toEqual([
      'PRs Merged',
      'PRs In Review',
      'In QA (awaiting verification, open)',
      'In progress',
      'No worker / not started',
    ]);
  });

  it('an issue an open PR speaks for is not repeated in progress', () => {
    const out = buildSummary({
      ...EMPTY,
      rows: [row({ number: 4336, status: 'pr-open', statusDetail: 'PR #4446 open' })],
      openPrs: { items: [openPr({ reviewDecision: 'APPROVED', labels: [] })], error: null },
    });
    expect(out.sections.map((s) => s.heading)).toEqual(['PRs In Review']);
  });

  it('is left out when every row is spoken for elsewhere', () => {
    expect(headings([row({ number: 4405, status: 'no-worker' })])).toEqual(['No worker / not started']);
  });

  it('does not say a review is "pending" on a PR nobody has been shown', () => {
    // "draft, review pending" reads as though a review were on its way. It is
    // not: no codeowner has been asked and no review workflow has fired.
    const out = buildSummary({
      ...EMPTY,
      rows: [row({ number: 4336, status: 'pr-open', statusDetail: 'PR #4446 (draft) open' })],
      openPrs: { items: [openPr({ isDraft: true, labels: [] })], error: null },
    });
    const inReview = out.sections.find((s) => s.heading === 'PRs In Review')!.items.join(' ');
    expect(inReview).toContain('draft — not in review until it is marked ready');
    expect(inReview).not.toContain('review pending');
  });
});

describe('backlog this machine raised says so', () => {
  const notStarted = (rows: IssueRow[]) =>
    buildSummary({ ...EMPTY, rows }).sections.find((s) => s.heading === 'No worker / not started')?.items ?? [];

  it('marks a self-filed, untriaged issue, so a pasted post does not pass it off as agreed work', () => {
    const items = notStarted([
      row({
        number: 4472,
        title: 'Reporting tech debt',
        status: 'no-worker',
        author: 'operator',
        selfFiled: true,
        labels: ['needs-triage'],
      }),
    ]);
    expect(items).toEqual(['#4472 — Reporting tech debt (self-filed, needs triage)']);
  });

  it('marks nothing else: not a teammate’s untriaged issue, not a self-filed one that has been ranked', () => {
    const items = notStarted([
      // #4336's shape: needs-triage, but a teammate filed it.
      row({ number: 4336, title: 'Filter pills', status: 'no-worker', selfFiled: false, labels: ['needs-triage'] }),
      // Filed here, but triage has since ranked it — a stale needs-triage label
      // does not undo that: the priority is the more specific fact.
      row({
        number: 4405,
        title: 'Org search scope',
        status: 'no-worker',
        author: 'operator',
        selfFiled: true,
        labels: ['P2', 'needs-triage'],
      }),
    ]);
    expect(items).toEqual(['#4405 — Org search scope', '#4336 — Filter pills']);
  });
});

describe('a section that could not be read says so', () => {
  it('prints the failure in the section instead of printing nothing', () => {
    const out = buildSummary({
      ...EMPTY,
      mergedPrs: { items: [], error: 'gh pr list --state merged: HTTP 403' },
    });
    const section = out.sections.find((s) => s.heading === 'PRs Merged');
    expect(section?.items).toEqual(['could not fetch — gh pr list --state merged: HTTP 403']);
    expect(out.markdown).toContain('• could not fetch — gh pr list --state merged: HTTP 403');
  });

  it('a section that read fine and found nothing is still left out', () => {
    const out = buildSummary({ ...EMPTY, mergedPrs: { items: [], error: 'boom' } });
    expect(out.sections.map((s) => s.heading)).toEqual(['PRs Merged']);
  });
});
