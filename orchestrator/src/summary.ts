import type { GateLetter, IssueRow } from './types.js';
import { issueFromBranch } from './naming.js';

/**
 * The status summary: one plain-text post in the house format a team already
 * uses in Slack — section headings, one bullet per item, issue number, short
 * title, status, bare PR link.
 *
 * This file is a FORMATTER. Everything it needs is handed to it, so it is tested
 * without gh: the console's own rows say what is waiting on a person, and the
 * windowed GitHub reads say what closed, merged and is in review.
 *
 * Three rules the format itself enforces:
 *
 *  - a section with nothing in it is left out entirely — an empty heading under a
 *    status post reads as noise, not as news;
 *  - a section we could not READ says so, in the text. A failed fetch printed as
 *    an empty section would say "nothing happened" when the truth is "we do not
 *    know", and this console does not tell that kind of lie;
 *  - every assigned issue comes out somewhere. The sections are matched by what
 *    they are ABOUT, so a status none of them names would otherwise vanish from
 *    the post — which is the same lie again. "In progress" is the catch-all, and
 *    it is fed by subtraction rather than by a list of statuses, so it cannot go
 *    stale when a new status is added.
 */

export type SummaryWindow = 'daily' | 'weekly' | 'monthly';

export const WINDOW_DAYS: Record<SummaryWindow, number> = { daily: 1, weekly: 7, monthly: 30 };
export const WINDOW_LABEL: Record<SummaryWindow, string> = {
  daily: 'last 24 hours',
  weekly: 'last 7 days',
  monthly: 'last 30 days',
};

export function isSummaryWindow(value: unknown): value is SummaryWindow {
  return value === 'daily' || value === 'weekly' || value === 'monthly';
}

/** The cutoff for a window, counted back from now at request time. */
export function windowStart(window: SummaryWindow, nowIso: string): string {
  return new Date(Date.parse(nowIso) - WINDOW_DAYS[window] * 86_400_000).toISOString();
}

/** A list we tried to fetch. A non-null `error` is printed in the section rather
 *  than swallowed — see the honesty rule above. */
export type Fetched<T> = { items: T[]; error: string | null };

export type ClosedIssue = { number: number; title: string; closedAt: string };
export type MergedPr = { number: number; title: string; url: string; mergedAt: string; headRefName: string };
export type OpenPr = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  isDraft: boolean;
  reviewDecision: string;
  labels: string[];
  /** GitHub's status rollup: CheckRun rows carry status+conclusion, StatusContext rows a state. */
  checks: Array<{ status: string; conclusion: string; state: string }>;
};

export type SummarySection = { heading: string; items: string[] };
export type SummaryResult = { markdown: string; sections: SummarySection[] };

/** What `GET /api/summary` answers with: the post itself, plus what it is a post
 *  OF, plus anything we could not read while building it. */
export type SummaryPayload = SummaryResult & {
  window: SummaryWindow;
  generatedAt: string;
  warnings: string[];
};

export type SummaryInput = {
  window: SummaryWindow;
  /** ISO, taken once at request time — it stamps the header and bounds the window. */
  generatedAt: string;
  /** The console's own state: where "waiting on a person" and "no worker" come from. */
  rows: IssueRow[];
  /** Open assigned issues, so an issue whose PR merged can be shown as still in QA. */
  openIssues: Array<{ number: number; title: string }>;
  closedIssues: Fetched<ClosedIssue>;
  mergedPrs: Fetched<MergedPr>;
  openPrs: Fetched<OpenPr>;
};

/** What each gate actually asks, so a blocked line says what the person has to do. */
const GATE_ASK: Record<GateLetter, string> = {
  A: 'scope',
  B: 'plan',
  C: 'QA + comprehension',
  D: 'raising the PR',
  E: 'merge',
};

/** The repo's own label for "the automated panel deferred to a human". */
export const HUMAN_REVIEW_LABEL = 'human-review-needed';

/**
 * The repo's whole priority axis. An issue with none of these has not been
 * ranked, which is the same thing its `needs-triage` label says — the label is
 * applied *because* priority was left off. The UI keeps its own copy of this axis
 * (ui/src/priority.ts) because the two sides share no code; they must agree.
 */
const PRIORITY_LABELS = new Set(['p0', 'p1', 'p2', 'p3', 'icebox']);

function awaitingTriage(labels: string[]): boolean {
  return !labels.some((l) => PRIORITY_LABELS.has(l.trim().toLowerCase()));
}

const BULLET = '•';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "11 Aug 2026, 14:32", in this laptop's own clock — the summary is written here
 *  and pasted from here, so local time is the honest one to stamp on it. */
function stamp(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

/** One item line: the pieces joined the way the house format joins them. */
function item(...parts: Array<string | null>): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(' — ');
}

/**
 * The issue a PR belongs to. `closingIssuesReferences` is empty on this repo's
 * feature PRs — they target `dev`, not the default branch, so GitHub never links
 * them — which is exactly why every branch embeds its issue number. Same source
 * the board automation reads.
 */
function prIssue(pr: { headRefName: string }): number | null {
  return issueFromBranch(pr.headRefName);
}

/** `(#4336)` after the title, unless the title already cites it (they usually do). */
function citation(title: string, issue: number | null): string | null {
  if (issue === null) return null;
  return title.includes(`#${issue}`) ? null : `(#${issue})`;
}

/** Where CI stands, in three words. Null when the PR has no checks at all. */
export function ciNote(checks: OpenPr['checks']): string | null {
  if (checks.length === 0) return null;
  const verdict = (c: OpenPr['checks'][number]) => c.conclusion || c.state;
  const bad = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
  if (checks.some((c) => bad.has(verdict(c)))) return 'CI failing';
  if (checks.some((c) => (c.status && c.status !== 'COMPLETED') || verdict(c) === 'PENDING' || verdict(c) === 'EXPECTED')) {
    return 'CI running';
  }
  return 'CI green';
}

/** Where the review stands, in plain English. */
function reviewNote(pr: OpenPr): string | null {
  // "draft, review pending" reads as though a review were on its way. Nothing is
  // pending on a draft: GitHub requests no codeowner and fires no review
  // workflow until it is marked ready, so the draft marker beside this is the
  // whole story and a second clause could only soften it.
  if (pr.isDraft) return null;
  if (pr.labels.includes(HUMAN_REVIEW_LABEL)) return 'awaiting a human reviewer';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested';
  if (pr.reviewDecision === 'APPROVED') return 'approved';
  return 'review pending';
}

/** An open PR is still waiting on a person while nobody has approved it.
 *
 *  A DRAFT IS NOT ONE OF THEM — it is waiting on you, and `blockingReason` says
 *  so above this. The guard is here as well as there because this predicate
 *  reads as a general question and would otherwise answer the draft case wrongly
 *  at the next call site somebody adds. */
function needsApprovingReview(pr: OpenPr): boolean {
  if (pr.isDraft) return false;
  return pr.labels.includes(HUMAN_REVIEW_LABEL) || pr.reviewDecision !== 'APPROVED';
}

export type WaitingItem = { number: number; title: string; reason: string };

/**
 * Everything parked on a person, and which person. The order of the checks is
 * deriveStatus's own precedence — a gate outranks a PR, because a gate is
 * somebody standing still — so one row produces at most one line.
 */
export function waitingOnAPerson(rows: IssueRow[], openPrs: OpenPr[]): WaitingItem[] {
  const out: WaitingItem[] = [];
  for (const row of rows) {
    const reason = blockingReason(row, openPrs);
    if (reason) out.push({ number: row.number, title: row.title, reason });
  }
  return out;
}

function blockingReason(row: IssueRow, openPrs: OpenPr[]): string | null {
  if (row.status === 'at-gate' && row.gate) {
    return `waiting on you — gate ${row.gate.gate} (${GATE_ASK[row.gate.gate]})`;
  }
  if (row.status === 'awaiting-post' && row.commentRequest) {
    return `drafted a comment for ${row.commentRequest.addressee || 'the ticket'} — waiting on you to post it`;
  }
  if (row.status === 'reply-received' && row.commentBlock?.reply) {
    return `${row.commentBlock.reply.author} replied — waiting on you to resume the worker`;
  }
  if (row.status === 'rework' && row.reviewBlock) {
    const round = row.reviewBlock.rounds[row.reviewBlock.rounds.length - 1];
    const pr = row.pr?.url ?? null;
    return item(`changes requested by ${round?.reviewer || 'a reviewer'} — rework not started`, pr);
  }
  if (row.status === 'blocked' && row.commentBlock) {
    return `blocked — awaiting reply from ${row.commentBlock.addressee || 'a third party'}`;
  }
  if (row.status === 'detached') return 'taken over in a terminal';
  // Frozen to give the machine its memory back. Nothing about it moves until a
  // person resumes it, and it holds its slot while it waits — so leaving it out
  // of this list would be the console comforting rather than reporting.
  if (row.status === 'paused' && row.paused) {
    const who = row.paused.by === 'floor' ? 'the memory floor paused it' : 'you paused it';
    return `${who} — waiting on you to resume it (nothing is lost)`;
  }

  // The machine has it: nobody is waiting on a person while a worker is moving.
  if (row.status === 'active' || row.status === 'queued' || row.status === 'preparing') return null;

  const pr = openPrs.find((p) => prIssue(p) === row.number) ?? null;

  // A DRAFT IS ON HIM, and this section is the one that gets pasted into Slack.
  // Filed under "awaiting approving review (codeowner)" it read as work the team
  // owed him — which is how #4375 and #5269 were reported as in-flight, week
  // after week, while no reviewer had been asked and none would be.
  if (pr?.isDraft) {
    return item(`waiting on you — PR #${pr.number} is still a draft, so nobody can review it`, pr.url);
  }

  // Nothing local is holding it, but the PR is: nobody has approved it yet. This
  // repo's panel never approves — it labels `human-review-needed` — so an open PR
  // sitting there is a codeowner's turn, not ours.
  if (pr && needsApprovingReview(pr)) {
    return item('awaiting approving review (codeowner)', pr.url);
  }
  return null;
}

/**
 * The marker on backlog this machine raised and nobody has triaged.
 *
 * It costs a few words in a section that is otherwise one line per issue, and it
 * is worth them: this post gets pasted into Slack, and an issue a worker spun off
 * — auto-assigned straight back by the repo's workflow — would otherwise sit in
 * "No worker / not started" reading exactly like work the team agreed to. Being
 * honest about where a backlog item came from matters more here than being short.
 */
function provenanceMarker(row: IssueRow): string {
  return row.selfFiled && awaitingTriage(row.labels) ? ' (self-filed, needs triage)' : '';
}

/** A section, unless there is nothing in it. A failed fetch is not nothing. */
function section(heading: string, items: string[], error: string | null): SummarySection | null {
  if (error) return { heading, items: [`could not fetch — ${error}`] };
  if (items.length === 0) return null;
  return { heading, items };
}

const byNumberDesc = <T extends { number: number }>(a: T, b: T) => b.number - a.number;

/** What a mid-flight row says about itself: its own status detail, and its stage
 *  when the detail does not already carry it ("stopped after stage 0" does). */
function progressNote(row: IssueRow): string {
  const detail = row.statusDetail || row.status;
  const stage = row.stage !== null && !detail.includes(`stage ${row.stage}`) ? `stage ${row.stage}` : null;
  return item(detail, stage);
}

export function buildSummary(input: SummaryInput): SummaryResult {
  const openPrs = input.openPrs.items;
  const openIssues = new Map(input.openIssues.map((i) => [i.number, i.title]));

  const waitingItems = waitingOnAPerson(input.rows, openPrs);
  const waiting = waitingItems.map((w) => item(`#${w.number}`, w.title, w.reason));

  const closed = [...input.closedIssues.items]
    .sort(byNumberDesc)
    .map((i) => item(`#${i.number}`, i.title));

  const merged = [...input.mergedPrs.items].sort(byNumberDesc).map((pr) => {
    const issue = prIssue(pr);
    return item(`#${pr.number}`, [pr.title, citation(pr.title, issue)].filter(Boolean).join(' '), pr.url);
  });

  const inReview = [...openPrs].sort(byNumberDesc).map((pr) => {
    const issue = prIssue(pr);
    const notes = [pr.isDraft ? 'draft — not in review until it is marked ready' : null, reviewNote(pr), ciNote(pr.checks)]
      .filter(Boolean)
      .join(', ');
    return item(`#${pr.number}`, [pr.title, citation(pr.title, issue)].filter(Boolean).join(' '), notes, pr.url);
  });

  // The repo's QA limbo: the PR is merged, the issue is not closed. Drawn from the
  // PRs merged in this window, so it is a window view, not the whole backlog.
  const inQaNumbers = [...input.mergedPrs.items]
    .map((pr) => prIssue(pr))
    .filter((n): n is number => n !== null && openIssues.has(n))
    .filter((n, i, all) => all.indexOf(n) === i)
    .sort((a, b) => b - a);
  const inQa = inQaNumbers.map((n) => item(`#${n}`, openIssues.get(n)!));

  const notStartedRows = input.rows.filter((r) => r.status === 'no-worker').sort(byNumberDesc);
  const notStarted = notStartedRows.map((r) => item(`#${r.number}`, r.title) + provenanceMarker(r));

  // Which issues the sections above have already spoken for. Collected from the
  // items themselves, never from a list of statuses, so nothing has to be kept in
  // step: a section that could not be read has no items and therefore covers
  // nothing, which is the honest answer.
  const covered = new Set(
    [
      ...waitingItems.map((w) => w.number),
      ...input.closedIssues.items.map((i) => i.number),
      ...input.mergedPrs.items.map((pr) => prIssue(pr)),
      ...openPrs.map((pr) => prIssue(pr)),
      ...inQaNumbers,
      ...notStartedRows.map((r) => r.number),
    ].filter((n): n is number => n !== null),
  );

  // The catch-all, and the reason nothing can fall out of this post: work that is
  // genuinely moving (or stalled part-way) and is not parked on a person. It is
  // what is LEFT, not what matches a status, so a status added tomorrow lands here
  // rather than nowhere.
  const inProgress = input.rows
    .filter((r) => !covered.has(r.number))
    .sort(byNumberDesc)
    .map((r) => item(`#${r.number}`, r.title, progressNote(r)));

  const sections = [
    // First when it has anything in it: this is the part somebody has to act on.
    section('Waiting on a person', waiting, null),
    section('Issues Closed', closed, input.closedIssues.error),
    section('PRs Merged', merged, input.mergedPrs.error),
    section('PRs In Review', inReview, input.openPrs.error),
    section('In QA (awaiting verification, open)', inQa, null),
    section('In progress', inProgress, null),
    section('No worker / not started', notStarted, null),
  ].filter((s): s is SummarySection => s !== null);

  const header = `Status — ${WINDOW_LABEL[input.window]} (${stamp(input.generatedAt)})`;
  const body = sections.map((s) => [s.heading, ...s.items.map((i) => `${BULLET} ${i}`)].join('\n'));
  const blocks = body.length > 0 ? body : ['Nothing to report in this window.'];

  return { markdown: [header, ...blocks].join('\n\n') + '\n', sections };
}
