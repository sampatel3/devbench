import type { GateFile, PausedStamp, PullRequest, WorkerStatus } from './types.js';
import { issueFromBranch } from './naming.js';

export type StatusInput = {
  hasWorktree: boolean;
  isRunning: boolean;
  /** Frozen with SIGSTOP. A paused worker is STILL running as far as the runner
   *  is concerned — it holds its slot — so this has to be read before the plain
   *  `isRunning` branch or it would be unreachable. */
  paused?: PausedStamp | null;
  gate: GateFile | null;
  detached: boolean;
  queuePosition: number | null;
  /** When this issue ENTERED the queue. Absent on rows queued before this was
   *  recorded, and on those the row says only where it sits — an unstamped entry
   *  must never be reported as if it just arrived. */
  queuedAt?: string | null;
  lastError: string | null;
  pr: PullRequest | null;
  /**
   * A post-merge verdict that sent this back, from the actions feed — the same
   * fact the UAT chip and card are drawn from.
   *
   * It outranks both endings a row can otherwise reach. `pr-merged` says "stage
   * 9 post-merge", which is an invitation to hand the work to QA; `issueClosed`
   * says QA signed it off. On #4914 the tester marked it Fail, closed the issue
   * in the same second and moved the card to `Revisit`, and the row went on
   * offering the QA hand-off with nothing on it saying a verdict existed.
   *
   * `inflight` means somebody is already fixing it. That changes the wording,
   * never whether it is said.
   */
  sentBack?: { by: string; verdict: string; inflight: boolean } | null;
  stage: number | null;
  /** The ISSUE is closed on GitHub. Stage 9 exists to get an issue to QA and
   *  closed; once QA has closed it, there is nothing left to ask for. Without
   *  this the row read "stage 9 post-merge" on #4336 six hours after QA posted
   *  a full pass and closed it. */
  issueClosed?: boolean;
  /** Set while a worktree is being created and scaffolded. */
  provision?: { phase: 'creating' | 'preparing' | 'ready' | 'failed'; error: string | null } | null;
  /** A worker's drafted comment, waiting for you to post it. */
  commentRequest?: { addressee: string; kind?: 'decision' | 'handoff' } | null;
  /** A comment already posted, and whether a reply has landed. */
  commentBlock?: { addressee: string; reply: { author: string } | null } | null;
  /** A PR review requesting changes, still waiting on you to start the rework. */
  reviewBlock?: { reviewer: string } | null;
  /** This running worker was picked back up after a console restart. It is not a
   *  fresh start and must not read as one. */
  reattached?: boolean;
  /** Its last run ended while the console was not running. Without this a row
   *  that died unattended reads as an ordinary checkpoint. */
  endedWhileDown?: boolean;
  /**
   * Its last run EXITED CLEANLY AND STOPPED AT NO GATE.
   *
   * `outcome: 'finished'` in `worker.ts` — the process exited 0, emitted its
   * `result` event, and wrote no `.gate.json`. Nothing failed, so `lastError` is
   * cleared, and the row used to fall all the way to the bare checkpoint line:
   * "stopped after stage 6", the same sentence as a worktree nobody has ever
   * started work in. On #5402 (gates A–D passed, no PR, no gate file) the
   * operator asked why the issue was on a checkpoint at all — and the answer
   * was not on the card.
   *
   * The console has always had the word for it: the same handler writes
   * `exit: 'exited-no-gate'` into `runs.jsonl` one line after clearing the
   * error. This is that fact, on the row.
   */
  endedWithoutGate?: boolean;
  /**
   * THE `blocked` LABEL, and the last thing a worker said about this issue.
   *
   * The operator asked for this on #5674: an issue carrying the `blocked` label
   * should say `blocked` on the row, with a reason, the way a parked issue does
   * — otherwise it is forgotten under a pile of live tickets and the question
   * gets asked again.
   *
   * That is right, and #5674 is the case: the fix already existed on dev, there
   * was no diff to raise, the worker said exactly that at gate E — and the row
   * read "checkpoint — stopped after stage 9", which is true and tells you
   * nothing. The finding was three files away in `.gate-history.jsonl`.
   *
   * The label is the TRIGGER because the team maintains it and it is precise:
   * 2 of 73 rows carry it. The last gate summary is the REASON, because that
   * is where a worker actually writes why it stopped.
   */
  labels?: string[];
  /** The last gate decision on record, newest last — the worker’s own words. */
  history?: Array<{ gate: string; summary?: string | null }>;
  /** You have already answered — a gate, a rework, a landed reply, a reopened
   *  gate — and the answer is queued behind a busy desk. The files that raised
   *  the question are still on disk (the worker clears them when it picks the
   *  answer up), but the ball is no longer in your court. */
  answered?: boolean;
  /** What the person who applied the `blocked` label said about it. Outranks the
   *  worker's own summary — see `blockedReason`. */
  blockedNote?: { by: string; body: string } | null;
};

/**
 * ONE SENTENCE out of something long: the first, unless the split leaves an
 * implausibly short fragment, in which case the whole opening line is better
 * than half of one. Markdown markers go, because a status line is plain text —
 * the words inside them are untouched.
 */
function oneSentence(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*[>#\-*+]+\s*/gm, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const first = flat.split(/(?<=[.!?])\s/)[0]?.trim() ?? flat;
  return first.length < 25 ? flat.slice(0, 200) : first;
}

/**
 * WHY a blocked issue is blocked, in the words of whoever said so.
 *
 * The label alone says only that somebody marked it. Two people can answer the
 * question and they answer different ones, so the order matters:
 *
 *  1. THE PERSON WHO APPLIED THE LABEL. The label's description in this repo is
 *     "Cannot proceed on an external dependency. The comment must name what is
 *     being waited on", so where there is an external blocker a human has been
 *     told to write it down, and that comment is the answer by construction.
 *  2. The worker's last gate summary. It says where the WORKER stopped, which
 *     is a related but different question, and it is all there was before the
 *     comment was read.
 *
 * #5674 is why the order is that way round. It read "blocked — Ready to hand
 * over, and there is no pull request to hand over — which is the finding": the
 * worker's account of itself, true and unusable. Two seconds after labelling it,
 * a human had written that the guard already exists on `dev` and the issue
 * unblocks when the fix reaches `main` — and none of that reached the row, which
 * said the issue was blocked and nothing else.
 *
 * ONE SENTENCE of either, because a status line is a status line. The rest is a
 * click away on GitHub, and the worker's full text is in the gate history.
 */
export function blockedReason(i: Pick<StatusInput, 'labels' | 'history' | 'blockedNote'>): string | null {
  if (!(i.labels ?? []).includes('blocked')) return null;
  // Attributed, because "who decided this" is half the answer to "can I move it
  // on" — and because it is a person speaking, not the console summarising.
  const note = i.blockedNote;
  if (note && note.body.trim() !== '') return `blocked, per @${note.by} — ${oneSentence(note.body)}`;
  const said = [...(i.history ?? [])].reverse().find((h) => (h.summary ?? '').trim() !== '');
  const summary = (said?.summary ?? '').trim();
  if (summary === '') return 'labelled blocked on GitHub — nobody has said why yet';
  return `blocked — ${oneSentence(summary)}`;
}

/**
 * What a paused row SAYS. Who paused it, when, and why — because a pause the
 * memory floor took on its own and a pause you asked for must never read the
 * same, and a row that looks stuck rather than paused is the failure this text
 * exists to prevent.
 */
export function pausedDetail(p: PausedStamp): string {
  const at = new Date(p.at);
  const time = Number.isFinite(at.getTime())
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : p.at;
  const who = p.by === 'floor' ? 'paused by the memory floor' : 'paused by you';
  return `${who} at ${time}${p.reason ? ` — ${p.reason}` : ''}. Nothing is lost; Resume picks it straight back up.`;
}

/**
 * One status per issue, in priority order. The order is the point:
 *
 *  - a gate outranks a PR, because a gate is a person waiting;
 *  - detached outranks queued, because we must not start a second owner;
 *  - a failed run outranks an open PR, because a failure is news.
 */
/** "6 min ago" / "8 h ago" / "3 d ago" — the vocabulary the account cards use. */
function ago(iso: string, now: number): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/**
 * The PR for an issue whose fix was folded into ANOTHER issue's PR.
 *
 * A row resolves its PR by head branch, so an issue with no branch of its own
 * matched nothing and read `checkpoint` for ever (#4562, folded into PR #4535 on
 * #4344's branch). GitHub's timeline already hands us every PR that references
 * the issue, each with its head branch, so those are resolved through the SAME
 * branch map rather than assembled into a half-populated PullRequest — the row
 * then shows the real title, draft state and review decision.
 *
 * Deliberately conservative in THREE ways, because a cross-reference is only a
 * mention and a wrong PR on a row is worse than none:
 *  - a reference whose branch the console never fetched is skipped, not faked;
 *  - a PR that does not SAY it closes this issue is a mention, not a fold-in,
 *    and is skipped as well;
 *  - the result is marked `inherited`, so nothing can present another issue's
 *    PR as this one's own work.
 *
 * The middle one was missing, and the guard around it only ever excluded other
 * people's branches — every PR of ours is in the branch map by construction. So
 * PR #5006, which is #5000's work and names #5002 once in prose, became #5002's
 * PR: an issue nobody had started read `PR open`, stage 7 and "nothing for you
 * to do", and the board writer moved its card from `Ready` to `In review`. The
 * closing keyword is the test — #4535 opens `Closes #4562.` and #5006 opens
 * `Closes #5000.` — with the head branch as the other way in, for a PR raised
 * on this issue's own branch outside the console. See closes.ts.
 *
 * Merged wins over open, then newest — the folded fix has usually landed, and
 * that is the one worth showing.
 */
export function inheritPr(
  refs: readonly { number: number; headRefName: string; createdAt: string; mergedAt: string | null }[],
  byBranch: ReadonlyMap<string, PullRequest>,
  issue: number,
): PullRequest | null {
  const at = (iso: string | null): number => {
    const t = iso === null ? NaN : Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
  };
  const found = refs
    .map((r) => ({ r, pr: byBranch.get(r.headRefName) ?? null }))
    .filter((x): x is { r: (typeof refs)[number]; pr: PullRequest } => x.pr !== null)
    .filter((x) => ownsIssue(x.pr, x.r.headRefName, issue))
    .sort((a, b) => {
      const merged = Number(b.r.mergedAt !== null) - Number(a.r.mergedAt !== null);
      if (merged !== 0) return merged;
      return at(b.r.mergedAt ?? b.r.createdAt) - at(a.r.mergedAt ?? a.r.createdAt);
    })[0];
  return found ? { ...found.pr, inherited: true } : null;
}

/**
 * Is this PR this issue's WORK, rather than a PR that merely mentions it?
 *
 * Two ways to qualify, and a mention satisfies neither:
 *  - the body declares it closes this issue — the fold-in, #4535 for #4562;
 *  - the head branch names this issue — its own PR, raised outside the console.
 */
export function ownsIssue(pr: PullRequest, headRefName: string, issue: number): boolean {
  return (pr.closes ?? []).includes(issue) || issueFromBranch(headRefName) === issue;
}

/** One sentence for a send-back, so the two endings that can carry one cannot
 *  word the same fact differently. */
function sentBackDetail(sentBack: NonNullable<StatusInput['sentBack']>, ending: string): string {
  const who = `${sentBack.by} marked it ${sentBack.verdict} after the merge`;
  return sentBack.inflight ? `${ending}, but ${who} — a fix is in flight` : `${ending}, but ${who} — not signed off`;
}

export function deriveStatus(i: StatusInput, now: number = Date.now()): { status: WorkerStatus; statusDetail: string } {
  // A half-built worktree is neither ready nor absent, and must never read as either.
  if (i.provision) {
    if (i.provision.phase === 'creating') return { status: 'preparing', statusDetail: 'creating the worktree' };
    if (i.provision.phase === 'preparing') {
      return { status: 'preparing', statusDetail: 'setting the worktree up' };
    }
    if (i.provision.phase === 'failed') {
      return { status: 'failed', statusDetail: i.provision.error ?? 'setting the worktree up failed' };
    }
  }
  // BEFORE the plain `isRunning` branch, deliberately. A paused worker is still
  // in the runner's map — that is what makes it hold its slot so nothing
  // backfills the hole — so putting this second would make it unreachable and
  // the row would read `active` while the process sat frozen.
  if (i.isRunning && i.paused) {
    return { status: 'paused', statusDetail: pausedDetail(i.paused) };
  }
  if (i.isRunning) {
    const working = i.stage === null ? 'working' : `working, stage ${i.stage}`;
    return {
      status: 'active',
      statusDetail: i.reattached ? `${working} — re-attached after a console restart` : working,
    };
  }
  // An ANSWERED question is not a question. The decision is made and queued, so
  // NOTHING that asks you something may still claim this row: not the gate, not
  // the rework, not the landed reply, not the drafted comment. Every one of them
  // steps aside and the row falls through to `queued` below, which is where it
  // actually is. Anything less and a card that was answered at capacity keeps
  // offering its button — the exact shape of "that click did nothing".
  const answered = i.answered === true;
  // An ANSWERED gate is not a gate: the decision is made and queued, so the row
  // must not keep asking for it in orange.
  if (i.gate && !answered) return { status: 'at-gate', statusDetail: `at gate ${i.gate.gate}` };
  // A posted comment outranks its own request file, which lingers in the worktree
  // until the worker deletes it on resume (the console never writes there).
  if (i.commentBlock && !answered) {
    return i.commentBlock.reply
      ? { status: 'reply-received', statusDetail: `${i.commentBlock.reply.author} replied` }
      : { status: 'blocked', statusDetail: `awaiting ${i.commentBlock.addressee || 'a reply'}` };
  }
  // A PR that got CHANGES_REQUESTED needs you to kick off the rework — a person
  // waiting with work to do, the same tier as a landed reply, above the open PR.
  if (i.reviewBlock && !answered) {
    return { status: 'rework', statusDetail: `${i.reviewBlock.reviewer || 'a reviewer'} requested changes` };
  }
  // A drafted comment not yet posted needs you.
  if (i.commentRequest && !answered) {
    const noun = i.commentRequest.kind === 'decision' ? 'a product question' : 'a comment';
    return {
      status: 'awaiting-post',
      statusDetail: `drafted ${noun} for ${i.commentRequest.addressee || 'the ticket'} — needs your OK to post`,
    };
  }
  // CLOSED outranks detached. `decideDetached` reads `exitMtimes`, which is
  // persisted and cleared only by restart-fresh or reset — so an issue you took
  // over in a terminal, drove to a merged PR and QA then closed would read
  // "you took this one over in a terminal" forever: never `done`, never faded,
  // a live-looking row for work that finished. Being closed is the end of the
  // line whoever was driving. The rule that put `detached` up here at all —
  // never start a second owner of one session — is untouched, because a closed
  // issue is not one we would start.
  if (i.detached && !i.issueClosed) {
    return { status: 'detached', statusDetail: 'you took this one over in a terminal' };
  }
  if (i.queuePosition !== null) {
    const where = i.queuePosition === 1 ? 'next up' : `${i.queuePosition} in line`;
    const waited = i.queuedAt ? ago(i.queuedAt, now) : null;
    return {
      status: 'queued',
      statusDetail: waited ? `${where} · queued ${waited}` : where,
    };
  }
  if (i.lastError) return { status: 'failed', statusDetail: i.lastError };
  // BLOCKED, with the reason, before the row can fall to a checkpoint line.
  //
  // Below `active` and the gates deliberately: a worker running on a blocked
  // issue IS running (#5673 was, while carrying the label), and a gate open on
  // one is still a decision waiting on you. This is for the rest — the rows
  // where nothing is happening and the label is the whole story.
  const blocked = blockedReason(i);
  if (blocked !== null) return { status: 'blocked', statusDetail: blocked };
  // A MERGED PR before the open-PR branch, because until this existed a merged
  // PR simply vanished from `listOpenPrs`, the row fell back to the stale
  // `.issue-state.md` number, and finished work rendered as "checkpoint —
  // stopped after stage 7". Three issues read that way on 2026-08-11 behind PRs
  // #4368, #4446 and #4466, all merged.
  // Closed outranks merged: the issue reaching CLOSED is the end of the line,
  // and asking for Stage 9 after QA has signed it off is asking for work that
  // has already happened.
  if (i.issueClosed) {
    // "QA signed it off" was an inference from the close, and it is only true
    // when nothing has sent the work back. #4914 was closed by the tester in the
    // same second as the Fail they were posting, so the one row that most needed
    // to say "this came back" was the one asserting the opposite.
    //
    // Reached only by a row we READ as closed now, or by one GitHub could not be
    // read for at all. It used to be reached by an issue's mere absence from the
    // open list, which also catches a reassignment and a paging drop — both of
    // which then read "QA signed it off". The wording here is unchanged, because
    // absence has overwhelmingly always meant a close and this sentence is the
    // useful summary of it; what changed is which rows arrive at it. A row that
    // could not be read says so on its own card. See `OrphanCard`.
    if (i.sentBack) {
      return { status: 'done', statusDetail: sentBackDetail(i.sentBack, 'closed on GitHub') };
    }
    return {
      status: 'done',
      statusDetail: i.pr ? `closed — PR #${i.pr.number} merged and QA signed it off` : 'closed on GitHub',
    };
  }
  if (i.pr && i.pr.state === 'MERGED') {
    // Not "stage 9 post-merge" when a tester has already sent it back: that
    // sentence reads as an invitation to hand finished work to QA, and QA is
    // where it just came from. See `sentBack`.
    if (i.sentBack) {
      return {
        status: 'pr-merged',
        statusDetail: sentBackDetail(i.sentBack, `PR #${i.pr.number} merged`),
      };
    }
    return { status: 'pr-merged', statusDetail: `PR #${i.pr.number} merged — stage 9 post-merge` };
  }
  if (i.pr) return { status: 'pr-open', statusDetail: `PR #${i.pr.number}${i.pr.isDraft ? ' (draft)' : ''} open` };
  if (i.hasWorktree) {
    const where = i.stage === null ? 'stopped part-way' : `stopped after stage ${i.stage}`;
    // A run that ended unattended looks exactly like one that never started, and
    // that silence is what made a restart feel like it had eaten the work.
    //
    // `endedWhileDown` leads because it is the stronger caveat: whatever else is
    // true, the console was not watching, so everything else it says about that
    // ending is read off files rather than seen. A clean exit at no gate is the
    // next most specific thing there is to say, and saying nothing is what made
    // #5402 unreadable — a worker that ended its turn after gate D without
    // raising a PR, rendered identically to an untouched worktree.
    const why = i.endedWhileDown
      ? ' — it ended while the console was down'
      : i.endedWithoutGate
        ? ' — the worker ended its turn without stopping at a gate'
        : '';
    return { status: 'checkpoint', statusDetail: `${where}${why}` };
  }
  return { status: 'no-worker', statusDetail: 'no worktree yet' };
}

/**
 * How far along this issue actually is — the furthest point the EVIDENCE supports,
 * not merely what `.issue-state.md` last recorded.
 *
 * That file is written by the worker, so it goes stale the moment work happens any
 * other way: #4336's stages 6-7 were done in an interactive session, the file still
 * read "stage 5", and the spine drew Understanding as current while the PR was open
 * with two review rounds on it. The console already knew better — it had the PR and
 * the reviews — so it should not have believed the file over itself.
 *
 * Evidence outranks the file, and only ever moves the marker FORWARD:
 *   PR merged            -> 9, post-merge
 *   PR open              -> 7, PR & review (gate D is behind you by definition)
 *   otherwise            -> whatever the file says
 *
 * A live gate is not consulted here: `gate.stage` is already the file's own,
 * fresher-by-construction number, and it flows in as `fileStage`.
 */
export function effectiveStage(input: { fileStage: number | null; pr: PullRequest | null }): number | null {
  const { fileStage, pr } = input;
  const fromEvidence = pr === null ? null : pr.state === 'MERGED' ? 9 : 7;
  if (fromEvidence === null) return fileStage;
  if (fileStage === null) return fromEvidence;
  return Math.max(fileStage, fromEvidence);
}

/** The things that put the ball in your court get the orange treatment. */
export function needsOperator(status: WorkerStatus): boolean {
  return (
    status === 'at-gate' ||
    status === 'awaiting-post' ||
    status === 'reply-received' ||
    status === 'rework'
  );
}
