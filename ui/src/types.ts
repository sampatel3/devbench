export type GateLetter = 'A' | 'B' | 'C' | 'D' | 'E';

/** Is CI green, as a field rather than a sentence. Mirrors orchestrator/src/ci.ts:
 *  `green` only when the rollup landed and nothing is outstanding; everything
 *  else that is not an outright failure is `unconfirmed`. */
export type CiState = 'green' | 'red' | 'unconfirmed';

export type GateCi = {
  state: CiState;
  rollup: string | null;
  outstanding: string[];
  passed: number | null;
  note: string;
};

export type GateFile = {
  issue: number;
  gate: GateLetter;
  stage: number | null;
  sessionId: string | null;
  stoppedAt: string | null;
  reportPath: string | null;
  summary: string;
  questions: string[];
  /** Null before Gate E when nothing was reported; never null at Gate E. */
  ci?: GateCi | null;
  /** What this gate file's `evidence` array listed and the console would not
   *  serve, as one finished line. Optional: a bundle built before the field
   *  existed is served by a console that sends it, and the other way round. */
  evidenceWarning?: string | null;
};

export type ProvisionStatus = {
  phase: 'creating' | 'preparing' | 'ready' | 'failed';
  /** Optional while an older server build is still running. */
  code?: 'ok' | 'outside' | 'exists' | 'branch-exists' | 'recovery-pending' | null;
  branch: string;
  worktreePath: string;
  port: number;
  startedAt: string;
  error: string | null;
  logTail: string[];
};

export type EvidenceItem = {
  kind: 'screenshot' | 'transcript' | 'sql' | 'report';
  path: string;
  caption: string;
  isImage: boolean;
};

export type GateHistoryRecord = {
  issue: number;
  gate: GateLetter;
  stage: number | null;
  stoppedAt: string | null;
  reportPath: string | null;
  summary: string;
  questions: string[];
  evidence: EvidenceItem[];
  /** What you asked at this gate before deciding it, and what you were told.
   *  Empty for a gate nobody asked at. */
  thread: GateThreadFileEntry[];
  decision: string | null;
  resumedAt: string | null;
  /** Which provider profile did this round. Null for rounds recorded before accounts. */
  account: string | null;
  /** Runtime identity comes from the console-owned provenance sidecar. Older
   * rounds stay null rather than being attributed by guesswork. */
  provider: AgentProvider | null;
  model: string | null;
  agentSessionId: string | null;
  /** Same line as `GateFile.evidenceWarning`, for this past round. */
  evidenceWarning?: string | null;
  /** Lines of `.gate-history.jsonl` that could not be read, filed against the
   *  round they followed — "1 unreadable round (bad gate letter 'B-postscript')".
   *  Optional for the same old-bundle reason as every other new field. */
  quarantined?: string | null;
};

/** One question you asked at a gate, and its answer once it lands. */
export type GateThreadEntry = {
  id: number;
  /** Your words, verbatim. */
  question: string;
  askedAt: string;
  answer: string | null;
  answeredAt: string | null;
  /** Set when you decided the gate before this was answered. */
  supersededAt: string | null;
};

/** The whole exchange at ONE open gate. */
export type GateThreadRecord = {
  gate: GateLetter;
  entries: GateThreadEntry[];
  /** Questions waiting for a free slot before they can even be sent. */
  pendingAskIds: number[];
  /** Set when the worker walked past a gate you were only asking about. */
  violation: string | null;
  closedAt: string | null;
  stoppedAt: string | null;
};

/** The worker's copy of the exchange, as it reaches the permanent history. */
export type GateThreadFileEntry = { id: number; q: string; a: string; at: string | null };

/**
 * What one screenshot capture run did.
 *
 * The console drives its own browser at gate C so a card arrives with the
 * pictures on it rather than a warning asking for them. `line` is a finished
 * sentence composed by the server — including for a run that captured nothing,
 * because a screenshot that is silently absent is the failure this replaced.
 */
export type CaptureReport = {
  at: string;
  line: string;
  ok: boolean;
  /** `<stepId>/<leg>` for every capture written and filed. */
  wrote: string[];
  /** Steps whose before and after are the same bytes — a pair that proves
   *  nothing, and the thing you spotted yourself. */
  identical: number[];
  /** Everything refused, skipped or failed, one line each. */
  notes: string[];
};

/**
 * One step of the click-script. Before and after are ONE step — never a step for
 * the before and another for the after.
 */
export type ManualQaStep = {
  /** 1-based and never renumbered: your ticks are keyed on it. */
  id: number;
  /** Bumped by exactly 1 each time this step is sent back and fixed. A tick set
   *  against an older revision does not carry to the new one. */
  rev: number;
  do: string;
  /** A deep link, or null when there was none we would link to. */
  url: string | null;
  /** The app path this step is on — `/quotes/1234`. `url` is what you click;
   *  this is what the console drives to when it takes the screenshots itself.
   *  Absent on an older server and on any step with no screen: either way the
   *  step is not drivable and its captures stay the worker's. */
  route?: string | null;
  /** What it did before this change. Null WITH a null `beforeShot` means the
   *  behaviour is new and there is nothing to compare. */
  before: string | null;
  beforeShot: string | null;
  after: string | null;
  afterShot: string | null;
  /** rev > 1 only: what the fix changed. */
  fix: string | null;
  /** A fingerprint of the BYTES behind the two captures, stamped by the console
   *  when it scanned the worktree. Rounds reuse filenames, so this is the only
   *  thing that can tell a re-captured picture from the one you ticked. */
  shotStamp: string | null;
  /** Which of the captures this step DECLARED are not files in the worktree,
   *  stamped by the same scan. A path with no file behind it is the same failure
   *  as no path at all — the evidence cannot be seen — and it used to reach the
   *  card as the browser's own broken-image icon with nothing said. Absent reads
   *  as `[]`: the console must not accuse on a file it never looked for. */
  goneShots?: Array<'before' | 'after'>;
};

/**
 * The click-script for your own QA: where the app is, what to sign in as, and
 * what to do. Only localhost URLs are ever linked — see manual-qa.ts.
 */
export type ManualQa = {
  appUrl: string | null;
  login: { email: string; password: string } | null;
  /** The state you start from. */
  start: string | null;
  steps: ManualQaStep[];
  /** How many entries the console could not read as a step. A dropped step is
   *  invisible, so this is the only thing that stops the gate passing on a
   *  fraction of its own QA. Non-zero locks Approve. */
  dropped: number;
  /** Legacy only — v2 workers write steps, because only a step can be ticked. */
  edgeCases: string[];
};

/** One option in a quiz question, with the reasoning shown after you submit. */
export type QuizOption = { text: string; why: string };

export type QuizQuestion = {
  /** Everything you need to answer, terms defined inline. May be empty. */
  context: string;
  question: string;
  options: QuizOption[];
  /** Index into `options`. The key ships to the page: grading is local and
   *  instant, and the score has no authority over the gate. */
  correct: number;
};

/** The comprehension half of gate C: what was done, then the questions. */
export type Quiz = {
  brief: string[];
  questions: QuizQuestion[];
  /** How many questions the console had to void. A voided question is invisible,
   *  so a 2/2 on a three-question quiz would otherwise read as a pass. Non-zero
   *  locks Approve. */
  dropped: number;
};

export type QaVerdictStatus = 'verified' | 'failed' | 'cleared';

/** Your own tick on one QA step. Console-owned — no worker can write one. */
export type QaVerdict = {
  stepId: number;
  rev: number;
  /** A hash of the step as it was when you ticked it. Any change resets the
   *  tick to unset, which is the only safe direction. */
  hash: string;
  status: QaVerdictStatus;
  note: string | null;
  at: string;
  /** The capture you were looking at when you failed it, kept reachable after
   *  the worker writes a new one. */
  shotAtFail: string | null;
};

export type QaStepState = 'unset' | 'verified' | 'failed';

/**
 * One step's tick, already resolved by the console. Render from this — the join
 * between a verdict and a step is a content hash, and re-deriving it here is a
 * second way to show a green tick against a step you never read.
 */
export type QaStepView = {
  id: number;
  rev: number;
  state: QaStepState;
  /** Your words, on a failed step. */
  note: string | null;
  at: string | null;
  shotAtFail: string | null;
  /** This step is NOT in the gate file the worker last wrote — what you are
   *  looking at is the console's own copy of it, kept so a rework cannot shrink
   *  the QA that Approve counts. */
  missing: boolean;
};

/** The counts behind the Approve button — the QA half of the lock. */
export type QaProgress = {
  total: number;
  verified: number;
  failed: number;
  unset: number;
  /** Every step ticked verified, and at least one step to tick. */
  complete: boolean;
};

/** One dispatched targeted rework: which steps went back, and what came back. */
export type QaReworkEntry = {
  stepIds: number[];
  notes: Record<string, string>;
  sentAt: string;
  /** `cancelled` means a later message of yours replaced it before it ever left
   *  the console — nothing was sent, and your ticks are untouched. */
  status: 'queued' | 'sent' | 'returned' | 'cancelled';
  /** Set when the returned gate file dropped something it was told to carry.
   *  The card shows the console's own copy either way. */
  violation: string | null;
  /** Evidence paths the console put back from its own snapshot. */
  restored: string[];
};

/**
 * A gate decision you took back. Not a code rewind — the worker is sent back to
 * the stage that gate governs with your correction, and the original round stays
 * exactly as it was recorded.
 */
export type GateReopening = {
  gate: GateLetter;
  /** Which recorded round of that gate this reopens — 1-based; 0 when the gate
   *  was passed before there was a recorded exchange to point at. */
  round: number;
  /** Your correction, verbatim. */
  message: string;
  /** The stage the worker was sent back to. */
  stage: number;
  at: string;
};

export type WorktreePlan = {
  issue: number;
  title: string;
  branch: string;
  worktreePath: string;
  port: number;
  commands: string[];
};

export type ContinuationPlan = {
  issue: number;
  title: string;
  branch: string;
  worktreePath: string;
  port: number | null;
  head: string;
  mode: 'restore' | 'use-existing';
  commands: string[];
};

/** Mirrors `orchestrator/src/addressee.ts`. */
export type Addressee = {
  handle: string;
  known: boolean;
  why: string;
};

export type CommentRequest = {
  issue: number;
  kind?: 'decision' | 'handoff';
  target?: { kind: 'issue' | 'pr'; number: number };
  addressee: string;
  /** Who this actually reaches, resolved on the row against the issue author. */
  to?: Addressee;
  /** True only when posting deliberately parks the worker until somebody replies. */
  blocks: boolean;
  why: string;
  context?: string;
  question?: string;
  draftBody: string;
  sessionId: string | null;
  requestedAt: string | null;
};

export type CommentBlock = {
  addressee: string;
  /** Exact GitHub surface for blocks written by target-aware builds. */
  onTarget?: { kind: 'issue' | 'pr'; number: number };
  /** Mirrors `orchestrator/src/types.ts`. The ticket the comment actually went
   *  on, which is not always this row — absent on blocks written before the
   *  cross-issue case was handled, and those meant the row's own number. */
  onIssue?: number;
  postedAt: string;
  commentUrl: string | null;
  reply: { author: string; createdAt: string; body: string } | null;
};

/** 'operator' = the operator started the rework here; 'superseded' = the reviewer
 *  moved on or asked again; 'external' = the rework was pushed outside the
 *  console.
 *
 *  The first literal is a legacy wire value: it is written into state files on
 *  disk and mirrored in `orchestrator/src/review.ts`, so renaming it is a
 *  migration rather than an edit. */
export type ResolvedBy = 'operator' | 'superseded' | 'external';

export type ReviewRound = {
  round: number;
  reviewer: string;
  requestedAt: string;
  requestedChanges: string;
  decision: string | null;
  resumedAt: string | null;
  account?: string | null;
  /** Absent = the round is still waiting on you. */
  resolvedBy?: ResolvedBy | null;
  resolvedAt?: string | null;
  resolution?: string | null;
};

export type SummaryWindow = 'daily' | 'weekly' | 'monthly';

/** The status post for one window: the text to paste, what it is a post of, and
 *  anything the console could not read while building it. */
export type Summary = {
  markdown: string;
  generatedAt: string;
  window: SummaryWindow;
  sections: Array<{ heading: string; items: string[] }>;
  warnings: string[];
};

export type AgentProvider = 'claude' | 'codex';

export type AccountSummary = {
  name: string;
  provider: AgentProvider;
  configDir: string;
  isDefault: boolean;
  /** This account's default model, or null for the console's. */
  model: string | null;
};

/** The definitive answer to "will a worker on this account sign in?", from one
 *  provider-specific probe on a click. Distinct from `loggedIn`, which is a file hint. */
export type LoginProbe = {
  account: string;
  /** Present on provider-aware backends; omitted by older saved probe payloads. */
  provider?: AgentProvider;
  verdict: 'signed-in' | 'not-signed-in' | 'unknown';
  detail: string;
  loginCommand: string;
  checkedAt: string;
};

/** The account doctor's report: booleans about a config dir, never a credential —
 *  plus the last login probe, when one has been asked for. */
export type AccountHealth = AccountSummary & {
  /** Whether this is the provider's conventional ~/.claude or ~/.codex home. */
  isCanonicalConfigDir?: boolean;
  configDirExists: boolean;
  loggedIn: boolean | 'unknown';
  skillsLinked: boolean;
  /** Provider-specific instruction file and link health. Legacy payloads expose only claudeMdLinked. */
  instructionsFile?: 'CLAUDE.md' | 'AGENTS.md';
  instructionsLinked?: boolean;
  claudeMdLinked: boolean;
  /** Codex's worker write-fence hooks.json; null/absent for Claude and older payloads. */
  hooksValid?: boolean | null;
  loginCommand: string;
  probe: LoginProbe | null;
};

/** A model the pickers offer, with the line that says when to pick it. */
export type ModelOption = { provider: AgentProvider; id: string; label: string; when: string };

/** A figure and the number of runs behind it. Never shown without its n. */
export type Measure = { n: number; value: number };

export type MetricsCell = {
  provider: AgentProvider;
  model: string;
  /** Exact profiles and provider conversation IDs represented in this cell. */
  accounts: string[];
  sessions: string[];
  segment: string;
  runs: number;
  medianDurationMs: number | null;
  medianOutputTokens: number | null;
  medianReasoningOutputTokens: number | null;
  medianCostUsd: number | null;
  medianFilesChanged: number | null;
  firstTimeApproval: Measure | null;
  gateFeedback: Measure | null;
  rework: Measure | null;
  ciRed: Measure | null;
  enough: boolean;
};

export type Metrics = {
  cells: MetricsCell[];
  models: string[];
  segments: string[];
  totalRuns: number;
  minSample: number;
  enough: boolean;
  /** The line the page must print when it cannot support a conclusion. */
  caveat: string | null;
  generatedAt: string;
  warnings: string[];
};

export type ReviewBlock = { pr: number; rounds: ReviewRound[] };

/** What is actually running on this machine, from GET /api/instances. */
export type InstanceReport = {
  containers: Array<{ name: string; bytes: number | null; label: string; isEdgeRuntime: boolean }>;
  devServers: Array<{
    issue: number | null;
    worktree: string | null;
    port: number;
    pid: number | null;
    cwd: string | null;
    bytes: number | null;
    label: string;
    /** False when the attribution rule refuses it — `reason` says why. */
    stoppable: boolean;
    reason: string;
  }>;
  workers: Array<{ issue: number; pid: number; bytes: number | null; label: string }>;
  totals: {
    containerBytes: number | null;
    containerLabel: string;
    devServerBytes: number | null;
    devServerLabel: string;
    workerBytes: number | null;
    workerLabel: string;
  };
  freePct: number | null;
  /** Anything the console could not read, said out loud rather than left empty. */
  notes: string[];
  checkedAt: string;
};

/** The last edge-runtime restart ATTEMPT. Always the button — nothing restarts
 *  it automatically. */
export type EdgeReclaim = {
  at: string;
  grewTo: string;
  freePctBefore: number | null;
  /** False when the restart did not come back — shown, not swallowed. */
  ok: boolean;
  error: string | null;
};

/** The background job's answer to "can I decide about the router yet?". */
export type MetricsSnapshot = {
  computedAt: string;
  readiness: { ready: boolean; headline: string; next: string | null };
  totalRuns: number;
  models: string[];
  minSample: number;
  /** Set when the last refresh failed — the figures are then the last good ones. */
  error: string | null;
};

/** A dev server the console stopped, and why. */
export type DevServerStop = { at: string; port: number; pid: number | null; why: string };

export type WorkerStatus =
  | 'no-worker'
  | 'preparing'
  | 'queued'
  | 'awaiting-post'
  | 'blocked'
  | 'reply-received'
  | 'rework'
  | 'active'
  /** Frozen with SIGSTOP to give the machine its memory back. Nothing is lost,
   *  it holds its slot, and one click puts it straight back. */
  | 'paused'
  | 'at-gate'
  | 'detached'
  | 'pr-open'
  /** Its PR merged. Not orange: a calm state with an action available. */
  | 'pr-merged'
  /** The ISSUE is closed on GitHub — QA signed it off. The end of the line, and
   *  the one state with nothing left to ask for. */
  | 'done'
  | 'checkpoint'
  /** The console could not read GitHub's PR lists this poll and had no previous
   *  map to fall back on, so this row cannot say where its PR stands. It says
   *  that instead of guessing. Transient: the next good poll replaces it. */
  | 'unreadable'
  | 'failed';

/** A worker frozen with SIGSTOP, and who froze it — a pause you asked for and a
 *  pause the memory floor took must never read the same. */
export type PausedStamp = { at: string; by: 'you' | 'floor'; reason: string };

/**
 * Set aside by YOU, on purpose. Mirrors `orchestrator/src/types.ts`.
 *
 * Called PARKED and not "paused" because "paused" already means two automatic
 * brakes on a machine: `PausedStamp` above is a worker frozen with SIGSTOP by
 * the memory floor, and the actions feed's `paused` is the GitHub quota brake.
 * Parking is a decision about a TICKET, and it signals nothing.
 */
export type ParkedStamp = {
  at: string;
  /** Why, in your own words. Null when you did not say — which is fine. */
  reason: string | null;
};

/** One worker's process tree, as the watcher measured it this tick. */
export type WatchWorker = {
  issue: number;
  pid: number;
  /** processes in the tree — the fan-out, made visible */
  procCount: number;
  treeBytes: number;
  /** how many of them are actually in state T — a pause verified, not assumed */
  stoppedProcs: number;
  /** the biggest this tree has been this run */
  peakTreeBytes: number | null;
  paused: PausedStamp | null;
  lastTool: string | null;
};

export type WatchLevel = 'ok' | 'hold' | 'warn' | 'pause-largest' | 'floor';

/**
 * The live measurement — at most one tick old (5 s while workers run), unlike
 * `resources`, whose machine read can be two minutes stale and was on the night the
 * machine crashed while the dashboard reported headroom.
 */
export type WatchReport = {
  sample: { at: string; freePct: number | null; headroomBytes: number | null };
  level: WatchLevel;
  forecast: { sentence: string; comfortable: boolean; projectedHeadroomBytes: number | null };
  workers: WatchWorker[];
  /** The per-worker spike the forecast models — WORKER_HEADROOM_GB. */
  spikeBytes: number;
  /** Whether the floor pauses everything on its own at floorFreePct. */
  autoPauseFloor: boolean;
  thresholds: { minFreePct: number; warnFreePct: number; pauseFreePct: number; floorFreePct: number };
  intervalMs: number;
  totalBytes: number;
};

export type IssueRow = {
  number: number;
  title: string;
  url: string;
  labels: string[];
  updatedAt: string;
  /** Who FILED the issue — not who it is assigned to. Empty when unknown. */
  author: string;
  /** The issue this was spun off from, when its body says so. */
  spunOffFrom?: number | null;
  /**
   * Why there is no open issue behind this row. Set only where the console built
   * the row from a worktree instead of an issue, and null on every ordinary one.
   * See `OrphanIssue` in the orchestrator's types: one placeholder sentence used
   * to cover a close, a reassignment and a paging drop alike.
   */
  orphan?: {
    reason: 'closed' | 'not-yours' | 'still-open' | 'unread';
    closedAt: string | null;
    assignees: string[];
  } | null;
  /**
   * What QA had said when the console first saw this issue closed.
   *
   * OPTIONAL, like every field the server may not send: a rebuilt `ui/dist` in
   * front of a console that has not restarted sends none of this, and a closed
   * row must then read exactly as it did before rather than claiming nobody
   * verified it. Absent and null are the same thing here — "never established" —
   * and `verdict: 'none'` is the different, louder one: the console looked at
   * the comments and found no verdict at all.
   *
   * `line` is the server's finished sentence. The page renders it and never
   * re-words it, the same rule `captureReport.line` keeps.
   */
  closeVerdict?: {
    closedAt: string | null;
    verdict: 'pass' | 'fail' | 'partial' | 'none';
    by: string | null;
    at: string;
    line: string;
  } | null;
  /** The project board column this card is in, e.g. `In review`. Null when the
   *  issue is on no board or the poll has not run yet. */
  lane?: string | null;
  /**
   * You filed it: raised from this machine, by you or by a worker, and then
   * auto-assigned back to you by the repo's workflow. Separate from
   * `needs-triage`, which is the question of whether anybody has agreed it is
   * worth doing.
   */
  selfFiled: boolean;

  /**
   * Post-UAT, a human tested the shipped work and sent it back.
   *
   * The server stamps this off ONE predicate (`orchestrator/src/uat.ts`): a real
   * person, not this console's own account, posting the QA template on the ISSUE
   * after the work merged. The page never re-derives it and must never key off a
   * label — `changes-requested` is the pre-merge review bot's and lands on every
   * feature PR, and `human-review-needed` is never cleaned up at all.
   *
   * Null = nothing has been sent back.
   */
  uatFail: {
    /** The human who gave the verdict — never a bot login. */
    by: string;
    at: string;
    verdict: 'Fail' | 'Partial Pass' | 'Pass';
    /** Deep link to the verdict comment itself. */
    url: string;
    /**
     * A fix is already moving for it — a PR opened or pushed to since the
     * verdict. It reads quieter for that, never absent: leaving the in-flight
     * case out of the row is what made #4914 say `stage 9 post-merge` with no
     * sign anywhere that QA had failed it.
     *
     * OPTIONAL for the same reason `parked` is: a rebuilt `ui/dist` can be
     * talking to a server that has not restarted yet.
     */
    inflight?: boolean;
  } | null;

  /**
   * You set this one aside. Null — or absent — means you did not.
   *
   * OPTIONAL for the same reason `uatFail` is guarded with `!= null`: a rebuilt
   * `ui/dist` can be talking to a server that has not restarted yet and sends
   * rows with no `parked` field at all. Absent must read as "not parked", never
   * as a crash and never as a whole board going quiet at once.
   *
   * A separate axis from `status`, deliberately: a parked ticket KEEPS its
   * gate, so the status chip beside this goes on saying `AT GATE C`.
   */
  parked?: ParkedStamp | null;

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
  gateReport: string | null;
  gateEvidence: EvidenceItem[];
  /**
   * A supercharged run — the console passing gates A, B and C on the operator's
   * standing instruction, stopping at D.
   *
   * OPTIONAL for the same reason `parked` is: a `ui/dist` built before this
   * field existed is served by a console that sends it, and an older page must
   * read its absence as "not supercharged" rather than throwing.
   */
  supercharge?: {
    on: boolean;
    autoRounds: number;
    stopped: string | null;
  } | null;
  /** The structured click-script for your own QA at this gate. Null when the
   *  worker wrote none. */
  gateManualQa: ManualQa | null;
  /** The comprehension quiz at gate C. Null when the worker wrote none — which
   *  locks the gate rather than passing a half nobody was offered. */
  gateQuiz: Quiz | null;
  /** Your ticks on the QA steps. Append-only; the newest matching one counts. */
  qaVerdicts: QaVerdict[];
  /** Those ticks resolved against the steps on the card right now, in order. */
  qaSteps: QaStepView[];
  /** The QA half of the Approve lock. Gate C still needs the quiz submitted too. */
  qaProgress: QaProgress;
  /** The most recent targeted rework, or null when none has been sent. */
  qaRework: QaReworkEntry | null;
  /** What the last screenshot capture did, or null when none has run. Absent on
   *  an older server — a fresh bundle talks to whatever is serving it. */
  captureReport?: CaptureReport | null;
  /** Questions asked at this gate, and the answers, with the gate still open. */
  gateThread: GateThreadRecord | null;
  history: GateHistoryRecord[];
  /** Gates you have reopened, oldest first. Shown inline in that gate's history. */
  reopenings: GateReopening[];
  commentRequest: CommentRequest | null;
  /** Spin-offs filed from this row by the console — parent and child, linked. */
  spinOffs?: Array<{ number: number; title: string; url: string; at: string }>;
  /** A related issue decision the worker drafted rather than acted on.
   *  `fileUrl` is GitHub's own new-issue form, prefilled. */
  issueRequest?: {
    fromIssue: number | null;
    title: string;
    body: string;
    labels: string[];
    boardLane: string | null;
    /** Optional while an older server build is still running. */
    identifiedHow?: string;
    relationship?: string;
    recommendation?: 'fold' | 'separate' | null;
    recommendationWhy?: string;
    why: string;
    fileUrl: string;
  } | null;
  /** A board move the worker DRAFTED rather than made. */
  boardRequest?: {
    issue: number;
    lane: string;
    currentLane: string | null;
    why: string;
    boardUrl: string;
    /** Set once the console moved this card itself — mirrors orchestrator board.ts.
     *  Present means it already happened; the card reads in the past tense. */
    applied?: { from: string; to: string; at: string; why: string } | null;
  } | null;
  commentBlock: CommentBlock | null;
  reviewBlock: ReviewBlock | null;
  reviewHistory: ReviewRound[];
  sessionId: string | null;
  resumeCommand: string | null;
  /** Runtime stamped on this issue. Older live servers may omit it until restart. */
  provider: AgentProvider;
  /** The provider account this issue runs under; null = never stamped (the default). */
  account: string | null;
  /** A session exists, so neither the account nor the model can change without a
   *  restart-fresh. */
  accountLocked: boolean;
  /** The model stamped on this issue; null = never stamped (it resolves). */
  model: string | null;
  /** What the precedence chain resolves to — the model the next run will use. */
  modelResolved: string;
  /** What to type if this worker says it is not logged in. */
  loginCommand: string;
  status: WorkerStatus;
  statusDetail: string;
  queuePosition: number | null;
  /** When it entered the queue. Null on entries queued before this shipped. */
  queuedAt?: string | null;
  pr: {
    number: number;
    url: string;
    state: string;
    title: string;
    isDraft: boolean;
    /** When it merged, for a PR that has. */
    mergedAt?: string | null;
    /** Set when this row's fix was folded into ANOTHER issue's PR — the rail
     *  marks it so no card claims someone else's PR as this issue's own work.
     *  Mirrors `inheritPr` in `orchestrator/src/status.ts`. */
    inherited?: boolean;
    /** The pre-merge checklist from the PR body: what is ticked and what is not.
     *  Workers write these and nothing watched them until the operator asked how
     *  they were supposed to know what they were waiting on. */
    checklist?: { total: number; done: number; outstanding: string[] } | null;
  } | null;
  /** Whether this PR can actually be handed to a codeowner, read off GitHub.
   *  Null when there is no PR. Gate E must not present as ready without it. */
  handover?: { ready: boolean; why: string } | null;
  /** You answered a review round; the reviewer has not cleared it. Null when
   *  nothing was sent back, the reviewer moved on, or GitHub could not be read. */
  reviewOutstanding?: { reviewer: string; why: string; sentAt: string | null } | null;
  /** Mirrors `orchestrator/src/question.ts`. */
  openQuestion?: { askedAt: string; firstLine: string; url: string } | null;
  /** Mirrors `orchestrator/src/waiting.ts`. Finished strings — compose nothing here. */
  waiting?: {
    on: string | null;
    /** A review that cannot block the merge — named so you do not chase it. */
    note: string | null;
    /**
     * Each follow-up, and — when the console can make the repair itself — the
     * repair, rendered as a button beside it.
     *
     * `fix` is OPTIONAL and read defensively, for the reason this file already
     * gives about `parked`: a `ui/dist` older than the server that feeds it
     * must show the sentence and the link exactly as it did before, never throw.
     */
    yours: Array<{
      text: string;
      detail: string | null;
      url: string | null;
      fix?: { kind: "pr-ready"; pr: number } | null;
    }>;
  } | null;
  live: {
    startedAt: string;
    turns: number;
    lastText: string | null;
    lastTool: string | null;
    /** WHAT that tool was asked to do, truncated — the answer to "what is it
     *  doing right now" that a bare tool name never was. */
    lastToolCommand: string | null;
    /** When the stream says the call was made, so the card can say how long it
     *  has been running. */
    lastToolAt: string | null;
    /** Its result has not come back: that command is still running. */
    toolRunning: boolean;
    /** Picked back up after a console restart — not a fresh start. */
    reattached: boolean;
  } | null;
  /** Set while this worker is frozen. It has given its SLOT back — you can start
   *  another issue — and still holds its memory; one click resumes it and
   *  nothing about the work is lost. */
  paused: PausedStamp | null;
  lastError: string | null;
  lastActivityAt: string | null;
  provision: ProvisionStatus | null;
  /** The last time this worktree's dev server was stopped by the console. */
  devServerStop: DevServerStop | null;
};

/* ------------------------------------------------------- actions on you */

/**
 * 1 = fix first. 2 = needs a response from you. 3 = FYI.
 *
 * The server stamps this. The page NEVER computes it from the kind: there is one
 * place that decides what outranks what, and it is not the browser.
 */
export type ActionTier = 1 | 2 | 3;

/** One thing on GitHub that is on you. Mirrors `orchestrator/src/actions.ts`. */
export type Action = {
  /** Built from GitHub's own ids, so it survives a restart and never re-fires. */
  id: string;
  /** Open-ended on purpose: a kind this build has never heard of still renders. */
  kind: string;
  tier: ActionTier;
  subject: { type: 'issue' | 'pr'; number: number; title: string; url: string };
  /** Who did it. Empty when GitHub gives no author. */
  actor: string;
  eventAt: string;
  /** Plain English: why this is on you. */
  reason: string;
  /** First line of the body, trimmed. Never the whole thing. */
  detail: string | null;
  /** Where the click goes on GitHub — the comment anchor when there is one. */
  url: string;
  /** The console row that owns this, when one exists. */
  consoleIssue: number | null;
  verdict?: 'Fail' | 'Partial Pass' | 'Pass';
};

export type ActionsFeed = {
  actions: Action[];
  /** When these were READ from GitHub. Never the time of a failed attempt. */
  fetchedAt: string | null;
  /** The last read failed; the rows below are the previous good one. */
  stale: boolean;
  error: string | null;
  seenAt: string | null;
  quota: { remaining: number; limit: number; resetAt: string } | null;
  /** Set while the quota brake is holding off automatic reads. */
  paused: string | null;
  /** Set when the phone subscription has expired and pushes go nowhere. */
  pushProblem: string | null;
  /** Set when GitHub gave back a shorter list than it holds. A short list must
   *  never render as a whole one — the wording is in `banner`. */
  truncated: string | null;
  /** The honest-degradation line, already worded by the server. */
  banner: string | null;
};

/**
 * One row of the log of what has been announced.
 *
 * Mirrors `LogEntry` in `orchestrator/src/notify.ts`. Everything but `kind` and
 * `at` is nullable, and the page draws it that way: entries recorded before the
 * log kept any detail degrade to a kind and a time rather than crashing a tab.
 */
export type LogEntry = {
  id: string;
  kind: string;
  tier: ActionTier;
  /** When it was announced — or first seen, when it never was. */
  at: string;
  /** Recorded by the first-run seed: seen at first read, never announced. */
  seeded: boolean;
  read: boolean;
  subject: { type: 'issue' | 'pr'; number: number; title: string; url: string } | null;
  actor: string | null;
  reason: string | null;
};

/** Per kind: push it to the phone, show it in the feed only, or nothing. */
export type KindSwitch = 'push' | 'feed' | 'off';

export type NotifyPrefs = {
  /** Master. `NOTIFY=0` in the environment forces this false and it cannot be
   *  turned back on from the page. */
  enabled: boolean;
  /** In-app toasts and the count in the header. */
  inApp: boolean;
  /** Web Push to the phone. Off until a phone has actually subscribed. */
  phone: boolean;
  /** How much a push may say. `numbers` = kind + issue number, nothing else. */
  detail: 'numbers' | 'none';
  /** Overrides per kind; anything absent uses that kind's own default. */
  kinds: Record<string, KindSwitch>;
};

export type WorkSourceId = 'github' | 'linear' | 'sentry';

export type WorkItem = {
  source: WorkSourceId;
  id: string;
  key: string;
  title: string;
  url: string;
  status: string;
  updatedAt: string;
  labels: string[];
  priority: string | null;
  repository: string | null;
  project: string | null;
  number: number | null;
};

export type WorkSourceStatus = {
  id: WorkSourceId;
  name: string;
  connected: boolean;
  account: string | null;
  detail: string;
  error: string | null;
  itemCount: number;
  connectCommand: string | null;
  managedBy: 'gh' | 'file' | 'environment' | null;
  /** Sentry only: who "assign to me" resolves to. Optional — an older page must
   *  read its absence as "nobody set" rather than throwing. */
  assignAs?: string | null;
};

export type WorkSourcesSnapshot = {
  sources: WorkSourceStatus[];
  items: WorkItem[];
  refreshedAt: string;
};

/**
 * THE AUDIT — every open issue read against what its status claims, mirrored
 * from `orchestrator/src/audit.ts`. Every string arrives finished; the page
 * composes nothing.
 */
export type AuditFinding = {
  key: string;
  /** stuck: nothing moves this without somebody noticing. slow: moving, but
   *  held past the median of the leg it is in. */
  level: 'stuck' | 'slow';
  text: string;
};

export type IssueAudit = {
  issue: number;
  title: string;
  status: WorkerStatus;
  statusDetail: string;
  verdict: 'stuck' | 'slow' | 'ok';
  findings: AuditFinding[];
  /** How long in the current phase against the pack, or null when no phase
   *  has honestly begun. */
  phase: string | null;
};

export type AuditReport = {
  at: string;
  /** Stuck first, then slow, then on pace; longest-held first inside each. */
  issues: IssueAudit[];
  stuck: number;
  slow: number;
  ok: number;
  /** Rows you parked — named, never judged. */
  parked: number[];
};

export type ConsoleState = {
  issues: IssueRow[];
  accounts: AccountSummary[];
  defaultAccount: string;
  /** Provider-qualified models — known ones plus any custom id in force. */
  models: ModelOption[];
  /** Each runtime has its own model namespace and fallback. */
  defaultsByProvider?: Partial<Record<AgentProvider, string>>;
  /** Legacy Claude fallback, accepted while an older backend is still live. */
  defaultModel?: string;
  queue: number[];
  maxActive: number;
  /** Workers holding a SLOT. A paused one is not counted — it gave the slot back. */
  activeCount: number;
  /** How long one command may run before the card says so loudly. */
  longToolMs: number;
  resources: {
    ok: boolean;
    reason: string;
    freePct: number | null;
    headroomLabel: string;
    minFreePct: number;
    footprintLabel: string;
    ceilingLabel: string;
    edgeRuntimeLabel: string | null;
    /** How full swap is — the second memory signal. Null when the sysctl could
     *  not be read, which is said out loud rather than shown as a healthy 0. */
    swapUsedPct: number | null;
    /** "8.4 GB of 16.0 GB (92%)", or "swap unreadable". */
    swapLabel: string;
    /** The swap ceiling that holds dispatch. Hold only — never a pause or kill. */
    maxSwapPct: number;
    checkedAt: string;
  } | null;
  /** The watcher's answer — fresh, per-worker, and forward-looking. Null until
   *  the first tick. */
  watch: WatchReport | null;
  /** The last edge-runtime restart you asked for, and how it went. */
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
  workspaces?: string[];
  repoPath: string;
  pollError: string | null;
  /** A read that worked, but not the way it usually does — the merged-PR list
   *  answering off REST after GraphQL refused it. Optional for the same reason
   *  `workspaces` is — a rebuilt bundle can be talking to a server that has not
   *  restarted. */
  pollNote?: string | null;
  /** Whether to say that in the warning register. A whole fallback read is a
   *  fact and renders quiet; a SHORT one is a warning, because rows below it
   *  have gone to "cannot say where its PR stands". Absent on an older server,
   *  which reads as quiet — the register it had for every note it could send. */
  pollNoteWarn?: boolean;
  /** When GitHub was last read, or null before the first poll finished. Shown
   *  beside Refresh — 15-minute-old data must never look live. */
  lastPolledAt: string | null;
  /** How often that happens, so the UI says the real cadence. */
  pollMs: number;
  /** Everything on GitHub that needs you. It rides the SSE the page already
   *  listens on — there is no second endpoint and the browser never polls. */
  actions: ActionsFeed;
  /** The notification switches, so Settings edits real state rather than asking
   *  you to edit an environment variable. */
  notify: NotifyPrefs;
  /** How many phones are registered for push. `readReadiness()` can only tell
   *  you about THIS browser; anything else on the tailnet can register too, and
   *  this count is the only place that shows up. */
  pushDevices: number;
  /** Unread notifications, for the bell's badge. Optional for the same reason
   *  the feed is: a freshly built page routinely talks to a console that has not
   *  restarted yet, and a badge is not worth a white screen. */
  unreadNotifications?: number;
  /** The last audit run — null until one is, optional because a fresh bundle
   *  routinely talks to a server that has not restarted. */
  audit?: AuditReport | null;
  updatedAt: string;
};
