import { EventEmitter } from 'node:events';
import { randomUUID , createHash} from "node:crypto";
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from './config.js';
import {
  describeIssues,
  listIssues,
  listOpenPrs,
  listRecentMergedPrs,
  readBlockedNote,
  type ActionsPayload,
  type GhBlockedNote,
  type GhIssue,
  type GhIssueFacts,
  type MergedPrsFallback,
} from './gh.js';
import {
  EMPTY_WATCH_STATE,
  forecast,
  gb,
  inertWatchProbes,
  nextWatchState,
  parsePsForest,
  realWatchProbes,
  sampleWorkers,
  signalProcessGroup,
  type WatchProbes,
  type WatchSample,
  type WatchState,
  type WorkerSample,
} from './watch.js';
import { scanWorktrees, gateHashOf, type WorktreeScan } from './worktrees.js';
import {
  decideResources,
  parseMemoryPressure,
  parseVmStat,
  probeResources,
  restartEdgeRuntime,
} from './resources.js';
import { inertProbes, probeInstances, stopDevServer, type InstanceProbes, type InstanceReport } from './instances.js';
import { WorkerQueue, bandOf, selectNext, type Weight } from './queue.js';
import {
  WorkerRunner,
  mtimeMs,
  runResultFrom,
  transcriptPath,
  deleteGateFile,
  readGateFile,
  GATE_FILE,
  type RunResult,
  type SpawnInfo,
} from './worker.js';
import { commandLines, decideReattach, pidAlive } from './reattach.js';
import { parseGithubSnapshot, serializeGithubSnapshot } from './snapshot.js';
import { decideDetached } from './detached.js';
import {
  answeredEntries,
  askPrompt,
  chargedPastMessage,
  committedWhileAnsweringMessage,
  mergeThreadAnswers,
  openEntries,
  type GateThreadRecord,
} from './ask.js';
import {
  currentVerdict,
  failedSteps,
  qaProgress,
  stepHash,
  stepState,
  type QaStepState,
  type QaStepView,
  type QaVerdict,
} from './qa-verdict.js';
import { withEvidenceReminder } from './evidence-reminder.js';
import {
  cancelledReworkMessage,
  chargedPastReworkMessage,
  deletedEvidenceMessage,
  droppedEvidenceMessage,
  droppedStepsMessage,
  rewrittenEvidenceMessage,
  reworkPrompt,
  type QaReworkEntry,
  type QaSnapshot,
} from './rework.js';
import type { ManualQa, ManualQaStep } from './manual-qa.js';
import {
  captureGateShots,
  playwrightDriver,
  systemListens,
  type CaptureDeps,
  type CaptureReport,
} from './capture.js';
import type { EvidenceItem } from './evidence.js';
import {
  ACCOUNT_NAME_RE,
  accountFor,
  doctor,
  expandHome,
  hasAccount,
  implicitRegistry,
  isCanonicalDir,
  loadAccounts,
  loginCommandFor,
  readRegistryFile,
  scanDirsFor,
  writeRegistryFile,
  type Account,
  type AccountRegistry,
} from './accounts.js';
import { checkLogin, type AccountReport, type LoginProbe } from './login.js';
import { defaultModelFor, isKnownModel, pickableModelsFor, resolveModel } from './models.js';
import {
  aggregate,
  appendRun,
  gitHead,
  readRuns,
  routerReadiness,
  workStat,
  MIN_SAMPLE,
  type LateSignals,
  type MetricsReport,
  type RouterReadiness,
  type RunRecord,
} from './metrics.js';
import { parseIssueState } from './state.js';
import { handoverBlock } from './handover.js';
import { appendGateHistory, appendGateProvenance, parseGateHistory } from './history.js';
import { ciNote } from './summary.js';
import {
  etDayRange,
  etDayOf,
  etDaysBetween,
  countsIn,
  dailyCounts,
  laneMovesFromLedger,
  mergedPrsFromLedger,
  prsRaisedFrom,
  type Counts,
  type DayCounts,
} from './counts.js';
import { foldPrompt } from './fold.js';
import { resolveAttachmentTarget, ATTACH_DIR } from './attach.js';
import { issueFromBranch } from './naming.js';
import { deriveStatus, effectiveStage, inheritPr, ownsIssue } from './status.js';
import {
  Provisioner,
  staleFenceJobs,
  verifiedRecoveryJobs,
  pathExists,
  type ContinuationPlan,
  type ProvisionPlan,
} from './provision.js';
import { resolveEvidencePath } from './evidence.js';
import { commentRequestKey, commentTarget, postTargetComment, detectReply, type GhWriteExec } from './comment.js';
import { commentAddressee } from './addressee.js';
import {
  appendDecision,
  readDecisions,
  gatesPassedFor,
  codeSince,
  saidInTheApproveBox,
  sentBackByTheConsole,
  type GateDecision,
} from './decisions.js';
import { decideSupercharge } from './supercharge.js';
import {
  legsOf,
  summarise,
  summariseSince,
  trendOf,
  LEG_KEYS,
  type CycleSummary,
  type LegKey,
  type Legs,
  type Milestones,
  type Trend,
} from './cycle.js';
import { readsAsQuestion, questionNotApprovalRefusal } from './approval.js';
import { markPrReady } from './comment.js';
import { why } from './why.js';
import { decideBoardMove, moveBoardItem, realBoardExec, type Milestone } from './board.js';
import { openQuestion, type OpenQuestion } from './question.js';
import { waiting } from './waiting.js';
import { auditIssues, type AuditReport } from './audit.js';
import { reviewOutstanding, detectChangeRequest, isActionable, nextRound, resolveRound } from './review.js';
import { viewIssueComments, listPrReviews, listClosedIssues, listMergedPrs, listAuthoredOpenPrs, readBoardItem } from './gh.js';
import { fetchActionsOnMe, readGraphqlQuota } from './gh.js';
import { deriveActions, newestUatVerdict, uatFailFor, EMPTY_FEED, type Action, type ActionsFeed } from './actions.js';
import { closeLine, recordCloses, type CloseVerdict, type ClosedSighting } from './close-verdict.js';
import { fallbackBanner, quotaBrake, staleBanner } from './quota.js';
import {
  WRITE_FENCE_HOOK,
  assertCodexHooksReady,
  codexHooksDocument,
  fenceArgs,
} from './fence.js';
import { ClaudeProvider, CodexProvider, type AgentProviderId, type AgentProviderRegistry } from './providers/index.js';
import { newIssueUrl, boardUrl } from './drafts.js';
import { createIssue, type GhWriteExec as IssueWriteExec } from './issues.js';
import {
  applySends,
  clearLog,
  markAllRead,
  notificationLog,
  planNotifications,
  prunedLedger,
  seedLedger,
  unreadCount,
  DEFAULT_PREFS,
  type Ledger,
  type LogEntry,
  type NotifyPrefs,
  LEDGER_TTL_DAYS,
} from './notify.js';
import { loadOrCreateVapidKeys, pushProblemBanner, pushRefusedBanner, sendPush, type PushSubscription, type VapidKeys } from './push.js';
import { buildSummary, windowStart, type Fetched, type SummaryPayload, type SummaryWindow } from './summary.js';
import type {
  CommentBlock,
  ConsoleState,
  DevServerStop,
  EdgeReclaim,
  GateFile,
  GateLetter,
  GateReopening,
  IssueRow,
  OrphanIssue,
  ParkedStamp,
  PausedStamp,
  PullRequest,
  ResourceReport,
  ReviewBlock,
  RunningRun,
  WatchReport,
} from './types.js';

/** The metrics report as served: the table, when it was built, and anything we
 *  could not read while building it. */
export type MetricsPayload = MetricsReport & { generatedAt: string; warnings: string[] };

/**
 * The Dashboard's answer to "can I decide about the router yet?".
 *
 * It is a SNAPSHOT, computed by a background job — at startup and then every
 * `metricsRefreshMs` — and persisted, so opening the Dashboard costs nothing and
 * a console restart shows the last answer immediately rather than an empty card.
 * `computedAt` is shown with it always: a stale answer presented as fresh is the
 * one failure this card must not have.
 */
export type MetricsSnapshot = {
  computedAt: string;
  readiness: RouterReadiness;
  totalRuns: number;
  models: string[];
  minSample: number;
  /** Set when the last refresh FAILED. The figures above are then the last good
   *  ones, and their age is the reader's warning. */
  error: string | null;
};

/**
 * The few things that reach out and touch the machine — reading what is running,
 * signalling a dev server, restarting the one container we may restart. They are
 * injectable for one reason: a test must be able to prove the fences WITHOUT
 * killing anything on the operator's laptop.
 */
export type OrchestratorDeps = {
  instanceProbes?: InstanceProbes;
  kill?: (pid: number) => void;
  restartContainer?: (name: string) => Promise<string>;
  log?: (line: string) => void;
  /** The watcher's three reads. Inert under vitest unless a test wires them, for
   *  the same reason as everything else here: measuring the operator's real machine
   *  from a test is one short step from ACTING on it. */
  watchProbes?: WatchProbes;
  /** SIGSTOP / SIGCONT to a whole process group — the only way a pause happens.
   *  It THROWS under vitest unless wired, identical to the `kill` rule: no
   *  process may be signalled from a test that has not wired one. */
  signalGroup?: (pgid: number, signal: 'SIGSTOP' | 'SIGCONT') => void;
  /**
   * The screenshot runner's browser and its port probe.
   *
   * The fourth machine capability, and it follows the same rule as the other
   * three: under vitest it falls back to "not there" rather than to the real
   * thing, so a test that has not deliberately wired a browser cannot launch
   * one against whatever happens to be listening on the operator's machine. See
   * the constructor.
   */
  captureDeps?: CaptureDeps;
};

/**
 * How much a peak has to grow before it is worth a state-file write. The peak is
 * updated in memory every tick; saving every 5 seconds to record a 4 MB wobble
 * would be absurd, and losing the last quarter-gigabyte of a peak to a console
 * restart costs nothing anybody reads.
 */
const PEAK_SAVE_DELTA_BYTES = 256 * 1024 * 1024;

/**
 * Appended to the prompt of every FRESH spawn — and to no resume, ever.
 *
 * The uncapped jest fan-out is the root cause of the crash this whole watcher
 * exists for, and the primary fix is the skill's own Stage 4 text. This is the
 * belt to that pair of braces: a worker running an older copy of the skill still
 * gets told. It is appended where the prompt is COMPOSED rather than inside
 * `WorkerRunner`, so the runner stays a dumb transport and the one place that
 * decides what a worker is told is the one place to look.
 *
 * It must never touch a resume: resume prompts are the operator's own words, gate
 * history records them verbatim, and a byte-exactness test proves nothing is
 * appended.
 */
export const FANOUT_RULE =
  'Hard rule for this machine: never run jest or vitest uncapped — cap with --maxWorkers=2 (see issue-pipeline Stage 4).';

/**
 * What the skills library is FOR — carried the same way and for the same reason
 * as the fan-out rule. A skill governs a round only if the worker is told to
 * apply it: the folder is offered as a reference shelf, and a shelf is something
 * a model reads when it happens to think of it. Fresh spawns only — a resume
 * must stay byte-exact the operator's words.
 *
 * It names the two skills that always apply rather than saying "apply your
 * skills", because a rule with no subject is one a worker can satisfy by doing
 * nothing. The carve-out belongs to `google-dev-writing` alone and is spelled
 * out as such: `issue-pipeline` governs the code, the branch and the PR, and a
 * blanket "no skill touches code" would gut it.
 *
 * Deliberately says "for a person to read" and not "everything you write": the
 * prose skill excludes code, identifiers, command output and quoted material,
 * and a rule that appeared to ask for renamed variables or edited quotes would
 * be ignored wholesale, which is worse than not asking.
 *
 * It also states the ORDER, because two prose rules with no precedence is a
 * worker guessing at every gate. `google-dev-writing` is the whole Google
 * developer documentation style guide and applies to every word; `issue-pipeline`'s
 * "How to write" is this console's own layer on top and wins where they
 * disagree — which is the order Google's guide itself sets, project style
 * first. `google-dev-writing` replaced `inclusive-writing`, which covered one
 * page of that guide.
 */
export const SKILLS_RULE =
  'Standing rule: your skills are binding, not a reference shelf. Before you start, and again at every gate, ' +
  'apply every skill whose description covers what you are about to do. Two always do: `issue-pipeline` ' +
  'governs the round itself, and `google-dev-writing` — the whole Google developer documentation style ' +
  'guide — governs every piece of prose you write for a person to read: gate summaries and questions, PR ' +
  'bodies, drafted comments and issues, status posts and handovers. Apply `google-dev-writing` to every ' +
  "word first, then `issue-pipeline`'s \"How to write\" section on top, and where the two disagree " +
  '`issue-pipeline` wins. ' +
  '`google-dev-writing` never applies to code, identifiers, command output or quoted material, and accuracy ' +
  'always wins over any skill.';

const runScript = promisify(execFile);

/** Makes each atomic state write's temp file unique — see `#save`. */
let saveSeq = 0;

/** How many phones may be registered for push at once. See
 *  `savePushSubscription` — this is a security and a poll-latency bound, not a
 *  preference. */
const MAX_PUSH_DEVICES = 5;

/**
 * State that must survive an orchestrator restart. Everything else is rebuilt by
 * rescanning the worktrees — today's lesson was that state in a process is state
 * you lose.
 */
type Persisted = {
  /** transcript mtime when our own child last exited, per issue — the detached signal */
  exitMtimes: Record<string, number>;
  /** last failure per issue, so a crash-looping worker is visible after a restart */
  lastErrors: Record<string, string>;
  /** the session id we spawned, per issue */
  sessions: Record<string, string>;
  /** The provider-owned conversation id. Claude matches `sessions`; Codex is
   *  learned from `thread.started` after the process exists. */
  agentSessions: Record<string, string>;
  /** comments posted on the operator's behalf, per issue — the blocked-on-reply
   *  record */
  commentBlocks: Record<string, CommentBlock & { requestKey?: string }>;
  /** A request file already dealt with without a worker resume. The file is
   *  worker-owned and deliberately left untouched; this digest suppresses that
   *  exact consumed request across polls/restarts while a different future
   *  request still surfaces. */
  handledCommentRequests: Record<
    string,
    { requestKey: string; handledAt: string; reason: 'posted-non-blocking' | 'resolved' | 'discarded' }
  >;
  /** Spin-off drafts FOLDED into their parent instead of filed, by title.
   *  `.issue-request.json` is worker-owned and lingers until the next resume, so
   *  without this the card comes straight back offering to file the thing that
   *  was just absorbed — and filing it then would raise the duplicate the fold
   *  existed to avoid. */
  foldedSpinOffs: Record<string, string[]>;
  /** When each queued issue ENTERED the queue, so a row can say how long it has
   *  been waiting rather than only where it sits. Persisted because the queue
   *  itself is not — it is rebuilt from `pendingResume` on boot, and a stamp
   *  invented at boot would report an overnight wait as brand new. Entries
   *  already queued when this shipped stay absent, and read as they always did. */
  enqueuedAt: Record<string, string>;
  /** PR review rounds requesting changes, per issue — the rework record */
  reviewBlocks: Record<string, ReviewBlock>;
  /** the Claude account each issue runs under, stamped when it is SPAWNED and
   *  changed only by a restart-fresh — a session cannot move between accounts */
  accountByIssue: Record<string, string>;
  /** Provider locked with the account/session. Missing in older state means Claude. */
  providerByIssue: Record<string, AgentProviderId>;
  /** the model each issue runs under, stamped the same way and at the same
   *  moment as the account, so a segment is always attributable to one model */
  modelByIssue: Record<string, string>;
  /** workers that were RUNNING when we last wrote this file — the pid, the
   *  stream file and how far we had read it. This is the map that survives a
   *  console restart, and re-attachment is nothing more than reading it back */
  runningRuns: Record<string, RunningRun>;
  /** issues whose run ended while the console was not running, so the row can
   *  say so instead of reading as a plain checkpoint. Cleared on the next run */
  endedWhileDown: Record<string, string>;
  /**
   * Issues whose last run EXITED CLEANLY AND STOPPED AT NO GATE, and when.
   *
   * `outcome: 'finished'`: the process exited 0, emitted its `result` event and
   * wrote no `.gate.json`. Nothing failed, so `#track` clears `lastError` — and
   * the row then had nothing left to say, falling to the bare checkpoint line
   * that a never-started worktree prints. #5402 sat there with gates A–D passed
   * and no PR: a worker that ended its turn at Stage 7 without raising one and
   * without writing a Gate E stop, reported as "stopped after stage 6".
   *
   * Same shape and same lifecycle as `endedWhileDown` beside it: written when
   * the run settles, cleared in `#registerRun` the instant a new one spawns.
   */
  endedWithoutGate: Record<string, string>;
  /**
   * SUPERCHARGED RUNS, per issue — a standing instruction from the operator,
   * given once at start, to pass gates A, B and C without waiting for them.
   *
   * PERSISTED, and that is not incidental: the console going down mid-run is
   * routine and is now one click (Rebuild), and a flag lost across a restart
   * would quietly turn a supercharged run back into one waiting for a person
   * with nothing on screen saying so. `endedWithoutGate` beside it is the
   * cautionary tale — it shipped, and #5402 still rendered without its reason
   * because the running build predated it.
   *
   * `autoRounds` counts the gate C send-backs already spent, which is what
   * bounds them. `lastGateHash` is the `.gate.json` this issue was last
   * auto-decided against, so one gate round can never be decided twice.
   */
  supercharged: Record<string, { at: string; autoRounds: number; lastGateHash: string | null }>;
  /**
   * Why a supercharged run handed itself back, per issue.
   *
   * An automatic run that stops owes the operator one sentence saying why, and the
   * gate card alone cannot say it: the card shows the gate, not the fact that the
   * console had been passing gates until this one. Cleared when it is started again.
   */
  superchargeStopped: Record<string, string>;
  /** the last dev server the console stopped, per issue, so a dev server
   *  disappearing is always explained on the row that caused it */
  devStops: Record<string, DevServerStop>;
  /**
   * Issues THE OPERATOR has set aside, per issue. Their act, so it lives in the
   * console's own store and survives both a refresh and a restart.
   *
   * Here rather than in `decisions.jsonl`: that ledger is append-only and its
   * every entry is a GATE decision (`approved` | `feedback`) that
   * `gatesApproved` counts. Parking is not a gate decision, it decides nothing
   * about the work, and — unlike a decision — it is REVERSIBLE, which an
   * append-only ledger models badly. It is the same shape as `devStops` and
   * `boardMoves` beside it: one current fact per issue, keyed by number,
   * deleted when it stops being true.
   */
  parked: Record<string, ParkedStamp>;
  /** a gate decision the operator has already made, taken while every slot was
   *  busy and held until one frees. It is here rather than in memory for the same
   *  reason as everything else in this file: a decision a person made must not
   *  die because a process restarted */
  pendingResume: Record<string, string>;
  /**
   * Which of those parked things is a SEND-BACK rather than an approval.
   *
   * The queue ranks a send-back above every band (`queue.ts`, key 2) and an
   * approval not at all, so the two have to be told apart — and `pendingResume`
   * holds only the words, which cannot be read for intent. `resume`'s own
   * `decision` already carries `'approved' | 'feedback'` and decisions.ts is
   * explicit that *"`approved` moves the work on; `feedback` sends it back"*, so
   * that is the default; the paths that ARE a send-back whatever they record in
   * the ledger — a targeted QA rework, a reopened gate, a question at a gate —
   * say so outright.
   *
   * Read only alongside a live `pendingResume` entry (`#sentBack`), which is
   * what makes a stale mark harmless: nothing is ranked by it once the thing it
   * described has gone out. Same rule as `parked`'s `!= null` guard.
   */
  sentBackResumes: Record<string, true>;
  /**
   * Held resumes that a SUPERCHARGED run produced, per issue.
   *
   * Exactly parallel to `sentBackResumes` beside it, and for the same reason.
   * A supercharged pass that arrives at capacity is held in `pendingResume` and
   * replayed later by `#dispatch`, which is the only party that writes the
   * ledger line for it — and it had no way of knowing the console had produced
   * those words rather than the operator. The result was that with two slots and
   * four supercharged issues, every pass that waited was recorded as one THEY made,
   * which is the precise confusion `by: 'supercharge'` exists to prevent.
   * Consumed where the message is.
   */
  superchargeResumes: Record<string, true>;
  /** gates the operator has taken back, per issue. Append-only and never
   *  rewritten: a decision that was reversed is a fact about the work, and the
   *  row it was made on must go on saying so */
  reopenings: Record<string, GateReopening[]>;
  /**
   * Spin-off issues filed from this console, per parent issue.
   *
   * The operator asked that whatever files the issue also update the status by
   * linking it. The prefilled-URL route could never do that — a browser form
   * hands the new number to GitHub and to nobody else, so the console never
   * learned it and parent and child stayed strangers. Filed here, both numbers
   * are in hand at the same moment, and this is where the link lives.
   *
   * Append-only: an issue filed is a fact, and a second spin-off from the same
   * parent is another entry rather than an overwrite.
   */
  spinOffs: Record<string, Array<{ number: number; title: string; url: string; at: string }>>;
  /**
   * Board cards the console has moved by itself. ONE entry per issue for the life
   * of this file, and it is what makes "move it back and it stays back" true —
   * nothing deletes `.board-request.json`, so without this record the same draft
   * would be re-applied on every poll. Never swept, never rewritten.
   */
  boardMoves: Record<string, { from: string; to: string; at: string; why: string }>;
  /** the last router-readiness snapshot, so a console restart shows the last
   *  answer immediately instead of an empty card while the job runs */
  metricsSnapshot: MetricsSnapshot | null;
  /** the question-and-answer thread at an OPEN gate, per issue. The worker
   *  echoes the same exchange into `.gate.json` (and from there into the gate
   *  history), so this is the belt to that pair of braces: a question asked
   *  while the worker was mid-answer, or one overtaken by a decision before it
   *  was ever delivered, exists nowhere else */
  gateThreads: Record<string, GateThreadRecord>;
  /** The operator's own per-step QA ticks at gate C, per issue. Append-only, and
   *  here rather than in `.gate.json` for the reason that decides everything about
   *  this feature: the worker rewrites that file whole on every stop, and a
   *  verdict a person gave must not be at the mercy of a process rewriting a
   *  file. No worker can write state.json — see qa-verdict.ts */
  qaVerdicts: Record<string, QaVerdict[]>;
  /** What the gate held the moment a targeted rework went out: the evidence and
   *  the click-script. The verification baseline and the render fallback, so
   *  nothing the operator has seen can vanish because a worker fumbled a merge */
  qaSnapshots: Record<string, QaSnapshot>;
  /** Every targeted rework dispatched for an issue, in order. Append-only on
   *  the same principle as `reopenings`: a round that went back to Build is a
   *  fact about the work */
  qaReworks: Record<string, QaReworkEntry[]>;
  /**
   * The last screenshot capture run per issue, and the gate round it ran for.
   *
   * `gateHash` is what makes the automatic run happen ONCE per round rather than
   * once per poll — the same discriminator `#autoDecideSuperchargedGates` uses,
   * for the same reason. It is persisted rather than held in memory because a
   * console restart must not re-drive a browser over a gate it already captured.
   *
   * The report itself lives here too, so the card can say what the last run did
   * — including that it failed, and why — without the console having to run it
   * again to find out.
   */
  captures: Record<string, CaptureReport & { gateHash: string | null }>;
  /**
   * What QA had said the first time the console saw each issue CLOSED.
   *
   * Record-once and never rewritten, which is the whole point: a `Pass` posted
   * after the close must not make the close look verified in hindsight, and a
   * ticket closed over a standing `Fail` goes on saying so. Persisted for the
   * same reason `boardMoves` and `reopenings` are — it is a fact about the
   * ticket, not current state, and rebuilding it from a later poll would answer
   * a different question.
   *
   * An issue the console could not read a verdict for gets NO entry. Absence is
   * "never established"; `none` means it looked and there was nothing. See
   * `close-verdict.ts`.
   */
  closeVerdicts: Record<string, CloseVerdict>;
};

/**
 * The actions ledger file — `actions.json`, beside `state.json`.
 *
 * Separate from `Persisted` on purpose. It is written on every poll (state.json
 * is written on nearly every event), it is the only file the notification path
 * touches, and keeping it apart means a corrupt ledger costs at most a repeated
 * notification rather than every running worker's re-attach row.
 */
type NotifyStore = {
  /** id → what we have already announced. Keyed on GitHub's own ids. */
  ledger: Ledger;
  prefs: NotifyPrefs;
  /** The phones that asked for pushes. Dropped on a 404/410 from the relay. */
  subscriptions: PushSubscription[];
  /** Issues already known to be assigned to them — so an existing row is a row,
   *  not news. Seeded from the first payload. */
  knownAssigned: number[];
  /** When the operator last said "seen". Retires tier 2–3 news; tier 1 ignores it. */
  seenAt: string | null;
  /** The last good feed, so a restart shows it immediately — stamped with its
   *  REAL age, never with the restart time. */
  feed: ActionsFeed | null;
  /** True once the first poll has seeded. Absent = first run ever. */
  seeded: boolean;
};

const EMPTY_NOTIFY: NotifyStore = {
  ledger: {},
  prefs: DEFAULT_PREFS,
  subscriptions: [],
  knownAssigned: [],
  seenAt: null,
  feed: null,
  seeded: false,
};

const EMPTY: Persisted = {
  exitMtimes: {},
  lastErrors: {},
  sessions: {},
  agentSessions: {},
  commentBlocks: {},
  handledCommentRequests: {},
  enqueuedAt: {},
  foldedSpinOffs: {},
  reviewBlocks: {},
  accountByIssue: {},
  providerByIssue: {},
  modelByIssue: {},
  runningRuns: {},
  endedWhileDown: {},
  endedWithoutGate: {},
  supercharged: {},
  superchargeStopped: {},
  devStops: {},
  parked: {},
  pendingResume: {},
  sentBackResumes: {},
  superchargeResumes: {},
  reopenings: {},
  spinOffs: {},
  boardMoves: {},
  metricsSnapshot: null,
  gateThreads: {},
  qaVerdicts: {},
  qaSnapshots: {},
  qaReworks: {},
  captures: {},
  closeVerdicts: {},
};

/**
 * Which stage each gate closes, from the skill's own flow — so "reopen gate C"
 * has one unambiguous meaning: go back and re-run stage 5.
 *
 *   A → 1 Scope        B → 2 Plan          C → 5 Understanding
 *   D → 6 Pre-PR       E → 8 Merge
 */
const GATE_STAGE: Record<GateLetter, number> = { A: 1, B: 2, C: 5, D: 6, E: 8 };

const GATE_LETTERS = Object.keys(GATE_STAGE) as GateLetter[];

/**
 * A capture record as the ROW carries it — the report, without the round key it
 * is filed under.
 *
 * `gateHash` is the console's own bookkeeping for "have I already captured this
 * round", and it is dropped here on the standing rule that the wire carries what
 * the card renders. Nothing in the page has any use for it, and a field on the
 * row is a field somebody will eventually read.
 */
const captureOf = (record: (CaptureReport & { gateHash: string | null }) | undefined): CaptureReport | null => {
  if (!record) return null;
  const { gateHash: _key, ...report } = record;
  return report;
};

/**
 * What we knew when a run STARTED, kept so the run can be measured when it ends.
 * `headBefore` is the commit the worktree was on, which is what makes "how much
 * code did this segment produce" answerable from git afterwards.
 */
type RunContext = {
  issue: number;
  worktree: string;
  sessionId: string;
  provider: AgentProviderId;
  model: string;
  account: string;
  startedAt: string;
  startedMs: number;
  headBefore: string | null;
  stageStart: number | null;
  labels: string[];
  /** Set when this run is ANSWERING A QUESTION rather than acting on a decision.
   *  It is what lets the ending be checked: a run asked at gate C must come back
   *  to gate C, and anything else is a worker that walked past a gate nobody
   *  decided. It rides in `runningRuns` too, so the check survives a restart. */
  ask: { gate: GateLetter; ids: number[] } | null;
};

/**
 * The context of a run that started before this console process did. Nothing has
 * to be guessed or re-derived: it was all written into `runningRuns` at spawn,
 * for exactly this moment.
 */
function contextOf(entry: RunningRun): RunContext {
  return {
    issue: entry.issue,
    worktree: entry.worktree,
    sessionId: entry.sessionId,
    provider: entry.provider ?? 'claude',
    model: entry.model,
    account: entry.account,
    startedAt: entry.startedAt,
    startedMs: Date.parse(entry.startedAt) || Date.now(),
    headBefore: entry.headBefore,
    stageStart: entry.stageStart,
    labels: entry.labels,
    ask: entry.ask ?? null,
  };
}

/** Evidence that is READ, not looked at. Stamped by content so a rework may add
 *  to it — appending what it found is the wanted outcome — but never rewrite it. */
const TEXT_EVIDENCE = /\.(md|txt|sql|json|jsonl|log|csv)$/i;
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex").slice(0, 16);
const countLines = (b: Buffer): number => {
  const t = b.toString("utf8");
  if (t.trim() === "") return 0;
  return t.split("\n").filter((l) => l.trim() !== "").length;
};

export class Orchestrator extends EventEmitter {
  #cfg: Config;
  /**
   * The line waiting for a slot, ordered by what it is rather than when it
   * arrived — send-backs from UAT first, then P0 … P3. The queue holds arrival
   * order and asks this back for the rank, so a label added while a ticket
   * waits takes effect on the next dispatch instead of at the next restart.
   *
   * An arrow in a field initializer is safe here: it captures `this` but is not
   * CALLED until something asks the queue to order itself, long after every
   * field it reads exists.
   */
  #queue = new WorkerQueue((issue) => this.#weigh(issue));
  #runner: WorkerRunner;
  #providers: AgentProviderRegistry;
  #issues: GhIssue[] = [];
  /**
   * GitHub's word on each worktree whose issue is NOT in `#issues`, so the row
   * the console synthesizes for it can name the reason instead of reciting one
   * sentence for three of them. Keyed by issue number, refreshed every poll, and
   * empty until a poll has run — a number missing from it means "not read", never
   * "still open". See `#orphanOf`.
   */
  #orphanFacts = new Map<number, GhIssueFacts>();
  /**
   * Why each `blocked` issue is blocked, from the person who labelled it. Keyed
   * by issue number and refreshed every poll. Empty means nobody has been asked
   * yet or nobody answered, and the row falls back to the worker's own summary.
   */
  #blockedNotes = new Map<number, GhBlockedNote>();

  /**
   * The last audit the operator ran, riding `state()` so every tab shows the same
   * report. In-memory on purpose: the report is a reading of live data, and a
   * copy that outlived a restart would be a stale answer wearing a timestamp.
   */
  #audit: AuditReport | null = null;
  /** Open and merged kept apart, so a failure of either read falls back to its
   *  OWN last good answer. `#prs` is the joined view every row reads. */
  #openPrs = new Map<string, PullRequest>();
  #mergedPrs = new Map<string, PullRequest>();
  #prs = new Map<string, PullRequest>();
  /** issue number -> every PR that references it, whole. Feeds `inheritPr` and
   *  the board writer's `pr-open` milestone, which needs the state too. */
  #referencingFull = new Map<
    number,
    readonly { number: number; state: string; headRefName: string; createdAt: string; mergedAt: string | null }[]
  >();
  #scans: WorktreeScan[] = [];
  /** Monotonic read order: an older poll snapshot must never replace a newer
   *  recovery scan that already found the restored worktree. */
  #scanGeneration = 0;
  #resources: ResourceReport | null = null;
  #dispatchReason = 'starting up';
  #pollError: string | null = null;
  /**
   * A read that SUCCEEDED, but not the way it usually does.
   *
   * Separate from `#pollError` because it is a different sentence: a fallback
   * that worked is not a failed read, and leaving the operator with a failure
   * banner over a board that is entirely correct is its own kind of 2026-09-05.
   */
  #pollNote: string | null = null;
  /**
   * Which colour that sentence is in — and it is not always the same one.
   *
   * A WHOLE fallback read renders quiet, like the "GitHub read HH:MM" stamp: a
   * fact about the data, nothing to act on. A CAPPED one renders `warn`, because
   * the map is short and rows below it have gone to "cannot say where its PR
   * stands"; styling that like furniture is how the one poll worth acting on
   * gets skimmed past. Decided here rather than in the page, because whether a
   * read is worth acting on is a fact about the read.
   */
  #pollNoteWarn = false;
  /**
   * The last poll lost a PR list AND had no map of its own to fall back on, so
   * no row may say "there is no pull request" until one succeeds.
   *
   * `false` before the first poll on purpose: an unread console is not a
   * console that failed to read, and every row is `no-worker` at that point
   * anyway. Set once per poll and read by every `#row`, so the rows built
   * between polls all describe the same read. See `prsUnreadable` in status.ts.
   */
  #prsUnreadable = false;
  /** When GitHub was last read. On screen beside Refresh, because at a fifteen
   *  minute cadence a number with no age on it is a number that looks live. */
  #lastPolledAt: string | null = null;
  #persisted: Persisted = structuredClone(EMPTY);
  /** Everything on GitHub that needs the operator, as of the last read. */
  #actions: ActionsFeed = { ...EMPTY_FEED };
  /** Reentrancy guard for the board-move pass — it writes, so it runs alone. */
  #applyingBoard = false;
  /** Every gate decision the operator has made, read once at boot and appended to. */
  #decisions: GateDecision[] = [];
  /**
   * Per issue: a question of the operator's on that thread that nobody answered.
   * Derived from comments the actions poll already fetches and otherwise throws
   * away — #4344 carried one for fifteen hours with nothing on the page to say so.
   */
  #openQuestions = new Map<number, OpenQuestion>();
  /**
   * The board lane per issue, from the actions poll that already fetches it. Used
   * as a CHEAP pre-check before any board move: without it, deciding a milestone
   * cost a per-issue GraphQL read on every poll for every issue with a session.
   */
  #lanes = new Map<number, string>();
  /** The announce-once ledger, the notification preferences and the phone
   *  subscriptions, in their own file beside state.json. */
  #notifyStore: NotifyStore = structuredClone(EMPTY_NOTIFY);
  /** Loaded lazily: generating a keypair is pointless until push is used. */
  #vapid: VapidKeys | null = null;
  #notifyLoaded = false;
  #timer: NodeJS.Timeout | null = null;
  /** The local machine read — see `resourcesMs`. Its own timer, because it must
   *  not follow the GitHub poll out to fifteen minutes. */
  #resourcesTimer: NodeJS.Timeout | null = null;
  #polling = false;
  #provisioner: Provisioner;
  #accounts: AccountRegistry;
  /** The account picked on the start card, held until the worker actually spawns. */
  #pendingAccount = new Map<number, string>();
  /** The model picked on the same card, held the same way. */
  #pendingModel = new Map<number, string>();
  /** A one-shot spawn prompt for the next dispatch of an issue, when it is not
   *  the plain `/issue-pipeline <N>` — today only the rework fresh start. */
  #pendingPrompt = new Map<number, string>();
  /** One built summary per window, held for `summaryTtlMs`, so flipping between
   *  Daily/Weekly/Monthly does not fire three gh calls a click. */
  #summaries = new Map<SummaryWindow, { at: number; payload: SummaryPayload }>();
  /** The built metrics report, held for `metricsTtlMs` — the Settings tab asks on
   *  a timer and the CI half of the join costs one read-only gh call. */
  #metrics: { at: number; payload: MetricsPayload } | null = null;
  /** What we knew when each in-flight run started, keyed by issue. It is handed
   *  to the run record when the run ends, and to `runningRuns` at spawn. */
  #contexts = new Map<number, RunContext>();
  /** Issues whose spawn has been DECIDED but whose worker does not exist yet.
   *  In memory only, and deliberately: it covers a window measured in
   *  milliseconds, and a claim that outlived the process would wedge the issue.
   *  See `#busy` for what it is for. */
  #starting = new Set<number>();
  /** The last login probe per account. In memory ONLY: an account can be signed
   *  in or out from a terminal at any moment, so this is a memory of an answer,
   *  never a stored fact — and it dies with the process, which is honest. */
  #logins = new Map<string, LoginProbe>();
  /** The instances inventory, held briefly: docker stats and lsof are not free. */
  #instancesCache: { at: number; payload: InstanceReport } | null = null;
  /** The three things that touch the machine, injectable so tests never do. */
  #instanceProbes: InstanceProbes | undefined;
  #kill: ((pid: number) => void) | undefined;
  #restartContainer: (name: string) => Promise<string>;
  #log: (line: string) => void;
  /** Set while a container restart is actually in flight. The restart takes ~12s,
   *  and nothing may be started into the middle of it. */
  #reclaiming = false;
  /** The last edge-runtime restart the operator asked for, for the banner. In
   *  memory only: it is feedback on a click, not state anything depends on. */
  #lastEdgeReclaim: EdgeReclaim | null = null;
  /** The daily router-readiness snapshot job. */
  #metricsTimer: NodeJS.Timeout | null = null;
  /** The watcher: its probes, its last sample, where it is on the ladder, and the
   *  same re-entrancy guard `#polling` uses. */
  #watchProbes: WatchProbes;
  #signalGroup: (pgid: number, signal: 'SIGSTOP' | 'SIGCONT') => void;
  /** The screenshot runner's browser and port probe. Never real under vitest
   *  unless a test wired one — see the constructor. */
  #captureDeps: CaptureDeps;
  #watch: WatchSample | null = null;
  #watchState: WatchState = { ...EMPTY_WATCH_STATE };
  #watchTimer: NodeJS.Timeout | null = null;
  #watching = false;
  /** Set by `stop()`. Nothing may START anything after the console has been told
   *  to shut down — not a dispatch that was already in flight, not the next
   *  watcher tick. Cleared by `start()`. */
  #stopped = false;
  /** The last tick's per-worker measurement, keyed by issue — so a pause knows
   *  which process groups to signal without taking its own `ps`. */
  #trees = new Map<number, WorkerSample>();

  constructor(cfg: Config, deps: OrchestratorDeps = {}) {
    super();
    this.#cfg = cfg;
    // A test that has not deliberately wired the machine must not be able to
    // touch it. This is a structural rule and not a convention because it has
    // already gone wrong once: back when the console restarted the edge runtime
    // by itself, a test that let the real `probeResources` run measured the real
    // container, decided it was fat, and restarted the operator's own container
    // while a worker was live. So, under vitest, each of the three machine
    // capabilities falls back to "not there" rather than to the real thing, per
    // capability, and a test that wires one gets exactly that one.
    const underTest = Boolean(process.env.VITEST);
    this.#instanceProbes = deps.instanceProbes ?? (underTest ? inertProbes : undefined);
    this.#kill =
      deps.kill ??
      (underTest
        ? () => {
            throw new Error('no process may be signalled from a test that has not wired one');
          }
        : undefined);
    this.#restartContainer =
      deps.restartContainer ??
      (underTest
        ? async () => {
            throw new Error('no container may be restarted from a test that has not wired one');
          }
        : restartEdgeRuntime);
    this.#watchProbes = deps.watchProbes ?? (underTest ? inertWatchProbes : realWatchProbes);
    this.#signalGroup =
      deps.signalGroup ??
      (underTest
        ? () => {
            throw new Error('no process group may be signalled from a test that has not wired one');
          }
        : signalProcessGroup);
    // The fourth capability, same rule as the three above: a browser is a
    // process on the operator's machine pointed at whatever listens on a port, and a
    // test that has not asked for one gets a refusal it can read rather than a
    // real Chromium against a real dev server.
    this.#captureDeps = deps.captureDeps ?? {
      open: underTest
        ? () => Promise.reject(new Error('no browser may be launched from a test that has not wired one'))
        : playwrightDriver({ storageState: cfg.qaStorageState }),
      listens: underTest ? async () => false : systemListens,
    };
    this.#log = deps.log ?? ((line) => console.log(line));
    // Until start() reads accounts.json we assume the implicit single account,
    // which is the pre-accounts behaviour.
    this.#accounts = implicitRegistry(cfg.canonicalConfigDir);
    this.#provisioner = new Provisioner({ repoPath: cfg.repoPath });
    this.#providers = {
      claude: new ClaudeProvider({
        bin: cfg.claudeBin,
        permissionMode: cfg.workerPermissionMode,
        canonicalConfigDir: cfg.canonicalConfigDir,
        extraArgs: fenceArgs(),
      }),
      codex: new CodexProvider({
        bin: cfg.codexBin,
        sandbox: cfg.codexSandbox,
        assertHooksReady: assertCodexHooksReady,
      }),
    };
    this.#runner = new WorkerRunner({
      providers: this.#providers,
      streamDir: cfg.streamDir,
      pollMs: cfg.streamPollMs,
      // So the fence can ask whether the operator approved gate D before
      // `gh pr create`.
      decisionsFile: cfg.decisionsFile,
      onChange: () => this.#changed(),
      onSpawn: (info) => this.#registerRun(info),
      // Frequent and cheap: keep the number current in memory, and let the next
      // save carry it to disk. A write every quarter-second would be absurd.
      onProgress: (issue, offset) => {
        const entry = this.#persisted.runningRuns[String(issue)];
        if (entry) entry.offset = offset;
      },
      // Codex chooses its thread id after spawn. Persist it at the first stream
      // event so a console restart can resume the exact same conversation.
      onAgentSession: (issue, provider, agentSessionId) => {
        const key = String(issue);
        this.#persisted.agentSessions[key] = agentSessionId;
        this.#persisted.providerByIssue[key] = provider;
        const entry = this.#persisted.runningRuns[key];
        if (entry) entry.agentSessionId = agentSessionId;
        void this.#save();
      },
    });
  }

  /** Re-attached and reconciled issue numbers, for the startup log. */
  async start(): Promise<{ reattached: number[]; reconciled: number[] }> {
    this.#stopped = false;
    this.#persisted = await this.#load();
    // The last successful poll's GitHub reading, back into memory BEFORE the
    // first poll — so if that poll fails (the 2026-09-05 restart landed in an
    // hour of exhausted quota), its fallbacks keep this instead of an empty
    // process and the board shows the old statuses under the old "GitHub read"
    // stamp rather than degrading every row to a bare checkpoint. See snapshot.ts.
    await this.#seedFromSnapshot();
    // The decision ledger, read once. Append-only, so memory and file stay in step.
    this.#decisions = await readDecisions(this.#cfg.decisionsFile);
    await this.#ensureNotifyLoaded();
    // The queue itself is memory, so a decision the operator made before the
    // restart has to be put back in line here or it would wait for a dispatch that
    // never comes. This is the whole reason the message is on disk in the first
    // place.
    for (const key of Object.keys(this.#persisted.pendingResume)) this.#queue.enqueue(Number(key));
    this.#accounts = await loadAccounts(this.#cfg.accountsFile, { canonical: this.#cfg.canonicalConfigDir });
    const picked = await this.#reattachAll();
    await this.poll();
    this.#timer = setInterval(() => void this.poll(), this.#cfg.pollMs);
    // The machine read, on its own timer. The poll above has just taken one, so
    // this only schedules the next: slowing the GitHub poll to fifteen minutes
    // must not slow the number the dispatch banner and the edge-runtime button
    // are drawn from.
    this.#resourcesTimer = setInterval(() => void this.resourceTick(), this.#cfg.resourcesMs);
    // The watcher. One tick straight away so the header is never empty, then a
    // self-rescheduling timer whose interval depends on whether anything of ours
    // is running — 5 s with workers, 30 s without.
    await this.watchTick();
    this.#scheduleWatch();
    // The router-readiness snapshot: once now, then daily. Fire-and-forget —
    // it reads a log and one gh call, and nothing waits on it.
    void this.refreshMetricsSnapshot();
    this.#metricsTimer = setInterval(() => void this.refreshMetricsSnapshot(), this.#cfg.metricsRefreshMs);
    return picked;
  }

  /**
   * Shutting the console down must not touch a single worker.
   *
   * A worker is a detached process writing to a file; this console is one
   * reader of that file. Killing them here — which is what `stopAll()` did — is
   * what made every restart eat whatever was in flight, and it is why the same
   * work kept coming back as "checkpoint — stopped after stage 0". Stop the
   * timer, stop reading, write down where we had got to, and leave.
   */
  async stop(): Promise<{ leftRunning: number }> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#resourcesTimer) clearInterval(this.#resourcesTimer);
    this.#resourcesTimer = null;
    if (this.#metricsTimer) clearInterval(this.#metricsTimer);
    this.#metricsTimer = null;
    this.#stopped = true;
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    this.#watchTimer = null;
    // A PAUSED worker is left paused. Un-pausing is the operator's click and
    // nothing else's — a console shutdown quietly resuming everything would be the
    // console acting on the machine while nobody was looking, which is the one
    // thing this whole feature is built not to do. The `paused` stamp is on its
    // runningRuns row, so it comes back reading paused.
    const leftRunning = await this.#runner.detachAll();
    await this.#save();
    return { leftRunning };
  }

  // ------------------------------------------------------------- re-attaching

  /**
   * For every worker `state.json` says was running: is it still there?
   *
   *  - yes → carry on tailing its stream file from the offset we had reached,
   *    and the row goes back to `active`. Nothing is re-run and nothing is
   *    signalled; from the worker's side the console was never away.
   *  - no  → it ended while we were down. Read its stream file to the end and
   *    put it through exactly the same ending the live path uses, so the gate,
   *    the error and the `runs.jsonl` record all come out identical.
   *
   * The pid check is deliberately suspicious — see reattach.ts. Adopting a pid
   * that is no longer ours would mean "Stop this worker" could signal a
   * stranger's process, so anything unconfirmed is reconciled instead.
   *
   * Entries are handled ONE AT A TIME, and reconciling one runs a full poll
   * before the next has been looked at — so for the whole of this function
   * `activeCount()` reports only the workers attached so far, not the desk.
   * Nothing in the console acts on "the desk is idle" any more, which is the
   * point of there being no automatic restart (docs/INFO.md).
   */
  async #reattachAll(): Promise<{ reattached: number[]; reconciled: number[] }> {
    const entries = Object.values(this.#persisted.runningRuns);
    const reattached: number[] = [];
    const reconciled: number[] = [];
    if (entries.length === 0) return { reattached, reconciled };
    return await this.#reattachEach(entries, reattached, reconciled);
  }

  async #reattachEach(
    entries: RunningRun[],
    reattached: number[],
    reconciled: number[],
  ): Promise<{ reattached: number[]; reconciled: number[] }> {
    // ONE ps for every pid, at startup only.
    const ps = await commandLines(entries.map((e) => e.pid));

    for (const entry of entries) {
      const key = String(entry.issue);
      const provider = entry.provider ?? this.#persisted.providerByIssue[key] ?? 'claude';
      entry.provider = provider;
      entry.agentSessionId ??=
        this.#persisted.agentSessions[key] ?? (provider === 'claude' ? entry.sessionId : null);
      const st = await stat(entry.streamFile).catch(() => null);
      const decision = decideReattach({
        pidAlive: pidAlive(entry.pid),
        commandLine: ps.commands.get(entry.pid) ?? null,
        psRan: ps.ran,
        sessionId: entry.sessionId,
        processIdentityToken: entry.processIdentityToken,
        streamExists: st !== null,
        streamMtimeMs: st?.mtimeMs ?? null,
        startedAtMs: Date.parse(entry.startedAt) || 0,
      });
      // The account the run was STAMPED with when it spawned, not whatever the
      // issue resolves to now: its transcript is in that account's folder.
      const configDir = accountFor(this.#accounts, entry.account).configDir;
      const ctx = contextOf(entry);
      this.#contexts.set(entry.issue, ctx);

      if (decision.attach) {
        reattached.push(entry.issue);
        void this.#track(entry.issue, this.#runner.attach(entry, configDir), ctx);
      } else {
        reconciled.push(entry.issue);
        this.#persisted.endedWhileDown[String(entry.issue)] = new Date().toISOString();
        // The same ending as the live path, from the same files.
        await this.#track(
          entry.issue,
          runResultFrom({
            streamFile: entry.streamFile,
            startOffset: entry.startOffset,
            stderrFile: entry.stderrFile,
            worktree: entry.worktree,
            sessionId: entry.sessionId,
            agentSessionId: entry.agentSessionId,
            configDir,
            provider,
            adapter: this.#providers[provider],
            exitCode: null,
            stopping: false,
            spawnError: null,
          }),
          ctx,
        );
      }
    }
    await this.#save();
    return { reattached, reconciled };
  }

  /** The row that makes a worker findable again: written the instant it exists,
   *  because everything after that instant is a thing that can go wrong. */
  #registerRun(info: SpawnInfo): void {
    const key = String(info.issue);
    const ctx = this.#contexts.get(info.issue);
    this.#persisted.runningRuns[key] = {
      issue: info.issue,
      provider: info.provider,
      sessionId: info.sessionId,
      agentSessionId: info.agentSessionId,
      processIdentityToken: info.processIdentityToken,
      pid: info.pid,
      worktree: info.worktree,
      streamFile: info.streamFile,
      stderrFile: info.stderrFile,
      startOffset: info.startOffset,
      offset: info.startOffset,
      startedAt: info.startedAt,
      model: ctx?.model ?? this.#modelOf(info.issue),
      account: ctx?.account ?? this.#accountOf(info.issue).name,
      headBefore: ctx?.headBefore ?? null,
      stageStart: ctx?.stageStart ?? null,
      labels: ctx?.labels ?? [],
      // Written at spawn like everything else here: after a console restart this
      // row is the ONLY thing that still knows the run in flight is an answer to
      // a question rather than work on a decision.
      ask: ctx?.ask ?? null,
    };
    this.#persisted.providerByIssue[key] = info.provider;
    if (info.agentSessionId) this.#persisted.agentSessions[key] = info.agentSessionId;
    delete this.#persisted.endedWhileDown[key];
    // Both endings describe the run BEFORE this one. A worker is spawning.
    delete this.#persisted.endedWithoutGate[key];
    void this.#save();
  }

  // ---------------------------------------------------------------- polling

  /**
   * Read GitHub, the worktrees and the machine.
   *
   * On a fifteen-minute timer (see `pollMs`), and immediately whenever something
   * has happened that this would otherwise be the first to notice: a worktree
   * created, a run ending, a restart-fresh, an edge-runtime restart, or the operator
   * pressing Refresh. It is guarded against re-entry, so a click during a poll
   * is a no-op rather than a second set of `gh` calls.
   *
   * Returns whether it actually READ. A dropped re-entrant poll used to be
   * indistinguishable from a completed one, and `/api/refresh` reported "read
   * GitHub just now" for it — on the `manual: true` path, which is the only one
   * that outranks the quota brake, pressed at exactly the moment a slow poll is
   * most likely to be in flight.
   */
  async poll(opts: { manual?: boolean } = {}): Promise<boolean> {
    if (this.#polling) return false;
    this.#polling = true;
    const scanGeneration = ++this.#scanGeneration;
    try {
      /**
       * Every GITHUB read that fell back to its previous value, in plain words.
       *
       * Only `listIssues` used to say anything. `listOpenPrs` and
       * `listRecentMergedPrs` swallowed the error and returned the last good
       * map with NO surface at all, while `#lastPolledAt` was stamped
       * regardless — so a rate limit on the two PR lists rendered "GitHub read
       * 16:44" over stage data an hour old, with no banner anywhere. The rule
       * this file states three times is that the age on screen is the age of the
       * DATA, never of the attempt.
       *
       * GitHub only, deliberately: `scanWorktrees` is a local filesystem read
       * and `#lastPolledAt` is rendered as "GitHub read HH:MM". Letting a local
       * failure freeze that stamp would make the label a lie in the other
       * direction.
       */
      const failed: string[] = [];
      const why = (e: Error): string => e.message.split('\n')[0] ?? 'no reason given';
      // Per-list, because the fallback each one takes is only as good as the map
      // it falls back ON. See `#prsUnreadable`.
      let openFailed = false;
      let mergedFailed = false;
      /**
       * Set when GraphQL refused the merged-PR read and REST answered it
       * instead, and it is TWO different polls wearing one name.
       *
       * A whole REST read is not a failure: the map is full, every row below
       * knows where its PR stands, so it never joins `failed`, never sets
       * `mergedFailed`, and never makes a row say "we could not look". It gets a
       * quiet line, because a console running on its second road should say so
       * while it still has one.
       *
       * A CAPPED one is a read that did not finish. The map holds the newest
       * merges and is short at the old end, and nothing downstream can tell a
       * branch that is missing from a branch that never merged — which is the
       * whole 2026-09-05 mechanism, reached this time through a success rather
       * than a refusal. So `capped` goes into `#prsUnreadable` below and the
       * banner goes to `warn`.
       *
       * A HOLDER rather than a `let`, because the assignment happens inside the
       * `onFallback` closure: TypeScript's control-flow analysis narrows a `let`
       * to its initialiser at every use site past a closure it only PASSED
       * (TS#9998), so `mergedViaRest.capped` would be a property access on
       * `never`. A field on an object is not narrowed that way, so the compiler
       * checks the read the poll actually makes.
       */
      const merged: { viaRest: MergedPrsFallback | null } = { viaRest: null };
      const [issues, openPrs, mergedPrs, scans, resources] = await Promise.all([
        listIssues(this.#cfg.repo, this.#cfg.assignee).catch((e: Error) => {
          failed.push(`gh issue list failed: ${why(e)}`);
          return this.#issues;
        }),
        listOpenPrs(this.#cfg.repo).catch((e: Error) => {
          failed.push(`gh pr list (open) failed: ${why(e)}`);
          openFailed = true;
          return this.#openPrs;
        }),
        // One extra read-only list per poll. A failure keeps the LAST merged map
        // rather than emptying it: a flaky network must not resurrect the
        // "checkpoint — stopped after stage 7" lie mid-session.
        listRecentMergedPrs(this.#cfg.repo, this.#cfg.assignee, {
          onFallback: (note) => {
            merged.viaRest = note;
          },
        }).catch((e: Error) => {
          failed.push(`gh pr list (merged) failed: ${why(e)}`);
          mergedFailed = true;
          return this.#mergedPrs;
        }),
        this.#scanWorktreesFromDisk().catch(() => this.#scans),
        probeResources({
          systemReserveBytes: this.#cfg.systemReserveBytes,
          minFreePct: this.#cfg.minFreePct,
          edgeContainer: this.#cfg.edgeContainer,
          workerHeadroomBytes: this.#cfg.workerHeadroomBytes,
        }),
      ]);
      // EVERY failed read, not just the first.
      //
      // `failed[0]` was the whole banner, so a poll that lost two lists named
      // one of them and hid the rest. On 2026-09-05 that sent an hour of
      // debugging at the wrong read: the banner named a read that was
      // incidental and said nothing about the merged-PR query that was actually
      // being rejected — the one every broken row hung off. Which reads are down
      // IS the diagnosis. Still one finished string — the page composes nothing
      // — and still one line, because the banner is one line.
      this.#pollError =
        failed.length === 0
          ? null
          : failed.length === 1
            ? failed[0]!
            : `${failed.length} GitHub reads failed this poll — ${failed.join('; ')}`;
      // THE READ THAT WORKED THE OTHER WAY, in its own words. It says which road
      // answered, why the usual one did not, and how much it came back with —
      // and it admits the one thing REST paging can lose. Composed here, like
      // every other banner, so the page renders a finished string; its register
      // is composed here too, because whether a fallback is worth acting on is a
      // fact about the read, not a styling choice for the page to make.
      const note = fallbackBanner(merged.viaRest);
      this.#pollNote = note?.text ?? null;
      this.#pollNoteWarn = note?.warn ?? false;
      this.#issues = issues;
      this.#openPrs = openPrs;
      this.#mergedPrs = mergedPrs;
      // WHETHER A ROW MAY STILL SAY "no PR" THIS POLL.
      //
      // The two PR reads fall back to their previous map, which is right while
      // there IS one and useless the moment there is not: after a restart both
      // maps start empty, so a rejected query turns "we could not look" into
      // "there is no pull request" for every row at once. That is the 2026-09-05
      // incident — 21 merged PRs erased, 21 rows reading "stopped after stage 8".
      //
      // Per list and not on the merged `#prs`, because a row's PR could be in
      // either one: an unreadable OPEN list with an empty fallback hides an open
      // PR just as completely, even if the merged list answered.
      //
      // AND A CAPPED REST READ COUNTS, with no `size === 0` beside it. The two
      // failure cases above are guarded on an empty map because a failed read
      // over a map we already hold is the case the fallback was written for —
      // the previous answer is still the best answer. A capped read is a
      // different animal: it is THIS poll's answer, it is short by construction,
      // and no size tells you whether the branch you are asking about is one of
      // the ones it never reached. Read 900 merges and miss the one a worktree
      // is waiting on and the row reverts to "checkpoint — stopped after stage
      // 8", which is verbatim the sentence this whole branch exists to delete.
      // A short read is a read we could not complete, and rows say so.
      this.#prsUnreadable =
        (openFailed && openPrs.size === 0) ||
        (mergedFailed && mergedPrs.size === 0) ||
        merged.viaRest?.capped === true;
      // OPEN wins on a branch collision. Branches get reused: a new open PR on a
      // branch whose previous PR merged is the live one, and showing the merged
      // one would send the row to stage 9 while a review is still running.
      this.#prs = new Map([...mergedPrs, ...openPrs]);
      const enrichedScans = await this.#withProviderActivity(scans);
      if (scanGeneration === this.#scanGeneration) this.#scans = enrichedScans;
      // THE SCREENSHOTS, BEFORE ANYTHING RENDERS THE CARD. It is here — first
      // thing after the scan and before every read that depends on it — because
      // this is the poll that `#track` fires the moment a worker parks at gate
      // C, and the whole point is that the first card the operator sees already
      // has the pictures on it rather than a warning asking for the work to be
      // sent back for them. It stamps `.gate.json`, so a run that wrote anything is
      // followed by a fresh scan: everything below reads the stamped file.
      if (await this.#captureMissingShots()) {
        const restamped = await this.#scanWorktreesFromDisk().catch(() => null);
        if (restamped) await this.#publishScans(restamped, scanGeneration);
      }
      // AFTER both lists are in place: which worktrees are orphaned is a question
      // about the two of them together, and asking it against a half-updated pair
      // would read a closed issue for a worktree that has an open one.
      await this.#readOrphanFacts();
      // Same moment, same reason: which issues wear `blocked` is a question about
      // both lists, and the orphan facts are where a closed one's labels come from.
      await this.#readBlockedNotes();
      // A fence refusal for a worktree that is now on disk and tracked describes
      // nothing that is still true. It is dropped HERE rather than at the create
      // call, because the create is exactly where the console had lost sight of
      // the worktree — this is the first moment it can see one again. See
      // `staleFenceJobs` for why only `exists` qualifies.
      for (const issue of staleFenceJobs(this.#provisioner.jobs(), (n) => scans.some((s) => s.issue === n))) {
        this.#provisioner.clear(issue);
      }
      for (const issue of verifiedRecoveryJobs(this.#provisioner.jobs(), (job) =>
        this.#scans.some(
          (scan) => scan.issue === job.issue && scan.path === job.worktreePath && scan.branch === job.branch,
        ),
      )) {
        this.#provisioner.clear(issue);
      }
      this.#resources = resources;
      await this.#mergeThreadAnswers();
      await this.#sweepQaState();
      // Migrate the exact bug #4641 exposed: older builds created a reply block
      // even when the request explicitly said `blocks:false`.
      await this.#reconcileNonBlockingCommentBlocks();
      await this.#checkReplies();
      await this.#checkReviews();
      // Last, because it reads the worktree scan and the review blocks the four
      // calls above have just refreshed — the feed dedups against both.
      await this.#readActions(opts.manual === true);
      await this.#applyBoardMoves();
      // LAST of the poll's own work, because it acts on the gate files, the QA
      // state and the restored evidence that everything above has just
      // refreshed — and because what it does is resume workers, which must not
      // race the reads that decide whether it should.
      await this.#autoDecideSuperchargedGates();
      // Stamped only when the GitHub reads above actually SUCCEEDED. "GitHub
      // read 16:44" is a claim about the data on screen; moving it over a read
      // that fell back to the previous value makes hour-old rows look live, and
      // `#pollError` beside it is what says why it has stopped moving.
      //
      // A capped REST read still moves it, and that is the right reading of the
      // stamp rather than an exception to it: the rows on screen WERE read this
      // minute, they are short and not stale, and freezing the stamp would say
      // the opposite of the true thing. What is short about them is carried
      // where shortness belongs — the `warn` banner and the rows that have gone
      // to "cannot say".
      if (failed.length === 0) {
        this.#lastPolledAt = new Date().toISOString();
        // A GOOD poll, and only a good poll, replaces the startup seed on disk.
        // Writing on a failed one would restamp old data with a fresher-looking
        // file; the next restart is owed the last read that actually happened.
        await this.#saveSnapshot(this.#lastPolledAt);
      }
      this.#changed();
      await this.#dispatch();
      return true;
    } finally {
      this.#polling = false;
    }
  }

  /**
   * The local machine read, on its own two-minute timer.
   *
   * It used to be the fifth entry in the poll's `Promise.all`, which was fine
   * while the poll was two minutes. It is not fine at fifteen: `memory_pressure`,
   * `vm_stat` and one `docker stats` cost no network and no GitHub quota, and
   * the dispatch banner, the edge-runtime button's size label and the poll-side
   * half of `#resourceVerdict` are all drawn from them. Slowing the GitHub poll
   * is not a reason to stop looking at the machine.
   *
   * Deliberately NOT the watcher: that is 5 s / 30 s and stays that way, and it
   * never runs `docker stats` (1–2 s) on its tick.
   */
  async resourceTick(): Promise<void> {
    if (this.#stopped) return;
    this.#resources = await probeResources({
      systemReserveBytes: this.#cfg.systemReserveBytes,
      minFreePct: this.#cfg.minFreePct,
      edgeContainer: this.#cfg.edgeContainer,
      workerHeadroomBytes: this.#cfg.workerHeadroomBytes,
    }).catch(() => this.#resources);
    this.#changed();
    await this.#dispatch();
  }

  /**
   * Pick the worker's ANSWERS up out of the freshly scanned gate files, and
   * retire a thread whose gate is over.
   *
   * There is no new machinery here on purpose. A run ending calls `poll()`
   * (see `#track`), `poll()` calls this, and the `#changed()` a few lines later
   * pushes it down the SSE the page is already listening on — so an answer
   * appears on the card the moment the worker stops, through the same path
   * everything else uses.
   *
   * The merge is by id and write-once (see `mergeThreadAnswers`): the console is
   * authoritative for what was ASKED, the gate file for what was ANSWERED.
   *
   * Retiring is the other half. The thread belongs to ONE gate stop, so it is
   * dropped once a decision has gone out AND the worker has reached its next
   * stop — that is what stops a second round at the same gate letter inheriting
   * the first round's questions. A thread carrying a violation is kept until it is
   * genuinely resolved, because the violation IS the thing the operator has to see.
   */
  async #mergeThreadAnswers(): Promise<void> {
    let dirty = false;
    for (const [key, record] of Object.entries(this.#persisted.gateThreads)) {
      const scan = this.#scans.find((s) => s.issue === Number(key));
      if (!scan) {
        delete this.#persisted.gateThreads[key]; // the worktree is gone
        dirty = true;
        continue;
      }
      const gate = scan.gate;
      // A question still waiting to be DELIVERED holds the thread open whatever
      // else has changed. The thread is the only thing that tells dispatch a held
      // message is a question rather than a decision, so retiring it here would
      // send the operator's question out through the decision path.
      if (record.pendingAskIds.length > 0) continue;
      const decidedAndMovedOn = gate !== null && record.closedAt !== null;
      const differentGate = gate !== null && gate.gate !== record.gate && record.violation === null;
      if ((decidedAndMovedOn || differentGate) && !this.#threadStillInPlay(key, record)) {
        delete this.#persisted.gateThreads[key];
        dirty = true;
        continue;
      }
      if (mergeThreadAnswers(record, scan.gateThreadFile)) dirty = true;
    }
    if (dirty) await this.#save();
  }

  /**
   * Did a targeted rework bring the whole issue back with it?
   *
   * A pure function of (snapshot, current scan) run from `poll()`, rather than a
   * hook on the run that carried it. That is deliberate: a rework can be parked
   * at capacity and delivered by a later dispatch, and the console can be
   * restarted in between — so the check has to work from what is on disk, at any
   * moment, with no memory of who sent what.
   *
   * It only judges a NEW gate stop, and the discriminator is a hash of the raw
   * `.gate.json` BYTES taken when the rework was dispatched — so the old file,
   * still on disk in the seconds before the worker rewrites it, is never mistaken
   * for the answer. It used to be `stoppedAt`, which is a field the WORKER
   * writes: the prompt lists the header fields to carry forward unchanged, a
   * worker that read the stop stamp as one of them was being obedient, and the
   * whole check — dropped evidence, dropped steps, charged past, the `returned`
   * transition itself — then never ran at all.
   *
   * What is left of that hole: a worker that returns a byte-identical file has
   * done nothing, and cannot be told apart from one that has not run yet. That
   * fails safe — their failed tick is still failed, so the gate stays locked.
   *
   * This also sweeps. Ticks belong to ONE gate C stop: once the worker is past
   * gate C the steps they ticked are gone, and a tick left lying around would
   * attach itself to the next click-script that happened to reuse an id.
   */
  async #sweepQaState(): Promise<void> {
    // A scan that failed is not "the worktrees are gone". `poll()` falls back to
    // the previous scan list on error, and on the very first poll that list is
    // empty — so without this a `git worktree list` that hiccuped once would
    // delete every tick the operator had set by hand. Losing their own
    // verification to a transient read is the loss this feature exists to prevent.
    if (this.#scans.length === 0) return;
    let dirty = false;
    const keys = new Set([
      ...Object.keys(this.#persisted.qaVerdicts),
      ...Object.keys(this.#persisted.qaSnapshots),
      ...Object.keys(this.#persisted.qaReworks),
      ...Object.keys(this.#persisted.captures),
    ]);
    for (const key of keys) {
      const issue = Number(key);
      const scan = this.#scans.find((s) => s.issue === issue);
      if (!scan) {
        // The worktree is gone: there is no gate, no steps and nothing to tick.
        delete this.#persisted.qaVerdicts[key];
        delete this.#persisted.qaSnapshots[key];
        delete this.#persisted.qaReworks[key];
        // And no gate file the capture record could still be about. It is
        // bookkeeping, not a fact about the work — unlike `reopenings` and
        // `spinOffs` beside it, which are kept for ever on purpose.
        delete this.#persisted.captures[key];
        dirty = true;
        continue;
      }

      const entry = (this.#persisted.qaReworks[key] ?? []).at(-1) ?? null;
      const snapshot = this.#persisted.qaSnapshots[key] ?? null;
      const held = this.#persisted.pendingResume[key] !== undefined;
      // Delivered at last: the words have left the console, so the round is with
      // the worker even though it was queued when the operator pressed the button.
      if (entry && entry.status === 'queued' && !held) {
        entry.status = 'sent';
        dirty = true;
      }

      const gate = scan.gate;
      const open = entry !== null && (entry.status === 'queued' || entry.status === 'sent');
      if (open && entry && snapshot && !held && !this.#busy(issue) && gate !== null) {
        // `.gate.json` is deleted while a worker resumes, so a gate file that is
        // BACK and DIFFERENT is the return we are waiting for. "Different" is the
        // console's own hash of the raw bytes first, and the worker-written stop
        // stamp only as the fallback for a snapshot taken before that hash
        // existed: keying the check on a field the worker controls meant a worker
        // that carried the header forward unchanged was never checked at all.
        const rewritten =
          snapshot.gateHash !== null ? scan.gateHash !== snapshot.gateHash : gate.stoppedAt !== snapshot.stoppedAt;
        if (rewritten) {
          if (gate.gate !== 'C') {
            entry.violation = chargedPastReworkMessage();
          } else {
            const returned = new Set(scan.gateEvidence.map((e) => e.path));
            const missingEvidence = snapshot.evidence.filter((e) => !returned.has(e.path)).map((e) => e.path);
            const ids = new Set((scan.gateManualQa?.steps ?? []).map((s) => s.id));
            const missingSteps = snapshot.manualQa.steps.map((s) => s.id).filter((id) => !ids.has(id));
            // A path the console can put back is not the same thing as a picture
            // it can put back: `QaSnapshot.evidence` holds the manifest ENTRY and
            // the evidence route reads the bytes live out of the worktree. So a
            // capture the rework deleted is gone whatever the manifest says, and
            // one it rewrote in place is a different picture in the same frame.
            const { gone, changed } = await this.#movedEvidence(scan, snapshot.evidenceStamps ?? {});
            entry.restored = missingEvidence;
            // One violation, and it is the worst thing that happened.
            entry.violation = missingSteps.length
              ? droppedStepsMessage(missingSteps)
              : gone.length
                ? deletedEvidenceMessage(gone)
                : changed.length
                  ? rewrittenEvidenceMessage(changed)
                  : missingEvidence.length
                    ? droppedEvidenceMessage(missingEvidence)
                    : null;
          }
          entry.status = 'returned';
          dirty = true;
        }
      }

      // Past gate C, with nothing outstanding: the ticks and the baseline retire
      // together. The rework records themselves stay — a step that went back to
      // Build is a fact about the work, on the same rule as `reopenings`. A
      // CANCELLED round is not outstanding: it never left the console.
      const outstanding = entry !== null && (entry.status === 'queued' || entry.status === 'sent');
      if (gate !== null && gate.gate !== 'C' && !outstanding && !held && !this.#busy(issue)) {
        if (this.#persisted.qaVerdicts[key] || this.#persisted.qaSnapshots[key]) {
          delete this.#persisted.qaVerdicts[key];
          delete this.#persisted.qaSnapshots[key];
          dirty = true;
        }
      }
    }
    if (dirty) await this.#save();
  }

  /**
   * Is something still going to be WRITTEN ONTO this thread?
   *
   * Retiring is decided from the gate file on disk, and there are two windows
   * where that file is not the evidence it looks like. In both of them the
   * worker is parked at the very stop this thread belongs to, so "a gate file
   * exists" means nothing has happened yet rather than that the worker moved on:
   *
   *  - a DECISION still sitting in `pendingResume` has not been delivered. The
   *    thread was stamped closed the moment the operator clicked, but at capacity
   *    the click only parked — so the next poll dropped their question, the worker's
   *    answer and the "superseded before it was answered" stamp before the
   *    decision had even run. That stamp is the whole reason the record is kept
   *    rather than deleted (see GateThreadEntry.supersededAt).
   *
   *  - a run that is ANSWERING this thread has not ended. Its ending is what
   *    decides whether the worker held the gate or charged past it, and the
   *    verdict is written onto THIS record — so a poll landing in the worker's
   *    own tail time, between writing a new `.gate.json` and exiting, erased
   *    the evidence a moment before it existed. `#checkAskEnding` then found no
   *    record and said nothing, and a charge-past showed up as an ordinary new
   *    gate stop. Pressing Refresh was enough to enter that window.
   *
   * The in-memory context is checked first and the persisted row second, so this
   * is still right in the seconds after a restart, before contexts are rebuilt.
   */
  #threadStillInPlay(key: string, record: GateThreadRecord): boolean {
    if (this.#persisted.pendingResume[key] !== undefined) return true;
    const ask = this.#contexts.get(Number(key))?.ask ?? this.#persisted.runningRuns[key]?.ask ?? null;
    return ask !== null && ask.gate === record.gate;
  }

  /**
   * Repair blocks written by builds that ignored the worker's explicit
   * `blocks:false`. Unlike absence from the assigned-open list, the request file
   * is direct evidence: it names the same target/addressee and says no answer is
   * required. The handled digest prevents its lingering file from resurfacing.
   */
  async #reconcileNonBlockingCommentBlocks(): Promise<void> {
    let changed = false;
    for (const [key, block] of Object.entries(this.#persisted.commentBlocks)) {
      const issueNumber = Number(key);
      if (block.reply !== null) continue;
      const scan = this.#scans.find((candidate) => candidate.issue === issueNumber) ?? null;
      const request = scan?.commentRequest ?? null;
      if (!request || request.blocks) continue;
      const requestTarget = commentTarget(request);
      const blockTarget = block.onTarget ?? { kind: 'issue' as const, number: block.onIssue ?? issueNumber };
      if (
        blockTarget.kind !== requestTarget.kind ||
        blockTarget.number !== requestTarget.number ||
        block.addressee !== request.addressee
      ) continue;
      const requestKey = commentRequestKey(request);
      if (block.requestKey) {
        if (block.requestKey !== requestKey) continue;
        this.#persisted.handledCommentRequests[key] = {
          requestKey,
          handledAt: new Date().toISOString(),
          reason: 'posted-non-blocking',
        };
      } else {
        // Legacy blocks carry no request identity. Same target/addressee alone
        // cannot prove the current file is the one that was posted; a newer
        // request could have overwritten it. Only retire without suppressing the
        // file once the owner row is absent AND its own branch PR is merged —
        // the narrow completed-work shape #4641 has. An open row uses explicit
        // resolution instead of guessing.
        const pr = scan?.branch ? (this.#prs.get(scan.branch) ?? null) : null;
        if (this.#issues.some((issue) => issue.number === issueNumber) || pr?.state !== 'MERGED') continue;
        this.#persisted.handledCommentRequests[key] = {
          requestKey,
          handledAt: new Date().toISOString(),
          reason: 'posted-non-blocking',
        };
      }
      delete this.#persisted.commentBlocks[key];
      changed = true;
    }
    if (changed) await this.#save();
  }

  /**
   * For every issue we posted a comment on and are still waiting to hear back,
   * fetch its comments and see if a reply landed. Read-only — `gh issue view`.
   */
  async #checkReplies(): Promise<void> {
    // Retained explicit-true waits keep polling even when their owner row is
    // absent from the assigned-open list. Absence can mean reassignment or list
    // truncation, not closure, and neither is permission to lose an answer.
    const pending = Object.entries(this.#persisted.commentBlocks).filter(([, block]) => block.reply === null);
    for (const [key, block] of pending) {
      // The ticket the comment actually went on, which is not always the row it
      // hangs off. Falls back to the row for blocks written before `onIssue`
      // existed, which is precisely what those older blocks meant.
      const target = block.onTarget ?? { kind: 'issue' as const, number: block.onIssue ?? Number(key) };
      try {
        // Pull requests share GitHub's issue-comment timeline, so the same
        // read-only query detects a reply on either surface.
        const comments = await viewIssueComments(this.#cfg.repo, target.number);
        const reply = detectReply(comments, block.postedAt, this.#cfg.assignee);
        if (reply) {
          // The read awaited GitHub. A resolve (or a newer post) may have won in
          // that window; never resurrect or overwrite it from this stale poll.
          const current = this.#persisted.commentBlocks[key];
          if (!current || current.postedAt !== block.postedAt || current.requestKey !== block.requestKey) continue;
          this.#persisted.commentBlocks[key] = { ...current, reply };
          await this.#save();
        }
      } catch {
        /* leave it blocked; a failed read is not a reply */
      }
    }
  }

  /**
   * For every tracked issue with an open PR, read the PR and keep its rework
   * rounds honest. Read-only — `gh pr view`.
   *
   * An actionable round is checked against the PR as it stands now FIRST: the
   * reviewer may have moved on, may have asked again, or the rework may have been
   * done outside the console entirely. Any of those resolves the round on its own,
   * with how it resolved written onto it — a round is never deleted. Only when
   * nothing is actionable do we look for a fresh CHANGES_REQUESTED to open the
   * next round, so asks still cannot pile up: one at a time, always.
   */
  async #checkReviews(): Promise<void> {
    // Over the TRACKED WORKTREES, not the open issues. An issue that closed with
    // an actionable rework round still open — which is what happens when the PR
    // merges — would otherwise never be re-examined, and its synthetic row would
    // sit orange for ever. Every other line of this loop already keys off the
    // scan, so this is the pivot that actually empties the waiting-on-you count
    // for merged-and-closed work.
    for (const scan of this.#scans) {
      const branch = scan.branch ?? null;
      const pr = branch ? (this.#prs.get(branch) ?? null) : null;
      if (!pr) continue;

      const key = String(scan.issue);
      const block = this.#persisted.reviewBlocks[key] ?? { pr: pr.number, rounds: [] };
      const last = block.rounds[block.rounds.length - 1];
      const waiting = Boolean(last && isActionable(last));
      // A PR that is not open can only ever RESOLVE a round — no new ask can
      // arrive on it. With nothing waiting there is nothing to learn, so the gh
      // call is not made: the poll costs exactly what it did before.
      if (pr.state !== 'OPEN' && !waiting) continue;

      let signals;
      if (pr.state === 'MERGED') {
        // Merged resolves unconditionally (see resolveRound), so this needs no
        // reviews read at all.
        signals = { latestReviews: [], labels: [], commits: [] };
      } else {
        try {
          signals = await listPrReviews(this.#cfg.repo, pr.number);
        } catch {
          continue; // a failed read is neither a change-request nor a resolution
        }
      }

      let dirty = false;
      if (last && isActionable(last)) {
        const resolved = resolveRound(last, signals, pr.state);
        if (!resolved) continue; // still the ask the operator is looking at — leave it
        last.resolvedBy = resolved.resolvedBy;
        last.resolvedAt = new Date().toISOString();
        last.resolution = resolved.resolution;
        dirty = true;
        // The same reviewer asked again: the replacement round is actionable now,
        // so the row goes orange again — correctly, for the new ask.
        if (resolved.supersededBy) {
          block.pr = pr.number;
          block.rounds.push(nextRound(block.rounds, resolved.supersededBy));
          this.#persisted.reviewBlocks[key] = block;
          await this.#save();
          continue;
        }
      }

      // A new round only ever opens on an OPEN PR. Nothing can be asked for on a
      // PR that has merged, and opening one there would put an orange card on
      // work that is already in.
      const since = block.rounds[block.rounds.length - 1]?.requestedAt ?? new Date(0).toISOString();
      const cr = pr.state === 'OPEN' ? detectChangeRequest(signals.latestReviews, since, this.#cfg.assignee) : null;
      if (cr) {
        block.pr = pr.number;
        block.rounds.push(nextRound(block.rounds, cr));
        dirty = true;
      }
      if (dirty) {
        this.#persisted.reviewBlocks[key] = block;
        await this.#save();
      }
    }
  }

  // ------------------------------------------------ actions on the operator

  /**
   * Read every action on the operator, in ONE read-only GraphQL request.
   *
   * Measured against the live repo: **cost 2 points, nodeCount 2480**, constant
   * whatever the repo is doing (GitHub charges the `first:` values asked for, not
   * the rows returned). ~15 polls in a busy hour is ~30 extra points, 0.6% of the
   * 5,000-per-hour window.
   *
   * The rest of the poll costs more than this docstring used to claim, and the
   * claim mattered because it was the number the brake was sized against.
   * Measured with `GET /rate_limit` deltas either side of each call:
   *
   *     poll() = 3 + P + R + 2
   *
   * 3 for the `Promise.all` lists, 2 for this omnibus, and then the two loops
   * nobody counted: **P** = comment blocks still awaiting a reply
   * (`#checkReplies`, one `gh issue view` each) and **R** = tracked worktrees
   * with an OPEN PR (`#checkReviews`, one `gh pr view` each). Both are serial
   * `await`s with a 30 s timeout apiece, and both are unbounded by design. Today
   * P=0 and R=0, so a poll is 5 points; with eight worktrees all carrying open
   * PRs it is 13, and eight hung `gh pr view` calls stall one poll for four
   * minutes — during which every other trigger is dropped by the `#polling`
   * guard.
   *
   * Two rules this method exists to keep:
   *
   *  - **A failed read never empties the feed.** It keeps the last good actions,
   *    marks them stale, and leaves `fetchedAt` where it was — the age on screen
   *    is the age of the DATA, never of the attempt. Same rule as
   *    `listRecentMergedPrs`.
   *  - **The brake reads the quota fresh.** `GET /rate_limit` is free on every
   *    bucket, and the graphql bucket is drained by the Claude worker sessions at
   *    13–70 points a minute — a rider from the last successful omnibus is up to
   *    fifteen minutes stale about a number that moves that fast.
   */
  /**
   * Read the ledger once, whoever asks first.
   *
   * Lazy rather than start()-only because `poll()` is reachable without
   * `start()` — every test does it, and so does a Refresh that races startup.
   * A poll that ran with an unloaded ledger would treat a restart as a first run
   * and re-seed, which is silent but wrong: the seed would swallow a genuinely
   * new verdict that arrived while the console was down.
   */
  async #ensureNotifyLoaded(): Promise<void> {
    if (this.#notifyLoaded) return;
    this.#notifyStore = await this.#loadNotify();
    this.#notifyLoaded = true;
    // The last good feed, shown immediately — stamped with the age it actually
    // has, so a restart never makes fifteen-minute-old rows look live.
    if (this.#notifyStore.feed) this.#actions = { ...this.#notifyStore.feed, paused: null };
  }

  async #readActions(manual: boolean): Promise<void> {
    await this.#ensureNotifyLoaded();
    const now = new Date();
    const quota = await readGraphqlQuota();
    const brake = quotaBrake({ quota, floor: this.#cfg.actionsQuotaFloor, now, manual });
    if (brake.paused) {
      // Not an error: the rows on screen are still the last true reading, they
      // are just not being refreshed. Saying so is the whole point.
      this.#actions = { ...this.#actions, paused: brake.reason };
      return;
    }

    let payload;
    try {
      payload = await fetchActionsOnMe(this.#cfg.repo, this.#cfg.assignee, now, this.#cfg.actionsLookbackDays);
    } catch (e) {
      const error = (e as Error).message.split('\n')[0] ?? 'GitHub did not answer';
      this.#actions = {
        ...this.#actions,
        stale: true,
        paused: null,
        error,
      };
      return;
    }

    const actions = deriveActions(payload, {
      me: this.#cfg.assignee,
      now,
      seenAt: this.#notifyStore.seenAt,
      lookbackMs: this.#cfg.actionsLookbackDays * 86_400_000,
      trackedIssues: new Set(this.#scans.map((s) => s.issue)),
      // So the console does not report its own board write to the operator as news. The
      // ProjectV2 change comes back with no actor, indistinguishable from a person
      // moving the card, unless we remember that it was us.
      ownBoardMoves: new Map(
        Object.entries(this.#persisted.boardMoves).map(([k, m]) => [Number(k), { to: m.to, at: m.at }]),
      ),
      // A gate card already says "waiting on you", with buttons. The feed does
      // not repeat it — except for a tier-1 verdict, which always shows.
      atGate: new Set(this.#scans.filter((s) => s.gate !== null).map((s) => s.issue)),
      reworkIssues: new Set(
        Object.entries(this.#persisted.reviewBlocks)
          .filter(([, b]) => {
            const last = b.rounds[b.rounds.length - 1];
            return Boolean(last && isActionable(last));
          })
          .map(([key]) => Number(key)),
      ),
      // The third decay signal: the operator is fixing it interactively, in a worktree,
      // right now. Mirrors resolveRound's "handled outside the console".
      branchActivity: new Map(
        this.#scans
          .filter((s) => s.lastActivityAt !== null)
          .map((s) => [s.issue, s.lastActivityAt as string] as const),
      ),
      knownAssigned: new Set(this.#notifyStore.knownAssigned),
      // The work is already moving without the operator. Enumerated over the payload
      // rather than kept as a list, so it cannot drift: a worker live or paused
      // on it, a place in the queue, or a resume the operator has already authorised
      // and the console still owes.
      inFlight: new Set(
        payload.issues
          .map((i) => i.number)
          .filter(
            (n) =>
              this.#runner.isRunning(n) ||
              this.#queue.position(n) !== null ||
              this.#persisted.pendingResume[String(n)] !== undefined,
          ),
      ),
    });

    await this.#recordCloseVerdicts(payload, now);

    // Every PR that references each issue, kept WHOLE, so a row whose fix was
    // folded into another issue's PR can resolve that PR through the branch map
    // and ask whether it says it closes this issue (see `inheritPr`). Cheap: it
    // is the payload already in hand, not a new request. A state-only copy of
    // this used to feed the board writer, which is how a mention could move a
    // card — both readers now ask the same whole reference the same question.
    this.#referencingFull = new Map(payload.issues.map((i) => [i.number, i.referencingPrs]));

    this.#lanes = new Map(
      payload.issues.filter((i) => i.lane !== null).map((i) => [i.number, i.lane as string]),
    );

    this.#openQuestions = new Map(
      payload.issues
        .map((i) => [i.number, openQuestion(i.comments, this.#cfg.assignee)] as const)
        .filter((e): e is readonly [number, OpenQuestion] => e[1] !== null),
    );

    this.#actions = {
      actions,
      fetchedAt: now.toISOString(),
      stale: false,
      error: null,
      seenAt: this.#notifyStore.seenAt,
      quota: payload.quota
        ? { remaining: payload.quota.remaining, limit: payload.quota.limit, resetAt: payload.quota.resetAt }
        : null,
      paused: null,
      pushProblem: this.#actions.pushProblem,
      truncated: payload.truncated,
    };

    // WHAT WAS ACTUALLY ANNOUNCED, intersected with what is still on their plate.
    //
    // Stamping the whole payload here — which is what this line used to do —
    // made suppression permanent. `alreadyHandled` hides "newly assigned" while
    // a gate card, a live worker or a shipped PR owns the issue; if the stamp
    // went down anyway, the row was not deferred, it was SPENT, and when the
    // condition cleared there was no second chance. Every issue this console
    // ever ran a worker on had its assignment event consumed in silence.
    //
    // Both halves are load-bearing:
    //
    //  - the UNION with what was already known is what makes it notify-once —
    //    an issue announced last poll must not be announced again;
    //  - the INTERSECTION with the live payload is what lets an issue that left
    //    their plate and came back read as the fresh ask it is. Closed, or
    //    reassigned away, drops out of `assignedQ` and so out of this set.
    const announced = new Set(actions.filter((a) => a.kind === 'assigned').map((a) => a.subject.number));
    const known = new Set(this.#notifyStore.knownAssigned);
    this.#notifyStore.knownAssigned = payload.issues
      .map((i) => i.number)
      .filter((n) => announced.has(n) || known.has(n));
    await this.#announce(actions, now);
    // AFTER the announce, not before. `#announce` is where the push banner is
    // raised, and it raises it on a fresh object — snapshotting first wrote the
    // pre-banner copy, so the one thing that says "your phone stopped working"
    // did not survive a restart, on the same restart that had already (rightly)
    // deleted the dead subscription. No subscription, no future 410, no way to
    // ever raise it again: silently unsubscribed for good.
    this.#notifyStore.feed = this.#actions;
    await this.#saveNotify();
  }

  /**
   * WRITE DOWN WHAT QA HAD SAID, at the moment a close is first seen.
   *
   * Called from inside `#readActions` and not from `#readOrphanFacts`, though it
   * is the close half of the same question, because the two halves of the answer
   * are refreshed in different places and both have to be current:
   *
   *  - THE CLOSE comes from `#orphanFacts`, refreshed earlier in this same poll.
   *    It carries GitHub's own `closedAt`, which the omnibus payload does not,
   *    and it scopes the record to the issues this console has a worktree for —
   *    the ones it draws a row for and can therefore say anything about;
   *  - THE VERDICT comes from the payload in hand right here, through the same
   *    `newestUatVerdict` the feed uses. Recording from the previous poll's
   *    derived actions would have missed a verdict and a close landing in one
   *    window, which is exactly what #4914 did — `Test Result: Fail` and the
   *    close in the same second.
   *
   * An orphan-closed issue the payload does not carry gets NO record. That is
   * the honest answer and it is a real case: `closedQ` reaches back only
   * `actionsLookbackDays`, and its 20-row page can be cut short. Absence reads
   * as "never established" everywhere downstream; `none` is reserved for a look
   * that found nothing.
   */
  async #recordCloseVerdicts(payload: ActionsPayload, now: Date): Promise<void> {
    const seen = new Map(payload.issues.map((i) => [i.number, i]));
    const sightings: ClosedSighting[] = [];
    for (const fact of this.#orphanFacts.values()) {
      if (fact.state !== 'CLOSED') continue;
      if (this.#persisted.closeVerdicts[String(fact.number)]) continue; // recorded once, for ever
      const issue = seen.get(fact.number);
      if (!issue) continue; // not read this poll — nothing to record, and no guess
      const v = newestUatVerdict(issue, this.#cfg.assignee);
      sightings.push({
        issue: fact.number,
        closedAt: fact.closedAt,
        verdict: v ? { verdict: v.verdict, by: v.comment.author.login } : null,
      });
    }
    if (sightings.length === 0) return;

    const { verdicts, added } = recordCloses(this.#persisted.closeVerdicts, sightings, now);
    if (added.length === 0) return;
    this.#persisted.closeVerdicts = verdicts;
    await this.#save();
    for (const n of added) {
      const v = verdicts[String(n)]!;
      this.#log(`#${n}: closed on GitHub. ${closeLine(v)}`);
    }
  }

  /**
   * Announce what is new — and on the FIRST EVER run, announce nothing.
   *
   * A fresh ledger (first start, or a lost `actions.json`) is seeded from the
   * payload and stays silent. Without that, ten assigned issues and every
   * standing verdict fire at once, on their phone, which is how a notifier gets
   * muted on day one.
   *
   * Sends happen BEFORE the ledger is stamped. A crash between the two then
   * re-sends rather than dropping: duplicates are survivable, a dropped UAT fail
   * is the entire feature.
   */
  async #announce(actions: Action[], now: Date): Promise<void> {
    if (!this.#notifyStore.seeded) {
      this.#notifyStore.ledger = seedLedger(actions, now);
      this.#notifyStore.seeded = true;
      return;
    }
    const prefs: NotifyPrefs = {
      ...this.#notifyStore.prefs,
      // The environment can veto, never enable.
      enabled: this.#notifyStore.prefs.enabled && this.#cfg.notify,
    };
    const plan = planNotifications(actions, this.#notifyStore.ledger, prefs, now);
    if (plan.ledgerable.length === 0) return;

    let sent = plan.pushes.length === 0;
    let removed = 0;
    /** The first thing the relay actually SAID, when it refused rather than
     *  reporting a dead phone. Nothing read this before, so a 400/403/429/500
     *  was indistinguishable from success-with-no-phone. */
    let refusal: string | null = null;
    if (plan.pushes.length > 0 && this.#notifyStore.subscriptions.length > 0) {
      const keys = this.#vapidKeys();
      const alive: PushSubscription[] = [];
      for (const sub of this.#notifyStore.subscriptions) {
        let subAlive = true;
        for (const message of plan.pushes) {
          const r = await sendPush(sub, message, keys);
          if (r.ok) sent = true;
          if (r.gone) {
            // The relay says this phone is gone. Dropping it is right; doing it
            // silently is not — the banner is the point.
            subAlive = false;
            removed += 1;
            break;
          }
          if (!r.ok && refusal === null) refusal = r.error ?? `HTTP ${r.status}`;
        }
        if (subAlive) alive.push(sub);
      }
      this.#notifyStore.subscriptions = alive;
      this.#actions = {
        ...this.#actions,
        pushProblem: pushProblemBanner(removed) ?? pushRefusedBanner(refusal) ?? this.#actions.pushProblem,
      };
    } else if (plan.pushes.length > 0) {
      // Push is on but no phone is registered. That is not a failure to retry
      // for ever: the toast still fired, so the round is done.
      sent = true;
    }

    for (const a of plan.toasts) this.emit('action', a);

    /**
     * The round is SETTLED if any channel delivered it.
     *
     * `sent` used to mean "a push succeeded", which conflated two independent
     * channels. A relay that refuses everything — a regenerated VAPID key gives
     * a permanent 403 — then left the ledger unstamped for ever, and the SAME
     * in-app toasts re-fired on every single poll until the console was
     * restarted. The toast is a real delivery: it reached them, at their desk.
     *
     * So the phone leg's failure is reported in the banner (above) rather than
     * by replaying the notification for ever. When there is no other channel —
     * in-app off, phone refusing — nothing was delivered and the retry is still
     * the right answer, which is what `toasts.length > 0` preserves.
     */
    const delivered = sent || plan.toasts.length > 0;
    this.#notifyStore.ledger = prunedLedger(applySends(this.#notifyStore.ledger, plan.ledgerable, now, delivered), now);
  }

  #vapidKeys(): VapidKeys {
    if (!this.#vapid) this.#vapid = loadOrCreateVapidKeys(this.#cfg.pushKeysFile);
    return this.#vapid;
  }

  /** The public half, for the page's `PushManager.subscribe`. */
  vapidPublicKey(): string {
    return this.#vapidKeys().publicKey;
  }

  notifyPrefs(): NotifyPrefs {
    return this.#notifyStore.prefs;
  }

  async setNotifyPrefs(patch: Partial<NotifyPrefs>): Promise<NotifyPrefs> {
    await this.#ensureNotifyLoaded();
    this.#notifyStore.prefs = {
      ...this.#notifyStore.prefs,
      ...patch,
      kinds: { ...this.#notifyStore.prefs.kinds, ...(patch.kinds ?? {}) },
    };
    await this.#saveNotify();
    this.#changed();
    return this.#notifyStore.prefs;
  }

  /**
   * Register a phone.
   *
   * BOUNDED, and the bound is not a tuning knob. `/api/push/subscribe` has no
   * auth — the console binds loopback and intends to keep it that way, but
   * Tailscale Serve proxies the whole tailnet at it, so any device on the
   * tailnet can register its own keypair and then DECRYPT every push: the kind,
   * the issue number, and the fact a UAT fail landed. A pairing code is the real
   * answer and is not built.
   *
   * Two things this cap does in the meantime. It bounds the blast radius of a
   * registration loop, and it bounds the POLL: every registered device costs up
   * to four sequential HTTPS round trips inside `#announce`, and `#polling` is
   * held shut for all of them. Five is more devices than one person carries.
   *
   * An endpoint already registered always wins — the cap must never stop the
   * operator's own phone refreshing a rotated subscription.
   */
  async savePushSubscription(sub: PushSubscription): Promise<{ ok: boolean; count: number; message?: string }> {
    await this.#ensureNotifyLoaded();
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return { ok: false, count: this.#notifyStore.subscriptions.length };
    const rest = this.#notifyStore.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    if (rest.length >= MAX_PUSH_DEVICES) {
      return {
        ok: false,
        count: this.#notifyStore.subscriptions.length,
        message:
          `${MAX_PUSH_DEVICES} devices are already registered for phone notifications. ` +
          'Remove one from Settings first — and if you do not recognise them all, remove them all and re-register this device.',
      };
    }
    this.#notifyStore.subscriptions = [...rest, sub];
    // A phone that has just registered has nothing to catch up on; anything
    // standing right now is already in the ledger.
    this.#actions = { ...this.#actions, pushProblem: null };
    await this.#saveNotify();
    this.#changed();
    return { ok: true, count: this.#notifyStore.subscriptions.length };
  }

  async removePushSubscription(endpoint: string): Promise<{ ok: boolean; count: number }> {
    await this.#ensureNotifyLoaded();
    this.#notifyStore.subscriptions = this.#notifyStore.subscriptions.filter((s) => s.endpoint !== endpoint);
    await this.#saveNotify();
    this.#changed();
    return { ok: true, count: this.#notifyStore.subscriptions.length };
  }

  /**
   * One push, now, because the operator pressed the button.
   *
   * The setup it proves cannot be proved any other way: keys, subscription,
   * relay, and the phone's own notification permission are four things that each
   * fail silently and only matter when they are away from the desk. A local
   * `showNotification` in the page would prove none of them.
   *
   * It carries no work data at all — not even a number. It is a test of the
   * plumbing, and the plumbing does not need to know what an issue is called.
   */
  async sendTestPush(): Promise<{ ok: boolean; message: string }> {
    await this.#ensureNotifyLoaded();
    const subs = this.#notifyStore.subscriptions;
    if (subs.length === 0) {
      return { ok: false, message: 'No phone is registered yet — turn on phone notifications from the phone first.' };
    }
    const keys = this.#vapidKeys();
    const message = {
      kind: 'test',
      title: 'worker console — test',
      body: 'Phone notifications are working.',
      path: '/',
    };
    const alive: PushSubscription[] = [];
    let sent = 0;
    let removed = 0;
    let failure: string | null = null;
    for (const sub of subs) {
      const r = await sendPush(sub, message, keys);
      if (r.ok) sent += 1;
      if (r.gone) {
        removed += 1;
        continue;
      }
      if (!r.ok && !failure) failure = r.error;
      alive.push(sub);
    }
    this.#notifyStore.subscriptions = alive;
    if (removed > 0) this.#actions = { ...this.#actions, pushProblem: pushProblemBanner(removed) ?? null };
    await this.#saveNotify();
    this.#changed();
    if (sent > 0) {
      return { ok: true, message: `Sent to ${sent} phone${sent === 1 ? '' : 's'} — it should arrive within a few seconds.` };
    }
    if (removed > 0) {
      return { ok: false, message: 'That subscription has expired — re-enable phone notifications from the phone.' };
    }
    return { ok: false, message: `The push was not accepted: ${failure ?? 'no reason given'}` };
  }

  /**
   * "Seen" retires tier 2–3 news. It deliberately does NOT touch tier 1: a UAT
   * send-back is a to-do, and a to-do does not disappear because the operator
   * looked at it. It clears when GitHub says the fix shipped.
   */
  async markActionsSeen(): Promise<{ seenAt: string }> {
    await this.#ensureNotifyLoaded();
    const seenAt = new Date().toISOString();
    this.#notifyStore.seenAt = seenAt;
    this.#actions = { ...this.#actions, seenAt };
    await this.#saveNotify();
    this.#changed();
    return { seenAt };
  }

  /* ----------------------------------------------------- the announced log */

  /**
   * Everything the console has announced, newest first.
   *
   * Read off the SAME ledger that decides what has already been sent, so the log
   * cannot disagree with what actually went out. It is not a second copy of the
   * feed: the feed answers "what still needs me" and empties itself, this answers
   * "what did the console tell me, and when" and does not.
   */
  async notifications(): Promise<{ entries: LogEntry[]; unread: number }> {
    await this.#ensureNotifyLoaded();
    return { entries: notificationLog(this.#notifyStore.ledger), unread: unreadCount(this.#notifyStore.ledger) };
  }

  /** Opening the tab is reading it — the plain bell behaviour, no per-row button. */
  async markNotificationsRead(): Promise<{ ok: true; unread: number }> {
    await this.#ensureNotifyLoaded();
    this.#notifyStore.ledger = markAllRead(this.#notifyStore.ledger, new Date());
    await this.#saveNotify();
    this.#changed();
    return { ok: true, unread: 0 };
  }

  /** Empty the list. It stamps and hides; the entries stay, so nothing the
   *  console has already announced can be announced a second time. */
  async clearNotifications(): Promise<{ ok: true; message: string }> {
    await this.#ensureNotifyLoaded();
    this.#notifyStore.ledger = clearLog(this.#notifyStore.ledger, new Date());
    await this.#saveNotify();
    this.#changed();
    return { ok: true, message: 'log cleared' };
  }

  /** For the bell badge, on every view. */
  unreadNotifications(): number {
    return unreadCount(this.#notifyStore.ledger);
  }

  /** The feed as the page receives it, with its banner already worded. */
  actionsFeed(): ActionsFeed & { banner: string | null } {
    // A kind switched OFF leaves the feed too. The operator set @mentions to off
    // because the swarm @s them constantly, and the bell went quiet — but the four
    // mentions stayed on their Actions list, which is where they were looking. A
    // switch labelled "off" that leaves the thing on screen is not off.
    //
    // Filtered HERE, on the way out, rather than at the source: `uatFail` and the
    // row derivations read `#actions.actions` directly, and a UAT send-back must
    // never be silenceable by a preference.
    const visible = this.#actions.actions.filter((a) => this.#notifyStore.prefs.kinds[a.kind] !== 'off');
    return {
      ...this.#actions,
      actions: visible,
      banner: staleBanner({
        fetchedAt: this.#actions.fetchedAt,
        error: this.#actions.error,
        resetAt: this.#actions.quota?.resetAt ?? null,
        empty: this.#actions.actions.length === 0,
        truncated: this.#actions.truncated,
      }),
    };
  }

  // ---------------------------------------------------------------- watching

  /** The next tick, at the cadence the current situation deserves. A `setTimeout`
   *  chain rather than an interval, so the cadence can change without tearing a
   *  timer down, and unref'd so the watcher is never why the process stays up. */
  #scheduleWatch(): void {
    // A tick can be in flight when the console is stopped, and its `finally`
    // would then schedule the next one into a console that has shut down. The
    // flag is the authority, not the handle: clearing a timeout that has already
    // fired does nothing.
    if (this.#stopped) return;
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    const busy = this.#runner.activeCount() > 0;
    const wait = busy ? this.#cfg.watchIntervalMs : this.#cfg.watchIdleIntervalMs;
    this.#watchTimer = setTimeout(() => {
      void this.watchTick().finally(() => this.#scheduleWatch());
    }, wait);
    this.#watchTimer.unref();
  }

  /**
   * ONE tick: one `ps` for the whole table, one `memory_pressure`, one `vm_stat`.
   * Three short-lived processes and under 100 ms of work, every 5 s — under 2 %
   * of one core, no network, no `docker stats`.
   *
   * Public because a test must be able to drive a tick deterministically instead
   * of waiting on a timer, and because "Refresh" costs nothing here.
   *
   * The re-entrancy guard is the same one `poll()` uses: if a tick is somehow
   * still running when the next is due, the next is skipped rather than stacked.
   */
  async watchTick(): Promise<WatchSample | null> {
    if (this.#watching) return this.#watch;
    this.#watching = true;
    try {
      // A probe that throws degrades to "could not read", never to a crash. The
      // watcher is the thing that is supposed to still be working when the
      // machine is in trouble, and a ladder that treats an unreadable signal as
      // "unmeasurable" is already the documented behaviour of every level.
      const read = async (probe: () => Promise<string>): Promise<string> => probe().catch(() => '');
      const [ps, pressure, vm] = await Promise.all([
        read(this.#watchProbes.psForest),
        read(this.#watchProbes.memoryPressure),
        read(this.#watchProbes.vmStat),
      ]);
      const procs = parsePsForest(ps);
      const running = Object.values(this.#persisted.runningRuns).map((r) => ({ issue: r.issue, pid: r.pid }));
      const workers = sampleWorkers(procs, running);
      const sample: WatchSample = {
        at: new Date().toISOString(),
        freePct: parseMemoryPressure(pressure),
        headroomBytes: parseVmStat(vm),
        workers,
      };
      this.#watch = sample;
      this.#trees = new Map(workers.map((w) => [w.issue, w]));
      await this.#rememberPeaks(workers);

      const shape = this.#forecast(sample);
      const step = nextWatchState(
        this.#watchState,
        {
          at: sample.at,
          freePct: sample.freePct,
          forecastComfortable: shape.comfortable,
          anyPaused: this.#pausedIssues().length > 0,
        },
        {
          minFreePct: this.#cfg.minFreePct,
          warnFreePct: this.#cfg.warnFreePct,
          pauseFreePct: this.#cfg.pauseFreePct,
          floorFreePct: this.#cfg.floorFreePct,
          autoPause: this.#cfg.autoPause,
          autoPauseFloor: this.#cfg.autoPauseFloor,
        },
      );
      this.#watchState = step.state;
      if (step.act) await this.#applyWatchAct(step.act.kind, sample);
      this.#changed();
      return sample;
    } finally {
      this.#watching = false;
    }
  }

  /**
   * The ONLY thing the automation is allowed to do: pause.
   *
   * There is no branch here that kills, restarts, unpauses or dispatches, and
   * there must never be. A pause is reversible and loses nothing on disk, which
   * is precisely why automating it is defensible where automating the
   * edge-runtime restart was not — that one was destructive and irreversible
   * mid-flight. Un-pausing stays the operator's click, so the system cannot flap.
   */
  async #applyWatchAct(kind: 'pause-largest' | 'pause-all', sample: WatchSample): Promise<void> {
    const free = sample.freePct === null ? 'free % unknown' : `${sample.freePct}% free`;
    if (kind === 'pause-all') {
      await this.pauseAllWorkers('floor', `${free} — the memory floor`);
      return;
    }
    const biggest = [...sample.workers]
      .filter((w) => !this.#persisted.runningRuns[String(w.issue)]?.paused)
      .sort((a, b) => b.treeBytes - a.treeBytes)[0];
    if (biggest) await this.pauseWorker(biggest.issue, 'floor', `${free} — the largest tree, ${gb(biggest.treeBytes)}`);
  }

  /** The peak each running worker's tree has reached THIS RUN. Kept in memory
   *  every tick; written to disk only when it grows by a real amount. */
  async #rememberPeaks(workers: WorkerSample[]): Promise<void> {
    let worthSaving = false;
    for (const w of workers) {
      const entry = this.#persisted.runningRuns[String(w.issue)];
      if (!entry) continue;
      const before = entry.peakTreeBytes ?? 0;
      if (w.treeBytes <= before) continue;
      entry.peakTreeBytes = w.treeBytes;
      if (w.treeBytes - before >= PEAK_SAVE_DELTA_BYTES) worthSaving = true;
    }
    if (worthSaving) await this.#save();
  }

  #forecast(sample: WatchSample) {
    return forecast({
      headroomBytes: sample.headroomBytes,
      spikeBytes: this.#cfg.workerHeadroomBytes,
      workers: sample.workers.map((w) => ({
        treeBytes: w.treeBytes,
        paused: Boolean(this.#persisted.runningRuns[String(w.issue)]?.paused),
      })),
      floorFreePct: this.#cfg.floorFreePct,
      autoPauseFloor: this.#cfg.autoPauseFloor,
    });
  }

  /** Every worker that is frozen right now. */
  #pausedIssues(): number[] {
    return Object.values(this.#persisted.runningRuns)
      .filter((r) => r.paused)
      .map((r) => r.issue);
  }

  /** What the UI receives — the sample, the level, the sentence, and the numbers
   *  the panel needs to state its own thresholds and cost rather than hard-code
   *  them into the page. */
  #watchReport(): WatchReport | null {
    const sample = this.#watch;
    if (!sample) return null;
    const shape = this.#forecast(sample);
    return {
      sample,
      level: this.#watchState.level,
      forecast: {
        sentence: shape.sentence,
        comfortable: shape.comfortable,
        projectedHeadroomBytes: shape.projectedHeadroomBytes,
      },
      workers: sample.workers.map((w) => {
        const entry = this.#persisted.runningRuns[String(w.issue)] ?? null;
        return {
          issue: w.issue,
          pid: w.pid,
          procCount: w.procCount,
          treeBytes: w.treeBytes,
          stoppedProcs: w.stoppedProcs,
          peakTreeBytes: entry?.peakTreeBytes ?? null,
          paused: entry?.paused ?? null,
          lastTool: this.#runner.live(w.issue)?.lastTool ?? null,
        };
      }),
      spikeBytes: this.#cfg.workerHeadroomBytes,
      autoPauseFloor: this.#cfg.autoPauseFloor,
      thresholds: {
        minFreePct: this.#cfg.minFreePct,
        warnFreePct: this.#cfg.warnFreePct,
        pauseFreePct: this.#cfg.pauseFreePct,
        floorFreePct: this.#cfg.floorFreePct,
      },
      intervalMs: this.#runner.activeCount() > 0 ? this.#cfg.watchIntervalMs : this.#cfg.watchIdleIntervalMs,
      totalBytes: this.#resources?.totalBytes ?? 0,
    };
  }

  // ------------------------------------------------------------ pause & resume

  /** The process groups a pause has to signal, leader's group first. The watcher
   *  measured them; with no sample yet we fall back to the pid itself, which IS
   *  the pgid for a worker spawned `detached: true` (verified on this machine —
   *  see watch.ts). */
  #groupsOf(entry: RunningRun): number[] {
    const measured = this.#trees.get(entry.issue)?.pgids ?? [];
    return measured.length > 0 ? measured : [entry.pid];
  }

  /**
   * Freeze one worker's whole process tree — the lever that gives the machine
   * its memory back without throwing away any work.
   *
   * What survives, stated because it is the whole justification: uncommitted
   * edits (on disk), the session transcript (a jsonl on disk, appended as it
   * goes), the gate files and history, the queue and any pending resume. Nothing
   * is written over and nothing is deleted. The one honest caveat is in
   * docs/INFO.md's survival matrix: a pause that lands while the model is
   * mid-stream can cost a retried request, or at worst end the segment as
   * `failed` — recoverable by the existing one-click resume, and still nothing
   * lost on disk.
   *
   * A paused worker GIVES ITS SLOT BACK. It stays in the runner's map, but
   * `#slotsTaken()` subtracts it, so parking one issue to work another is
   * exactly what the button does. What it still holds is RAM — its pages are
   * resident, `memory_pressure`, `vm_stat` and the swap reading all see them —
   * and the memory guard is what decides whether there is room for the next
   * worker. Slot and memory are two different questions and are answered by two
   * different brakes.
   */
  async pauseWorker(
    issueNumber: number,
    by: 'you' | 'floor',
    reason: string,
  ): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    const entry = this.#persisted.runningRuns[key];
    if (!entry || !this.#runner.isRunning(issueNumber)) {
      return { ok: false, message: `#${issueNumber} is not running, so there is nothing to pause` };
    }
    if (entry.paused) return { ok: false, message: `#${issueNumber} is already paused` };

    const groups = this.#groupsOf(entry);
    const failed: string[] = [];
    for (const pgid of groups) {
      try {
        this.#signalGroup(pgid, 'SIGSTOP');
      } catch (e) {
        failed.push(`${pgid}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    // Every group failing means nothing stopped — do NOT stamp a pause that did
    // not happen, or the row would lie and dispatch would hold for nothing.
    if (failed.length === groups.length) {
      return { ok: false, message: `could not pause #${issueNumber} — ${failed.join('; ')}` };
    }

    const stamp: PausedStamp = { at: new Date().toISOString(), by, reason };
    entry.paused = stamp;
    await this.#save();
    this.#log(`#${issueNumber}: paused (${by === 'floor' ? 'memory floor' : 'you'}) — ${reason}`);
    // Re-evaluate immediately: the slot this worker just gave back is free NOW,
    // and anything queued behind it should start rather than wait for a poll.
    // The memory guard still has its say — a pause frees a slot, not RAM.
    void this.#dispatch();
    this.#changed();
    return {
      ok: true,
      message:
        `#${issueNumber} paused — ${reason}. Its edits, session and gate history are untouched, and ` +
        `it has given its slot back, so you can start another issue. It still holds its memory ` +
        `(the processes are frozen, not gone), so the memory guard may still hold the next one.`,
    };
  }

  /**
   * SIGCONT: the worker picks up exactly where it was. Always a click — the
   * automation never resumes anything, which is what stops it flapping between
   * pausing and un-pausing on a machine that is oscillating around a threshold.
   */
  async unpauseWorker(issueNumber: number): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    const entry = this.#persisted.runningRuns[key];
    if (!entry?.paused) return { ok: false, message: `#${issueNumber} is not paused` };

    // In reverse: the leader's group is signalled last so the tree comes back
    // with its children already running.
    const failed: string[] = [];
    for (const pgid of [...this.#groupsOf(entry)].reverse()) {
      try {
        this.#signalGroup(pgid, 'SIGCONT');
      } catch (e) {
        failed.push(`${pgid}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    const held = Date.now() - (Date.parse(entry.paused.at) || Date.now());
    entry.pausedMs = (entry.pausedMs ?? 0) + Math.max(0, held);
    entry.paused = null;
    await this.#save();
    // The hold this worker was placing on dispatch is gone, so anything queued
    // behind it can go now rather than waiting for a timer.
    void this.#dispatch();
    this.#changed();
    return {
      ok: true,
      message: failed.length > 0
        ? `#${issueNumber} resumed, but some of it may not have restarted — ${failed.join('; ')}`
        : `#${issueNumber} resumed after ${Math.round(held / 1000)}s paused`,
    };
  }

  /** The floor's one act, and the button beside the banner. */
  async pauseAllWorkers(by: 'you' | 'floor', reason: string): Promise<{ ok: boolean; message: string }> {
    const targets = Object.values(this.#persisted.runningRuns).filter((r) => !r.paused);
    if (targets.length === 0) return { ok: false, message: 'nothing is running that is not already paused' };
    const done: number[] = [];
    const refused: string[] = [];
    for (const entry of targets) {
      const out = await this.pauseWorker(entry.issue, by, reason);
      if (out.ok) done.push(entry.issue);
      else refused.push(out.message);
    }
    if (done.length === 0) return { ok: false, message: `could not pause anything — ${refused.join('; ')}` };
    return {
      ok: true,
      message:
        `paused ${done.map((n) => `#${n}`).join(', ')} — ${reason}. ` +
        `Nothing was killed and nothing is lost; resume each when the machine is comfortable.`,
    };
  }

  // ------------------------------------------------------ instances & memory

  /**
   * What is running on this machine right now: containers, dev servers and this
   * console's own workers, with what each is costing. Read-only. Held for
   * `instancesTtlMs` because `docker stats` and `lsof` are not free and the
   * panel refreshes by hand.
   *
   * The three groups are attributed, not guessed: a dev server is only ever
   * matched to a worktree by BOTH its registered port and its working directory,
   * and port 8080 is never even looked at (see instances.ts).
   */
  async instances(): Promise<InstanceReport> {
    const cached = this.#instancesCache;
    if (cached && Date.now() - cached.at < this.#cfg.instancesTtlMs) return cached.payload;
    const payload = await probeInstances(
      {
        edgeContainer: this.#cfg.edgeContainer,
        worktrees: this.#scans.map((s) => ({ issue: s.issue, path: s.path, port: s.state.port })),
        workers: Object.values(this.#persisted.runningRuns).map((r) => ({ issue: r.issue, pid: r.pid })),
      },
      this.#instanceProbes,
    );
    this.#instancesCache = { at: Date.now(), payload };
    return payload;
  }

  /**
   * Restart the edge runtime — the ONLY container this console ever restarts,
   * by exact name. Nothing here stops, removes or prunes any other container,
   * and `supabase stop` / `db:reset` appear nowhere in this codebase.
   *
   * ONE caller: the operator's click on the button. `cfg.edgeContainer` is the
   * name it measured and the name it restarts, and an EDGE_CONTAINER override can
   * only rename it to another edge runtime — never a db, storage or auth container.
   * There is deliberately no automatic caller; see "Why there is no automatic
   * restart" in docs/INFO.md.
   *
   * Two things happen here that the click alone cannot do:
   *
   *  - an in-flight flag is held across the ~12 seconds, so a double-click
   *    cannot start two restarts and dispatch will not start a worker into one;
   *  - a restart that fails says so, once, rather than failing silently.
   *
   * It does NOT refuse while a worker is running. The dialog says plainly that a
   * mid-flight worker may see an edge function fail, and it is then the operator's
   * call — which is exactly the judgement the automatic path could not make.
   */
  async reclaimEdgeRuntime(): Promise<{ ok: boolean; message: string }> {
    if (this.#reclaiming) {
      return { ok: false, message: 'the edge runtime is already being restarted — waiting for that to finish' };
    }
    const container = this.#cfg.edgeContainer;
    const record: EdgeReclaim = {
      at: new Date().toISOString(),
      grewTo: this.#resources?.edgeRuntimeLabel ?? 'unknown size',
      freePctBefore: this.#resources?.freePct ?? null,
      ok: false,
      error: null,
    };
    this.#lastEdgeReclaim = record;
    this.#reclaiming = true;

    let outcome: { ok: boolean; message: string };
    try {
      this.#changed();
      const out = await this.#restartContainer(container);
      record.ok = true;
      const line = `restarted ${container}: ${out}`;
      this.#log(line);
      this.#instancesCache = null;
      outcome = { ok: true, message: line };
    } catch (e) {
      // The DAEMON's line, not Node's echo of the command. This button failing
      // read the same every time and said nothing — see why.ts.
      record.error = why(e as Error);
      outcome = { ok: false, message: `could not restart ${container}: ${record.error}` };
      this.#log(outcome.message);
    } finally {
      // In a `finally` because a flag that holds dispatch must not be able to
      // survive its own failure: leaving this true would wedge the queue for as
      // long as the console runs.
      this.#reclaiming = false;
    }

    this.#changed();
    if (outcome.ok) await this.poll();
    return outcome;
  }

  /**
   * Stop the dev server belonging to ONE worktree.
   *
   * Always on the operator's click — the "Stop dev server" button in the instances
   * panel, stopping a worker that was actually running, or APPROVING GATE C.
   * Never because a worker merely ARRIVED at a gate: gate C is their manual QA of
   * the running app and the Playwright capture needs the same server, so
   * stopping it there would sabotage the exact workflow the gate exists for.
   * Approving it is the opposite — that is the moment the last customer walks
   * away, and it is still their click that does it.
   *
   * The attribution rule is the panel's, unchanged and non-negotiable: the
   * process must be listening on THAT worktree's registered port and its working
   * directory must be inside THAT worktree. Both, always. A refusal is recorded
   * as a message and nothing else happens.
   */
  async stopDevServerFor(issueNumber: number, why: string): Promise<{ ok: boolean; message: string }> {
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    const out = await stopDevServer(
      { issue: issueNumber, worktree: scan?.path ?? null, registeredPort: scan?.state.port ?? null },
      this.#instanceProbes,
      this.#kill,
    );
    if (out.ok) {
      this.#persisted.devStops[String(issueNumber)] = {
        at: new Date().toISOString(),
        port: out.port!,
        pid: out.pid ?? null,
        why,
      };
      this.#instancesCache = null;
      await this.#save();
      this.#log(`#${issueNumber}: ${out.message} — ${why}`);
      this.#changed();
    }
    return out;
  }

  // --------------------------------------------------------------- accounts

  /** The account an issue runs under: what it was stamped with at spawn, or the
   *  default for an issue that has never been stamped. */
  #accountOf(issueNumber: number): Account {
    return accountFor(this.#accounts, this.#persisted.accountByIssue[String(issueNumber)] ?? null);
  }

  /** Provider is stamped with a session. State written before this field existed
   *  is Claude, preserving every existing worker and registry. */
  #providerOf(issueNumber: number): AgentProviderId {
    const key = String(issueNumber);
    return (
      this.#persisted.runningRuns[key]?.provider ??
      this.#persisted.providerByIssue[key] ??
      this.#accountOf(issueNumber).provider ??
      'claude'
    );
  }

  #agentSessionOf(issueNumber: number): string | null {
    const key = String(issueNumber);
    return (
      this.#runner.agentSessionIdOf(issueNumber) ??
      this.#persisted.runningRuns[key]?.agentSessionId ??
      this.#persisted.agentSessions[key] ??
      (this.#providerOf(issueNumber) === 'claude' ? this.#persisted.sessions[key] ?? null : null)
    );
  }

  /** Console-owned provenance never enters a customer worktree, where a new
   * unignored dotfile could be swept into a PR by `git add -A`. */
  #gateProvenanceFile(): string {
    return `${this.#cfg.stateFile}.gate-provenance.jsonl`;
  }

  /** A known model from the other runtime is never allowed to cross the
   * provider boundary. Unknown ids remain valid so private/renamed models keep
   * the same pass-through behavior the console has always supported. */
  #modelForProvider(provider: AgentProviderId, value?: string | null): string | null {
    const model = value?.trim();
    if (!model) return null;
    const other: AgentProviderId = provider === 'claude' ? 'codex' : 'claude';
    if (isKnownModel(model, other) && !isKnownModel(model, provider)) return null;
    return model;
  }

  #modelConflict(account: Account, value?: string | null): string | null {
    const model = value?.trim();
    if (!model || this.#modelForProvider(account.provider, model)) return null;
    const owner = account.provider === 'claude' ? 'Codex' : 'Claude';
    const destination = account.provider === 'claude' ? 'Claude' : 'Codex';
    return `${model} is a ${owner} model and cannot run under ${destination} profile '${account.name}'`;
  }

  /** Prove a profile's provider-specific launch boundary before any caller
   * abandons or consumes durable work. The adapter repeats the same assertion at
   * spawn, closing the configuration-change window as far as one process can. */
  async #providerReadiness(
    account: Account,
    providerId: AgentProviderId = account.provider,
  ): Promise<string | null> {
    const provider = this.#providers[providerId];
    try {
      await provider.assertReady(account.configDir);
      return null;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return (
        `${provider.label} profile '${account.name}' is not ready: ${detail}. ` +
        `Repair or relink that profile in Settings, then retry.`
      );
    }
  }

  async #resumeReadiness(issueNumber: number): Promise<string | null> {
    const provider = this.#providerOf(issueNumber);
    if (provider === 'codex' && !this.#agentSessionOf(issueNumber)) {
      return `No Codex thread id for #${issueNumber} — restart it fresh so the console can establish one.`;
    }
    return this.#providerReadiness(this.#accountOf(issueNumber), provider);
  }

  #providerFallback(provider: AgentProviderId): string {
    const configured = provider === 'codex' ? this.#cfg.codexWorkerModel : this.#cfg.workerModel;
    return this.#modelForProvider(provider, configured) ?? defaultModelFor(provider);
  }

  /** The destination profile's own resolved default, without an issue/model
   * stamp from the profile being left. */
  #profileModel(account: Account): string {
    return resolveModel({
      account: this.#modelForProvider(account.provider, account.model),
      fallback: this.#providerFallback(account.provider),
    });
  }

  /**
   * The model this issue's next invocation runs with, most specific first:
   * the picker held for the next spawn, what the issue is stamped with, the
   * account's own default, the console's default. Exactly the account chain's
   * shape, so there is one rule rather than two.
   */
  #modelOf(issueNumber: number): string {
    const provider = this.#providerOf(issueNumber);
    const account = this.#accountOf(issueNumber);
    return resolveModel({
      pending: this.#modelForProvider(provider, this.#pendingModel.get(issueNumber)),
      issue: this.#modelForProvider(provider, this.#persisted.modelByIssue[String(issueNumber)]),
      account: this.#modelForProvider(provider, account.provider === provider ? account.model : null),
      fallback: this.#providerFallback(provider),
    });
  }

  /** Stamp every part of a brand-new conversation together. A model id from a
   * different provider is never carried across an account switch. */
  #stampFreshIdentity(issueNumber: number, account: Account, requestedModel?: string | null): string {
    const key = String(issueNumber);
    const model = resolveModel({
      pending: this.#modelForProvider(account.provider, requestedModel),
      account: this.#modelForProvider(account.provider, account.model),
      fallback: this.#providerFallback(account.provider),
    });
    this.#persisted.accountByIssue[key] = account.name;
    this.#persisted.providerByIssue[key] = account.provider;
    this.#persisted.modelByIssue[key] = model;
    delete this.#persisted.agentSessions[key];
    this.#pendingAccount.set(issueNumber, account.name);
    this.#pendingModel.set(issueNumber, model);
    return model;
  }

  /** Where this issue's transcripts live: its own account, or — unstamped — all
   *  of them, newest wins. With one registered account both are the same list. */
  #scanDirs(issueNumber: number): string[] {
    const stamped = this.#persisted.accountByIssue[String(issueNumber)] ?? null;
    if (stamped) {
      const account = accountFor(this.#accounts, stamped);
      return account.provider === 'claude' ? [account.configDir] : [];
    }
    return scanDirsFor(
      { ...this.#accounts, accounts: this.#accounts.accounts.filter((a) => a.provider === 'claude') },
      null,
    );
  }

  /**
   * Ask GitHub about the worktrees with no open issue of the operator's behind them.
   *
   * Small by construction — a number here is a worktree on this laptop whose
   * issue has left `#issues`, which is normally none and occasionally one — so
   * this is one `gh issue view` each, in parallel, once per poll.
   *
   * A number that could not be read KEEPS its previous answer rather than
   * dropping to "unread": a flaky network must not turn a row that correctly
   * said "closed on GitHub" back into the placeholder that reads as a fault.
   * Numbers that stopped being orphaned are dropped, so a reopened issue cannot
   * leave a stale "closed" behind it.
   */
  async #readOrphanFacts(): Promise<void> {
    const orphaned = this.#scans
      .map((s) => s.issue)
      .filter((n) => !this.#issues.some((i) => i.number === n));
    if (orphaned.length === 0) {
      this.#orphanFacts.clear();
      return;
    }
    const read = await describeIssues(this.#cfg.repo, orphaned).catch(() => new Map<number, GhIssueFacts>());
    const next = new Map<number, GhIssueFacts>();
    for (const n of orphaned) {
      const fact = read.get(n) ?? this.#orphanFacts.get(n);
      if (fact) next.set(n, fact);
    }
    this.#orphanFacts = next;
  }

  /**
   * Ask GitHub why each `blocked` issue is blocked.
   *
   * The repo's own label description makes a human responsible for the answer —
   * "Cannot proceed on an external dependency. The comment must name what is
   * being waited on" — and the console was reading the worker's gate history
   * instead, which answers a different question. See `blockedReason`.
   *
   * One read per blocked issue per poll, over both lists: a closed issue can
   * still carry the label, and its row is the one most likely to be read months
   * later. A failed read KEEPS the previous answer rather than dropping the row
   * back to the worker's sentence; a label removed drops it, so an unblocked
   * issue cannot go on explaining itself.
   */
  async #readBlockedNotes(): Promise<void> {
    const blocked = [
      ...this.#issues.filter((i) => i.labels.includes('blocked')).map((i) => i.number),
      ...[...this.#orphanFacts.values()].filter((f) => f.labels.includes('blocked')).map((f) => f.number),
    ];
    if (blocked.length === 0) {
      this.#blockedNotes.clear();
      return;
    }
    const next = new Map<number, GhBlockedNote>();
    await Promise.all(
      blocked.map(async (n) => {
        const note = await readBlockedNote(this.#cfg.repo, n).catch(() => this.#blockedNotes.get(n) ?? null);
        if (note) next.set(n, note);
      }),
    );
    this.#blockedNotes = next;
  }

  /**
   * WHY this issue is not in the open list, in the row's own words.
   *
   * Null for an ordinary row — an issue that IS in `#issues` is not orphaned and
   * this is never asked about it. `unread` is the honest answer before the first
   * poll and after a failed read, and it is the one that keeps the old
   * behaviour: a row that cannot be described still reads as done, because
   * closed is overwhelmingly what absence has always meant.
   */
  #orphanOf(issueNumber: number): OrphanIssue {
    const fact = this.#orphanFacts.get(issueNumber);
    if (!fact) return { reason: 'unread', closedAt: null, assignees: [] };
    if (fact.state === 'CLOSED') return { reason: 'closed', closedAt: fact.closedAt, assignees: [] };
    // Open. `listIssues` asks for both of these, so an open issue that is either
    // is one the fifty-issue page dropped rather than one that left them.
    const theirs = fact.assignees.includes(this.#cfg.assignee) || fact.author === this.#cfg.assignee;
    if (theirs) return { reason: 'still-open', closedAt: null, assignees: fact.assignees };
    return { reason: 'not-yours', closedAt: null, assignees: fact.assignees };
  }

  /** The local half of a poll, kept separate so recovery can verify a newly
   *  attached worktree without waiting behind unrelated GitHub reads. */
  async #scanWorktreesFromDisk(): Promise<WorktreeScan[]> {
    const provenance = await readFile(this.#gateProvenanceFile(), 'utf8').catch(() => '');
    return scanWorktrees(this.#cfg.repoPath, (issue) => this.#scanDirs(issue), provenance);
  }

  async #publishScans(scans: WorktreeScan[], generation: number): Promise<WorktreeScan[]> {
    // Provider activity is helpful row metadata, not part of worktree identity.
    // A transcript probe must not strand a worktree that the Git scan verified.
    const enriched = await this.#withProviderActivity(scans).catch(() => scans);
    if (generation === this.#scanGeneration) this.#scans = enriched;
    return enriched;
  }

  /** `scanWorktrees` understands Claude's per-project transcript layout. Codex
   *  stores rollouts under CODEX_HOME/sessions, so enrich the same neutral scan
   *  shape with activity from its provider adapter. */
  async #withProviderActivity(scans: WorktreeScan[]): Promise<WorktreeScan[]> {
    await Promise.all(
      scans.map(async (scan) => {
        if (this.#providerOf(scan.issue) !== 'codex') return;
        const key = String(scan.issue);
        const agentSessionId = this.#agentSessionOf(scan.issue);
        const consoleSessionId = this.#persisted.sessions[key] ?? scan.gate?.sessionId ?? scan.sessionId;
        if (consoleSessionId) scan.sessionId = consoleSessionId;
        if (!agentSessionId) return;
        const account = this.#accountOf(scan.issue);
        const activity = await this.#providers.codex.sessionActivity({
          worktree: scan.path,
          configDir: account.configDir,
          agentSessionId,
        });
        scan.transcriptMtimeMs = activity;
        scan.newestSessionId = consoleSessionId ?? null;
        if (activity !== null) {
          const existing = scan.lastActivityAt ? Date.parse(scan.lastActivityAt) : 0;
          if (activity > existing) scan.lastActivityAt = new Date(activity).toISOString();
        }
      }),
    );
    return scans;
  }

  /** A session exists for this issue, so its account is locked to whatever wrote
   *  it: the transcript and the server-side conversation live in that account. */
  #hasSession(issueNumber: number): boolean {
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    return Boolean(
      this.#persisted.sessions[String(issueNumber)] ?? scan?.gate?.sessionId ?? scan?.sessionId ?? null,
    );
  }

  /**
   * Re-read accounts.json and report each account's health. Read-only, and it
   * never runs `claude`: booleans about files, never a credential. Each account
   * carries the last login PROBE too, when one has been asked for — a different
   * kind of answer, from `checkAccountLogin`, and clearly marked as such.
   */
  async accountsReport(): Promise<AccountReport[]> {
    await this.#reloadAccounts();
    const hook = codexHooksDocument().hooks.PreToolUse[0]!.hooks[0]!.command;
    const health = await doctor(this.#accounts, {
      canonicalClaudeDir: this.#cfg.canonicalConfigDir,
      canonicalCodexDir: this.#cfg.canonicalCodexDir,
      expectedCodexHookCommand: hook,
    });
    return health.map((h) => ({ ...h, probe: this.#logins.get(h.name) ?? null }));
  }

  /**
   * The definitive "will a worker on this account authenticate?" — one real
   * `claude` run, on the operator's click and never on a timer, because it spends
   * tokens and can hit a rate limit. Its environment comes from the same helper the
   * worker spawn uses, so it cannot pass where a real worker would fail.
   *
   * The result is held in MEMORY only. A login can change outside the console,
   * and a remembered answer written to disk would start looking like a fact.
   */
  async checkAccountLogin(name: string): Promise<{ ok: boolean; message: string; probe?: LoginProbe }> {
    const account = this.#accounts.accounts.find((a) => a.name === name.trim());
    if (!account) return { ok: false, message: `there is no account called '${name}'` };

    const probe = await checkLogin({
      provider: account.provider,
      name: account.name,
      bin: account.provider === 'codex' ? this.#cfg.codexBin : this.#cfg.claudeBin,
      configDir: account.configDir,
      canonicalConfigDir: this.#cfg.canonicalConfigDir,
      timeoutMs: this.#cfg.loginProbeTimeoutMs,
    });
    this.#logins.set(account.name, probe);
    this.#changed();
    return { ok: true, message: `${account.name}: ${probe.detail}`, probe };
  }

  /** Pick up an edited accounts.json without restarting the console. */
  async #reloadAccounts(): Promise<void> {
    this.#accounts = await loadAccounts(this.#cfg.accountsFile, { canonical: this.#cfg.canonicalConfigDir });
    this.#changed();
  }

  /**
   * Add an account to `accounts.json` and reload the registry live. The ONLY
   * thing written is that one file at the repo root: the account's config
   * directory is not created, not touched and not looked inside. Linking it is
   * the vetted script (`linkAccount`); logging in is always the operator in a terminal.
   */
  async addAccount(
    name: string,
    configDir: string,
    provider: AgentProviderId = 'claude',
  ): Promise<{ ok: boolean; message: string }> {
    const wanted = name.trim();
    const dir = configDir.trim();
    if (!ACCOUNT_NAME_RE.test(wanted)) {
      return { ok: false, message: `'${wanted}' is not a usable name — letters and digits, then dots, dashes or _` };
    }
    if (!dir) return { ok: false, message: 'an account needs a config directory, e.g. ~/.claude-work' };
    if (provider !== 'claude' && provider !== 'codex') {
      return { ok: false, message: `unknown agent provider '${String(provider)}'` };
    }
    if (provider === 'codex' && isCanonicalDir(expandHome(dir), this.#cfg.canonicalCodexDir)) {
      return {
        ok: false,
        message:
          `${dir} is the interactive Codex home. Worker Console requires a dedicated CODEX_HOME ` +
          `(for example ~/.codex-worker) so its fail-closed hook never affects interactive Codex.`,
      };
    }

    const file = await readRegistryFile(this.#cfg.accountsFile, { canonical: this.#cfg.canonicalConfigDir });
    if (file.accounts.some((a) => a.name === wanted)) {
      return { ok: false, message: `there is already an account called '${wanted}'` };
    }
    file.accounts.push({ name: wanted, provider, configDir: dir });
    await writeRegistryFile(this.#cfg.accountsFile, file);
    await this.#reloadAccounts();
    return { ok: true, message: `added ${wanted} (${dir}) — link it, then log it in` };
  }

  /** Which account a new issue starts under when the picker is left alone. */
  async setDefaultAccount(name: string): Promise<{ ok: boolean; message: string }> {
    const wanted = name.trim();
    const file = await readRegistryFile(this.#cfg.accountsFile, { canonical: this.#cfg.canonicalConfigDir });
    if (!file.accounts.some((a) => a.name === wanted)) {
      return { ok: false, message: `there is no account called '${wanted}'` };
    }
    file.default = wanted;
    await writeRegistryFile(this.#cfg.accountsFile, file);
    await this.#reloadAccounts();
    return { ok: true, message: `${wanted} is now the default account` };
  }

  /**
   * An account's default model — a preference written into `accounts.json`, one
   * more line in the same file. An empty string clears it, which puts that
   * account back on the console's default. It is not a fence: the picker on the
   * issue still wins, and an unknown id is accepted because `WORKER_MODEL` may
   * name a model this build has never heard of.
   */
  async setAccountModel(name: string, model: string): Promise<{ ok: boolean; message: string }> {
    const wanted = name.trim();
    const chosen = model.trim();
    const file = await readRegistryFile(this.#cfg.accountsFile, { canonical: this.#cfg.canonicalConfigDir });
    const entry = file.accounts.find((a) => a.name === wanted);
    if (!entry) return { ok: false, message: `there is no account called '${wanted}'` };

    const selected: Account = { ...entry, provider: entry.provider === 'codex' ? 'codex' : 'claude' };
    const modelConflict = this.#modelConflict(selected, chosen);
    if (modelConflict) return { ok: false, message: modelConflict };

    if (chosen) entry.model = chosen;
    else delete entry.model;
    await writeRegistryFile(this.#cfg.accountsFile, file);
    await this.#reloadAccounts();
    return {
      ok: true,
      message: chosen
        ? `${wanted} now runs ${chosen} unless an issue says otherwise`
        : `${wanted} is back on the console default (${this.#providerFallback(selected.provider)})`,
    };
  }

  /**
   * Remove a registry ENTRY. It never deletes a directory, and it refuses to
   * remove an account that issues are stamped with — their sessions live in that
   * account's `projects/` and would be orphaned — or the last account left, which
   * would leave the console with nothing to run workers under.
   */
  async removeAccount(name: string): Promise<{ ok: boolean; message: string }> {
    const wanted = name.trim();
    const file = await readRegistryFile(this.#cfg.accountsFile, { canonical: this.#cfg.canonicalConfigDir });
    const entry = file.accounts.find((a) => a.name === wanted);
    if (!entry) return { ok: false, message: `there is no account called '${wanted}'` };
    if (file.accounts.length === 1) {
      return { ok: false, message: `'${wanted}' is the only account — removing it would leave no account to run under` };
    }

    const stamped = Object.entries(this.#persisted.accountByIssue)
      .filter(([, acct]) => acct === wanted)
      .map(([issue]) => `#${issue}`);
    if (stamped.length > 0) {
      return {
        ok: false,
        message:
          `${wanted} is the account ${stamped.join(', ')} ${stamped.length === 1 ? 'runs' : 'run'} under. ` +
          `Restart ${stamped.length === 1 ? 'it' : 'them'} fresh under another account first — a session cannot ` +
          `move, and removing the account would orphan it.`,
      };
    }

    file.accounts = file.accounts.filter((a) => a.name !== wanted);
    if (file.default === wanted) file.default = file.accounts[0]!.name;
    await writeRegistryFile(this.#cfg.accountsFile, file);
    await this.#reloadAccounts();
    return { ok: true, message: `removed ${wanted} from the registry — ${entry.configDir} itself is untouched` };
  }

  /**
   * FENCE NOTE — the one narrow relaxation of "the console never writes into an
   * account config dir". It executes exactly `scripts/link-account.sh <dir>` and
   * nothing else: that script makes two symlinks (`skills`, `CLAUDE.md`) back to
   * the canonical `~/.claude`, is idempotent, and refuses to replace a real file
   * or directory. No other path in the console writes there, no argument but the
   * registered config dir is ever passed, and the script's own output is returned
   * verbatim so the operator sees exactly what it did.
   */
  async linkAccount(name: string): Promise<{ ok: boolean; message: string; output: string }> {
    const account = this.#accounts.accounts.find((a) => a.name === name.trim());
    if (!account) return { ok: false, message: `there is no account called '${name}'`, output: '' };
    const env = {
      ...process.env,
      CANONICAL_CLAUDE_DIR: this.#cfg.canonicalConfigDir,
      CANONICAL_CODEX_DIR: this.#cfg.canonicalCodexDir,
      WORKER_NODE_BIN: process.execPath,
      WORKER_WRITE_FENCE_HOOK: WRITE_FENCE_HOOK,
    };
    const args = account.provider === 'codex' ? ['codex', account.configDir] : [account.configDir];
    try {
      const { stdout, stderr } = await runScript(this.#cfg.linkScript, args, { timeout: 30_000, env });
      return { ok: true, message: `linked ${account.name}`, output: `${stdout}${stderr}`.trim() };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      return {
        ok: false,
        message: `link-account.sh failed for ${account.name}`,
        output: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || (err.message ?? 'no output'),
      };
    }
  }

  // ------------------------------------------------------------------ state

  state(): ConsoleState {
    const verdict = this.#resourceVerdict();
    const rows = this.#issues.map((i) => this.#row(i));
    // A worktree whose issue is closed or reassigned still deserves a row.
    //
    // Built from what GitHub says about that issue where we have it: the REAL
    // title, because "worktree with no matching open issue" identifies nothing —
    // the operator could not tell from the row what the work even was — and the
    // real labels, because a priority and a `blocked` are true of a closed issue
    // too.
    // The placeholder survives for the one case that has earned it, an issue we
    // could not read, and `orphan` carries the reason to the row so the pane can
    // say which of the three this is.
    for (const s of this.#scans) {
      if (rows.some((r) => r.number === s.issue)) continue;
      const fact = this.#orphanFacts.get(s.issue);
      rows.push(
        this.#row(
          {
            number: s.issue,
            title: fact ? fact.title : `#${s.issue} — worktree with no matching open issue`,
            url: fact ? fact.url : `https://github.com/${this.#cfg.repo}/issues/${s.issue}`,
            spunOffFrom: null,
            labels: fact ? fact.labels : [],
            // Empty when there is no open issue to have read an author off.
            author: fact ? fact.author : '',
            updatedAt: fact ? fact.updatedAt : (s.lastActivityAt ?? new Date().toISOString()),
          },
          this.#orphanOf(s.issue),
        ),
      );
    }
    return {
      issues: rows,
      accounts: this.#accounts.accounts.map((a) => ({
        name: a.name,
        provider: a.provider,
        configDir: a.configDir,
        isDefault: a.name === this.#accounts.default,
        model: this.#modelForProvider(a.provider, a.model),
      })),
      defaultAccount: this.#accounts.default,
      // What the pickers offer: the models this build knows, plus anything
      // actually in force that it does not — a custom WORKER_MODEL, or an
      // account pinned to an id from before a rename, is still selectable.
      models: (['claude', 'codex'] as const).flatMap((provider) =>
        pickableModelsFor(
          provider,
          this.#providerFallback(provider),
          ...this.#accounts.accounts
            .filter((a) => a.provider === provider)
            .map((a) => this.#modelForProvider(provider, a.model)),
        ),
      ),
      defaultModel: this.#providerFallback('claude'),
      defaultsByProvider: {
        claude: this.#providerFallback('claude'),
        codex: this.#providerFallback('codex'),
      },
      queue: this.#queue.list(),
      maxActive: this.#cfg.maxActive,
      // The number the page prints beside MAX_ACTIVE, so it has to be the same
      // number dispatch uses — a paused worker is not occupying one of these.
      activeCount: this.#slotsTaken(),
      longToolMs: this.#cfg.longToolMs,
      resources: this.#resources,
      watch: this.#watchReport(),
      lastEdgeReclaim: this.#lastEdgeReclaim,
      dispatchReason: this.#dispatchReason,
      // WHY NOTHING IS STARTING, when something is waiting to.
      //
      // Read here rather than taken from `#dispatchReason`, which is only
      // rewritten when a dispatch actually runs — up to two minutes old, since
      // `resourceTick` is what usually triggers one. This asks the same verdict
      // `#dispatch` asks, at the moment the page is drawn, so the sentence on
      // screen and the decision that froze the queue cannot disagree.
      //
      // Null unless real work is being held: memory can be uncomfortable with an
      // empty desk, and then there is no queued row lying about it and nothing
      // that needs a banner. The ladder and the Resources tab say the rest.
      dispatchHold: this.#queue.list().length > 0 && !verdict.ok ? verdict.reason : null,
      repo: this.#cfg.repo,
      // Every workspace this console knows, for the header's picker. ONE today —
      // `config.ts` carries a single `repo`/`repoPath` — and the list is what the
      // server actually knows rather than a placeholder, so the picker can never
      // offer somewhere the console cannot go. A second entry needs real work
      // behind it (per-repo polling, gh calls, worktree roots and slot accounting),
      // and this field is where that lands.
      workspaces: [this.#cfg.repo],
      repoPath: this.#cfg.repoPath,
      pollError: this.#pollError,
      pollNote: this.#pollNote,
      pollNoteWarn: this.#pollNoteWarn,
      lastPolledAt: this.#lastPolledAt,
      pollMs: this.#cfg.pollMs,
      // Everything on GitHub that needs the operator, riding the SSE the page already
      // listens on — no new read endpoint, no polling from the browser.
      actions: this.actionsFeed(),
      notify: this.#notifyStore.prefs,
      // How many phones are registered. The Settings page could only ever say
      // whether THIS browser was subscribed, so a device registered by anything
      // else on the tailnet was undetectable from the console entirely.
      pushDevices: this.#notifyStore.subscriptions.length,
      // The bell's badge. It rides the state the page already listens on, so the
      // count is live on every view without the browser polling for it.
      unreadNotifications: this.unreadNotifications(),
      // The last audit, until the next one replaces it. The page stamps its
      // age — an audit is a reading, and a reading with no time on it looks
      // live when it is not.
      audit: this.#audit,
      updatedAt: new Date().toISOString(),
    };
  }

  #row(issue: GhIssue, orphan: OrphanIssue | null = null): IssueRow {
    const scan = this.#scans.find((s) => s.issue === issue.number) ?? null;
    const account = this.#accountOf(issue.number);
    const provider = this.#providerOf(issue.number);
    const isRunning = this.#runner.isRunning(issue.number);
    const paused = this.#persisted.runningRuns[String(issue.number)]?.paused ?? null;
    const live = this.#runner.live(issue.number);
    // `.gate.json` is deleted on resume, so a stale `stoppedAtGate:` in the
    // prose keeps reconstructing the gate the worker has already been resumed
    // past. #4344 read GATE E at turn 7 of a live run because of it.
    // The gate file, or nothing. No reconstruction, so a live worker cannot be
    // shadowed by a phantom and a stale sentence cannot invent a decision card.
    const gate = scan?.gate ?? null;
    const branch = scan?.branch ?? null;
    // Its own PR by head branch; failing that, one it was folded into. The
    // fallback is marked `inherited`, so no card claims another issue's PR as
    // this one's own work.
    const pr =
      (branch ? (this.#prs.get(branch) ?? null) : null) ??
      inheritPr(this.#referencingFull.get(issue.number) ?? [], this.#prs, issue.number);
    const sessionId =
      this.#runner.sessionIdOf(issue.number) ??
      this.#persisted.sessions[String(issue.number)] ??
      scan?.sessionId ??
      null;
    const agentSessionId = this.#agentSessionOf(issue.number);

    const detached = decideDetached({
      weAreRunning: isRunning,
      transcriptMtimeMs: scan?.transcriptMtimeMs ?? null,
      mtimeAtOurExit: this.#persisted.exitMtimes[String(issue.number)] ?? null,
      newestSessionId: scan?.newestSessionId ?? null,
      ourSessionId: this.#runner.sessionIdOf(issue.number) ?? this.#persisted.sessions[String(issue.number)] ?? null,
    });

    const lastError = this.#persisted.lastErrors[String(issue.number)] ?? null;
    const queuePosition = this.#queue.position(issue.number);
    const queuedAt = this.#persisted.enqueuedAt[String(issue.number)] ?? null;
    // What the worker last WROTE down. Evidence can outrank it — see effectiveStage.
    const fileStage = scan?.gate?.stage ?? scan?.state.stage ?? null;

    const job = this.#provisioner.job(issue.number);
    const provision = job
      ? {
          phase: job.phase,
          code: job.code,
          branch: job.branch,
          worktreePath: job.worktreePath,
          port: job.port,
          startedAt: job.startedAt,
          error: job.error,
          logTail: job.logTail,
        }
      : null;

    const rawCommentRequest = scan?.commentRequest ?? null;
    const handledCommentRequest = this.#persisted.handledCommentRequests[String(issue.number)] ?? null;
    const foldedTitles = this.#persisted.foldedSpinOffs[String(issue.number)] ?? [];
    // Posting or resolving never writes into a worker-owned worktree. Suppress
    // only the exact request already handled; a later request has a different
    // digest and appears normally.
    const commentRequest =
      rawCommentRequest && handledCommentRequest?.requestKey === commentRequestKey(rawCommentRequest)
        ? null
        : rawCommentRequest;
    const commentBlock = this.#persisted.commentBlocks[String(issue.number)] ?? null;

    // The whole block is the round history; the actionable one is the last round
    // nobody has started and nothing has resolved. Only that surfaces as
    // `reviewBlock` — a round that resolved itself is history, not a card.
    const allRounds = this.#persisted.reviewBlocks[String(issue.number)] ?? null;
    const lastRound = allRounds?.rounds[allRounds.rounds.length - 1] ?? null;
    const reviewBlock = lastRound && isActionable(lastRound) ? allRounds : null;
    const reviewHistory = allRounds?.rounds ?? [];

    // The spine and "stopped after stage N" must reflect reality, not just the
    // worker's last note to itself — an open PR means stage 7 even if the file
    // never got past 5 (work done outside a console worker).
    const stage = effectiveStage({ fileStage, pr });
    // Derived ONCE and read twice — by the row's UAT card and by the sentence
    // deriveStatus writes beside it. Two reads of one fact cannot disagree.
    const uatFail = uatFailFor(this.#actions.actions, issue.number);
    // What QA had said when this close was first seen. Read for the SAME two
    // readers and on the same rule: the card's line and the status sentence are
    // composed from one record, so they cannot word it two ways.
    const closeVerdict = this.#persisted.closeVerdicts[String(issue.number)] ?? null;

    const { status, statusDetail } = deriveStatus({
      hasWorktree: scan !== null,
      isRunning,
      // Frozen, not stuck. It reads BEFORE `isRunning` inside deriveStatus,
      // because a paused worker is still in the runner's map.
      paused,
      gate,
      detached,
      queuePosition,
      queuedAt,
      lastError,
      pr,
      stage,
      // The `blocked` label and the worker's own last word, so a blocked row can
      // say WHY rather than falling to a checkpoint line. See `blockedReason`.
      labels: issue.labels,
      history: scan?.history ?? [],
      // What the PERSON who applied the label said, which outranks the worker's
      // account of where it stopped. #5674 read the worker's and said nothing.
      blockedNote: this.#blockedNotes.get(issue.number) ?? null,
      // Closed on GitHub. Stage 9 exists to get an issue to QA and closed — once
      // it IS closed there is nothing left to ask for. #4336 read "stage 9
      // post-merge" six hours after QA posted a full pass and closed it.
      //
      // Absence from `#issues` used to BE this answer, and it was wrong twice
      // over: an issue can leave that list still open, by being reassigned or by
      // falling off its fifty-issue page, and both then read "closed — QA signed
      // it off". Only a row we actually read as closed says so now, and an
      // orphan we could not read keeps the old assumption, which is what absence
      // has overwhelmingly always meant.
      issueClosed: orphan !== null && (orphan.reason === 'closed' || orphan.reason === 'unread'),
      // What QA had said at the close — so "QA signed it off" is something the
      // console READ rather than something it inferred from the close. Null on
      // a row it never established, and that row says exactly what it said
      // before. See `close-verdict.ts`.
      closeVerdict,
      // The same send-back the UAT chip and card are drawn from, so the sentence
      // beside them cannot contradict them. A `Pass` is not a send-back.
      sentBack:
        uatFail && uatFail.verdict !== 'Pass'
          ? { by: uatFail.by, verdict: uatFail.verdict, inflight: uatFail.inflight }
          : null,
      provision,
      commentRequest: commentRequest ? { addressee: commentRequest.addressee, kind: commentRequest.kind } : null,
      commentBlock,
      reviewBlock: reviewBlock ? { reviewer: lastRound!.reviewer } : null,
      // Honesty about restarts, both ways round: a worker we picked back up did
      // not start now, and a run that ended unattended did not simply stop.
      reattached: live?.reattached ?? false,
      endedWhileDown: Boolean(this.#persisted.endedWhileDown[String(issue.number)]),
      endedWithoutGate: Boolean(this.#persisted.endedWithoutGate[String(issue.number)]),
      // They have answered this one; it is waiting for a slot, not for them. It
      // covers every card, not just the gate: a rework brief or a reopened gate
      // taken while the desk was full is just as answered.
      //
      // A held QUESTION is the one thing that is NOT an answer. `pendingResume`
      // carries both, and `pendingAskIds` is the only thing that tells them
      // apart — so without this test a question asked at capacity took its own
      // gate off the "waiting on you" list, dropped the AT GATE chip, and
      // replaced the gate card with the answered one, putting Approve and
      // Feedback out of reach until a slot freed. An ask decides nothing: the
      // gate is exactly as open as it was and the ball never left their court.
      answered: this.#answerIsQueued(issue.number),
      // Only where the row found NO PR of its own and none to inherit. With a PR
      // in hand the row says what it read, however the poll went; without one it
      // must not turn a failed read into "there is no pull request". See
      // `#prsUnreadable`.
      prsUnreadable: this.#prsUnreadable && pr === null,
    });

    return {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      labels: issue.labels,
      updatedAt: issue.updatedAt,
      author: issue.author,
      // Which issue this was spun off from. The operator needs to know which
      // original ticket each one came from — three of these were sitting in their
      // queue under their own name looking like work the team had asked for.
      spunOffFrom: issue.spunOffFrom,
      // Null on every ordinary row. Set only where `state()` synthesized this
      // from a worktree, and then it says WHY there is no open issue behind it.
      orphan,
      // The verdict that stood when this closed, with its sentence already
      // written. The card renders `line`; nothing in the page re-words it.
      closeVerdict: closeVerdict ? { ...closeVerdict, line: closeLine(closeVerdict) } : null,
      // Where the card sits on the project board — the operator asked for the
      // board's queue column on the issue, so it is clear where it is. Already
      // fetched every poll for lane-change actions and the board pre-check — this
      // just says it.
      lane: this.#lanes.get(issue.number) ?? null,
      // Sent back from UAT by a human, after the work shipped. Read off the SAME
      // derived actions the feed shows — never a second parse of the comments,
      // because two implementations of one predicate drift, and this one decides
      // both what outranks P0 and what reaches their phone.
      //
      // Deliberately NOT the `changes-requested` label: that is the pre-merge
      // swarm bot's, it lands on every feature PR they open, and `reviewBlock`
      // already carries it as status 'rework' inside its own band.
      uatFail,
      // Filed by the very account this console assigns work to. The repo's
      // autoassign workflow then put it in that queue, which is why an issue a
      // worker spun off reads exactly like an issue the team handed over — this
      // is the one bit that tells them apart, and the UI shows it as its own
      // fact rather than folding it into the priority pill.
      selfFiled: issue.author !== '' && issue.author === this.#cfg.assignee,
      // Set aside by the operator. Read straight off the console's own store, and
      // NOTHING else on this row is derived from it: the status, the gate, the
      // stage and the priority all go on saying exactly what they said before
      // they parked it. Parking is presentation and priority, not workflow.
      parked: this.#persisted.parked[String(issue.number)] ?? null,
      worktree: scan?.path ?? null,
      branch,
      port: scan?.state.port ?? null,
      stage,
      // From the CONSOLE's record of their decisions, not from the prose line in
      // the worker's `.issue-state.md`. That line is append-only in practice, so
      // it went stale by design and contradicted the history drawer on the same
      // screen — on 6 of 10 worktrees. It is what made the audit report three
      // skipped gates that the operator had in fact approved.
      gatesPassed: gatesPassedFor(this.#decisions, issue.number, scan?.history ?? []),
      // "Code landed after your QA" — derived from the commit their Gate C
      // approval was given against, rather than left to a worker to volunteer in
      // prose at the next gate. The operator asked why these points were not being
      // surfaced at gate C as potential blockers.
      codeSinceQa: codeSince(this.#decisions, issue.number, 'C', scan?.head ?? null),
      // What they left open at the gate they last approved. It used to evaporate
      // and come back as the worker's own choice, announced as a "last call".
      leftUnanswered:
        this.#decisions
          .filter((d) => d.issue === issue.number && d.decision === 'approved')
          .sort((a, b) => String(a.at).localeCompare(String(b.at)))
          .pop()?.unanswered ?? [],
      gate,
      gateReport: scan?.gateReport ?? null,
      // Union'd with the console's own snapshot when a targeted rework is in
      // play — see `#evidenceFor`. Nothing the operator has looked at disappears
      // from this card because a worker rewrote `.gate.json` badly.
      gateEvidence: this.#evidenceFor(issue.number, scan),
      // The structured click-script, so the card can give real links rather than
      // a reference to a script the operator cannot reach — and with any step the
      // console has already shown them put back underneath it. See `#manualQaFor`.
      gateManualQa: this.#manualQaFor(issue.number, scan),
      // The comprehension quiz. Null locks the gate: a half nobody was offered
      // cannot have been submitted.
      gateQuiz: scan?.gateQuiz ?? null,
      // SUPERCHARGE, both halves: whether this run is currently passing its own
      // gates, and — once one has stopped — the sentence saying why it handed
      // itself back. A run that decides gates without them has to be visible on
      // the row that it is doing so.
      supercharge: {
        on: this.#persisted.supercharged[String(issue.number)] !== undefined,
        autoRounds: this.#persisted.supercharged[String(issue.number)]?.autoRounds ?? 0,
        stopped: this.#persisted.superchargeStopped[String(issue.number)] ?? null,
      },
      // The operator's own ticks, one per QA step. The console's, not the worker's.
      qaVerdicts: this.#persisted.qaVerdicts[String(issue.number)] ?? [],
      // ...and the RESOLVED view of them, joined onto the steps that are on the
      // card right now. The page renders from this rather than re-deriving it:
      // the join is a content hash, and a second implementation of that hash in
      // the browser is a second chance to show a tick against a step the operator
      // never read. One rule, in one place.
      ...this.#qaTicks(issue.number, scan),
      // The latest targeted rework, so the card can say a step went back to
      // Build and whether what came back carried everything else forward.
      qaRework: (this.#persisted.qaReworks[String(issue.number)] ?? []).at(-1) ?? null,
      // What the last screenshot capture did — including nothing, and why. The
      // round key it was filed under is dropped here: the card needs the outcome
      // and the time, and the hash is bookkeeping this side of the wire.
      captureReport: captureOf(this.#persisted.captures[String(issue.number)]),
      // The question-and-answer thread at the open gate. Console-owned, so it
      // survives the window where the gate file has been deleted for a resume.
      gateThread: this.#persisted.gateThreads[String(issue.number)] ?? null,
      history: scan?.history ?? [],
      reopenings: this.#persisted.reopenings[String(issue.number)] ?? [],
      // The operator posts this under their own name, so WHO it reaches is the
      // one fact that has to be on the card. Resolved here, against the issue's
      // real author, rather than printing whatever the worker happened to type.
      commentRequest: commentRequest
        ? {
            ...commentRequest,
            to: commentAddressee({
              addressee: commentRequest.addressee,
              issueAuthor: issue.author,
              me: this.#cfg.assignee,
            }),
          }
        : null,
      // Drafted, never filed by a worker — the fence denies `gh issue create`,
      // because the repo's autoassign workflow would stamp the filer as assignee
      // and move it to `Ready`, so a worker-filed issue skips triage and becomes
      // the operator's assigned work. The row carries the draft, the prefilled
      // GitHub link, AND a console-side file button: the decision stays theirs
      // either way, but filing here means the console learns the new number and
      // can record the link, which the browser form never could.
      // A folded draft is gone from the card: the file lingers until the worker's
      // next resume, and re-offering it would invite filing the very thing that
      // was just absorbed.
      issueRequest:
        scan?.issueRequest && !foldedTitles.includes(scan.issueRequest.title)
          ? {
              ...scan.issueRequest,
              // The request lives in this issue's worktree, so the row is the
              // authoritative base. A missing or stale worker-authored number
              // must not create an unlinked child or make the card describe a
              // different relationship from the one GitHub receives.
              fromIssue: issue.number,
              fileUrl: newIssueUrl(this.#cfg.repo, { ...scan.issueRequest, fromIssue: issue.number }),
            }
          : null,
      /** Spin-offs already filed from this row — the link the browser form lost. */
      spinOffs: this.#persisted.spinOffs[String(issue.number)] ?? [],
      boardRequest: scan?.boardRequest
        ? {
            ...scan.boardRequest,
            boardUrl: boardUrl(this.#cfg.repo.split('/')[0] ?? 'example-org'),
            // Set once the console has moved this card itself. The card then reads
            // in the past tense, with no link and no button — a thing that happened,
            // not a thing wanted.
            applied:
              this.#persisted.boardMoves[`${issue.number}:pr-open`] ??
              this.#persisted.boardMoves[`${issue.number}:started`] ??
              this.#persisted.boardMoves[String(issue.number)] ??
              null,
          }
        : null,
      commentBlock,
      reviewBlock,
      reviewHistory,
      sessionId,
      // Taking over in a terminal has to happen in the SAME account, or the
      // session is not there to resume. The prefix is omitted for the CANONICAL
      // account — not merely the default one — because naming ~/.claude
      // explicitly stops Claude Code finding its Keychain credentials.
      resumeCommand:
        agentSessionId && scan
          ? this.#providers[provider].terminalResumeCommand({
              worktree: scan.path,
              configDir: account.configDir,
              agentSessionId,
            })
          : null,
      provider,
      account: this.#persisted.accountByIssue[String(issue.number)] ?? null,
      accountLocked: this.#hasSession(issue.number),
      // The stamp, and what it actually resolves to through the chain. A session
      // fixes BOTH the account and the model, so `accountLocked` covers both
      // pickers: the only switch either way is a restart fresh.
      model: this.#modelForProvider(provider, this.#persisted.modelByIssue[String(issue.number)]),
      modelResolved: this.#modelOf(issue.number),
      // What to type if this worker says it is not logged in. Composed by the
      // one shared helper, so it can never disagree with the Settings card.
      loginCommand: loginCommandFor(account.configDir, this.#cfg.canonicalConfigDir, provider),
      status,
      statusDetail,
      queuePosition,
      queuedAt,
      pr,
        // GitHub's own verdict on whether this can be handed to a codeowner.
        // Gate E asked "is it ready?" for months and never consulted it.
        handover: handoverBlock(pr),
        // The operator answered the round; the reviewer has not cleared it. Two
        // different events that shared one field until #4344 walked to Gate E on
        // the strength of the first while the second had not happened.
        // reviewHistory, NOT reviewBlock. reviewBlock is the ACTIONABLE block and
        // is null exactly when a round has been answered — which is the only case
        // this function exists for. Wiring it there made the fix inert, and its
        // unit tests passed the whole time because they tested the function and
        // not the wiring.
        reviewOutstanding: reviewOutstanding(reviewHistory, pr ?? {}),
      openQuestion: this.#openQuestions.get(issue.number) ?? null,
      // The whole "what is this waiting on" card, as finished strings. Built
      // here, from the values this row publishes, so the page and the row can
      // never disagree — and built next to `reviewOutstanding` because wiring
      // one of these to the wrong variable is how that one shipped inert.
      waiting: waiting({
        live: live !== null,
        atGate: gate !== null,
        // A rework round with its own Start button is theirs too.
        reworkWaiting: reviewBlock !== null,
        // "There is no open issue of theirs behind this row" — which is what a
        // waiting card must not be raised on, and is broader than closed: an
        // issue that left them is not one to ask them to act on either. An orphan
        // that is still theirs, dropped by the fifty-issue page, is NOT this.
        closed: orphan !== null && orphan.reason !== 'still-open',
        pr: pr
          ? {
              number: pr.number,
              url: pr.url,
              state: pr.state,
              checklist: pr.checklist ?? null,
              // Who GitHub is actually waiting on. Without these the card named
              // the swarm bot, a read-only reviewer that can neither block nor clear.
              reviewDecision: pr.reviewDecision ?? null,
              reviewRequests: pr.reviewRequests ?? [],
              latestReviews: pr.latestReviews ?? [],
              // Without this the card asked GitHub who was reviewing a PR GitHub
              // had shown to nobody. `status.ts` has printed "(draft)" in the
              // detail line since the field was fetched; the decision never saw
              // it, which is how #4375 and #5269 sat at Stage 7 for weeks.
              isDraft: pr.isDraft ?? false,
            }
          : null,
        reviewOutstanding: reviewOutstanding(reviewHistory, pr ?? {}),
        handover: handoverBlock(pr ?? null),
        openQuestion: this.#openQuestions.get(issue.number) ?? null,
      }),
      live,
      paused,
      lastError,
      lastActivityAt: scan?.lastActivityAt ?? null,
      provision,
      // A dev server that vanishes without explanation is a mystery; this is the
      // explanation, on the row that caused it.
      devServerStop: this.#persisted.devStops[String(issue.number)] ?? null,
    };
  }

  // ----------------------------------------------------------------- counts

  /**
   * The four numbers the status panel leads with, over an EASTERN day or range.
   *
   * Three of the four are answered from the console's own audit and cost no
   * network read at all: the notification ledger keys every lane change and
   * every merge it has announced, and `decisions.jsonl` keys every gate D — the
   * approval to raise a PR — the operator asked that a PR being raised be read
   * off that gate rather than costing another gh call.
   *
   * The fourth, issues closed, has no audit entry — nothing announces a closure
   * — so it keeps the read-only `gh issue list --state closed` the prose summary
   * already makes. Said plainly in `sources` rather than left to be discovered.
   *
   * The audit's horizon is the ledger's: `prunedLedger` drops settled entries
   * after LEDGER_TTL_DAYS (30). Inside a month these are true counts; beyond it
   * they under-report, and `beyondAudit` says so instead of quietly shrinking.
   */
  async counts(from: string, to: string): Promise<{
    range: { from: string; to: string; sinceIso: string; untilIso: string };
    counts: Counts;
    beyondAudit: boolean;
    warnings: string[];
  }> {
    const range = etDayRange(from, to);
    const ledger = this.#notifyStore.ledger ?? {};
    const closed = await listClosedIssues(this.#cfg.repo, this.#cfg.assignee, range.sinceIso).then(
      (items) => ({ items, error: null as string | null }),
      (e: Error) => ({ items: [] as Awaited<ReturnType<typeof listClosedIssues>>, error: `gh issue list --state closed: ${e.message.split('\n')[0]}` }),
    );

    return {
      range: { from, to, ...range },
      counts: countsIn({
        ...range,
        laneMoves: laneMovesFromLedger(ledger),
        prsRaised: prsRaisedFrom(this.#decisions),
        prsMerged: mergedPrsFromLedger(ledger),
        issuesClosed: closed.items.map((i) => ({ number: i.number, closedAt: i.closedAt })),
      }),
      beyondAudit: Date.parse(range.sinceIso) < Date.now() - LEDGER_TTL_DAYS * 86_400_000,
      warnings: closed.error === null ? [] : [closed.error],
    };
  }

  /**
   * THE FOUR NUMBERS PER DAY, for the cumulative graph.
   *
   * One pass over the same sources `counts` uses, including its single GitHub
   * read for closed issues — so a month of days costs what one range costs.
   *
   * `auditFrom` is the honest part. The notify ledger keeps 30 days, and
   * `laneMoves` and `prsMerged` both come out of it, so a graph asked for a
   * range older than that would draw a flat line at zero and read as "nothing
   * happened" — the exact lie this console is built against. The series says
   * where the audit actually begins and the graph greys everything before it.
   */
  async series(from: string, to: string): Promise<{
    days: DayCounts[];
    auditFrom: string;
    warnings: string[];
  }> {
    const range = etDayRange(from, to);
    const ledger = this.#notifyStore.ledger ?? {};
    const closed = await listClosedIssues(this.#cfg.repo, this.#cfg.assignee, range.sinceIso).then(
      (items) => ({ items, error: null as string | null }),
      (e: Error) => ({
        items: [] as Awaited<ReturnType<typeof listClosedIssues>>,
        error: `gh issue list --state closed: ${e.message.split('\n')[0]}`,
      }),
    );
    const days = dailyCounts(
      {
        ...range,
        laneMoves: laneMovesFromLedger(ledger),
        prsRaised: prsRaisedFrom(this.#decisions),
        prsMerged: mergedPrsFromLedger(ledger),
        issuesClosed: closed.items.map((i) => ({ number: i.number, closedAt: i.closedAt })),
      },
      etDaysBetween(from, to),
      etDayOf,
    );
    return {
      days,
      auditFrom: etDayOf(new Date(Date.now() - LEDGER_TTL_DAYS * 86_400_000).toISOString()),
      warnings: closed.error === null ? [] : [closed.error],
    };
  }

  /**
   * THE THREE PHASE STARTS PER ISSUE, from sources the console already holds.
   * Shared by `cycle`, which averages the finished legs, and `audit`, which
   * reads each OPEN issue's elapsed time against those averages — one join,
   * so the two can never disagree about when a phase began.
   */
  #momentMaps(): {
    startedAt: Map<number, string>;
    raisedAt: Map<number, string>;
    mergedAt: Map<number, string>;
    /** Merges that could not be pinned to an issue — said, never hidden. */
    unattributed: number;
  } {
    const ledger = this.#notifyStore.ledger ?? {};

    // FIRST start per issue, not the latest: a restart does not reset the clock.
    const startedAt = new Map<number, string>();
    for (const m of laneMovesFromLedger(ledger)) {
      if (m.lane !== 'In progress') continue;
      const held = startedAt.get(m.issue);
      if (held === undefined || Date.parse(m.at) < Date.parse(held)) startedAt.set(m.issue, m.at);
    }

    // FIRST gate D per issue, for the same reason: a re-raised PR after a
    // send-back is the same piece of work.
    const raisedAt = new Map<number, string>();
    for (const p of prsRaisedFrom(this.#decisions)) {
      const held = raisedAt.get(p.number);
      if (held === undefined || Date.parse(p.createdAt) < Date.parse(held)) raisedAt.set(p.number, p.createdAt);
    }

    // PR number → issue. The PR body is authoritative (`Closes #N`); the
    // branch name is the fallback, and it is a good one because
    // `scripts/git-new-worktree.sh` names every branch `…issue-<N>-…`.
    const prToIssue = new Map<number, number>();
    for (const [branch, pr] of this.#prs) {
      // `closes` is the PR body already parsed (`closes.ts`) — the declaration,
      // which is what GitHub itself acts on. The branch is the fallback and a
      // good one: `scripts/git-new-worktree.sh` names every one `…issue-<N>-…`.
      const declared = pr.closes?.[0] ?? null;
      const named = branch.match(/issue-(\d+)-/)?.[1];
      const issue = declared ?? (named === undefined ? null : Number(named));
      if (issue !== null) prToIssue.set(pr.number, issue);
    }
    const mergedAt = new Map<number, string>();
    let unattributed = 0;
    for (const p of mergedPrsFromLedger(ledger)) {
      const issue = prToIssue.get(p.number);
      if (issue === undefined) {
        unattributed += 1;
        continue;
      }
      const held = mergedAt.get(issue);
      if (held === undefined || Date.parse(p.mergedAt) > Date.parse(held)) mergedAt.set(issue, p.mergedAt);
    }

    return { startedAt, raisedAt, mergedAt, unattributed };
  }

  /**
   * THE FOUR MOMENTS PER ISSUE, and what the three legs between them cost.
   *
   * Every source here is one the console already reads, joined per issue:
   *
   *   started  the FIRST `In progress` lane move (`laneMovesFromLedger`).
   *            A ticket bounced back and restarted keeps its first start —
   *            the leg is how long the work took, not how long the last
   *            attempt took.
   *   raised   gate D approved (`prsRaisedFrom`), which is the approval to
   *            raise the PR and lands a minute or two before it.
   *   merged   the merge the console announced. The ledger keys these by PR
   *            number, so they are joined back to an issue through the PR
   *            body`s `Closes #N` and, failing that, the branch name — which
   *            is `fix/issue-<N>-…` by construction.
   *   closed   the issue closed on GitHub, after QA has signed it off.
   *
   * RETENTION DIFFERS BY SOURCE and that is stated rather than smoothed: the
   * ledger keeps 30 days, so `started` and `merged` thin out before
   * `raised` (append-only decisions) and `closed` (asked of GitHub). A leg
   * with one end beyond its source is not measured, which is why every
   * average carries the count it is an average OF.
   */
  async cycle(
    from: string,
    to: string,
  ): Promise<{
    perIssue: Array<Milestones & { legs: Legs }>;
    summary: CycleSummary;
    /** The last seven days of it, and which way that is going. */
    recent: CycleSummary;
    recentDays: number;
    trend: Record<LegKey, Trend | null>;
    warnings: string[];
  }> {
    const range = etDayRange(from, to);
    const closed = await listClosedIssues(this.#cfg.repo, this.#cfg.assignee, range.sinceIso).then(
      (items) => ({ items, error: null as string | null }),
      (e: Error) => ({
        items: [] as Awaited<ReturnType<typeof listClosedIssues>>,
        error: `gh issue list --state closed: ${e.message.split('\n')[0]}`,
      }),
    );

    const { startedAt, raisedAt, mergedAt, unattributed } = this.#momentMaps();

    const closedAt = new Map<number, string>();
    for (const i of closed.items) closedAt.set(i.number, i.closedAt);

    // An issue belongs to the window if ANY of its moments falls in it —
    // otherwise a ticket started before the range and merged inside it would
    // vanish from the very metric it is the point of.
    const since = Date.parse(range.sinceIso);
    const until = Date.parse(range.untilIso);
    const inRange = (iso: string | undefined): boolean => {
      if (iso === undefined) return false;
      const t = Date.parse(iso);
      return Number.isFinite(t) && t >= since && t <= until;
    };
    const issues = new Set<number>();
    for (const map of [startedAt, raisedAt, mergedAt, closedAt]) {
      for (const [issue, at] of map) if (inRange(at)) issues.add(issue);
    }

    const perIssue = [...issues]
      .sort((a, b) => b - a)
      .map((issue) => {
        const m: Milestones = {
          issue,
          startedAt: startedAt.get(issue) ?? null,
          raisedAt: raisedAt.get(issue) ?? null,
          mergedAt: mergedAt.get(issue) ?? null,
          closedAt: closedAt.get(issue) ?? null,
        };
        return { ...m, legs: legsOf(m) };
      });

    const warnings = closed.error === null ? [] : [closed.error];
    if (unattributed > 0) {
      // Said, never hidden: a merge the console cannot pin to an issue is a
      // hole in the middle leg, and a silently smaller sample is the failure
      // this whole file is written against.
      warnings.push(
        `${unattributed} merged PR(s) could not be matched to an issue, so they are not in the raised → merged average`,
      );
    }
    // A WEEK, against the whole range. The operator asked for a week's average
    // beside the overall one — the level alone says nothing about whether it is
    // improving.
    const recentDays = 7;
    const summary = summarise(perIssue.map((p) => p.legs));
    const recent = summariseSince(perIssue, Date.now() - recentDays * 86_400_000);
    const trend = {} as Record<LegKey, Trend | null>;
    for (const key of LEG_KEYS) trend[key] = trendOf(recent[key], summary[key]);
    return { perIssue, summary, recent, recentDays, trend, warnings };
  }

  /**
   * THE AUDIT — read GitHub fresh, then read every open row against what its
   * status claims. The rules live in `audit.ts`; this method only gathers what
   * they read: the rows as `state()` publishes them, the blocked notes, and
   * the same phase moments and 30-day averages the Cycle panel shows — thirty
   * days because that is the ledger's own retention, so a wider ask would
   * widen the window without widening the data behind it.
   *
   * One deliberate mend before judging: a merge older than the ledger's 30
   * days has fallen out of `#momentMaps`, but the PR on the row still carries
   * its own `mergedAt` — and an issue merged five weeks ago and still open is
   * exactly the row an audit exists to catch, so the older stamp is used
   * rather than letting the worst case go unmeasured.
   */
  async audit(): Promise<{ ok: boolean; message: string }> {
    // `manual`, same as Refresh: the operator pressing a button outranks the brake.
    const ran = await this.poll({ manual: true });
    const to = etDayOf(new Date().toISOString());
    const from = etDayOf(new Date(Date.now() - 30 * 86_400_000).toISOString());
    const { summary } = await this.cycle(from, to);
    const { startedAt, raisedAt, mergedAt } = this.#momentMaps();
    const rows = this.state().issues.filter(
      // Open and theirs: a closed issue has nothing to validate, and an orphan
      // that left them (closed, reassigned, unreadable) is not theirs to chase.
      (r) => r.status !== 'done' && (r.orphan == null || r.orphan.reason === 'still-open'),
    );
    this.#audit = auditIssues(
      rows.map((r) => ({
        number: r.number,
        title: r.title,
        status: r.status,
        statusDetail: r.statusDetail,
        parked: r.parked !== null,
        blockedNote: this.#blockedNotes.get(r.number) ?? null,
        prNumber: r.pr?.number ?? null,
        prIsDraft: r.pr?.isDraft ?? false,
        startedAt: startedAt.get(r.number) ?? null,
        raisedAt: raisedAt.get(r.number) ?? null,
        mergedAt:
          mergedAt.get(r.number) ??
          (r.pr?.state === 'MERGED' ? (r.pr.mergedAt ?? null) : null),
      })),
      summary,
    );
    this.#changed();
    const a = this.#audit;
    const counts = `${a.stuck} stuck, ${a.slow} slow, ${a.ok} on pace`;
    const parked = a.parked.length > 0 ? ` — ${a.parked.length} parked row(s) set aside` : '';
    return {
      ok: true,
      message: ran
        ? `read GitHub, then audited ${a.issues.length} open issues — ${counts}${parked}`
        : `a read was already running — audited ${a.issues.length} open issues on what the console holds: ${counts}${parked}`,
    };
  }

  // ---------------------------------------------------------------- summary

  /**
   * The status post for a window: what closed, what merged, what is in review,
   * and — first, because it is the part somebody has to act on — what is waiting
   * on a person. Three extra READ-ONLY gh calls, each allowed to fail on its own:
   * a section we could not read says so in the text and in `warnings`, instead of
   * printing empty and reading as "nothing happened".
   *
   * Cached per window for `summaryTtlMs`. The cached payload is returned whole,
   * generation stamp and all, so a repeat click is the same post rather than a
   * near-identical one.
   */
  async summary(window: SummaryWindow): Promise<SummaryPayload> {
    const cached = this.#summaries.get(window);
    if (cached && Date.now() - cached.at < this.#cfg.summaryTtlMs) return cached.payload;

    const generatedAt = new Date().toISOString();
    const since = windowStart(window, generatedAt);
    const tried = async <T>(what: string, run: Promise<T[]>): Promise<Fetched<T>> =>
      run.then(
        (items) => ({ items, error: null }),
        (e: Error) => ({ items: [], error: `${what}: ${e.message.split('\n')[0]}` }),
      );

    const [closedIssues, mergedPrs, openPrs] = await Promise.all([
      tried('gh issue list --state closed', listClosedIssues(this.#cfg.repo, this.#cfg.assignee, since)),
      tried('gh pr list --state merged', listMergedPrs(this.#cfg.repo, this.#cfg.assignee, since)),
      tried('gh pr list --state open', listAuthoredOpenPrs(this.#cfg.repo, this.#cfg.assignee)),
    ]);

    const built = buildSummary({
      window,
      generatedAt,
      rows: this.state().issues,
      openIssues: this.#issues.map((i) => ({ number: i.number, title: i.title })),
      closedIssues,
      mergedPrs,
      openPrs,
    });

    const payload: SummaryPayload = {
      ...built,
      window,
      generatedAt,
      warnings: [closedIssues.error, mergedPrs.error, openPrs.error].filter((e): e is string => e !== null),
    };
    this.#summaries.set(window, { at: Date.now(), payload });
    return payload;
  }

  // ------------------------------------------------------- worktree creation

  /** Ports already claimed by existing worktrees, so a new one does not collide. */
  #takenPorts(exceptProvisionIssue?: number, scans: WorktreeScan[] = this.#scans): number[] {
    const fromScans = scans.map((s) => s.state.port).filter((p): p is number => p !== null);
    const fromJobs = this.#provisioner
      .jobs()
      .filter((job) => job.issue !== exceptProvisionIssue)
      .map((job) => job.port);
    return [...fromScans, ...fromJobs];
  }

  /** What the confirm dialog shows. Nothing has run at this point. */
  worktreePlan(issueNumber: number): { ok: boolean; message: string; plan?: ProvisionPlan } {
    const issue = this.#issues.find((i) => i.number === issueNumber);
    if (!issue) return { ok: false, message: `#${issueNumber} is not one of your open issues` };
    if (this.#scans.some((s) => s.issue === issueNumber)) {
      return { ok: false, message: `#${issueNumber} already has a worktree` };
    }
    return { ok: true, message: 'ready to create', plan: this.#provisioner.plan(issue, this.#takenPorts()) };
  }

  /**
   * Create-only. The Provisioner re-checks the fence itself before running
   * anything, so this cannot be talked past by a stale plan from the UI.
   *
   * `account` is the picker's choice on the create card — the first screen there
   * is for an issue with no worktree, and so the first place the choice can be
   * made. It is stamped here, before any worker exists, so that the spawn that
   * follows minutes of `npm install` later runs under the account that was
   * picked, whatever happened to the browser in between.
   *
   * Stamping does not lock the issue: the lock is `#hasSession`, and creating a
   * worktree creates no session. The picker on the start card stays live, and
   * simply comes up pre-selected with this choice.
   */
  /**
   * Move the board cards the console is entitled to move, and say nothing.
   *
   * The operator asked that a card left in 'Ready' while the work is actively
   * under way be moved on to 'In Progress' by the agent. The rule and every
   * refusal live in board.ts; this is only the plumbing around it.
   *
   * Called from `poll()` and NOWHERE else. Not from `#row`/`state()`, which the
   * server calls once per open tab per change event — a write placed there would
   * fire many times a minute off caches that only a poll refreshes.
   */
  async #applyBoardMoves(): Promise<void> {
    // No board, nothing to move. `boardProjectNumber` is null when
    // BOARD_PROJECT_NUMBER is unset, and a console without a project board runs
    // everything else exactly as it always did.
    if (this.#cfg.boardProjectNumber === null) return;
    if (this.#applyingBoard) return;
    const projectNumber = this.#cfg.boardProjectNumber;
    this.#applyingBoard = true;
    try {
      for (const scan of this.#scans) {
        const issue = this.#issues.find((x) => x.number === scan.issue) ?? null;
        const branch = scan.branch ?? null;
        const pr = branch ? (this.#prs.get(branch) ?? null) : null;

        // The two milestones, in order. Both are facts the console already holds:
        // a worker has run on this issue, and a pull request is open for it.
        // Neither waits for a worker to draft anything.
        const milestones: Milestone[] = [];
        if (this.#persisted.sessions[String(scan.issue)] || this.#runner.isRunning(scan.issue)) {
          milestones.push('started');
        }
        // A PR that MERGED was submitted for review — the milestone is "a pull
        // request exists", not "one is open right now". Keyed on OPEN only, the
        // card was stranded on `In progress` whenever the console was not
        // watching at the moment the PR was raised: #4329 and #4546 both merged
        // before it could fire, and nothing would ever have moved them. A CLOSED
        // PR does not count — that one was abandoned, not reviewed.
        const submitted = (st: string): boolean => st === 'OPEN' || st === 'MERGED';
        // Its own branch's PR, OR a PR that references it. On #4562 the operator
        // pointed out that work folded into the original issue's PR has been
        // submitted for review too. Its fix went into #4535 and #4535 says `Closes
        // #4562`, so it HAS been submitted for review; it just has no branch of
        // its own. Keyed on the branch alone, a folded-in issue sits on
        // `In progress` for ever.
        //
        // `Closes #4562` was the reason all along, and this used to take the
        // reference on its own word: any PR that so much as named the issue
        // fired the milestone. #5002 was moved `Ready` -> `In review` on
        // 2026-08-21 by PR #5006, which is #5000's work and mentions #5002 as
        // work it deliberately did NOT do. A board write is the one place a
        // wrong guess leaves the laptop, so it asks the same question the row
        // does — see `ownsIssue`.
        const referenced = (this.#referencingFull.get(scan.issue) ?? []).some((r) => {
          const refPr = this.#prs.get(r.headRefName) ?? null;
          return refPr !== null && submitted(r.state) && ownsIssue(refPr, r.headRefName, scan.issue);
        });
        if ((pr && submitted(pr.state)) || referenced) milestones.push('pr-open');

        for (const milestone of milestones) {
          const key = `${scan.issue}:${milestone}`;
          const base = {
            issue: scan.issue,
            milestone,
            createdByOperator: issue !== null && issue.author === this.#cfg.assignee,
            issueClosed: issue === null,
            alreadyDecided: this.#persisted.boardMoves[key] !== undefined,
          };
          // Decide once WITHOUT the card, so a milestone that could never move
          // does not cost a request. `card: null` is the fail-closed answer, so
          // anything refused there can never become a move with the card in hand.
          const dry = decideBoardMove({ ...base, card: null });
          if (dry.act !== 'card' || dry.reason !== 'could not read the board card just now') continue;

          // THE CHEAP PRE-CHECK. The lane the poll already knows decides whether a
          // move is even plausible. Without this, every issue with a session cost
          // a GraphQL read per milestone per poll, for ever — and no hint at all
          // means we do not know where the card is, so we do not touch it.
          const hint = this.#lanes.get(scan.issue) ?? null;
          if (hint === null) continue;
          const settled = decideBoardMove({ ...base, card: { lane: hint, optionIdByName: {} } });
          if (settled.act === 'none') continue; // terminal lane, or nothing to do
          if (settled.act === 'record') {
            // Already where the milestone would put it. Spend it without a read.
            this.#persisted.boardMoves[key] = {
              from: hint,
              to: hint,
              at: new Date().toISOString(),
              why: `${milestone} — ${settled.reason}`,
            };
            await this.#save();
            continue;
          }

          const card = await readBoardItem(this.#cfg.repo, scan.issue, projectNumber);
          const decision = decideBoardMove({ ...base, card });
          if (!decision.spend) continue;

          const to = decision.act === 'move' ? decision.to : card!.lane;
          if (decision.act === 'move') {
            const out = await moveBoardItem(
              { itemId: card!.itemId, projectId: card!.projectId, fieldId: card!.fieldId, optionId: decision.optionId },
              realBoardExec,
            );
            // A failed write records NOTHING: recording it would both lie on the
            // row and burn the one move this milestone gets.
            if (!out.ok) {
              this.#persisted.lastErrors[String(scan.issue)] = `board move failed: ${out.error ?? 'unknown'}`;
              continue;
            }
          }
          this.#persisted.boardMoves[key] = {
            from: card!.lane,
            to,
            at: new Date().toISOString(),
            why: `${milestone} — ${decision.reason}`,
          };
          await this.#save();
          this.#changed();
        }
      }
    } finally {
      this.#applyingBoard = false;
    }
  }

  async createWorktree(
    issueNumber: number,
    account?: string | null,
    model?: string | null,
  ): Promise<{ ok: boolean; message: string }> {
    const planned = this.worktreePlan(issueNumber);
    if (!planned.ok || !planned.plan) return { ok: false, message: planned.message };
    if (account && !hasAccount(this.#accounts, account)) return { ok: false, message: `unknown account '${account}'` };
    const selected = accountFor(
      this.#accounts,
      account ?? this.#persisted.accountByIssue[String(issueNumber)] ?? null,
    );
    const modelConflict = this.#modelConflict(selected, model);
    if (modelConflict) return { ok: false, message: modelConflict };

    const plan = planned.plan;

    // ASK THE DISK, not the cache. `worktreePlan` above refuses when `#scans`
    // already knows about the worktree — but `#scans` IS a cache: empty until
    // the first poll finishes, and one poll behind ever after. Click Create
    // inside that window and the fence refuses further down, a FAILED job is
    // recorded, and the row wears a red "Setting the worktree up failed" card
    // over a worktree that is present and healthy.
    //
    // `staleFenceJobs` clears that on the next poll, which is the right backstop
    // but the wrong first answer: the operator saw the red card on #4405, read it
    // as broken, and asked for the same thing to be fixed twice. A refusal to
    // rebuild something that is already there is not news — it is a plain "you
    // already have one", said before anything is recorded.
    if (await pathExists(plan.worktreePath)) {
      void this.poll(); // pick it up, so the next click gets the cached answer
      return { ok: false, message: `#${issueNumber} already has a worktree — nothing to create` };
    }
    // No try/catch around this. `start` is async, so it REJECTS rather than
    // throwing — a `try` here catches nothing, and the `.catch` below is the only
    // thing that can. That mattered: when the poll below threw, the whole chain
    // went silent, the job was never cleared, and the console carried on with no
    // record of the worktree it had just built. That is how #4642 came to refuse
    // to rebuild something it had made three minutes earlier.
    void this.#provisioner
      .start(plan, () => this.#changed())
      .then(async () => {
        const job = this.#provisioner.job(issueNumber);
        if (job?.phase === 'ready') {
          await this.poll(); // the new worktree now exists; pick it up
          this.#provisioner.clear(issueNumber);
        }
        this.#changed();
      })
      .catch((e: unknown) => {
        this.#persisted.lastErrors[String(issueNumber)] = `creating the worktree failed: ${(e as Error).message}`;
        this.#changed();
      });
    if (account) {
      const key = String(issueNumber);
      this.#persisted.accountByIssue[key] = selected.name;
      this.#persisted.providerByIssue[key] = selected.provider;
      // A profile switch starts from the destination profile's own default,
      // including when both profiles use the same provider.
      this.#persisted.modelByIssue[key] =
        this.#modelForProvider(selected.provider, model) ?? this.#profileModel(selected);
    } else if (model?.trim()) {
      this.#persisted.modelByIssue[String(issueNumber)] = model.trim();
    }
    if (account || model?.trim()) await this.#save();
    this.#changed();
    const under = [account, account ? this.#persisted.modelByIssue[String(issueNumber)] : model?.trim()]
      .filter(Boolean)
      .join(' / ');
    return { ok: true, message: `creating ${plan.branch}${under ? ` under ${under}` : ''}` };
  }

  /** Read-only preview for the explicit recovery confirmation. */
  async existingWorktreePlan(issueNumber: number): Promise<{
    ok: boolean;
    message: string;
    plan?: ContinuationPlan;
  }> {
    const issue = this.#issues.find((candidate) => candidate.number === issueNumber);
    if (!issue) return { ok: false, message: `#${issueNumber} is not one of your open issues` };
    const failed = this.#provisioner.job(issueNumber);
    if (!failed || failed.phase !== 'failed' || failed.code !== 'branch-exists') {
      return { ok: false, message: `#${issueNumber} has no existing-branch failure to continue` };
    }

    const generation = ++this.#scanGeneration;
    let scans: WorktreeScan[];
    try {
      scans = await this.#scanWorktreesFromDisk();
      await this.#publishScans(scans, generation);
    } catch (error) {
      return { ok: false, message: `could not verify the current worktrees: ${(error as Error).message}` };
    }
    const exact = scans.find(
      (scan) => scan.issue === issueNumber && scan.path === failed.worktreePath && scan.branch === failed.branch,
    );
    if (exact) return this.#provisioner.continuationPlan(issue, exact.state.port);

    try {
      this.#provisioner.refreshContinuationPort(issueNumber, this.#takenPorts(issueNumber, scans), () => this.#changed());
    } catch (error) {
      return { ok: false, message: `cannot reserve a recovery port: ${(error as Error).message}` };
    }
    return this.#provisioner.continuationPlan(issue);
  }

  /**
   * Recover from the one create refusal that can preserve existing work: the
   * exact issue branch exists, but its canonical worktree does not. This is an
   * explicit click, never automatic. The Provisioner attaches the branch
   * without `-b`, reset, force, fetch, or deletion; this layer accepts it only
   * after the normal scanner sees the exact path and branch together.
   */
  async continueExistingWorktree(
    issueNumber: number,
    expectedHead?: string,
    expectedPort?: number | null,
    expectedMode?: ContinuationPlan['mode'],
  ): Promise<{ ok: boolean; message: string }> {
    const issue = this.#issues.find((candidate) => candidate.number === issueNumber);
    if (!issue) return { ok: false, message: `#${issueNumber} is not one of your open issues` };

    const failed = this.#provisioner.job(issueNumber);
    if (!failed || failed.phase !== 'failed' || failed.code !== 'branch-exists') {
      return { ok: false, message: `#${issueNumber} has no existing-branch failure to continue` };
    }
    const expectedBranch = failed.branch;
    const expectedPath = failed.worktreePath;

    let scans: WorktreeScan[];
    const beforeGeneration = ++this.#scanGeneration;
    try {
      scans = await this.#scanWorktreesFromDisk();
    } catch (error) {
      return { ok: false, message: `could not verify the current worktrees: ${(error as Error).message}` };
    }
    // Port reservations come from scans, so make this fresh local read the
    // source for allocation even when an unrelated GitHub poll is in flight.
    await this.#publishScans(scans, beforeGeneration);
    const alreadyThere = scans.find((scan) => scan.issue === issueNumber) ?? null;
    if (alreadyThere) {
      if (alreadyThere.path !== expectedPath || alreadyThere.branch !== expectedBranch) {
        return {
          ok: false,
          message: `refusing to continue: #${issueNumber} is tracked at a different worktree or branch`,
        };
      }
      if (expectedMode && expectedMode !== 'use-existing') {
        return { ok: false, message: `the recovery mode changed since the plan was reviewed; review it again` };
      }
      if (expectedPort !== undefined && alreadyThere.state.port !== expectedPort) {
        return { ok: false, message: `the recovery port changed since the plan was reviewed; review it again` };
      }
      const planned = await this.#provisioner.continuationPlan(issue, alreadyThere.state.port);
      if (!planned.ok || !planned.plan) return { ok: false, message: planned.message };
      if (expectedHead && planned.plan.head !== expectedHead) {
        return { ok: false, message: `cannot continue: ${expectedBranch} changed since the recovery plan was reviewed` };
      }
      const current = this.#provisioner.job(issueNumber);
      // An exact worktree may appear while the first recovery request is still
      // scaffolding it. Treat the second request as idempotent, but leave the
      // job with its owner so a later scaffold failure cannot be hidden.
      if (current?.phase === 'failed' && current.code === 'branch-exists') {
        this.#provisioner.clear(issueNumber);
      }
      this.#changed();
      return { ok: true, message: `using the existing worktree for ${expectedBranch}` };
    }

    const current = this.#provisioner.job(issueNumber);
    if (current !== failed || current.phase !== 'failed' || current.code !== 'branch-exists') {
      return { ok: false, message: `recovery for #${issueNumber} is already in progress` };
    }

    if (expectedMode && expectedMode !== 'restore') {
      return { ok: false, message: `the recovery mode changed since the plan was reviewed; review it again` };
    }
    if (expectedPort !== undefined && current.port !== expectedPort) {
      return { ok: false, message: `the recovery port changed since the plan was reviewed; review it again` };
    }
    if (this.#takenPorts(issueNumber, scans).includes(current.port)) {
      return { ok: false, message: `dev port ${current.port} was claimed after the recovery plan; review it again` };
    }
    const out = await this.#provisioner.continueExistingBranch(
      issue,
      () => this.#changed(),
      expectedHead,
      expectedMode,
    );
    if (!out.ok) return out;

    const afterGeneration = ++this.#scanGeneration;
    try {
      scans = await this.#scanWorktreesFromDisk();
    } catch (error) {
      const message = `restored ${expectedBranch}, but the worktree scan failed: ${(error as Error).message}`;
      this.#provisioner.deferContinuationVerification(issueNumber, message, () => this.#changed());
      return { ok: false, message };
    }
    const restored = scans.find((scan) => scan.issue === issueNumber) ?? null;
    if (!restored || restored.path !== expectedPath || restored.branch !== expectedBranch) {
      const message = `restored ${expectedBranch}, but the worktree scan did not recognize the exact path and branch`;
      this.#provisioner.deferContinuationVerification(issueNumber, message, () => this.#changed());
      return { ok: false, message };
    }

    await this.#publishScans(scans, afterGeneration);
    this.#provisioner.clear(issueNumber);
    this.#changed();
    return { ok: true, message: `restored ${expectedBranch}; continue in its existing work` };
  }

  // -------------------------------------------------------------- commands

  /**
   * Ask for a worker. It runs when capacity and RAM allow. `account` and `model`
   * are the pickers' choices on the start card; both only apply to an issue that
   * has no session yet — a session cannot move between accounts, and its whole
   * point as a measured segment is that one model was in force from end to end.
   */
  enqueue(
    issueNumber: number,
    account?: string | null,
    model?: string | null,
    opts: { supercharge?: boolean } = {},
  ): { ok: boolean; message: string } {
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    if (!scan) {
      return { ok: false, message: `#${issueNumber} has no worktree yet — create one first` };
    }
    if (this.#runner.isRunning(issueNumber)) return { ok: false, message: 'already running' };
    const block = this.#persisted.commentBlocks[String(issueNumber)];
    if (block && !block.reply) {
      return { ok: false, message: `#${issueNumber} is blocked awaiting ${block.addressee || 'a reply'}` };
    }

    const key = String(issueNumber);
    if (account && !hasAccount(this.#accounts, account)) return { ok: false, message: `unknown account '${account}'` };
    const destination = accountFor(this.#accounts, account ?? this.#persisted.accountByIssue[key] ?? null);
    const modelConflict = this.#modelConflict(destination, model);
    if (modelConflict) return { ok: false, message: modelConflict };
    const hasSession = this.#hasSession(issueNumber);

    if (account) {
      const stamped = this.#persisted.accountByIssue[key] ?? null;
      const wouldChange = stamped ? stamped !== account : account !== this.#accounts.default;
      if (wouldChange && hasSession) {
        return {
          ok: false,
          message:
            `#${issueNumber} already has a session under ${stamped ?? 'its current account'}, and a session ` +
            `cannot move between accounts. Use "Restart fresh under ${account}" instead.`,
        };
      }
      this.#pendingAccount.set(issueNumber, account);
      if (!model?.trim() && !hasSession) this.#pendingModel.set(issueNumber, this.#profileModel(destination));
    }

    if (model?.trim()) {
      const chosen = model.trim();
      const inForce = this.#modelOf(issueNumber);
      if (chosen !== inForce && hasSession) {
        return {
          ok: false,
          message:
            `#${issueNumber} already has a session running ${inForce}. The model in force for a session does not ` +
            `change — switching means "Restart fresh", which starts a new session on ${chosen}.`,
        };
      }
      this.#pendingModel.set(issueNumber, chosen);
    }

    // LAST of the refusals, because the ones above are about a malformed request
    // and this one is about the state of the work. A gate open means a decision is
    // on screen waiting for them, and starting a FRESH worker walks straight past
    // it — which is exactly how #4404's PR went out without Gate D: one click on a
    // checkpoint row spawned a worker that read the previous one's notes and
    // carried on from stage 6. The browser already hides Start here; this puts the
    // same guard in the server, which is what actually owns the decision.
    if (scan.gate) {
      return {
        ok: false,
        message: `#${issueNumber} is at gate ${scan.gate.gate} — decide it on the card rather than starting a new worker`,
      };
    }

    // AFTER every refusal above, so a start that was rejected never leaves a
    // standing instruction behind it. Re-starting a supercharged issue resets
    // the gate C round count: they are asking again, not continuing.
    if (opts.supercharge === true) {
      this.#persisted.supercharged[key] = { at: new Date().toISOString(), autoRounds: 0, lastGateHash: null };
      delete this.#persisted.superchargeStopped[key];
    } else if (opts.supercharge === false) {
      delete this.#persisted.supercharged[key];
    }

    this.#enqueue(issueNumber);
    delete this.#persisted.lastErrors[String(issueNumber)];
    this.#changed();
    void this.#dispatch();
    return {
      ok: true,
      message: opts.supercharge === true ? `#${issueNumber} queued — supercharged to gate D` : `#${issueNumber} queued`,
    };
  }

  /**
   * Take an issue out of the line, and take the held message out with it.
   *
   * These two are ONE thing, and every path that drops a queue entry without
   * dispatching it has to go through here. `#dispatch` only ever selects from
   * `this.#queue.list()`, so a `pendingResume` left behind after the queue entry
   * is gone is never delivered again — until a console restart, which re-queues
   * from those very keys. Meanwhile `#answerIsQueued` reads true, so the card
   * says "answered" and every button that asks them something steps aside, and
   * `inFlight` reads true, so the feed keeps deferring the issue's rows. A
   * decision that quietly stops existing, with the card claiming the opposite.
   *
   * Returns what to SAY about it, because a dropped decision they made must never
   * be dropped in silence.
   */
  #dropFromQueue(issueNumber: number): { held: boolean; note: string } {
    this.#dequeue(issueNumber);
    this.#pendingAccount.delete(issueNumber);
    this.#pendingModel.delete(issueNumber);
    this.#pendingPrompt.delete(issueNumber);
    const key = String(issueNumber);
    const held = this.#persisted.pendingResume[key] !== undefined;
    const record = this.#persisted.gateThreads[key];
    const wasQuestion = (record?.pendingAskIds.length ?? 0) > 0;
    if (held) {
      delete this.#persisted.pendingResume[key];
      // The mark goes with the words it described — see `sentBackResumes`.
      delete this.#persisted.sentBackResumes[key];
      delete this.#persisted.superchargeResumes[key];
      // Whatever it was, it is no longer on its way. A question left marked as
      // pending would read as "being delivered" for ever on the card.
      if (record) record.pendingAskIds = [];
      void this.#save();
    }
    return {
      held,
      note: held ? `the ${wasQuestion ? 'question' : 'answer'} you had queued for it is dropped too` : '',
    };
  }

  dequeue(issueNumber: number): { ok: boolean; message: string } {
    // Taking it out of the line takes the held answer out with it. Leaving it
    // behind would mean some later start silently resuming with a decision made
    // about a gate the operator has since taken back.
    const dropped = this.#dropFromQueue(issueNumber);
    this.#changed();
    return {
      ok: true,
      message: `#${issueNumber} taken out of the queue${dropped.held ? ` — ${dropped.note}` : ''}`,
    };
  }

  /**
   * PARK: the operator sets a ticket aside.
   *
   * The operator asked for a way to pause a ticket: it stays where it is at its
   * gate, it stops appearing at the top of the queue, and the row says plainly
   * that it is paused.
   *
   * Read what this method does NOT do, because that is the specification. It
   * does not touch `.gate.json`. It does not stop, start, signal or queue
   * anything. It does not write to GitHub, move a board card or change a label.
   * It writes one line into the console's own state file and says so. A parked
   * ticket at Gate C is still at Gate C, still has its worktree, still has its
   * session, and Approve still works on it — it has simply stopped competing
   * for the top of the list.
   *
   * Parking a RUNNING worker is allowed and deliberately so: the alternative is
   * a rule the operator did not ask for, on the one path where they most
   * obviously mean it — this is going the wrong way, come back to it later. The
   * worker goes on running and the live card goes on saying so.
   */
  async parkIssue(issueNumber: number, reason: string): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    const already = this.#persisted.parked[key];
    if (already) return { ok: false, message: `#${issueNumber} is already parked` };
    // Empty is a real answer, and it is stored as null rather than '' so that
    // "they gave no reason" and "they typed a space" are one fact on the row.
    const trimmed = reason.trim();
    const stamp: ParkedStamp = { at: new Date().toISOString(), reason: trimmed === '' ? null : trimmed };
    this.#persisted.parked[key] = stamp;
    await this.#save();
    this.#log(`#${issueNumber}: parked${stamp.reason ? ` — ${stamp.reason}` : ''}`);
    this.#changed();
    return {
      ok: true,
      message:
        `#${issueNumber} parked${stamp.reason ? ` — ${stamp.reason}` : ''}. It keeps its gate and everything ` +
        `else about it; it just drops out of the top of the list until you un-park it.`,
    };
  }

  /** Un-park. The row goes straight back to wherever the ordering says it
   *  belongs — nothing was moved, so there is nothing to move back. */
  async unparkIssue(issueNumber: number): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    if (!this.#persisted.parked[key]) return { ok: false, message: `#${issueNumber} is not parked` };
    delete this.#persisted.parked[key];
    await this.#save();
    this.#log(`#${issueNumber}: un-parked`);
    this.#changed();
    return { ok: true, message: `#${issueNumber} un-parked — it is back in the list where its priority puts it` };
  }

  /**
   * The ONLY way to move an issue to another account. A session belongs to one
   * account — its transcript and its server-side conversation live there — so it
   * is abandoned rather than transferred: a new session id is minted and the new
   * account is stamped. Everything that carries the work survives untouched: the
   * worktree, the branch and its commits, `.issue-state.md`, and the whole
   * `.gate-history.jsonl`. The new session rebuilds its context from exactly
   * those files, which is what they are for.
   *
   * The live `.gate.json` is the one thing that goes, because it names the dead
   * session id and a resume would otherwise chase it into an account where it
   * does not exist.
   */
  async restartFresh(
    issueNumber: number,
    account: string,
    model?: string | null,
  ): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    if (!hasAccount(this.#accounts, account)) return { ok: false, message: `unknown account '${account}'` };
    const chosen = accountFor(this.#accounts, account);
    const modelConflict = this.#modelConflict(chosen, model);
    if (modelConflict) return { ok: false, message: modelConflict };
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    if (!scan) return { ok: false, message: `no worktree for #${issueNumber}` };
    if (this.#runner.isRunning(issueNumber)) {
      return { ok: false, message: `#${issueNumber} is running — stop it first` };
    }
    // A CLOSED issue does not get a new run started on it.
    //
    // Every other continuation keys off the worktree, and rightly: `resume`
    // carries on a session already in flight, and a close landing mid-run must
    // not strand it. Restarting fresh is not that. It abandons the session and
    // begins a new one, which is what `createWorktree` does — and that has
    // refused a closed issue since the day it was written. #5697 was closed and
    // signed off on 3 September and restarted fresh the next day, and got to
    // stage 2 before anybody noticed the work had no ticket.
    //
    // The read, not the absence: an issue can leave the open list still open,
    // and refusing those would block real work. Reopen it on GitHub to restart.
    if (this.#orphanFacts.get(issueNumber)?.state === 'CLOSED') {
      return {
        ok: false,
        message:
          `#${issueNumber} is closed on GitHub — a fresh run would start work nobody is waiting for. ` +
          `Reopen it there if the work is not finished; the worktree and its branch are untouched either way.`,
      };
    }

    const readiness = await this.#providerReadiness(chosen);
    if (readiness) return { ok: false, message: readiness };
    await deleteGateFile(scan.path);
    this.#persisted.sessions[key] = randomUUID();
    const chosenModel = this.#stampFreshIdentity(issueNumber, chosen, model);
    // The detached signal belonged to the abandoned session; it means nothing now.
    delete this.#persisted.exitMtimes[key];
    delete this.#persisted.lastErrors[key];
    // So did any answer still waiting to be delivered: it was addressed to a
    // gate in a session that no longer exists, and the fresh worker rebuilds its
    // context from the worktree instead.
    delete this.#persisted.pendingResume[key];
    delete this.#persisted.sentBackResumes[key];
    delete this.#persisted.superchargeResumes[key];
    // And so was every unanswered question: they were asked of a session that no
    // longer exists, and the fresh worker has never seen that gate.
    delete this.#persisted.gateThreads[key];
    // And so were their QA ticks and the rework baseline: they were verdicts on a
    // click-script this session will write again from scratch. The rework RECORD
    // stays — it happened.
    delete this.#persisted.qaVerdicts[key];
    delete this.#persisted.qaSnapshots[key];
    await this.#save();

    await this.poll(); // re-scan: the gate file is gone and the account changed
    this.#enqueue(issueNumber);
    this.#changed();
    void this.#dispatch();
    return {
      ok: true,
      message: `#${issueNumber} restarting fresh under ${chosen.name} on ${chosenModel}`,
    };
  }

  /**
   * Start the rework with a NEW worker, for a PR whose work happened outside the
   * console: there is no session on disk to resume, but the worktree, the branch
   * and the PR all exist. Same machinery as restart-fresh — mint a session id,
   * stamp the account, clear the stale gate — with two differences: the spawn
   * prompt is `/issue-pipeline <N> resume` plus the rework brief (the skill's resume
   * mode rebuilds its context from the worktree files), and the round is stamped
   * exactly as `resume` stamps it, so the history stays complete.
   */
  async reworkFresh(
    issueNumber: number,
    brief: string,
    account?: string | null,
    model?: string | null,
  ): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    if (!scan) return { ok: false, message: `no worktree for #${issueNumber}` };
    if (this.#runner.isRunning(issueNumber)) return { ok: false, message: 'already running' };
    if (!brief.trim()) return { ok: false, message: 'a rework needs a brief' };
    if (account && !hasAccount(this.#accounts, account)) return { ok: false, message: `unknown account '${account}'` };

    const block = this.#persisted.reviewBlocks[key];
    const round = block?.rounds[block.rounds.length - 1];
    if (!round || !isActionable(round)) {
      return { ok: false, message: `#${issueNumber} has no rework round waiting on you` };
    }

    const chosen = accountFor(this.#accounts, account ?? this.#persisted.accountByIssue[key] ?? null);
    const modelConflict = this.#modelConflict(chosen, model);
    if (modelConflict) return { ok: false, message: modelConflict };
    const readiness = await this.#providerReadiness(chosen);
    if (readiness) return { ok: false, message: readiness };

    // Any answer still queued belonged to the session this abandons.
    delete this.#persisted.pendingResume[key];
    delete this.#persisted.sentBackResumes[key];
    delete this.#persisted.superchargeResumes[key];
    await deleteGateFile(scan.path);
    this.#persisted.sessions[key] = randomUUID();
    this.#stampFreshIdentity(issueNumber, chosen, model);
    delete this.#persisted.exitMtimes[key];
    delete this.#persisted.lastErrors[key];
    round.decision = brief;
    round.resumedAt = new Date().toISOString();
    round.account = chosen.name;
    round.resolvedBy = 'operator';
    round.resolvedAt = round.resumedAt;
    round.resolution = 'you started the rework from the console — a fresh worker';
    this.#pendingPrompt.set(
      issueNumber,
      `${this.#providers[chosen.provider].workflowPrompt(issueNumber, 'resume')}\n\n${brief}`,
    );
    await this.#save();

    await this.poll(); // re-scan: the gate file is gone and the account is stamped
    this.#enqueue(issueNumber);
    this.#changed();
    void this.#dispatch();
    return {
      ok: true,
      message:
        `#${issueNumber} starting a fresh worker for the rework under ${chosen.name} ` +
        `on ${this.#modelOf(issueNumber)}`,
    };
  }

  /**
   * Stage 9, on the operator's click, for an issue whose PR has merged.
   *
   * Merge is not done: the board card has to move, the verification path has to
   * be chosen (cherry-pick versus the promotion train), and QA needs a ready
   * script. The console used to render that state as "checkpoint — stopped after
   * stage 7" and offer nothing at all.
   *
   * No new machinery. If a session is resumable it is RESUMED, because its
   * context is worth keeping; otherwise this borrows the rework-fresh pattern —
   * mint a session id, stamp the account, and spawn with
   * `/issue-pipeline <N> resume` plus the prompt. The one thing it does NOT require
   * is an actionable review round, which is what stops `reworkFresh` being
   * usable here.
   *
   * THE WRITE FENCE, restated because this touches it: the skill's Stage 9 has
   * the worker post the ready-to-verify comment on the ISSUE — a GitHub write. A
   * console worker may not do that. The prompt the card prefills overrides it
   * toward `.comment-request.json` → CommentCard → the operator's click → the
   * guarded issue/PR comment writer, still the only GitHub write in this codebase.
   * Nothing here writes to GitHub.
   */
  async postMergeStart(
    issueNumber: number,
    prompt: string,
    account?: string | null,
    model?: string | null,
  ): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    const said = prompt.trim();
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    if (!scan) return { ok: false, message: `no worktree for #${issueNumber}` };
    if (this.#runner.isRunning(issueNumber)) return { ok: false, message: 'already running' };
    if (!said) return { ok: false, message: 'Stage 9 needs an instruction — the card prefills one' };
    if (account && !hasAccount(this.#accounts, account)) return { ok: false, message: `unknown account '${account}'` };

    // A session on disk is the better path by far: it remembers the issue, the
    // plan and the review rounds. `resume` sends the operator's words byte-exactly
    // and parks the decision if the desk is full, like every other answer.
    const sessionId = scan.sessionId ?? this.#persisted.sessions[key];
    // Stage 9 decides no gate: `null` is the contract's own "this is not a
    // decision". It only ever mattered if a gate file happened to still be on
    // disk, but a spurious approval is exactly what this ledger cannot afford.
    if (sessionId) return this.resume(issueNumber, said, { decision: null });

    const chosen = accountFor(this.#accounts, account ?? this.#persisted.accountByIssue[key] ?? null);
    const modelConflict = this.#modelConflict(chosen, model);
    if (modelConflict) return { ok: false, message: modelConflict };
    const readiness = await this.#providerReadiness(chosen);
    if (readiness) return { ok: false, message: readiness };
    await deleteGateFile(scan.path);
    this.#persisted.sessions[key] = randomUUID();
    this.#stampFreshIdentity(issueNumber, chosen, model);
    delete this.#persisted.exitMtimes[key];
    delete this.#persisted.lastErrors[key];
    this.#pendingPrompt.set(
      issueNumber,
      `${this.#providers[chosen.provider].workflowPrompt(issueNumber, 'resume')}\n\n${said}`,
    );
    await this.#save();

    await this.poll();
    this.#enqueue(issueNumber);
    this.#changed();
    void this.#dispatch();
    return { ok: true, message: `#${issueNumber} starting Stage 9 with a fresh worker under ${chosen.name}` };
  }

  /**
   * Why a resume cannot start THIS SECOND, or null. Every reason here is the
   * machine being busy — a reclaim in flight, no memory headroom, every slot
   * taken — and not one of them is a reason to throw away what the operator decided.
   *
   * Resources that have never been measured count as fine, exactly as they did
   * before: an unmeasured machine is not a busy one.
   */
  #resumeHold(): string | null {
    if (this.#reclaiming) return this.#resourceVerdict().reason;
    const resources = this.#resources ?? { ok: true, reason: '' };
    if (!resources.ok) return resources.reason;
    const active = this.#slotsTaken();
    if (active >= this.#cfg.maxActive) {
      return `every slot is busy: ${active} of ${this.#cfg.maxActive} workers are active`;
    }
    return null;
  }

  /**
   * Take the decision and say so plainly.
   *
   * It goes to disk BEFORE anything else, because "accepted" is a promise and a
   * promise that a restart forgets was never one. The issue then joins the
   * queue, which is the only thing in the console that starts work — so the
   * memory and headroom checks still happen, at dispatch, where they belong.
   *
   * A second answer replaces the first. Two answers to one gate queued behind
   * each other would be answered in the wrong order, and the last thing the
   * operator said is what they mean.
   */
  /** A held resume keeps BOTH marks: which decision it was, and who made it. */
  async #holdResume(
    issueNumber: number,
    message: string,
    why: string,
    sentBack: boolean,
    by?: 'supercharge',
  ): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    const replaced = this.#persisted.pendingResume[key] !== undefined;
    const cancelled = this.#cancelQueuedRework(issueNumber);
    this.#persisted.pendingResume[key] = message;
    // Written beside the words, in the same save, because the two are one fact:
    // what is parked, and whether it is a failure going back. A replacement
    // overwrites this as it overwrites the message — the newest thing sent is
    // the one that runs, so it is also the one that ranks.
    if (sentBack) this.#persisted.sentBackResumes[key] = true;
    else delete this.#persisted.sentBackResumes[key];
    if (by === 'supercharge') this.#persisted.superchargeResumes[key] = true;
    else delete this.#persisted.superchargeResumes[key];
    await this.#save();
    this.#enqueue(issueNumber);
    this.#changed();
    const place = this.#queue.position(issueNumber);
    return {
      ok: true,
      message:
        `#${issueNumber}: answer taken — ${why}, so it is queued (${place === 1 ? 'next up' : `${place} in line`}) ` +
        `and runs with exactly what you wrote as soon as a slot frees` +
        (replaced ? '. This replaces the answer you sent before — the newest one is the one that runs.' : '.') +
        (cancelled ?? ''),
    };
  }

  /**
   * A queued rework that the message now being held is about to overwrite.
   *
   * `pendingResume` holds exactly ONE message, so the next thing the operator sends
   * from the same card replaces whatever was parked there. When that was a targeted
   * rework it was the only thing carrying their failed step, the prior evidence and
   * the whole click-script forward — and it went silently, under a generic line
   * about replacing "the answer you had queued". The card kept saying the step
   * was with Build, `outstanding` stayed true so nothing ever retired, and the
   * worker's next stop was judged against a baseline for a round it never
   * received: a fresh gate file, every tick reset, and a dropped-evidence
   * accusation against a worker that was never asked to carry anything.
   *
   * Cancelling is the honest half. The SNAPSHOT deliberately stays: it is the
   * ratchet holding this stop's evidence on the card, and the round that never
   * left took nothing with it. Their ticks are untouched, so one click sends it
   * again.
   */
  #cancelQueuedRework(issueNumber: number): string | null {
    const entry = (this.#persisted.qaReworks[String(issueNumber)] ?? []).findLast((e) => e.status === 'queued');
    if (!entry) return null;
    entry.status = 'cancelled';
    return cancelledReworkMessage(entry.stepIds);
  }

  /**
   * Approve or send feedback: both resume the same session in the same worktree.
   *
   * A decision the operator has made is ACCEPTED even when nothing can run right
   * now. It used to be refused — "at capacity: 2 of 2 active" — and a refusal at
   * the far end of a click reads as a dead button: they approved four gates and
   * two of them silently did nothing. So a busy machine parks the decision instead:
   * the exact message is written to state.json, the issue joins the queue, and
   * the dispatch that finds a free slot resumes with those words and no others.
   * The decision waits; it never dies.
   *
   * `fromDispatch` is the queue calling back in, where the slot has already been
   * counted — parking there would queue the issue behind itself.
   */
  async resume(
    issueNumber: number,
    message: string,
    opts: {
      fromDispatch?: boolean;
      decision?: 'approved' | 'feedback' | null;
      sentBack?: boolean;
      /** Set only by a supercharged run, so the ledger can tell an automatic
       *  pass from one the operator read and approved themselves. See
       *  `supercharge.ts`. */
      by?: 'supercharge';
    } = {},
  ): Promise<{ ok: boolean; message: string }> {
    // `null` means "this is not a decision" — the queue continuing work that was
    // never parked on them. Everything else records: a direct call is the operator
    // acting now, and a dispatch carrying a HELD answer is their decision finally
    // running (held at capacity, so never recorded at the moment they gave it).
    const asked = opts.decision === undefined ? 'approved' : opts.decision;
    // A SEND-BACK THE CONSOLE COMPOSED IS NOT AN APPROVAL, whatever the caller
    // said. `/api/issues/:n/resume` defaults an absent `decision` to `approved`,
    // so all four "your gate C deliverable is incomplete" prompts have been
    // writing approvals of the gate they were sent back from — see
    // `sentBackByTheConsole`. Read from the message rather than from the flag
    // because the flag is the page's, and the page is the half that got it wrong.
    //
    // It only ever demotes, and it demotes on bytes the console itself wrote.
    const decision = asked === 'approved' && sentBackByTheConsole(message) ? 'feedback' : asked;
    // Is this them handing the work BACK? `feedback` is that by definition
    // (decisions.ts: "`approved` moves the work on; `feedback` sends it back"),
    // and a caller that knows better says so — `qaRework` and `reopenGate` are
    // send-backs whatever they write to the ledger. It matters only if this ends
    // up parked: it is the queue's key 2, and nothing else reads it.
    const sentBack = opts.sentBack ?? decision === 'feedback';
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    if (!scan) return { ok: false, message: `no worktree for #${issueNumber}` };
    if (this.#busy(issueNumber)) return { ok: false, message: 'already running' };

    // A QUESTION IS NOT AN APPROVAL. See `approval.ts` — #5402 spent a day on a
    // checkpoint because this check did not exist.
    //
    // Only at the moment of the click: `fromDispatch` is an answer they already
    // gave being run late (it was checked when they gave it, and refusing it here
    // would strand it), and `by` is a supercharged run, which is nobody typing at
    // all.
    // Only for an approval: a send-back may ask anything it likes.
    //
    // Read against THEIR OWN WORDS, not the composed message. `approvePrompt` puts
    // `Gate D approved, proceed.` in front of whatever is in the textarea, so the
    // check as written found the page's `approved` and `proceed` every single
    // time and passed #5402's two questions through as the approvals it was
    // built to catch. `saidInTheApproveBox` takes that one canned line back off.
    if (
      scan.gate &&
      decision === 'approved' &&
      opts.fromDispatch !== true &&
      opts.by === undefined &&
      readsAsQuestion(saidInTheApproveBox(scan.gate.gate, message))
    ) {
      return { ok: false, message: questionNotApprovalRefusal(scan.gate.gate) };
    }

    const sessionId = scan.sessionId ?? this.#persisted.sessions[String(issueNumber)];
    if (!sessionId) {
      return {
        ok: false,
        message:
          `No session id for #${issueNumber} — nothing to resume. ` +
          `Start it in the worktree by hand once and the console will pick the session up.`,
      };
    }
    const provider = this.#providerOf(issueNumber);
    if (provider === 'codex' && !this.#agentSessionOf(issueNumber)) {
      return {
        ok: false,
        message: `No Codex thread id for #${issueNumber} — restart it fresh so the console can establish one.`,
      };
    }

    // A decision that cannot run yet is deliberately accepted and held. It has
    // consumed no gate file and will be preflighted again at dispatch, after the
    // profile may have been repaired.
    const initialHold = opts.fromDispatch ? null : this.#resumeHold();
    if (initialHold !== null) {
      await this.#supersedeOpenQuestions(issueNumber);
      return await this.#holdResume(issueNumber, message, initialHold, sentBack, opts.by);
    }

    // An immediate resume is different: prove the selected profile can launch
    // before closing questions, clearing a comment block, resolving a review
    // round or appending a gate decision. The adapter repeats this check beside
    // spawn so a hook changed during this window still fails closed.
    const account = this.#accountOf(issueNumber);
    const readiness = await this.#providerReadiness(account, provider);
    if (readiness) return { ok: false, message: readiness };

    // Readiness is asynchronous. Re-check both concurrency and machine capacity
    // before taking the synchronous spawn claim, otherwise two clicks can pass
    // the first check together or a newly-busy machine can consume the decision.
    if (this.#busy(issueNumber)) return { ok: false, message: 'already running' };
    const delayedHold = opts.fromDispatch ? null : this.#resumeHold();
    if (delayedHold !== null) {
      await this.#supersedeOpenQuestions(issueNumber);
      return await this.#holdResume(issueNumber, message, delayedHold, sentBack, opts.by);
    }

    // Claimed HERE, synchronously, because everything below awaits: without it a
    // second click landing before the runner has the issue passes the check
    // above and spawns a second worker. Handed to `#track` if we get as far as
    // spawning, and given back on every path that does not. See `#busy`.
    this.#starting.add(issueNumber);
    let spawned = false;
    try {
      // A DECISION overtakes any question still waiting for an answer, whether it
      // runs now or is held for a slot — the decision is TAKEN either way. The
      // questions are stamped rather than deleted: "you decided the gate before
      // this was answered" is a true thing about the exchange, and a question that
      // silently disappeared would be indistinguishable from one that was ignored.
      await this.#supersedeOpenQuestions(issueNumber);

      // Resuming clears any comment block — the answer is in hand, we are unblocked.
      const commentBlock = this.#persisted.commentBlocks[String(issueNumber)];
      if (commentBlock) {
        if (commentBlock.requestKey) {
          this.#persisted.handledCommentRequests[String(issueNumber)] = {
            requestKey: commentBlock.requestKey,
            handledAt: new Date().toISOString(),
            reason: 'resolved',
          };
        }
        delete this.#persisted.commentBlocks[String(issueNumber)];
        await this.#save();
      }

      // Resuming an actionable rework round marks it handled: stamp the operator's
      // resume prompt as the decision and when they started it. The round stays in
      // history; it is just no longer the actionable one, so the row leaves 'rework'.
      const rework = this.#persisted.reviewBlocks[String(issueNumber)];
      const roundToStamp = rework?.rounds[rework.rounds.length - 1];
      if (roundToStamp && isActionable(roundToStamp)) {
        roundToStamp.decision = message;
        roundToStamp.resumedAt = new Date().toISOString();
        roundToStamp.account = this.#accountOf(issueNumber).name;
        roundToStamp.resolvedBy = 'operator';
        roundToStamp.resolvedAt = roundToStamp.resumedAt;
        roundToStamp.resolution = 'you started the rework from the console';
        await this.#save();
      }

      // THE RECORD, written before anything is destroyed or spawned. Every
      // approval in this console passes through here, and until now not one of
      // them was written down by the party that witnessed it — which is how a
      // report reached the operator saying they had skipped gates they had approved.
      //
      // Deliberately BEFORE the unlink inside #spawnResume: if the console dies
      // between the two, a decision recorded that did not resume is visible and
      // recoverable, and a resume with no decision recorded is exactly the hole
      // this closes.
      if (scan.gate && decision !== null) {
        await this.#recordDecision(issueNumber, scan.gate, decision, message, sessionId, scan, opts.by);
      }

      await this.#spawnResume(issueNumber, scan, sessionId, message, null);
      spawned = true;
      return { ok: true, message: `resumed #${issueNumber}` };
    } finally {
      if (!spawned) this.#starting.delete(issueNumber);
    }
  }

  /**
   * Is a worker for this issue running, or on its way to running?
   *
   * `isRunning` only becomes true once the child has been spawned, and the road
   * from "we have decided to spawn" to there crosses a state save, a
   * `git rev-parse` and an unlink of the gate file. Two clicks landing in that
   * window both saw a free issue and both spawned; the runner refused whichever
   * lost, and the second question went with it — written down, marked delivered,
   * and never sent.
   *
   * The claim is taken synchronously at the point of no return and released when
   * the run settles (`#track`), so the second caller sees a busy worker and takes
   * the "held until it stops" path it was always supposed to take.
   */
  #busy(issueNumber: number): boolean {
    return this.#runner.isRunning(issueNumber) || this.#starting.has(issueNumber);
  }

  /**
   * Send a message into an existing session and watch the run — the one place a
   * resume actually spawns, shared by decisions and questions alike.
   *
   * Same session, same account, same model, always: a resume in another config
   * dir would not find the session at all, and a resume on another model would
   * make the run un-attributable to either.
   *
   * `ask` is the ONE thing that differs between the two callers, and it is
   * carried on the run rather than remembered here — see `RunContext.ask`.
   */
  /**
   * Write one decision line, and keep the in-memory copy in step.
   *
   * A dispatch from the queue does NOT come through here: that is the console
   * running an answer the operator already gave, and the decision was recorded at
   * the moment they gave it. Recording it twice would show the gate approved twice.
   */
  async #recordDecision(
    issue: number,
    gateFile: GateFile,
    decision: 'approved' | 'feedback',
    message: string,
    sessionId: string | null,
    scan: WorktreeScan,
    by?: 'supercharge',
  ): Promise<void> {
    const gate = gateFile.gate;
    const qa = this.#qaProgressFor(issue);
    // WHAT they approved OF. Without this, a commit landing afterwards is invisible
    // and they only hear of it if a worker volunteers it at the next gate.
    const head = await gitHead(scan.path);
    // What they left OPEN. These used to evaporate — the worker took its own
    // recommendation and asked again later as a "last call".
    const thread = this.#persisted.gateThreads[String(issue)] ?? null;
    const unanswered = thread ? openEntries(thread).map((e) => e.question) : [];
    const rec = {
      issue,
      gate,
      decision,
      message,
      at: new Date().toISOString(),
      sessionId,
      account: this.#persisted.accountByIssue[String(issue)] ?? null,
      // Gate C only: their own tick counts at the instant they decided, so the
      // record says what they verified rather than what a worker later claimed.
      qa: gate === 'C' ? qa : null,
      head,
      unanswered,
      // Absent on every decision the operator made themselves, which is what
      // keeps the ledger's history readable: `by` is present only when the console
      // passed the gate on their standing instruction. #5402 is why this matters
      // — two questions recorded as approvals left a ticket whose history claimed
      // a gate was passed twice while nothing had been decided.
      ...(by ? { by } : {}),
    };
    await appendDecision(this.#cfg.decisionsFile, rec);
    this.#decisions.push(rec);

    // AND THE ROUND ITSELF, into the worktree's own audit trail, because the
    // console is about to destroy the only copy of it. See `appendGateHistory`
    // for the fence note: this is the one place the console writes into a
    // customer worktree, and it writes one appended line.
    //
    // Evidence and the click-script come from the CARD's copies, not from the
    // raw file. `#evidenceFor` and `#manualQaFor` put back anything a fumbled
    // rework dropped, and what the operator decided against is what they were
    // shown — a permanent record of the shrunken list would be a record of a gate
    // nobody was offered. The quiz and the worker's thread are the file's own.
    //
    // `resumedAt` is null and stays null. The console records the DECISION; the
    // resume it is about to attempt may still be refused, and stamping a time
    // for something that has not happened is the invention this whole record
    // exists to remove.
    await appendGateHistory(join(scan.path, '.gate-history.jsonl'), {
      ...gateFile,
      evidence: this.#evidenceFor(issue, scan),
      thread: scan.gateThreadFile,
      manualQa: this.#manualQaFor(issue, scan),
      quiz: scan.gateQuiz,
      decision: message,
      resumedAt: null,
      account: this.#persisted.accountByIssue[String(issue)] ?? null,
    });

    this.#changed();
  }

  /**
   * PASS THE GATES A SUPERCHARGED RUN MAY PASS — and hand back the ones it may not.
   *
   * Called from `poll`, which is called when a run ends (`#track`), so a worker
   * stopping at gate A gets its answer within a second of stopping rather than
   * on the next fifteen-minute tick. No new timer, no new loop.
   *
   * The evidence rule is in `supercharge.ts` and is the whole point: gate C is
   * passed only when the captures are genuinely there, and sent BACK — twice at
   * most — when they are not. Gate D is never passed here.
   */
  async #autoDecideSuperchargedGates(): Promise<void> {
    for (const scan of this.#scans) {
      const key = String(scan.issue);
      const flag = this.#persisted.supercharged[key];
      if (!flag) continue;
      // A worker that is still running has not asked us for anything yet.
      if (this.#busy(scan.issue)) continue;

      // THE GATE IS READ FROM DISK HERE, not taken from `scan`.
      //
      // #5555 is why. It parked at gate B, the card said "AT GATE B — waiting
      // for you" for seven minutes, and the only reading available to the operator
      // was that a supercharged run was asking for gate B approval anyway.
      // The decision logic was right and had already passed gate A on the same
      // issue; what was wrong was WHEN it ran. `#scans` is shared, generation-
      // guarded and refreshed by both this poll and the watcher, and `poll()`
      // opens with `if (this.#polling) return false` — so the `poll()` the exit
      // handler fires to "pick up .gate.json" is DROPPED whenever a poll is
      // already in flight, and the decision then waited on the fifteen-minute
      // timer. A feature whose entire job is to act the moment a worker parks
      // must not depend on either of those.
      //
      // So: one small file read per supercharged issue, straight off the disk
      // the worker just wrote to. There are never many, and it is the same file
      // `readGateFile` reads everywhere else in this class.
      const raw = await readFile(join(scan.path, GATE_FILE), 'utf8').catch(() => '');
      if (raw === '') continue; // no gate on disk: nothing has parked
      const live = await readGateFile(scan.path);
      // A gate file that does not parse is NOT ours to guess at. It is left
      // exactly where it is, for the operator, which is what happens today.
      if (!live) continue;
      // ONE decision per gate ROUND, keyed on the bytes. Without it every poll
      // would resume the same gate again and gate C would collect a send-back
      // per tick. It is hashed here rather than reusing `scan.gateHash` so the
      // key and the decision always come from the same read.
      const roundKey = createHash('sha1').update(raw).digest('base64url').slice(0, 12);
      if (flag.lastGateHash === roundKey) continue;

      // GATE C IS THE EXCEPTION, and it is deliberate. Its verdict is an
      // evidence check, and the inputs to that check — the restored evidence
      // manifest and the per-step "is this capture still a file" stamps — are
      // computed BY the scan (`stampShots`), not by this read. Judging fresh
      // bytes with stale stamps could send work back for a screenshot that is
      // sitting right there. So gate C waits for the scan to catch up with the
      // disk, which is at most one poll away, while A and B — which check
      // nothing — are decided now.
      if (live.gate === 'C' && scan.gateHash !== gateHashOf(raw)) continue;

      const qa = this.#manualQaFor(scan.issue, scan);
      const act = decideSupercharge({
        issue: scan.issue,
        gate: live.gate,
        steps: qa?.steps ?? [],
        qaDropped: qa?.dropped ?? 0,
        // The RESTORED count, the same one the card renders — not the raw gate
        // file. A worker that dropped an entry the operator has been shown must
        // not be able to fail its own evidence check into a send-back loop.
        evidenceCount: this.#evidenceFor(scan.issue, scan).length,
        autoRounds: flag.autoRounds,
      });

      if (act.act === 'nothing') continue;

      if (act.act === 'stop') {
        // Supercharge is OVER for this issue, and the reason is kept: the gate
        // card shows the gate, and cannot say that the console had been passing
        // gates until this one.
        this.#persisted.superchargeStopped[key] = act.why;
        delete this.#persisted.supercharged[key];
        this.#log(`#${scan.issue}: supercharge stopped at gate ${live.gate} — ${act.why}`);
        await this.#save();
        this.#changed();
        continue;
      }

      // Claim the round BEFORE resuming, and put the claim back if the resume is
      // refused. Claiming after would re-decide this same gate on the next poll;
      // never claiming would do the same. A refusal is not a decision.
      this.#persisted.supercharged[key] = {
        ...flag,
        lastGateHash: roundKey,
        autoRounds: act.act === 'send-back' ? flag.autoRounds + 1 : flag.autoRounds,
      };
      await this.#save();

      const out = await this.resume(scan.issue, act.message, {
        decision: act.act === 'send-back' ? 'feedback' : 'approved',
        by: 'supercharge',
      });
      if (out.ok) {
        this.#log(
          act.act === 'pass'
            ? `#${scan.issue}: supercharge passed gate ${live.gate}`
            : `#${scan.issue}: supercharge sent gate C back — ${act.why}`,
        );
      } else {
        this.#persisted.supercharged[key] = flag;
        await this.#save();
        this.#log(`#${scan.issue}: supercharge could not resume at gate ${live.gate} — ${out.message}`);
      }
      this.#changed();
    }
  }

  /**
   * MARK THIS ISSUE'S PR READY FOR REVIEW — the repair for the thing the card
   * was already reporting.
   *
   * The console has always been able to SEE the draft (`waiting.ts`) and has
   * always said the right sentence about it. What it could not do was fix it, so
   * five complete PRs sat unreviewable. This is that one click, through the
   * narrowest write fence in the codebase (`assertPrReadyOnly`).
   *
   * The in-memory PR is updated on success rather than waiting for the next
   * poll: the write has already happened, so `isDraft: false` is not optimism,
   * it is what GitHub now says — and the card must stop asking for something
   * that is done.
   */
  async markPrReadyForReview(issueNumber: number): Promise<{ ok: boolean; message: string }> {
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    const branch = scan?.branch ?? null;
    const pr = branch ? (this.#prs.get(branch) ?? null) : null;
    if (!pr) return { ok: false, message: `no open PR on record for #${issueNumber}` };
    if (!pr.isDraft) {
      return { ok: false, message: `PR #${pr.number} is already ready for review — nothing to do` };
    }

    const out = await markPrReady(pr.number, this.#cfg.repo);
    if (!out.ok) {
      return { ok: false, message: `could not mark PR #${pr.number} ready — ${out.error ?? 'gh gave no reason'}` };
    }

    pr.isDraft = false;
    this.#log(`#${issueNumber}: PR #${pr.number} marked ready for review`);
    this.#changed();
    return {
      ok: true,
      message: `PR #${pr.number} is ready for review — the auto-review fires on ready_for_review, and codeowners are asked now`,
    };
  }

  /** The operator's ticks right now, for the Gate C record. Null when there is
   *  no QA. */
  #qaProgressFor(issue: number): { ticked: number; total: number } | null {
    const v = this.#persisted.qaVerdicts[String(issue)];
    if (!v) return null;
    const all = Object.values(v);
    return { ticked: all.filter((x) => x.status === 'verified').length, total: all.length };
  }

  async #spawnResume(
    issueNumber: number,
    scan: WorktreeScan,
    sessionId: string,
    message: string,
    ask: { gate: GateLetter; ids: number[] } | null,
  ): Promise<void> {
    const account = this.#accountOf(issueNumber);
    const provider = this.#providerOf(issueNumber);
    const agentSessionId = this.#agentSessionOf(issueNumber);
    const model = this.#modelOf(issueNumber);
    const ctx = await this.#runContext(issueNumber, scan, sessionId, account.name, model, ask);
    // Set BEFORE the spawn: the runner reports the pid the moment it has one,
    // and the row it writes to state.json is built from this.
    this.#contexts.set(issueNumber, ctx);
    void this.#track(
      issueNumber,
      this.#runner.resume(
        issueNumber,
        scan.path,
        sessionId,
        message,
        account.configDir,
        model,
        provider,
        agentSessionId ?? sessionId,
      ),
      ctx,
    );
  }

  /** Stamp every unanswered question at this issue's open gate as overtaken. */
  async #supersedeOpenQuestions(issueNumber: number): Promise<void> {
    const record = this.#persisted.gateThreads[String(issueNumber)];
    if (!record) return;
    const now = new Date().toISOString();
    for (const entry of openEntries(record)) entry.supersededAt = now;
    // The held prompt, if there is one, is about to be replaced by the decision,
    // so nothing is pending as a question any more. `closedAt` is what retires
    // the thread once the worker reaches its next stop — see #mergeThreadAnswers.
    record.pendingAskIds = [];
    record.closedAt = now;
    await this.#save();
  }

  /**
   * ASK at an open gate, without deciding it.
   *
   * The third act at a gate, and the whole point of it is what it does NOT do:
   * it clears no comment block, starts no rework round, and passes nothing. The
   * worker answers, writes the gate file back with the same letter, and stops in
   * the same place — so the gate is still the operator's to decide, with one more
   * thing understood about it.
   *
   * It has its own method rather than being a client-composed `/resume` for
   * exactly that reason: only the orchestrator can know a message is a question,
   * and everything downstream — the held-message kind, the ending check, the row
   * — turns on knowing.
   *
   * Asking while the worker is mid-answer is normal, not an error: the question
   * is written down and delivered the moment that run stops. No new scheduler is
   * needed for it — a run ending polls, and a poll dispatches.
   */
  async ask(issueNumber: number, question: string): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    const said = question.trim();
    if (!said) return { ok: false, message: 'a question needs words' };

    const scan = this.#scans.find((s) => s.issue === issueNumber);
    if (!scan) return { ok: false, message: `no worktree for #${issueNumber}` };

    // The gate file is DELETED while a worker is resuming (see WorkerRunner), so
    // mid-answer the only record of which gate this is, is the console's own.
    const existingBeforeReadiness = this.#persisted.gateThreads[key] ?? null;
    const midAnswerBeforeReadiness =
      existingBeforeReadiness !== null && openEntries(existingBeforeReadiness).length > 0;
    const gateBeforeReadiness =
      scan.gate?.gate ?? (midAnswerBeforeReadiness ? existingBeforeReadiness!.gate : null);
    if (!gateBeforeReadiness) {
      return {
        ok: false,
        message: `no open gate on #${issueNumber} to ask at — questions belong to a gate that is still waiting on you`,
      };
    }

    const sessionId = scan.sessionId ?? this.#persisted.sessions[key];
    if (!sessionId) {
      return {
        ok: false,
        message:
          `No session id for #${issueNumber} — there is no worker to ask. ` +
          `Start it in the worktree by hand once and the console will pick the session up.`,
      };
    }

    const provider = this.#providerOf(issueNumber);
    if (provider === 'codex' && !this.#agentSessionOf(issueNumber)) {
      return {
        ok: false,
        message: `No Codex thread id for #${issueNumber} — restart it fresh so the console can establish one.`,
      };
    }

    // A queued question is durable and may wait for a profile repair. A question
    // that is going to spawn now must prove readiness before it is appended to
    // the exchange, because a failed adapter launch otherwise left a question on
    // the card that had never been sent while returning a false success.
    let deliveryBusy = this.#busy(issueNumber);
    let deliveryHold = deliveryBusy ? null : this.#resumeHold();
    if (!deliveryBusy && deliveryHold === null) {
      const readiness = await this.#providerReadiness(this.#accountOf(issueNumber), provider);
      if (readiness) return { ok: false, message: readiness };
      // The readiness read awaited I/O; capacity or another click may have moved.
      deliveryBusy = this.#busy(issueNumber);
      deliveryHold = deliveryBusy ? null : this.#resumeHold();
    }

    // Read the exchange again after readiness. Two questions can enter before
    // that filesystem check resolves; the first continuation claims the issue
    // synchronously below and appends its entry before yielding, so the second
    // sees both the claim and the newly-current thread instead of replacing it
    // from a stale preflight snapshot.
    const existing = this.#persisted.gateThreads[key] ?? null;
    const midAnswer = existing !== null && openEntries(existing).length > 0;
    const gate = scan.gate?.gate ?? (midAnswer ? existing!.gate : null);
    if (!gate) {
      return {
        ok: false,
        message: `no open gate on #${issueNumber} to ask at — questions belong to a gate that is still waiting on you`,
      };
    }
    const launchNow = !deliveryBusy && deliveryHold === null;
    if (launchNow) this.#starting.add(issueNumber);

    // A thread belongs to ONE gate. A record left over from a gate the worker has
    // since moved past is not this exchange, and appending to it would record a
    // question about gate D against gate C — and then check the answer against
    // the wrong letter when the run ends.
    const carryOn = existing !== null && existing.gate === gate;
    const record: GateThreadRecord = carryOn
      ? existing!
      : { gate, entries: [], pendingAskIds: [], violation: null, closedAt: null, stoppedAt: scan.gate?.stoppedAt ?? null };
    // Asking re-opens the exchange. Without this, a question asked after a
    // decision was queued would sit inside a thread already marked closed, and
    // be retired underneath the operator with their question unanswered in it.
    record.closedAt = null;
    const nextId = record.entries.reduce((max, e) => Math.max(max, e.id), 0) + 1;
    record.entries.push({
      id: nextId,
      question: said,
      askedAt: new Date().toISOString(),
      answer: null,
      answeredAt: null,
      supersededAt: null,
    });
    this.#persisted.gateThreads[key] = record;

    // Recomposed from the WHOLE thread every time, which is what makes a
    // follow-up asked while the first is still held safe: `pendingResume` keeps
    // only the newest message, and the newest message carries every open
    // question rather than replacing the one before it.
    const open = openEntries(record);
    const prompt = askPrompt(gate, open, answeredEntries(record));

    // Holding this question throws away whatever was held before it. When that
    // was a DECISION, the newest thing the operator sent is still the one that
    // runs — but an approval that disappears without a word is the failure this
    // console was built around, so it is said out loud on the way past.
    const heldSomething = this.#persisted.pendingResume[key] !== undefined;
    const heldQuestions = existing?.pendingAskIds.length ?? 0;
    const replacedDecision = heldSomething && heldQuestions === 0;
    // The same rule, for the other thing that can be thrown away here. When the
    // worker has moved to a new gate, the old thread is replaced wholesale (see
    // `carryOn` above) — and if a question for the OLD gate was still waiting to
    // be delivered, it goes with it. Correct: it was a question about a gate
    // that is over. But a question of the operator's must never vanish in
    // silence, which is the rule this whole module is built on, so it is named.
    const droppedQuestions = !carryOn && heldQuestions > 0 ? existing!.gate : null;
    // A queued REWORK is the sharpest thing this can overwrite, and "the answer
    // you had queued" is not a sentence that tells the operator their failed step
    // has been cancelled. Only the two PARKING paths below write `pendingResume`; a
    // question that goes straight out replaces nothing.
    const parking = deliveryBusy || deliveryHold !== null;
    const cancelledRework = parking ? this.#cancelQueuedRework(issueNumber) : null;
    const alsoSay =
      (replacedDecision
        ? '. This replaces the answer you had queued — the gate stays open until you decide it.'
        : droppedQuestions
          ? `. Your undelivered question about gate ${droppedQuestions} is dropped with it — that gate is behind the worker now.`
          : '') + (cancelledRework ?? '');

    // `#busy`, not `isRunning`: a question clicked twice in the same tick used to
    // pass this check twice, spawn twice, and lose whichever spawn the runner
    // refused — along with the question that spawn was carrying.
    if (deliveryBusy) {
      record.pendingAskIds = open.map((e) => e.id);
      this.#persisted.pendingResume[key] = prompt;
      // A question at a gate is work going back, so it ranks as one. Set here
      // rather than in `#holdResume` because a question deliberately never goes
      // through `resume` — see the comment at the dispatch end of this path.
      this.#persisted.sentBackResumes[key] = true;
      await this.#save();
      this.#enqueue(issueNumber);
      this.#changed();
      return {
        ok: true,
        message:
          `question saved — #${issueNumber} is mid-answer, so this goes the moment it stops at gate ${gate} again` +
          alsoSay,
      };
    }

    if (deliveryHold !== null) {
      record.pendingAskIds = open.map((e) => e.id);
      this.#persisted.pendingResume[key] = prompt;
      this.#persisted.sentBackResumes[key] = true; // same rule as the branch above
      await this.#save();
      this.#enqueue(issueNumber);
      this.#changed();
      const place = this.#queue.position(issueNumber);
      return {
        ok: true,
        message:
          `question taken — ${deliveryHold}, so it is queued (${place === 1 ? 'next up' : `${place} in line`}) ` +
          `and goes to the worker at gate ${gate} as soon as a slot frees` +
          alsoSay,
      };
    }

    // The point of no return was claimed before this question mutated the thread
    // (above), so another same-tick ask composes on top of it instead of spawning
    // beside it. `#track` gives the claim back when this run ends.
    record.pendingAskIds = [];
    await this.#save();
    this.#changed();
    try {
      await this.#spawnResume(issueNumber, scan, sessionId, prompt, { gate, ids: open.map((e) => e.id) });
    } catch (error) {
      this.#starting.delete(issueNumber);
      throw error;
    }
    return { ok: true, message: `asking — the worker answers and stops at gate ${gate} again` };
  }

  // ------------------------------------------------- gate C: ticks and rework

  /**
   * The evidence THIS CARD shows — the gate file's, with the console's snapshot
   * union'd underneath it.
   *
   * A targeted rework asks the worker to rewrite `.gate.json` carrying every
   * other step's evidence forward verbatim, and mostly it will. When it does
   * not, the honest thing is not to show the operator a shorter list than they
   * had five minutes ago: they are being asked to approve the whole issue on this
   * card, and the requirement is the full evidence for the entire issue in the
   * gate C box. So the snapshot leads and anything new is appended, matched on
   * path.
   *
   * The violation is recorded separately (`#checkQaReworkEnding`) rather than
   * inferred here, because this runs on every render and an accusation must be
   * made once, from a comparison, at the moment a run comes back.
   */
  #evidenceFor(issueNumber: number, scan: WorktreeScan | null): EvidenceItem[] {
    const current = scan?.gateEvidence ?? [];
    const snapshot = this.#persisted.qaSnapshots[String(issueNumber)];
    if (!snapshot) return current;
    // Gate C's evidence belongs to gate C. A gate file that has moved on is
    // showing a different stop's artifacts, and the sweep is about to drop this
    // snapshot anyway — until it does, it must not lead a later gate's list. A
    // MISSING gate file is the resume window, where the snapshot is all there is.
    if (scan?.gate && scan.gate.gate !== 'C') return current;
    const seen = new Set(snapshot.evidence.map((e) => e.path));
    return [...snapshot.evidence, ...current.filter((e) => !seen.has(e.path))];
  }

  /**
   * The click-script THIS CARD shows — the gate file's, with any step the
   * console has already shown the operator put back underneath it.
   *
   * The same rule as `#evidenceFor` and for a sharper reason. Evidence is
   * something they look at; a STEP is the unit Approve counts. A rework that came
   * back holding two of nine steps used to shrink the denominator with it, so
   * the card said "verify 1 more step to approve" — true about the two that
   * survived — and Approve went green over a QA whose size the worker had
   * chosen. The snapshot leads, anything new is appended, and a step only the
   * console still has is marked `missing` rather than quietly dropped.
   *
   * The merge is by step id, which is exactly why `parseManualQa` must never
   * renumber a step that already has an id.
   */
  #manualQaFor(issueNumber: number, scan: WorktreeScan | null): ManualQa | null {
    const current = scan?.gateManualQa ?? null;
    const snapshot = this.#persisted.qaSnapshots[String(issueNumber)];
    // No baseline, no gate file to merge into, or a gate that has moved past C:
    // there is nothing to put back and the snapshot is about to be retired.
    if (!current || !snapshot || scan?.gate?.gate !== 'C') return current;
    const live = new Map(current.steps.map((s) => [s.id, s]));
    const steps: ManualQaStep[] = snapshot.manualQa.steps.map((s) => live.get(s.id) ?? s);
    const seen = new Set(steps.map((s) => s.id));
    return { ...current, steps: [...steps, ...current.steps.filter((s) => !seen.has(s.id))] };
  }

  /** The step ids the last gate file came back short of, in snapshot order. */
  #missingStepIds(issueNumber: number, scan: WorktreeScan | null): Set<number> {
    const snapshot = this.#persisted.qaSnapshots[String(issueNumber)];
    if (!snapshot || !scan?.gateManualQa || scan.gate?.gate !== 'C') return new Set();
    const live = new Set(scan.gateManualQa.steps.map((s) => s.id));
    return new Set(snapshot.manualQa.steps.map((s) => s.id).filter((id) => !live.has(id)));
  }

  /**
   * TAKE THE MISSING SCREENSHOTS FOR ONE ISSUE, and remember what happened.
   *
   * The runner is in capture.ts and everything interesting is there; this is the
   * wiring — the worktree, the two ports and the operator's storage state — plus
   * the record that makes the automatic run happen once per gate round.
   *
   * The browser itself is opened lazily inside `playwrightDriver`, at the moment
   * a capture is about to run, so a console on a machine with no Chromium
   * starts, polls and serves exactly as it always did and finds out about the
   * missing browser at the one moment it matters — on the card, with the command
   * that fixes it.
   */
  async #captureFor(scan: WorktreeScan): Promise<CaptureReport> {
    const report = await captureGateShots(
      {
        issue: scan.issue,
        worktree: scan.path,
        port: scan.state.port,
        baselinePort: this.#cfg.baselinePort,
        storageState: this.#cfg.qaStorageState,
      },
      this.#captureDeps,
    );
    // Keyed on the gate file's bytes, so the automatic pass is one attempt per
    // round. A FAILED attempt claims the round too: a machine with no browser
    // must not re-launch one on every poll for the whole time a gate sits open,
    // and the failure is on the card with a button beside it.
    this.#persisted.captures[String(scan.issue)] = { ...report, gateHash: scan.gateHash };
    await this.#save();
    this.#log(`#${scan.issue}: capture — ${report.line}`);
    return report;
  }

  /**
   * SCREENSHOTS BEFORE THE CARD, not after a round trip through the operator.
   *
   * The operator asked for captures that are always there, always consistent, and
   * generated with no human intervention. The measured cost of the old behaviour
   * was 32 of 53 gate C send-backs spent asking for a capture, so this runs inside
   * the poll that first sees a gate C — the same poll `#track` fires the moment a
   * worker parks — and the caller re-scans afterwards, so the first card the
   * operator is shown already has the pictures on it.
   *
   * It is deliberately narrow about when it will run at all:
   *
   *  - gate C only. It is the only gate with a click-script to photograph.
   *  - not while a worker is running. A capture stamps `.gate.json`, and the
   *    worker owns that file until it stops.
   *  - once per gate ROUND, keyed on the file's own bytes. A worker that comes
   *    back with new steps is a new round and gets a new attempt; a poll five
   *    minutes later is not.
   *
   * Returns whether anything was stamped, which is the caller's cue to re-read
   * the worktree.
   */
  async #captureMissingShots(): Promise<boolean> {
    let stamped = false;
    for (const scan of this.#scans) {
      if (scan.gate?.gate !== 'C') continue;
      if (this.#busy(scan.issue)) continue;
      if (scan.gateHash === null) continue;
      const last = this.#persisted.captures[String(scan.issue)];
      if (last?.gateHash === scan.gateHash) continue;
      const report = await this.#captureFor(scan).catch((e: Error) => {
        // Unreachable — `captureGateShots` returns its failures rather than
        // throwing — but a capture that threw must not take a poll down with it,
        // and an empty catch is the silent skip this feature exists to delete.
        this.#log(`#${scan.issue}: capture threw — ${e.message}`);
        return null;
      });
      if (report?.ok) stamped = true;
    }
    return stamped;
  }

  /**
   * Run the capture again, on the operator's click.
   *
   * The same runner, with the once-per-round guard deliberately not consulted:
   * they press this when they have just started the dev server, or fixed the
   * baseline, or wants the pair retaken. It writes into a worktree, so it is
   * refused while that worktree's worker is running — that file is the worker's
   * until it stops.
   */
  async captureShots(issueNumber: number): Promise<{ ok: boolean; message: string }> {
    const scan = this.#scans.find((s) => s.issue === issueNumber) ?? null;
    if (!scan) return { ok: false, message: `no worktree for #${issueNumber}` };
    if (scan.gate?.gate !== 'C') return { ok: false, message: `#${issueNumber} is not at gate C` };
    if (this.#busy(issueNumber)) {
      return { ok: false, message: 'the worker is running — it owns the gate file until it stops' };
    }
    const report = await this.#captureFor(scan);
    if (report.ok) await this.poll();
    this.#changed();
    return { ok: report.ok, message: report.line };
  }

  /**
   * Which of the captures already shown to the operator are no longer FILES.
   *
   * The restore in `#evidenceFor` puts back a manifest entry; the evidence route
   * then reads the bytes live out of the worktree. So a worker that unlinks the
   * png defeats the restore completely — the card renders a broken image while
   * the round reports the path was put back. This is the one read in the whole
   * gate-C path that touches the worktree, and it runs once, when a round comes
   * back.
   */
  /**
   * Text evidence and picture evidence fail differently, so they are stamped
   * differently.
   *
   * A PICTURE is byte-exact or it is a different picture: same filename, new
   * image, and the tick above it is now vouching for something never looked at.
   * Size-and-mtime is exactly right there.
   *
   * A TRANSCRIPT is not. A rework that fixes a step and appends "here is what I
   * found and how I proved it" has made the evidence BETTER, and that is the
   * normal, wanted outcome. On #4404 the guard blocked the operator on a file
   * that had grown by 95 lines and lost none — their own finding, written up. So
   * text is stamped by its LENGTH AND A HASH OF ITS CURRENT CONTENT: if the old
   * bytes are still the head of the new file, nothing they read was altered, and
   * only additions follow. Anything else — a rewrite, a deletion, an edit in the
   * middle — fails the prefix check and is a real violation.
   */
  async #stampEvidence(scan: WorktreeScan, items: EvidenceItem[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const item of items) {
      const s = await stat(join(scan.path, item.path)).catch(() => null);
      // Only real files are stamped. A manifest entry the worker never backed
      // with an image was already nothing, and must not later read as a deletion.
      if (!s?.isFile()) continue;
      if (TEXT_EVIDENCE.test(item.path)) {
        const buf = await readFile(join(scan.path, item.path)).catch(() => null);
        if (buf) {
          out[item.path] = `t:${buf.length}:${sha(buf)}`;
          continue;
        }
      }
      out[item.path] = `b:${s.size}:${Math.round(s.mtimeMs)}`;
    }
    return out;
  }

  async #movedEvidence(
    scan: WorktreeScan,
    stamps: Record<string, string>,
  ): Promise<{ gone: string[]; changed: Array<{ path: string; added: number; removed: number }> }> {
    const gone: string[] = [];
    const changed: Array<{ path: string; added: number; removed: number }> = [];
    for (const [path, was] of Object.entries(stamps)) {
      const full = join(scan.path, path);
      const s = await stat(full).catch(() => null);
      if (!s?.isFile()) {
        gone.push(path);
        continue;
      }
      // Text, stamped by content: the old bytes must still be the HEAD of the
      // file. Pure additions pass; a rewrite, a deletion or a mid-file edit does
      // not. Report the line counts either way — "95 added, 0 removed" is the
      // whole answer to "what changed", and nobody should have to diff it by hand.
      if (was.startsWith('t:')) {
        const [, lenRaw, hash] = was.split(':');
        const wasLen = Number(lenRaw);
        const buf = await readFile(full).catch(() => null);
        if (!buf) {
          gone.push(path);
        } else if (buf.length >= wasLen && sha(buf.subarray(0, wasLen)) === hash) {
          const added = countLines(buf.subarray(wasLen));
          if (added > 0) continue; // appended only — the wanted outcome, not a violation
        } else {
          changed.push({ path, added: 0, removed: 0 });
        }
        continue;
      }
      // A LEGACY stamp (size:mtime, no prefix) on a text file cannot tell an
      // append from a rewrite — that is the whole reason the format changed. It
      // must not accuse on evidence it cannot read: #4404 was blocked by exactly
      // this, on a transcript that had only grown. Pictures still fail closed.
      const legacy = !was.startsWith('b:') && !was.startsWith('t:');
      if (legacy && TEXT_EVIDENCE.test(path)) continue;
      // A picture is byte-exact or it is a different picture.
      const now = legacy ? `${s.size}:${Math.round(s.mtimeMs)}` : `b:${s.size}:${Math.round(s.mtimeMs)}`;
      if (now !== was) changed.push({ path, added: 0, removed: 0 });
    }
    return { gone, changed };
  }

  /** What one QA step's tick reads as right now: unset, verified or failed. */
  qaStepState(issueNumber: number, step: ManualQaStep): QaStepState {
    return stepState(step, this.#persisted.qaVerdicts[String(issueNumber)] ?? []);
  }

  /**
   * The ticks resolved against the steps that are on the card RIGHT NOW, plus
   * the counts the Approve button reads.
   *
   * `complete` is the QA half of the gate lock, and only the QA half: the quiz
   * half is submitted in the page. Both are required — the operator considered
   * dropping comprehension and decided against it in the same breath, keeping the
   * gate blocked by the QA half and the comprehension half together, so nothing
   * here should ever be read as the whole lock.
   */
  #qaTicks(
    issueNumber: number,
    scan: WorktreeScan | null,
  ): { qaSteps: QaStepView[]; qaProgress: ReturnType<typeof qaProgress> } {
    // The MERGED list, not the file's: the denominator Approve counts is the
    // console's, or a worker can shrink the QA it is being held to.
    const steps = this.#manualQaFor(issueNumber, scan)?.steps ?? [];
    const missing = this.#missingStepIds(issueNumber, scan);
    const verdicts = this.#persisted.qaVerdicts[String(issueNumber)] ?? [];
    return {
      qaSteps: steps.map((step) => {
        const v = currentVerdict(step, verdicts);
        return {
          id: step.id,
          rev: step.rev,
          state: stepState(step, verdicts),
          note: v?.note ?? null,
          at: v?.at ?? null,
          shotAtFail: v?.shotAtFail ?? null,
          missing: missing.has(step.id),
        };
      }),
      qaProgress: qaProgress(steps, verdicts),
    };
  }

  /**
   * The operator ticks one QA step: verified, or failed with a note.
   *
   * This is the console's own record and touches no worktree file, spawns
   * nothing and reads nothing from GitHub — so it is legal at any moment,
   * including while a worker is mid-run.
   *
   * It is written against the exact REVISION they were looking at. A tick for a
   * step that has since been fixed and re-emitted is refused rather than
   * quietly applied to the new text: the whole value of a tick is that a person
   * looked at that thing, and the fail-safe direction is always "they re-check",
   * never "they inherit a tick they did not give".
   */
  async setQaVerdict(
    issueNumber: number,
    input: { stepId: number; rev: number; status: QaVerdict['status']; note: string | null },
  ): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    // The same merged list the card renders: a step the worker dropped is still
    // on screen with its tick, so undoing or changing that tick has to work.
    const qa = this.#manualQaFor(issueNumber, scan ?? null);
    if (!qa) return { ok: false, message: `no click-script on #${issueNumber} to tick` };

    const step = qa.steps.find((s) => s.id === input.stepId);
    if (!step) return { ok: false, message: `no step ${input.stepId} in this click-script` };
    if (step.rev !== input.rev) {
      return {
        ok: false,
        message: `step ${input.stepId} has changed since you looked at it (now rev ${step.rev}) — re-read it and tick again`,
      };
    }

    const note = (input.note ?? '').trim();
    if (input.status === 'failed' && !note) {
      return { ok: false, message: 'say what you saw — the worker builds the fix from those words' };
    }

    const verdict: QaVerdict = {
      stepId: step.id,
      rev: step.rev,
      hash: stepHash(step),
      status: input.status,
      note: note || null,
      // Stamped HERE, never taken from the caller: a page cannot backdate a tick.
      at: new Date().toISOString(),
      // The capture they were looking at when they failed it. The worker writes
      // a new one for the fix, and this is what keeps the old one reachable in
      // the step's history line afterwards.
      shotAtFail: input.status === 'failed' ? step.afterShot : null,
    };
    const all = this.#persisted.qaVerdicts[key] ?? [];
    all.push(verdict);
    this.#persisted.qaVerdicts[key] = all;
    await this.#save();
    this.#changed();
    return { ok: true, message: `step ${step.id} marked ${input.status}` };
  }

  /**
   * Send the failed steps — and only those — back to Build.
   *
   * Failing a step does not dispatch; this does. The operator works down the
   * whole card ticking, and one button sends everything they failed in ONE round.
   * Two sequential worker runs for two failed steps is the cost they objected to.
   *
   * It goes down `/resume`, so every piece of decision machinery is inherited
   * rather than rebuilt: open questions are superseded, a rework round is
   * stamped, capacity parks it in `pendingResume` with a queue position, and the
   * spawn race guard applies. What it adds is the snapshot — taken BEFORE the
   * message goes, because after it goes the worker owns the file.
   */
  async qaRework(issueNumber: number): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    if (!scan) return { ok: false, message: `no worktree for #${issueNumber}` };
    if (this.#busy(issueNumber)) return { ok: false, message: `#${issueNumber} is already running` };
    if (scan.gate?.gate !== 'C') {
      return { ok: false, message: `#${issueNumber} is not parked at gate C — a QA rework belongs to gate C` };
    }
    const qa = this.#manualQaFor(issueNumber, scan) ?? scan.gateManualQa;
    if (!qa) return { ok: false, message: `no click-script on #${issueNumber} to rework` };

    const failed = failedSteps(qa.steps, this.#persisted.qaVerdicts[key] ?? []);
    if (failed.length === 0) {
      return { ok: false, message: 'nothing is failed — tick a step Failed, with what you saw, first' };
    }

    /**
     * THE BASELINE IS A RATCHET, NOT A MIRROR.
     *
     * Taken from what the CARD holds — `#evidenceFor` and `#manualQaFor`, the
     * console's copy union'd over the file — and never from the raw scan. Taking
     * it from the file made every defence in this module last exactly one round:
     * round 1 drops six screenshots, the card puts them back, and then round 2's
     * snapshot is rebased onto the shrunken file. The prompt then asks the worker
     * to carry forward the short list, an obedient worker does exactly that, and
     * the return check compares the result against the shrunken baseline and
     * finds nothing missing. One fumbled merge followed by one honest one and
     * everything the operator ticked against is gone from the card, the gate file
     * and the baseline at once, with no violation raised anywhere.
     *
     * So while a gate C stop is open the console's copy only ever grows. It is
     * retired wholesale when the worker moves past gate C (`#sweepQaState`),
     * which is the only thing that ever shrinks it.
     */
    const previous = this.#persisted.qaSnapshots[key];
    const evidence = this.#evidenceFor(issueNumber, scan);
    this.#persisted.qaSnapshots[key] = {
      takenAt: new Date().toISOString(),
      stoppedAt: scan.gate?.stoppedAt ?? null,
      gateHash: scan.gateHash,
      evidence,
      evidenceStamps: await this.#stampEvidence(scan, evidence),
      manualQa: qa,
    };
    const entry: QaReworkEntry = {
      stepIds: failed.map((f) => f.step.id),
      notes: Object.fromEntries(failed.map((f) => [String(f.step.id), f.verdict.note ?? ''])),
      sentAt: new Date().toISOString(),
      status: 'sent',
      violation: null,
      restored: [],
    };
    const entries = this.#persisted.qaReworks[key] ?? [];
    entries.push(entry);
    this.#persisted.qaReworks[key] = entries;
    await this.#save();

    const prompt = reworkPrompt(
      failed.map((f) => ({ id: f.step.id, rev: f.step.rev, do: f.step.do, note: f.verdict.note ?? '' })),
      this.#persisted.qaSnapshots[key]!,
    );
    // BOTH, and for the same reason. A targeted rework is the sharpest send-back
    // there is — they ticked a step Failed and said what they saw — and it used to
    // reach `resume` with no `decision` at all, which defaults to `'approved'`.
    // `#recordDecision` writes against the gate the worker is PARKED at, so
    // sending a QA step back wrote an approval of gate C. decisions.ts is
    // explicit that "`feedback` never counts: sending work back is not passing a
    // gate"; this was the wiring that made the ledger say otherwise. Three
    // things read it and all three were wrong: the spine ticked C while the gate
    // sat open on a failed step, `codeSince` reset its clock (so "code has
    // landed since your QA" went quiet at the exact moment the code was about to
    // change), and `leftUnanswered` took the rework's own empty list as their
    // newest approval — hiding questions they had left open.
    const out = await this.resume(issueNumber, prompt, { decision: 'feedback', sentBack: true });
    if (!out.ok) {
      // Nothing went anywhere, so nothing is outstanding — and the baseline goes
      // back to whatever it was, rather than being deleted. Deleting it was safe
      // only while a snapshot was a mirror of the file: now it is the ratchet
      // holding an EARLIER round's restored evidence on the card, and throwing it
      // away would make screenshots vanish on a button press that reported
      // failure.
      entries.pop();
      if (previous) this.#persisted.qaSnapshots[key] = previous;
      else delete this.#persisted.qaSnapshots[key];
      await this.#save();
      return out;
    }
    // A resume at capacity parks the words instead of spawning. The round is
    // still real and still the operator's — it has just not left yet, and the card
    // says so.
    if (this.#persisted.pendingResume[key] !== undefined) entry.status = 'queued';
    await this.#save();
    this.#changed();
    const which = failed.length === 1 ? `step ${failed[0]!.step.id}` : `${failed.length} failed steps`;
    return {
      ok: true,
      message:
        entry.status === 'queued'
          ? `${which} queued for Build — it goes as soon as a slot frees, and only that step is redone`
          : `${which} sent back to Build — only that step is redone, everything else you ticked stands`,
    };
  }

  /**
   * Pass gate C — the one decision the console checks before it takes it.
   *
   * Every other gate goes down `/resume` with a message the page composed, and
   * that is right: A, B, D and E are judgements only the operator can make and
   * the console has nothing to add. Gate C is different because it has a
   * MECHANICAL half. The page renders `approveLockC` over a row that arrived by
   * SSE, and a row can be a moment old: a rework returning between the paint and
   * the click resets a
   * tick under a button that still says "Approve gate C". Recomputing here, from
   * the state on disk at the instant of the decision, is what makes the lock a
   * lock rather than a rendering of one.
   *
   * WHAT THIS IS NOT is a security boundary, and it must not be read as one. The
   * server binds loopback with no auth by design, and workers run with
   * unrestricted Bash as the same user — anything that can call this route can
   * also write `state.json`. The check earns its place against staleness and
   * against a mistake in the page, not against the machine it runs on.
   *
   * The QUIZ half cannot be checked here and deliberately is not faked: the
   * answers live in the browser's own storage, because the gate file is rewritten
   * whole on every stop. The page owns that half; this owns the QA half.
   *
   * MISSING BEFORE/AFTER EVIDENCE is not refused here either, and that is a
   * decision rather than an omission. It is a warning they are allowed to take —
   * the operator wanted a warning rather than a degraded gate, with the gate still
   * explicitly approved — so the console's duty is that it cannot be missed and
   * that taking it is deliberate and recorded, which is the tick beside Approve
   * and the `Accepted with …` lines this message carries. Refusing it here would
   * make an honest report of a failed capture a gate nobody can pass.
   */
  async approveGateC(issueNumber: number, message: string): Promise<{ ok: boolean; message: string }> {
    const said = message.trim();
    if (!said) return { ok: false, message: 'an approval needs a message' };
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    if (!scan) return { ok: false, message: `no worktree for #${issueNumber}` };
    if (scan.gate?.gate !== 'C') {
      return { ok: false, message: `#${issueNumber} is not parked at gate C — there is no gate C here to pass` };
    }

    const qa = this.#manualQaFor(issueNumber, scan);
    const verdicts = this.#persisted.qaVerdicts[String(issueNumber)] ?? [];
    const steps = qa?.steps ?? [];
    const progress = qaProgress(steps, verdicts);
    const failed = failedSteps(steps, verdicts).map((f) => f.step.id);
    const rework = (this.#persisted.qaReworks[String(issueNumber)] ?? []).at(-1) ?? null;

    // The same order the button's label uses, so a refusal here reads as the
    // same sentence they would have seen if the page had been a moment fresher.
    const refuse =
      progress.total === 0
        ? 'there are no QA steps to have verified — ask for the click-script'
        : rework?.violation
          ? `the last rework came back short — ${rework.violation}`
          : (qa?.dropped ?? 0) > 0
            ? `${qa!.dropped} step(s) of the click-script came back malformed — ask for it again`
            : (scan.gateQuiz?.dropped ?? 0) > 0
              ? `${scan.gateQuiz!.dropped} quiz question(s) came back malformed — ask for the quiz again`
              : failed.length > 0
                ? `step ${failed.join(', ')} is still ticked Failed — send it back or change your tick`
                : progress.unset > 0
                  ? `${progress.unset} step(s) are not ticked verified`
                  : null;
    if (refuse !== null) {
      return { ok: false, message: `gate C is not passable yet: ${refuse}. Nothing was sent.` };
    }
    const out = await this.resume(issueNumber, said);

    // GATE C IS THE DEV SERVER'S LAST CUSTOMER. Its only two users are the
    // worker's Playwright capture and the operator's own click-through, and both
    // are over the moment they approve; nothing between here and the merge needs
    // it, and one of them sat on port 8083 for a whole day. So the approval takes
    // its own server down with it — cleanup attached to THEIR click, not an
    // autonomous decision, and it goes down the existing guarded path, which
    // still requires the process to be listening on THAT worktree's registered
    // port AND to have its cwd inside THAT worktree. Port 8080 is untouchable
    // there and stays untouchable here.
    //
    // A failed cleanup is logged and dropped. Their approval has already been
    // taken and is the thing being reported; a dev server that would not stop
    // must never be the reason a gate decision reads as failed.
    if (out.ok) {
      try {
        const dev = await this.stopDevServerFor(issueNumber, 'you approved gate C');
        if (!dev.ok) this.#log(`#${issueNumber}: gate C approved; dev server not stopped — ${dev.message}`);
      } catch (e) {
        this.#log(`#${issueNumber}: gate C approved; stopping the dev server threw — ${(e as Error).message}`);
      }
    }
    return out;
  }

  /**
   * Take back a gate decision.
   *
   * The operator approved gate A on an assumption they now disagree with. The
   * work has moved on, but nothing about that is expensive to correct: the session
   * is resumable, the worktree is on disk, and the gate history is append-only. So
   * the worker is sent back to the stage that gate governs, with the correction in
   * their own words.
   *
   * What this is NOT is a code rewind. Nothing already written is undone, no
   * commit is touched and no file is reverted — which is why the composed
   * message asks the worker to say what it is redoing before it redoes it.
   *
   * The reversal is WRITTEN DOWN. The original round in `.gate-history.jsonl` is
   * not deleted, not edited and not re-decided; a separate reopening record is
   * appended beside it, and the gate's history in the UI shows both. A decision
   * that changed silently is the one failure this must not have.
   *
   * At capacity it parks exactly like any other answer — see `resume` — so the
   * click is never refused for want of a slot.
   */
  async reopenGate(issueNumber: number, gate: string, message: string): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    const letter = gate.trim().toUpperCase() as GateLetter;
    const said = message.trim();

    if (!GATE_LETTERS.includes(letter)) {
      return { ok: false, message: `'${gate}' is not a gate — they are ${GATE_LETTERS.join(', ')}` };
    }
    if (!said) {
      return {
        ok: false,
        message: `Reopening gate ${letter} needs to say what changed — without that the worker has nothing to correct.`,
      };
    }
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    if (!scan) return { ok: false, message: `no worktree for #${issueNumber}` };
    if (this.#runner.isRunning(issueNumber)) {
      return { ok: false, message: `#${issueNumber} is running — stop it first` };
    }
    if (!(scan.sessionId ?? this.#persisted.sessions[key])) {
      return {
        ok: false,
        message:
          `No session id for #${issueNumber}, so there is no worker to send back to gate ${letter}. ` +
          `Start it in the worktree by hand once and the console will pick the session up.`,
      };
    }

    // "Passed" from either signal: the recorded exchange in `.gate-history.jsonl`,
    // or the gates line in `.issue-state.md` for a worktree that predates it. A
    // gate that has not been passed cannot be taken back — there is no decision.
    const rounds = scan.history.filter((h) => h.gate === letter).length;
    // Was this gate actually decided? The console's own ledger, or a worker
    // history record carrying their words. NOT `state.gatesPassed` — that prose
    // line is append-only in practice and goes stale, which is what made an audit
    // report three skipped gates they had approved.
    const passed = rounds > 0 || gatesPassedFor(this.#decisions, issueNumber, scan.history).includes(letter);
    if (!passed) {
      const have = gatesPassedFor(this.#decisions, issueNumber, scan.history);
      return {
        ok: false,
        message:
          `#${issueNumber} has not passed gate ${letter}, so there is no decision to take back. ` +
          (have.length > 0 ? `Passed so far: ${have.join(', ')}.` : 'No gate has been passed yet.'),
      };
    }

    const stage = GATE_STAGE[letter];
    const reopened =
      `Reopening gate ${letter}. What changed: ${said}. ` +
      `Re-run from stage ${stage} with this correction, and tell me what you are redoing before you redo it.`;
    // A reopened gate C lands the worker back at the gate with the evidence box,
    // and the round that produced it is already history by then — so the standing
    // evidence rule goes with the correction, exactly as it does on an ask or a
    // rework.
    const composed = letter === 'C' ? withEvidenceReminder(reopened) : reopened;

    // The resume is what actually happens — immediately, or parked in the queue
    // if the desk is full. The record follows it, so a reopening is only ever
    // written down once the correction is genuinely on its way.
    // Taking a gate back IS handing the work back: it ranks with the other
    // send-backs if the desk is full (`queue.ts`, key 2), and it is `feedback`
    // rather than an approval in the ledger.
    //
    // Without the second half, reopening a gate while the worker sat parked at
    // one wrote a fresh APPROVAL of the gate it was parked at — the reversal and
    // an approval of the same work, one line apart. `reopenings` is the record
    // of WHICH gate they took back; what this fixes is the kind, so a reversal
    // stops counting as a decision in `gatesApproved`, in the daily gate-D tally
    // (`counts.ts`) and as the newest approval `codeSince` measures from.
    const out = await this.resume(issueNumber, composed, { decision: 'feedback', sentBack: true });
    if (!out.ok) return out;

    const record: GateReopening = { gate: letter, round: rounds, message: said, stage, at: new Date().toISOString() };
    this.#persisted.reopenings[key] = [...(this.#persisted.reopenings[key] ?? []), record];
    await this.#save();
    this.#changed();
    return { ok: true, message: `gate ${letter} reopened — ${out.message}` };
  }

  /**
   * Post a worker's drafted comment — the ONLY thing in this console that writes
   * to GitHub, and only ever from this one method, on the operator's explicit
   * click. The `body` is the text the operator approved (possibly edited); it is
   * passed byte-exact to the request's issue or PR. Nothing is posted unless this
   * method is called.
   */
  async postComment(
    issueNumber: number,
    body: string,
    exec?: GhWriteExec,
  ): Promise<{ ok: boolean; message: string; url?: string }> {
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    const request = scan?.commentRequest ?? null;
    if (!request) return { ok: false, message: `#${issueNumber} has no drafted comment to post` };
    if (!body.trim()) return { ok: false, message: 'refusing to post an empty comment' };
    const key = String(issueNumber);
    const requestKey = commentRequestKey(request);
    if (this.#persisted.handledCommentRequests[key]?.requestKey === requestKey) {
      return { ok: false, message: `#${issueNumber}'s current comment request was already handled` };
    }

    // Legacy files post on `request.issue`. Structured files name the exact
    // issue or PR, so a merge question can live with the review instead of
    // becoming an unrelated essay on the product ticket.
    const target = commentTarget(request);
    const targetLabel = target.kind === 'pr' ? `PR #${target.number}` : `#${target.number}`;

    const result = await postTargetComment(this.#cfg.repo, target, body, { exec });
    if (!result.ok) return { ok: false, message: `gh comment failed: ${result.error}` };

    const postedAt = new Date().toISOString();
    if (request.blocks) {
      // Blocked-on-reply: record when we posted, who we are waiting on, and
      // WHERE. The request digest is the stale-tab-safe identity a later manual
      // resolution consumes without touching the worktree file.
      this.#persisted.commentBlocks[key] = {
        addressee: request.addressee,
        onTarget: target,
        // Retained for readers from older builds and for durable state already
        // shaped around GitHub's shared issue/PR timeline number.
        onIssue: target.number,
        postedAt,
        commentUrl: result.url ?? null,
        reply: null,
        requestKey,
      };
      delete this.#persisted.handledCommentRequests[key];
      // Waiting costs nothing, so it drops out of the queue — UNLESS a decision
      // of the operator's is held for it. A non-blocking heads-up never enters
      // this path and therefore never loses its existing queue place.
      if (this.#persisted.pendingResume[key] === undefined) this.#dequeue(issueNumber);
    } else {
      // The file remains worker-owned and may linger until the next resume. Mark
      // this exact request consumed so it cannot reappear as `awaiting-post` or
      // be posted twice, without manufacturing a reply block or moving queues.
      this.#persisted.handledCommentRequests[key] = {
        requestKey,
        handledAt: postedAt,
        reason: 'posted-non-blocking',
      };
    }
    await this.#save();
    this.#changed();
    return { ok: true, message: `posted on ${targetLabel}`, url: result.url };
  }

  /**
   * Join the queue, stamped. `??=` so a repeat enqueue of something already in
   * line keeps its ORIGINAL time — otherwise every poll that re-asserted the
   * entry would reset the clock and it would read "just now" for ever.
   *
   * The boot rebuild deliberately does NOT come through here: it repopulates the
   * line from `pendingResume`, and stamping there would date every overnight
   * wait to the last restart.
   */
  #enqueue(issue: number): void {
    this.#persisted.enqueuedAt[String(issue)] ??= new Date().toISOString();
    this.#queue.enqueue(issue);
  }

  /** Leave the queue, and drop the stamp with it — a later re-queue is a new wait. */
  #dequeue(issue: number): void {
    delete this.#persisted.enqueuedAt[String(issue)];
    this.#queue.remove(issue);
  }

  /**
   * Throw a drafted comment away without posting it.
   *
   * The Post card used to be a one-way door: the only route off it was
   * `postComment`, so a draft whose moment had passed — #4619's sat there after
   * automation closed the ticket underneath it — could only be cleared by
   * deleting a worker-owned file by hand.
   *
   * It marks the request consumed by the SAME mechanism posting uses, and for
   * the same reason: `.comment-request.json` belongs to the worker and lingers
   * until its next resume, so without the fingerprint the discarded card comes
   * straight back on the next poll. Nothing here touches the worktree, and
   * nothing here reaches GitHub.
   *
   * `requestedAt` is the compare-and-clear token off the row the caller saw, so
   * a stale tab cannot throw away a NEWER draft that replaced the one on screen
   * — the same guard `resolveCommentBlock` puts on `postedAt`.
   */
  async discardComment(issueNumber: number, requestedAt: string): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    const request = this.#scans.find((s) => s.issue === issueNumber)?.commentRequest ?? null;
    if (!request) return { ok: false, message: `#${issueNumber} has no drafted comment to discard` };
    if (request.requestedAt !== requestedAt) {
      return { ok: false, message: `#${issueNumber}'s draft changed — refresh before discarding it` };
    }
    this.#persisted.handledCommentRequests[key] = {
      requestKey: commentRequestKey(request),
      handledAt: new Date().toISOString(),
      reason: 'discarded',
    };
    await this.#save();
    this.#log(`#${issueNumber}: drafted comment discarded — nothing was posted`);
    this.#changed();
    return { ok: true, message: `#${issueNumber}'s draft discarded — nothing was posted` };
  }

  /**
   * Resolve one posted-comment wait without running or resuming a worker.
   *
   * `postedAt` is a compare-and-clear token from the row the caller saw: an old
   * tab must never clear a newer question that replaced it. The consumed request
   * fingerprint is kept separately because its worker-owned file may linger;
   * this prevents the dismissed Post card from immediately resurrecting and is
   * durable across both polls and console restarts.
   */
  async resolveCommentBlock(issueNumber: number, postedAt: string): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    const block = this.#persisted.commentBlocks[key];
    if (!block) return { ok: false, message: `#${issueNumber} has no comment block to resolve` };
    if (block.postedAt !== postedAt) {
      return { ok: false, message: `#${issueNumber}'s comment block changed — refresh before resolving it` };
    }
    if (block.reply !== null) {
      return { ok: false, message: `#${issueNumber} already has a reply — resume with that answer instead` };
    }

    // New blocks carry the exact request identity. A legacy block does not, and
    // hashing whatever file happens to be current could hide a NEW request that
    // replaced it, so legacy resolution deliberately suppresses nothing.
    const requestKey = block.requestKey ?? null;
    if (requestKey) {
      this.#persisted.handledCommentRequests[key] = {
        requestKey,
        handledAt: new Date().toISOString(),
        reason: 'resolved',
      };
    }
    delete this.#persisted.commentBlocks[key];
    await this.#save();
    this.#log(`#${issueNumber}: comment block resolved without resuming a worker`);
    this.#changed();
    return { ok: true, message: `#${issueNumber} comment block resolved — no worker was started` };
  }

  /**
   * Write an attachment the operator uploaded into the issue's worktree, so a
   * worker can actually look at it.
   *
   * This is the ONLY path in the console that writes a file into a worktree that
   * a worker owns, and it is deliberately narrow: `resolveAttachmentTarget`
   * generates the filename, fixes the directory, enforces the type allowlist and
   * caps the size, so nothing the browser sends becomes a path. The bytes arrive
   * base64 because that is what a `FileReader` in the page produces and it keeps
   * the route a plain JSON POST.
   *
   * It never overwrites: the name carries a UTC minute stamp, and a collision
   * inside the same minute is suffixed rather than replacing what is there.
   */
  async attach(
    issueNumber: number,
    originalName: string,
    base64: string,
  ): Promise<{ ok: boolean; message: string; path?: string }> {
    const scan = this.#scans.find((sc) => sc.issue === issueNumber);
    if (!scan?.path) return { ok: false, message: `#${issueNumber} has no worktree to attach to` };

    let bytes: Buffer;
    try {
      bytes = Buffer.from(String(base64), 'base64');
    } catch {
      return { ok: false, message: 'refusing: attachment was not readable base64' };
    }

    const target = resolveAttachmentTarget(scan.path, originalName, bytes.byteLength);
    if (!target.ok) return { ok: false, message: target.reason };

    let abs = target.absPath;
    let rel = target.repoRelative;
    for (let n = 2; existsSync(abs) && n < 100; n += 1) {
      const dot = target.name.lastIndexOf('.');
      const suffixed = `${target.name.slice(0, dot)}-${n}${target.name.slice(dot)}`;
      rel = `${ATTACH_DIR}/${suffixed}`;
      abs = join(scan.path, rel);
    }

    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, bytes);
    } catch (e) {
      return { ok: false, message: `could not write the attachment: ${(e as Error).message}` };
    }

    this.#log(`#${issueNumber}: attachment saved at ${rel} (${bytes.byteLength} bytes)`);
    this.#changed();
    return { ok: true, message: `attached as ${rel}`, path: rel };
  }

  /**
   * Fold a drafted spin-off into the issue that found it, instead of filing it.
   *
   * Writes NOTHING to GitHub — that is the whole point of it, and it is why this
   * needs no fence: there is no write path to fence. It marks the draft handled
   * by title (see `foldedSpinOffs`) and resumes the worker with `foldPrompt`, so
   * the work comes home to this issue and ships in this PR.
   *
   * The worktree file is left exactly where it is. `.issue-request.json` belongs
   * to the worker, which deletes it on its next round; the console has never
   * written into a customer worktree and does not start here.
   */
  async foldSpinOff(issueNumber: number): Promise<{ ok: boolean; message: string }> {
    const key = String(issueNumber);
    const request = this.#scans.find((s) => s.issue === issueNumber)?.issueRequest ?? null;
    if (!request) return { ok: false, message: `#${issueNumber} has no drafted issue to fold` };

    const folded = this.#persisted.foldedSpinOffs[key] ?? [];
    if (folded.includes(request.title)) {
      return { ok: false, message: `already folded into #${issueNumber}` };
    }
    const filed = this.#persisted.spinOffs[key] ?? [];
    const prior = filed.find((f) => f.title === request.title);
    if (prior) return { ok: false, message: `already filed as #${prior.number} — too late to fold it` };

    this.#persisted.foldedSpinOffs[key] = [...folded, request.title];
    await this.#save();
    this.#log(`#${issueNumber}: related issue folded in rather than filed — nothing was created on GitHub`);

    // Same delivery as any other decision: if the desk is full it queues, and the
    // brief is held durably rather than dropped.
    const out = await this.resume(issueNumber, foldPrompt(issueNumber, request.title), { decision: 'approved' });
    this.#changed();
    return out.ok
      ? { ok: true, message: `folding into #${issueNumber} — ${out.message}` }
      : { ok: true, message: `folded into #${issueNumber}; the worker could not be resumed yet — ${out.message}` };
  }

  /**
   * File the drafted spin-off, on the operator's click. The console's second
   * GitHub write.
   *
   * The operator asked why the console could not create the issue itself, and
   * pointed out that whatever creates it can also update the status by linking it.
   *
   * The reason a WORKER may not is real and specific — the repo's autoassign
   * workflow stamps the filer as assignee and moves the card to `Ready`, so a
   * worker-filed issue skips triage and silently becomes the operator's assigned
   * work (#4562 arrived that way). But that lands the same whether the console
   * files it or they press Submit on the prefilled GitHub form, because it is
   * their account either way. The fence was buying the DECISION, not protection from
   * the automation, and a click here keeps the decision exactly where it was.
   *
   * The gain is the link. A browser form tells GitHub the new number and nobody
   * else; here the console holds parent and child at once and records both.
   */
  async fileSpinOff(
    issueNumber: number,
    exec?: IssueWriteExec,
  ): Promise<{ ok: boolean; message: string; number?: number; url?: string }> {
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    const request = scan?.issueRequest ?? null;
    if (!request) return { ok: false, message: `#${issueNumber} has no drafted issue to file` };

    // Filing twice from one draft is the mistake this guards: nothing deletes
    // `.issue-request.json`, so the card stays on screen after a successful file
    // and a second click would raise a duplicate under their name.
    // Folded and filed are mutually exclusive. Filing something already absorbed
    // raises exactly the duplicate the fold existed to avoid.
    if ((this.#persisted.foldedSpinOffs[String(issueNumber)] ?? []).includes(request.title)) {
      return { ok: false, message: `that draft was folded into #${issueNumber} — nothing to file` };
    }

    const already = this.#persisted.spinOffs[String(issueNumber)] ?? [];
    if (already.some((s) => s.title === request.title)) {
      const prior = already.find((s) => s.title === request.title)!;
      return { ok: false, message: `already filed as #${prior.number}`, number: prior.number, url: prior.url };
    }

    // The route and worktree already identify the parent. Use that fact for the
    // GitHub write as well as the card, so an omitted or mismatched worker field
    // cannot produce an unlinked child.
    const out = await createIssue(this.#cfg.repo, { ...request, fromIssue: issueNumber }, { exec });
    if (!out.ok || out.number === undefined) {
      return { ok: false, message: `filing failed: ${out.error ?? 'unknown'}` };
    }

    this.#persisted.spinOffs[String(issueNumber)] = [
      ...already,
      { number: out.number, title: request.title, url: out.url ?? '', at: new Date().toISOString() },
    ];
    await this.#save();
    this.#changed();
    return { ok: true, message: `filed #${out.number}`, number: out.number, url: out.url };
  }

  /**
   * Resolve an evidence file for the read-only endpoint, or refuse. The fence
   * lives in resolveEvidencePath; this only supplies the right worktree.
   */
  evidenceFile(issueNumber: number, requestedPath: string): { ok: boolean; reason: string; absPath?: string } {
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    return resolveEvidencePath(scan?.path ?? null, requestedPath);
  }

  /**
   * Kill a worker. The ONLY thing in the console that kills a worker —
   * restarting the console certainly does not — so it happens on the operator's
   * explicit click and nowhere else.
   *
   * When a worker WAS actually stopped it also stops that worktree's dev server,
   * under the same attribution rule as everywhere else, because stopping a
   * worker should actually return memory: the `claude` process is 0.2–0.5 GB and
   * the dev server it left behind can be more than that.
   *
   * When nothing was running, nothing else happens either. A POST to stop an
   * idle issue must not quietly become a bare dev-server kill — that server may
   * be the one the operator has open in a browser for their own QA.
   */
  async stopWorker(issueNumber: number): Promise<{ ok: boolean; message: string }> {
    // SIGTERM is not DELIVERED to a stopped process until it continues. Stopping
    // a paused worker without this would leave the signal pending, the process
    // frozen, the row saying "stopping" and nothing ever happening — so the
    // pause is lifted first, and only then does the existing stop run.
    if (this.#persisted.runningRuns[String(issueNumber)]?.paused) await this.unpauseWorker(issueNumber);
    const stopped = this.#runner.stop(issueNumber);
    // Stop means stop, and that includes the place in the line — through
    // `#dropFromQueue`, so a decision held for this issue goes with it and is
    // SAID rather than orphaned. It is the same rule `dequeue` states: a later
    // start must never resume with a decision the operator has since called off.
    const dropped = this.#dropFromQueue(issueNumber);
    const alsoDropped = dropped.held ? ` — ${dropped.note}` : '';
    if (!stopped) {
      this.#changed();
      return { ok: dropped.held, message: `nothing running${alsoDropped}` };
    }
    const dev = await this.stopDevServerFor(issueNumber, 'you stopped the worker');
    this.#changed();
    const head = `stopping #${issueNumber}${alsoDropped}`;
    return { ok: true, message: dev.ok ? `${head} — also ${dev.message}` : head };
  }

  // ------------------------------------------------------------- dispatch

  /**
   * What the memory guard says right now, plus the one thing it cannot see: a
   * container restart in flight. Starting a worker into those ~12 seconds means
   * its first edge-function call meets a container that is coming back up, and
   * the reason it is held has to read as its own thing, not as a free-% number
   * that is about to change anyway.
   */
  #resourceVerdict(): { ok: boolean; reason: string } {
    if (this.#reclaiming) {
      return { ok: false, reason: 'waiting on memory — reclaiming the edge runtime, about 12 seconds' };
    }
    // A PAUSED WORKER IS NOT A DISPATCH HOLD. It used to be — "resume it before
    // starting more" — and that made parking one issue to work another
    // impossible, which is the whole reason the pause button exists. What a
    // paused worker holds is RAM, not a slot, and the RAM is already counted:
    // its pages are resident, so `memory_pressure`, `vm_stat` and the swap
    // reading below all measure it whether it is frozen or not. The memory
    // guard is what decides whether there is room for another worker; a frozen
    // process is not a second opinion on that.
    const poll = this.#resources;
    if (!poll) return { ok: false, reason: 'waiting on resources: not measured yet' };

    // The 2-minute blind spot, closed. The machine read's free % can be two
    // minutes old — on the night of the crash it was, and it said there was
    // headroom while the machine went down. When the watcher has something
    // fresher, its numbers replace it before the same decision function runs, so
    // dispatch reacts within one tick (5 s) instead of one machine read (120 s).
    // The docker footprint stays on that read: it moves slowly and costs a
    // `docker stats`. Both cadences are independent of the GitHub poll, which is
    // fifteen minutes and never feeds this decision.
    const watch = this.#watch;
    if (!watch || Date.parse(watch.at) <= Date.parse(poll.checkedAt)) return poll;
    // A watch sample that could not read the free % must NOT overwrite one that
    // could. `decideResources` treats a null free % as "allow, tool missing",
    // which is right for a machine nobody can measure and catastrophic as a way
    // of un-doing a hold the poll had already decided on.
    if (watch.freePct === null) return poll;
    return decideResources({
      freePct: watch.freePct,
      minFreePct: this.#cfg.minFreePct,
      footprintBytes: poll.footprintBytes,
      ceilingBytes: poll.ceilingBytes,
      headroomBytes: watch.headroomBytes,
      headroomNeededBytes: this.#cfg.workerHeadroomBytes,
        // The kernel verdict rides the machine read, not the watcher: it is a
        // whole-machine judgment that moves over minutes, so a two-minute-old
        // number is a true one, and a fresher free % must not un-do it.
      pressureLevel: poll.pressureLevel ?? null,
    });
  }

  /**
   * How many workers are occupying a SLOT.
   *
   * A paused worker is not one of them. `activeCount()` counts everything in
   * the runner's map, frozen or not, and using that for dispatch is what made
   * "pause this and let me work the other issue" impossible. What a paused
   * worker holds is memory — already measured by the memory guard, which is a
   * separate brake and stays exactly as strict as it was.
   */
  #slotsTaken(): number {
    return Math.max(0, this.#runner.activeCount() - this.#pausedIssues().length);
  }

  /**
   * Is there a session in this worktree worth CONTINUING?
   *
   * Not a gate answer to deliver and not a fresh start — a run that stopped
   * mid-flight with its context intact. Answered by the one thing that proves a
   * worker has actually worked here: a transcript on disk.
   *
   * That is deliberately the SAME test the fresh-start path already makes, where
   * it is the reason to mint a new session id ("a pinned id that already has a
   * transcript is spent"). Here it is the reason not to. Reading one fact two
   * ways in two places is how a checkpoint came to be restarted from Preflight
   * while the console knew perfectly well the session was there.
   *
   * A BRIEF beats this, always. `reworkFresh` and `postMergeStart` mint their own
   * session and set `#pendingPrompt` precisely because they want a fresh worker
   * with their words; both would already fail the transcript test, and the guard
   * is here anyway because consuming somebody else's brief is the one mistake in
   * this area that cannot be undone.
   */
  async #canContinue(issueNumber: number, scan: WorktreeScan): Promise<boolean> {
    if (this.#pendingPrompt.has(issueNumber)) return false;
    const key = String(issueNumber);
    const sessionId = this.#persisted.sessions[key] ?? scan.sessionId ?? null;
    if (sessionId === null) return false;
    const provider = this.#providerOf(issueNumber);
    // Codex owns its own thread ids and there is no transcript to stat; the
    // recorded thread is the same proof, and the same one the fresh path reads.
    if (provider === 'codex') return this.#persisted.agentSessions[key] !== undefined;
    return (await mtimeMs(transcriptPath(scan.path, sessionId, this.#accountOf(issueNumber).configDir))) !== null;
  }

  /**
   * What the queue needs to know to order one waiting ticket: has UAT sent it
   * back, and what did triage rank it. The operator asked that the line always
   * pick UAT failures first, then P0, P1, P2 and P3 in that order.
   *
   * Both facts are read from the SAME two sources the row and the rail read —
   * the issue's labels, and the derived actions feed — so the line the
   * dispatcher serves cannot disagree with the order the operator is looking at. A
   * second parse of the comments here would be a second implementation of
   * `uatFail`, and the one in `uat.ts` is deliberately strict (a real person,
   * not this console's account, posting the QA template on the issue after the
   * merge). A `Pass` verdict is the good news that RETIRES a send-back; it is
   * never fix-first.
   *
   * An issue the console has no record of — enqueued from a `pendingResume`
   * that outlived its issue, or queued before the first poll landed — weighs as
   * unranked with no send-back, which puts it exactly where an unlabelled issue
   * goes rather than at either end of the line.
   */
  #weigh(issue: number): Weight {
    const uat = uatFailFor(this.#actions.actions, issue);
    return {
      uatFail: uat !== null && uat.verdict !== 'Pass',
      sentBack: this.#sentBack(issue),
      band: bandOf(this.#issues.find((i) => i.number === issue)?.labels ?? []),
    };
  }

  /**
   * Is the thing waiting on this issue something the operator SENT BACK?
   *
   * A P2 the operator has sent back outranks a P1 nobody has sent back yet:
   * failures are resolved first and immediately. This is the fact that key sorts
   * on; `queue.ts` holds the reasoning.
   *
   * Gated on a live `pendingResume` deliberately. The mark is one boolean beside
   * the parked words and it is the words that are the work — so an entry left
   * behind by a path that cleared one and not the other cannot promote anything,
   * and a send-back that has already gone out stops ranking the moment it does.
   * The same shape as `isParked`'s `!= null`: absent, or orphaned, is "no".
   */
  #sentBack(issue: number): boolean {
    const key = String(issue);
    if (this.#persisted.pendingResume[key] === undefined) return false;
    return this.#persisted.sentBackResumes[key] === true;
  }

  async #dispatch(): Promise<void> {
    // A console that has been told to stop starts nothing. Dispatch is fired
    // and forgotten from half a dozen places, so without this a request that was
    // already in flight can spawn a worker into a shutdown — or, in a test, into
    // a worktree that has just been deleted.
    if (this.#stopped) return;
    // An issue whose worker is ALREADY RUNNING is not dispatchable, and saying so
    // here is what makes asking a question mid-answer safe. Without it, a free
    // slot (at MAX_ACTIVE ≥ 2) picks that issue, `resume` refuses it with
    // "already running", and the held-message error path below deletes the held
    // question and says it could not be sent — a question lost to a race.
    const waiting = this.#queue.list().filter((n) => !this.#busy(n));
    const decision = selectNext({
      queue: waiting,
      // Slots, not processes: a paused worker has given its slot back.
      activeCount: this.#slotsTaken(),
      maxActive: this.#cfg.maxActive,
      resources: this.#resourceVerdict(),
    });
    this.#dispatchReason =
      decision.issue === null && waiting.length === 0 && this.#queue.list().length > 0
        ? 'the queued work is already running — its message goes when that run stops'
        : decision.reason;
    if (decision.issue === null) {
      this.#changed();
      return;
    }

    const issueNumber = decision.issue;
    const key = String(issueNumber);
    const scan = this.#scans.find((s) => s.issue === issueNumber);
    if (!scan) {
      this.#dequeue(issueNumber);
      this.#pendingPrompt.delete(issueNumber); // a brief must never outlive its dispatch
      // A decision cannot be delivered to a worktree that is gone, and holding
      // it would mean sending it to whatever is created next under this number.
      delete this.#persisted.pendingResume[key];
      delete this.#persisted.sentBackResumes[key];
      delete this.#persisted.superchargeResumes[key];
      this.#persisted.lastErrors[key] = 'worktree disappeared';
      await this.#save();
      this.#changed();
      return;
    }

    // A CLOSED issue is not STARTED, however it got into the queue.
    //
    // `resume` is left deliberately open — a close landing mid-run must not
    // strand the session it lands on, and an explicit click on a row that now
    // says "Closed on GitHub" is the operator deciding. A dispatch is neither. It
    // begins work on its own, minutes or hours after the queueing, and by then the
    // ticket can have been signed off: #5697 was closed and QA-passed on 3
    // September and sat at the head of this queue the next evening, one freed
    // slot away from running again.
    //
    // Dequeued rather than skipped, because the queue is served from the head:
    // a refusal that left it in place would stop everything behind it for ever.
    // The held answer goes with it, exactly as a dequeue by hand drops it — the
    // decision was about work that has since been signed off.
    if (this.#orphanFacts.get(issueNumber)?.state === 'CLOSED') {
      this.#dequeue(issueNumber);
      this.#pendingPrompt.delete(issueNumber);
      delete this.#persisted.pendingResume[key];
      delete this.#persisted.sentBackResumes[key];
      delete this.#persisted.superchargeResumes[key];
      await this.#save();
      // No `lastErrors` entry: a closed issue is not a failed run, and a `failed`
      // row would outrank the `done` the close has earned. The line and the row's
      // own card are where this is said.
      this.#log(
        `#${issueNumber}: not started — the issue is closed on GitHub. Reopen it there to queue it again.`,
      );
      // AND THE DISPATCHER SAYS SO IN ITS OWN STATE, not only in the log.
      //
      // `selectNext` has already written "starting #5697" into `#dispatchReason`
      // twenty lines up, and this refusal used to leave that standing: the last
      // decision the console reported making was to start the thing it had just
      // declined to start, while the row vanished out of the queue with the held
      // answer. A drop nobody can see the reason for is the shape of a bug, and
      // the reason is the whole point of taking it out.
      this.#dispatchReason = `#${issueNumber} is closed on GitHub — not started, and taken out of the line`;
      this.#changed();
      return;
    }

    this.#dequeue(issueNumber);

    // A worktree already parked at a gate resumes; a fresh one starts the skill.
    // The worker's own `sessionId` field is null on every record ever written, so
    // preferring it only ever cost a fallback. The console generated the session
    // and knows it; that is the value used.
    const parked = scan.gate !== null && scan.sessionId !== null;
    // An answer held while the desk was full is delivered by RESUMING too, gate
    // file or not. A reopened gate has none — that gate was passed and its file
    // is long gone — and without this the dispatch fell straight through to the
    // fresh-start path and ran `/issue-pipeline <N>` from the top, silently
    // dropping the correction the operator had been promised would run.
    const held = this.#persisted.pendingResume[key];
    // AND SO DOES A CHECKPOINT. The third case, and the one that had no branch.
    //
    // A run that stopped mid-flight leaves no gate file and holds no answer, so
    // it matched neither test above and took the fresh path: `/issue-pipeline <N>`
    // from the TOP, and — because that session's transcript already exists on
    // disk, which `claude -p --session-id` refuses — under a NEWLY MINTED
    // session id. So the single button on a checkpoint card abandoned the
    // context of the run that got the work there and re-entered at Preflight.
    // #5402 was four gates deep with that button as its only offer.
    //
    // `postMergeStart` already says the rule this borrows: "A session on disk is
    // the better path by far: it remembers the issue, the plan and the review
    // rounds." The card even keeps "Restart fresh…" as its own deliberate
    // action, which is what "Start a worker" should NOT have been doing.
    const continuing = parked || held !== undefined ? false : await this.#canContinue(issueNumber, scan);
    if (parked || held !== undefined || continuing) {
      const resumableSession = scan.sessionId ?? this.#persisted.sessions[key] ?? null;
      if (resumableSession) {
        const readiness = await this.#resumeReadiness(issueNumber);
        if (readiness) {
          // Queue removal above is only a claim for this dispatch attempt. A
          // broken profile must not consume the held answer/question or gate;
          // put the claim back so a relink can deliver the exact same payload.
          this.#enqueue(issueNumber);
          this.#dispatchReason = readiness;
          this.#changed();
          return;
        }
      }
      // A resume stays on the session's own account and model; a picker choice
      // that was never spawned has nothing to apply to here.
      this.#pendingAccount.delete(issueNumber);
      this.#pendingModel.delete(issueNumber);
      this.#pendingPrompt.delete(issueNumber);
      // A held QUESTION is delivered by its own path, never through `resume`:
      // resume is the decision path, and a question must not clear a comment
      // block, stamp a rework round, or overtake itself as it goes out.
      const askIds = this.#persisted.gateThreads[key]?.pendingAskIds ?? [];
      if (held !== undefined && askIds.length > 0) {
        const record = this.#persisted.gateThreads[key]!;
        const sessionId = scan.sessionId ?? this.#persisted.sessions[key] ?? null;
        record.pendingAskIds = [];
        delete this.#persisted.pendingResume[key];
        delete this.#persisted.sentBackResumes[key];
      delete this.#persisted.superchargeResumes[key];
        if (!sessionId) {
          // Same rule as an undeliverable decision: it is said out loud on the
          // row rather than disappearing.
          this.#persisted.lastErrors[key] = 'your question could not be sent — there is no session to ask';
        } else {
          this.#starting.add(issueNumber); // claimed before the await, as everywhere else
        }
        await this.#save();
        this.#changed();
        if (sessionId) await this.#spawnResume(issueNumber, scan, sessionId, held, { gate: record.gate, ids: askIds });
        return;
      }
      // The operator's own words, sent verbatim. Only "Continue." when there is
      // nothing held, which is a resume nobody typed.
      // A held answer IS their decision, arriving late. A bare 'Continue.' is the
      // queue picking work back up and decides nothing.
      //
      // WHICH decision it was is read from the mark parked beside the words, not
      // assumed. `'approved'` was hard-coded here, so every feedback answer that
      // waited for a slot — and only because it waited — was written to the
      // ledger as an approval of the gate it was sent back from. The mark is
      // consumed below, so it is read before that happens.
      const heldWasSentBack = this.#persisted.sentBackResumes[key] === true;
      // ...and WHO made it, read before the mark is consumed, for the same
      // reason: the ledger line for a held decision is written here, and this is
      // the only thing that still knows the console composed those words.
      const heldWasSupercharge = this.#persisted.superchargeResumes[key] === true;
      // Continuing a checkpoint sends the skill's own resume mode rather than
      // "Continue.": the worker rebuilds its bearings from the worktree and
      // picks up at the stage the evidence supports, which is the whole point of
      // keeping the session. It decides no gate, so `null` — see `resume`.
      const message = held ?? (continuing ? this.#providers[this.#providerOf(issueNumber)].workflowPrompt(issueNumber, 'resume') : 'Continue.');
      const out = await this.resume(issueNumber, message, {
        fromDispatch: true,
        decision: held ? (heldWasSentBack ? 'feedback' : 'approved') : null,
        ...(held !== undefined && heldWasSupercharge ? { by: 'supercharge' as const } : {}),
      });
      if (!out.ok) {
        // The message is still addressed to this session. Keep it durable and
        // queued on any pre-spawn refusal; restart-fresh explicitly clears it if
        // the operator chooses to abandon that session instead.
        this.#enqueue(issueNumber);
        this.#persisted.lastErrors[key] = `your answer could not be sent — ${out.message}`;
        await this.#save();
        this.#changed();
        return;
      }
      if (held !== undefined) {
        // It is consumed only after the immediate launch path accepted it.
        delete this.#persisted.pendingResume[key];
        delete this.#persisted.sentBackResumes[key];
      delete this.#persisted.superchargeResumes[key];
        await this.#save();
        this.#changed();
      }
      return;
    }

    // Stamp the account and the model at SPAWN: the pickers' choices if there
    // were any, otherwise whatever this issue already runs under (for a new
    // issue: the default account, and the model its chain resolves to).
    const chosen = this.#pendingAccount.get(issueNumber) ?? this.#persisted.accountByIssue[key] ?? null;
    const account = accountFor(this.#accounts, chosen);
    const previousProvider =
      this.#persisted.providerByIssue[key] ??
      (this.#persisted.accountByIssue[key]
        ? accountFor(this.#accounts, this.#persisted.accountByIssue[key]).provider
        : undefined);
    if (previousProvider && previousProvider !== account.provider && !this.#pendingModel.has(issueNumber)) {
      delete this.#persisted.modelByIssue[key];
    }
    this.#persisted.accountByIssue[key] = account.name;
    this.#persisted.providerByIssue[key] = account.provider;
    this.#pendingAccount.delete(issueNumber);
    const model = this.#modelOf(issueNumber);
    this.#persisted.modelByIssue[key] = model;
    this.#pendingModel.delete(issueNumber);

    let sessionId = this.#persisted.sessions[key] ?? scan.sessionId ?? randomUUID();
    // A fresh start needs a session id that does not already exist: `claude -p
    // --session-id <id>` refuses an id whose transcript is already on disk. A
    // pinned (or adopted) id that already has a transcript is spent — mint a new
    // one rather than fail to launch. A freshly minted uuid never has a transcript.
    if (
      (account.provider === 'claude' &&
        (await mtimeMs(transcriptPath(scan.path, sessionId, account.configDir))) !== null) ||
      (account.provider === 'codex' && this.#persisted.agentSessions[key] !== undefined)
    ) {
      sessionId = randomUUID();
      delete this.#persisted.agentSessions[key];
    }
    this.#persisted.sessions[key] = sessionId;
    // Normally the skill from the top; a rework fresh start supplies its own
    // prompt (resume mode + the brief) for this one spawn. Either way a FRESH
    // spawn carries the fan-out rule — and a resume never does; see FANOUT_RULE.
    const prompt = `${
      this.#pendingPrompt.get(issueNumber) ?? this.#providers[account.provider].workflowPrompt(issueNumber, 'start')
    }\n\n${FANOUT_RULE}\n\n${SKILLS_RULE}`;
    this.#pendingPrompt.delete(issueNumber);
    await this.#save();
    const ctx = await this.#runContext(issueNumber, scan, sessionId, account.name, model);
    this.#contexts.set(issueNumber, ctx);
    void this.#track(
      issueNumber,
      this.#runner.start(issueNumber, scan.path, sessionId, prompt, account.configDir, model, account.provider),
      ctx,
    );
  }

  async #track(issueNumber: number, run: Promise<RunResult>, ctx: RunContext): Promise<void> {
    const key = String(issueNumber);
    const result = await run;
    if (result.agentSessionId) {
      this.#persisted.agentSessions[key] = result.agentSessionId;
      this.#persisted.providerByIssue[key] = result.provider;
    }
    // The runner is done with this issue one way or the other, so the spawn
    // claim goes back — before the early returns below, or a refused twin would
    // leave the issue looking busy for ever. See #busy.
    this.#starting.delete(issueNumber);
    // Neither of these is an ENDING, and nothing may be concluded or recorded
    // about either. Its runningRuns row must stay exactly where it is — that row
    // IS the re-attachment:
    //
    //  - `left-running`: the console stopped watching and the worker carried on.
    //  - `refused`: this spawn never happened because one was already running.
    //    The row, the context and the card all belong to the live worker, and
    //    running a refusal through the ending path deleted them — orphaning the
    //    worker on the next restart and taking `runningRuns[].ask`, the only
    //    persisted record that the live run is answering a question, with it.
    if (result.outcome === 'left-running' || result.outcome === 'refused') return;

    this.#contexts.delete(issueNumber);
    // Read BEFORE the row goes: it is the only record of how long this run spent
    // frozen, and without it a paused hour would read as model slowness in
    // runs.jsonl for ever.
    const pausedMs = this.#persisted.runningRuns[key]?.pausedMs ?? null;
    delete this.#persisted.runningRuns[key];
    await this.#checkAskEnding(key, ctx, result);
    if (result.transcriptMtimeMs !== null) this.#persisted.exitMtimes[key] = result.transcriptMtimeMs;
    if (result.outcome === 'failed' && result.error) this.#persisted.lastErrors[key] = result.error;
    else delete this.#persisted.lastErrors[key];
    // A CLEAN EXIT AT NO GATE IS NEWS, and this is the only line that keeps it.
    // `finished` means the process exited 0, emitted its `result` event and left
    // no gate file — so the `delete` above has just removed the last trace that
    // a run happened at all, and the row falls to the same sentence an untouched
    // worktree prints. The next line of this same handler writes
    // `exit: 'exited-no-gate'` into `runs.jsonl`; the row deserves it too.
    if (result.outcome === 'finished' && !result.gate) {
      this.#persisted.endedWithoutGate[key] = new Date().toISOString();
    } else delete this.#persisted.endedWithoutGate[key];
    await this.#save();
    if (result.outcome === 'gate' && result.gate) {
      await appendGateProvenance(this.#gateProvenanceFile(), {
        issue: ctx.issue,
        gate: result.gate.gate,
        sessionId: ctx.sessionId,
        stoppedAt: result.gate.stoppedAt,
        provider: ctx.provider,
        account: ctx.account,
        model: ctx.model,
        agentSessionId: result.agentSessionId,
        recordedAt: new Date().toISOString(),
      });
    }
    await this.#recordRun(ctx, result, pausedMs);
    // NOTHING is stopped here. A worker parking at a gate is precisely when the
    // running app matters most: gate C is the operator's own QA of it, and the
    // Playwright screenshot capture drives the same dev server. The console says
    // what is running and gives them a button; it does not tidy up behind them.
    await this.poll(); // pick up .gate.json and any state file the worker wrote
    // AFTER the poll, and NOT ONLY inside it. `poll()` returns immediately when
    // one is already running, so on a busy console the line above can be a
    // no-op — which is exactly how #5555 came to sit at gate B for seven
    // minutes with supercharge on. This call reads the gate file itself, so it
    // is correct whether that poll ran or not.
    await this.#autoDecideSuperchargedGates();
  }

  /**
   * Is there a DECISION of the operator's held for this issue, waiting for a slot?
   *
   * A question held in the same place is not one — see the row comment above.
   */
  #answerIsQueued(issueNumber: number): boolean {
    const key = String(issueNumber);
    if (this.#persisted.pendingResume[key] === undefined) return false;
    return (this.#persisted.gateThreads[key]?.pendingAskIds.length ?? 0) === 0;
  }

  /**
   * Did a run that was only ANSWERING A QUESTION come back to the gate it was
   * asked at?
   *
   * This is the structural half of the charge-past defence. The wording of the
   * ask and the skill's own rule are the other two, and neither is provable: the
   * worker is autonomous, and no prompt can guarantee obedience. What IS provable
   * is where the run ended, so a run asked at gate C that ends anywhere else —
   * at a different gate, or finished with no gate file at all — is recorded
   * against the issue in plain English, with the one-click remedy named.
   *
   * A run that FAILED or was STOPPED is not accused of anything. It did not walk
   * past the gate; it died before it could answer, and the thread says so by
   * leaving the question unanswered.
   *
   * The state file is written by the caller immediately after this.
   */
  async #checkAskEnding(key: string, ctx: RunContext, result: RunResult): Promise<void> {
    if (!ctx.ask) return;
    const record = this.#persisted.gateThreads[key];
    if (!record) return;
    if (result.outcome === 'failed' || result.outcome === 'stopped') return;
    const heldTheGate = result.outcome === 'gate' && result.gate?.gate === ctx.ask.gate;
    if (!heldTheGate) {
      record.violation = chargedPastMessage(ctx.ask.gate);
      return;
    }
    // It came back to the right gate. That is the only thing the gate letter can
    // tell us, and the ask prompt TELLS the worker to write that letter back —
    // so on its own it proves obedience to one instruction and nothing about the
    // rest of the run. The head is the second provable thing, and the console
    // already holds the one from before the run started.
    //
    // A head that could not be read on either side is not evidence, so it says
    // nothing rather than guessing: an accusation from a failed measurement is
    // worse than no accusation at all.
    if (ctx.headBefore === null) return;
    const headAfter = await gitHead(ctx.worktree);
    if (headAfter === null || headAfter === ctx.headBefore) return;
    record.violation = committedWhileAnsweringMessage(ctx.ask.gate);
  }

  // ---------------------------------------------------------------- metrics

  /** What we know before a run starts, so it can be measured when it ends. */
  async #runContext(
    issueNumber: number,
    scan: WorktreeScan,
    sessionId: string,
    account: string,
    model: string,
    ask: { gate: GateLetter; ids: number[] } | null = null,
  ): Promise<RunContext> {
    return {
      issue: issueNumber,
      worktree: scan.path,
      sessionId,
      provider: this.#providerOf(issueNumber),
      model,
      account,
      startedAt: new Date().toISOString(),
      startedMs: Date.now(),
      headBefore: await gitHead(scan.path),
      stageStart: scan.gate?.stage ?? scan.state.stage ?? null,
      labels: this.#issues.find((i) => i.number === issueNumber)?.labels ?? [],
      ask,
    };
  }

  /**
   * One line in `runs.jsonl` per run. Append-only, and deliberately fire-and-
   * forget: a measurement that cannot be written must never take the worker with
   * it, so every read here is allowed to fail into a null.
   *
   * The quality signals that arrive LATER — whether the gate passed first time,
   * the rework rounds, CI — are not written here at all. They are joined in at
   * read time (`metrics()`), because back-writing them would mean rewriting an
   * append-only log.
   */
  async #recordRun(
    ctx: RunContext,
    result: Awaited<ReturnType<WorkerRunner['start']>>,
    pausedMs: number | null = null,
  ): Promise<void> {
    // Stamped FIRST: the git and file reads below are the measuring, and timing
    // the measurement as if it were the work is how a duration column lies.
    const endedMs = Date.now();
    const gate = result.gate?.gate ?? null;
    const stat = await workStat(ctx.worktree, ctx.headBefore);

    // The worker appends the PREVIOUS gate to history on resume, so at this
    // moment history holds every RESOLVED stop and not this one: its length for
    // this gate is exactly how many attempts came before. No file yet means
    // nothing has been appended, which is zero attempts, not an unknown.
    let gateStopsBefore: number | null = null;
    if (gate) {
      const raw = await readFile(join(ctx.worktree, '.gate-history.jsonl'), 'utf8').catch(() => '');
      gateStopsBefore = parseGateHistory(raw).filter((h) => h.gate === gate).length;
    }

    const stageEnd =
      result.gate?.stage ??
      parseIssueState(await readFile(join(ctx.worktree, '.issue-state.md'), 'utf8').catch(() => '')).stage;

    const record: RunRecord = {
      issue: ctx.issue,
      segment: gate ?? 'none',
      provider: ctx.provider,
      model: ctx.model,
      resolvedModel: result.resolvedModel,
      account: ctx.account,
      startedAt: ctx.startedAt,
      endedAt: new Date(endedMs).toISOString(),
      durationMs: endedMs - ctx.startedMs,
      agentSessionId: result.agentSessionId,
      sessionId: ctx.sessionId,
      exit: result.outcome === 'gate' ? 'gate' : result.outcome === 'finished' ? 'exited-no-gate' : 'error',
      error: result.outcome === 'stopped' ? 'stopped from the console' : result.error,
      stageStart: ctx.stageStart,
      stageEnd,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      reasoningOutputTokens: result.usage?.reasoningOutputTokens ?? null,
      cacheReadTokens: result.usage?.cacheReadTokens ?? null,
      cacheCreationTokens: result.usage?.cacheCreationTokens ?? null,
      costUsd: result.usage?.costUsd ?? null,
      assistantTurns: result.turns,
      toolCalls: result.toolCalls,
      usageSource: result.usage?.source ?? null,
      filesChanged: stat.filesChanged,
      insertions: stat.insertions,
      deletions: stat.deletions,
      touchedMigration: stat.touchedMigration,
      labels: ctx.labels,
      gateStopsBefore,
      // Time this run spent frozen. `durationMs` is wall-clock and has to stay
      // that way, so the honest reading of a run is duration MINUS this.
      pausedMs,
    };
    await appendRun(this.#cfg.runsFile, record);
  }

  /**
   * The per-model × per-segment table. Everything late-arriving is joined HERE,
   * against live state, rather than written back into the log:
   *
   *  - gate history and the live gate say whether a gate passed first time and
   *    how many rounds of feedback it took;
   *  - the review blocks say which rework rounds landed after which run;
   *  - one read-only `gh pr list` says where CI stands right now. It costs
   *    THREE graphql points, not one — `statusCheckRollup` is what makes it
   *    three. Cached for `metricsTtlMs`, so it is minor, but the Settings tab
   *    and the daily snapshot each pay it.
   *
   * A signal we cannot read is left OUT, not defaulted — an issue whose worktree
   * is gone contributes no approval data, and that is a different answer from a
   * bad one. Nothing here ranks models or recommends one; at this console's
   * sample sizes it could not honestly do either.
   */
  async metrics(): Promise<MetricsPayload> {
    const cached = this.#metrics;
    if (cached && Date.now() - cached.at < this.#cfg.metricsTtlMs) return cached.payload;
    const payload = await this.#buildMetrics();
    this.#metrics = { at: Date.now(), payload };
    return payload;
  }

  /** The build itself. Separate from the cache because the daily snapshot job
   *  builds its own and must not leave its answer sitting in the tab's cache. */
  async #buildMetrics(): Promise<MetricsPayload> {
    const runs = await readRuns(this.#cfg.runsFile);
    const late: LateSignals = { gateStops: {}, openGate: {}, reworkRequestedAt: {}, ciRed: {} };

    for (const scan of this.#scans) {
      const key = String(scan.issue);
      const stops: Record<string, number> = {};
      for (const h of scan.history) stops[h.gate] = (stops[h.gate] ?? 0) + 1;
      late.gateStops[key] = stops;
      if (scan.gate) late.openGate[key] = scan.gate.gate;
    }

    // An issue with a PR and no rework is a real zero; an issue with no PR is an
    // unknown. Those must not read the same, so only PR-bearing issues get an entry.
    for (const row of this.state().issues) {
      if (row.pr) late.reworkRequestedAt[String(row.number)] = [];
    }
    for (const [key, block] of Object.entries(this.#persisted.reviewBlocks)) {
      late.reworkRequestedAt[key] = block.rounds.map((r) => r.requestedAt);
    }

    const warnings: string[] = [];
    try {
      for (const pr of await listAuthoredOpenPrs(this.#cfg.repo, this.#cfg.assignee)) {
        const issue = issueFromBranch(pr.headRefName);
        if (issue !== null) late.ciRed[String(issue)] = ciNote(pr.checks) === 'CI failing';
      }
    } catch (e) {
      warnings.push(`could not read CI: ${(e as Error).message.split('\n')[0]}`);
    }

    const payload: MetricsPayload = {
      ...aggregate(runs, late),
      generatedAt: new Date().toISOString(),
      warnings,
    };
    return payload;
  }

  /**
   * The router-readiness snapshot, computed as a BACKGROUND JOB — at startup and
   * then every `metricsRefreshMs` (a day) — and persisted.
   *
   * The Dashboard never computes this on render: the same aggregation feeds the
   * Settings table and this card (one function, two renderings), but the card
   * reads the last snapshot, which costs a property lookup.
   *
   * A refresh that fails keeps the last good snapshot and stamps the failure on
   * it. The card then shows the old answer WITH its age, which is the honest
   * failure: a card that silently keeps showing an old number as if it were
   * current is worse than one that says how old it is.
   */
  async refreshMetricsSnapshot(): Promise<MetricsSnapshot> {
    try {
      // Built directly, never through the cache: this job must not serve a held
      // answer, and its own answer must not become the Settings tab's cache.
      const payload = await this.#buildMetrics();
      const snapshot: MetricsSnapshot = {
        computedAt: payload.generatedAt,
        readiness: routerReadiness(payload),
        totalRuns: payload.totalRuns,
        models: payload.models,
        minSample: payload.minSample,
        error: payload.warnings.length > 0 ? payload.warnings.join('; ') : null,
      };
      this.#persisted.metricsSnapshot = snapshot;
      // Fire-and-forget from `start()`, so it can still be computing when the
      // console is stopped — and a background job that writes the state file
      // AFTER shutdown is a write nobody is expecting, into a directory that may
      // no longer be there. Keep the answer in memory; the next start recomputes.
      if (!this.#stopped) {
        await this.#save();
        this.#changed();
      }
      return snapshot;
    } catch (e) {
      const message = (e as Error).message.split('\n')[0] ?? 'unknown error';
      const last = this.#persisted.metricsSnapshot;
      // No previous answer at all: say that, rather than invent a readiness.
      const snapshot: MetricsSnapshot = last
        ? { ...last, error: `could not refresh: ${message}` }
        : {
            computedAt: new Date().toISOString(),
            readiness: {
              ready: false,
              headline: 'Could not read the run log, so there is nothing to say about the router yet.',
              next: `The last attempt failed: ${message}`,
            },
            totalRuns: 0,
            models: [],
            minSample: MIN_SAMPLE,
            error: `could not refresh: ${message}`,
          };
      this.#persisted.metricsSnapshot = snapshot;
      if (!this.#stopped) {
        await this.#save();
        this.#changed();
      }
      return snapshot;
    }
  }

  /** The last snapshot, as it stands. Never computes — see above. */
  metricsSnapshot(): MetricsSnapshot | null {
    return this.#persisted.metricsSnapshot;
  }

  // -------------------------------------------------------- persistence

  /**
   * The actions ledger. Unparseable reads as "first run", which is the safe
   * direction: a corrupt file re-seeds and stays SILENT rather than announcing
   * the whole backlog at once.
   */
  async #loadNotify(): Promise<NotifyStore> {
    const store = structuredClone(EMPTY_NOTIFY);
    let raw: Partial<NotifyStore>;
    try {
      raw = JSON.parse(await readFile(this.#cfg.actionsFile, 'utf8')) as Partial<NotifyStore>;
    } catch {
      return store;
    }
    for (const key of Object.keys(store) as Array<keyof NotifyStore>) {
      const value = raw[key];
      if (value !== undefined) Object.assign(store, { [key]: value });
    }
    store.prefs = { ...DEFAULT_PREFS, ...store.prefs, kinds: { ...(store.prefs?.kinds ?? {}) } };
    return store;
  }

  /**
   * Atomic, for the same reason `#save` is: a reader must get the old file or
   * the new one, never a truncated one. A half-read ledger would re-announce.
   *
   * And 0600, for the same reason `push-keys.json` is. This file is not a
   * cache: it holds the push subscription's `auth` secret — endpoint plus auth
   * is enough to FORGE notifications to the operator's phone — and every action's
   * `detail`, which is the first line of a real comment on the team's work.
   * The mode goes on the TEMP file because `rename` carries the temp file's
   * inode, so a 0644 temp is a 0644 `actions.json` however it is chmodded
   * afterwards; the explicit `chmod` then also repairs a file left at 0644 by a
   * build from before this change.
   */
  async #saveNotify(): Promise<void> {
    const tmp = `${this.#cfg.actionsFile}.${process.pid}.${(saveSeq += 1)}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(this.#notifyStore, null, 2), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.#cfg.actionsFile);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  /**
   * Put the last successful poll's GitHub reading back into memory, exactly
   * where a failed poll's fallbacks would have kept it. Nothing else moves:
   * `#lastPolledAt` becomes the snapshot's own `at`, so the header stamps the
   * data's real age, and the first failed poll sets `#pollError` beside it to
   * say why the stamp has stopped moving. A file that is missing, half-written
   * or another build's shape seeds nothing — that is the pre-snapshot startup,
   * which was only ever wrong when GitHub then refused to answer.
   */
  async #seedFromSnapshot(): Promise<void> {
    const raw = await readFile(this.#cfg.githubSnapshotFile, 'utf8').catch(() => '');
    const seed = parseGithubSnapshot(raw);
    if (!seed) return;
    this.#issues = seed.issues;
    this.#openPrs = seed.openPrs;
    this.#mergedPrs = seed.mergedPrs;
    // The same join the poll makes, with the same rule: OPEN wins on a branch
    // collision.
    this.#prs = new Map([...seed.mergedPrs, ...seed.openPrs]);
    this.#blockedNotes = seed.blockedNotes;
    this.#lanes = seed.lanes;
    this.#lastPolledAt = seed.at;
  }

  /**
   * Atomic and 0600, for the same reasons `#saveNotify` is: a reader must get
   * the old snapshot or the new one, never a truncated one — `parseGithubSnapshot`
   * treats truncated as "no seed", so losing that race would cost the next
   * restart its board — and a blocked note's `body` is a real comment on the
   * team's work. A failed write is survivable: the file just goes on holding
   * the previous good poll.
   */
  async #saveSnapshot(at: string): Promise<void> {
    const tmp = `${this.#cfg.githubSnapshotFile}.${process.pid}.${(saveSeq += 1)}.tmp`;
    try {
      await writeFile(
        tmp,
        serializeGithubSnapshot({
          at,
          issues: this.#issues,
          openPrs: this.#openPrs,
          mergedPrs: this.#mergedPrs,
          blockedNotes: this.#blockedNotes,
          lanes: this.#lanes,
        }),
        { mode: 0o600 },
      );
      await chmod(tmp, 0o600);
      await rename(tmp, this.#cfg.githubSnapshotFile);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  async #load(): Promise<Persisted> {
    const state = structuredClone(EMPTY);
    let raw: Partial<Persisted>;
    try {
      raw = JSON.parse(await readFile(this.#cfg.stateFile, 'utf8')) as Partial<Persisted>;
    } catch {
      return state; // missing, empty or half-written: start from nothing
    }
    // Copied key by key rather than spread, so a key this version no longer
    // knows about is ignored instead of being loaded and written straight back
    // out. `lastEdgeReclaim` is the one that matters today: every state.json
    // written before the automatic restart was removed still has it.
    for (const key of Object.keys(state) as Array<keyof Persisted>) {
      const value = raw[key];
      if (value !== undefined) Object.assign(state, { [key]: value });
    }
    return state;
  }

  /**
   * Write the state file ATOMICALLY — temp file, then rename.
   *
   * A plain write truncates first, so anything reading state.json at that moment
   * sees an empty or half-written file. `#load` treats unparseable as EMPTY, so
   * the failure mode of losing that race is losing every running worker's row —
   * the very map that re-attaches them. A rename is a single step: a reader gets
   * the old file or the new one, never neither. (accounts.json has been written
   * this way from the start, for the same reason.)
   */
  async #save(): Promise<void> {
    // A unique temp name per write: two saves in flight at once must not share a
    // buffer and produce a file that is half of each.
    const tmp = `${this.#cfg.stateFile}.${process.pid}.${(saveSeq += 1)}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(this.#persisted, null, 2));
      await rename(tmp, this.#cfg.stateFile);
    } catch {
      // A failed save is survivable; a temp file left behind on every failed
      // save is not — the state file is written on nearly every event, so the
      // directory would fill with `state.json.4821.917.tmp`. The rename is what
      // usually fails (a full disk, a read-only mount), and it fails with the
      // temp file already written.
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  #changed(): void {
    this.emit('change');
  }
}
