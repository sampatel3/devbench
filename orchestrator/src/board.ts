import { execFile } from 'node:child_process';

/**
 * Moving the board card, without asking the operator.
 *
 * The rule: once a ticket starts it moves to In progress; once a PR is submitted
 * for review it moves to In review. A card sitting in Backlog may also be moved
 * on, but ONLY when the operator raised the issue themselves.
 *
 * "Raised it themselves" is GitHub's issue author, and a prefilled issue they
 * clicked Submit on counts — they decided it should exist. So the check is simply
 * `issue.author === <the operator's login>`, and it only guards the Backlog cases,
 * because those are the ones where the team may have parked something
 * deliberately.
 *
 * The other gate is that the console is tracking a worktree for this issue —
 * which it only ever is because the operator asked for one. A card is never
 * touched for an issue nobody is working.
 *
 * TWO EARLIER MISTAKES THIS REPLACES.
 *
 * The first: `In review` was not on the allowed list at all, so the second half
 * of the rule could never have worked however it was triggered.
 *
 * The second, and worse: the guard read "one automatic move per issue, EVER". It
 * was written that way so dragging a card back could never start a fight — and it
 * also meant a card moved to `In progress` could never move again, to any lane, for
 * the life of the state file. #4404, #4344 and #4329 all sat on `In progress`
 * with open PRs because of it. The guard is now per MILESTONE: each one fires
 * once, and moving a card back still sticks, because the milestone that moved it
 * is already spent.
 *
 * Both milestones are facts the CONSOLE already holds. Neither waits for a worker
 * to draft anything, which is one less moving part and one less thing to go
 * stale:
 *
 *   started  — a worker has run on this issue     -> In progress
 *   pr-open  — a pull request is open for it      -> In review
 *
 * Everything past that is a claim rather than a fact. `QA` says the work is ready
 * to be verified, and that stays the operator's card to click.
 */

/** What the console noticed. One automatic move each, per issue. */
export type Milestone = 'started' | 'pr-open';

const LANE_FOR: Record<Milestone, string> = {
  started: 'In progress',
  'pr-open': 'In review',
};

/** Lanes a milestone may write. Nothing else is ever written automatically. */
const ALLOWED_DEST = new Set(Object.values(LANE_FOR));
export const BOARD_DEST = 'In progress';

/**
 * Lanes the console will not move a card OUT of, because a human put it there
 * and it means something the console cannot see. `QA` means somebody is testing;
 * `Done` and `Revisit` are verdicts.
 */
const TERMINAL = new Set(['QA', 'Done', 'Revisit']);

/**
 * The lanes in lifecycle order. A milestone may move a card FORWARD along this
 * and never back — #4596 went `In review` → `In progress` because `pr-open`
 * resolved on one poll and `started` fired on the next, dragging it backwards.
 * Milestones do not arrive in order, so the ordering has to be enforced here
 * rather than assumed from the sequence they are checked in.
 */
const LANE_ORDER = ['Backlog', 'Planned', 'Ready', 'In progress', 'In review', 'QA', 'Done'];
const rank = (lane: string): number => LANE_ORDER.indexOf(lane);

export type BoardFacts = {
  issue: number;
  /** Which milestone the console just noticed. */
  milestone: Milestone;
  /** GitHub says the operator opened this issue — the "if I raised it" clause. */
  createdByHim: boolean;
  /** Not in the open assigned list any more. */
  issueClosed: boolean;
  /** THIS milestone has already been applied to THIS issue. */
  alreadyDecided: boolean;
  /**
   * One fresh read of the card, taken in the same call as the write — never a
   * value that survived a poll boundary, because a stale lane aims a write wrong.
   */
  card: { lane: string; optionIdByName: Readonly<Record<string, string>> } | null;
};

export type BoardDecision =
  | { act: 'move'; optionId: string; to: string; spend: true; reason: string }
  | { act: 'record'; spend: true; reason: string }
  | { act: 'card'; spend: false; reason: string }
  | { act: 'none'; spend: false; reason: string };

export function decideBoardMove(f: BoardFacts): BoardDecision {
  // This milestone has fired. It never fires twice, which is what makes moving a
  // card back stick — but the NEXT milestone is still free to move it on.
  if (f.alreadyDecided) {
    return { act: 'none', spend: false, reason: `the ${f.milestone} move has already been made` };
  }

  if (f.issueClosed) return { act: 'card', spend: false, reason: 'this issue is closed — nothing to move' };

  // Fail CLOSED. This codebase keeps the last good value when a read fails, which
  // is right for a label and wrong for a write.
  if (f.card === null) return { act: 'card', spend: false, reason: 'could not read the board card just now' };

  const to = LANE_FOR[f.milestone];
  if (!ALLOWED_DEST.has(to)) return { act: 'card', spend: false, reason: `${to} is not an automatic lane` };

  // A human put it here and it means something the console cannot see: QA is
  // somebody testing, Done and Revisit are verdicts. Never drag a card out.
  if (TERMINAL.has(f.card.lane)) {
    return { act: 'none', spend: false, reason: `the card is on ${f.card.lane} — a person put it there` };
  }

  // The Backlog guard, and the only place "I raised it" is consulted. A card the
  // TEAM parked in Backlog is their triage decision, not the console's to override.
  if (f.card.lane === 'Backlog' && !f.createdByHim) {
    return { act: 'card', spend: false, reason: 'the team put this in Backlog and you did not raise it' };
  }

  // Never backwards. A card already further along than this milestone would put
  // it has been moved on by something that knows more than we do — the next
  // milestone, a person, or the team.
  const here = rank(f.card.lane);
  const there = rank(to);
  if (here !== -1 && there !== -1 && here > there) {
    return { act: 'record', spend: true, reason: `already past ${to} — on ${f.card.lane}` };
  }

  if (f.card.lane === to) {
    // Somebody got there first. Spend the milestone anyway, or parking it back
    // later would be met by the console moving it forward again.
    return { act: 'record', spend: true, reason: `already ${to} — nothing to write` };
  }

  const optionId = f.card.optionIdByName[to];
  if (optionId === undefined) return { act: 'card', spend: false, reason: `the board has no ${to} lane` };

  return { act: 'move', optionId, to, spend: true, reason: `moved to ${to}` };
}

// ------------------------------------------------------------------ the write

/**
 * The second GitHub write in this codebase. `postIssueComment` was the first, and
 * its header calls itself "the ONLY GitHub-write in this codebase" — that is no
 * longer true, so this one carries the same guard: a fence that runs before any
 * process is spawned, an argv built from ids here rather than assembled from
 * anything a worker can influence, and a failure reported rather than swallowed.
 *
 * Note the worker's own fence is NOT widened for this. That fence is a PreToolUse
 * hook on the worker's `claude` process; the console is a different process with no
 * hook attached, so `denyBoard()` still refuses every board write a worker attempts.
 */
export type GhExec = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Its own, rather than reaching into comment.ts — that module's exec is private
 *  and its guard permits comments only, which is exactly right for it. */
export const realBoardExec: GhExec = (args) =>
  new Promise((resolve) => {
    execFile('gh', args, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export function assertBoardMoveOnly(args: string[]): void {
  if (args[0] !== 'project' || args[1] !== 'item-edit') {
    throw new Error(`the board writer may only run \`gh project item-edit\`, not \`gh ${args.slice(0, 2).join(' ')}\``);
  }
}

export async function moveBoardItem(
  ids: { itemId: string; projectId: string; fieldId: string; optionId: string },
  exec: GhExec,
): Promise<{ ok: boolean; error?: string }> {
  // Built here, from ids only. No lane name, no issue number, no worker string.
  const args = [
    'project', 'item-edit',
    '--id', ids.itemId,
    '--project-id', ids.projectId,
    '--field-id', ids.fieldId,
    '--single-select-option-id', ids.optionId,
  ];
  assertBoardMoveOnly(args); // fence FIRST, before any process
  const { code, stderr } = await exec(args);
  if (code !== 0) return { ok: false, error: stderr.trim() || `gh exited with code ${code}` };
  return { ok: true };
}
