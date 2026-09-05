import { describe, it, expect } from 'vitest';
import { deriveActions, uatFailFor, KIND_META, metaFor, type DeriveContext } from '../src/actions.js';
import { parseActionsPayload, type ActionsPayload } from '../src/gh.js';
import { RAW_OMNIBUS } from './fixtures/actions-payload.js';

/**
 * The feed. `deriveActions` is pure: payload in, actions out, no network, no
 * clock of its own.
 */

const ME = 'operator';
const NOW = new Date('2026-08-12T12:00:00Z');

const ctx = (over: Partial<DeriveContext> = {}): DeriveContext => ({
  me: ME,
  now: NOW,
  seenAt: null,
  lookbackMs: 7 * 86_400_000,
  trackedIssues: new Set<number>(),
  atGate: new Set<number>(),
  reworkIssues: new Set<number>(),
  branchActivity: new Map<number, string>(),
  knownAssigned: new Set<number>([4334, 4336, 4491]),
  inFlight: new Set<number>(),
  ...over,
});

/** #4334's own work, shipped — the PR the merge stamp on the fixture comes from. */
const SHIPPED_4334 = {
  number: 4466,
  url: 'https://github.com/example-org/example-repo/pull/4466',
  state: 'MERGED',
  createdAt: '2026-08-10T12:00:00Z',
  mergedAt: '2026-08-11T18:45:31Z',
  headRefName: 'fix/issue-4334-branded-auth-email-links',
  lastCommitAt: '2026-08-11T18:40:00Z',
};

/** An assigned issue in the shape the omnibus returns it. */
const issue = (over: Partial<ActionsPayload['issues'][number]> = {}): ActionsPayload['issues'][number] => ({
  number: 4334,
  title: 'Branded auth email links',
  url: 'https://github.com/example-org/example-repo/issues/4334',
  updatedAt: '2026-08-12T09:00:00Z',
  labels: ['P2'],
  comments: [],
  lane: 'QA',
  laneAt: '2026-08-11T18:44:03Z',
  // Consistent the way `parseActionsPayload` guarantees it: `mergedAt` is the
  // earliest merge among `referencingPrs`, and `mergedPrs` is that same subset.
  // A fixture that carried a merge stamp with no PR behind it could pass a rule
  // that the real payload would never reach.
  referencingPrs: [SHIPPED_4334],
  mergedPrs: [SHIPPED_4334],
  mergedAt: '2026-08-11T18:45:31Z',
  closed: false,
  ...over,
});

const human = (body: string, over: Partial<ActionsPayload['issues'][number]['comments'][number]> = {}) => ({
  id: '9001',
  author: { login: 'qa-alice', typename: 'User' },
  createdAt: '2026-08-12T09:00:00Z',
  body,
  url: 'https://github.com/example-org/example-repo/issues/4334#issuecomment-9001',
  ...over,
});

const payload = (over: Partial<ActionsPayload> = {}): ActionsPayload => ({
  issues: [],
  prs: [],
  reviewRequested: [],
  mentions: [],
  merged: [],
  quota: null,
  truncated: null,
  ...over,
});

describe('uat-fail — the one tier-1 kind, and the only thing that outranks P0', () => {
  it('a human Test Result: Fail after the merge is tier 1', () => {
    const a = deriveActions(payload({ issues: [issue({ comments: [human('**Test Result:** Fail\nsteps…')] })] }), ctx());
    const fail = a.find((x) => x.kind === 'uat-fail')!;
    expect(fail).toBeDefined();
    expect(fail.tier).toBe(1);
    expect(fail.actor).toBe('qa-alice');
    expect(fail.subject.number).toBe(4334);
    expect(fail.reason).toBe('qa-alice tested this in UAT and marked it Fail');
    // The id is GitHub's own comment id, so notify-once survives a restart.
    expect(fail.id).toBe('uat-fail:issue#4334:9001');
    expect(fail.url).toContain('#issuecomment-9001');
  });

  it('Partial Pass is a send-back too', () => {
    const a = deriveActions(payload({ issues: [issue({ comments: [human('**Test Result:** Partial Pass')] })] }), ctx());
    expect(a.find((x) => x.kind === 'uat-fail')!.verdict).toBe('Partial Pass');
  });

  it('the live #5019 bare Partial Pass header is a send-back without a Revisit move', () => {
    const i = issue({
      number: 5019,
      title: 'Records tab — search, per-lane paging, ordering',
      lane: 'QA',
      comments: [
        human('**Partial Pass:**\n@operator\n---\nSearch by name returns no results', {
          id: '5411177750',
          author: { login: 'qa-bob', typename: 'User' },
          url: 'https://github.com/example-org/example-repo/issues/5019#issuecomment-5411177750',
        }),
      ],
    });

    const a = deriveActions(payload({ issues: [i] }), ctx({ trackedIssues: new Set([5019]) }));

    expect(a.find((x) => x.kind === 'uat-unparsed')).toBeUndefined();
    expect(uatFailFor(a, 5019)).toMatchObject({
      by: 'qa-bob',
      verdict: 'Partial Pass',
      url: 'https://github.com/example-org/example-repo/issues/5019#issuecomment-5411177750',
      inflight: false,
    });
  });

  it('the same verdict from the swarm BOT is nothing at all', () => {
    const bot = human('**Test Result:** Fail', { author: { login: 'pr-swarm[bot]', typename: 'Bot' } });
    const a = deriveActions(payload({ issues: [issue({ comments: [bot] })] }), ctx());
    expect(a.filter((x) => x.tier === 1)).toEqual([]);
  });

  it('the operator’s OWN worker posting the template is nothing at all', () => {
    const mine = human('**Test Result:** Fail', { author: { login: 'operator', typename: 'User' } });
    const a = deriveActions(payload({ issues: [issue({ comments: [mine] })] }), ctx());
    expect(a.filter((x) => x.tier === 1)).toEqual([]);
  });

  it('a verdict-shaped comment before the merge is not a UAT verdict', () => {
    const early = human('**Test Result:** Fail', { createdAt: '2026-08-01T09:00:00Z' });
    const a = deriveActions(payload({ issues: [issue({ comments: [early] })] }), ctx());
    expect(a.filter((x) => x.tier === 1)).toEqual([]);
  });

  it('a later Pass retires the standing fail and becomes a tier-3 FYI', () => {
    const a = deriveActions(
      payload({
        issues: [
          issue({
            comments: [
              human('**Test Result:** Fail', { id: '1', createdAt: '2026-08-12T09:00:00Z' }),
              human('**Test Result:** Pass', { id: '2', createdAt: '2026-08-12T10:00:00Z' }),
            ],
          }),
        ],
      }),
      ctx(),
    );
    expect(a.find((x) => x.kind === 'uat-fail')).toBeUndefined();
    expect(a.find((x) => x.kind === 'uat-pass')!.tier).toBe(3);
  });

  it('the NEWEST verdict wins even when it is the fail', () => {
    const a = deriveActions(
      payload({
        issues: [
          issue({
            comments: [
              human('**Test Result:** Pass', { id: '1', createdAt: '2026-08-12T09:00:00Z' }),
              human('**Test Result:** Fail', { id: '2', createdAt: '2026-08-12T10:00:00Z' }),
            ],
          }),
        ],
      }),
      ctx(),
    );
    expect(a.find((x) => x.kind === 'uat-fail')!.id).toBe('uat-fail:issue#4334:2');
    expect(a.find((x) => x.kind === 'uat-pass')).toBeUndefined();
  });

  it('a tier-1 fail is NEVER seen-gated — a to-do does not expire because it was looked at', () => {
    const old = human('**Test Result:** Fail', { createdAt: '2026-08-11T19:00:00Z' });
    const a = deriveActions(
      payload({ issues: [issue({ comments: [old] })] }),
      ctx({ seenAt: '2026-08-12T11:00:00Z', now: new Date('2026-08-25T00:00:00Z') }),
    );
    expect(a.find((x) => x.kind === 'uat-fail')!.tier).toBe(1);
  });
});

describe('correction 4 — the verdict decays instead of sitting red for days', () => {
  const failing = () => issue({ comments: [human('**Test Result:** Fail', { createdAt: '2026-08-12T09:00:00Z' })] });

  it('a merged fix PR after the verdict clears it completely', () => {
    const i = failing();
    i.referencingPrs = [
      {
        number: 4600,
        url: 'u',
        state: 'MERGED',
        createdAt: '2026-08-12T09:30:00Z',
        mergedAt: '2026-08-12T10:00:00Z',
        headRefName: 'fix/issue-4334-branded-auth-email-links',
      },
    ];
    const a = deriveActions(payload({ issues: [i] }), ctx());
    expect(a.find((x) => x.kind === 'uat-fail')).toBeUndefined();
    expect(a.find((x) => x.kind === 'uat-fail-inflight')).toBeUndefined();
  });

  it('an OPEN PR opened after the verdict downgrades it out of tier 1', () => {
    // Mirrors resolveRound: the fix is under way, so it stops shouting — but it
    // does not disappear, because nothing has shipped yet.
    const i = failing();
    i.referencingPrs = [
      { number: 4600, url: 'u', state: 'OPEN', createdAt: '2026-08-12T09:30:00Z', mergedAt: null },
    ];
    const a = deriveActions(payload({ issues: [i] }), ctx());
    expect(a.find((x) => x.kind === 'uat-fail')).toBeUndefined();
    const inflight = a.find((x) => x.kind === 'uat-fail-inflight')!;
    expect(inflight.tier).toBe(2);
    expect(inflight.reason).toContain('fix in flight');
  });

  it('a branch touched after the verdict downgrades it too — someone is on it interactively', () => {
    const a = deriveActions(
      payload({ issues: [failing()] }),
      ctx({ branchActivity: new Map([[4334, '2026-08-12T09:45:00Z']]) }),
    );
    expect(a.find((x) => x.kind === 'uat-fail')).toBeUndefined();
    expect(a.find((x) => x.kind === 'uat-fail-inflight')).toBeDefined();
  });

  /**
   * FIX — a fix PUSHED to a PR that already existed never decayed.
   *
   * `fixProgress` had three signals and two of them go missing exactly when they
   * are needed. It tested `p.createdAt`, and a PR opened before the verdict can
   * still be where the fix lands. The other signal, `branchActivity`, needs a
   * live worktree — and a UAT fail is by definition post-merge, which is when
   * the worktree is most likely to have been cleaned up. So the row sat red at
   * the top of the page for days while the operator was demonstrably fixing it.
   *
   * The referencing PR now carries its newest commit date. Measured on the live
   * repo: `commits(last: 1)` inside the existing `timelineItems` selection costs
   * NOTHING — `cost 1 / nodeCount 630` with and without it, identically.
   */
  it('a commit pushed after the verdict decays it, even on a PR that predates the verdict', () => {
    const i = failing();
    i.referencingPrs = [
      {
        number: 4600,
        url: 'u',
        state: 'OPEN',
        createdAt: '2026-08-12T08:00:00Z', // an hour BEFORE the verdict
        mergedAt: null,
        lastCommitAt: '2026-08-12T09:40:00Z', // ...and worked on after it
      },
    ];
    const a = deriveActions(payload({ issues: [i] }), ctx());
    expect(a.find((x) => x.kind === 'uat-fail')).toBeUndefined();
    expect(a.find((x) => x.kind === 'uat-fail-inflight')!.tier).toBe(2);
  });

  it('a commit from BEFORE the verdict decays nothing — that is the work that failed', () => {
    const i = failing();
    i.referencingPrs = [
      {
        number: 4466,
        url: 'u',
        state: 'MERGED',
        createdAt: '2026-08-10T12:00:00Z',
        mergedAt: '2026-08-11T18:45:31Z',
        lastCommitAt: '2026-08-11T18:00:00Z',
        headRefName: 'fix/issue-4334-branded-auth-email-links',
      },
    ];
    expect(deriveActions(payload({ issues: [i] }), ctx()).find((x) => x.kind === 'uat-fail')!.tier).toBe(1);
  });

  it('a PR or branch from BEFORE the verdict changes nothing — that is the work that failed', () => {
    const i = failing();
    i.referencingPrs = [
      {
        number: 4466,
        url: 'u',
        state: 'MERGED',
        createdAt: '2026-08-10T12:00:00Z',
        mergedAt: '2026-08-11T18:45:31Z',
        headRefName: 'fix/issue-4334-branded-auth-email-links',
      },
    ];
    const a = deriveActions(
      payload({ issues: [i] }),
      ctx({ branchActivity: new Map([[4334, '2026-08-11T00:00:00Z']]) }),
    );
    expect(a.find((x) => x.kind === 'uat-fail')!.tier).toBe(1);
  });
});

describe('correction 2 — the FYI valve turns a silent miss into a visible one', () => {
  it('a human comment after the merge on a QA-lane issue that did NOT parse gets a tier-3 row', () => {
    const a = deriveActions(
      payload({ issues: [issue({ comments: [human('Test Results — it still fails on step 3')] })] }),
      ctx(),
    );
    const fyi = a.find((x) => x.kind === 'uat-unparsed')!;
    expect(fyi.tier).toBe(3);
    expect(fyi.reason).toBe('qa-alice commented on #4334 after merge — not a recognised verdict');
  });

  it('the valve never reaches tier 1 and never pushes', () => {
    const a = deriveActions(payload({ issues: [issue({ comments: [human('anything at all')] })] }), ctx());
    expect(a.every((x) => x.kind !== 'uat-unparsed' || x.tier === 3)).toBe(true);
    expect(metaFor('uat-unparsed').push).toBe(false);
  });

  it('ordinary chat in a lane that is not QA is a normal comment, not a valve row', () => {
    // The valve must not swallow every post-merge comment into tier 3: an
    // ordinary question from a colleague still needs a response, so it stays a
    // tier-2 `comment`.
    const a = deriveActions(
      payload({ issues: [issue({ lane: 'In progress', comments: [human('some chat')] })] }),
      ctx(),
    );
    expect(a.find((x) => x.kind === 'uat-unparsed')).toBeUndefined();
    expect(a.find((x) => x.kind === 'comment')?.tier).toBe(2);
  });

  /**
   * BLOCK — the valve was scoped to the lane a Fail moves OUT of.
   *
   * A send-back moves the board item back to `In progress` / `In review`. Of the
   * open issues on this repo carrying a Fail verdict, most are NOT in `QA` by
   * the time the console reads them. So the one case the valve exists for — a
   * verdict the regex could not parse — was the exact case it could not see, and
   * the miss rendered as an indistinguishable "new comment".
   */
  it('a verdict-SHAPED comment the regex could not parse trips the valve in ANY lane', () => {
    const odd = human('Test Result: needs another look, see the table below');
    for (const lane of ['QA', 'In progress', 'In review', null]) {
      const a = deriveActions(payload({ issues: [issue({ lane, comments: [odd] })] }), ctx());
      const fyi = a.find((x) => x.kind === 'uat-unparsed');
      expect([lane, fyi?.tier ?? null]).toEqual([lane, 3]);
      // and it is not ALSO reported as ordinary chat
      expect([lane, a.find((x) => x.kind === 'comment')]).toEqual([lane, undefined]);
    }
  });

  it('a malformed bare verdict heading trips the valve after the issue leaves QA', () => {
    const odd = human('**Partial Pass:** search is still broken');
    for (const lane of ['QA', 'In progress', 'In review', null]) {
      const a = deriveActions(payload({ issues: [issue({ lane, comments: [odd] })] }), ctx());
      expect([lane, a.find((x) => x.kind === 'uat-unparsed')?.tier ?? null]).toEqual([lane, 3]);
    }
  });

  it('does not fire for a bot, and does not double up when the comment DID parse', () => {
    const bot = human('whatever', { author: { login: 'github-actions', typename: 'Bot' } });
    expect(deriveActions(payload({ issues: [issue({ comments: [bot] })] }), ctx()).find((x) => x.kind === 'uat-unparsed')).toBeUndefined();
    const parsed = deriveActions(payload({ issues: [issue({ comments: [human('**Test Result:** Fail')] })] }), ctx());
    expect(parsed.find((x) => x.kind === 'uat-unparsed')).toBeUndefined();
  });
});

describe('the permanent-label trap, and the bot round', () => {
  it('human-review-needed produces NOTHING — 351 PRs carry it and it is never cleaned up', () => {
    const p = parseActionsPayload({
      data: {
        myPrs: {
          nodes: [
            {
              number: 4466,
              title: 'merged work',
              url: 'u',
              isDraft: false,
              reviewDecision: 'APPROVED',
              labels: { nodes: [{ name: 'human-review-needed' }] },
              latestReviews: { nodes: [] },
              comments: { totalCount: 0, nodes: [] },
              commits: { nodes: [{ commit: { oid: 'x', statusCheckRollup: { state: 'SUCCESS' } } }] },
            },
          ],
        },
      },
    });
    expect(deriveActions(p, ctx())).toEqual([]);
  });

  it('the swarm’s changes-requested is tier 2 and never pushes — it lands on every PR opened', () => {
    // The reviewers blocked this at tier 1: pr-swarm[bot] has applied that
    // label to 142/142 feature PRs, so a tier-1 push would fire on essentially
    // every PR the operator raises — the failure mode that gets a notifier muted.
    const a = deriveActions(parseActionsPayload(RAW_OMNIBUS), ctx());
    const cr = a.find((x) => x.kind === 'changes-requested')!;
    expect(cr.tier).toBe(2);
    expect(metaFor('changes-requested').push).toBe(false);
    expect(cr.subject.number).toBe(4501);
  });

  it('CI red on the operator’s open PR is keyed on the commit, not the poll', () => {
    const a = deriveActions(parseActionsPayload(RAW_OMNIBUS), ctx());
    expect(a.find((x) => x.kind === 'ci-failed')!.id).toBe('ci-failed:pr#4501:abc123');
  });
});

/**
 * The bug reported from the console: five issues listed under "waiting on you"
 * that needed nothing — two merged, two with a worker live on them, one
 * queued to run next. The rule is `alreadyHandled`, and it is consulted in
 * exactly one place.
 *
 * Every case here is tested at the `deriveActions` boundary on purpose. The
 * live symptom is a FIRST-READ burst — a fresh `actions.json` leaves
 * `knownAssigned` empty, every assigned issue passes, and fifteen minutes later
 * the feed has cleared itself. Curling `/api/state` therefore shows green with
 * or without the fix; only a synthetic context proves anything.
 */
describe('what is already moving without you is not an action on you', () => {
  /** Nothing local, nothing merged: the shape of a row that MUST survive. */
  const onSam = (n: number) =>
    issue({ number: n, mergedAt: null, lane: 'In progress', referencingPrs: [], mergedPrs: [] });

  it('#4334 — its PR merged, so "newly assigned" is stale news', () => {
    const a = deriveActions(payload({ issues: [issue({ number: 4334 })] }), ctx({ knownAssigned: new Set() }));
    expect(a.filter((x) => x.kind === 'assigned')).toEqual([]);
  });

  it('a merged referencing PR suppresses it even when the issue carries no merge stamp', () => {
    const merged = issue({
      number: 4342,
      mergedAt: null,
      referencingPrs: [
        {
          number: 4368,
          url: 'https://github.com/example-org/example-repo/pull/4368',
          state: 'MERGED',
          createdAt: '2026-08-11T10:00:00Z',
          mergedAt: '2026-08-11T18:43:38Z',
          headRefName: 'issue-4342',
          lastCommitAt: '2026-08-11T18:00:00Z',
        },
      ],
    });
    const a = deriveActions(payload({ issues: [merged] }), ctx({ knownAssigned: new Set() }));
    expect(a.filter((x) => x.kind === 'assigned')).toEqual([]);
  });

  it('somebody ELSE’s merged PR merely mentioning the issue does not make it stale news', () => {
    // A `CROSS_REFERENCED_EVENT` is created by any PR whose body says `#4502`.
    // That PR shipping says nothing at all about #4502's own work.
    const mentioned = issue({
      number: 4502,
      mergedAt: null,
      mergedPrs: [],
      referencingPrs: [
        {
          number: 4499,
          url: 'https://github.com/example-org/example-repo/pull/4499',
          state: 'MERGED',
          createdAt: '2026-08-11T10:00:00Z',
          mergedAt: '2026-08-11T18:43:38Z',
          headRefName: 'fix/issue-4488-quote-preview',
          lastCommitAt: '2026-08-11T18:00:00Z',
        },
      ],
    });
    const a = deriveActions(payload({ issues: [mentioned] }), ctx({ knownAssigned: new Set() }));
    expect(a.filter((x) => x.kind === 'assigned').map((x) => x.subject.number)).toEqual([4502]);
  });

  it('#4487 — a worker is live on it right now', () => {
    const a = deriveActions(
      payload({ issues: [onSam(4487)] }),
      ctx({ knownAssigned: new Set(), inFlight: new Set([4487]) }),
    );
    expect(a.filter((x) => x.kind === 'assigned')).toEqual([]);
  });

  it('#4329 — it is queued and runs next on its own', () => {
    const a = deriveActions(
      payload({ issues: [onSam(4329)] }),
      ctx({ knownAssigned: new Set(), inFlight: new Set([4329]) }),
    );
    expect(a.filter((x) => x.kind === 'assigned')).toEqual([]);
  });

  it('a paused worker keeps its own row, with a Resume button on it — the feed does not ask twice', () => {
    const a = deriveActions(
      payload({ issues: [onSam(4491)] }),
      ctx({ knownAssigned: new Set(), inFlight: new Set([4491]) }),
    );
    expect(a.filter((x) => x.kind === 'assigned')).toEqual([]);
  });

  it('a resume the console still owes is not a fresh ask', () => {
    const a = deriveActions(
      payload({ issues: [onSam(4344)] }),
      ctx({ knownAssigned: new Set(), inFlight: new Set([4344]) }),
    );
    expect(a.filter((x) => x.kind === 'assigned')).toEqual([]);
  });

  it('a comment on a LIVE issue still counts — no worker in this console reads GitHub comments', () => {
    // "Do not ship this, the endpoint changed", landing on the issue a worker is
    // building right now. The single moment the operator most needs to see it.
    const a = deriveActions(
      payload({
        issues: [
          issue({
            number: 4487,
            mergedAt: null,
            mergedPrs: [],
            referencingPrs: [],
            lane: 'In progress',
            comments: [human('do not ship this, the endpoint changed')],
          }),
        ],
      }),
      ctx({ inFlight: new Set([4487]) }),
    );
    expect(a.find((x) => x.kind === 'comment')?.detail).toBe('do not ship this, the endpoint changed');
  });

  it('a comment on an issue parked at a GATE counts too — the gate card asks its own question, not GitHub’s', () => {
    const a = deriveActions(
      payload({
        issues: [
          issue({
            number: 4344,
            mergedAt: null,
            mergedPrs: [],
            referencingPrs: [],
            lane: 'In progress',
            comments: [human('this needs the sysadmin check first')],
          }),
        ],
      }),
      ctx({ atGate: new Set([4344]) }),
    );
    expect(a.find((x) => x.kind === 'comment')).toBeDefined();
  });

  it('#4405 and #4472 — no worker, nothing merged: these rows are the point of the feed', () => {
    const a = deriveActions(
      payload({ issues: [onSam(4405), onSam(4472)] }),
      ctx({ knownAssigned: new Set() }),
    );
    expect(a.filter((x) => x.kind === 'assigned').map((x) => x.subject.number).sort()).toEqual([4405, 4472]);
  });

  it('a worker that died at a checkpoint hands the issue back — the row stays', () => {
    // A checkpoint is not a gate: no `.gate.json` was left behind, so `atGate`
    // is empty, and it is not live, not queued, and owes no resume.
    const a = deriveActions(payload({ issues: [onSam(4405)] }), ctx({ knownAssigned: new Set(), inFlight: new Set() }));
    expect(a.filter((x) => x.kind === 'assigned')).toHaveLength(1);
  });

  it('a worker that died AT A GATE does not — its gate file is still on disk and the card still asks', () => {
    // `atGate` is read off `.gate.json`, not off a live process, so a dead
    // worker parked at gate C is still in it. That is right: the card renders
    // `at-gate` with its buttons, so the feed would only be saying it twice.
    const a = deriveActions(
      payload({ issues: [onSam(4405)] }),
      ctx({ knownAssigned: new Set(), inFlight: new Set(), atGate: new Set([4405]) }),
    );
    expect(a.filter((x) => x.kind === 'assigned')).toEqual([]);
  });

  it('a gate card owns its issue entirely — no assigned row beside it', () => {
    const a = deriveActions(
      payload({ issues: [onSam(4344)] }),
      ctx({ knownAssigned: new Set(), atGate: new Set([4344]) }),
    );
    expect(a.filter((x) => x.kind === 'assigned')).toEqual([]);
  });

  it('merge suppresses "newly assigned" ONLY — someone talking to you after it still counts', () => {
    const a = deriveActions(
      payload({ issues: [issue({ number: 4334, lane: 'In progress', comments: [human('is this the right link?')] })] }),
      ctx(),
    );
    expect(a.find((x) => x.kind === 'comment')).toBeDefined();
  });

  it('a UAT fail on a merged issue is never suppressed — the merge is its precondition', () => {
    const a = deriveActions(
      payload({ issues: [issue({ comments: [human('**Test Result:** Fail')] })] }),
      ctx({ knownAssigned: new Set(), inFlight: new Set([4334]), atGate: new Set([4334]) }),
    );
    expect(a.find((x) => x.kind === 'uat-fail')!.tier).toBe(1);
  });

  it('the uat-unparsed valve still fires on a merged issue with a worker live on it', () => {
    const a = deriveActions(
      payload({ issues: [issue({ comments: [human('looks off to me')] })] }),
      ctx({ knownAssigned: new Set(), inFlight: new Set([4334]) }),
    );
    expect(a.find((x) => x.kind === 'uat-unparsed')).toBeDefined();
  });
});

describe('dedup', () => {
  it('R1 — two comments on one subject collapse to one action, the newest', () => {
    const a = deriveActions(
      payload({
        issues: [
          issue({
            lane: 'In progress',
            mergedAt: null,
            comments: [
              human('first', { id: '1', createdAt: '2026-08-12T09:00:00Z' }),
              human('second', { id: '2', createdAt: '2026-08-12T10:00:00Z' }),
            ],
          }),
        ],
      }),
      ctx(),
    );
    const comments = a.filter((x) => x.kind === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe('comment:issue#4334:2');
  });

  it('R3 — the operator’s own comments are never actions', () => {
    const mine = human('a note to self', { author: { login: 'operator', typename: 'User' } });
    const a = deriveActions(payload({ issues: [issue({ lane: 'In progress', comments: [mine] })] }), ctx());
    expect(a.filter((x) => x.kind === 'comment')).toEqual([]);
  });

  it('R5/gate — a gate card owns the ASK, never the conversation: no assigned row, but the comment stays', () => {
    const a = deriveActions(
      payload({ issues: [issue({ number: 4405, lane: 'In progress', comments: [human('ping')] })] }),
      ctx({ knownAssigned: new Set(), atGate: new Set([4405]) }),
    );
    expect(a.filter((x) => x.kind === 'assigned')).toEqual([]);
    expect(a.find((x) => x.kind === 'comment')).toBeDefined();
  });

  it('a tier-1 verdict is NOT suppressed by a gate — it is the one thing that must always show', () => {
    const a = deriveActions(
      payload({ issues: [issue({ comments: [human('**Test Result:** Fail')] })] }),
      ctx({ atGate: new Set([4334]) }),
    );
    expect(a.find((x) => x.kind === 'uat-fail')).toBeDefined();
  });

  it('R2 — a PR the console already tracks as rework carries consoleIssue and no duplicate row', () => {
    const a = deriveActions(
      parseActionsPayload(RAW_OMNIBUS),
      ctx({ trackedIssues: new Set([4342]), reworkIssues: new Set([4342]), branchActivity: new Map([[4342, '2026-08-12T09:00:00Z']]) }),
    );
    expect(a.filter((x) => x.kind === 'changes-requested')).toHaveLength(1);
    expect(a.find((x) => x.kind === 'changes-requested')!.consoleIssue).toBe(4342);
  });

  it('R7 — assigned fires on arrival only', () => {
    const p = parseActionsPayload(RAW_OMNIBUS);
    expect(deriveActions(p, ctx()).filter((x) => x.kind === 'assigned')).toEqual([]);
    const fresh = deriveActions(p, ctx({ knownAssigned: new Set([4334, 4336]) }));
    expect(fresh.filter((x) => x.kind === 'assigned').map((x) => x.subject.number)).toEqual([4491]);
  });
});

describe('seen-gating and ordering', () => {
  it('a tier-2 comment older than seenAt is gone; a tier-1 is not', () => {
    const i = issue({
      lane: 'In progress',
      mergedAt: null,
      comments: [human('old news', { createdAt: '2026-08-12T08:00:00Z' })],
    });
    const a = deriveActions(payload({ issues: [i] }), ctx({ seenAt: '2026-08-12T09:00:00Z' }));
    expect(a.filter((x) => x.kind === 'comment')).toEqual([]);
  });

  it('anything older than the lookback never resurrects', () => {
    const i = issue({
      lane: 'In progress',
      mergedAt: null,
      comments: [human('ancient', { createdAt: '2026-01-01T00:00:00Z' })],
    });
    expect(deriveActions(payload({ issues: [i] }), ctx()).filter((x) => x.kind === 'comment')).toEqual([]);
  });

  it('orders tier ascending, oldest-first inside tiers 1–2, newest-first in tier 3', () => {
    const a = deriveActions(
      payload({
        issues: [
          issue({ number: 4334, comments: [human('**Test Result:** Fail', { id: '1', createdAt: '2026-08-12T10:00:00Z' })] }),
          issue({
            number: 4342,
            url: 'https://github.com/example-org/example-repo/issues/4342',
            comments: [human('**Test Result:** Fail', { id: '2', createdAt: '2026-08-12T08:00:00Z' })],
          }),
        ],
      }),
      ctx({ knownAssigned: new Set([4334, 4342]) }),
    );
    // Tier never goes backwards down the list…
    expect(a.map((x) => x.tier)).toEqual([...a.map((x) => x.tier)].sort());
    // …and inside tier 1 the verdict that has kept QA waiting longest is first.
    expect(a.filter((x) => x.tier === 1).map((x) => x.subject.number)).toEqual([4342, 4334]);
    // Tier 3 is the other way round: newest news at the top of its section.
    const t3 = a.filter((x) => x.tier === 3).map((x) => Date.parse(x.eventAt));
    expect(t3).toEqual([...t3].sort((x, y) => y - x));
  });

  it('an unknown kind renders rather than throwing', () => {
    expect(metaFor('something-this-build-never-heard-of')).toEqual({ tier: 2, label: 'action', push: false });
    expect(KIND_META['uat-fail']).toEqual({ tier: 1, label: 'UAT fail', push: true });
  });
});

/**
 * The header read "3 actions on you" and the operator could not find the three —
 * the merged branches were the obvious guess, and those are not on anyone.
 *
 * It was not the merges — those are tier 3 and uncounted. It was three
 * `changes-requested` rows for PRs #4535, #4547 and #4594, and the console's own
 * state said every one of their last review rounds was already resolved by the
 * operator: each review had been read and the rework sent back. The operator was
 * being counted three times for work that was finished.
 *
 * The machinery to know this was already being passed in. `reworkIssues` holds the
 * issues with a STILL-ACTIONABLE round, and the emitter computed it — then used it
 * only to set a pointer, never to decide whether the row should exist.
 */
describe('a review the operator has already answered is not an action on them', () => {
  const pr = (number: number, headRefName: string) => ({
    number,
    title: `PR ${number}`,
    url: `https://github.com/example-org/example-repo/pull/${number}`,
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    labels: [],
    headRefName,
    headOid: 'abc',
    checkState: 'SUCCESS',
    createdAt: '2026-08-13T06:00:00Z',
    updatedAt: '2026-08-13T06:00:00Z',
    latestReviews: [
      { author: { login: 'pr-swarm', typename: 'Bot' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-08-13T06:30:00Z', body: 'fix it' },
    ],
    comments: [],
  });

  const ctxFor = (rework: number[], tracked: number[]) => ({
    me: 'operator',
    now: new Date('2026-08-13T12:00:00Z'),
    seenAt: null,
    lookbackMs: 7 * 86_400_000,
    trackedIssues: new Set(tracked),
    atGate: new Set<number>(),
    reworkIssues: new Set(rework),
    branchActivity: new Map<number, string>(),
    knownAssigned: new Set<number>(),
    inFlight: new Set<number>(),
  });

  const payloadWith = (p: ReturnType<typeof pr>) =>
    ({ issues: [], prs: [p], reviewRequested: [], mentions: [], merged: [], quota: null, truncated: false }) as never;

  it('drops it when the console knows the rework was already sent back', () => {
    // Tracked by the console, but NOT in reworkIssues — so its round resolved.
    const out = deriveActions(payloadWith(pr(4535, 'feat/issue-4344-x')), ctxFor([], [4344]) as never);
    expect(out.filter((a) => a.kind === 'changes-requested')).toEqual([]);
  });

  it('keeps it while the round is genuinely still waiting on the operator', () => {
    const out = deriveActions(payloadWith(pr(4535, 'feat/issue-4344-x')), ctxFor([4344], [4344]) as never);
    expect(out.filter((a) => a.kind === 'changes-requested')).toHaveLength(1);
  });

  it('keeps it on a PR the console tracks nothing for — it cannot know', () => {
    // No worktree, no opinion. Silence here would hide a real ask.
    const out = deriveActions(payloadWith(pr(9999, 'someone-elses-branch')), ctxFor([], []) as never);
    expect(out.filter((a) => a.kind === 'changes-requested')).toHaveLength(1);
  });
});

/**
 * #4914 — A SEND-BACK ON AN ISSUE THAT WAS ALREADY CLOSED.
 *
 * The searches behind this payload were `is:open`, so once GitHub's index caught
 * up with a close, a send-back on that issue could never be read. On 2026-08-21
 * the tester posted `Test Result: Fail`, closed the issue as COMPLETED in the
 * same second, and moved the card to `Revisit` twelve seconds later — the first
 * instance of an event a measurement over 60 issues had found none of.
 *
 * (What actually hid #4914 that day was downstream, in `uatFailFor`; the index
 * was still serving the issue as open. This half is the hole that would have
 * bitten next.)
 *
 * Closed issues are now read for a window — and ONLY for this. The four kinds
 * that describe a life already lived are suppressed, or a week of finished work
 * would bury the one thing that is not finished.
 */
describe('a send-back that lands on an already-closed issue', () => {
  const failComment = () =>
    human('Test Result: Fail\n\nPublishing an exclusion shows it as Archived.', {
      id: '5373268785',
      createdAt: '2026-08-12T09:00:00Z',
    });

  it('is still tier 1 when the issue closed in the same act', () => {
    const a = deriveActions(payload({ issues: [issue({ closed: true, comments: [failComment()] })] }), ctx());
    const fail = a.find((x) => x.kind === 'uat-fail')!;
    expect(fail).toBeDefined();
    expect(fail.tier).toBe(1);
    expect(fail.actor).toBe('qa-alice');
    expect(fail.id).toBe('uat-fail:issue#4334:5373268785');
  });

  it('reads the board send-back too, when no comment parsed', () => {
    const a = deriveActions(
      payload({ issues: [issue({ closed: true, lane: 'Revisit', laneAt: '2026-08-11T19:00:00Z', comments: [] })] }),
      ctx(),
    );
    const fail = a.find((x) => x.kind === 'uat-fail')!;
    expect(fail).toBeDefined();
    expect(fail.reason).toContain('moved to Revisit');
  });

  it('says nothing else about it — no assignment, comment, lane move or pass', () => {
    const chatty = issue({
      closed: true,
      lane: 'Revisit',
      laneAt: '2026-08-11T19:00:00Z',
      number: 9999, // not in knownAssigned, so `assigned` would fire if it could
      comments: [human('any thoughts on this one?', { id: '77', createdAt: '2026-08-12T09:30:00Z' })],
    });
    const kinds = deriveActions(payload({ issues: [chatty] }), ctx()).map((x) => x.kind);
    expect(kinds).not.toContain('assigned');
    expect(kinds).not.toContain('comment');
    expect(kinds).not.toContain('lane-change');
    // And the send-back it IS here for survives all of that.
    expect(kinds).toContain('uat-fail');
  });

  it('does not announce a pass that closed the issue', () => {
    const passed = issue({ closed: true, comments: [human('**Test Result:** Pass')] });
    const kinds = deriveActions(payload({ issues: [passed] }), ctx()).map((x) => x.kind);
    expect(kinds).not.toContain('uat-pass');
  });

  it('still announces all of it while the issue is OPEN', () => {
    const open = issue({
      lane: 'Revisit',
      laneAt: '2026-08-11T19:00:00Z',
      number: 9999,
      comments: [human('any thoughts on this one?', { id: '77', createdAt: '2026-08-12T09:30:00Z' })],
    });
    const kinds = deriveActions(payload({ issues: [open] }), ctx()).map((x) => x.kind);
    expect(kinds).toContain('assigned');
    expect(kinds).toContain('comment');
    expect(kinds).toContain('lane-change');
  });
});

/**
 * #4914 — THE SEND-BACK THAT VANISHED FROM THE ROW WHEN SOMEBODY STARTED FIXING IT.
 *
 * What actually happened on 2026-08-21, measured off the live payload:
 *
 *  - 17:42:36  the tester posts `Test Result: Fail` and closes the issue;
 *  - 17:42:48  the card moves to `Revisit`;
 *  - 18:41:19  a colleague opens QA-fix PR #5027 — so `fixProgress` reads
 *              `inflight`, and the feed correctly demotes the fail to tier 2;
 *  - 19:02:16  the card moves on to `In review`, so `revisitSendBack` — the
 *              other, independent signal — sees nothing to report.
 *
 * `uatFailFor` matched `uat-fail` alone, so the demotion did not quieten the
 * row, it emptied it: no chip, no card, and a status sentence reading `PR #4976
 * merged — stage 9 post-merge`, which invites a QA hand-off for work QA had
 * already failed. The feed had it the whole time, at tier 2.
 */
describe('a send-back somebody is already fixing still reaches the row', () => {
  const failThenFix = () =>
    issue({
      number: 4914,
      comments: [human('Test Result: Fail\n\nPublishing shows Archived.', { id: '5373268785' })],
      // The QA fix, opened after the verdict — this is what makes it `inflight`.
      referencingPrs: [
        SHIPPED_4334,
        {
          number: 5027,
          url: 'https://github.com/example-org/example-repo/pull/5027',
          state: 'OPEN',
          createdAt: '2026-08-12T10:00:00Z',
          mergedAt: null,
          headRefName: 'fix/issue-4914-qa',
          lastCommitAt: '2026-08-12T09:59:00Z',
        },
      ],
    });

  it('is tier 2 in the feed — the demotion itself is right', () => {
    const a = deriveActions(payload({ issues: [failThenFix()] }), ctx());
    const f = a.find((x) => x.kind === 'uat-fail-inflight')!;
    expect(f).toBeDefined();
    expect(f.tier).toBe(2);
    expect(a.some((x) => x.kind === 'uat-fail')).toBe(false);
  });

  it('and the row still gets it, marked as in flight', () => {
    const a = deriveActions(payload({ issues: [failThenFix()] }), ctx());
    const row = uatFailFor(a, 4914)!;
    expect(row).not.toBeNull();
    expect(row.by).toBe('qa-alice');
    expect(row.verdict).toBe('Fail');
    expect(row.inflight).toBe(true);
  });

  it('a plain fail nobody has touched is not marked in flight', () => {
    const a = deriveActions(payload({ issues: [issue({ comments: [human('**Test Result:** Fail')] })] }), ctx());
    expect(uatFailFor(a, 4334)!.inflight).toBe(false);
  });

  it('and a pass is still no send-back at all', () => {
    const a = deriveActions(payload({ issues: [issue({ comments: [human('**Test Result:** Pass')] })] }), ctx());
    expect(uatFailFor(a, 4334)).toBeNull();
  });
});
