import { beforeEach, vi } from 'vitest';
import * as gh from '../../src/gh.js';

/**
 * NO TEST TALKS TO GITHUB. This file is what makes that true rather than hoped.
 *
 * The poll reads GitHub, so every test that polls has always had to stub the
 * `gh` functions it uses — the convention `probeResources` already follows for
 * the machine ("unstubbed, every poll shelled out to the real `docker stats`").
 * Adding the actions omnibus to the poll broke that convention silently: sixty
 * test files that had stubbed `listIssues`, `listOpenPrs` and the rest knew
 * nothing about two new calls, so the suite started spawning real `gh api
 * graphql` against the live repository — and it was measurable, in the graphql
 * quota, before anything failed. What failed first was five worker tests timing
 * out, because a network round trip had been added to every poll.
 *
 * So the two new reads are stubbed inert HERE, for every test, in a `beforeEach`
 * that re-applies after each file's own `vi.restoreAllMocks()`. A test that
 * wants them overrides with its own `vi.spyOn` as usual — `actions-poll.test.ts`
 * does exactly that.
 *
 * Inert means: no quota reading (so the brake stands aside) and an empty
 * payload (so the feed derives to nothing). It never means "throw", because a
 * throw would make every unrelated test's feed read `stale` and the failure
 * would look like a bug in the feature rather than a missing stub.
 */
beforeEach(() => {
  vi.spyOn(gh, 'readGraphqlQuota').mockResolvedValue(null);
  // The orphan read is the same story: a poll asks GitHub about every worktree
  // whose issue is not in the open list, which in a test fixture is often all of
  // them. Inert means an EMPTY map — "not read" — which is what makes the
  // synthesized row fall back to the placeholder sentence, exactly as it did
  // before this read existed. A test about the reason overrides it.
  vi.spyOn(gh, 'describeIssues').mockResolvedValue(new Map());
  // And the read behind a `blocked` row's reason. Inert means null — nobody has
  // said why — which is what sends the row back to the worker's own summary,
  // exactly as it behaved before this read existed.
  vi.spyOn(gh, 'readBlockedNote').mockResolvedValue(null);
  vi.spyOn(gh, 'fetchActionsOnMe').mockResolvedValue({
    issues: [],
    prs: [],
    reviewRequested: [],
    mentions: [],
    merged: [],
    quota: null,
    truncated: null,
  });
});
