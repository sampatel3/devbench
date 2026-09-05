import { describe, it, expect } from 'vitest';
import {
  assigneeOf,
  hasTicketIn,
  issueNumberIn,
  linkedIssueUrlsOf,
  parseSentryIssue,
  parseSentryList,
  sentryApiBase,
  sentryError,
  sentryLinkFrom,
  ticketDraftFor,
  validSentryOrg,
  validSentryToken,
} from '../src/sentry.js';

/**
 * The join between the two systems is a link in a GitHub issue body, written by
 * Sentry's own integration. This is a real body, off #5555 on 2026-09-02, with
 * the org and the project renamed.
 */
const REAL_BODY =
  'Sentry Issue: [ACME-BACKEND-CV](https://acme-corp.sentry.io/issues/7704960840/?referrer=github_integration)\n' +
  '\n' +
  '```\n' +
  'Error: send-authored-email: no published definition matches\n' +
  '```';

describe('sentryLinkFrom', () => {
  it('reads the id and the short id out of the body the integration writes', () => {
    expect(sentryLinkFrom(REAL_BODY)).toEqual({
      id: '7704960840',
      shortId: 'ACME-BACKEND-CV',
      url: 'https://acme-corp.sentry.io/issues/7704960840',
    });
  });

  it('reads the org-scoped and region-scoped URL forms too', () => {
    expect(sentryLinkFrom('see https://us.sentry.io/organizations/acme-corp/issues/12345/')?.id).toBe('12345');
    expect(sentryLinkFrom('see https://sentry.io/issues/999/')?.id).toBe('999');
  });

  it('takes the FIRST link, so a later comment cannot repoint the card', () => {
    const two = `${REAL_BODY}\n\nalso https://acme-corp.sentry.io/issues/1111111111/`;
    expect(sentryLinkFrom(two)?.id).toBe('7704960840');
  });

  it('does not invent a short id when the link is bare', () => {
    expect(sentryLinkFrom('https://acme-corp.sentry.io/issues/7704960840/')).toEqual({
      id: '7704960840',
      shortId: null,
      url: 'https://acme-corp.sentry.io/issues/7704960840',
    });
  });

  it('is null for a body with no Sentry link, and for anything that is not a string', () => {
    expect(sentryLinkFrom('an ordinary issue about a broken button')).toBeNull();
    expect(sentryLinkFrom('https://github.com/example-org/example-repo/issues/5555')).toBeNull();
    expect(sentryLinkFrom(null)).toBeNull();
    expect(sentryLinkFrom(undefined)).toBeNull();
    expect(sentryLinkFrom('')).toBeNull();
  });
});

/** The documented single-issue shape, with the fields the card actually reads. */
const ISSUE = {
  id: '7704960840',
  shortId: 'ACME-BACKEND-CV',
  title: 'Error: send-authored-email',
  metadata: { value: 'no published definition matches', title: 'Error' },
  culprit: 'sanctionsDocuments in recordLedger',
  level: 'error',
  status: 'unresolved',
  substatus: 'ongoing',
  count: '412',
  userCount: 7,
  firstSeen: '2026-08-28T09:11:00Z',
  lastSeen: '2026-09-02T18:15:00Z',
  permalink: 'https://acme-corp.sentry.io/issues/7704960840/',
  project: { id: '1', slug: 'acme-backend', name: 'acme-backend', platform: 'node' },
  isUnhandled: true,
  firstRelease: { version: 'acme@1.2.2', shortVersion: '1.2.2' },
  lastRelease: { version: 'acme@1.2.4', shortVersion: '1.2.4' },
  tags: [
    {
      key: 'environment',
      topValues: [
        { value: 'uat', count: 401 },
        { value: 'aus', count: 11 },
      ],
    },
    { key: 'release', topValues: [{ value: '1.2.4', count: 300 }] },
  ],
};

describe('parseSentryIssue', () => {
  const facts = parseSentryIssue(ISSUE)!;

  it('answers the question #5555 could not: which environment fired it', () => {
    // Gate B on #5555 closed without knowing which environment fired the
    // Sentry event. This is the whole reason the connection is worth having.
    expect(facts.environments).toEqual([
      { name: 'uat', count: 401 },
      { name: 'aus', count: 11 },
    ]);
  });

  it('reads counts whether Sentry sends them as strings or numbers', () => {
    expect(facts.count).toBe(412);
    expect(facts.userCount).toBe(7);
  });

  it('prefers the error`s own message over the generic title', () => {
    expect(facts.title).toBe('no published definition matches');
  });

  it('carries the facts that decide whether it is worth working', () => {
    expect(facts.status).toBe('unresolved');
    expect(facts.substatus).toBe('ongoing');
    expect(facts.unhandled).toBe(true);
    expect(facts.firstSeen).toBe('2026-08-28T09:11:00Z');
    expect(facts.lastSeen).toBe('2026-09-02T18:15:00Z');
    expect(facts.project).toBe('acme-backend');
    expect(facts.culprit).toBe('sanctionsDocuments in recordLedger');
    expect(facts.firstRelease).toBe('1.2.2');
    expect(facts.lastRelease).toBe('1.2.4');
    expect(facts.releases).toEqual([{ name: '1.2.4', count: 300 }]);
  });

  it('degrades to fewer facts rather than throwing when the shape changes', () => {
    const thin = parseSentryIssue({ id: '1' })!;
    expect(thin.id).toBe('1');
    expect(thin.environments).toEqual([]);
    expect(thin.releases).toEqual([]);
    expect(thin.count).toBeNull();
    expect(thin.unhandled).toBeNull();
    expect(thin.firstRelease).toBeNull();
  });

  it('is null only when there is no id — there would be nothing to link to', () => {
    expect(parseSentryIssue({ shortId: 'X-1' })).toBeNull();
    expect(parseSentryIssue(null)).toBeNull();
    expect(parseSentryIssue('nope')).toBeNull();
  });
});

describe('linkedIssueUrlsOf — has this error been ticketed already', () => {
  it('reads the integration`s own record', () => {
    expect(
      linkedIssueUrlsOf({
        integrationIssues: [{ url: 'https://github.com/example-org/example-repo/issues/5555' }],
      }),
    ).toEqual(['https://github.com/example-org/example-repo/issues/5555']);
  });

  it('reads the older annotations shape, both as an object and as bare HTML', () => {
    expect(linkedIssueUrlsOf({ annotations: [{ url: 'https://github.com/example-org/example-repo/issues/1' }] })).toEqual([
      'https://github.com/example-org/example-repo/issues/1',
    ]);
    expect(
      linkedIssueUrlsOf({ annotations: ['<a href="https://github.com/example-org/example-repo/issues/2">GH-2</a>'] }),
    ).toEqual(['https://github.com/example-org/example-repo/issues/2']);
  });

  it('is empty for an error nobody has ticketed', () => {
    expect(linkedIssueUrlsOf({})).toEqual([]);
    expect(linkedIssueUrlsOf({ annotations: [], integrationIssues: [] })).toEqual([]);
  });
});

describe('parseSentryList', () => {
  it('normalises the rows and keeps what is already ticketed', () => {
    const items = parseSentryList([
      { id: '1', shortId: 'A-1', title: 'one', count: 3, integrationIssues: [{ url: 'https://github.com/example-org/example-repo/issues/9' }] },
      { id: '2', shortId: 'A-2', metadata: { value: 'two' } },
      { shortId: 'A-3' },
      'not an object',
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]!.linkedIssueUrls).toEqual(['https://github.com/example-org/example-repo/issues/9']);
    expect(items[1]!.title).toBe('two');
    expect(items[1]!.linkedIssueUrls).toEqual([]);
  });

  it('is empty for anything that is not a list', () => {
    expect(parseSentryList({})).toEqual([]);
    expect(parseSentryList(null)).toEqual([]);
  });
});

describe('hasTicketIn', () => {
  const item = (urls: string[]) => ({ linkedIssueUrls: urls }) as never;

  it('matches the repo this console works, whatever the case', () => {
    expect(hasTicketIn(item(['https://github.com/example-org/example-repo/issues/5555']), 'example-org/example-repo')).toBe(true);
    expect(hasTicketIn(item(['https://github.com/EXAMPLE-ORG/Example-Repo/issues/1']), 'example-org/example-repo')).toBe(true);
  });

  it('does not match a ticket in somebody else`s repo', () => {
    expect(hasTicketIn(item(['https://github.com/other/repo/issues/1']), 'example-org/example-repo')).toBe(false);
    expect(hasTicketIn(item([]), 'example-org/example-repo')).toBe(false);
  });
});

describe('sentryError — the token never reaches the screen', () => {
  it('redacts the literal token', () => {
    const token = 'sntryu_abc123DEF-456_xyz';
    expect(sentryError(new Error(`401 for Bearer ${token}`), token)).toBe('401 for Bearer [redacted]');
  });

  it('redacts a token by shape even when it is not the one we hold', () => {
    // An auth failure is exactly when a service echoes the header back, and the
    // one it echoes may be a stale token from another attempt.
    expect(sentryError(new Error('bad token sntrys_othertoken99'), 'sntryu_ours')).toBe('bad token [redacted]');
    expect(sentryError(new Error(`legacy ${'a'.repeat(64)}`), 'x')).toBe('legacy [redacted]');
  });

  it('keeps the first useful line and nothing else', () => {
    expect(sentryError(new Error('rate limited\nsecond line'), 'x')).toBe('rate limited');
    expect(sentryError('', 'x')).toBe('unknown error');
  });
});

describe('the token and org are checked before anything is sent', () => {
  it('accepts a real Sentry token shape, hyphens and underscores included', () => {
    expect(validSentryToken(' sntrys_ab-cd_ef ')).toBe('sntrys_ab-cd_ef');
  });

  it('refuses an empty token, and says which scope it needs', () => {
    expect(() => validSentryToken('   ')).toThrow(/event:read/);
  });

  it('refuses a token carrying a control character, which would break the header', () => {
    expect(() => validSentryToken('abc\ndef')).toThrow(/invalid characters/);
    expect(() => validSentryToken('abc def')).toThrow(/invalid characters/);
  });

  it('takes their org slug and lower-cases it', () => {
    expect(validSentryOrg(' Acme-Corp ')).toBe('acme-corp');
    expect(() => validSentryOrg('not a slug!')).toThrow(/organisation slug/);
    expect(() => validSentryOrg('')).toThrow(/acme-corp/);
  });
});

describe('sentryApiBase', () => {
  it('uses the org subdomain — the host their own ticket links prove resolves', () => {
    expect(sentryApiBase('acme-corp')).toBe('https://acme-corp.sentry.io/api/0');
  });

  it('takes an override, without a trailing slash', () => {
    expect(sentryApiBase('acme-corp', 'https://us.sentry.io/api/0/')).toBe('https://us.sentry.io/api/0');
    expect(sentryApiBase('acme-corp', '   ')).toBe('https://acme-corp.sentry.io/api/0');
  });
});

describe('assigneeOf — who has this already', () => {
  it('reads a person', () => {
    expect(assigneeOf({ type: 'user', id: '9', name: 'QA Alice', email: 'qa-alice@example.com' })).toEqual({
      kind: 'user',
      name: 'QA Alice',
      email: 'qa-alice@example.com',
    });
  });

  it('keeps a team a team — "assigned to #platform" is not somebody picking it up', () => {
    expect(assigneeOf({ type: 'team', slug: 'platform', name: '#platform' })?.kind).toBe('team');
  });

  it('is null for nobody', () => {
    expect(assigneeOf(null)).toBeNull();
    expect(assigneeOf(undefined)).toBeNull();
    expect(assigneeOf({})).toBeNull();
  });
});

describe('issueNumberIn', () => {
  it('reads the number out of a link into this repo', () => {
    expect(issueNumberIn('https://github.com/example-org/example-repo/issues/5555', 'example-org/example-repo')).toBe(5555);
    expect(issueNumberIn('https://github.com/Example-Org/example-repo/issues/42#issuecomment-1', 'example-org/example-repo')).toBe(42);
  });

  it('is null for another repo, a PR, or no number', () => {
    expect(issueNumberIn('https://github.com/other/repo/issues/1', 'example-org/example-repo')).toBeNull();
    expect(issueNumberIn('https://github.com/example-org/example-repo/pull/5555', 'example-org/example-repo')).toBeNull();
    expect(issueNumberIn('https://github.com/example-org/example-repo/issues/', 'example-org/example-repo')).toBeNull();
  });

  it('treats the repo name as data, not as a pattern', () => {
    // A `.` in an owner name must not match any character. `ex-org` vs `ex.org`.
    expect(issueNumberIn('https://github.com/ex-org/example-repo/issues/7', 'ex.org/example-repo')).toBeNull();
  });
});

describe('the triage row carries who has it and what kind of issue it is', () => {
  it('reads the Sentry assignee and the category off the list payload', () => {
    const [row] = parseSentryList([
      {
        id: '7604240683',
        shortId: 'ACME-FRONTEND-32',
        title: 'Frontend LCP p75 regression - acme-monitor-aus',
        assignedTo: { type: 'user', name: 'QA Alice', email: 'qa-alice@example.com' },
        issueCategory: 'performance',
      },
    ]);
    expect(row!.assignee?.name).toBe('QA Alice');
    expect(row!.category).toBe('performance');
  });

  it('leaves both null on an unassigned error, which is the actionable case', () => {
    const [row] = parseSentryList([{ id: '1' }]);
    expect(row!.assignee).toBeNull();
    expect(row!.category).toBeNull();
  });
});

describe('Sentry`s own priority, measured against the live org', () => {
  it('is carried through, because it beats `level` as a triage key', () => {
    // ACME-BACKEND-B9 in the live org: level `warning`, 484 events, 401 users.
    // Reading "warning" would tell you to ignore it.
    const [row] = parseSentryList([
      { id: '1', shortId: 'ACME-BACKEND-B9', level: 'warning', priority: 'high', count: '484', userCount: 401 },
    ]);
    expect(row!.priority).toBe('high');
    expect(row!.level).toBe('warning');
    expect(row!.count).toBe(484);
  });

  it('is null when Sentry sends none, never guessed from level', () => {
    expect(parseSentryList([{ id: '1', level: 'error' }])[0]!.priority).toBeNull();
  });
});

/**
 * ACME-FRONTEND-K7 could be SEEN and not TAKEN.
 *
 * The take route searched an unfiltered list read while the panel showed an
 * `aus`-filtered one, and both are capped at Sentry's 100. K7 was last seen six
 * days before the rest of the selection: inside the top 100 for `aus`, outside
 * it across every environment. So the row was on screen and the button could
 * not find it — silently, and only for errors old enough to fall off the wider
 * page.
 *
 * The route now reads the issue BY ID, which has neither a cap nor a filter.
 * These assertions hold the two halves that made the fix possible: a
 * single-issue payload carries everything the ticket draft needs, and the draft
 * builder accepts that shape as readily as a list row.
 */
describe('a ticket can be drafted from a single-issue read, not just a list row', () => {
  it('carries priority and category on the single-issue shape', () => {
    const facts = parseSentryIssue({ ...ISSUE, priority: 'high', issueCategory: 'error' })!;
    expect(facts.priority).toBe('high');
    expect(facts.category).toBe('error');
  });

  it('drafts the same ticket from a single-issue read as from a list row', () => {
    const facts = parseSentryIssue({ ...ISSUE, priority: 'high', issueCategory: 'error' })!;
    const [row] = parseSentryList([{ ...ISSUE, priority: 'high', issueCategory: 'error' }]);
    const fromFacts = ticketDraftFor(facts);
    const fromRow = ticketDraftFor(row!);
    expect(fromFacts.title).toBe(fromRow.title);
    expect(fromFacts.labels).toEqual(['needs-triage']);
    // The Sentry link is the part that has to be identical: it is what pairs the
    // ticket back to the error on the next poll.
    expect(fromFacts.body.split('\n')[0]).toBe(fromRow.body.split('\n')[0]);
    expect(sentryLinkFrom(fromFacts.body)?.id).toBe('7704960840');
  });
});

/**
 * "Bad Request" is not a title.
 *
 * The first four tickets this raised included three titled exactly that —
 * #5695, #5696 and #5698 — because `metadata.value` is the message and nothing
 * else. Indistinguishable in the queue, and useless to a worker.
 */
describe('the ticket title says what, where and which', () => {
  const row = (over: Record<string, unknown>) =>
    parseSentryList([{ id: '1', shortId: 'ACME-FRONTEND-D4', ...over }])[0]!;

  it('adds the culprit, which is the part that says where', () => {
    const draft = ticketDraftFor(row({ metadata: { value: 'Bad Request' }, culprit: '/underwriting/submissions' }));
    expect(draft.title).toBe('Bad Request — /underwriting/submissions (ACME-FRONTEND-D4)');
  });

  it('distinguishes two errors that share BOTH message and culprit', () => {
    // #5695 and #5696 are exactly this: Sentry grouped them apart and nothing
    // in the payload but the short id tells them apart.
    const a = ticketDraftFor(row({ metadata: { value: 'Bad Request' }, culprit: '/x', shortId: 'A-1' }));
    const b = ticketDraftFor(row({ metadata: { value: 'Bad Request' }, culprit: '/x', shortId: 'A-2' }));
    expect(a.title).not.toBe(b.title);
  });

  it('does not repeat a culprit the message already names', () => {
    const draft = ticketDraftFor(row({ metadata: { value: 'Bad Request at /a/b' }, culprit: '/a/b' }));
    expect(draft.title).toBe('Bad Request at /a/b (ACME-FRONTEND-D4)');
  });

  it('leaves an already-specific title alone apart from the id', () => {
    const draft = ticketDraftFor(row({ metadata: { value: 'Critical: p75(measurements.lcp) above 4000.0' }, culprit: null }));
    expect(draft.title).toBe('Critical: p75(measurements.lcp) above 4000.0 (ACME-FRONTEND-D4)');
  });

  it('falls back to the short id alone when Sentry gives no message', () => {
    const draft = ticketDraftFor(row({ culprit: null }));
    expect(draft.title).toBe('ACME-FRONTEND-D4');
  });
});
