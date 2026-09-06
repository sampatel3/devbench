import type { EvidenceItem } from './evidence.js';
import type { GateHistoryRecord } from './history.js';
import type { CommentRequest, CommentTarget } from './comment.js';
import type { ReviewBlock, ReviewRound } from './review.js';
import type { WatchLevel, WatchSample } from './watch.js';
import type { GateThreadRecord } from './ask.js';
import type { ManualQa } from './manual-qa.js';
import type { Quiz } from './quiz.js';
import type { GateCi } from './ci.js';
import type { IssueRequest, BoardRequest } from './drafts.js';
import type { QaProgress, QaStepView, QaVerdict } from './qa-verdict.js';
import type { QaReworkEntry } from './rework.js';
import type { CaptureReport } from './capture.js';
import type { CloseVerdict } from './close-verdict.js';
import type { ActionsFeed } from './actions.js';
import type { NotifyPrefs } from './notify.js';
import type { AgentProviderId } from './providers/types.js';
import type { AuditReport } from './audit.js';

/**
 * A supercharged run's state, as the page needs it.
 *
 * `on` is live — the console is passing this issue's gates A, B and C without
 * waiting. `stopped` is the sentence a finished automatic run left behind, and
 * the two are mutually exclusive by construction: stopping deletes the flag and
 * writes the reason.
 */
export type SuperchargeState = {
  on: boolean;
  /** Gate C send-backs spent so far. Bounded — see `MAX_AUTO_ROUNDS`. */
  autoRounds: number;
  stopped: string | null;
};

export type { EvidenceItem } from './evidence.js';
export type { GateHistoryRecord } from './history.js';
export type { CommentRequest } from './comment.js';
export type { ReviewBlock, ReviewRound } from './review.js';
export type { WatchLevel, WatchSample, WorkerSample } from './watch.js';
export type { GateThreadEntry, GateThreadRecord, GateThreadFileEntry } from './ask.js';
export type { ManualQa, ManualQaStep } from './manual-qa.js';
export type { Quiz, QuizQuestion, QuizOption } from './quiz.js';
export type { QaVerdict, QaVerdictStatus, QaStepState, QaStepView, QaProgress } from './qa-verdict.js';
export type { QaReworkEntry, QaSnapshot } from './rework.js';
export type { CaptureReport } from './capture.js';
export type { CloseVerdict, CloseVerdictKind } from './close-verdict.js';

/** Set once the console moved this card itself — see board.ts. The card then
 *  reads in the past tense: a thing that happened, not a thing wanted. */
export type BoardApplied = { from: string; to: string; at: string; why: string };

export type GateLetter = 'A' | 'B' | 'C' | 'D' | 'E';

/** What a worker writes to the worktree root when it stops at a gate. */
export type GateFile = {
  issue: number;
  gate: GateLetter;
  stage: number | null;
  sessionId: string | null;
  stoppedAt: string | null;
  reportPath: string | null;
  summary: string;
  questions: string[];
  /** Is CI green — as a field, because as a paragraph it could not be trusted.
   *  Null before Gate E when nothing was reported; NEVER null at Gate E, where
   *  silence surfaces as `unconfirmed` rather than as nothing at all. */
  ci: GateCi | null;
  /**
   * What this gate file's `evidence` array claimed and the console refused, as
   * one finished line for the card. Null when it kept everything.
   *
   * It rides on the gate rather than beside it because that is where the reader
   * is: the evidence box is rendered from `.gate.json`, and the sentence saying
   * what is MISSING from that box has to arrive with it or it arrives nowhere.
   * `parseGateFile` does not set it — the field is filled in where the manifest
   * is actually read (`worktrees.ts` for the live gate, `history.ts` for a past
   * round), so nothing about which gate a worker is parked at can turn on it.
   */
  evidenceWarning?: string | null;
};

/**
 * A gate decision you have TAKEN BACK.
 *
 * It is not a code rewind: nothing that has been written is undone. It is a
 * correction sent to the worker with an instruction to re-run from the stage
 * that gate governs. Recorded so the reversal is visible for ever — a decision
 * that quietly changed underneath the work is the one thing this must not be.
 */
export type GateReopening = {
  gate: GateLetter;
  /** Which recorded round of that gate this reopens — 1-based. 0 means the gate
   *  is passed but has no recorded exchange (a pre-`.gate-history.jsonl` worktree). */
  round: number;
  /** Your correction, verbatim. */
  message: string;
  /** The stage the worker is sent back to. */
  stage: number;
  at: string;
};

/** What we can read out of a worktree's .issue-state.md. */
export type IssueState = {
  stage: number | null;
  gatesPassed: GateLetter[];

  stoppedAtGate: GateLetter | null;
  port: number | null;
  branch: string | null;
};

export type WorkerStatus =
  | 'no-worker'
  | 'preparing'
  | 'queued'
  | 'active'
  /** Running, and STOPPED with SIGSTOP to give the machine its memory back.
   *  Nothing is lost and it holds its slot; one click puts it back. */
  | 'paused'
  | 'at-gate'
  | 'awaiting-post'
  | 'blocked'
  | 'reply-received'
  | 'rework'
  | 'detached'
  | 'pr-open'
  /** Its PR merged. Deliberately NOT orange: it is a calm state with an
   *  available action (Stage 9), not a demand. */
  | 'pr-merged'
  /** The ISSUE is closed on GitHub — QA signed it off. The end of the line, and
   *  the one state with nothing left to ask for. */
  | 'done'
  | 'checkpoint'
  /**
   * THE CONSOLE COULD NOT READ ENOUGH TO SAY.
   *
   * The only value here that describes the CONSOLE rather than the work: a
   * worktree exists, nothing is running in it, and GitHub's PR lists failed this
   * poll with no previous map to fall back on — so whether there is a PR, and
   * what it did, is a question this row cannot answer. See `prsUnreadable` in
   * `status.ts` for why it is not `checkpoint`, `no-worker` or `detached`.
   *
   * Transient by construction. The next successful poll replaces it with
   * whatever the row actually is.
   */
  | 'unreadable'
  | 'failed';

/**
 * A worker frozen with SIGSTOP — the lossless lever.
 *
 * `by` is the whole reason this is a record and not a boolean: a pause you asked
 * for and a pause the memory floor took must never read the same on the row, and
 * only one of them is something the machine did on its own.
 */
export type PausedStamp = {
  at: string;
  by: 'you' | 'floor';
  /** Plain English, shown on the row: "4% free — the memory floor". */
  reason: string;
};

/**
 * SET ASIDE BY THE OPERATOR. Not by the memory floor, not by the quota brake,
 * not by SIGSTOP — by you, in the console, on purpose.
 *
 * It is called PARKED and not "paused" because `paused` is already spoken for
 * twice on this machine and both are automatic brakes on a MACHINE:
 * `PausedStamp` above is a worker frozen with SIGSTOP (the memory floor's act,
 * `config.pauseFreePct`), and `ActionsFeed.paused` is the GitHub quota brake.
 * A third "paused" would have made "is #4491 paused?" a question with three
 * different right answers. Parked is a decision about a TICKET; paused is a
 * thing done to a process.
 *
 * The stamp is deliberately thin, and what it does NOT hold is the point:
 * no gate, no stage, no status. Parking changes nothing about where the work
 * is — the row keeps its gate and its place in the pipeline — so there is
 * nothing here to fall out of step with the worktree.
 */
export type ParkedStamp = {
  /** When you set it aside. Real clock, from the console. */
  at: string;
  /**
   * Why, in your own words, or null when you did not say.
   *
   * Optional on purpose: a parked ticket with no reason is fine and must never
   * be blocked on a text box. But three weeks later "waiting for the design
   * call on 3 Sep" is the difference between un-parking it and re-deciding it
   * from scratch, so the field is offered every time.
   */
  reason: string | null;
};

/** A comment posted on your behalf, and whether a reply has landed. */
export type CommentBlock = {
  addressee: string;
  /** Exact GitHub surface for new blocks. `onIssue` remains the legacy number. */
  onTarget?: CommentTarget;
  /**
   * The ticket the comment was actually posted on, which is not always the row
   * this block hangs off — a worker often has something to say on a DIFFERENT
   * issue (#4641's warned @reviewer-one about #4317, whose PR inherits its work).
   * The reply watch reads THIS number; without it, a reply on #4317 is looked
   * for on #4641 and never found.
   *
   * Optional because blocks written before this existed have no such field;
   * every reader falls back to the row's own number, which is what those older
   * blocks meant.
   */
  onIssue?: number;
  postedAt: string;
  commentUrl: string | null;
  reply: { author: string; createdAt: string; body: string } | null;
};

export type LiveRun = {
  startedAt: string;
  turns: number;
  lastText: string | null;
  lastTool: string | null;
  /** WHAT that tool was asked to do, truncated — the answer to "what is it
   *  doing right now" that a bare tool name never was. */
  lastToolCommand: string | null;
  /** When the stream says that call was made, so the card can say how long it
   *  has been running. Null before the first tool call. */
  lastToolAt: string | null;
  /** Its result has not come back: the command is still running. */
  toolRunning: boolean;
  /** This worker was picked back up after a console restart — it did not start
   *  now, and the counts above are from the re-attachment, not from its spawn. */
  reattached: boolean;
};

/**
 * A worker process that is running RIGHT NOW, written down so it can be found
 * again after the console restarts. This is the whole of what makes a worker
 * survivable: the pid to look for, the file its stream is going to, how far we
 * had read it, and everything the run record will need if it ends while we are
 * not watching.
 */
export type RunningRun = {
  issue: number;
  /** Missing on persisted rows written before Codex support: those are Claude. */
  provider?: AgentProviderId;
  /** Console-owned stable key used by gate and stream files. */
  sessionId: string;
  /** Vendor conversation id. Claude equals sessionId; Codex is learned after spawn. */
  agentSessionId?: string | null;
  /** Exact argv token that proves a surviving pid is this run, not a recycled pid. */
  processIdentityToken?: string;
  pid: number;
  worktree: string;
  /** One file per session; every segment appends to it. */
  streamFile: string;
  stderrFile: string;
  /** Where THIS segment's output starts in that file. */
  startOffset: number;
  /** How far the tail got. Complete lines only — it never points mid-line. */
  offset: number;
  startedAt: string;
  model: string;
  account: string;
  /** What we knew when it started, so the run can still be measured if it ends
   *  while the console is down. */
  headBefore: string | null;
  stageStart: number | null;
  labels: string[];
  /** Set while this worker is frozen. It survives a console restart on purpose:
   *  a paused worker must come back reading *paused*, not *active* with a stream
   *  that has mysteriously gone quiet. */
  paused?: PausedStamp | null;
  /** How long this run has spent paused, accumulated across pauses. It goes into
   *  the run record so a paused hour cannot masquerade as model slowness. */
  pausedMs?: number | null;
  /** The biggest this worker's process tree has been THIS RUN. An instantaneous
   *  sample cannot show a Validate spike after it has passed; this can — "400 MB
   *  now, peaked at 3.1 GB" is the sentence that was missing. */
  peakTreeBytes?: number | null;
  /** Set when this run is ANSWERING a question you asked at a gate, rather than
   *  acting on a decision. It is here, and not only in memory, because the check
   *  that the worker came back to the same gate has to survive a console restart
   *  — a charge-past during the ten seconds the console was down is exactly the
   *  one nobody would otherwise ever see. */
  ask?: { gate: GateLetter; ids: number[] } | null;
};

export type PullRequest = {
  /** True when this PR belongs to ANOTHER issue and was inherited via a
   *  cross-reference — the folded-in case. Never set on an issue own PR. */
  inherited?: boolean;
  /** The issues this PR's body DECLARES it closes. It is what separates a fold-in
   *  from a mere mention, and no PR is inherited without it — see closes.ts. */
  closes?: number[];
  number: number;
  url: string;
  state: string;
  title: string;
  isDraft: boolean;
  /** When it merged, for a PR that has. Null for an open one. A merged PR used
   *  to vanish from the console entirely — see `listRecentMergedPrs`. */
  mergedAt?: string | null;
  /** GitHub's own verdict: APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / ''.
   *  Fetched since gh.ts was written and never once read — which is how #4344
   *  reached Gate E reading "ready to hand to the team lead" while the PR carried
   *  CHANGES_REQUESTED and needed an approving review to merge. */
  reviewDecision?: string | null;
  /** The repo's own convention: this label means a reviewer asked for something
   *  and nothing has been pushed for it yet. */
  changesRequested?: boolean;
  /** The pre-merge checklist from the PR body: what is ticked and what is not. */
  checklist?: { total: number; done: number; outstanding: string[] } | null;
  /**
   * Reviewers GitHub is still waiting on — team names or logins. The question
   * this answers is which of the two is actually holding the PR — the advisory
   * bot or the approver — and without it the console named the bot.
   */
  reviewRequests?: string[];
  /** Latest review per reviewer, to name one that cannot block. See blocker.ts. */
  latestReviews?: Array<{ author: string; state: string }>;
};

/**
 * Why a row has a worktree but no open issue of yours behind it.
 *
 * The console's issue list is open, assigned-to-or-raised-by-you and fifty long,
 * so an issue leaves it for three unrelated reasons and a worktree outlives all
 * three. One placeholder sentence used to cover the lot, and #5697 — closed the
 * day before, still running a worker — read as a fault in the console rather
 * than as a ticket that had been signed off. Each reason gets its own words now.
 *
 *  - `closed`     — closed on GitHub. The usual one: QA signs off and closes.
 *  - `not-yours`  — still open, but no longer assigned to or raised by you.
 *  - `still-open` — open and yours; it fell off the fifty-issue page.
 *  - `unread`     — GitHub could not be read for it, and the row says so rather
 *                   than guessing.
 */
export type OrphanIssue = {
  reason: 'closed' | 'not-yours' | 'still-open' | 'unread';
  /** When it closed, on `closed` only. */
  closedAt: string | null;
  /** Who holds it now, on `not-yours` only. Logins, never empty strings. */
  assignees: string[];
};

export type IssueRow = {
  number: number;
  title: string;
  url: string;
  labels: string[];
  updatedAt: string;
  /** The GitHub login that filed the issue. Empty when there is none to read. */
  author: string;
  /** The issue this was spun off from, when its body says so. See parent.ts. */
  spunOffFrom: number | null;
  /** Set only on a row the console synthesized from a worktree, when there is no
   *  open issue of yours behind it. Null on every ordinary row. */
  orphan?: OrphanIssue | null;
  /**
   * What QA had said when this issue was first seen closed, and one finished
   * sentence saying it. Null on an open row, and null on a closed one the
   * console never read a verdict for — absence is "not established", never
   * "nobody verified it". See `close-verdict.ts`.
   *
   * `line` is composed by the server and rendered by the card, the same shape
   * `CaptureReport.line` uses: one fact, one wording, wherever it is read.
   */
  closeVerdict?: (CloseVerdict & { line: string }) | null;
  /** The project board column this card is in, e.g. `In review`. Null when the
   *  issue is on no board or the poll has not run yet. */
  lane?: string | null;
  /**
   * The filer is the account this console runs as — so the issue was raised from
   * this machine (by you, or by a worker acting on your instruction) and the
   * repo's autoassign workflow handed it straight back to you. It says nothing
   * about whether the work is worth doing; `needs-triage` is that question, and
   * the two are deliberately kept apart.
   */
  selfFiled: boolean;

  /**
   * Post-UAT, a human tested the shipped work and sent it back.
   *
   * Stamped off the QA verdict comment on the ISSUE — author a real User, not
   * us, posted after the work merged. Never off the `changes-requested` label,
   * which belongs to the pre-merge review bot and lands on every feature PR.
   * Null = nothing sent back. This is the one fact that outranks every priority
   * band, so it is a verdict, not a rank: the priority pill beside it keeps
   * saying what triage decided.
   */
  uatFail: {
    /** The human who gave the verdict — never a bot login. */
    by: string;
    at: string;
    verdict: 'Fail' | 'Partial Pass' | 'Pass';
    /** Deep link to the verdict comment. */
    url: string;
    /** A fix is already moving for it — a PR opened or pushed to since the
     *  verdict. It is quieter, not gone: see `uatFailFor`. */
    inflight: boolean;
  } | null;

  /**
   * You have set this one aside. Null = you have not.
   *
   * A SEPARATE AXIS from `status`, and that is the whole design. Making
   * `parked` a `WorkerStatus` would have meant `deriveStatus` returning it
   * INSTEAD of `at-gate`, which would have hidden the gate the ticket is
   * standing at — and the one rule of this feature is that a parked ticket
   * keeps its gate. So it rides alongside, exactly as `uatFail` does: a fact
   * about the row that the priority pill and the status chip go on stating
   * truthfully underneath it.
   */
  parked: ParkedStamp | null;

  worktree: string | null;
  branch: string | null;
  port: number | null;
  stage: number | null;
  gatesPassed: GateLetter[];
  /** Set when the code moved after your Gate C approval — see decisions.ts. */
  codeSinceQa?: { approvedAt: string; headNow: string; at: string } | null;
  /** Questions you left open at the gate you last approved. */
  leftUnanswered?: string[];

  gate: GateFile | null;
  /** Where the gate came from. The legacy path matters: worktrees created before
   *  the skill amendment only say "STOPPED AT GATE C" in prose. */
  gateReport: string | null;
  gateEvidence: EvidenceItem[];
  /** The structured click-script for your own QA at this gate: the running app,
   *  the local-dev login, and the steps with deep links. Null when the worker
   *  wrote none — the card says so rather than pretending there is nothing to do. */
  gateManualQa: ManualQa | null;
  /** The comprehension quiz at gate C: what was done, then multiple choice with
   *  the answer key and every option's reasoning, graded in the page. Null when
   *  the worker wrote none — which locks the gate rather than passing it. */
  gateQuiz: Quiz | null;
  /** Whether this run is deciding its own gates, and why it stopped if it was. */
  supercharge: SuperchargeState;
  /** Your own tick on each QA step. Append-only, console-owned, and the thing
   *  the Approve button counts. No worker can write one. */
  qaVerdicts: QaVerdict[];
  /** Those ticks RESOLVED against the steps on the card right now, in step
   *  order. The page renders from this: the join is a content hash, and a second
   *  implementation of it in the browser is a second way to show a tick against
   *  a step you never read. */
  qaSteps: QaStepView[];
  /** The counts behind the Approve button. `complete` is the QA half of the gate
   *  lock only — the quiz half is submission, and gate C still needs both. */
  qaProgress: QaProgress;
  /** The most recent targeted rework: which steps went back to Build, and
   *  whether what came back carried the rest of the issue forward. */
  qaRework: QaReworkEntry | null;
  /**
   * The last screenshot capture the console ran for this issue, or null when it
   * has never run one.
   *
   * It is on the row rather than left implicit in the pictures because a capture
   * that FAILED has to be as visible as one that worked: a missing screenshot
   * with no explanation is the thing this whole path exists to remove, and
   * "the console tried and here is why it could not" is an answer you can act
   * on in one step. `line` is composed by the server; the card renders it.
   */
  captureReport: CaptureReport | null;
  /** Questions asked at this gate and the answers that came back, without the
   *  gate having been decided either way. Null when nothing has been asked. */
  gateThread: GateThreadRecord | null;
  history: GateHistoryRecord[];
  /** Gates you have reopened, in the order you reopened them. Append-only, and
   *  shown inline in that gate's history so a reversal is never silent. */
  reopenings: GateReopening[];
  commentRequest: CommentRequest | null;
  /** A spin-off issue the worker DRAFTED rather than filed — `gh issue create`
   *  is fenced. `fileUrl` is GitHub's own new-issue form, prefilled: the console
   *  files nothing, it just makes your click one click. */
  issueRequest: (IssueRequest & { fileUrl: string }) | null;
  /**
   * Spin-offs already filed from this row by the console. Nothing deletes
   * `.issue-request.json`, so the draft stays on screen after a successful file
   * — this is what lets the card say "filed as #N" instead of offering to file
   * it again, and it is the parent-to-child link the prefilled GitHub form
   * could never report back.
   */
  spinOffs: Array<{ number: number; title: string; url: string; at: string }>;
  /** A board move the worker DRAFTED rather than made. */
  boardRequest: (BoardRequest & { boardUrl: string; applied: BoardApplied | null }) | null;
  commentBlock: CommentBlock | null;
  /** A PR review requesting changes, still waiting on you. Null when none is actionable. */
  reviewBlock: ReviewBlock | null;
  /** Every review round for this PR — resolved and actionable — for the spine history. */
  reviewHistory: ReviewRound[];

  sessionId: string | null;
  resumeCommand: string | null;

  /** Which CLI owns this issue's current or next session. */
  provider: AgentProviderId;

  /** The agent profile this issue's worker runs under. Null = never stamped
   *  (an issue that predates accounts): it runs under the default. */
  account: string | null;
  /** A session belongs to one account and cannot move, and a measured segment
   *  needs one model in force from end to end. True once a session exists — the
   *  only way to change EITHER then is "restart fresh". */
  accountLocked: boolean;
  /** The model stamped on this issue. Null = never stamped; it resolves through
   *  the account's default to the console's. */
  model: string | null;
  /** What that chain actually resolves to — the model the next run will use. */
  modelResolved: string;
  /** The exact line to type if this worker says it is not logged in. Composed by
   *  the same helper the Settings card uses, so the two cannot disagree. */
  loginCommand: string;

  status: WorkerStatus;
  statusDetail: string;
  queuePosition: number | null;
  /** When it entered the queue. Null on entries queued before this shipped. */
  queuedAt?: string | null;
  pr: PullRequest | null;
  /** Whether this PR can actually be handed to a codeowner, read off GitHub.
   *  Null when there is no PR. Gate E must not present as ready without it. */
  handover?: { ready: boolean; why: string } | null;
  /** You answered a review round; the reviewer has not cleared it. Null when
   *  nothing was sent back, the reviewer moved on, or GitHub could not be read. */
  reviewOutstanding?: { reviewer: string; why: string; sentAt: string | null } | null;
  /** A question of yours on this issue that nobody has answered. See question.ts. */
  openQuestion?: { askedAt: string; firstLine: string; url: string } | null;
  /**
   * What this issue is waiting on, split into a status you can do nothing about
   * and the follow-ups that are yours. Every string finished server-side, because
   * the page composing sentences is how the same fact ends up worded two ways.
   */
  waiting?: {
    on: string | null;
    note: string | null;
    yours: Array<{ text: string; detail: string | null; url: string | null }>;
  } | null;
  live: LiveRun | null;
  /** Set while this worker is frozen. The row holds its slot, blocks dispatch,
   *  and one click resumes it — nothing about the work is lost. */
  paused: PausedStamp | null;
  lastError: string | null;
  lastActivityAt: string | null;
  provision: ProvisionStatus | null;
  /** The last time this worktree's dev server was stopped by the console. */
  devServerStop: DevServerStop | null;
};

export type ProvisionStatus = {
  phase: 'creating' | 'preparing' | 'ready' | 'failed';
  /** Structured result; only `branch-exists` offers branch recovery. */
  code: 'ok' | 'outside' | 'exists' | 'branch-exists' | 'recovery-pending' | null;
  branch: string;
  worktreePath: string;
  port: number;
  startedAt: string;
  error: string | null;
  logTail: string[];
};

export type ResourceReport = {
  ok: boolean;
  reason: string;
  /** macOS memory-pressure free % — the gate signal. Null if unreadable. */
  freePct: number | null;
  /** Reclaimable headroom before swap, from vm_stat — the human number. */
  headroomBytes: number;
  headroomLabel: string;
  minFreePct: number;
  /** Our Docker footprint (sum of container memory). Null if docker is down. */
  footprintBytes: number | null;
  footprintLabel: string;
  /** totalRAM − reserve — the backstop ceiling for our footprint. */
  ceilingBytes: number;
  ceilingLabel: string;
  totalBytes: number;
  /** The known leaker's current size, for the one-click restart button. */
  edgeRuntimeLabel: string | null;
  /** The same size as a number, for the instances panel. */
  edgeRuntimeBytes: number | null;
  /** What a new worker plus its test spike needs free before it is dispatched. */
  workerHeadroomBytes: number;
  /** How full swap is. Null when `sysctl vm.swapusage` could not be read — which
   *  is said out loud, never rounded to a comfortable 0. */
  swapUsedPct: number | null;
  /** "8.4 GB of 16.0 GB (92%)", or "swap unreadable". */
  swapLabel: string;
  /** macOS kernel pressure: 1 normal, 2 warn, 4 critical. Gates at 4 only. */
  pressureLevel: number | null;
  checkedAt: string;
};

/**
 * The last time you clicked "Restart edge runtime". An ATTEMPT, not a success:
 * `ok: false` is a restart that did not come back, and it has to be visible.
 *
 * In memory only. It exists to tell the person who just clicked what happened;
 * there is no automatic restart for it to rate-limit, so there is nothing here
 * that has to survive a console restart.
 */
export type EdgeReclaim = {
  at: string;
  /** How big it had grown — the whole reason it happened. */
  grewTo: string;
  freePctBefore: number | null;
  /** Whether the restart actually came back. */
  ok: boolean;
  /** Why it did not, when it did not. */
  error: string | null;
};

/** A dev server the console stopped, and why — so one vanishing is never a mystery. */
export type DevServerStop = {
  at: string;
  port: number;
  pid: number | null;
  why: string;
};

/**
 * The watcher's answer, as the UI receives it. One row per running worker with
 * its tree size AND its observed peak, the level the ladder is at, the
 * forward-looking sentence, and — stated rather than assumed — whether the floor
 * will actually act.
 */
export type WatchReport = {
  sample: WatchSample;
  level: WatchLevel;
  forecast: { sentence: string; comfortable: boolean; projectedHeadroomBytes: number | null };
  /** Per-worker extras the raw sample cannot carry: who is paused, and the peak. */
  workers: Array<{
    issue: number;
    pid: number;
    procCount: number;
    treeBytes: number;
    stoppedProcs: number;
    peakTreeBytes: number | null;
    paused: PausedStamp | null;
    /** What the worker's last tool call was — the phase hint, already tracked. */
    lastTool: string | null;
  }>;
  /** The per-worker spike the forecast models — `WORKER_HEADROOM_GB`. */
  spikeBytes: number;
  /** Whether the floor at `floorFreePct` pauses everything on its own. */
  autoPauseFloor: boolean;
  /** The ladder, so the panel can state its own thresholds rather than hard-code them. */
  thresholds: { minFreePct: number; warnFreePct: number; pauseFreePct: number; floorFreePct: number };
  /** How often it samples, so the panel can say what it costs. */
  intervalMs: number;
  totalBytes: number;
};

/** What the UI needs to offer an account: no health, no paths beyond the dir. */
export type AccountSummary = {
  name: string;
  provider: AgentProviderId;
  configDir: string;
  isDefault: boolean;
  /** This account's default model, or null for the console's. */
  model: string | null;
};

/** A model the pickers offer, with the one line that says when to pick it. */
export type ModelOption = { provider: AgentProviderId; id: string; label: string; when: string };

export type ConsoleState = {
  issues: IssueRow[];
  /** Registered Claude accounts. Exactly one entry (implicit `personal`) when
   *  there is no accounts.json — the UI hides the whole feature at that point. */
  accounts: AccountSummary[];
  defaultAccount: string;
  /** The models the pickers offer: the known ones, plus any unknown id actually
   *  in force, so a custom WORKER_MODEL is still selectable. */
  models: ModelOption[];
  /** The bottom of the precedence chain — config.workerModel. */
  defaultModel: string;
  /** Provider-specific bottoms of the same precedence chain. */
  defaultsByProvider: Record<AgentProviderId, string>;
  queue: number[];
  maxActive: number;
  /** Workers holding a SLOT. A paused one is not counted: it gave the slot back
   *  when it was parked, and only its memory is still spoken for. */
  activeCount: number;
  /** How long one command may run before the card says so loudly — LONG_TOOL_MIN. */
  longToolMs: number;
  resources: ResourceReport | null;
  /** The live measurement: what each worker's process tree costs right now, what
   *  the machine has left, and what happens if the running workers all spike at
   *  once. Null until the first tick. Everything here is at most one tick old —
   *  which is the whole point, the machine read behind `resources` can be two
   *  minutes stale and was, on the night this was built for. */
  watch: WatchReport | null;
  /** The last edge-runtime restart you asked for, for the banner. */
  lastEdgeReclaim: EdgeReclaim | null;
  dispatchReason: string;
  /**
   * Why nothing is starting, when something is queued waiting to. Null when
   * nothing is being held — including when the memory is uncomfortable but the
   * desk is empty, because then there is no queued row lying about it.
   *
   * Read at snapshot time off the same verdict `#dispatch` consults, so it is
   * never staler than the page. `dispatchReason` beside it is the last DECISION
   * the dispatcher made and can be up to a `resourceTick` old.
   */
  dispatchHold: string | null;
  repo: string;
  /** Every workspace this console knows; the current one is always in it.
   *  Optional on the UI side for the same reason `uatFail` is guarded: a
   *  rebuilt bundle can be talking to a server that has not restarted. */
  workspaces: string[];
  repoPath: string;
  pollError: string | null;
  /**
   * A read that worked, but not the way it usually does — today, the merged-PR
   * list answering off the REST budget after GraphQL refused it.
   *
   * Its own field beside `pollError` because it is its own claim: nothing
   * failed, and a degraded read still may not pass for the full one, which is
   * why it is not simply left unsaid. Null on an ordinary poll.
   */
  pollNote: string | null;
  /** Whether that note is worth acting on. A whole fallback read is quiet; a
   *  SHORT one is a warning, because rows below it have gone to "cannot say".
   *  See `#pollNoteWarn`. False whenever `pollNote` is null. */
  pollNoteWarn: boolean;
  /** When GitHub was last read, or null before the first poll finished. It is on
   *  screen beside Refresh: at a fifteen-minute cadence, data with no age on it
   *  looks live when it is not. */
  lastPolledAt: string | null;
  /** How often that happens, so the UI can say it rather than hard-code it. */
  pollMs: number;
  /**
   * Every action on you that lives on GitHub — issues assigned, review requests,
   * comments, CI, and the post-UAT verdicts. It rides this state down the SSE
   * the page already listens on, so there is no second endpoint and no polling
   * from the browser. `banner` is the honest-degradation line, already worded.
   */
  actions: ActionsFeed & { banner: string | null };
  /** The notification switches, so the Settings panel edits real state rather
   *  than asking you to edit an environment variable. */
  notify: NotifyPrefs;
  /**
   * How many phones are registered for push.
   *
   * `/api/push/subscribe` has no auth and Tailscale Serve exposes it to the
   * whole tailnet, so this number is the only way a registration you did not
   * make is visible at all — the Settings page can otherwise report only
   * whether the browser looking at it is subscribed.
   */
  pushDevices: number;
  /** How many announced notifications you have not read yet — the bell's badge.
   *  It is on the state rather than behind its own poll because the tab bar is
   *  drawn on every view. */
  unreadNotifications: number;
  /** The last audit you ran — every open issue read against what its status
   *  claims. Null until you run one; replaced whole by the next. */
  audit: AuditReport | null;
  updatedAt: string;
};
