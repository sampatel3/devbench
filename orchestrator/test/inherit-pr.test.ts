/**
 * An issue whose fix was FOLDED INTO another issue's PR has no PR of its own.
 *
 * The console resolves a row's PR by head branch — `#prs.get(scan.branch)` — so
 * #4562, whose surplus-lines fix rode inside PR #4535 on #4344's branch, matched
 * nothing. The row fell through to `checkpoint — stopped after stage 7` and read
 * that way even after #4535 merged. Nor does it self-heal: #4535 merged into
 * `dev`, and closing keywords only fire on the default branch, so #4562 stays
 * open with no PR until it promotes to main.
 *
 * The data was already on hand — GitHub's timeline gives every PR that
 * references the issue, each with its head branch — so the fix is to resolve
 * those through the same branch map rather than invent a PullRequest.
 */
import { describe, it, expect } from 'vitest';
import { inheritPr } from '../src/status.js';
import type { PullRequest } from '../src/types.js';

const pr = (
  number: number,
  headRefName: string,
  state: string,
  mergedAt: string | null,
  closes: number[] = [],
): PullRequest => ({
  number,
  url: `https://github.com/example-org/example-repo/pull/${number}`,
  state,
  title: `pr ${number}`,
  isDraft: false,
  mergedAt,
  closes,
});

const byBranch = new Map<string, PullRequest>([
  ['feat/issue-4344-updated-policy-admin-fee-logic', pr(4535, 'feat/issue-4344-updated-policy-admin-fee-logic', 'MERGED', '2026-08-18T22:42:35Z', [4562])],
  ['fix/issue-9999-something-else', pr(9001, 'fix/issue-9999-something-else', 'OPEN', null, [4562])],
  // #5000's own work. It names #5002 in prose, as work it deliberately did not do.
  ['fix/issue-5000-fix-rating-captured-expiring-limit-never-reaches', pr(5006, 'fix/issue-5000-fix-rating-captured-expiring-limit-never-reaches', 'OPEN', null, [5000])],
]);

const ref = (number: number, headRefName: string, createdAt: string, mergedAt: string | null) => ({
  number,
  url: `https://github.com/example-org/example-repo/pull/${number}`,
  state: mergedAt ? 'MERGED' : 'OPEN',
  createdAt,
  mergedAt,
  headRefName,
  lastCommitAt: null,
});

describe('an issue folded into another issue PR still finds its PR', () => {
  it('resolves the referencing PR through the branch map — the #4562 case', () => {
    const out = inheritPr(
      [ref(4535, 'feat/issue-4344-updated-policy-admin-fee-logic', '2026-08-14T09:00:00Z', '2026-08-18T22:42:35Z')],
      byBranch,
      4562,
    );
    expect(out?.number).toBe(4535);
    expect(out?.title).toBe('pr 4535'); // the REAL PR, not a fabricated stub
    expect(out?.inherited).toBe(true); // and it says so, so no card claims it as this issue's own
  });

  it('prefers the merged referencing PR over an older open one', () => {
    const out = inheritPr(
      [
        ref(9001, 'fix/issue-9999-something-else', '2026-08-01T09:00:00Z', null),
        ref(4535, 'feat/issue-4344-updated-policy-admin-fee-logic', '2026-08-14T09:00:00Z', '2026-08-18T22:42:35Z'),
      ],
      byBranch,
      4562,
    );
    expect(out?.number).toBe(4535);
  });

  /** A PR that merely MENTIONS the issue, on a branch the console never fetched,
   *  must not become its PR — the row is better honest than wrong. */
  it('is null when no referencing PR resolves to a known branch', () => {
    expect(inheritPr([ref(7777, 'some/unknown-branch', '2026-08-14T09:00:00Z', null)], byBranch, 4562)).toBeNull();
    expect(inheritPr([], byBranch, 4562)).toBeNull();
  });

  /**
   * THE #5002 CASE. The guard above only ever excluded other people's branches:
   * every PR of ours is in the branch map by construction, so a mention from one
   * of them sailed through.
   *
   * PR #5006 is #5000's work, on #5000's branch, and names #5002 once in prose
   * as work it deliberately did not do. That mention made a cross-reference, the
   * cross-reference became #5002's PR, and an issue nobody had started read
   * `PR open`, stage 7 and "nothing for you to do" — while the board writer
   * moved its board card from `Ready` to `In review` at 15:47 on 2026-08-21.
   */
  it('refuses a PR that only MENTIONS the issue, however well known its branch', () => {
    const mention = ref(5006, 'fix/issue-5000-fix-rating-captured-expiring-limit-never-reaches', '2026-08-21T10:44:36Z', null);
    expect(inheritPr([mention], byBranch, 5002)).toBeNull();
    // And still resolves for the issue it really does close.
    expect(inheritPr([mention], byBranch, 5000)?.number).toBe(5006);
  });

  /** A PR raised on this issue's OWN branch outside the console: no fold-in, no
   *  closing keyword needed — the branch names the issue. */
  it('accepts a PR on the issue own branch even with nothing declared', () => {
    const own = new Map<string, PullRequest>([
      ['fix/issue-5002-lim-retention-tiers', pr(5099, 'fix/issue-5002-lim-retention-tiers', 'OPEN', null)],
    ]);
    const out = inheritPr([ref(5099, 'fix/issue-5002-lim-retention-tiers', '2026-08-22T09:00:00Z', null)], own, 5002);
    expect(out?.number).toBe(5099);
  });
});
