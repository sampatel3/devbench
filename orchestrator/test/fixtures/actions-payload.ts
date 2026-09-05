/**
 * The omnibus response, in the exact shape GitHub returned from one live poll of
 * one repository — measured `rateLimit { cost: 2, nodeCount: 2480 }`.
 *
 * Trimmed to the rows that carry a signal (the ten assigned issues are three
 * here) and with titles and logins neutralised, but every field name, nesting
 * depth and `__typename` is the live one, including the two facts the whole
 * feature turns on: #4342 and #4334 sit in board lane `QA` with a MERGED
 * cross-referenced PR, and the only comments on the operator's issues that day
 * are from the `github-actions` Bot.
 */
export const RAW_OMNIBUS = {
  data: {
    assigned: {
      nodes: [
        {
          number: 4334,
          title: 'Branded auth email links',
          url: 'https://github.com/example-org/example-repo/issues/4334',
          state: 'OPEN',
          createdAt: '2026-08-05T09:00:00Z',
          updatedAt: '2026-08-11T18:45:31Z',
          author: { login: 'operator' },
          labels: { nodes: [{ name: 'P2' }] },
          comments: { totalCount: 0, nodes: [] },
          projectItems: {
            nodes: [{ project: { number: 3, title: 'Example Board' }, fieldValueByName: { name: 'QA', updatedAt: '2026-08-11T18:44:03Z' } }],
          },
          timelineItems: {
            nodes: [
              {
                createdAt: '2026-08-10T12:00:00Z',
                source: {
                  number: 4466,
                  url: 'https://github.com/example-org/example-repo/pull/4466',
                  state: 'MERGED',
                  createdAt: '2026-08-10T12:00:00Z',
                  mergedAt: '2026-08-11T18:45:31Z',
                  headRefName: 'fix/issue-4334-branded-auth-email-links',
                  commits: { nodes: [{ commit: { committedDate: '2026-08-11T17:23:00Z' } }] },
                },
              },
            ],
          },
        },
        {
          number: 4336,
          title: 'Organizations sysadmin filter pills',
          url: 'https://github.com/example-org/example-repo/issues/4336',
          state: 'OPEN',
          createdAt: '2026-08-07T09:00:00Z',
          updatedAt: '2026-08-11T18:49:13Z',
          author: { login: 'operator' },
          labels: { nodes: [{ name: 'needs-triage' }] },
          comments: {
            totalCount: 1,
            nodes: [
              {
                databaseId: 5551,
                author: { login: 'github-actions', __typename: 'Bot' },
                createdAt: '2026-08-07T20:02:08Z',
                body: '<!-- needs-triage-explainer -->\nTagged `needs-triage` — still missing:',
                url: 'https://github.com/example-org/example-repo/issues/4336#issuecomment-5551',
              },
            ],
          },
          projectItems: {
            nodes: [
              { project: { number: 3, title: 'Example Board' }, fieldValueByName: { name: 'In review', updatedAt: '2026-08-11T18:00:00Z' } },
            ],
          },
          timelineItems: { nodes: [] },
        },
        {
          number: 4491,
          title: 'Change brokerage on a submission',
          url: 'https://github.com/example-org/example-repo/issues/4491',
          state: 'OPEN',
          createdAt: '2026-08-12T08:00:00Z',
          updatedAt: '2026-08-12T08:00:00Z',
          author: { login: 'qa-bob' },
          labels: { nodes: [] },
          comments: { totalCount: 0, nodes: [] },
          projectItems: {
            nodes: [{ project: { number: 3, title: 'Example Board' }, fieldValueByName: { name: 'Ready', updatedAt: '2026-08-12T08:00:00Z' } }],
          },
          timelineItems: { nodes: [] },
        },
      ],
    },
    myPrs: {
      nodes: [
        {
          number: 4501,
          title: 'Quote preview notice pills',
          url: 'https://github.com/example-org/example-repo/pull/4501',
          isDraft: false,
          reviewDecision: 'CHANGES_REQUESTED',
          createdAt: '2026-08-12T07:00:00Z',
          updatedAt: '2026-08-12T09:35:00Z',
          baseRefName: 'dev',
          headRefName: 'fix/issue-4342-quote-preview',
          labels: { nodes: [{ name: 'changes-requested' }, { name: 'human-review-needed' }] },
          latestReviews: {
            nodes: [
              {
                author: { login: 'pr-swarm[bot]', __typename: 'Bot' },
                state: 'CHANGES_REQUESTED',
                submittedAt: '2026-08-12T09:30:00Z',
                body: 'Tighten the null check',
              },
            ],
          },
          comments: { totalCount: 0, nodes: [] },
          commits: { nodes: [{ commit: { oid: 'abc123', statusCheckRollup: { state: 'FAILURE' } } }] },
        },
      ],
    },
    reviewRequested: { nodes: [] },
    mentions: { nodes: [] },
    mergedRecently: {
      nodes: [
        {
          number: 4466,
          title: 'Branded auth email links',
          url: 'https://github.com/example-org/example-repo/pull/4466',
          mergedAt: '2026-08-11T18:45:31Z',
          headRefName: 'fix/issue-4334-branded-auth-email-links',
        },
      ],
    },
    rateLimit: { cost: 2, remaining: 836, resetAt: '2026-08-12T11:26:24Z', limit: 5000, used: 4164, nodeCount: 2480 },
  },
};
