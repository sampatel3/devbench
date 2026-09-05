import {
  LEG_LABEL,
  MIN_SAMPLE,
  compare,
  humanMinutes,
  type CycleSummary,
  type LegKey,
  type Stat,
} from './cycle.js';
import type { WorkerStatus } from './types.js';

/**
 * THE AUDIT — every open issue, read against what its status claims.
 *
 * What the operator asked for: one button that reads every open issue (PR open,
 * merged, anything not closed) and validates the status each one claims, so that
 * an issue is never quietly stuck — a blocked issue has a stated reason, and a
 * status held far longer than that status usually takes gets said out loud.
 *
 * TWO VERDICTS, and the line between them is the point:
 *
 *   stuck  Nothing will move this without somebody noticing. A blocked issue
 *          nobody explained, a draft PR (a draft gets no review at all — the
 *          trap that held #4375 and #5269 at stage 7 for weeks), a dead
 *          worker, a reply that arrived and was never resumed, a board card at
 *          In progress with nothing behind it. Each is a dropped ball, not a
 *          long wait.
 *   slow   Moving, but held longer than the pack. Judged the way the Cycle
 *          panel already judges a ticket: against the MEDIAN of the leg it is
 *          in, withheld entirely below `MIN_SAMPLE` — an issue called slow
 *          against an average of two is being judged by noise.
 *
 * WHY THE LEG, and not a per-status clock. Nothing anywhere records when an
 * issue ENTERED its current status — status is derived fresh on every read —
 * so "in blocked longer than the average blocked" has no honest data behind
 * it, in either half. What the console does hold is the three cycle legs and
 * the moment each phase began: the first In progress lane move, the gate D
 * approval, the merge. So the audit asks the nearest honest question: has this
 * issue been in its current PHASE longer than the finished tickets took to
 * leave it? A blocked issue three days into a phase whose median is nine hours
 * is the long hang the operator is asking after, whatever its status is called.
 *
 * EVERY STRING LEAVES HERE FINISHED. The page composes nothing — the same
 * contract as `waiting.ts`, and for the same reason: a sentence assembled in
 * the browser is a sentence nobody reviewed.
 */

export type AuditFinding = {
  /** Which rule fired — stable, so a test can name the finding it expects. */
  key:
    | 'blocked-unexplained'
    | 'draft-pr'
    | 'worker-failed'
    | 'worker-checkpoint'
    | 'reply-unresumed'
    | 'started-nothing-behind'
    | 'past-median';
  level: 'stuck' | 'slow';
  /** The finding, as a finished sentence. */
  text: string;
};

export type IssueAudit = {
  issue: number;
  title: string;
  status: WorkerStatus;
  statusDetail: string;
  verdict: 'stuck' | 'slow' | 'ok';
  /** Empty on a row that is where it says it is. */
  findings: AuditFinding[];
  /**
   * How long this issue has been in its current phase, against the pack — a
   * finished line, with the comparison withheld below the sample floor. Null
   * when no phase has honestly begun (nothing started, nothing raised), and
   * null on a row the past-median finding already timed.
   */
  phase: string | null;
};

export type AuditReport = {
  /** When the audit ran, which is also how old its answers are. */
  at: string;
  /** Stuck first, then slow, then on pace; the longest-held first inside each. */
  issues: IssueAudit[];
  stuck: number;
  slow: number;
  ok: number;
  /** Rows you parked. Named, never judged — parking was the judgement. */
  parked: number[];
  /** The yardsticks every slow verdict used, so the panel can show its ruler. */
  summary: CycleSummary;
};

/** What the audit reads per issue. Everything here the console already holds. */
export type AuditInput = {
  number: number;
  title: string;
  status: WorkerStatus;
  statusDetail: string;
  /** Set aside by the operator — reported apart, not judged. */
  parked: boolean;
  /** What the person who applied the `blocked` label wrote. The worker's own
   *  account is not accepted here: the label's contract is that a HUMAN names
   *  the dependency, and #5674 is what the worker's version reads like. */
  blockedNote: { by: string; at: string; body: string } | null;
  prNumber: number | null;
  prIsDraft: boolean;
  /** The three phase starts, from the same joins the Cycle panel reads. */
  startedAt: string | null;
  raisedAt: string | null;
  mergedAt: string | null;
};

/**
 * Which leg an issue is currently inside — the furthest phase it has entered.
 * By milestone, not by status: a blocked issue with an open PR is blocked
 * INSIDE raised → merged, and judging it against start → PR raised would
 * compare it with the wrong pack.
 */
function phaseOf(i: AuditInput): { leg: LegKey; since: string } | null {
  if (i.mergedAt !== null) return { leg: 'toClose', since: i.mergedAt };
  if (i.raisedAt !== null) return { leg: 'toMerge', since: i.raisedAt };
  if (i.startedAt !== null) return { leg: 'toRaise', since: i.startedAt };
  return null;
}

function minutesSince(iso: string, now: number): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t > now) return null;
  return Math.round((now - t) / 60_000);
}

/** "start → PR raised: 3 d 4 h so far — median 10 h across 14 finished". */
function phaseLine(leg: LegKey, held: number, stat: Stat): string {
  const base = `${LEG_LABEL[leg]}: ${humanMinutes(held)} so far`;
  // Below the floor the figure stands on its own rather than being dressed up —
  // the same rule the cycle line on the ticket card follows.
  if (stat.medianMin === null || stat.n < MIN_SAMPLE) return base;
  return `${base} — median ${humanMinutes(stat.medianMin)} across ${stat.n} finished`;
}

function auditOne(i: AuditInput, summary: CycleSummary, now: number): IssueAudit {
  const findings: AuditFinding[] = [];

  if (i.status === 'blocked' && (i.blockedNote === null || i.blockedNote.body.trim() === '')) {
    findings.push({
      key: 'blocked-unexplained',
      level: 'stuck',
      text:
        'Blocked, and nobody has said what it is waiting on. The label asks for a comment naming ' +
        'the dependency — ask whoever applied it to write one.',
    });
  }

  if (i.status === 'pr-open' && i.prIsDraft) {
    findings.push({
      key: 'draft-pr',
      level: 'stuck',
      text:
        `PR #${i.prNumber} is a draft, and a draft gets no review at all — no reviewer is assigned ` +
        'and none will be by waiting. Mark it ready.',
    });
  }

  if (i.status === 'failed') {
    findings.push({
      key: 'worker-failed',
      level: 'stuck',
      text: 'The worker errored and nothing is running. Restart it, or take the issue over.',
    });
  }

  if (i.status === 'checkpoint') {
    findings.push({
      key: 'worker-checkpoint',
      level: 'stuck',
      text: 'The worker stopped without reaching a gate. Nothing moves until it is resumed.',
    });
  }

  if (i.status === 'reply-received') {
    findings.push({
      key: 'reply-unresumed',
      level: 'stuck',
      text: 'The reply this was waiting on has arrived, and the worker has not been resumed to read it.',
    });
  }

  // The board says In progress; the console has nothing behind it — no worker,
  // no queue entry, no PR ever raised. This is how work goes quietly missing:
  // the lane move is the only trace it ever started.
  if (i.status === 'no-worker' && i.startedAt !== null && i.raisedAt === null && i.mergedAt === null) {
    findings.push({
      key: 'started-nothing-behind',
      level: 'stuck',
      text: 'The board has had this In progress since the work began, and nothing is behind it any more — no worker, no queue entry, no PR.',
    });
  }

  const phase = phaseOf(i);
  const held = phase === null ? null : minutesSince(phase.since, now);
  let pastMedian = false;
  if (phase !== null && held !== null && compare(held, summary[phase.leg]) === 'slower') {
    const stat = summary[phase.leg];
    pastMedian = true;
    findings.push({
      key: 'past-median',
      level: 'slow',
      text:
        `In ${LEG_LABEL[phase.leg]} for ${humanMinutes(held)} — the ${stat.n} tickets that finished ` +
        `this leg took a median of ${humanMinutes(stat.medianMin)}.`,
    });
  }

  const verdict = findings.some((f) => f.level === 'stuck')
    ? 'stuck'
    : findings.some((f) => f.level === 'slow')
      ? 'slow'
      : 'ok';

  return {
    issue: i.number,
    title: i.title,
    status: i.status,
    statusDetail: i.statusDetail,
    verdict,
    findings,
    // Withheld when the past-median finding fired: that sentence already
    // carries the same numbers, and a line said twice reads like two facts.
    phase:
      phase === null || held === null || pastMedian ? null : phaseLine(phase.leg, held, summary[phase.leg]),
  };
}

const RANK: Record<IssueAudit['verdict'], number> = { stuck: 0, slow: 1, ok: 2 };

/**
 * The whole report. `inputs` is every OPEN row — closed issues have nothing to
 * validate and are the caller's to exclude, as is anything not the operator's.
 */
export function auditIssues(
  inputs: readonly AuditInput[],
  summary: CycleSummary,
  now: number = Date.now(),
): AuditReport {
  const parked = inputs.filter((i) => i.parked).map((i) => i.number);
  const heldOf = (i: AuditInput): number => {
    const phase = phaseOf(i);
    return phase === null ? -1 : (minutesSince(phase.since, now) ?? -1);
  };
  const issues = inputs
    .filter((i) => !i.parked)
    .map((i) => ({ audit: auditOne(i, summary, now), held: heldOf(i) }))
    .sort(
      (a, b) =>
        RANK[a.audit.verdict] - RANK[b.audit.verdict] ||
        b.held - a.held ||
        b.audit.issue - a.audit.issue,
    )
    .map((x) => x.audit);
  return {
    at: new Date(now).toISOString(),
    issues,
    stuck: issues.filter((i) => i.verdict === 'stuck').length,
    slow: issues.filter((i) => i.verdict === 'slow').length,
    ok: issues.filter((i) => i.verdict === 'ok').length,
    parked,
    summary,
  };
}
