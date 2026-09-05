/**
 * The two GitHub writes a worker may no longer make, drafted so the operator can
 * make them in one click.
 *
 * The write fence denies `gh issue create` and every board move. That is the
 * right call — an autoassign workflow stamps the filer as assignee and moves the
 * issue to `Ready`, so an issue a worker files does not go to triage, it becomes
 * the operator's assigned work looking exactly like something the team asked
 * for. #4562 arrived that way, under their own account, against an explicit
 * instruction.
 *
 * But a fence with no way forward just moves the cost: the worker stops and asks,
 * and the round trip is paid anyway. So the worker writes a complete draft and
 * the console renders it as a single link.
 *
 * **The console still writes nothing.** `newIssueUrl` opens GitHub's own
 * new-issue form with the fields already filled in; the operator presses Submit
 * there, on GitHub, as themselves. `gh.ts` stays read-only and `comment.ts`
 * stays the only thing in this console that posts anything.
 */

export type IssueRecommendation = 'fold' | 'separate';

export type IssueRequest = {
  /** The base issue whose work exposed this related finding. Null in older drafts. */
  fromIssue: number | null;
  title: string;
  body: string;
  labels: string[];
  boardLane: string | null;
  /** The concrete sweep hit, test, trace, or evidence that exposed the finding. */
  identifiedHow: string;
  /** How the finding shares a mechanism, behaviour, surface, or dependency with the base issue. */
  relationship: string;
  /** The worker's proposed disposition. Null for legacy or malformed drafts. */
  recommendation: IssueRecommendation | null;
  /** Why the proposed disposition is safer or cheaper than the alternative. */
  recommendationWhy: string;
  /** @deprecated Compatibility alias for older UI builds. */
  why: string;
  sessionId: string | null;
};

export type BoardRequest = {
  issue: number;
  /** The lane the worker believes it should be in. */
  lane: string;
  /** What it actually read off the card, or null if it could not read it. */
  currentLane: string | null;
  why: string;
  sessionId: string | null;
};

/**
 * The lanes the board actually has, read off its live Status field rather than
 * imagined. A guess on a board the operator reads at a glance is worse than an
 * admission.
 *
 * This list was wrong once: it carried `Icebox`, which the board does not have, and
 * was missing `Planned`, `Revisit` and `In review` — so a worker correctly reporting
 * `currentLane: 'In review'` had it silently nulled to "could not read it". If your
 * board's Status field uses other names, this is the list to edit.
 *
 * These three fields are DISPLAY ONLY. None of them reaches the code that actually
 * moves a card: see board.ts, whose destination is a literal and whose current lane
 * comes from a fresh read, never from this file.
 */
const LANES = ['Backlog', 'Planned', 'Ready', 'Revisit', 'In progress', 'In review', 'QA', 'Done'];

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function json(raw: string): Record<string, unknown> | null {
  try {
    const o: unknown = JSON.parse(raw);
    return typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Null unless there is genuinely an issue to file: a title and a body. */
export function parseIssueRequest(raw: string): IssueRequest | null {
  const r = json(raw);
  if (!r) return null;
  const title = str(r.title);
  const body = str(r.draftBody);
  if (!title || !body) return null;
  const recommendation: IssueRecommendation | null =
    r.recommendation === 'fold' || r.recommendation === 'separate' ? r.recommendation : null;
  const recommendationWhy = str(r.recommendationWhy) || str(r.why);

  return {
    fromIssue: typeof r.fromIssue === 'number' ? r.fromIssue : null,
    title,
    body,
    labels: Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === 'string' && l.trim() !== '') : [],
    boardLane: LANES.includes(str(r.boardLane)) ? str(r.boardLane) : null,
    identifiedHow: str(r.identifiedHow),
    relationship: str(r.relationship),
    recommendation,
    recommendationWhy,
    why: recommendationWhy,
    sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
  };
}

/** Null unless the draft names both an issue and a lane to move it to. */
export function parseBoardRequest(raw: string): BoardRequest | null {
  const r = json(raw);
  if (!r) return null;
  const lane = str(r.lane);
  if (typeof r.issue !== 'number' || !lane) return null;

  return {
    issue: r.issue,
    lane,
    currentLane: LANES.includes(str(r.currentLane)) ? str(r.currentLane) : null,
    why: str(r.why),
    sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
  };
}

/**
 * The issue body used by both filing paths.
 *
 * The worktree identifies the base issue, and the structured context explains
 * why this related finding exists before the worker's full draft begins. One
 * builder keeps the console-side File action and GitHub's prefilled form from
 * creating differently linked issues.
 */
export function spinOffBody(r: IssueRequest): string {
  const parts: string[] = [];
  if (r.fromIssue !== null) {
    parts.push(`Spun off from #${r.fromIssue}.`);
    if (r.identifiedHow?.trim()) parts.push(`**How it was identified:** ${r.identifiedHow.trim()}`);
    if (r.relationship?.trim()) {
      parts.push(`**How it relates to #${r.fromIssue}:** ${r.relationship.trim()}`);
    }
    if (r.recommendation !== null) {
      const action = r.recommendation === 'fold' ? `Fold into #${r.fromIssue}` : 'File separately';
      const why = r.recommendationWhy?.trim() ? ` ${r.recommendationWhy.trim()}` : '';
      parts.push(`**Worker recommendation:** ${action}.${why}`);
    } else if (r.why?.trim()) {
      // Older drafts had only `why`, whose contract was specifically a reason
      // for separation. Keep that meaning instead of pretending they carried a
      // structured recommendation.
      parts.push(`**Why it is separate:** ${r.why.trim()}`);
    }
    parts.push('---');
  }
  parts.push(r.body);
  return parts.join('\n\n');
}

/** Browsers and GitHub both stop caring somewhere past 8k; stay well under. */
const MAX_URL = 7500;

/**
 * GitHub's own new-issue form, prefilled. One click for the operator, no write for us.
 *
 * A body too long to carry in a query string is TRIMMED VISIBLY rather than
 * silently: a draft that arrives half-there, with nothing saying so, is how a
 * spin-off ends up missing the reproduction that justified it.
 */
/**
 * GITHUB'S OWN NEW-ISSUE FORM, FILLED IN. The primitive both callers share.
 *
 * Extracted from `newIssueUrl` when the Sentry panel needed the same trick for
 * a draft that is not an `IssueRequest`: a spin-off a worker drafted and a
 * ticket for a Sentry error are different things, and faking the worker's shape
 * to reuse the URL builder would have put five empty fields into a type whose
 * whole job is to carry them.
 *
 * `assignees` is here because GitHub's form takes it alongside `labels`, so a
 * prefilled ticket can arrive already assigned — one of the four steps the operator
 * does by hand on every Sentry issue. Only a collaborator can be assigned, and a
 * name GitHub will not accept is ignored by the form rather than rejected,
 * which is why it is safe to pass without checking first.
 *
 * `trimNote` is what a body too long for a URL is told; each caller knows where
 * the untrimmed version lives, and neither should have to guess for the other.
 */
export function prefilledIssueUrl(
  repo: string,
  draft: { title: string; body: string; labels: string[] },
  opts: { assignees?: string[]; trimNote?: string } = {},
): string {
  const base = `https://github.com/${repo}/issues/new`;
  const build = (body: string) => {
    const q = new URLSearchParams({ title: draft.title, body });
    if (draft.labels.length) q.set('labels', draft.labels.join(','));
    if (opts.assignees?.length) q.set('assignees', opts.assignees.join(','));
    return `${base}?${q.toString()}`;
  };

  const full = build(draft.body);
  if (full.length <= MAX_URL) return full;

  const note = opts.trimNote ?? '\n\n_(Body trimmed to fit this link.)_';
  // Binary-search-free: shrink until it fits, cheaply and predictably.
  let keep = draft.body.length;
  let url = full;
  while (url.length > MAX_URL && keep > 0) {
    keep = Math.floor(keep * 0.8);
    url = build(draft.body.slice(0, keep) + note);
  }
  return url;
}

export function newIssueUrl(repo: string, r: IssueRequest, assignees: string[] = []): string {
  return prefilledIssueUrl(
    repo,
    { title: r.title, body: spinOffBody(r), labels: r.labels },
    {
      assignees,
      trimNote:
        '\n\n_(Body trimmed to fit this link — the full draft is in `.issue-request.json` in the worktree.)_',
    },
  );
}

/**
 * The board itself, where the move is actually made.
 *
 * `projectNumber` is `boardProjectNumber` from the config, and NULL means no
 * board is configured — the link then goes to the org's project list rather
 * than inventing a project number that would open somebody else's board.
 */
export function boardUrl(owner: string, projectNumber: number | null = null): string {
  const base = `https://github.com/orgs/${owner}/projects`;
  return projectNumber === null ? base : `${base}/${projectNumber}`;
}
