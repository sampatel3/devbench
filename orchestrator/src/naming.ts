/**
 * Branch names, by the worker skill's rules:
 *   - `fix/issue-<N>-<slug>` for bugs, `feat/issue-<N>-<slug>` for features
 *   - never `feature/*` — the preview workflow's branch glob misses it
 *   - always the issue number — board automation parses it out of the branch
 *
 * The repo's own git-new-worktree.sh names the directory after the last path
 * segment of the branch, so `fix/issue-4400-x` lands in `.worktrees/issue-4400-x`,
 * which is exactly what the worktree scanner expects to read the number back out of.
 */

const MAX_SLUG = 48;
const FEATURE_LABELS = new Set(['feature', 'enhancement']);

export function slugFromTitle(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean);

  if (words.length === 0) return 'issue';

  const out: string[] = [];
  let len = 0;
  for (const w of words) {
    const next = len === 0 ? w.length : len + 1 + w.length;
    if (next > MAX_SLUG) break;
    out.push(w);
    len = next;
  }
  // A single word longer than the cap still has to come through.
  return out.length ? out.join('-') : words[0]!.slice(0, MAX_SLUG);
}

export function branchNameFor(issue: { number: number; title: string; labels: string[] }): string {
  const isFeature = issue.labels.some((l) => FEATURE_LABELS.has(l.toLowerCase()));
  const prefix = isFeature ? 'feat' : 'fix';
  return `${prefix}/issue-${issue.number}-${slugFromTitle(issue.title)}`;
}

export function worktreeDirFor(branch: string): string {
  return branch.slice(branch.lastIndexOf('/') + 1);
}

/**
 * The issue number back out of a branch name — the same read the board automation
 * does, and the only one available for a PR: `closingIssuesReferences` is empty on
 * this repo's feature PRs, because they target `dev` rather than the default
 * branch and GitHub only links closing references there.
 */
export function issueFromBranch(branch: string): number | null {
  const m = /(?:^|\/)issue-(\d+)(?:-|$)/.exec(branch);
  return m ? Number(m[1]) : null;
}
