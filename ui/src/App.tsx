import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Markdown, splitSections } from './markdown';
import { SentryPanel } from './sentry-panel';
import { SummaryChart } from './summary-chart';
import { CycleAverages, IssueCycleLine } from './cycle-view';
import {
  approveCPrompt,
  approvePrompt,
  askForMissingShotsPrompt,
  askForQuizPrompt,
  askForScriptPrompt,
  askForShotsPrompt,
  feedbackCPrompt,
  feedbackPrompt,
  type GateCRecord,
} from './gate';
import {
  acceptedLine,
  approveLockC,
  gateWarnings,
  missingShots,
  parseGateSummary,
  toAccept,
  type GateWarning,
} from './gate-c';
import {
  allAnswered,
  answeredCount,
  loadProgress,
  quizKey,
  quizRecord,
  saveProgress,
  scoreOf,
  verdictOf,
  withPick,
  withSubmit,
  type QuizProgress,
} from './quiz';
import {
  ORANGE,
  waitingOnYou,
  bandLabel,
  isClosedIssue,
  isParked,
  isPriorityLabel,
  isTriageLabel,
  isUatFail,
  needsTriage,
  priorityOf,
  selfFiledNeedsTriage,
  sortIssues,
} from './priority';
import { chipClass, edgeClass } from './look';
import { matchesQuery } from './search';
import {
  PUSHES_ALONE,
  SWITCHABLE,
  SWITCH_LABEL,
  TIER_SUB,
  TIER_TITLE,
  actionCount,
  byTier,
  feedOf,
  fixFirstCount,
  fixFirstLine,
  kindLabel,
  plainDetail,
  prefsOf,
  pushDeviceNote,
  quotaNote,
  since,
  switchOf,
} from './actions';
import { blockedReason, disablePush, enablePush, pushSupported, readReadiness, type PushReadiness } from './push';
import type {
  AccountHealth,
  AccountSummary,
  Action,
  ActionTier,
  AgentProvider,
  AuditReport,
  ConsoleState,
  ContinuationPlan,
  EvidenceItem,
  GateCi,
  GateHistoryRecord,
  GateLetter,
  GateReopening,
  GateThreadRecord,
  InstanceReport,
  IssueRow,
  KindSwitch,
  LogEntry,
  ManualQaStep,
  Measure,
  NotifyPrefs,
  Metrics,
  MetricsSnapshot,
  ModelOption,
  QaStepView,
  QaVerdict,
  Quiz,
  ReviewRound,
  Summary,
  SummaryWindow,
  WatchReport,
  WorkItem,
  WorkSourcesSnapshot,
  WorkerStatus,
  WorktreePlan,
} from './types';

/** The nine stages of issue-pipeline, with the gate that closes each one. */
const STAGES: Array<{ n: number; label: string; gate?: GateLetter }> = [
  { n: 0, label: 'Preflight' },
  { n: 1, label: 'Scope', gate: 'A' },
  { n: 2, label: 'Plan', gate: 'B' },
  { n: 3, label: 'Build' },
  { n: 4, label: 'Validate' },
  { n: 5, label: 'Understanding', gate: 'C' },
  { n: 6, label: 'Pre-PR', gate: 'D' },
  { n: 7, label: 'PR & review' },
  { n: 8, label: 'Merge', gate: 'E' },
  { n: 9, label: 'Post-merge' },
];

const CHIP_LABEL: Record<WorkerStatus, string> = {
  'no-worker': 'no worker',
  preparing: 'preparing',
  queued: 'queued',
  'awaiting-post': 'draft to post',
  blocked: 'blocked',
  'reply-received': 'reply received',
  rework: 'rework requested',
  active: 'active',
  paused: 'paused',
  'at-gate': 'AT GATE',
  detached: 'detached',
  'pr-open': 'PR open',
  'pr-merged': 'merged',
  done: 'closed',
  checkpoint: 'checkpoint',
  // Pairs with the "GitHub read HH:MM" stamp in the header, which is the other
  // half of the same fact: the stamp has stopped moving, and this is the row it
  // stopped moving on.
  unreadable: 'GitHub unread',
  failed: 'failed',
};

/**
 * The ONE triage signal, wherever the issue is named: the band triage put it in,
 * or "needs triage" in a dashed outline when it has not been ranked. Unranked is
 * NOT quietly filed as P2 — "nobody has ranked this" is a different fact from
 * "normal", and it is the one triage still owes an answer on.
 *
 * The repo's `needs-triage` label exists precisely because priority was left off,
 * so it is the same fact and is never given a chip of its own. An issue carrying
 * a priority AND a stale `needs-triage` shows its priority: the more specific
 * answer wins, and the pill stays out of the way.
 *
 * It takes the ROW rather than the labels, because whether there is a triage
 * question left is a question about the row: see `needsTriage`.
 */
function Pill({ row }: { row: Pick<IssueRow, 'labels' | 'status' | 'orphan'> }) {
  const p = priorityOf(row.labels);
  // NOTHING LEFT TO TRIAGE ON A CLOSED ISSUE, and closed is `isClosedIssue`
  // rather than `status === 'done'`. The status is decided by the loudest thing
  // on the row, so a worker parked at a gate on a ticket QA closed reads
  // `at-gate` and used to keep its "needs triage" pill — 33 of 105 closed issues
  // still carried the label, and the console cannot remove one (it never writes
  // labels), so it stops asking instead.
  if (isClosedIssue(row)) return null;
  return (
    <span
      className={`prio ${p.toLowerCase()}`}
      title={
        p === 'untriaged'
          ? 'no priority set — triage sets it, and the repo’s needs-triage label says the same thing. Where the issue came from is the self-filed chip, which is a separate question'
          : `priority ${p}, set by triage`
      }
    >
      {bandLabel(p)}
    </span>
  );
}

/**
 * Where the issue came FROM. The fact the queue cannot show on its own: the repo
 * assigns the filer, so an issue this machine raised — by the operator, or by a worker
 * spinning one off — arrives looking exactly like work the team handed over.
 *
 * It appears only for issues this machine's own account raised. An issue a
 * teammate filed never shows it, however untriaged it is.
 */
function Provenance({ row }: { row: IssueRow }) {
  if (!row.selfFiled) return null;
  return (
    <span
      className="chip self"
      title="raised from this machine (by you or by a worker), then auto-assigned by the repo's autoassign workflow"
    >
      self-filed
    </span>
  );
}

/**
 * Sent back from UAT — the one thing on this page that outranks P0.
 *
 * **Where it sits, and why it cannot duplicate anything already there.** It goes
 * FIRST in the same row of chips as the priority pill, immediately before it,
 * everywhere an issue is named. Four neighbours, four different questions:
 *
 *  - the **priority pill** (`P0`…`needs triage`) says what TRIAGE RANKED this.
 *    This says a person has SINCE tested the shipped work and failed it. A rank
 *    and a verdict are different facts, and the vocabularies do not overlap by a
 *    single word — this chip never renders a band and the pill never renders a
 *    verdict. They read as one sentence: "P2 · UAT FAIL — qa-alice · 10 Aug".
 *  - **needs-triage** is the same pill (the console has exactly one triage
 *    signal, and it lives in `Pill`). Nothing here touches it.
 *  - the **self-filed** chip is provenance — where the issue came FROM. Faint,
 *    grey, and about the past.
 *  - the **status chip** `rework requested` is the pre-merge review round, which
 *    needs an OPEN PR; this needs a MERGED one. On the same PR they are mutually
 *    exclusive by construction, and if both ever show they are two true facts
 *    about two different PRs, in different words and different colours.
 *
 * It is the only chip in the app that fills solid, so it wins the eye without
 * anything else having to get louder — the P0 pill stays the outline it is.
 *
 * And it says WHO and WHEN, not just "changes requested": the row answers the
 * whole question without being opened.
 */
function UatChip({ row }: { row: IssueRow }) {
  const f = row.uatFail;
  // A `Pass` is the good news that retires a fail; it is never this chip.
  if (!f || f.verdict === 'Pass') return null;
  const day = new Date(f.at);
  const when = Number.isNaN(day.getTime()) ? 'an unknown date' : day.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return (
    <span
      className="chip uat"
      title={
        `${f.by} tested this in UAT and marked it ${f.verdict}` +
        `${Number.isNaN(day.getTime()) ? '' : ` on ${day.toLocaleString()}`}. ` +
        (f.inflight
          ? 'A fix is already moving for it — a PR has been opened or pushed to since. Still the verdict on this issue: ' +
            'it is not signed off, whoever is fixing it.'
          : 'Highest priority — fix this before anything else.') +
        ' This is the post-merge human verdict on the issue, not the pre-merge review bot.'
      }
    >
      {f.verdict === 'Fail' ? 'UAT FAIL' : 'UAT PARTIAL'} — {f.by} · {when}
      {/* Said on the chip, not just in the tooltip: a fail somebody is already
          fixing is a different thing to do next from one nobody has touched. */}
      {f.inflight ? ' · fix in flight' : ''}
    </span>
  );
}

/**
 * The same fact as a sentence, at the top of the issue. It exists because the
 * chip has room for a name and a date and nothing else, and the thing the operator
 * actually needs is the link to what the tester wrote — the steps to recreate
 * are in that comment.
 */
function UatCard({ row }: { row: IssueRow }) {
  const f = row.uatFail;
  if (!f || f.verdict === 'Pass') return null;
  const at = new Date(f.at);
  return (
    <section className="card uat-card">
      <div className="card-head">
        <h3>Sent back from UAT</h3>
      </div>
      <p>
        <strong>{f.by}</strong> tested this in UAT and marked it <strong>{f.verdict}</strong>
        {!Number.isNaN(at.getTime()) && <> · {at.toLocaleString()}</>} ·{' '}
        <a href={f.url} target="_blank" rel="noreferrer">
          read the verdict on GitHub
        </a>
      </p>
      <p className="note">
        {f.inflight
          ? 'A fix is already moving for it — a PR has been opened or pushed to since the verdict. Check that PR ' +
            'answers what the tester wrote before you count this closed; the verdict comment has the steps to recreate.'
          : 'This goes first — above every priority. QA is waiting on the fix, and the verdict comment has the steps ' +
            'to recreate.'}
      </p>
    </section>
  );
}

/**
 * Said once, directly above the button that would start the work: this issue came
 * from here, and nobody outside this laptop has agreed to it. It disables
 * nothing — the decision is the operator's, and the console's job is only to make sure it
 * is not made by accident.
 */
function TriageCaution({ row }: { row: IssueRow }) {
  if (!selfFiledNeedsTriage(row)) return null;
  return (
    <p className="note caution">
      Self-filed and not yet triaged — the team usually sets priority before this gets picked up.
    </p>
  );
}

/**
 * PARKED — the second chip on a parked row.
 *
 * It has to be a SECOND chip rather than a replacement, and that is the whole
 * feature in one component. The operator asked for parked work to stay at its
 * gate, to drop off the top of the queue, and to be plainly marked paused. So
 * the status chip beside this one goes on reading "AT GATE C" — because the
 * ticket IS still at gate C — and this says the other half.
 *
 * `blocked` gets no chip of its own here: its status chip already says the
 * word. The two share the cold dashed outline (`.chip.aside`, applied by
 * `chipClass`) and each says which it is, which is what "the same ui" has to
 * mean if the list is to stay readable.
 */
function ParkedChip({ row }: { row: IssueRow }) {
  if (!isParked(row)) return null;
  const when = new Date(row.parked!.at);
  return (
    <span
      className="chip aside parked"
      title={
        `You parked this${Number.isNaN(when.getTime()) ? '' : ` on ${when.toLocaleString()}`}` +
        `${row.parked!.reason ? ` — ${row.parked!.reason}` : ''}. ` +
        'It keeps its gate and everything else; it is just out of the top of the list until you un-park it.'
      }
    >
      PARKED
    </span>
  );
}

/**
 * A run that is deciding its own gates, said on the row.
 *
 * It sits beside the status chip rather than instead of it, exactly like
 * `ParkedChip`: the ticket really is at gate C, and this says the other half —
 * that nobody is being waited for. A run passing gates without the operator is
 * the one state in this console they must never have to infer.
 */
function SuperchargeChip({ row }: { row: IssueRow }) {
  if (row.supercharge?.on !== true) return null;
  const rounds = row.supercharge.autoRounds;
  return (
    <span
      className="chip aside"
      title={
        'Supercharged: the console is passing gates A, B and C on this issue without waiting for you, and ' +
        'will stop at gate D. Gate C is passed only when every QA step carries its before and after ' +
        'captures and those files are on disk' +
        (rounds > 0 ? `; ${rounds} automatic gate C send-back${rounds === 1 ? '' : 's'} so far.` : '.')
      }
    >
      SUPERCHARGED
    </span>
  );
}

/**
 * WHY THIS GATE IS IN FRONT OF YOU, when a supercharged run put it there.
 *
 * Gate D on a supercharged issue is not the same decision as gate D on a hand-
 * driven one: the three gates behind it were passed by the console, so nobody
 * has read the plan or clicked the script. The card has to say that, because the
 * alternative is the operator approving a PR on the assumption that they
 * approved the work leading to it.
 */
function SuperchargeNotice({ row }: { row: IssueRow }) {
  const s = row.supercharge;
  if (!s) return null;
  if (s.stopped) {
    return (
      <p className="note caution">
        This run was supercharged and has stopped: {s.stopped} Gates before this one were passed by the console,
        not read by you.
      </p>
    );
  }
  if (!s.on) return null;
  return (
    <p className="note caution">
      This run is supercharged — the console is passing gates A, B and C on it and will stop at gate D. Nobody
      has read the plan or clicked through the QA script; the evidence was checked for completeness only.
    </p>
  );
}

/**
 * The same fact as a sentence, at the top of the issue — and the way back out.
 *
 * The chip has room for one word. What is worth having three weeks later is the
 * DATE and the REASON, which is why the reason field exists at all: "parked" on
 * its own decays into "why is this here?", and that is how a parked ticket turns
 * into a forgotten one.
 *
 * A ticket parked with no reason says so plainly rather than inventing one. It
 * is a legitimate thing to do and the card must not nag about it.
 */
/**
 * WHY this row has a worktree and no ticket, in words that name the case.
 *
 * The row itself used to be the whole answer, and it was the same answer three
 * times over: "#5697 — worktree with no matching open issue" was shown for an
 * issue closed the day before, for one reassigned to somebody else, and for one
 * that had simply fallen off the fifty-issue page. It reads as a fault in the
 * console rather than as a fact about the ticket, and on #5697 — closed,
 * signed off, and running a worker at stage 2 — that is what it was read as.
 *
 * Placed above every other card because it changes what all of them mean: a
 * gate, a PR and a stage on work nobody is waiting for are a different thing
 * from the same three on live work.
 */
function OrphanCard({ row }: { row: IssueRow }) {
  const o = row.orphan;
  if (!o) return null;
  const closedOn = o.closedAt ? new Date(o.closedAt) : null;
  const holders = o.assignees.filter((a) => a !== '');
  return (
    <div className="drafted-item">
      <p className="note">
        {o.reason === 'closed' && (
          <>
            <strong>Closed on GitHub</strong>
            {closedOn && !Number.isNaN(closedOn.getTime()) && (
              <> on {closedOn.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</>
            )}
            {' — the worktree is still here, so the row is too. Nothing is waiting for this work. '}
            {'Reopen it on GitHub if it is not finished.'}
          </>
        )}
        {o.reason === 'not-yours' && (
          <>
            <strong>Not yours any more</strong>
            {' — still open on GitHub, but neither assigned to you nor raised by you'}
            {holders.length > 0 && <> (with {holders.map((a) => `@${a}`).join(', ')} now)</>}
            {'. The worktree on this machine is what keeps the row here.'}
          </>
        )}
        {o.reason === 'still-open' && (
          <>
            <strong>Open, and still yours</strong>
            {' — it is off the end of the fifty issues the console reads, not gone. '}
            {'Everything on this row is real work; only its place in the list is missing.'}
          </>
        )}
        {o.reason === 'unread' && (
          <>
            <strong>No matching open issue</strong>
            {' — and GitHub could not be read for this one, so which of closed, reassigned or '}
            {'off-the-page it is has not been established. It is usually closed.'}
          </>
        )}
      </p>
      {/* WHAT QA HAD SAID AT THE CLOSE, in the server's own words.
          UNDER the close line because it qualifies it: "nothing is waiting for
          this work" is only the whole truth when somebody verified the work, and
          28 of 105 closures carried no QA verdict at all. It renders only where
          the server established one — an absent record means the console never
          looked, and the card says nothing rather than guessing. A `pass` reads
          quiet; everything else earns the caution treatment, including the close
          made over a verdict that was still standing. */}
      {o.reason === 'closed' && row.closeVerdict && (
        <p className={row.closeVerdict.verdict === 'pass' ? 'note' : 'note caution'}>{row.closeVerdict.line}</p>
      )}
    </div>
  );
}

function ParkedCard({ row, onDone }: { row: IssueRow; onDone: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (!isParked(row)) return null;
  const p = row.parked!;
  const when = new Date(p.at);
  const unpark = async () => {
    setBusy(true);
    onDone((await post(`/api/issues/${row.number}/unpark`)).message);
    setBusy(false);
  };
  return (
    <div className="parked-card">
      <p className="parked-line">
        <strong>Parked</strong>
        {!Number.isNaN(when.getTime()) && <> on {when.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</>}
        {' — you set this aside. It is still '}
        {row.gate ? `at gate ${row.gate.gate}` : `“${CHIP_LABEL[row.status]}”`}
        {' and nothing about it has moved; it is only out of the top of the list.'}
      </p>
      {p.reason ? <p className="parked-why">“{p.reason}”</p> : <p className="parked-why none">No reason recorded.</p>}
      <button disabled={busy} onClick={() => void unpark()}>
        Un-park it
      </button>
    </div>
  );
}

/**
 * Put it down. One button, and a reason the operator may leave empty.
 *
 * The reason is offered EVERY time and demanded never. `reopen-gate` demands
 * one because reopening reverses a decision other people are working from;
 * parking is the operator telling themselves something, and a box they have to
 * fill before they can put a ticket down is a box that stops them putting
 * tickets down.
 *
 * It lives in the toolbar rather than at the top of the pane on purpose: on a
 * row that is NOT parked this is a rarely-used control, and putting it beside
 * the gate card would give a quiet act the same weight as an approval.
 */
function ParkControl({ row, onDone }: { row: IssueRow; onDone: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  // A closed issue is already at the floor of the list and has nothing left to
  // set aside. Everything else can be parked, including a running worker — see
  // `parkIssue`.
  if (row.status === 'done' || isParked(row)) return null;
  const park = async () => {
    setBusy(true);
    onDone((await post(`/api/issues/${row.number}/park`, { reason: why })).message);
    setBusy(false);
    setOpen(false);
    setWhy('');
  };
  if (!open) return <button onClick={() => setOpen(true)}>Park this issue</button>;
  return (
    <div className="park-form">
      <input
        autoFocus
        value={why}
        placeholder="why are you parking it? (optional)"
        onChange={(e) => setWhy(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void park()}
      />
      <button className="primary" disabled={busy} onClick={() => void park()}>
        Park it
      </button>
      <button disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </button>
      <p className="note">
        It keeps its gate, its worktree and its session. Nothing stops, nothing moves — it drops out of the top of
        the list until you un-park it.
      </p>
    </div>
  );
}

function Chip({ row }: { row: IssueRow }) {
  // `chipClass` (ui/src/look.ts) replaced a ternary chain that left SEVEN of the
  // sixteen statuses with no class at all — including `checkpoint` and
  // `detached`, work that has stopped and will not restart itself, which
  // rendered pixel-identical to a healthy `pr-open`.
  const cls = chipClass(row);
  const text = row.status === 'at-gate' && row.gate ? `AT GATE ${row.gate.gate}` : CHIP_LABEL[row.status];
  return <span className={`chip ${cls}`}>{text}</span>;
}

export async function post(path: string, body?: unknown): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as { ok: boolean; message: string };
}

/** Every Settings write answers with the fresh doctor report, so one call both
 *  does the thing and leaves the tab showing the truth. */
type AccountReply = { ok: boolean; message: string; output?: string; accounts?: AccountHealth[] };

async function accountCall(path: string, method: string, body?: unknown): Promise<AccountReply> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as AccountReply;
}

async function sourceCall(path: string, method = 'GET', body?: unknown): Promise<WorkSourcesSnapshot> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const reply = (await res.json()) as WorkSourcesSnapshot | { message?: string };
  if (!res.ok) throw new Error('message' in reply && reply.message ? reply.message : `source request failed (${res.status})`);
  return reply as WorkSourcesSnapshot;
}

function Copyable({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="resume-line">
      <code>{text}</code>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          });
        }}
      >
        {done ? 'copied' : 'copy'}
      </button>
    </div>
  );
}

const PROVIDERS: AgentProvider[] = ['claude', 'codex'];
type ProviderDefaults = Record<AgentProvider, string>;

const providerLabel = (provider: AgentProvider): string => (provider === 'codex' ? 'Codex' : 'Claude');

/** Legacy SSE/account payloads predate provider stamps and are all Claude. */
function providerOfAccount(account: Pick<AccountSummary, 'provider'> | null | undefined): AgentProvider {
  return account?.provider === 'codex' ? 'codex' : 'claude';
}

function accountNamed(accounts: AccountSummary[], name: string): AccountSummary | null {
  return accounts.find((account) => account.name === name) ?? null;
}

function providerOfModel(model: ModelOption): AgentProvider {
  if (model.provider === 'codex') return 'codex';
  // A provider-less legacy payload only contained Claude models. The id fallback
  // lets a rolling backend deploy still render newly introduced Codex ids safely.
  return model.provider === 'claude' || !model.id.startsWith('gpt-') ? 'claude' : 'codex';
}

function modelsForProvider(models: ModelOption[], provider: AgentProvider): ModelOption[] {
  return models.filter((model) => providerOfModel(model) === provider);
}

function defaultsForState(state: ConsoleState): ProviderDefaults {
  const first = (provider: AgentProvider) => modelsForProvider(state.models, provider)[0]?.id ?? '';
  return {
    claude: state.defaultsByProvider?.claude ?? state.defaultModel ?? first('claude'),
    codex: state.defaultsByProvider?.codex ?? first('codex'),
  };
}

function providerModel(
  models: ModelOption[],
  defaults: ProviderDefaults,
  provider: AgentProvider,
  preferred?: string | null,
): string {
  const scoped = modelsForProvider(models, provider);
  if (preferred && scoped.some((model) => model.id === preferred)) return preferred;
  if (scoped.some((model) => model.id === defaults[provider])) return defaults[provider];
  return scoped[0]?.id ?? preferred ?? defaults[provider];
}

/** The model a destination profile resolves to before an issue overrides it.
 * Account switches always use this instead of carrying the previous profile's
 * picker value across, even when both profiles use the same provider. */
function modelForAccount(
  models: ModelOption[],
  defaults: ProviderDefaults,
  account: AccountSummary | null,
): string {
  const provider = providerOfAccount(account);
  return providerModel(models, defaults, provider, account?.model);
}

function providerForRow(row: IssueRow, accounts: AccountSummary[]): AgentProvider {
  if (row.provider === 'codex') return 'codex';
  if (row.provider === 'claude') return 'claude';
  return providerOfAccount(accountNamed(accounts, row.account ?? '') ?? accounts.find((account) => account.isDefault));
}

function ProviderBadge({ provider }: { provider: AgentProvider }) {
  return (
    <span className="acct" title={`agent provider: ${providerLabel(provider)}`}>
      {providerLabel(provider)}
    </span>
  );
}

/** Account badges only need a name; ProviderBadge carries the runtime beside it. */
function AccountBadge({ name }: { name: string }) {
  return (
    <span className="acct" title="the provider account this worker runs under">
      {name}
    </span>
  );
}

function healthOf(health: AccountHealth[], name: string): AccountHealth | null {
  return health.find((h) => h.name === name) ?? null;
}

/** A model's short name, or the raw id for one this console does not know. */
function modelName(models: ModelOption[], id: string, provider?: AgentProvider): string {
  return models.find((model) => model.id === id && (!provider || providerOfModel(model) === provider))?.label ?? id;
}

/**
 * "Not logged in" is the one failure with an exact, typeable fix, and it is the
 * live cause of workers dying at stage 0. Recognising it here is what turns a red
 * line into a command you can paste.
 */
const LOGIN_ERROR = /not logged in|please run \/login/i;

/** A failed run, with the login command when that is what went wrong. The command
 *  comes from the row, composed by the same helper Settings uses. */
function FailureNote({ row }: { row: IssueRow }) {
  if (!row.lastError) return null;
  const isLogin = LOGIN_ERROR.test(row.lastError);
  return (
    <div className={isLogin ? 'report' : undefined}>
      <p className="note err">Last run failed: {row.lastError}</p>
      {isLogin && (
        <>
          <p className="note">
            That account is not signed in. Run this in the <strong>Terminal</strong> app, sign in, then start the worker
            again.
          </p>
          <Copyable text={row.loginCommand} />
        </>
      )}
    </div>
  );
}

/** What is wrong with the account about to be used, and the exact fix to type. */
function AccountWarning({ h }: { h: AccountHealth | null }) {
  if (!h) return null;
  const problems: string[] = [];
  const provider = providerOfAccount(h);
  if (provider === 'codex' && h.isCanonicalConfigDir) {
    return (
      <p className="note err">
        Codex · {h.name}: this is the interactive Codex home. Remove this profile and add a dedicated worker folder
        such as <code>~/.codex-worker</code>; Worker Console will not install its safety hook into interactive Codex.
      </p>
    );
  }
  const instructionsFile = h.instructionsFile ?? (provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md');
  const instructionsLinked = h.instructionsLinked ?? h.claudeMdLinked;
  if (!h.configDirExists) problems.push('its config directory does not exist yet');
  if (h.loggedIn === false) problems.push('it is not logged in');
  if (!h.skillsLinked) problems.push('its skills are not linked to the canonical ones');
  if (!instructionsLinked) problems.push(`its ${instructionsFile} is not linked to the shared instructions`);
  if (h.hooksValid === false) problems.push('its worker write fence is not installed');
  if (problems.length === 0) return null;
  return (
    <p className="note err">
      {providerLabel(provider)} · {h.name}: {problems.join('; ')}. Use <strong>Link worker files</strong> in Settings,
      then run <code>{h.loginCommand}</code> in Terminal.
    </p>
  );
}

/**
 * Which provider account this worker will run under. Always rendered next to the
 * button that starts one, even with a single account — a control you cannot see
 * is a control you cannot find. With one account, or with a session that has
 * already fixed the account, the select is disabled and says why.
 */
function RunAs({
  accounts,
  value,
  onChange,
  busy,
  lockedNote,
}: {
  accounts: AccountSummary[];
  value: string;
  onChange: (name: string, provider: AgentProvider) => void;
  busy?: boolean;
  /** Set when the account cannot be changed here, and says what to do instead. */
  lockedNote?: string;
}) {
  const only = accounts.length < 2;
  // With one account there is nothing to switch to and "Restart fresh" is not
  // offered either, so that hint wins over the locked one — pointing at a
  // control that is not on the page would be worse than saying nothing.
  const hint = only ? 'add accounts in Settings to switch' : (lockedNote ?? null);
  return (
    <span className="runas">
      <label className="acct-pick">
        Run as{' '}
        <select
          value={value}
          onChange={(e) => {
            const name = e.target.value;
            onChange(name, providerOfAccount(accountNamed(accounts, name)));
          }}
          disabled={busy || only || lockedNote !== undefined}
        >
          {accounts.map((a) => (
            <option key={a.name} value={a.name}>
              {providerLabel(providerOfAccount(a))} · {a.name}
              {a.isDefault ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
      {hint && <span className="note">{hint}</span>}
    </span>
  );
}

/**
 * Which model this worker runs. It sits next to “Run as” everywhere a worker can
 * be started, and it works the same way: the choice is made at SPAWN and holds
 * for the whole segment, so what a run cost can be attributed to one model.
 *
 * The list carries a line each on when you would pick it, because a dropdown of
 * four model names with no guidance is not a decision aid.
 */
function RunOn({
  models,
  provider,
  value,
  onChange,
  busy,
  lockedNote,
}: {
  models: ModelOption[];
  provider: AgentProvider;
  value: string;
  onChange: (id: string) => void;
  busy?: boolean;
  /** Set when the model cannot be changed here, and says what to do instead. */
  lockedNote?: string;
}) {
  // An id nobody offers — an issue stamped before a rename, say — is still shown
  // as itself rather than silently becoming the first option in the list.
  const scoped = modelsForProvider(models, provider);
  const options = scoped.some((m) => m.id === value)
    ? scoped
    : [
        ...scoped,
        { provider, id: value, label: value, when: `Not a ${providerLabel(provider)} model this console knows about.` },
      ];
  const chosen = options.find((m) => m.id === value) ?? null;
  return (
    <span className="runas">
      <label className="acct-pick">
        Model{' '}
        <select value={value} onChange={(e) => onChange(e.target.value)} disabled={busy || lockedNote !== undefined}>
          {options.map((m) => (
            <option key={`${providerOfModel(m)}:${m.id}`} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      {lockedNote ? <span className="note">{lockedNote}</span> : chosen && <span className="note">{chosen.when}</span>}
    </span>
  );
}

/**
 * What supercharging actually costs, in front of the click.
 *
 * The gate-C sentence is the one the operator asked for by name — the evidence
 * is the part that matters most, so it has to be there at gate C — and it
 * is stated as what the console CHECKS rather than as a reassurance, because the
 * difference between "the pictures exist" and "the pictures are right" is the
 * whole difference between this and reading the gate yourself.
 */
const superchargeQuestion = (n: number): string =>
  `Run #${n} supercharged, to gate D?\n\n` +
  `Gates A, B and C are passed by the console as the worker reaches them. Nothing waits for you until gate ` +
  `D — which is your approval to raise the PR, and is where it stops. Gate E, the hand-over to the team ` +
  `lead, is never automatic either.\n\n` +
  `GATE C STILL NEEDS THE EVIDENCE. It is passed only when the click-script has steps, none of them came ` +
  `back malformed, every step carries both an afterShot and a beforeShot (or declares itself genuinely new ` +
  `behaviour), every one of those captures is a file on disk, and the gate file lists them. If any of that ` +
  `is missing the work is sent BACK for the captures — twice at most, then it stops and waits for you.\n\n` +
  `WHAT YOU GIVE UP: nobody reads the plan at gate A or B, and nobody clicks through the QA script at gate ` +
  `C. The evidence is checked for completeness, never for whether it shows the right thing. You see all of ` +
  `it at gate D, and every automatic pass is written into the decision ledger as one.`;

/**
 * Start a worker, under a chosen account and model for a fresh issue. Once a
 * session exists both are fixed — its transcript and conversation live in one
 * account, and a segment measured across two models measures nothing — so the
 * pickers lock and the only switch is "restart fresh".
 */
function StartWorker({
  row,
  accounts,
  models,
  defaults,
  health,
  onDone,
}: {
  row: IssueRow;
  accounts: AccountSummary[];
  models: ModelOption[];
  defaults: ProviderDefaults;
  health: AccountHealth[];
  onDone: (m: string) => void;
}) {
  const fallback = accounts.find((a) => a.isDefault)?.name ?? accounts[0]?.name ?? '';
  // Leaks the same way the rework brief did — a worker silently started on the
  // account another issue was pinned to.
  const [account, setAccount] = useIssueState(row.number, row.account ?? fallback);
  const provider = providerOfAccount(accountNamed(accounts, account));
  const [model, setModel] = useIssueState(
    row.number,
    providerModel(models, defaults, provider, row.modelResolved),
  );
  const [busy, setBusy] = useState(false);
  const multi = accounts.length > 1;
  const locked = row.accountLocked;

  const start = () => {
    setBusy(true);
    void post(`/api/issues/${row.number}/start`, {
      ...(multi && !locked ? { account } : {}),
      ...(locked ? {} : { model }),
    }).then((out) => {
      setBusy(false);
      onDone(out.message);
    });
  };

  /**
   * The same start, with a standing instruction attached. It is a separate
   * button rather than a checkbox because it is a separate decision — the one
   * where the operator chooses not to read three gates — and it asks first.
   */
  const startSupercharged = () => {
    if (!confirm(superchargeQuestion(row.number))) return;
    setBusy(true);
    void post(`/api/issues/${row.number}/start`, {
      ...(multi && !locked ? { account } : {}),
      ...(locked ? {} : { model }),
      supercharge: true,
    }).then((out) => {
      setBusy(false);
      onDone(out.message);
    });
  };

  return (
    <>
      <TriageCaution row={row} />
      <RunAs
        accounts={accounts}
        value={account}
        onChange={(name) => {
          setAccount(name);
          setModel(modelForAccount(models, defaults, accountNamed(accounts, name)));
        }}
        busy={busy}
        lockedNote={
          locked ? 'this session is fixed to that account — “Restart fresh” below is the only switch' : undefined
        }
      />
      <RunOn
        models={models}
        provider={provider}
        value={model}
        onChange={setModel}
        busy={busy}
        lockedNote={
          locked ? 'this session is running that model — “Restart fresh” below is the only switch' : undefined
        }
      />
      <button className="primary" disabled={busy} onClick={start}>
        Start a worker
      </button>
      <button className="tool" disabled={busy} onClick={startSupercharged} title={superchargeQuestion(row.number)}>
        Supercharge to gate D
      </button>
      <SuperchargeNotice row={row} />
      <AccountWarning h={healthOf(health, account)} />
    </>
  );
}

/**
 * The only way to move an issue to another account — or to another model. The
 * session is abandoned, not transferred; the worktree, branch, commits and the
 * whole gate history stay exactly where they are, and the new session reads them
 * to pick the work up.
 */
function RestartFresh({
  row,
  accounts,
  models,
  defaults,
  health,
  onDone,
}: {
  row: IssueRow;
  accounts: AccountSummary[];
  models: ModelOption[];
  defaults: ProviderDefaults;
  health: AccountHealth[];
  onDone: (m: string) => void;
}) {
  const current = row.account ?? accounts.find((a) => a.isDefault)?.name ?? '';
  const others = accounts.filter((a) => a.name !== current);
  // With one account this card is still the only way to change the MODEL, so it
  // offers the account it is already on rather than disappearing.
  const choices = others.length > 0 ? others : accounts;
  const initialAccountName = choices[0]?.name ?? current;
  const initialAccount = accountNamed(accounts, initialAccountName);
  const [account, setAccount] = useIssueState(row.number, initialAccountName);
  const provider = providerOfAccount(accountNamed(accounts, account));
  const currentProvider = providerForRow(row, accounts);
  const [model, setModel] = useIssueState(
    row.number,
    initialAccountName === current
      ? providerModel(models, defaults, currentProvider, row.modelResolved)
      : modelForAccount(models, defaults, initialAccount),
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const changed = account !== current || model !== row.modelResolved;
  if (choices.length === 0) return null;

  if (!confirming) {
    return (
      <div className="toolbar">
        <span className="note">
          This {providerLabel(currentProvider)} session is fixed to <strong>{current}</strong> on{' '}
          <strong>{modelName(models, row.modelResolved, currentProvider)}</strong>{' '}
          — neither can move. Restarting abandons it and starts a new one.
        </span>
        {others.length > 0 && (
          <label className="acct-pick">
            <select
              value={account}
              onChange={(e) => {
                const name = e.target.value;
                setAccount(name);
                setModel(modelForAccount(models, defaults, accountNamed(accounts, name)));
              }}
            >
              {choices.map((a) => (
                <option key={a.name} value={a.name}>
                  {providerLabel(providerOfAccount(a))} · {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <RunOn models={models} provider={provider} value={model} onChange={setModel} />
        <button disabled={!changed} onClick={() => setConfirming(true)}>
          Restart fresh…
        </button>
      </div>
    );
  }

  return (
    <div className="confirm">
      <h3>
        Restart #{row.number} fresh with {providerLabel(provider)} under {account} on{' '}
        {modelName(models, model, provider)}?
      </h3>
      <p className="note">
        The current session ({row.sessionId?.slice(0, 8)}…) is abandoned and a new one starts under{' '}
        <strong>{providerLabel(provider)} · {account}</strong>, running{' '}
        <strong>{modelName(models, model, provider)}</strong>. The worktree, the branch and its
        commits, <code>.issue-state.md</code> and the whole gate history all stay — the new session reads them to pick
        the work back up. The live <code>.gate.json</code> is cleared, because it names the session being abandoned.
      </p>
      <AccountWarning h={healthOf(health, account)} />
      <div className="gate-actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void post(`/api/issues/${row.number}/restart-fresh`, { account, model }).then((out) => {
              setBusy(false);
              setConfirming(false);
              onDone(out.message);
            });
          }}
        >
          Yes, restart under {account}
        </button>
        <button disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One doctor boolean, said in English. `unknown` is never a failure — on macOS
 *  the credentials live in the Keychain, where the console cannot look. */
function Health({ value, label }: { value: boolean | 'unknown'; label: string }) {
  const state = value === 'unknown' ? 'unknown' : value ? 'yes' : 'no';
  return (
    <li className={`health ${state}`}>
      <span className="mark">{state === 'yes' ? '✓' : state === 'no' ? '✗' : '?'}</span> {label}
      {state === 'unknown' && <span className="note"> — can't tell from files alone</span>}
    </li>
  );
}

/**
 * The one thing left to do on this account, so it never has to be worked out
 * from the four ticks. Order matters: linking creates the folder if it is
 * missing, so it comes before the login.
 */
function nextStep(h: AccountHealth): string | null {
  const provider = providerOfAccount(h);
  if (provider === 'codex' && h.isCanonicalConfigDir) {
    return 'remove this entry and add a dedicated worker CODEX_HOME such as ~/.codex-worker. The interactive ~/.codex home cannot receive the Worker Console safety hook.';
  }
  const instructionsFile = h.instructionsFile ?? (provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md');
  if (!h.skillsLinked || !(h.instructionsLinked ?? h.claudeMdLinked) || h.hooksValid === false) {
    return `press “Link worker files” below. It makes the folder if it is missing, links skills and ${instructionsFile}${
      provider === 'codex' ? ', and installs the worker write fence' : ''
    }.`;
  }
  if (h.probe?.verdict === 'not-signed-in' || h.loggedIn === false) {
    return 'copy the line below, paste it into the Terminal app and press return. A browser window opens — sign in there with this account.';
  }
  // A probe that came back green settles the question the files could not.
  if (h.loggedIn === 'unknown' && h.probe?.verdict !== 'signed-in') {
    return `press “Check ${providerLabel(provider)} login” below. The files cannot answer reliably because this Mac may keep the login in the Keychain.`;
  }
  return null;
}

/** After this long an answer is a memory, not a fact: an account can be signed
 *  in or out from a terminal at any moment, and the console would never know. */
const PROBE_STALE_MS = 10 * 60 * 1000;

function ago(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

/**
 * What the login check found. Two rules: a stale answer is shown grey rather
 * than as if it were current, and it never outranks a fresh file signal saying
 * the directory is not even there.
 */
function LoginVerdict({ h }: { h: AccountHealth }) {
  if (!h.configDirExists) {
    return <span className="note err">that folder does not exist yet, so there is nothing to sign in to</span>;
  }
  if (!h.probe) {
    return <span className="note">not checked — the ticks above are only what the files suggest</span>;
  }
  const age = Date.now() - Date.parse(h.probe.checkedAt);
  const stale = !Number.isFinite(age) || age > PROBE_STALE_MS;
  const label =
    h.probe.verdict === 'signed-in' ? 'signed in' : h.probe.verdict === 'not-signed-in' ? 'NOT signed in' : "couldn't tell";
  return (
    <span className={`note ${stale ? '' : h.probe.verdict === 'signed-in' ? 'ok' : 'err'}`}>
      <strong>{label}</strong> · checked {ago(age)}
      {stale && ' — old enough to be worth re-checking'}
      {h.probe.verdict === 'unknown' && ` — ${h.probe.detail}`}
    </span>
  );
}

/** One registered account: what it is, whether it is healthy, and the three
 *  things the operator can do to it. Removing only ever removes the registry entry. */
function AccountCard({
  h,
  only,
  models,
  defaults,
  onReply,
}: {
  h: AccountHealth;
  only: boolean;
  models: ModelOption[];
  defaults: ProviderDefaults;
  onReply: (r: AccountReply) => void;
}) {
  // Which call is in flight, so the login check can say it is checking rather
  // than every button just going grey.
  const [pending, setPending] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const busy = pending !== null;
  const step = nextStep(h);
  const provider = providerOfAccount(h);
  const scopedModels = modelsForProvider(models, provider);
  const providerDefault = defaults[provider];
  const instructionsFile = h.instructionsFile ?? (provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md');
  const instructionsLinked = h.instructionsLinked ?? h.claudeMdLinked;

  const call = (path: string, method: string, body?: unknown) => {
    setPending(path);
    void accountCall(path, method, body).then((r) => {
      setPending(null);
      if (typeof r.output === 'string') setOutput(r.output || '(the script printed nothing)');
      onReply(r);
    });
  };
  const checkPath = `/api/accounts/${encodeURIComponent(h.name)}/check-login`;

  return (
    <div className="acct-card">
      <p className="acct-card-head">
        <strong>{h.name}</strong>
        <ProviderBadge provider={provider} />
        {h.isDefault && <span className="acct">default</span>}
        <span className="mono note">{h.configDir}</span>
      </p>
      <ul className="health-list">
        <Health value={h.configDirExists} label="config directory exists" />
        {/* A hint read off the files, not an answer — the button below is the
            answer. Labelled so the two can never be read as the same claim. */}
        <Health value={h.loggedIn} label="logged in, as far as the files show" />
        <Health value={h.skillsLinked} label="skills linked to the canonical ones" />
        <Health value={instructionsLinked} label={`${instructionsFile} linked to the shared instructions`} />
        {h.hooksValid !== null && h.hooksValid !== undefined && (
          <Health value={h.hooksValid} label="worker write fence installed" />
        )}
      </ul>

      {step === null ? (
        <p className="next-step done">Ready — pick it under “Run as” when you start a worker.</p>
      ) : (
        <p className="next-step">
          <strong>Next step:</strong> {step}
        </p>
      )}

      {/* The ticks above are what the files suggest. The provider-specific probe
          is the definitive answer, and only runs on this click. */}
      <div className="toolbar" style={{ margin: '10px 0 0' }}>
        <button disabled={busy} onClick={() => call(checkPath, 'POST')}>
          {pending === checkPath ? 'Checking…' : `Check ${providerLabel(provider)} login`}
        </button>
        <LoginVerdict h={h} />
      </div>

      {(h.loggedIn !== true || h.probe?.verdict === 'not-signed-in') && (
        <>
          <p className="note">Paste this into the Terminal app and press return; this page turns green on its own.</p>
          <Copyable text={h.loginCommand} />
        </>
      )}

      {/* This account's default model. It is a preference, not a fence: the
          picker on an issue still wins over it. */}
      <p className="note" style={{ margin: '12px 0 4px' }}>
        Default model for workers on this account:
      </p>
      <div className="toolbar">
        <label className="acct-pick">
          <select
            value={h.model ?? ''}
            disabled={busy}
            onChange={(e) => call(`/api/accounts/${encodeURIComponent(h.name)}/model`, 'PUT', { model: e.target.value })}
          >
            <option value="">
              {providerLabel(provider)} default ({modelName(models, providerDefault, provider)})
            </option>
            {scopedModels.map((m) => (
              <option key={`${provider}:${m.id}`} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <span className="note">an issue's own “Model” picker still wins over this</span>
      </div>

      <div className="toolbar">
        <button
          disabled={busy || (provider === 'codex' && h.isCanonicalConfigDir === true)}
          title={provider === 'codex' && h.isCanonicalConfigDir ? 'Use a dedicated worker CODEX_HOME' : undefined}
          onClick={() => call(`/api/accounts/${encodeURIComponent(h.name)}/link`, 'POST')}
        >
          Link worker files
        </button>
        {!h.isDefault && (
          <button disabled={busy} onClick={() => call('/api/accounts/default', 'PUT', { name: h.name })}>
            Make default
          </button>
        )}
        {!only && (
          <button disabled={busy} onClick={() => call(`/api/accounts/${encodeURIComponent(h.name)}`, 'DELETE')}>
            Remove
          </button>
        )}
      </div>
      {output !== null && <pre>{output}</pre>}
    </div>
  );
}

/** The same check, once per account, one at a time — so two probes never race
 *  each other into the same rate limit. */
function CheckAllLogins({ names, onReply }: { names: string[]; onReply: (r: AccountReply) => void }) {
  const [at, setAt] = useState<string | null>(null);
  return (
    <button
      disabled={at !== null}
      onClick={() => {
        void (async () => {
          for (const name of names) {
            setAt(name);
            onReply(await accountCall(`/api/accounts/${encodeURIComponent(name)}/check-login`, 'POST'));
          }
          setAt(null);
        })();
      }}
    >
      {at === null ? 'Check every login' : `Checking ${at}…`}
    </button>
  );
}

/** Register another account. This writes one line into accounts.json; it does not
 *  create the directory, link it or log it in — the card then says what is left. */
function AddAccount({ onReply }: { onReply: (r: AccountReply) => void }) {
  const [provider, setProvider] = useState<AgentProvider>('claude');
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const slug = name.trim();
  const configDir = edited ? dir : slug ? `~/.${provider}-${slug}` : '';

  return (
    <form
      className="add-acct"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void accountCall('/api/accounts', 'POST', { name: slug, configDir, provider }).then((r) => {
          setBusy(false);
          if (r.ok) {
            setName('');
            setDir('');
            setEdited(false);
          }
          onReply(r);
        });
      }}
    >
      <label>
        agent{' '}
        <select
          value={provider}
          disabled={busy}
          onChange={(e) => {
            setProvider(e.target.value === 'codex' ? 'codex' : 'claude');
            setDir('');
            setEdited(false);
          }}
        >
          {PROVIDERS.map((option) => (
            <option key={option} value={option}>
              {providerLabel(option)}
            </option>
          ))}
        </select>
      </label>
      <label>
        name{' '}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="work" disabled={busy} size={14} />
      </label>
      <label>
        config directory{' '}
        <input
          value={configDir}
          onChange={(e) => {
            setEdited(true);
            setDir(e.target.value);
          }}
          placeholder={`~/.${provider}-work`}
          disabled={busy}
          size={26}
        />
      </label>
      <button type="submit" disabled={busy || !slug || !configDir.trim()}>
        Add account
      </button>
    </form>
  );
}

/** A figure with the number of runs behind it, always together. `—` when nothing
 *  is known yet, which is a different thing from zero and has to read like one. */
function WithN({ m, format }: { m: Measure | null; format: (v: number) => string }) {
  if (!m) return <span className="note">—</span>;
  return (
    <>
      {format(m.value)} <span className="note">n={m.n}</span>
    </>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const mins = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`);
const thousands = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/**
 * What the console has measured, per provider × model × segment.
 *
 * The hard rule here is honesty about sample size. `MAX_ACTIVE` is 1 and the
 * operator runs one issue at a time, so n stays tiny for a long while — every figure
 * carries the number of runs behind it, and when any cell is under the
 * threshold the table says outright that it cannot support a decision. There are
 * deliberately no arrows, no rankings and no "recommended model": at these
 * counts every one of those would be noise dressed as a finding, and a page that
 * implies a conclusion it cannot support is worse than no page.
 */
function MetricsTable() {
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    void fetch('/api/metrics')
      .then((r) => r.json())
      .then((o: Metrics) => setData(o))
      .catch((e: Error) => setError(e.message));
  };
  // Once when the tab opens, and on the button. Deliberately NOT on the doctor's
  // five-second timer: the join costs a gh call, and nothing here changes that fast.
  useEffect(load, []);

  if (error) return <p className="note err">{error}</p>;
  if (!data) return <p className="note">loading…</p>;

  return (
    <>
      <p>
        One line is appended to <code>runs.jsonl</code> every time a worker runs — from spawn (or resume) until it stops
        at a gate and exits. That stretch is the <strong>segment</strong>: it is the only span with one model in force
        from end to end, so it is the unit everything below is grouped by. Provider, profile and session are kept
        visible beside each aggregate so a result is never detached from the runtime that produced it. The file is
        append-only; nothing in the console rewrites or prunes it.
      </p>
      <p>
        This exists to answer one question later, with evidence: <em>for this kind of work, would a cheaper model have
        done as well?</em> The automatic router that question implies is <strong>deliberately not built</strong> —
        building it now would mean guessing the answer and then measuring against the guess.
      </p>

      {data.caveat && <p className="note err">{data.caveat}</p>}
      {/* Same failure, same treatment as the Dashboard: one line, with the whole
          `gh` invocation one click below it rather than 200 wrapped red
          characters of it. This is where `could not read CI: Command failed: gh
          pr list …` comes from. */}
      {data.warnings.length > 0 && <ErrorLine raw={`Incomplete — ${data.warnings.join('; ')}`} />}

      {data.cells.length === 0 ? (
        <p className="note">Nothing logged yet, so there is nothing to show.</p>
      ) : (
        <div className="md-table">
          <table>
            <thead>
              <tr>
                <th>provider · model</th>
                <th>profile</th>
                <th>sessions</th>
                <th>segment</th>
                <th>runs</th>
                <th>median time</th>
                <th>median output</th>
                <th>median reasoning</th>
                <th>median cost</th>
                <th>median files</th>
                <th>approved first time</th>
                <th>feedback rounds</th>
                <th>rework after</th>
                <th>CI red</th>
              </tr>
            </thead>
            <tbody>
              {data.cells.map((c) => (
                <tr key={`${c.provider}-${c.model}-${c.segment}`}>
                  <td>
                    {providerLabel(c.provider)} · {c.model}
                  </td>
                  <td>
                    {c.accounts.length === 0 ? (
                      <span className="note">—</span>
                    ) : (
                      c.accounts.map((account) => <div key={account}>{account}</div>)
                    )}
                  </td>
                  <td>
                    {c.sessions.length === 0 ? (
                      <span className="note">—</span>
                    ) : (
                      c.sessions.map((session) => (
                        <div key={session}>
                          <code>{session}</code>
                        </div>
                      ))
                    )}
                  </td>
                  <td>{c.segment === 'none' ? 'no gate' : `gate ${c.segment}`}</td>
                  <td className={c.enough ? undefined : 'note'}>
                    {c.runs}
                    {!c.enough && ` (under ${data.minSample})`}
                  </td>
                  <td>{c.medianDurationMs === null ? <span className="note">—</span> : mins(c.medianDurationMs)}</td>
                  <td>
                    {c.medianOutputTokens === null ? <span className="note">—</span> : thousands(c.medianOutputTokens)}
                  </td>
                  <td>
                    {c.medianReasoningOutputTokens === null ? (
                      <span className="note">—</span>
                    ) : (
                      thousands(c.medianReasoningOutputTokens)
                    )}
                  </td>
                  <td>
                    {c.medianCostUsd === null ? <span className="note">—</span> : `$${c.medianCostUsd.toFixed(2)}`}
                  </td>
                  <td>{c.medianFilesChanged === null ? <span className="note">—</span> : c.medianFilesChanged}</td>
                  <td>
                    <WithN m={c.firstTimeApproval} format={pct} />
                  </td>
                  <td>
                    <WithN m={c.gateFeedback} format={(v) => v.toFixed(1)} />
                  </td>
                  <td>
                    <WithN m={c.rework} format={pct} />
                  </td>
                  <td>
                    <WithN m={c.ciRed} format={pct} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="toolbar">
        <button onClick={load}>Re-read the log</button>
        <span className="note">
          {data.totalRuns} run{data.totalRuns === 1 ? '' : 's'} logged · built {new Date(data.generatedAt).toLocaleTimeString()}
        </span>
      </div>

      <details className="report">
        <summary>What each column is, and what it cannot tell you</summary>
        <p className="note">
          <strong>Median time, output tokens, reasoning tokens and cost</strong> come from the provider's own terminal
          usage event. A dash for reasoning means that provider did not report it; it is not treated as zero.{' '}
          <strong>Median files</strong> is how much code that segment's commits actually touched — it is here so quality
          is read against difficulty, because otherwise the hardest issues make the best model look worst.
        </p>
        <p className="note">
          <strong>Approved first time</strong> and <strong>feedback rounds</strong> are only known once you have
          answered that gate, so a gate still open counts towards nothing. <strong>Rework after</strong> is the share of
          runs a reviewer asked for changes after, attributed to the run whose code they were looking at.{' '}
          <strong>CI red</strong> is where CI stands on that issue's open PR right now.
        </p>
        <p className="note">
          Every figure carries the <strong>n</strong> behind it, and a cell under {data.minSample} runs is marked. A
          difference between two small cells is not a finding — it is two small cells.
        </p>
      </details>
    </>
  );
}


function ConnectionsSettings({
  snapshot,
  error,
  busy,
  onBusy,
  onSnapshot,
  onError,
  onDone,
}: {
  snapshot: WorkSourcesSnapshot | null;
  error: string | null;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onSnapshot: (snapshot: WorkSourcesSnapshot) => void;
  onError: (error: string | null) => void;
  onDone: (message: string) => void;
}) {
  const [linearKey, setLinearKey] = useState('');
  const [sentryToken, setSentryToken] = useState('');
  const [assignAs, setAssignAs] = useState('');
  // Starts EMPTY on purpose. It is a slug, not a secret, so a default would be
  // safe to ship — but a default is a wrong answer that looks like a right one:
  // connecting against somebody else's org fails in Sentry's words, not ours.
  // Connect stays disabled until this is filled in, so the empty box is the ask.
  const [sentryOrg, setSentryOrg] = useState('');
  const github = snapshot?.sources.find((source) => source.id === 'github') ?? null;
  const linear = snapshot?.sources.find((source) => source.id === 'linear') ?? null;
  const sentry = snapshot?.sources.find((source) => source.id === 'sentry') ?? null;
  const storedAssignAs = sentry?.assignAs ?? null;
  useEffect(() => {
    setAssignAs(storedAssignAs ?? '');
  }, [storedAssignAs]);

  const run = async (work: () => Promise<WorkSourcesSnapshot>, success: string): Promise<boolean> => {
    onBusy(true);
    onError(null);
    try {
      onSnapshot(await work());
      onDone(success);
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      onError(message);
      onDone(message);
      return false;
    } finally {
      onBusy(false);
    }
  };

  return (
    <section className="connections-settings">
      <div className="settings-title">
        <div>
          <span className="eyebrow">Connections</span>
          <h2>Connect where tickets are assigned</h2>
        </div>
        <button disabled={busy} onClick={() => void run(() => sourceCall('/api/sources/refresh', 'POST'), 'Work sources refreshed')}>
          {busy ? 'Checking…' : 'Re-check all'}
        </button>
      </div>
      <p>
        Connect GitHub, Linear, Sentry, or any of them. These connections only READ; nothing here can close, comment
        on, or change a ticket — or resolve an error.
      </p>
      {error && <p className="note err">{error}</p>}

      <div className="connection-grid">
        <article className={`connection-card ${github?.connected ? 'connected' : ''}`}>
          <div className="connection-card-head">
            <span className="provider-logo github">GH</span>
            <div>
              <h3>GitHub Issues</h3>
              <span className="note">
                {github?.connected ? `Connected as @${github.account}` : 'Not connected'}
              </span>
            </div>
            <span className={`connection-state ${github?.connected ? 'ok' : ''}`}>
              {github?.connected ? 'Connected' : 'Setup needed'}
            </span>
          </div>
          <p>{github?.detail ?? 'Uses the GitHub CLI login already available on this machine.'}</p>
          {github?.error && <p className="note err">{github.error}</p>}
          {!github?.connected && github?.connectCommand && (
            <>
              <p className="note">Run this once in Terminal, finish the browser sign-in, then re-check:</p>
              <Copyable text={github.connectCommand} />
            </>
          )}
          <button
            disabled={busy}
            onClick={() => void run(() => sourceCall('/api/sources/github/connect', 'POST'), 'GitHub connection checked')}
          >
            {github?.connected ? 'Re-check GitHub' : 'Check GitHub connection'}
          </button>
        </article>

        <article className={`connection-card ${linear?.connected ? 'connected' : ''}`}>
          <div className="connection-card-head">
            <span className="provider-logo linear">LI</span>
            <div>
              <h3>Linear</h3>
              <span className="note">{linear?.connected ? `Connected as ${linear.account}` : 'Not connected'}</span>
            </div>
            <span className={`connection-state ${linear?.connected ? 'ok' : ''}`}>
              {linear?.connected ? 'Connected' : 'Setup needed'}
            </span>
          </div>
          <p>{linear?.detail ?? 'Connect a personal API key to find active Linear issues assigned to you.'}</p>
          {linear?.error && <p className="note err">{linear.error}</p>}
          {linear?.connected ? (
            <button
              className="danger"
              disabled={busy || linear.managedBy === 'environment'}
              title={linear.managedBy === 'environment' ? 'Managed by LINEAR_API_KEY' : undefined}
              onClick={() => void run(() => sourceCall('/api/sources/linear', 'DELETE'), 'Linear disconnected')}
            >
              {linear.managedBy === 'environment' ? 'Managed by environment' : 'Disconnect Linear'}
            </button>
          ) : (
            <>
              <label className="linear-key">
                Personal API key
                <input
                  type="password"
                  value={linearKey}
                  autoComplete="off"
                  placeholder="lin_api_…"
                  onChange={(event) => setLinearKey(event.target.value)}
                />
              </label>
              <div className="connection-actions">
                <button
                  className="primary"
                  disabled={busy || !linearKey.trim()}
                  onClick={() => {
                    void run(
                      () => sourceCall('/api/sources/linear', 'PUT', { apiKey: linearKey }),
                      'Linear connected',
                    ).then((connected) => connected && setLinearKey(''));
                  }}
                >
                  Connect Linear
                </button>
                <a className="linkish" href="https://linear.app/settings/api" target="_blank" rel="noreferrer">
                  Create a key ↗
                </a>
              </div>
              <p className="note">Stored only on this machine in an owner-only, gitignored file.</p>
            </>
          )}
        </article>

        {/* SENTRY. Half of this connection already exists without a token: its
            GitHub integration files the tickets, and five of the issues in this
            console were raised by `app/sentry`. What the token adds is
            everything that link throws away — how often it fired, how many
            people it reached, whether it is still happening, and which
            environment it came from, which is a question a worker spent a whole
            gate unable to answer on #5555. */}
        <article className={`connection-card ${sentry?.connected ? 'connected' : ''}`}>
          <div className="connection-card-head">
            <span className="provider-logo sentry">SE</span>
            <div>
              <h3>Sentry</h3>
              <span className="note">{sentry?.connected ? `Connected to ${sentry.account}` : 'Not connected'}</span>
            </div>
            <span className={`connection-state ${sentry?.connected ? 'ok' : ''}`}>
              {sentry?.connected ? 'Connected' : 'Setup needed'}
            </span>
          </div>
          <p>
            {sentry?.detail ??
              'Connect a read-only token to see unresolved errors that have no ticket yet, and to put the event count, the environment and the release on a Sentry-raised ticket.'}
          </p>
          {sentry?.error && <p className="note err">{sentry.error}</p>}
          {sentry?.connected ? (
            <>
              {/* WHO "assign to me" MEANS. The panel cannot assign without it,
                  and it is shown rather than hidden because a value you cannot
                  see is one you cannot tell is wrong. Not a credential: it is
                  your own address, and Sentry's own `assignedTo` takes it. */}
              <label className="linear-key">
                Assign to me, as Sentry knows you
                <input
                  type="text"
                  value={assignAs}
                  autoComplete="off"
                  placeholder="user:4892844"
                  onChange={(event) => setAssignAs(event.target.value)}
                />
              </label>
              {/* The USER ID is the recommendation, not the email. Sentry takes
                  either, but Account Details says the id "cannot be modified"
                  while an email can be changed — and only the PRIMARY address
                  works, which is a distinction nothing on this card could show. */}
              <p className="note">
                Your Sentry user id as <code>user:&lt;id&gt;</code> is safest — it is on Sentry’s Account Details
                page and cannot change. A primary email address works too.
              </p>
              <div className="connection-actions">
                <button
                  disabled={busy || assignAs.trim() === (storedAssignAs ?? '')}
                  onClick={() =>
                    void run(
                      () => sourceCall('/api/sources/sentry/identity', 'PUT', { email: assignAs }),
                      assignAs.trim() ? `Sentry assigns to ${assignAs.trim()}` : 'Sentry assignee cleared',
                    )
                  }
                >
                  {assignAs.trim() ? 'Save' : 'Clear'}
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => void run(() => sourceCall('/api/sources/sentry', 'DELETE'), 'Sentry disconnected')}
                >
                  Disconnect Sentry
                </button>
              </div>
              <p className="note">
                {storedAssignAs
                  ? 'The Sentry panel assigns to this. Clear it to stop the panel assigning at all.'
                  : 'Set this and the Sentry panel can assign errors to you; until then it lists and filters only.'}
              </p>
            </>
          ) : (
            <>
              <label className="linear-key">
                Organisation slug
                <input
                  type="text"
                  value={sentryOrg}
                  autoComplete="off"
                  placeholder="acme-corp"
                  onChange={(event) => setSentryOrg(event.target.value)}
                />
              </label>
              <label className="linear-key">
                Auth token
                <input
                  type="password"
                  value={sentryToken}
                  autoComplete="off"
                  placeholder="sntryu_…"
                  onChange={(event) => setSentryToken(event.target.value)}
                />
              </label>
              <div className="connection-actions">
                <button
                  className="primary"
                  disabled={busy || !sentryToken.trim() || !sentryOrg.trim()}
                  onClick={() => {
                    void run(
                      () => sourceCall('/api/sources/sentry', 'PUT', { token: sentryToken, org: sentryOrg }),
                      'Sentry connected',
                    ).then((connected) => connected && setSentryToken(''));
                  }}
                >
                  Connect Sentry
                </button>
                <a
                  className="linkish"
                  href="https://sentry.io/settings/account/api/auth-tokens/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Create a token ↗
                </a>
              </div>
              {/* The scope is named because it is the one thing that will make a
                  correct-looking token fail, and because asking for the
                  narrowest one is the point: nothing here writes to Sentry. */}
              <p className="note">
                Needs <code>event:read</code> and nothing more. Stored only on this machine in an owner-only,
                gitignored file — the same one Linear's key uses.
              </p>
            </>
          )}
        </article>
      </div>
    </section>
  );
}

/**
 * Settings: the one place accounts are managed. It registers them, reports the
 * doctor's booleans, hands over the login command to run, links each one's
 * skills and provider instructions to the shared ones, and holds each one's default
 * model. The measurement table lives here too — it is about how the machine is
 * configured, which is what this tab is for, and unlike Info (a static manual
 * read from a markdown file) this view already fetches live data.
 * Per-issue choice stays where it belongs: the pickers on the start card.
 */
function SettingsView({
  sources,
  sourceError,
  sourceBusy,
  onSourceBusy,
  onSources,
  onSourceError,
  health,
  models,
  defaults,
  notify,
  pushDevices,
  onRefresh,
  onReply,
  onDone,
}: {
  sources: WorkSourcesSnapshot | null;
  sourceError: string | null;
  sourceBusy: boolean;
  onSourceBusy: (busy: boolean) => void;
  onSources: (snapshot: WorkSourcesSnapshot) => void;
  onSourceError: (error: string | null) => void;
  health: AccountHealth[];
  models: ModelOption[];
  defaults: ProviderDefaults;
  notify: NotifyPrefs;
  pushDevices: number;
  onRefresh: () => void;
  onReply: (r: AccountReply) => void;
  onDone: (m: string) => void;
}) {
  return (
    <div className="detail settings">
      <ConnectionsSettings
        snapshot={sources}
        error={sourceError}
        busy={sourceBusy}
        onBusy={onSourceBusy}
        onSnapshot={onSources}
        onError={onSourceError}
        onDone={onDone}
      />

      {/* Delivery preferences stay separate from the connections that identify work. */}
      <h2 style={{ fontSize: 17, margin: '34px 0 8px' }}>Alerts</h2>
      <NotifySettings prefs={notify} pushDevices={pushDevices} onDone={onDone} />

      <h2 style={{ fontSize: 17, margin: '34px 0 8px' }}>Agent accounts</h2>

      <p>
        <strong>What is an account here?</strong> It is a Claude or Codex profile folder on this Mac. Claude may use its
        usual <code>~/.claude</code> home. Codex workers must use a dedicated folder such as{' '}
        <code>~/.codex-worker</code> or <code>~/.codex-work</code>, never the interactive <code>~/.codex</code> home;
        that keeps Worker Console's safety hook out of your interactive Codex sessions. Each folder keeps that
        provider's login and worker sessions separate.
      </p>
      <p>
        The console runs a worker <em>as</em> an account by starting that account's provider against its folder. Pick one
        with <strong>Run as</strong> next to “Start a worker”. The provider, account and model are fixed when the worker is{' '}
        <strong>spawned</strong>; use <strong>Restart fresh</strong> to change them after a session exists.
      </p>

      <h3 style={{ fontSize: 14, margin: '22px 0 6px' }}>Your accounts</h3>
      {health.map((h) => (
        <AccountCard
          key={h.name}
          h={h}
          only={health.length === 1}
          models={models}
          defaults={defaults}
          onReply={onReply}
        />
      ))}
      <div className="toolbar">
        <button onClick={onRefresh}>Re-check the files</button>
        <CheckAllLogins names={health.map((h) => h.name)} onReply={onReply} />
        <span className="note">
          the file check is free and automatic; each login check asks that account's provider, so it is a click
        </span>
      </div>

      <h3 style={{ fontSize: 14, margin: '26px 0 6px' }}>Add another account — four steps</h3>
      <ol className="steps">
        <li>
          <p className="step-title">
            <strong>Add it.</strong> Type a name; we suggest the folder to go with it.
          </p>
          <p className="note">
            This only registers the entry — one line in <code>accounts.json</code>. Nothing is created on disk yet, and
            no folder is touched.
          </p>
          <AddAccount onReply={onReply} />
        </li>
        <li>
          <p className="step-title">
            <strong>Link it.</strong> On the new card above, click <strong>Link worker files</strong>.
          </p>
          <p className="note">
            That links the shared skills and provider instructions (<code>CLAUDE.md</code> or <code>AGENTS.md</code>).
            Codex profiles also get the worker write fence. The card prints exactly what the script did.
          </p>
        </li>
        <li>
          <p className="step-title">
            <strong>Log it in.</strong> The card shows one line. Copy it, paste it into the <strong>Terminal</strong>{' '}
            app, press return.
          </p>
          <p className="note">
            Follow the Claude or Codex login prompt for the account you want. The console never sees or types the
            password — this step is yours, always.
          </p>
        </li>
        <li>
          <p className="step-title">
            <strong>Watch it go green.</strong> This page re-checks by itself every few seconds.
          </p>
          <p className="note">
            When the checks on the card are green, the account is ready to pick under <strong>Run as</strong>.
          </p>
        </li>
      </ol>

      <h2 style={{ fontSize: 17, margin: '34px 0 8px' }}>Choosing a model</h2>
      <p>
        Every worker is spawned with a model named explicitly. The choice sits next to “Run as” on the same three cards:{' '}
        <strong>Create a worktree…</strong>, the <strong>start card</strong>, and the fresh-start card when a PR made
        outside the console needs rework. It is made when the worker is <strong>spawned</strong> and holds for the whole
        run; changing it means <strong>Restart fresh</strong>, exactly like the account.
      </p>
      {PROVIDERS.map((provider) => {
        const scoped = modelsForProvider(models, provider);
        if (scoped.length === 0) return null;
        return (
          <div key={provider}>
            <h3 style={{ fontSize: 14, margin: '18px 0 6px' }}>{providerLabel(provider)}</h3>
            <ul>
              {scoped.map((model) => (
                <li key={`${provider}:${model.id}`}>
                  <strong>{model.label}</strong> <code>{model.id}</code> — {model.when}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <p className="note">
        Most specific wins: the picker on the issue → what that issue is stamped with → the account's default above →
        the selected provider's console default (Claude: <code>{defaults.claude || 'not configured'}</code>; Codex:{' '}
        <code>{defaults.codex || 'not configured'}</code>). Changing <strong>Run as</strong> immediately switches the
        model picker to that provider's catalog.
      </p>

      <h2 style={{ fontSize: 17, margin: '34px 0 8px' }}>What the console measures</h2>
      <MetricsTable />

      <details className="report">
        <summary>The small print: what the console can and cannot see</summary>
        <p className="note">
          <strong>“logged in” is a guess from files only.</strong> The console never reads a credential — a <code>?</code>{' '}
          means the provider may keep it somewhere the file check cannot see, such as the macOS Keychain. The card's
          provider-specific command is the source of truth for logging in.
        </p>
        <p className="note">
          Shared skills and instructions are linked into each profile; provider-owned settings and permissions stay
          separate. <strong>Link worker files</strong> refuses to replace a real file and shows exactly what it changed.
          <strong> Remove</strong> deletes the registry entry, never the profile directory.
        </p>
        <p className="note">
          <strong>Known limitation:</strong> provider session history and provider-owned memory stay in each account's
          own folder, so they can diverge. Durable workflow rules live in the shared instructions and skills.
        </p>
      </details>
    </div>
  );
}

/**
 * The manual's diagram: every stage at once, with the five gate stops. It is the
 * static "how it works" picture, not a per-issue status — same styling language
 * as the Spine below, but nothing here ever moves. Orange means the same thing it
 * means everywhere else on this page: the machine stops and waits for you.
 */
const FLOW: Array<{ n: number; label: string; does: string; gate?: GateLetter; asks?: string }> = [
  { n: 0, label: 'Preflight', does: 'worktree, branch, every citation re-checked' },
  { n: 1, label: 'Scope', does: 'the problem, acceptance criteria, open questions', gate: 'A', asks: 'is this the right problem?' },
  { n: 2, label: 'Plan', does: 'sibling sweep, trace to the wire, affected rows', gate: 'B', asks: 'approve the plan' },
  { n: 3, label: 'Build', does: 'TDD, every guardrail shown red first' },
  { n: 4, label: 'Validate', does: 'tests, then the worker drives the app itself' },
  { n: 5, label: 'Understanding', does: 'walkthrough, questions, a click-script for you', gate: 'C', asks: 'your QA passed and you can explain it' },
  { n: 6, label: 'Pre-PR', does: 'impact and design passes, PR body written', gate: 'D', asks: 'approve raising the PR' },
  { n: 7, label: 'PR & review', does: 'PR to dev, then the review rounds' },
  {
    n: 8,
    label: 'Merge',
    does: 'pre-merge checklist',
    gate: 'E',
    asks: 'ready to hand over? the team lead merges — not you, not the agent',
  },
  { n: 9, label: 'Post-merge', does: 'promoted to UAT, QA verifies there, may come back' },
];

function HowItWorks() {
  return (
    <figure className="flow">
      <div className="flow-track">
        {FLOW.map((s) => (
          <div key={s.n} className={`flow-stage ${s.gate ? 'gate' : ''}`}>
            <div className="bar" />
            <div className="n">{s.n}</div>
            <div className="lbl">{s.label}</div>
            <div className="does">{s.does}</div>
            {s.gate && (
              <div className="g">
                gate {s.gate}
                <span>{s.asks}</span>
              </div>
            )}
          </div>
        ))}
        <div className="flow-loop">↩ changes requested on the PR send stage 7 back through build and validate</div>
      </div>
      <div className="flow-legend">
        <span className="key gate">
          <i /> a gate — it waits here until you answer
        </span>
        <span className="key">
          <i /> runs unattended
        </span>
        <span className="key loop">
          <i /> rework loops back
        </span>
      </div>
      <figcaption>
        Five gates, and work does not flow past one on its own. A worker waiting at a gate has exited — it costs nothing
        while it waits.
      </figcaption>
    </figure>
  );
}

/**
 * The console's own manual, `docs/INFO.md`, served by /api/info and read there at
 * request time — so editing the file and reopening this view shows the edit. It
 * is rendered with the same markdown renderer the gate cards use; the document is
 * split at its `##` headings so each section gets an anchor for the contents list.
 */
function InfoView() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/info')
      .then(async (r) => {
        const body = (await r.json()) as { markdown?: string; message?: string };
        if (r.ok && typeof body.markdown === 'string') setMarkdown(body.markdown);
        else setError(body.message ?? 'could not read the manual');
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="detail">
        <p className="note err">{error}</p>
      </div>
    );
  }
  if (markdown === null) {
    return (
      <div className="detail">
        <p className="note">loading…</p>
      </div>
    );
  }

  const sections = splitSections(markdown);
  const contents = sections.filter((s) => s.heading !== null);

  return (
    <div className="detail info">
      <HowItWorks />
      {contents.length > 0 && (
        <nav className="toc">
          <p className="note" style={{ margin: '0 0 4px' }}>
            Contents
          </p>
          <ul>
            {contents.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.heading}</a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {sections.map((s, i) => (
        <section key={s.id || `lead-${i}`} id={s.id || undefined}>
          <Markdown source={s.body} />
        </section>
      ))}
    </div>
  );
}

function Spine({ row, onDone }: { row: IssueRow; onDone: (m: string) => void }) {
  const here = row.stage ?? -1;
  const atGate = row.gate?.gate ?? null;
  const [openGate, setOpenGate] = useState<GateLetter | null>(null);
  const [openReview, setOpenReview] = useState(false);
  const historyFor = (g: GateLetter) => row.history.filter((h) => h.gate === g);
  const reopeningsFor = (g: GateLetter) => row.reopenings.filter((r) => r.gate === g);
  // A gate worth opening: one with a recorded exchange, or a passed gate — which
  // can be taken back even on a worktree too old to have a recorded exchange.
  const canOpen = (g: GateLetter) => historyFor(g).length > 0 || row.gatesPassed.includes(g);

  return (
    <>
      <div className="spine">
        {STAGES.map((s) => {
          const done = here > s.n;
          const isHere = here === s.n;
          const passed = s.gate ? row.gatesPassed.includes(s.gate) : false;
          const gateState = s.gate ? (atGate === s.gate ? 'at' : passed ? 'passed' : '') : '';
          // A gate with a recorded exchange, or one that is passed, is clickable
          // to expand: that panel holds the exchange AND the way to take it back.
          const hasHistory = s.gate ? canOpen(s.gate) : false;
          return (
            <div key={s.n} className={`stage ${done ? 'done' : ''} ${isHere ? 'here' : ''}`}>
              <div className="bar" />
              <div className="n">{s.n}</div>
              <div className="lbl">{s.label}</div>
              {s.gate &&
                (hasHistory ? (
                  <button
                    className={`g gbtn ${gateState}`}
                    onClick={() => setOpenGate((cur) => (cur === s.gate ? null : s.gate!))}
                  >
                    gate {s.gate} {gateState === 'passed' ? '✓' : gateState === 'at' ? '← here' : ''}
                    {openGate === s.gate ? ' ▾' : ' ▸'}
                  </button>
                ) : (
                  <div className={`g ${gateState}`}>
                    gate {s.gate}
                    {gateState === 'passed' ? ' ✓' : gateState === 'at' ? ' ← here' : ''}
                  </div>
                ))}
              {/* Stage 7 (PR & review) has no gate but carries the rework rounds. */}
              {s.n === 7 && row.reviewHistory.length > 0 && (
                <button
                  className={`g gbtn ${row.reviewBlock ? 'at' : 'passed'}`}
                  onClick={() => setOpenReview((o) => !o)}
                >
                  reviews ({row.reviewHistory.length}){openReview ? ' ▾' : ' ▸'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {openGate &&
        historyFor(openGate).map((rec, i) => (
          <div className="history-panel" key={i}>
            <GateExchange record={rec} />
          </div>
        ))}
      {/* Reversals sit in the same panel as the decisions they reverse, each one
          naming the round it took back. A reopened gate that was not visible
          here would be a decision that changed silently. */}
      {openGate &&
        reopeningsFor(openGate).map((rec, i) => (
          <div className="history-panel" key={`reopen-${i}`}>
            <ReopenedNote record={rec} />
          </div>
        ))}
      {openGate && (
        <div className="history-panel">
          <ReopenGate row={row} gate={openGate} onDone={onDone} />
        </div>
      )}
      {openReview &&
        row.reviewHistory.map((round, i) => (
          <div className="history-panel" key={`rev-${i}`}>
            <ReviewExchange round={round} />
          </div>
        ))}
    </>
  );
}

/**
 * The QA evidence a worker attached to a gate. Screenshots render inline as real
 * images so the operator sees them before anything is pushed; transcripts, SQL and reports
 * are fetched on demand and shown as expandable text. Every file comes through
 * the fenced, read-only evidence endpoint.
 */
function Evidence({ issue, items, warning }: { issue: number; items: EvidenceItem[]; warning?: string | null }) {
  // An empty box used to mean "no evidence" and "the manifest was unreadable"
  // alike. #4698 was the second of those — twelve real screenshots on disk,
  // every entry written as a bare string, nothing rendered, and the gate
  // approved without them. A refusal now renders even when nothing else does.
  if (items.length === 0 && !warning) return null;
  return (
    <div className="evidence">
      <p className="note" style={{ margin: '0 0 6px' }}>
        Evidence — the same artifacts that go in the PR, for you to check now:
      </p>
      {warning && <p className="note warn-line">{warning}</p>}
      {items.map((it, i) => (
        <EvidenceOne key={i} issue={issue} item={it} />
      ))}
    </div>
  );
}

function EvidenceOne({ issue, item }: { issue: number; item: EvidenceItem }) {
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const url = `/api/issues/${issue}/evidence?path=${encodeURIComponent(item.path)}`;

  if (item.isImage) {
    return (
      <figure className="evi-fig">
        <img src={url} alt={item.caption} loading="lazy" />
        <figcaption>
          {item.caption} <span className="mono note">{item.path.split('/').pop()}</span>
        </figcaption>
      </figure>
    );
  }

  return (
    <div className="evi-text">
      <button
        className="linkish"
        onClick={() => {
          setOpen((o) => !o);
          if (text === null) {
            void fetch(url).then(async (r) => setText(r.ok ? await r.text() : `could not load: ${await r.text()}`));
          }
        }}
      >
        {open ? '▾' : '▸'} {item.kind}: {item.caption}
      </button>
      {open && <pre>{text ?? 'loading…'}</pre>}
    </div>
  );
}

/** Any passed gate, expanded: what the worker asked and how the operator decided it. */
function GateExchange({ record }: { record: GateHistoryRecord }) {
  return (
    <div className="exchange">
      <p style={{ margin: '2px 0 6px' }}>
        <strong>Gate {record.gate}</strong>
        {record.resumedAt && <span className="note"> · decided {new Date(record.resumedAt).toLocaleString()}</span>}
        {record.provider && <span className="note"> · {providerLabel(record.provider)}</span>}
        {record.account && <span className="note"> · profile {record.account}</span>}
        {record.model && <span className="note"> · model {record.model}</span>}
        {record.agentSessionId && (
          <span className="note">
            {' · session '}
            <code>{record.agentSessionId}</code>
          </span>
        )}
      </p>
      {record.summary && <p className="note">Worker asked: {record.summary}</p>}
      {record.questions.length > 0 && (
        <ol>
          {record.questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ol>
      )}
      {/* Everything asked before the decision, in the order it was asked. It is
          part of how the decision was reached, so it lives here for good rather
          than on a card that disappeared when the gate closed. */}
      {record.thread.length > 0 && (
        <div className="thread">
          {record.thread.map((t) => (
            <div className="qa" key={t.id}>
              <p className="q">
                <strong>You asked:</strong> {t.q}
              </p>
              <p className="a">{t.a}</p>
            </div>
          ))}
        </div>
      )}
      <p className="decision">
        <strong>You decided:</strong> {record.decision ?? '(no decision recorded)'}
      </p>
      <Evidence issue={record.issue} items={record.evidence} warning={record.evidenceWarning} />
      {/* A line of the audit trail the parser refused. It is filed against the
          round it came after, because position in an append-only file is the
          only thing a rejected line still tells us. */}
      {record.quarantined && <p className="note warn-line">{record.quarantined}</p>}
    </div>
  );
}

/** A gate decision you took back, shown beside the decision it reverses. */
function ReopenedNote({ record }: { record: GateReopening }) {
  return (
    <div className="exchange">
      <p style={{ margin: '2px 0 6px' }}>
        <strong>Gate {record.gate} reopened</strong>
        <span className="note"> · {new Date(record.at).toLocaleString()}</span>
        {record.round > 0 && <span className="note"> · takes back round {record.round}</span>}
      </p>
      <p className="decision">
        <strong>What changed:</strong> {record.message}
      </p>
      <p className="note">
        The worker was sent back to stage {record.stage} with this. Nothing already written was undone — the round above
        stands exactly as it was decided.
      </p>
    </div>
  );
}

/**
 * Take back a decision you have already made on this gate.
 *
 * Cheap, because nothing about the work is gone: the session is resumable, the
 * worktree is on disk, and the gate history is append-only. So a gate approved
 * on an assumption that turned out to be wrong does not mean living with it.
 *
 * The correction is REQUIRED — reopening without saying what changed tells the
 * worker nothing — and the confirm says plainly what this does and what it does
 * not do, because "reopen" could easily be read as "undo the code", and it is
 * not that.
 */
function ReopenGate({ row, gate, onDone }: { row: IssueRow; gate: GateLetter; onDone: (m: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const stage = STAGES.find((s) => s.gate === gate);
  const said = text.trim();

  if (row.live) {
    return (
      <p className="note">
        A worker is running on #{row.number} right now. Stop it first if you want to take gate {gate} back.
      </p>
    );
  }
  // It is parked at this very gate — an earlier round of it is in the history
  // above. The card is asking the question; answering it there is the point.
  if (row.gate?.gate === gate) {
    return (
      <p className="note">
        The worker is stopped at gate {gate} right now. Answer it on the card below rather than reopening it.
      </p>
    );
  }
  if (row.status === 'queued') {
    return (
      <p className="note">
        #{row.number} is queued and runs as soon as a slot frees. Reopening a gate is available again once it has —
        whatever you have already sent is what runs first.
      </p>
    );
  }
  if (row.sessionId === null) {
    return (
      <p className="note">
        There is no worker session on this machine for #{row.number}, so there is nothing to send back to gate {gate}.
      </p>
    );
  }

  return (
    <div className="reopen">
      <p className="note" style={{ margin: '0 0 6px' }}>
        Changed your mind about gate {gate}? Say what changed and the worker goes back to stage {stage?.n} (
        {stage?.label}) with it. This does <strong>not</strong> undo any code that has already been written.
      </p>
      <textarea
        placeholder={`What changed about gate ${gate}? e.g. "the org filter should be sysadmin-only, not any admin".`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
        style={{ minHeight: 84 }}
      />
      <div className="gate-actions">
        <button
          disabled={busy || !said}
          onClick={() => {
            const ok = window.confirm(
              `Reopen gate ${gate} on #${row.number}?\n\n` +
                `This does NOT undo code that has already been written — nothing is reverted, no commit is touched, ` +
                `and the decision you made stays in the history exactly as it was.\n\n` +
                `It sends the worker back to stage ${stage?.n} (${stage?.label}) with your correction, and it may ` +
                `redo work that is already done.\n\n` +
                `What changed:\n${said}`,
            );
            if (!ok) return;
            setBusy(true);
            void post(`/api/issues/${row.number}/reopen-gate`, { gate, message: said }).then((out) => {
              setBusy(false);
              if (out.ok) setText('');
              onDone(out.message);
            });
          }}
        >
          Reopen gate {gate}
        </button>
        <span className="note">asks first, and it is recorded here for ever</span>
      </div>
    </div>
  );
}

/**
 * One rework round, expanded: what the reviewer asked, and how the round ended —
 * the operator kicking it off, or the round resolving itself when the ask went away.
 * Rounds are never deleted, so this is the whole story either way.
 */
function ReviewExchange({ round }: { round: ReviewRound }) {
  const resolvedItself = Boolean(round.resolvedBy) && round.resolvedBy !== 'operator';
  return (
    <div className="exchange">
      <p style={{ margin: '2px 0 6px' }}>
        <strong>Round {round.round}</strong> · {round.reviewer || 'a reviewer'}
        {round.resumedAt && <span className="note"> · reworked {new Date(round.resumedAt).toLocaleString()}</span>}
        {round.account && <span className="note"> · ran under {round.account}</span>}
      </p>
      {round.requestedChanges && <pre>{round.requestedChanges}</pre>}
      {resolvedItself ? (
        <p className="decision">
          <strong>Cleared itself:</strong> {round.resolution ?? 'the ask no longer stands'}
          {round.resolvedAt && <span className="note"> · {new Date(round.resolvedAt).toLocaleString()}</span>}
        </p>
      ) : (
          <div className="decision">
            <strong>You sent:</strong>
            {/* A <p> collapsed every newline, so a numbered, line-broken answer
                reached the screen as one wall of prose — it read as the agent
                being wordy when it was this element eating the structure. The
                review body above has always used <pre>; a reply is not less
                structured than the ask it answers. */}
            {round.decision ? <pre className="sent">{round.decision}</pre> : <span> (not started yet)</span>}
          </div>
      )}
    </div>
  );
}

/**
 * A worker drafted a comment for a third party and stopped. The operator reviews the
 * draft (editable), and one click posts it — the only GitHub write the console
 * makes. The text in the box is exactly what gets posted.
 */
/**
 * State that belongs to ONE issue, and must not survive being shown another.
 *
 * THE BUG THIS EXISTS FOR. The cards under Detail are not remounted when the
 * operator clicks a different issue — same element, same position, so
 * `useState`'s initialiser never runs again and the previous issue's value stays
 * in the box. On 2026-08-13 that handed #4404's worker the swarm review for
 * #4344/PR #4535 as its rework brief: the text had been seeded while #4344 was
 * open, the operator clicked the button on the card in front of them, and a
 * worker spent a session on another PR's review. From the operator's side it
 * looked like the agent had wandered onto a PR nobody pointed it at — the
 * console had approved one thing and started another.
 *
 * The cause was mine twice over. The per-issue `key` was removed on 2026-08-12
 * to stop a card stacking, which is what stopped the remount; then when the same
 * leak surfaced on PostMergeCard I patched that one card and did not sweep for
 * the pattern. Six other seeds had it, two of them carrying text that gets SENT
 * — this one, and the comment body posted to GitHub under the operator's name.
 *
 * So it is a hook, not a per-card fix: one place to be right, and a test that
 * fails if a card seeds from `row` without it.
 *
 * The operator's own edits survive within one issue. Only crossing to a
 * different issue re-seeds — which is the whole point.
 */
function useIssueState<T>(issue: number, seed: T): [T, (v: T) => void] {
  const [held, setHeld] = useState<{ issue: number; value: T }>({ issue, value: seed });
  if (held.issue !== issue) {
    // Setting state during render is the sanctioned derived-state escape hatch:
    // React discards this render and re-runs with the new value, before anything
    // is shown. Returning `seed` here keeps THIS render honest either way.
    setHeld({ issue, value: seed });
    return [seed, (v: T) => setHeld({ issue, value: v })];
  }
  return [held.value, (v: T) => setHeld({ issue, value: v })];
}

function CommentCard({ row, onDone }: { row: IssueRow; onDone: (m: string) => void }) {
  const req = row.commentRequest!;
  const target = req.target ?? { kind: 'issue' as const, number: req.issue };
  const targetLabel = target.kind === 'pr' ? `PR #${target.number}` : `#${target.number}`;
  const isDecision = req.kind === 'decision';
  const addressee = req.to?.known ? req.to.handle : req.addressee || 'the product owner';
  // Posted to GitHub under the operator's name — a leak here comments on the wrong target.
  const [body, setBody] = useIssueState(row.number, req.draftBody);
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<string | null>(null);

  // Something on this issue has already been answered and is queued, so this
  // draft is not what is waiting on you — and a Post button here would run
  // ahead of the answer that is already in line.
  if (row.status === 'queued') {
    return <AnsweredCard title="Draft comment — answered, waiting for a free slot" row={row} />;
  }

  return (
    <div className="gate-card">
      <h2>
        {isDecision ? `Question for ${addressee} — post on ${targetLabel}?` : `Draft comment — post on ${targetLabel}?`}
      </h2>
      {isDecision ? (
        <p className="note">{req.why}</p>
      ) : (
        <dl className="facts">
          <dt>to</dt>
          <dd>
            {req.to?.known ? <strong>{req.to.handle}</strong> : 'nobody named'}
            {req.to?.why ? <span className="muted"> — {req.to.why}</span> : null}
          </dd>
          <dt>why</dt>
          <dd>{req.why || '—'}</dd>
          <dt>after posting</dt>
          <dd>
            {req.blocks ? (
              <>
                waits for a reply from <strong>{req.addressee || 'the addressee'}</strong>
              </>
            ) : (
              'continues — no reply needed'
            )}
          </dd>
        </dl>
      )}
      <p className="note">
        This posts <strong>exactly</strong> the text below on {targetLabel}, as you. Nothing else — the console cannot
        edit, close, or label. Edit it first if you like.
      </p>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} style={{ minHeight: 140 }} />
      <div className="gate-actions">
        <button
          className="primary"
          disabled={busy || !body.trim()}
          onClick={() => {
            setBusy(true);
            void post(`/api/issues/${row.number}/comment`, { body }).then(
              (out: { ok: boolean; message: string; url?: string }) => {
                setBusy(false);
                if (out.ok && out.url) setPosted(out.url);
                onDone(out.message);
              },
            );
          }}
        >
          {isDecision ? 'Post this question' : 'Post this comment'}
        </button>
        {/* The card used to be a one-way door. A draft whose moment has passed —
            the ticket closed, the question answered elsewhere — needed a worker-
            owned file deleted by hand to clear it. This posts nothing and writes
            nothing to the worktree; it just marks the draft consumed. */}
        <button
          disabled={busy}
          onClick={() => {
            if (!window.confirm('Discard this draft without posting it?')) return;
            setBusy(true);
            void post(`/api/issues/${row.number}/comment/discard`, { requestedAt: req.requestedAt }).then(
              (out: { ok: boolean; message: string }) => {
                setBusy(false);
                onDone(out.message);
              },
            );
          }}
        >
          Discard draft
        </button>
        <span className="note">one comment, on your click only</span>
      </div>
      {posted && (
        <p className="note">
          Posted:{' '}
          <a href={posted} target="_blank" rel="noreferrer">
            {posted}
          </a>{' '}
          — you can edit or delete it on GitHub if it's wrong.
        </p>
      )}
    </div>
  );
}

/** The ticket is parked on a posted comment: waiting, or a reply has landed. */
function BlockedCard({
  row,
  onDone,
  onRefresh,
}: {
  row: IssueRow;
  onDone: (m: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const b = row.commentBlock!;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const canResume = row.sessionId !== null;

  const resume = (message: string) => {
    setBusy(true);
    void post(`/api/issues/${row.number}/resume`, { message }).then((out) => {
      setBusy(false);
      onDone(out.message);
    });
  };

  // Answered while the desk was full: the reply has been sent on and is waiting
  // for a slot, not for you.
  if (row.status === 'queued') {
    return (
      <AnsweredCard
        title={b.reply ? `${b.reply.author}'s reply — answered, waiting for a free slot` : 'Answered, waiting for a free slot'}
        row={row}
      />
    );
  }

  return (
    <div className={b.reply ? 'gate-card' : 'report'}>
      <h2 style={b.reply ? undefined : { fontSize: 14, margin: '8px 0' }}>
        {b.reply ? `${b.reply.author} replied` : `Waiting on ${b.addressee || 'a reply'}`}
      </h2>
      <p className="note">
        Posted {new Date(b.postedAt).toLocaleString()}
        {b.commentUrl && (
          <>
            {' · '}
            <a href={b.commentUrl} target="_blank" rel="noreferrer">
              view comment
            </a>
          </>
        )}
      </p>

      {b.reply ? (
        <>
          <pre>{b.reply.body}</pre>
          <p className="note">Resume the worker with the answer — edit it first if you want to add anything:</p>
          <textarea
            value={text || b.reply.body}
            onChange={(e) => setText(e.target.value)}
            disabled={!canResume || busy}
          />
          <div className="gate-actions">
            <button className="primary" disabled={!canResume || busy} onClick={() => resume(text || b.reply!.body)}>
              Resume with this answer
            </button>
          </div>
          {!canResume && <p className="note err">No session id on disk, so the console cannot resume this worker.</p>}
        </>
      ) : (
        <>
          <p className="note">
            Only replies posted <strong>on this issue</strong> are detected. A Slack or email reply is invisible to the
            console — if the answer came that way, resume the worker yourself with it.
          </p>
          <p className="note">
            If this was only a heads-up, or the dependency is now resolved, clear the wait here. This does not run or
            restart a worker, and it changes nothing on GitHub.
          </p>
          <div className="gate-actions">
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void post(`/api/issues/${row.number}/comment-block/resolve`, { postedAt: b.postedAt })
                  .then(async (out) => {
                    onDone(out.message);
                    if (!out.ok) return;
                    try {
                      await onRefresh();
                    } catch (error) {
                      const reason = error instanceof Error ? error.message : String(error);
                      onDone(`wait resolved; display refresh failed — reload (${reason})`);
                    }
                  })
                  .catch((error: Error) => onDone(`could not clear the wait: ${error.message}`))
                  .finally(() => setBusy(false));
              }}
            >
              Resolved — no reply needed
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A PR got a review that requested changes. The operator kicks off the rework — one click
 * resumes the SAME worker with the requested changes, which it works on and
 * pushes to the PR branch exactly as Stage 7 already does. The console posts
 * nothing to GitHub here; it only runs the local worker.
 *
 * When the PR was made OUTSIDE the console there is no session to resume, so the
 * same click starts a FRESH worker in the existing worktree instead: the skill's
 * resume mode plus this brief. That path takes an account, like any first spawn.
 */
function ReworkCard({
  row,
  accounts,
  models,
  defaults,
  health,
  onDone,
}: {
  row: IssueRow;
  accounts: AccountSummary[];
  models: ModelOption[];
  defaults: ProviderDefaults;
  health: AccountHealth[];
  onDone: (m: string) => void;
}) {
  const block = row.reviewBlock!;
  // Only a round still waiting on you belongs on this card. A round that resolved
  // itself — the reviewer moved on, or the rework was pushed outside the console
  // — is history, and history lives on the spine.
  const actionable = block.rounds.filter((r) => r.decision === null && !r.resolvedBy);
  const round = actionable[actionable.length - 1] ?? null;
  // THE ONE THAT BIT: #4404's worker was handed #4344's review from this box.
  const [text, setText] = useIssueState(row.number, round?.requestedChanges ?? '');
  const [busy, setBusy] = useState(false);
  const canResume = row.sessionId !== null;
  const fallback = row.account ?? accounts.find((a) => a.isDefault)?.name ?? accounts[0]?.name ?? '';
  const [account, setAccount] = useIssueState(row.number, fallback);
  const provider = providerOfAccount(accountNamed(accounts, account));
  const [model, setModel] = useIssueState(
    row.number,
    providerModel(models, defaults, provider, row.modelResolved),
  );
  const multi = accounts.length > 1;

  const send = (path: string, body: unknown) => {
    setBusy(true);
    void post(`/api/issues/${row.number}/${path}`, body).then((out) => {
      setBusy(false);
      onDone(out.message);
    });
  };

  // The last round resolved between the poll and this render: nothing to ask.
  if (!round) return null;

  // The brief was taken while every slot was busy. Same treatment as the gate
  // card: no button, because pressing it again would only replace an answer the
  // console has already promised to run.
  if (row.status === 'queued') {
    return <AnsweredCard title="Rework — brief taken, waiting for a free slot" row={row} />;
  }

  return (
    <div className="gate-card">
      <h2>Changes requested — start the rework?</h2>
      <dl className="facts">
        <dt>reviewer</dt>
        <dd>{round.reviewer || '(a reviewer)'}</dd>
        <dt>on</dt>
        <dd>PR #{block.pr}</dd>
        <dt>requested</dt>
        <dd>{round.requestedAt ? new Date(round.requestedAt).toLocaleString() : '—'}</dd>
      </dl>
      {canResume ? (
        <p className="note">
          This resumes the worker with the changes below — it works on the PR branch and pushes there, exactly as Stage
          7 already does. The console posts <strong>nothing</strong> to GitHub. Edit the brief first if you like.
        </p>
      ) : (
        <p className="note">
          There is no worker session on this machine for #{row.number} — this PR was made outside the console. So this
          starts a <strong>new</strong> worker in the existing worktree with{' '}
          <code>{provider === 'codex' ? '$issue-pipeline' : '/issue-pipeline'} {row.number} resume</code> plus the brief below:
          the skill's resume mode rebuilds its
          context from the worktree's own files. The worktree, the branch and PR #{block.pr} are untouched, and the
          console still posts <strong>nothing</strong> to GitHub.
        </p>
      )}
      <textarea value={text} onChange={(e) => setText(e.target.value)} disabled={busy} style={{ minHeight: 140 }} />
      {!canResume && (
        <>
          <RunAs
            accounts={accounts}
            value={account}
            onChange={(name) => {
              setAccount(name);
              setModel(modelForAccount(models, defaults, accountNamed(accounts, name)));
            }}
            busy={busy}
          />
          <RunOn models={models} provider={provider} value={model} onChange={setModel} busy={busy} />
          <AccountWarning h={healthOf(health, account)} />
        </>
      )}
      <div className="gate-actions">
        {canResume ? (
          <button
            className="primary"
            disabled={busy || !text.trim()}
            onClick={() => send('resume', { message: text.trim() })}
          >
            Start rework
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || !text.trim()}
            onClick={() => send('rework-fresh', { brief: text.trim(), account: multi ? account : undefined, model })}
          >
            Start fresh worker for rework
          </button>
        )}
        <span className="note">runs the worker on your click only</span>
      </div>
    </div>
  );
}

/**
 * Any card whose answer was taken while every slot was busy.
 *
 * ONE component, used by every card that asks the operator something, because the failure
 * it prevents is the same everywhere: a button still sitting there after a click
 * that was, in fact, accepted. That reads as "the click did nothing", which is
 * exactly the bug the queued state was added to fix — and it was fixed on the
 * gate card only, so answering a rework or a landed reply at capacity still
 * looked dead.
 */
function AnsweredCard({ title, row, question = false }: { title: string; row: IssueRow; question?: boolean }) {
  return (
    <div className="gate-card answered">
      <h2>{title}</h2>
      <p style={{ margin: '0 0 6px' }}>
        Your {question ? 'question' : 'answer'} is saved and this issue is{' '}
        <strong>{row.queuePosition === 1 ? 'next up' : `${row.queuePosition ?? '—'} in line`}</strong>. The worker{' '}
        {question
          ? 'answers it and stops at the same gate again as soon as a slot frees — the gate is still yours to decide'
          : 'resumes with exactly what you wrote as soon as a slot frees'}
        {' '}— you do not need to press anything again, and it survives a console restart.
      </p>
      {question && <GateThread record={row.gateThread} row={row} />}
      <p className="note">
        Changed your mind? {question ? 'Take this out of the queue below to drop the question.' : ''} Send a new answer
        by taking this out of the queue below and answering again — the newest answer is always the one that runs.
      </p>
    </div>
  );
}

/**
 * Turn a localhost URL written in prose into something clickable.
 *
 * The operator asked for these links to be clearly visible in the body of the
 * text. A worker that mentions http://localhost:8106 in its summary is saying
 * where to look, and making the operator copy it out by hand is the difference
 * between QA they do and QA they skip.
 *
 * ONLY localhost. Everything else stays plain text — the same fence as
 * manual-qa.ts, for the same reason: a worker reads issue text and web pages,
 * and a link the console renders is a link the console is vouching for.
 */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s<>"')\]]*)?/g;

function Linkify({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LOCAL_URL)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <a key={`${at}`} href={m[0]} target="_blank" rel="noreferrer">
        {m[0]}
      </a>,
    );
    last = at + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

/** A date and a time, short: "12 Aug 14:32". Every tick and every fix is stamped. */
const stamp = (iso: string): string =>
  new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const wordCount = (s: string): number => s.split(/\s+/).filter((w) => w.length > 0).length;

/**
 * Long prose, folded to a few lines behind a "more".
 *
 * The card's own text is short by rule, but a worker's is not always: "the text
 * is incredibly wordy" was the complaint, and the console cannot make a worker
 * write less. What it CAN do is refuse to hand an essay the whole page. Nothing
 * is dropped — one tap opens it — and short text passes through untouched, so
 * the toggle only ever appears where it earns its place.
 */
function Clamp({ text, limit = 26 }: { text: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  const long = wordCount(text) > limit;
  // The word count only decides whether to MEASURE. Whether the toggle appears
  // is measured, because the same sentence overflows on a phone and fits on a
  // desktop — and a "more" that reveals nothing is its own small lie.
  useEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setOver(el.scrollHeight - el.clientHeight > 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  if (!long) return <Linkify text={text} />;
  return (
    <>
      <span ref={ref} className={open ? 'clamp open' : 'clamp'}>
        <Linkify text={text} />
      </span>
      {(over || open) && (
        <>
          {' '}
          <button className="linkish" onClick={() => setOpen(!open)}>
            {open ? 'less' : 'more'}
          </button>
        </>
      )}
    </>
  );
}

/**
 * The gate summary, as labelled bullets rather than a block of prose.
 *
 * The operator highlighted the whole of a gate C summary — about 250 words in
 * one unbroken paragraph, the first thing on the card — and asked for it bullet-
 * pointed, clearer and simpler. The information in it is worth having, so this
 * restructures rather than deletes:
 * what was driven, what was confirmed, what is honestly not proven, where to
 * start. A worker that writes a paragraph anyway gets it clamped, because the
 * console's answer to an essay is never to give it more room.
 */
function GateSummary({ text }: { text: string }) {
  const s = parseGateSummary(text);
  return (
    <div className="sum">
      {s.degraded !== null && <p className="note err">Degraded run — {s.degraded}</p>}
      {s.groups.map((g) => (
        <div className="sum-group" key={g.label}>
          <p className="sum-label">{g.label}</p>
          {g.items.length === 1 ? (
            <p className="sum-one">
              <Clamp text={g.items[0]!} limit={22} />
            </p>
          ) : (
            <ul className="sum-list">
              {g.items.map((it, i) => (
                <li key={i}>
                  <Clamp text={it} limit={22} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {s.prose !== null && (
        <p className="sum-prose">
          <Clamp text={s.prose} limit={22} />
        </p>
      )}
    </div>
  );
}

/** A short fact about a step that is not prose: "no capture", "New — nothing to compare". */
function QaChip({ text, warn = false }: { text: string; warn?: boolean }) {
  return <span className={warn ? 'qa2-chip qa2-chip--warn' : 'qa2-chip'}>{text}</span>;
}

/**
 * IS THIS CAPTURE A PICTURE?
 *
 * A real incident: the operator saw evidence listed and then declared
 * unavailable in the same breath — on cards where every text capture was called
 * missing while the screenshots beside them rendered.
 *
 * They were all being drawn as `<img>`. A `.txt` cannot decode as an image, so
 * `onError` fired, and the code turned a browser decode failure into "no
 * capture — … is not in the worktree". Measured against the live console at
 * the time: `http-evidence.txt` answered HTTP 200, `text/plain`, 2,229 bytes.
 * The file was there, served, and reported missing.
 *
 * Workers capture terminal output far more often than screens — `.txt`, `.log`,
 * `.md` — so this was most of the evidence on most gate C cards.
 */
const IMAGE_CAPTURE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

/**
 * One half of the before/after pair: the words, then the picture of them.
 *
 * The picture is what lets the words be short. The operator's rule — a manual QA
 * before/after is ONE question, not one point for the before and another for the
 * after — is held by the shape above this: there is no way to render a before
 * without the after beside it.
 */
function QaHalf({
  issue,
  label,
  text,
  shot,
  gone = false,
  empty,
  warn = false,
}: {
  issue: number;
  label: string;
  text: string | null;
  shot: string | null;
  /** This half NAMED a capture and the console could not find the file. */
  gone?: boolean;
  empty: string;
  warn?: boolean;
}) {
  const [broke, setBroke] = useState(false);
  const url = shot ? `/api/issues/${issue}/evidence?path=${encodeURIComponent(shot)}` : null;
  // A text capture is EVIDENCE, not a failed picture. It gets a link that says
  // what it is; only an image is ever put in an `<img>`, so only an image can
  // ever fail to decode.
  const isImage = shot !== null && IMAGE_CAPTURE.test(shot);
  // A CAPTURE THE CONSOLE CANNOT FIND IS SAID IN WORDS, never rendered as an
  // `<img>` that is going to fail. A real incident, on a whole click-script of
  // them: the screenshots did not appear, and the operator had to chase evidence
  // for each step by hand — often enough to be the norm. What they were looking
  // at was the browser's own broken-image icon — a grey box with a question mark
  // and no text anywhere near it — because this rendered every declared path
  // whether or not anything was behind it. The scan already knew (`goneShots`).
  //
  // `broke` is the same answer for the residual race the stamp cannot cover: a
  // file that is deleted between the poll and this paint, or one the route
  // refuses for a reason the scan does not model. The picture failing is itself
  // the fact, so it is reported rather than left as a glyph.
  // `broke` counts only for images now: it was the decode failure of a text
  // file that produced the false "not in the worktree" on every one of them.
  // `gone` still counts for both — that one is the console stat-ing the file
  // and finding nothing, which is true whatever the extension.
  const unviewable = url !== null && (gone || (isImage && broke));
  return (
    <div className="qa2-half">
      <p className="qa2-label">{label}</p>
      <p className="qa2-text">{text ? <Clamp text={text} limit={18} /> : <QaChip text={empty} warn={warn} />}</p>
      {unviewable ? (
        // The filename, and the link, both kept. Evidence was asked for and the
        // worker named a file: the name is the thing to quote back at it, and
        // the link answers WHY in plain text from the evidence route itself
        // ("not found: could not open the evidence file", or a refusal).
        <p className="qa2-text">
          <a className="qa2-gone" href={url!} target="_blank" rel="noreferrer">
            <QaChip text={`no capture — ${basename(shot!)} is not in the worktree`} warn />
          </a>
        </p>
      ) : url !== null && !isImage ? (
        // Terminal output, a log, a markdown report. Named and linked, because
        // that is what it is — and never claimed to be missing.
        <p className="qa2-text">
          <a className="qa2-file" href={url} target="_blank" rel="noreferrer">
            {basename(shot!)} ↗
          </a>
        </p>
      ) : url !== null ? (
        <a className="qa2-shot" href={url} target="_blank" rel="noreferrer">
          <img
            src={url}
            alt={`${label}: ${text ?? empty}`}
            loading="lazy"
            onError={() => setBroke(true)}
          />
        </a>
      ) : (
        <p className="qa2-text">
          <QaChip text="no capture" />
        </p>
      )}
    </div>
  );
}

/** The last segment of a worktree-relative path — `qa-5505/after-3.png` reads as
 *  `after-3.png`, which is the part a person quotes back to a worker. */
function basename(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * A step's whole past, folded away: failed, what was changed, re-verified.
 *
 * The understanding a step has earned has to stay visible at the gate — so a
 * step that came back fixed carries its own trail, on the step, at the gate,
 * every round. The screenshot the operator was looking at when they failed it is
 * linked from here rather than replaced: the console snapshotted its path at the
 * moment of the fail, so a new capture never unlinks the old one.
 */
function QaHistory({
  issue,
  step,
  verdicts,
  state,
}: {
  issue: number;
  step: ManualQaStep;
  verdicts: QaVerdict[];
  state: 'unset' | 'verified' | 'failed';
}) {
  const lines: ReactNode[] = [];
  let fixShown = false;
  let seenFail = false;
  const fixLine = (
    <p className="qa2-h-fix" key="fix">
      Fix: {step.fix}
    </p>
  );
  verdicts.forEach((v, i) => {
    if (!fixShown && step.fix !== null && v.rev === step.rev) {
      lines.push(fixLine);
      fixShown = true;
    }
    if (v.status === 'failed') {
      const url = v.shotAtFail ? `/api/issues/${issue}/evidence?path=${encodeURIComponent(v.shotAtFail)}` : null;
      lines.push(
        <p className="qa2-h-line" key={i}>
          Failed {stamp(v.at)} — “{v.note}”
          {url !== null && (
            <>
              {' · '}
              <a href={url} target="_blank" rel="noreferrer">
                old capture
              </a>
            </>
          )}
        </p>,
      );
      seenFail = true;
    } else if (v.status === 'verified') {
      // The operator can always flip their own tick back without sending
      // anything to Build. That is honest and it is theirs to make — so it is
      // recorded as what it was, never dressed up as a fix.
      const noFix = seenFail && v.rev === step.rev && step.fix === null;
      lines.push(
        <p className="qa2-h-line" key={i}>
          {seenFail ? 'Re-verified' : 'Verified'} {stamp(v.at)}
          {noFix ? ' — re-marked by you, no fix was sent' : ''}
        </p>,
      );
    } else {
      lines.push(
        <p className="qa2-h-line" key={i}>
          Cleared {stamp(v.at)}
        </p>,
      );
    }
  });
  if (!fixShown && step.fix !== null) lines.push(fixLine);
  if (state === 'unset' && step.rev > 1) {
    lines.push(
      <p className="qa2-h-line" key="await">
        Awaiting your re-check
      </p>,
    );
  }
  return (
    <details className="qa2-history">
      <summary>History</summary>
      {lines}
    </details>
  );
}

/**
 * One QA step: what to do, both states side by side, and the tick that is yours.
 *
 * The tick is written to the console's own state file and nowhere a worker can
 * reach — that is what makes it worth anything. It is keyed to the step's id AND
 * its revision, so a step that comes back fixed comes back UNSET while the other
 * nine keep the ticks already given them. You re-check one thing, not nine.
 */
function QaStepBlock({
  row,
  step,
  view,
  samePage,
  onDone,
}: {
  row: IssueRow;
  step: ManualQaStep;
  view: QaStepView | null;
  samePage: boolean;
  onDone: (m: string) => void;
}) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const state = view?.state ?? 'unset';

  const tick = async (status: 'verified' | 'failed' | 'cleared', words: string | null) => {
    setSaving(true);
    const out = await post(`/api/issues/${row.number}/qa-verdict`, {
      stepId: step.id,
      rev: step.rev,
      status,
      note: words,
    });
    setSaving(false);
    // A tick that landed says so by turning green — a toast for each of nine
    // steps is noise. A tick that was REFUSED has to be read.
    if (!out.ok) {
      onDone(out.message);
      return;
    }
    setNoting(false);
    setNote('');
  };

  const history = row.qaVerdicts.filter((v) => v.stepId === step.id);
  // The operator's LAST word on this revision was a tick, and the tick still
  // reads unset: the worker edited the step's words without bumping anything,
  // and the console dropped the tick rather than let them inherit one for text
  // they never read. Read backwards and stop at the first one, or the operator's
  // own undo reads as the worker having tampered with the step.
  const lastAtRev = [...history].reverse().find((v) => v.rev === step.rev) ?? null;
  const edited = state === 'unset' && lastAtRev !== null && lastAtRev.status !== 'cleared';
  const fixed = state === 'unset' && step.rev > 1 && !edited;
  const isNew = step.before === null && step.beforeShot === null;
  const missing = view?.missing ?? false;
  // Which halves named a capture the console could not find. Absent reads as
  // none: an older snapshot, or a step no scan has stamped, accuses nobody.
  const gone = step.goneShots ?? [];
  // THE PAIR THAT IS THE SAME PICTURE TWICE. The operator caught one by eye — a
  // before and an after that plainly looked the same — and byte-identical is the
  // only version of that claim the console can make without judgement: it is
  // either a step pointed at a screen the change does not touch, or a baseline
  // server running the same code. Either way it is not evidence of anything, and
  // the step it is on is where that has to be said.
  const identical = row.captureReport?.identical?.includes(step.id) ?? false;

  return (
    <li className={`qa2-step qa2-step--${state}`}>
      <p className="qa2-do">
        <span className="qa2-n">{step.id}</span>
        <span className="qa2-doc">
          <Clamp text={step.do} limit={16} />
          {step.url !== null && !samePage && (
            <>
              {' '}
              <a className="qa2-open" href={step.url} target="_blank" rel="noreferrer">
                open
              </a>
            </>
          )}
          {step.url !== null && samePage && <span className="qa2-samepage">same page</span>}
        </span>
      </p>

      <div className="qa2-pair">
        {isNew ? (
          <div className="qa2-half">
            <p className="qa2-label">Was</p>
            <p className="qa2-text">
              <QaChip text="New — nothing to compare" />
            </p>
          </div>
        ) : (
          <QaHalf
            issue={row.number}
            label="Was"
            text={step.before}
            shot={step.beforeShot}
            gone={gone.includes('before')}
            empty="no note — read the capture"
          />
        )}
        <QaHalf
          issue={row.number}
          label="Now"
          text={step.after}
          shot={step.afterShot}
          gone={gone.includes('after')}
          empty="no expected result — judge it yourself"
          warn
        />
      </div>

      {(fixed || edited || missing || identical) && (
        <p className="qa2-flags">
          {identical && (
            <QaChip text="The before and after are the same picture, byte for byte — this pair proves nothing" warn />
          )}
          {/* The worker's last rewrite of .gate.json does not contain this step.
              It is here, with your tick, because the console kept its own copy —
              and it still counts towards Approve, so a rework cannot shrink the
              QA it is being held to. Worded for what it IS rather than for how it
              usually happens: a rework that dropped it is the common cause, not
              the only one. */}
          {missing && <QaChip text="Missing from the worker's latest gate file — the console kept this copy" warn />}
          {fixed && <QaChip text="Fixed — check it again" />}
          {edited && <QaChip text="Changed since you ticked it — check it again" warn />}
        </p>
      )}

      <div className="qa2-verify">
        {state === 'unset' && !noting && (
          <>
            <button className="qa2-ok" disabled={saving} onClick={() => void tick('verified', null)}>
              Verified
            </button>
            <button className="qa2-no" disabled={saving} onClick={() => setNoting(true)}>
              Failed
            </button>
          </>
        )}
        {state === 'verified' && (
          <>
            <span className="qa2-set ok">✓ Verified{view?.at ? ` · ${stamp(view.at)}` : ''}</span>
            <button className="linkish" disabled={saving} onClick={() => void tick('cleared', null)}>
              undo
            </button>
          </>
        )}
        {state === 'failed' && !noting && (
          <>
            <span className="qa2-set bad">
              ✗ Failed{view?.at ? ` · ${stamp(view.at)}` : ''}
              {view?.note ? ` — “${view.note}”` : ''}
            </span>
            <button
              className="linkish"
              disabled={saving}
              onClick={() => {
                setNote(view?.note ?? '');
                setNoting(true);
              }}
            >
              change
            </button>
          </>
        )}
      </div>

      {noting && (
        <div className="qa2-note">
          <textarea
            rows={2}
            placeholder="What you saw instead"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={saving}
          />
          <div className="qa2-note-actions">
            {/* A fail with no words is not actionable rework — the worker builds
                the fix from exactly these words, so Save waits for them. */}
            <button disabled={saving || !note.trim()} onClick={() => void tick('failed', note.trim())}>
              Save
            </button>
            <button
              className="linkish"
              disabled={saving}
              onClick={() => {
                setNoting(false);
                setNote('');
              }}
            >
              cancel
            </button>
            {state === 'failed' && (
              <button className="linkish" disabled={saving} onClick={() => void tick('verified', null)}>
                mark verified instead
              </button>
            )}
          </div>
        </div>
      )}

      {(step.rev > 1 || history.length > 1) && (
        <QaHistory issue={row.number} step={step} verdicts={history} state={state} />
      )}
    </li>
  );
}

/**
 * "Run it yourself" — the click-script, with real links and a tick per step.
 *
 * The second of the three things the operator asked a gate C to be: not proof
 * that the agent did the work (that is the evidence above it), but the shortest
 * path to checking it yourself. Where the app is, what to sign in as, what to click, and
 * — the part a screenshot cannot carry — what it looked like BEFORE.
 *
 * The password shown here is the documented shared local-dev account and nothing
 * else; the console never types it anywhere, and only a localhost app is ever
 * linked from this card.
 */
function ManualQaCard({
  row,
  canResume,
  busy,
  onDone,
  allowRework = true,
  warningsShownAbove = false,
}: {
  row: IssueRow;
  canResume: boolean;
  busy: boolean;
  onDone: (m: string) => void;
  /** The targeted rework belongs to gate C. Elsewhere the click-script still
   *  renders and still ticks — there is just no gate C to send a step back to. */
  allowRework?: boolean;
  /** The gate C card carries every warning in one block at the top, so the two
   *  it would otherwise repeat here are suppressed rather than said twice. Left
   *  false everywhere else, where this card is the only thing on screen. */
  warningsShownAbove?: boolean;
}) {
  const [sending, setSending] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const qa = row.gateManualQa;
  if (!qa) return null;
  const app = qa.appUrl ?? (row.port ? `http://localhost:${row.port}` : null);
  const views = new Map(row.qaSteps.map((v) => [v.id, v]));
  const failed = row.qaSteps.filter((v) => v.state === 'failed').map((v) => v.id);
  const rw = row.qaRework;

  const sendRework = async () => {
    setSending(true);
    const out = await post(`/api/issues/${row.number}/qa-rework`);
    setSending(false);
    onDone(out.message);
  };

  const capture = async () => {
    setCapturing(true);
    const out = await post(`/api/issues/${row.number}/capture`);
    setCapturing(false);
    onDone(out.message);
  };

  return (
    <div className="qa-script">
      {app !== null && (
        <p className="qa-line">
          <span className="qa-k">App</span>
          <a href={app} target="_blank" rel="noreferrer">
            {app}
          </a>
          {qa.appUrl === null && <span className="note"> — from the worktree registered port</span>}
        </p>
      )}
      {app === null && <p className="note err">No app link. Ask it for one before approving.</p>}
      {/* The login is COPYABLE, not just readable: retyping a password by hand
          off a screen is the friction that turns a two-minute check into one you
          skip. Nothing here is ever typed for you — the console does not sign
          in anywhere, and this is the published local-dev account, which is why
          it can be on screen at all. */}
      {qa.login !== null && (
        <>
          <CopyLine k="Email" value={qa.login.email} />
          <CopyLine k="Password" value={qa.login.password} />
          <p className="note qa-cred">The published local-dev account — never a real credential. You sign in, not the console.</p>
        </>
      )}
      {qa.login === null && <p className="note">No sign-in given — see docs/LOCAL_DEV_SETUP.md.</p>}
      {qa.start !== null && (
        <p className="qa-line">
          <span className="qa-k">Start</span>
          <Clamp text={qa.start} limit={26} />
        </p>
      )}

      {qa.steps.length > 0 && (
        <ol className="qa2-steps">
          {qa.steps.map((s, i) => (
            <QaStepBlock
              key={s.id}
              row={row}
              step={s}
              view={views.get(s.id) ?? null}
              samePage={i > 0 && s.url !== null && s.url === qa.steps[i - 1]!.url}
              onDone={onDone}
            />
          ))}
        </ol>
      )}
      {qa.steps.length === 0 && <p className="note err">The click-script has no steps. Ask for it again.</p>}

      {/* THE CONSOLE'S OWN CAPTURES. It already ran once, by itself, in the poll
          that first saw this gate — the requirement is that they arrive with no
          human intervention at all, and a button that has to be pressed to get a
          screenshot is the thing being replaced. This block exists for the
          second time round: the dev server was down, the baseline was not up, or
          the pair wants retaking. Whatever happened is stated in one line,
          including when the answer is that nothing could be captured. */}
      {allowRework && (
        <div className="qa2-capture">
          {row.captureReport ? (
            <>
              <p className={row.captureReport.ok ? 'note' : 'note err'}>
                {row.captureReport.line} <span className="qa2-capture-at">{stamp(row.captureReport.at)}</span>
              </p>
              {(row.captureReport.notes ?? []).length > 0 && (
                <ul className="qa2-capture-notes">
                  {(row.captureReport.notes ?? []).map((n, i) => (
                    <li key={i} className="note">
                      {n}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="note">The console has not taken any screenshots for this gate.</p>
          )}
          <button disabled={busy || capturing} onClick={() => void capture()}>
            {capturing ? 'Capturing…' : 'Capture shots'}
          </button>
          <p className="note">
            Drives your dev server headlessly and files the pictures under the plans tree. Only a step with a{' '}
            <code>route</code> can be driven; nothing else is touched.
          </p>
        </div>
      )}

      {/* Failing a step does NOT dispatch. You work down the list ticking, and
          ONE button sends everything you failed in one round — two sequential
          worker runs for two failed steps is the cost the operator objected to. */}
      {allowRework && failed.length > 0 && (
        <div className="qa2-rework">
          <p className="qa2-rework-head">
            {failed.length === 1 ? `Step ${failed[0]} failed.` : `${failed.length} steps failed.`}
          </p>
          <button className="primary" disabled={!canResume || busy || sending} onClick={() => void sendRework()}>
            {failed.length === 1 ? `Send step ${failed[0]} back to Build` : `Send ${failed.length} failed steps back to Build`}
          </button>
          <p className="note">
            Only {failed.length === 1 ? 'that step gets' : 'those steps get'} redone — every other step keeps its tick
            and its screenshots.
          </p>
        </div>
      )}

      {rw !== null && (rw.status === 'queued' || rw.status === 'sent') && (
        <p className="note">
          {rw.stepIds.length === 1 ? `Step ${rw.stepIds[0]}` : `Steps ${rw.stepIds.join(', ')}`}{' '}
          {rw.status === 'queued' ? 'is queued for Build — it goes when a slot frees' : 'is with Build now'}, sent{' '}
          {stamp(rw.sentAt)}.
        </p>
      )}
      {/* Cancelled means it never left: something else the operator sent took its
          place in the queue. Said in red because the failed step is still failed
          and the only thing that moves it is pressing the button again. */}
      {rw !== null && rw.status === 'cancelled' && (
        <p className="note err">
          {rw.stepIds.length === 1 ? `Step ${rw.stepIds[0]}` : `Steps ${rw.stepIds.join(', ')}`} never went to Build —
          the rework you queued at {stamp(rw.sentAt)} was replaced by the next thing you sent. Your ticks are untouched;
          send it again.
        </p>
      )}
      {!warningsShownAbove && rw !== null && rw.violation !== null && (
        <p className="note err">Last rework — {rw.violation}</p>
      )}
      {/* What the parser could not read is invisible everywhere else on this
          card, which is exactly why it has to be said here. Both of these lock
          Approve — see `approveLockC`. */}
      {!warningsShownAbove && qa.dropped > 0 && (
        <p className="note err">
          {qa.dropped === 1 ? 'One step' : `${qa.dropped} steps`} in the click-script came back malformed and could not
          be shown, so this list is shorter than the QA the worker wrote. Ask for the click-script again.
        </p>
      )}

      {qa.edgeCases.length > 0 && (
        <details className="qa2-edge">
          <summary>Also worth trying ({qa.edgeCases.length}) — not gated</summary>
          <ul>
            {qa.edgeCases.map((e, i) => (
              <li key={i}>
                <Clamp text={e} limit={20} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** One labelled value with a copy button — the sign-in the operator types in. */
function CopyLine({ k, value }: { k: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy-line">
      <span className="qa-k">{k}</span>
      <code>{value}</code>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          });
        }}
      >
        {done ? 'copied' : 'copy'}
      </button>
    </div>
  );
}

/** Is there anything in this thread the card must keep showing? */
function threadNeedsAttention(t: GateThreadRecord | null): boolean {
  if (!t) return false;
  if (t.violation) return true;
  return t.entries.some((e) => e.answer === null && e.supersededAt === null);
}

/**
 * The back-and-forth at this gate: what you asked, what you were told.
 *
 * The third of the operator's three requirements, and the one the console had nothing at
 * all for. An unanswered question says WHY it is unanswered — being answered
 * now, waiting for a slot, or overtaken by a decision — because a question that
 * just sits there is indistinguishable from one that was ignored.
 */
function GateThread({ record, row }: { record: GateThreadRecord | null; row: IssueRow }) {
  if (!record || record.entries.length === 0) return null;
  return (
    <div className="thread">
      <p className="note" style={{ margin: '0 0 6px' }}>
        Your questions at this gate — asked without deciding it:
      </p>
      {record.entries.map((e) => (
        <div className="qa" key={e.id}>
          <p className="q">
            <strong>You asked:</strong> <Linkify text={e.question} />
          </p>
          {e.answer !== null && (
            <p className="a">
              <Linkify text={e.answer} />
            </p>
          )}
          {e.answer === null && e.supersededAt !== null && (
            <p className="note">You decided the gate before this was answered, so it never went.</p>
          )}
          {e.answer === null && e.supersededAt === null && (
            <p className="note">
              {row.live
                ? 'answering now — watch the live feed above'
                : row.status === 'queued'
                  ? 'queued — it goes to the worker as soon as a slot frees'
                  : 'waiting to be delivered'}
            </p>
          )}
        </div>
      ))}
      {record.violation && <p className="note err">{record.violation}</p>}
    </div>
  );
}

/** Ask a question without deciding anything — used on its own while a worker runs. */
function AskBox({ row, note, onDone }: { row: IssueRow; note: string; onDone: (m: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const said = text.trim();
  const ask = async () => {
    setBusy(true);
    const out = await post(`/api/issues/${row.number}/ask`, { question: said });
    setBusy(false);
    if (out.ok) setText('');
    onDone(out.message);
  };
  return (
    <>
      <textarea
        placeholder="Ask the worker something. It answers and comes back to the same gate — nothing is decided."
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />
      <div className="gate-actions">
        <button disabled={busy || !said} onClick={() => void ask()}>
          Ask a question
        </button>
        <span className="note">{note}</span>
      </div>
    </>
  );
}

/**
 * The thread on its own, for the window where there is no gate card to hang it
 * on: the worker is running (answering, usually) and `.gate.json` has been
 * deleted for the resume.
 *
 * The rule that nothing asking the operator for an ANSWER is offered during a run still
 * holds — there is no Approve here. Asking is exempt by design: a question sent
 * mid-answer is written down and delivered when that run stops.
 */
function GateThreadCard({ row, onDone }: { row: IssueRow; onDone: (m: string) => void }) {
  const record = row.gateThread;
  if (!record) return null;
  return (
    <div className="gate-card answered">
      <h2>Gate {record.gate} — your questions</h2>
      <GateThread record={record} row={row} />
      <AskBox
        row={row}
        note={row.live ? 'the worker is mid-answer; this is delivered when it stops' : 'the gate comes back when it stops'}
        onDone={onDone}
      />
    </div>
  );
}

/**
 * The screenshots, as a contact sheet.
 *
 * The thumbnail IS the link and full size is a new tab: there is no lightbox to
 * build or to learn, it works the same on a phone, and the full-size view is the
 * browser showing the same fenced, read-only evidence URL the thumbnail came
 * from. Six shots of one screen are a scroll of full-width figures and a grid of
 * six — one of those can be taken in at a glance.
 */
function ShotGrid({ issue, items }: { issue: number; items: EvidenceItem[] }) {
  return (
    <div className="shot-grid">
      {items.map((it, i) => {
        const url = `/api/issues/${issue}/evidence?path=${encodeURIComponent(it.path)}`;
        return (
          <figure key={i}>
            <a href={url} target="_blank" rel="noreferrer">
              <img src={url} alt={it.caption} loading="lazy" />
            </a>
            <figcaption>{it.caption}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}

/**
 * Something the worker was REQUIRED to attach is not here.
 *
 * Red, and with the button that fixes it, because the degraded gate must never
 * read like the normal one — approving on prose alone is the exact failure this
 * gate exists to catch. The button sends the worker the sanctioned method by
 * name, so the omission costs one click rather than a paragraph of typing.
 */
function MissingBlock({
  what,
  detail,
  action,
  onAsk,
  canResume,
  busy,
}: {
  what: string;
  detail: string;
  action: string;
  onAsk: () => void;
  canResume: boolean;
  busy: boolean;
}) {
  return (
    <div className="gate-missing">
      <p>
        <strong>{what}</strong> {detail}
      </p>
      <button disabled={!canResume || busy} onClick={onAsk}>
        {action}
      </button>
    </div>
  );
}

/**
 * EVERY WARNING ON A GATE CARD, IN ONE BLOCK, SAID THE SAME WAY.
 *
 * Before this there were four: an orange line for code landing after the QA, a
 * grey note under the click-script for a rework that came back short, a red note
 * inside the quiz for a voided question, and whatever the newest one added. Each
 * looked like something different, and none of them said whether it stopped
 * anything — only the Approve label knew that, at the bottom of the card.
 *
 * So severity is the thing this renders. `blocking` is red and says the fix is
 * not the operator's; `accept` is the gate colour and pairs with the tick beside Approve;
 * `note` is grey and costs nothing. The one-click send-back sits inside the
 * warning that raises it, which is the same rule the missing-evidence blocks
 * already followed.
 */
function GateWarnings({
  warnings,
  canResume,
  busy,
  onAsk,
}: {
  warnings: GateWarning[];
  canResume: boolean;
  busy: boolean;
  onAsk: (what: 'shots' | 'script' | 'quiz') => void;
}) {
  if (warnings.length === 0) return null;
  const word = (level: GateWarning['level']) =>
    level === 'blocking' ? 'Blocks approval' : level === 'accept' ? 'Needs your call' : 'For information';
  return (
    <div className="gate-warnings">
      <p className="gate-warnings-head">
        {warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`} on this gate
      </p>
      {warnings.map((w) => (
        <div className={`gate-warning ${w.level}`} key={w.key}>
          <p>
            <span className="gate-warning-tag">{word(w.level)}</span>
            <strong>{w.title}.</strong> {w.detail}
          </p>
          {w.ask && (
            <button disabled={!canResume || busy} onClick={() => onAsk(w.ask!)}>
              {w.ask === 'shots'
                ? 'Ask for the missing evidence'
                : w.ask === 'script'
                  ? 'Ask for the click-script again'
                  : 'Ask for the quiz again'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const LETTERS = ['A', 'B', 'C', 'D'];

/**
 * The comprehension half of gate C: what was done, then multiple choice.
 *
 * The operator asked for the QA to be part information — what was done — and
 * part simple multiple choice rather than free text: answerable on the spot,
 * marked right or wrong there and then, with the answers and the reasoning shown
 * on submit.
 *
 * So a pick locks and says right or wrong on the spot, and NOTHING else is
 * revealed until the operator submits — revealing the correct option mid-quiz
 * turns the remaining questions into pattern-matching, and holding every
 * rationale to one moment makes the post-submit card the single thing worth
 * re-reading.
 *
 * A wrong answer blocks nothing. Submitting is the whole of what this half owes
 * the gate, which is why the standing line under the header says so before
 * anything has been answered.
 */
function QuizCard({
  quiz,
  progress,
  onChange,
}: {
  quiz: Quiz;
  progress: QuizProgress;
  /** An UPDATE, not a value: two picks inside one React batch would otherwise
   *  both build on the same snapshot and the first one would be lost. */
  onChange: (update: (p: QuizProgress) => QuizProgress) => void;
}) {
  const submitted = progress.submittedAt !== null;
  const total = quiz.questions.length;
  const answered = answeredCount(progress);
  const ready = allAnswered(quiz, progress);

  return (
    <div className="quiz">
      <p className="note quiz-note">
        Wrong answers block nothing — submitting is what counts. The reasoning appears when you submit.
      </p>
      {quiz.brief.length > 0 && (
        <>
          <p className="quiz-brief-head">What was done</p>
          <ul className="quiz-brief">
            {quiz.brief.map((b, i) => (
              <li key={i}>
                <Clamp text={b} limit={18} />
              </li>
            ))}
          </ul>
        </>
      )}

      {quiz.questions.map((q, i) => {
        const picked = progress.picks[i] ?? null;
        const v = verdictOf(quiz, progress, i);
        return (
          <div className={v === null ? 'quiz-q' : `quiz-q ${v}`} key={i}>
            <p className="quiz-n">Q{i + 1}</p>
            {q.context !== '' && (
              <p className="quiz-context">
                <Clamp text={q.context} limit={32} />
              </p>
            )}
            <p className="quiz-question">{q.question}</p>
            <div className="quiz-opts">
              {q.options.map((o, j) => {
                const mine = picked === j;
                const right = j === q.correct;
                const cls = ['quiz-opt'];
                if (mine) cls.push('picked', right ? 'right' : 'missed');
                if (submitted && right) cls.push('reveal-correct');
                return (
                  <button
                    key={j}
                    className={cls.join(' ')}
                    disabled={picked !== null}
                    onClick={() => onChange((cur) => withPick(cur, i, j))}
                  >
                    <span className="quiz-letter">{LETTERS[j]}</span>
                    <span className="quiz-opt-text">{o.text}</span>
                    {submitted && right && <span className="quiz-tag">✓ correct</span>}
                    {submitted && mine && !right && <span className="quiz-tag">your pick</span>}
                  </button>
                );
              })}
            </div>
            {picked !== null && !submitted && (
              <p className={`quiz-verdict ${v}`}>
                {v === 'right' ? '✓ Right' : '✗ Not quite — nothing blocked, reasoning on submit'}
              </p>
            )}
            {submitted && (
              <div className="quiz-whys">
                {q.options.map((o, j) => (
                  <p className={j === q.correct ? 'quiz-why correct' : 'quiz-why'} key={j}>
                    <span className="quiz-letter">{LETTERS[j]}</span> {o.why}
                  </p>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {!submitted && (
        <div className="quiz-footer">
          <span className="note">
            {answered} of {total} answered
          </span>
          <button disabled={!ready} onClick={() => onChange((cur) => withSubmit(quiz, cur, new Date().toISOString()))}>
            Submit quiz
          </button>
          {!ready && <span className="note">Right or wrong doesn&apos;t matter — answered does.</span>}
        </div>
      )}
      {submitted && (
        <p className="quiz-score">
          {scoreOf(quiz, progress) === total
            ? `${scoreOf(quiz, progress)}/${total} — all right.`
            : `${scoreOf(quiz, progress)}/${total} — read the why on the ones you missed; that is the point of the quiz.`}
        </p>
      )}
    </div>
  );
}

/**
 * Gate C, as the three things the operator actually asked it to be:
 *
 *   1. evidence that the agent did the work, with screenshots;
 *   2. a manual QA click-through the operator can follow — links to the running
 *      app, the login, where to navigate;
 *   3. a place to ask questions and get answers until they understand it.
 *
 * They are numbered sections rather than a run of paragraphs because that is the
 * order they are read in and each one is a different job. Every other gate keeps
 * the plain card: A and B have no app to click through, D and E are decisions
 * about a PR, and only C is the understanding gate.
 *
 * The two red blocks are the load-bearing part. Gate C arrived once with no
 * screenshots and an offer to let the operator run the capture themselves, and a grey note
 * saying so is not enough — the console cannot make a worker capture evidence,
 * but it can refuse to let the omission slide past looking normal.
 */
/**
 * Attach a screenshot so the worker can actually look at it.
 *
 * Evidence only ever went worker → operator. When QA failed #4847 with two
 * screenshots the worker could not see them, so it stopped at a gate asking
 * which surface they showed — a question a picture answers in a second.
 *
 * The file is written into the issue's own worktree (fenced in `attach.ts`) and
 * its repo-relative path is appended to the message box, because a file the
 * worker is never TOLD about is a file it will not read.
 */
function AttachControl({ issue, onPath }: { issue: number; onPath: (p: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);

  const send = async (file: File) => {
    setBusy(true);
    setErr(null);
    try {
      const data: string = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1] ?? '');
        r.onerror = () => rej(new Error('could not read that file'));
        r.readAsDataURL(file);
      });
      const out = (await post(`/api/issues/${issue}/attach`, { name: file.name, data })) as {
        ok: boolean;
        message: string;
        path?: string;
      };
      if (out.ok && out.path) {
        setDone((d) => [...d, out.path!]);
        onPath(out.path);
      } else setErr(out.message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="attach">
      <label className="attach-btn">
        {busy ? 'Attaching…' : 'Attach a screenshot'}
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void send(f);
          }}
        />
      </label>
      <span className="note">saved into the worktree, and its path added to your message</span>
      {done.map((d) => (
        <span key={d} className="note attach-done">
          {d.split('/').pop()}
        </span>
      ))}
      {err && <span className="note bad">{err}</span>}
    </div>
  );
}

function GateCCard({ row, onDone }: { row: IssueRow; onDone: (m: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * The set of warnings the operator has ticked as read, by key.
   *
   * Held as the KEY rather than a boolean so a warning that arrives on a later
   * round — a rework that came back short of a capture it had before — cannot
   * inherit a tick given to a different warning. Deliberately not persisted: an
   * acceptance is a thing the operator does at the moment they approve.
   */
  const [acceptedKey, setAcceptedKey] = useState('');
  const quiz = row.gateQuiz;
  // The key changes only when a question, an option or the answer key changes —
  // so a targeted rework that rewrites one question voids the submission, and a
  // quiz carried forward byte for byte keeps it. Nothing to clean up.
  const key = quiz ? quizKey(quiz) : null;
  const [progress, setProgress] = useState<QuizProgress | null>(() => (quiz ? loadProgress(row.number, quiz) : null));
  useEffect(() => {
    setProgress(quiz ? loadProgress(row.number, quiz) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.number, key]);
  // Persisting is a side effect of the answers changing, not part of computing
  // them — so it happens here rather than inside the state update.
  useEffect(() => {
    if (progress !== null) saveProgress(row.number, progress);
  }, [row.number, progress]);
  if (!row.gate) return null;
  const g = row.gate;

  /** A DECISION: approve, feedback, or "your gate deliverable is incomplete".
   *  The ledger records which button this was, so the caller says so — the
   *  console-composed nags carry their own marker, but the operator's typed
   *  feedback is just their words, and without the flag it was filed as an
   *  approval. */
  const send = async (message: string, decision: 'approved' | 'feedback' = 'approved') => {
    setBusy(true);
    const out = await post(`/api/issues/${row.number}/resume`, { message, decision });
    setBusy(false);
    if (out.ok) setText('');
    onDone(out.message);
  };

  /** A QUESTION: the worker answers and stops at this same gate again. */
  const sendAsk = async (question: string) => {
    setBusy(true);
    const out = await post(`/api/issues/${row.number}/ask`, { question });
    setBusy(false);
    if (out.ok) setText('');
    onDone(out.message);
  };

  /** APPROVE: the one decision the console checks for itself before it runs. */
  const approveC = async (message: string) => {
    setBusy(true);
    const out = await post(`/api/issues/${row.number}/approve-c`, { message });
    setBusy(false);
    if (out.ok) setText('');
    onDone(out.message);
  };

  const canResume = row.sessionId !== null;
  const said = text.trim();
  // What the grid can SHOW is what counts as a screenshot: `isImage` is read off
  // the file extension, while `kind` is whatever the worker declared. A .md
  // labelled "screenshot" is not a picture of anything.
  const shots = row.gateEvidence.filter((it) => it.isImage);
  const rest = row.gateEvidence.filter((it) => !it.isImage);

  const p = row.qaProgress;
  // `progress` is set in an effect, so for the one render after an SSE push that
  // carried a NEW quiz it is still the OLD submission — long enough to read as
  // "submitted" for a quiz nobody has taken, and to grade the new questions
  // against the old picks into the permanent record. The key it belongs to is
  // the only thing that says so.
  const answers = progress !== null && progress.key === key ? progress : null;
  const quizDone = quiz !== null && answers !== null && answers.submittedAt !== null;
  // Both halves, still. Dropping comprehension as a blocker was considered and
  // rejected: the operator was content for the gate to be blocked by the QA and
  // the comprehension both. A WRONG answer blocks nothing; skipping does.
  // The operator's rule: both legs on every step, and the only step that may
  // show no before is one where there was nothing there before. Computed from
  // the script the card is rendering, so it says the same thing the card shows.
  const shotsMissing = missingShots(row.gateManualQa?.steps ?? []);
  // Every warning this gate carries, computed once, in one place: the block the
  // operator reads, the tick that clears it and the line the approval records
  // are all the same list — the console has to state its warnings plainly.
  const warnings = gateWarnings({
    missingShots: shotsMissing,
    violation: row.qaRework?.violation ?? null,
    droppedSteps: row.gateManualQa?.dropped ?? 0,
    droppedQuestions: quiz?.dropped ?? 0,
    codeSinceQa: row.codeSinceQa ?? null,
    leftUnanswered: row.leftUnanswered ?? [],
  });
  const mustAccept = toAccept(warnings);
  // Keyed on the WARNINGS, not on the issue: a warning that arrives on a later
  // round is one nobody has read, so the tick resets rather than carrying over.
  const acceptKey = mustAccept.map((w) => w.key).join('|');
  const accepted = acceptedKey === acceptKey && acceptKey !== '';
  const lock = approveLockC({
    progress: p,
    failedIds: row.qaSteps.filter((v) => v.state === 'failed').map((v) => v.id),
    hasQuiz: quiz !== null,
    quizSubmitted: quizDone,
    typed: said !== '',
    // The console's own accusation about the last rework, and the two counts of
    // what the parsers had to throw away. Each one means the card is showing
    // less than the gate is being asked to pass.
    violation: row.qaRework?.violation ?? null,
    droppedSteps: row.gateManualQa?.dropped ?? 0,
    droppedQuestions: quiz?.dropped ?? 0,
    toAccept: mustAccept,
    accepted,
  });

  /**
   * What the approval carries besides your words: the ticks, and the graded quiz.
   *
   * It goes down `/approve-c`, not `/resume`. The console recomputes the QA half
   * of this lock server-side before it resumes anything — the button's own state
   * is a rendering of a row that arrived over SSE, and a row can be a moment old.
   */
  const approve = () => {
    const record: GateCRecord = {
      qa: {
        total: p.total,
        verified: p.verified,
        reworkedIds: (row.gateManualQa?.steps ?? []).filter((s) => s.rev > 1).map((s) => s.id),
      },
      // Graded against the picks that belong to THIS quiz, never a stale set.
      quiz: quiz && answers ? quizRecord(quiz, answers) : null,
      // And what was accepted to get here, so a gate passed over a missing
      // capture says so in the history rather than only in the browser.
      accepted: acceptedLine(warnings),
    };
    void approveC(approveCPrompt(text, record));
  };

  return (
    <div className="gate-card">
      <h2>Gate C — waiting for you</h2>
      {/* Every warning the console knows about, in one block, at the top, said
          the same way each time — rather than four differently-styled notes
          scattered down the card with only the button's label to say which of
          them actually stopped anything. The operator asked twice for the same
          thing: surface these points at gate C as the potential blockers they
          are, and make every warning plain in the console. */}
      <GateWarnings
        warnings={warnings}
        canResume={canResume}
        busy={busy}
        onAsk={(what) =>
          void send(
            what === 'shots'
              ? askForMissingShotsPrompt(shotsMissing)
              : what === 'script'
                ? askForScriptPrompt()
                : askForQuizPrompt(),
          )
        }
      />
      {g.summary !== '' && <GateSummary text={g.summary} />}

      <section className="gate-sec">
        <h3>1 · Evidence — what the worker did</h3>
        {/* What the manifest listed and the console would not serve. Above the
            grid, because the thing it is telling you is that the grid is short:
            #4698 showed an empty box over twelve real screenshots and was
            approved on it. Server-composed — see `GateFile.evidenceWarning`. */}
        {g.evidenceWarning && <p className="note warn-line">{g.evidenceWarning}</p>}
        {shots.length > 0 ? (
          <>
            <p className="note" style={{ margin: '0 0 4px' }}>
              Screenshots the worker captured itself, from the app it changed. Click one to open it full size.
            </p>
            <ShotGrid issue={row.number} items={shots} />
          </>
        ) : (
          <MissingBlock
            what="No screenshots."
            detail={
              "The worker has to capture these itself with the repo's Playwright tooling — approving on a description " +
              'alone is the failure this gate exists to catch.'
            }
            action="Tell it to capture screenshots"
            onAsk={() => void send(askForShotsPrompt())}
            canResume={canResume}
            busy={busy}
          />
        )}
        {rest.map((it, i) => (
          <EvidenceOne key={i} issue={row.number} item={it} />
        ))}
        {row.gateReport && (
          <p className="note">
            The full written walkthrough is under{' '}
            {/* The click OPENS the disclosure as well as scrolling to it. A link
                that lands on a closed box is the same complaint in miniature:
                referenced, and still not reachable. */}
            <a
              href="#report"
              onClick={() => {
                const el = document.getElementById('report');
                if (el instanceof HTMLDetailsElement) el.open = true;
              }}
            >
              Worker&apos;s written report
            </a>{' '}
            at the bottom of this page.
          </p>
        )}
      </section>

      <section className="gate-sec">
        <h3>
          2 · Manual QA — tick each step
          {p.total > 0 && (
            <span className={p.complete ? 'qa2-progress done' : 'qa2-progress'}>
              {p.complete ? `All ${p.total} verified` : `${p.verified} of ${p.total} verified`}
            </span>
          )}
        </h3>
        {row.gateManualQa ? (
          <ManualQaCard row={row} canResume={canResume} busy={busy} onDone={onDone} warningsShownAbove />
        ) : (
          <MissingBlock
            what="No click-script."
            detail={
              'The worker has to hand you the exact steps — the app link, the login, what to click, what you should ' +
              'see. Checking this should never mean reading the diff.'
            }
            action="Ask for the click-script"
            onAsk={() => void send(askForScriptPrompt())}
            canResume={canResume}
            busy={busy}
          />
        )}
      </section>

      <section className="gate-sec">
        <h3>3 · Understanding — quick quiz</h3>
        {/* A voided question is invisible — you take the two that parsed, score
            2/2, and neither you nor the worker ever learns a third was written.
            It is said in the warnings block at the top of this card now, with
            everything else that stops the gate, rather than here on its own. */}
        {quiz !== null && answers !== null && (
          <QuizCard
            quiz={quiz}
            progress={answers}
            onChange={(update) => setProgress((cur) => (cur === null ? cur : update(cur)))}
          />
        )}
        {quiz === null && (
          <>
            <MissingBlock
              what="No quiz."
              detail="The understanding half of this gate cannot be completed without it."
              action="Ask for the quiz"
              onAsk={() => void send(askForQuizPrompt())}
              canResume={canResume}
              busy={busy}
            />
            {g.questions.length > 0 && (
              <>
                <p className="note">Old-style questions — ask for the quiz to complete this half.</p>
                <ol className="quiz-legacy">
                  {g.questions.map((q, i) => (
                    <li key={i}>
                      <Linkify text={q} />
                    </li>
                  ))}
                </ol>
              </>
            )}
          </>
        )}

        <GateThread record={row.gateThread} row={row} />

        {!canResume && (
          <p className="note err">
            No session id for this worktree, so this console cannot resume it. Open the worktree in a terminal and run{' '}
            <code>{row.provider === 'codex' ? 'codex resume' : 'claude --resume'}</code> to pick the session, or start it
            here once so the console owns a session id.
          </p>
        )}

        <textarea
          placeholder="A question, or anything else worth sending. It rides with whichever button you press."
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!canResume || busy}
        />
        {/* Both halves at a glance, so the disabled button never has to be read
            twice. Grey is "not yet", never "wrong" — a quiz score has no
            authority here and must never look like it does. */}
        <p className="quiz-pills">
          <span className={p.complete ? 'quiz-pill done' : 'quiz-pill pending'}>
            QA {p.verified}/{p.total}
            {p.complete ? ' verified' : ''}
          </span>
          <span className={quizDone ? 'quiz-pill done' : 'quiz-pill pending'}>
            {quizDone && quiz && answers
              ? `Quiz submitted · ${scoreOf(quiz, answers)}/${quiz.questions.length}`
              : 'Quiz not submitted'}
          </span>
        </p>
        {/* The deliberate act. A warning the operator can take is not a gate they
            cannot pass — the operator did not want a hard degraded gate, only a
            warning plus an explicit approval — so the way past it is one tick,
            next to the button, naming what is being taken on.
            What gets ticked rides into the approval and the gate history. */}
        {mustAccept.length > 0 && (
          <label className="gate-accept">
            <input
              type="checkbox"
              checked={accepted}
              disabled={!canResume || busy}
              onChange={(e) => setAcceptedKey(e.target.checked ? acceptKey : '')}
            />
            <span>
              I have read {mustAccept.length === 1 ? 'the warning' : `the ${mustAccept.length} warnings`} above and
              want to approve anyway — {mustAccept.map((w) => w.title.toLowerCase()).join('; ')}.
            </span>
          </label>
        )}
        <div className="gate-actions">
          {/* The label IS the reason it is locked — one blocker at a time, in the
              order you can act on them, so the reason is never a paragraph and
              never a tooltip. Approve carries whatever is in the box: it used to
              send only the canned line and silently drop three typed answers. */}
          <button className="primary" disabled={!canResume || busy || lock.locked} onClick={approve}>
            {lock.label}
          </button>
          {/* The only act that ENDS NOTHING, so it sits next to Approve rather
              than below the feedback path: understanding the work is meant to be
              the cheap thing to do here. */}
          <button disabled={!canResume || busy || !said} onClick={() => void sendAsk(said)}>
            Ask a question
          </button>
          {/* The gate C variant: your words lead, and the standing evidence rule
              rides under them. Feedback here always sends the worker back to
              rewrite .gate.json, which is exactly when the evidence box is at
              risk. */}
          <button disabled={!canResume || busy || !said} onClick={() => void send(feedbackCPrompt(text), 'feedback')}>
            Send feedback
          </button>
          {g.stoppedAt && <span className="note">stopped {new Date(g.stoppedAt).toLocaleString()}</span>}
        </div>
        <p className="note">
          Approve sends your ticks, the quiz result and anything you typed. Ask a question keeps the gate open.
        </p>
      </section>

      <p className="note">
        Read from .gate.json
      </p>
    </div>
  );
}

/**
 * Is CI green — one line, and a loud one when the answer is not yes.
 *
 * The rule it enforces is Stage 7's own: *"a handover that does not say CI is
 * green is a handover of an unknown."* That rule was already there and was
 * satisfiable by a paragraph, which is exactly what happened at Gate E on
 * 2026-08-13 — 27 green checks described at length, the missing `CI Success`
 * rollup mentioned once at the end. Nothing on the card contradicted it, because
 * nothing on the card knew.
 *
 * `unconfirmed` is deliberately as loud as `red`. It is not a softer red; it is
 * the state where nobody knows, and that is the one the operator has to be told about
 * because it is the one that looks like green from a distance.
 */
function CiLine({ ci }: { ci: GateCi | null }) {
  if (!ci) return null;
  const label = ci.state === 'green' ? 'CI green' : ci.state === 'red' ? 'CI RED' : 'CI NOT CONFIRMED';
  return (
    <p className={`ci-line ci-${ci.state}`}>
      <strong>{label}</strong>
      <span className="ci-note">{ci.note}</span>
      {ci.outstanding.length > 0 && (
        <span className="ci-outstanding">
          Outstanding: {ci.outstanding.join(', ')}
        </span>
      )}
    </p>
  );
}

/**
 * The writes a worker drafted instead of making.
 *
 * `gh issue create` and every board move are denied by the write fence, because
 * an issue a worker files is stamped with the operator's name by the repo's
 * autoassign workflow and lands in their queue looking like work the team asked
 * for — #4562 arrived exactly that way. But a denial that leaves the operator to
 * reconstruct the issue by hand has just moved the cost onto them, so the worker
 * writes the whole thing and this turns it into one link.
 *
 * The console files nothing. `fileUrl` is GitHub's own new-issue form with the
 * fields already populated: the operator presses Submit there, as themselves.
 */
export function DraftedWrites({ row }: { row: IssueRow }) {
  const iss = row.issueRequest ?? null;
  const brd = row.boardRequest ?? null;
  const filed = (row.spinOffs ?? []).find((s) => s.title === iss?.title) ?? null;
  const recommendation = iss?.recommendation ?? null;
  const recommendsFold = recommendation === 'fold';
  const recommendsSeparate = recommendation === 'separate';
  const recommendationLabel = recommendsFold
    ? `Fold into #${row.number}`
    : recommendsSeparate
      ? 'File separately'
      : 'No structured recommendation recorded';
  const recommendationReason = iss?.recommendationWhy?.trim() || iss?.why?.trim() || '';
  const [busy, setBusy] = useState<'file' | 'fold' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!iss && !brd) return null;

  const file = async () => {
    setBusy('file');
    setErr(null);
    const out = await post(`/api/issues/${row.number}/file-spin-off`);
    if (!out.ok) setErr(out.message);
    setBusy(null);
  };

  // The other half of the skill's own rule — "fold them into the original issue
  // and that should always be an option". No GitHub write at all: it marks the
  // draft absorbed and resumes the worker to do the work here.
  const fold = async () => {
    if (!window.confirm(`Fold this into #${row.number} instead of filing it?`)) return;
    setBusy('fold');
    setErr(null);
    const out = await post(`/api/issues/${row.number}/fold-spin-off`);
    if (!out.ok) setErr(out.message);
    setBusy(null);
  };

  return (
    <div className="drafted">
      {iss && (
        <div className="drafted-item">
          <p className="drafted-head">
            {filed ? (
              <>
                <strong>Spin-off issue filed</strong> — #{filed.number}, from here, on your click.
              </>
            ) : (
              <>
                <strong>Related issue identified</strong> — nothing is filed until you choose where it belongs.
              </>
            )}
          </p>
          <p className="drafted-title">{iss.title}</p>
          <p className="note">
            <strong>Identified while working on:</strong>{' '}
            <a href={row.url} target="_blank" rel="noreferrer">
              Base issue #{row.number}
            </a>
          </p>
          <p className="note">
            <strong>How it was identified:</strong>{' '}
            {iss.identifiedHow?.trim() || 'Not recorded in this draft.'}
          </p>
          <p className="note">
            <strong>How it relates to the base issue:</strong>{' '}
            {iss.relationship?.trim() || 'No structured relationship was recorded in this draft.'}
          </p>
          <p className="note">
            <strong>Worker recommendation:</strong> {recommendationLabel}
            {recommendationReason && <> — {recommendationReason}</>}
          </p>
          {iss.labels.length > 0 && <p className="note">Labels: {iss.labels.join(', ')}</p>}
          {filed ? (
            <a className="btn-link" href={filed.url} target="_blank" rel="noreferrer">
              Open #{filed.number}
            </a>
          ) : (
            <>
              {/* Filing from here rather than through the prefilled form is not a
                  loosening: it is your click either way, and the repo's autoassign
                  workflow stamps you as assignee either way. What it buys is the
                  link — the console learns the new number, which a browser form
                  never tells it, so parent and child stop being strangers. */}
              <div className="gate-actions">
                {recommendsFold ? (
                  <>
                    <button className="btn-primary" onClick={fold} disabled={busy !== null}>
                      {busy === 'fold' ? 'Folding…' : `Fold into #${row.number}`}
                    </button>
                    <button onClick={file} disabled={busy !== null}>
                      {busy === 'file' ? 'Filing…' : 'File separately'}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className={recommendsSeparate ? 'btn-primary' : undefined}
                      onClick={file}
                      disabled={busy !== null}
                    >
                      {busy === 'file' ? 'Filing…' : 'File separately'}
                    </button>
                    <button onClick={fold} disabled={busy !== null}>
                      {busy === 'fold' ? 'Folding…' : `Fold into #${row.number}`}
                    </button>
                  </>
                )}
                <a className="btn-link" href={iss.fileUrl} target="_blank" rel="noreferrer">
                  or open it on GitHub, prefilled
                </a>
              </div>
              <p className="note">
                <strong>Folding is always an option.</strong> It files nothing — the worker is resumed to do this work
                here, in this PR, and redoes the sweep and affected-rows sections because the diff gets wider. A chain
                of issue → raised issue → raised issue is rarely what you want.
              </p>
              <p className="note">
                Filed as you, with <code>Spun off from #{row.number}</code> in the body — so it shows on this issue's
                timeline. It will be auto-assigned to you and land in <code>Ready</code>, the same as filing it by hand.
              </p>
              {err && <p className="note bad">{err}</p>}
            </>
          )}
        </div>
      )}
      {/* Already done: the console moved this card itself, because the operator started the
          worker and "In progress" is a statement of fact rather than a claim on the
          team's plan. Past tense, muted, no link and no button — visible and
          auditable without being a demand. The second sentence is the whole
          contract: the undo is real and permanent, so disagreeing with the console
          never starts a fight. */}
      {brd?.applied && (
        <div className="drafted-item">
          <p className="note">
            <strong>Board</strong> — moved to <code>{brd.applied.to}</code> from{' '}
            <code>{brd.applied.from}</code> at {new Date(brd.applied.at).toLocaleTimeString()}. Move it back if
            that&rsquo;s wrong; it will not be moved again.
          </p>
        </div>
      )}
      {brd && !brd.applied && (
        <div className="drafted-item">
          <p className="drafted-head">
            <strong>Board move drafted</strong> — the worker did not move the card.
          </p>
          <p className="drafted-title">
            #{brd.issue} → <code>{brd.lane}</code>
            {brd.currentLane && <> (currently <code>{brd.currentLane}</code>)</>}
          </p>
          {brd.why && <p className="note">{brd.why}</p>}
          <a className="btn-link" href={brd.boardUrl} target="_blank" rel="noreferrer">
            Open the project board
          </a>
        </div>
      )}
    </div>
  );
}

function GateCard({ row, onDone }: { row: IssueRow; onDone: (m: string) => void }) {
  // GATE E has one question GitHub answers, not us: can this actually be handed
  // to a codeowner? #4535 presented as "ready to hand to the team lead" while
  // carrying CHANGES_REQUESTED, the `changes-requested` label and reviewDecision
  // REVIEW_REQUIRED. The console had tracked its own review rounds — both
  // answered by the operator, which means the rework went back, never that the
  // reviewer accepted it. Closing the round closed the gate.
  const handover = row.gate?.gate === 'E' ? (row.handover ?? null) : null;
  const handoverBlocks = handover !== null && !handover.ready;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!row.gate) return null;
  const g = row.gate;

  const send = async (message: string, decision: 'approved' | 'feedback' = 'approved') => {
    setBusy(true);
    const out = await post(`/api/issues/${row.number}/resume`, { message, decision });
    setBusy(false);
    if (out.ok) setText('');
    onDone(out.message);
  };

  /** Ask, without deciding: the worker answers and comes back to this gate. */
  const sendAsk = async (question: string) => {
    setBusy(true);
    const out = await post(`/api/issues/${row.number}/ask`, { question });
    setBusy(false);
    if (out.ok) setText('');
    onDone(out.message);
  };

  const canResume = row.sessionId !== null;
  const said = text.trim();

  // Answered, and waiting for a free slot rather than for the operator.
  if (row.status === 'queued') {
    const queuedAsk = (row.gateThread?.pendingAskIds.length ?? 0) > 0;
    return (
      <AnsweredCard
        title={`Gate ${g.gate} — ${queuedAsk ? 'question queued' : 'answered'}, waiting for a free slot`}
        row={row}
        question={queuedAsk}
      />
    );
  }

  // The understanding gate has its own card: evidence, a click-script and a
  // conversation are three jobs, not one column of paragraphs. Everything else
  // keeps the plain card below.
  if (g.gate === 'C') return <GateCCard row={row} onDone={onDone} />;

  return (
    <div className="gate-card">
      <h2>Gate {g.gate} — waiting for you</h2>
      <SuperchargeNotice row={row} />
      {/* Facts the CONSOLE knows, said here rather than left to a worker to
          volunteer in prose at a later gate. The operator asked for these points
          to be surfaced at gate C as the potential blockers they are. */}
      {row.codeSinceQa && (
        <p className="note warn-line">
          <strong>Code has landed since your QA.</strong> You approved gate C against{' '}
          <code>{row.codeSinceQa.approvedAt.slice(0, 9)}</code>; the branch is now on{' '}
          <code>{row.codeSinceQa.headNow.slice(0, 9)}</code>. Your walkthrough did not cover it.
        </p>
      )}
      {row.leftUnanswered && row.leftUnanswered.length > 0 && (
        <p className="note warn-line">
          <strong>You left {row.leftUnanswered.length === 1 ? 'a question' : `${row.leftUnanswered.length} questions`} unanswered</strong>{' '}
          at the last gate you approved — the worker will have picked its own answer:
          {' '}{row.leftUnanswered.map((q) => `“${q}”`).join('; ')}
        </p>
      )}

      {/* CI, before the prose and never inside it. At Gate E on 2026-08-13 a
          worker wrote a paragraph saying 27 checks were green and mentioned in
          its closing sentence that the rollup had not been emitted. This is why
          CI gets its own line: a worker can no longer bury it in a sentence. */}
      <CiLine ci={g.ci ?? null} />

      {g.summary && (
        <p style={{ margin: '0 0 10px' }}>
          <Linkify text={g.summary} />
        </p>
      )}

      {/* 1. What the agent DID, with its own screenshots. */}
      <Evidence issue={row.number} items={row.gateEvidence} warning={g.evidenceWarning} />

      {/* 2. How to check it yourself, with links you can actually click. A
          click-script outside gate C is not something the skill produces, but if
          one is there it is still yours to run — only the targeted rework is gate
          C's, so the button that sends one is not offered here. */}
      <ManualQaCard row={row} canResume={row.sessionId !== null} busy={busy} allowRework={false} onDone={onDone} />

      {/* 3. What the worker is asking you. */}
      {g.questions.length > 0 && (
        <ol>
          {g.questions.map((q, i) => (
            <li key={i}>
              <Linkify text={q} />
            </li>
          ))}
        </ol>
      )}

      {/* 4. What you asked it back. */}
      <GateThread record={row.gateThread} row={row} />

      {!canResume && (
        <p className="note err">
          No session id for this worktree, so this console cannot resume it. Open the worktree in a terminal and run{' '}
          <code>{row.provider === 'codex' ? 'codex resume' : 'claude --resume'}</code> to pick the session, or start it
          here once so the console owns a session id.
        </p>
      )}

      <textarea
        placeholder={
          `Your answers, feedback, or a question for gate ${g.gate}. Approve sends this WITH the approval; ` +
          `Send feedback sends it on its own; Ask a question gets you an answer and decides nothing.`
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={!canResume || busy}
      />

      <AttachControl
        issue={row.number}
        onPath={(p) =>
          setText((t) =>
            `${t}${t.trim() === '' ? '' : '\n'}I attached a screenshot at ${p} — read it before answering.\n`,
          )
        }
      />
      <div className="gate-actions">
        {/* Approve carries whatever is in the box. It used to send only the
            canned line and silently drop the box, so three typed answers went
            nowhere and the worker recorded an approval "with no explicit
            answers" — and took its own recommendations instead. */}
        <button
          className="primary"
            disabled={!canResume || busy || handoverBlocks}
          onClick={() => void send(approvePrompt(g.gate, text))}
        >
            {handoverBlocks
              ? // Never a bare greyed-out button: say what GitHub is waiting for.
                `Cannot hand over — ${handover!.why}`
              : said
                ? 'Approve with these answers'
                : `Approve gate ${g.gate}`}
        </button>
        {/* Not `primary`: this is the answer-WITHOUT-approving path, and two
            identical filled buttons side by side is what made them confusable. */}
        <button
          disabled={!canResume || busy || !said}
          onClick={() => void send(feedbackPrompt(text), 'feedback')}
        >
          Send feedback
        </button>
        {/* The third act, and the only one that ENDS NOTHING. The worker answers
            and stops at this same gate again, so understanding the work costs
            nothing and the decision is still yours to make afterwards. */}
        <button
          disabled={!canResume || busy || !said}
          onClick={() => void sendAsk(said)}
        >
          Ask a question
        </button>
        {g.stoppedAt && <span className="note">stopped {new Date(g.stoppedAt).toLocaleString()}</span>}
      </div>
      {said && <p className="note">Approve sends your answers too. Ask sends only the question, and decides nothing.</p>}
      <p className="note">
        Read from .gate.json
      </p>
    </div>
  );
}

/**
 * Creating a worktree is the one thing this console writes into the target
 * repo's checkout, so it never happens on a single click: this shows the exact branch
 * and the exact commands first.
 *
 * It is also the FIRST screen an untouched issue has, so the account picker
 * belongs here too: without it there is no way to choose an account before the
 * work starts. The choice is stamped when the worktree is created, so the start
 * card that follows comes up already set to it.
 */
/** What the Stage 9 card prefills. Exported shape kept in one place so the text
 *  the worker receives is the text you can read here. */
export function postMergePrompt(issue: number, pr: number, mergedAt: string | null): string {
  const at = mergedAt ? new Date(mergedAt).toLocaleString() : 'an unknown time';
  return (
    `PR #${pr} for issue #${issue} merged into dev at ${at}. Run Stage 9 (post-merge): ` +
    `move the board card, choose and justify the verification path, and draft the ` +
    `QA ready-to-verify comment for issue #${issue}. Do NOT post the comment yourself — ` +
    `write it as .comment-request.json and stop, as the comment path requires.`
  );
}

/**
 * Merge is not done.
 *
 * This row used to read "checkpoint — stopped after stage 7" and offer nothing,
 * because a merged PR vanished from `listOpenPrs` and the console fell back to
 * the worker's own stale note to itself. Three issues read that way on
 * 2026-08-11 behind PRs that had all merged.
 *
 * The card is deliberately calm — merged work is not a demand, it is a state
 * with an action available — and the action is one click with an editable
 * prompt, exactly like the rework brief.
 *
 * The prompt sends the worker to `.comment-request.json` rather than letting it
 * post on the issue itself. The skill's Stage 9 says post; a console worker may
 * not, and the only GitHub write in this codebase stays the one behind your own
 * click on the comment card.
 */
function PostMergeCard({
  row,
  accounts,
  models,
  defaults,
  health,
  onDone,
}: {
  row: IssueRow;
  accounts: AccountSummary[];
  models: ModelOption[];
  defaults: ProviderDefaults;
  health: AccountHealth[];
  onDone: (m: string) => void;
}) {
  const pr = row.pr;
  // Was the first place this leak was found — the operator opened #4336 and the
  // box said "PR #4368 for issue #4342". It had its own copy of the guard; now it
  // uses the shared one, so there is a single implementation to be right.
  const [prompt, setPrompt] = useIssueState(
    row.number,
    pr ? postMergePrompt(row.number, pr.number, pr.mergedAt ?? null) : '',
  );
  const fresh = !row.accountLocked;
  const fallback = row.account ?? accounts.find((candidate) => candidate.isDefault)?.name ?? accounts[0]?.name ?? '';
  const initialAccount = accountNamed(accounts, fallback);
  const [account, setAccount] = useIssueState(row.number, fallback);
  const selectedAccount = accountNamed(accounts, account);
  const provider = providerOfAccount(selectedAccount);
  const [model, setModel] = useIssueState(row.number, modelForAccount(models, defaults, initialAccount));
  const [busy, setBusy] = useState(false);
  if (!pr) return null;

  return (
    <div className="report merged-card">
      <h3 style={{ margin: '0 0 6px' }}>Issue #{row.number} — PR #{pr.number} merged</h3>
      <p className="note">
        {pr.mergedAt ? `The team lead merged this ${new Date(pr.mergedAt).toLocaleString()}. ` : ''}
        Merged is not verified. It still has to reach UAT, and QA has to check it there — so the board card has to
        move, the route to UAT has to be chosen (cherry-pick to the release branch, or wait for the daily promotion
        train), and QA needs a ready-to-verify script on the issue saying exactly what to click.
      </p>
      <p className="note">
        If QA finds something, it comes back to this issue — a fail is not a new bug, it is this one continuing.
      </p>
      <textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <p className="note">
        The worker DRAFTS the QA comment and stops. Posting it stays your click on the comment card — the console never
        writes to GitHub on its own.
      </p>
      <div className="toolbar">
        {fresh && (
          <>
            <RunAs
              accounts={accounts}
              value={account}
              onChange={(name) => {
                setAccount(name);
                setModel(modelForAccount(models, defaults, accountNamed(accounts, name)));
              }}
              busy={busy}
            />
            <RunOn models={models} provider={provider} value={model} onChange={setModel} busy={busy} />
          </>
        )}
        <button
          disabled={busy || !prompt.trim()}
          onClick={() => {
            setBusy(true);
            void post(`/api/issues/${row.number}/post-merge`, {
              prompt,
              ...(fresh ? { account, model } : {}),
            }).then((out) => {
              setBusy(false);
              onDone(out.message);
            });
          }}
        >
          Run Stage 9
        </button>
        <a href={pr.url} target="_blank" rel="noreferrer">
          PR #{pr.number}
        </a>
      </div>
      {fresh && <AccountWarning h={healthOf(health, account)} />}
    </div>
  );
}

/**
 * What a send-back asks for, in the worker's terms.
 *
 * The Stage 9 card's prompt is wrong for this state — it tells the worker to
 * move a board card and draft a ready-to-verify comment, both of which happened
 * BEFORE QA could have tested — so a UAT fail had exactly one button and it
 * pointed at finished work. The split is the skill's own (Stage 9 step 5) and it
 * is the part the operator has to choose between, so it is stated rather than left to be
 * remembered on a phone.
 */
export function uatFixPrompt(issue: number, verdict: string, by: string, url: string): string {
  return (
    `Issue #${issue} came back from UAT: ${by} tested the merged work and marked it ${verdict}. Read the verdict ` +
    `comment first — ${url} — it has the steps to recreate. Stage 9 is already done for this issue: the board card ` +
    `was moved and the ready-to-verify comment was posted, so do neither again.\n\n` +
    (verdict === 'Partial Pass'
      ? 'PARTIAL PASS: what shipped works and the remainder is new work. Take it on a NEW branch as a ' +
        'full-contract PR of its own, through every gate from A. Do not reopen the merged PR.'
      : 'FAIL: this issue continues, on a new PR. Before you change anything, reproduce it, then stop at a gate ' +
        'and tell me what the cause is — I may want the merged work reverted before you start.')
  );
}

/**
 * A verdict came back red — the card that REPLACES Stage 9's.
 *
 * `uatFail` was already derived, tiered and sorted on; it just never reached the
 * one card that carries a button, so the most urgent state in the system
 * prefilled a brief telling a worker to redo the very work QA had acted on. On
 * #4619 (P1, customer-reported) the card still read "draft the QA
 * ready-to-verify comment" hours after QA had failed it.
 */
function UatFixCard({
  row,
  accounts,
  models,
  defaults,
  health,
  onDone,
}: {
  row: IssueRow;
  accounts: AccountSummary[];
  models: ModelOption[];
  defaults: ProviderDefaults;
  health: AccountHealth[];
  onDone: (m: string) => void;
}) {
  const f = row.uatFail;
  // Same shared per-issue seed as PostMergeCard: this card does not remount per
  // issue, and a brief naming another issue's verdict would aim a worker at the
  // wrong work.
  const [prompt, setPrompt] = useIssueState(
    row.number,
    f ? uatFixPrompt(row.number, f.verdict, f.by, f.url) : '',
  );
  const fresh = !row.accountLocked;
  const fallback = row.account ?? accounts.find((candidate) => candidate.isDefault)?.name ?? accounts[0]?.name ?? '';
  const initialAccount = accountNamed(accounts, fallback);
  const [account, setAccount] = useIssueState(row.number, fallback);
  const selectedAccount = accountNamed(accounts, account);
  const provider = providerOfAccount(selectedAccount);
  const [model, setModel] = useIssueState(row.number, modelForAccount(models, defaults, initialAccount));
  const [busy, setBusy] = useState(false);
  if (!f) return null;

  return (
    <div className="report merged-card">
      <h3 style={{ margin: '0 0 6px' }}>Sent back from UAT — start the fix?</h3>
      <p className="note">
        {f.by} marked this {f.verdict} on {new Date(f.at).toLocaleString()}.{' '}
        {f.verdict === 'Partial Pass'
          ? 'A partial pass is new work on a new branch, through every gate — the merged PR stays merged.'
          : 'A fail continues on this issue with a new PR. The worker reports what it found before it changes anything, so a revert is still yours to choose.'}{' '}
        Edit the brief first if you want to.
      </p>
      <textarea rows={7} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="toolbar">
        {fresh && (
          <>
            <RunAs
              accounts={accounts}
              value={account}
              onChange={(name) => {
                setAccount(name);
                setModel(modelForAccount(models, defaults, accountNamed(accounts, name)));
              }}
              busy={busy}
            />
            <RunOn models={models} provider={provider} value={model} onChange={setModel} busy={busy} />
          </>
        )}
        <button
          disabled={busy || !prompt.trim()}
          onClick={() => {
            setBusy(true);
            void post(`/api/issues/${row.number}/post-merge`, {
              prompt,
              ...(fresh ? { account, model } : {}),
            }).then((out) => {
              setBusy(false);
              onDone(out.message);
            });
          }}
        >
          Start the fix
        </button>
        <a href={f.url} target="_blank" rel="noreferrer">
          the verdict comment
        </a>
        {row.pr && (
          <a href={row.pr.url} target="_blank" rel="noreferrer">
            PR #{row.pr.number}
          </a>
        )}
      </div>
      {fresh && <AccountWarning h={healthOf(health, account)} />}
    </div>
  );
}

function CreateWorktree({
  row,
  accounts,
  models,
  defaults,
  health,
  onDone,
}: {
  row: IssueRow;
  accounts: AccountSummary[];
  models: ModelOption[];
  defaults: ProviderDefaults;
  health: AccountHealth[];
  onDone: (m: string) => void;
}) {
  const [plan, setPlan] = useState<WorktreePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState(
    row.account ?? accounts.find((a) => a.isDefault)?.name ?? accounts[0]?.name ?? '',
  );
  const provider = providerOfAccount(accountNamed(accounts, account));
  const [model, setModel] = useIssueState(
    row.number,
    providerModel(models, defaults, provider, row.modelResolved),
  );
  const multi = accounts.length > 1;

  if (!plan) {
    return (
      <div className="toolbar">
        <TriageCaution row={row} />
        <RunAs
          accounts={accounts}
          value={account}
          onChange={(name) => {
            setAccount(name);
            setModel(modelForAccount(models, defaults, accountNamed(accounts, name)));
          }}
          busy={busy}
        />
        <RunOn models={models} provider={provider} value={model} onChange={setModel} busy={busy} />
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void fetch(`/api/issues/${row.number}/worktree-plan`)
              .then((r) => r.json())
              .then((out: { ok: boolean; message: string; plan?: WorktreePlan }) => {
                setBusy(false);
                if (out.ok && out.plan) setPlan(out.plan);
                else setError(out.message);
              });
          }}
        >
          Create a worktree…
        </button>
        {error && <span className="note err">{error}</span>}
        <AccountWarning h={healthOf(health, account)} />
      </div>
    );
  }

  return (
    <div className="confirm">
      <h3>Create a worktree for #{row.number}?</h3>
      <dl className="facts">
        <dt>branch</dt>
        <dd className="mono">{plan.branch}</dd>
        <dt>path</dt>
        <dd className="mono">{plan.worktreePath}</dd>
        <dt>dev port</dt>
        <dd>{plan.port}</dd>
        <dt>runs as</dt>
        <dd>{providerLabel(provider)} · {account}</dd>
        <dt>model</dt>
        <dd>{modelName(models, model, provider)}</dd>
      </dl>
      <p className="note">Exactly this will run, and nothing else:</p>
      <pre>{plan.commands.join('\n')}</pre>
      <p className="note">
        The console only ever creates a worktree that does not exist. It will not touch this one again afterwards, and it
        never deletes anything. It does <strong>not</strong> run <code>npm install</code>: stages 0-2 need no
        dependencies, so the worker installs them the first time it actually needs to build, test or start the dev
        server. A worktree with no <code>node_modules</code> is the expected state here, not a broken one.
      </p>
      <p className="note">
        The first worker here will run {multi && <strong>as {account} </strong>}on{' '}
        <strong>{providerLabel(provider)} · {modelName(models, model, provider)}</strong>. Cancel to pick differently; you can still change either on the start
        card afterwards, right up until the first worker has run.
      </p>
      <div className="gate-actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void post(`/api/issues/${row.number}/worktree`, { ...(multi ? { account } : {}), model }).then((out) => {
              setBusy(false);
              setPlan(null);
              onDone(out.message);
            });
          }}
        >
          Yes, create {plan.branch}
        </button>
        <button disabled={busy} onClick={() => setPlan(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Preparing({ row }: { row: IssueRow }) {
  const p = row.provision;
  if (!p) return null;
  return (
    <div className="report">
      <p style={{ margin: '10px 0 4px' }}>
        <strong>{p.phase === 'creating' ? 'Creating the worktree' : 'Setting the worktree up'}</strong> — {p.branch} on
        port {p.port}
      </p>
      <p className="note">
        Dependencies are <strong>not</strong> installed — there is no <code>node_modules</code> here yet, and that is
        deliberate. The worker runs <code>npm install</code> itself the first time it needs to build, test or start the
        dev server.
      </p>
      {p.logTail.length > 0 && <pre>{p.logTail.slice(-8).join('\n')}</pre>}
    </div>
  );
}

export function ProvisionFailure({ row, onDone }: { row: IssueRow; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useIssueState<ContinuationPlan | null>(row.number, null);
  const [planError, setPlanError] = useIssueState<string | null>(row.number, null);
  const provision = row.provision;
  if (!provision || provision.phase !== 'failed') return null;
  const canContinue = provision.code === 'branch-exists';

  return (
    <div className="report">
      <p className="note err">Setting the worktree up failed: {provision.error}</p>
      {provision.logTail.length > 0 && <pre>{provision.logTail.slice(-12).join('\n')}</pre>}
      {canContinue && (!plan || plan.issue !== row.number) && (
        <>
          <h3>Continue from the existing branch</h3>
          <p className="note">
            This branch already exists, so nothing was overwritten. Restore its worktree at{' '}
            <code>{provision.worktreePath}</code> from <code>{provision.branch}</code>. The existing branch tip will not
            be reset or recreated; after it is restored, the normal workflow controls continue from the files already
            on that branch.
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setPlanError(null);
              void fetch(`/api/issues/${row.number}/worktree/continue-existing-plan`)
                .then((response) => response.json())
                .then((out: { ok: boolean; message: string; plan?: ContinuationPlan }) => {
                  if (out.ok && out.plan) setPlan(out.plan);
                  else setPlanError(out.message);
                })
                .catch((error: Error) => setPlanError(`could not inspect the existing branch: ${error.message}`))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Checking…' : 'Review the recovery…'}
          </button>
          {planError && <p className="note err">{planError}</p>}
        </>
      )}
      {canContinue && plan?.issue === row.number && (
        <RecoveryConfirmation
          plan={plan}
          busy={busy}
          onCancel={() => setPlan(null)}
          onConfirm={() => {
            setBusy(true);
            setPlanError(null);
            void post(`/api/issues/${row.number}/worktree/continue-existing`, {
              head: plan.head,
              port: plan.port,
              mode: plan.mode,
            })
              .then((out) => {
                setPlan(null);
                if (!out.ok) setPlanError(out.message);
                onDone(out.message);
              })
              .catch((error: Error) => {
                const message = `could not restore the existing branch: ${error.message}`;
                setPlanError(message);
                onDone(message);
              })
              .finally(() => setBusy(false));
          }}
        />
      )}
      {plan?.issue === row.number && planError && <p className="note err">{planError}</p>}
    </div>
  );
}

export function RecoveryConfirmation({
  plan,
  busy,
  onConfirm,
  onCancel,
}: {
  plan: ContinuationPlan;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const restoring = plan.mode === 'restore';
  return (
    <div className="confirm">
      <h3>{restoring ? 'Restore this worktree from the existing branch?' : 'Use this existing worktree?'}</h3>
      <dl className="facts">
        <dt>branch</dt>
        <dd className="mono">{plan.branch}</dd>
        <dt>head</dt>
        <dd className="mono">{plan.head}</dd>
        <dt>path</dt>
        <dd className="mono">{plan.worktreePath}</dd>
        <dt>dev port</dt>
        <dd>{plan.port ?? 'not recorded'}</dd>
      </dl>
      {restoring ? (
        <>
          <p className="note">Git attachment and scaffold preview:</p>
          <pre>{plan.commands.join('\n')}</pre>
          <p className="note">
            The existing branch head must still match the value above. It will not be reset, recreated, forced out of
            another worktree, or given a different upstream. After Git attaches it, the console creates only missing
            scaffold entries: <code>supabase/</code>, <code>.env</code>, <code>supabase/.env.local</code>, and{' '}
            <code>.issue-state.md</code>. Existing entries are preserved, and no worker is started.
          </p>
        </>
      ) : (
        <p className="note">The exact path and branch are already registered together. This performs no Git write.</p>
      )}
      <div className="gate-actions">
        <button className="primary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Restoring…' : restoring ? 'Yes, restore this worktree' : 'Yes, use this worktree'}
        </button>
        <button disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * WHAT IT IS DOING RIGHT NOW.
 *
 * "working, stage 3 · last tool Bash" told the operator nothing while a worker sat 13
 * minutes inside one command. The stream already carried the answer — every
 * `tool_use` line has the command on it and the line's own timestamp — so this
 * is pure derivation from what is already on disk: nothing is asked of the
 * worker process, and nothing new is polled.
 *
 * Null when no command is outstanding: after a `tool_result` the model is
 * thinking, and printing a stopwatch against a command that already finished
 * would be worse than saying nothing.
 */
function runningTool(
  live: NonNullable<IssueRow['live']>,
  longToolMs: number,
  now: number,
): { what: string; ms: number | null; long: boolean } | null {
  if (!live.toolRunning || !live.lastTool) return null;
  const started = live.lastToolAt ? Date.parse(live.lastToolAt) : NaN;
  const ms = Number.isFinite(started) ? Math.max(0, now - started) : null;
  return {
    what: live.lastToolCommand ?? live.lastTool,
    ms,
    long: ms !== null && longToolMs > 0 && ms >= longToolMs,
  };
}

/**
 * A worker running RIGHT NOW.
 *
 * It is the first thing in the pane, above the gate cards and the facts,
 * because while an agent is working "what is it doing" outranks every other
 * question on the page — and it carries the one control that stops it, so the
 * run and the way to end it are never on different screens.
 *
 * Green, and green is used nowhere else. Orange on this page always means the
 * machine has STOPPED and is waiting for the operator; a running worker is the
 * opposite of that, and colouring it orange would say the ball is in their court.
 */
function LiveCard({
  row,
  models,
  provider,
  runsAs,
  longToolMs,
  onDone,
}: {
  row: IssueRow;
  models: ModelOption[];
  provider: AgentProvider;
  runsAs: string;
  longToolMs: number;
  onDone: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  // A stuck command writes NOTHING to the stream, so no SSE frame arrives and
  // nothing re-renders — the one case where the elapsed time matters most is
  // exactly the case where it would sit frozen on screen. One second of local
  // clock, and only while this card is mounted.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const live = row.live;
  if (!live) return null;
  const elapsed = now - Date.parse(live.startedAt);
  const paused = row.paused;
  const doing = runningTool(live, longToolMs, now);
  const call = (path: string, question: string | null) => {
    if (question && !window.confirm(question)) return;
    setBusy(true);
    void post(`/api/issues/${row.number}/${path}`).then((out) => {
      setBusy(false);
      onDone(out.message);
    });
  };

  return (
    <div className={`live-card ${paused ? 'paused' : ''}`}>
      <div className="live-head">
        <h2>
          {!paused && <span className="live-dot" />}
          {paused ? 'Paused' : 'Running'} — {providerLabel(provider)} ·{' '}
          {modelName(models, row.modelResolved, provider)}
          {runsAs && ` on ${runsAs}`}
        </h2>
        <span className="spacer" />
        {/* Pause is the lossless lever: it freezes the tree and gives the memory
            back, and everything on disk survives. It sits beside Stop precisely
            so the cheap reversible option is the one in reach. */}
        {row.status === 'active' && (
          <button disabled={busy} onClick={() => call('pause', pauseQuestion(row.number, 'its whole process tree'))}>
            Pause it
          </button>
        )}
        {paused && (
          <button disabled={busy} onClick={() => call('unpause', null)}>
            Resume it
          </button>
        )}
        {/* The only thing in the console that kills a worker, on the card that
            says it is alive. Restarting the console does not kill it, which is
            exactly why this asks first. */}
        {(row.status === 'active' || row.status === 'paused') && (
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              const ok = window.confirm(
                `Stop the worker on #${row.number}?\n\n` +
                  `It is running right now, and this kills the process — whatever it is part-way through is lost. ` +
                  `It ALSO stops this worktree's dev server` +
                  (row.port ? ` (port ${row.port})` : '') +
                  `, if one is running there, so that stopping actually gives the memory back. Nothing else is ` +
                  `touched: not port 8080, not the database, not another worktree.\n\n` +
                  `You do NOT need this to restart the console: workers survive that on their own.`,
              );
              if (!ok) return;
              setBusy(true);
              void post(`/api/issues/${row.number}/stop`).then((out) => {
                setBusy(false);
                onDone(out.message);
              });
            }}
          >
            Stop this worker
          </button>
        )}
      </div>
      <p>
        {row.statusDetail}
        {row.statusDetail.endsWith('.') ? '' : '.'}
      </p>
      <p className="note">
        {live.turns} turn{live.turns === 1 ? '' : 's'} · {Number.isFinite(elapsed) ? mins(Math.max(elapsed, 0)) : '—'}{' '}
        {live.reattached ? 'since it was picked back up' : 'so far'}
        {/* The current command, or — when nothing is outstanding — the last tool
            it used, which is what this line always said. */}
        {doing
          ? ` · now: ${doing.ms === null ? '' : `${mins(doing.ms)} · `}${doing.what}`
          : live.lastTool
            ? ` · last tool ${live.lastTool}`
            : ''}
      </p>
      {/* LOUD, not silent. Nothing is paused, killed or restarted over a long
          command — a full typecheck legitimately takes minutes — but a worker
          that has been inside one call for a quarter of an hour must not look
          identical to one that is ticking along. */}
      {doing?.long && doing.ms !== null && (
        <p className="note bad">
          This one command has been running {mins(doing.ms)} — past the {mins(longToolMs)} mark. It has not been paused
          or stopped; this is only here so a stall is not silent.
        </p>
      )}
      {live.reattached && (
        <p className="note">
          Re-attached after a console restart — this worker never stopped, and nothing was re-run. The turn count and
          the time above are counted from the re-attachment, not from the start of the run.
        </p>
      )}
      {/* A gate file still on disk while a run is live is the gate that was just
          answered: the worker has taken the answer and gone. Saying so beats
          leaving an Approve button on screen that would resume a session that is
          already running. */}
      {row.gate && (
        <p className="note">
          Gate {row.gate.gate} has been answered — that card is gone while the worker is working on it.
        </p>
      )}
      {live.lastText && <p className="last-text">{live.lastText.slice(0, 400)}</p>}
    </div>
  );
}

/**
 * What this issue is waiting on, and whether any of it is the operator's.
 *
 * A real incident: two issues that both read "PR open", and the operator could
 * not tell from either what was pending, what was awaiting somebody, or what the
 * status actually was — the same complaint raised more than once. Everything
 * here was already being computed and sent; it was rendered as two sentence-long
 * chips in a badge strip, which is not a place a person reads a status from.
 *
 * The split is the point. The top half is other people's work and is deliberately
 * plain — a status the operator can do nothing about must never wear the colour
 * that means something needs them. The bottom half is theirs, and is the only
 * part that does.
 *
 * Every string arrives finished from `waiting.ts`. Nothing is composed here, so
 * the page cannot word the same fact differently from the row.
 */
/**
 * THE REPAIR BESIDE THE REPORT.
 *
 * A follow-up item that the console can fix gets the fix here, in the place the
 * problem is already named. The draft PRs are why: the card said "nobody can
 * review it until you mark it ready" and the doing of it was a trip to GitHub,
 * so five complete PRs sat unreviewable, two of them for a day.
 *
 * Unknown `kind` renders nothing at all, on purpose: a page older than the
 * server it is talking to must degrade to the sentence and the link it always
 * showed, never to a button that does something it cannot describe.
 */
function FixButton({
  issue,
  fix,
  onDone,
}: {
  issue: number;
  fix: NonNullable<NonNullable<IssueRow['waiting']>['yours'][number]['fix']>;
  onDone: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (fix.kind !== 'pr-ready') return null;
  return (
    <button
      className="tool"
      disabled={busy}
      title={
        `Mark PR #${fix.pr} ready for review, from here. It opens the diff for review — it merges nothing, ` +
        'and GitHub keeps the history either way. The auto-review fires on ready_for_review, and codeowners ' +
        'are asked at that point.'
      }
      onClick={() => {
        setBusy(true);
        void post(`/api/issues/${issue}/pr-ready`).then((out) => {
          setBusy(false);
          onDone(out.message);
        });
      }}
    >
      {busy ? 'Marking ready…' : 'Mark ready for review'}
    </button>
  );
}

function PendingCard({
  waiting,
  issue,
  onDone,
}: {
  waiting: NonNullable<IssueRow['waiting']>;
  issue: number;
  onDone: (m: string) => void;
}) {
  return (
    <div className="pending">
      {waiting.on && (
        <>
          <h3 className="pending-h">Waiting on someone else</h3>
          <p className="pending-on">{waiting.on}</p>
        </>
      )}
      {/* A reviewer who cannot block. The operator asked which party was actually
          being waited on — the review swarm or the human approver — and this is
          the line that stops them chasing the one with no power to merge. */}
      {waiting.note && <p className="pending-note">{waiting.note}</p>}
      {waiting.yours.length > 0 ? (
        <>
          <h3 className="pending-h yours">For you to follow up</h3>
          <ul className="pending-list">
            {waiting.yours.map((y) => (
              <li key={y.text}>
                {y.url ? (
                  <a href={y.url} target="_blank" rel="noreferrer">
                    {y.text}
                  </a>
                ) : (
                  y.text
                )}
                {y.detail && <span className="pending-detail">“{y.detail}”</span>}
                {y.fix && <FixButton issue={issue} fix={y.fix} onDone={onDone} />}
              </li>
            ))}
          </ul>
        </>
      ) : (
        // Only ever printed alongside a reason above it — a card whose whole
        // content is "nothing to do" is noise on every healthy issue.
        <p className="pending-clear">Nothing for you to do.</p>
      )}
    </div>
  );
}

function Detail({
  row,
  accounts,
  models,
  defaults,
  health,
  longToolMs,
  onDone,
  onRefresh,
}: {
  row: IssueRow;
  accounts: AccountSummary[];
  models: ModelOption[];
  defaults: ProviderDefaults;
  health: AccountHealth[];
  /** How long one command may run before the live card says so loudly. */
  longToolMs: number;
  onDone: (m: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const multiAccount = accounts.length > 1;
  const runsAs = row.account ?? accounts.find((a) => a.isDefault)?.name ?? '';
  const provider = providerForRow(row, accounts);
  // Nothing the pill already says is repeated here: the priority label, and
  // `needs-triage` while the pill is reading "needs triage". A `needs-triage`
  // left on a RANKED issue stays in the line — the pill has stopped speaking for
  // it, and a half-finished triage is worth seeing.
  //
  // `needsTriage` and not `awaitingTriage`, so the same rule holds on a CLOSED
  // row: the pill is silent there by design, and reading the labels instead of
  // the row would have hidden the label as well — the console would have stopped
  // asking and stopped showing, which is a tidy-up rather than an answer. The
  // label is real and stays in the line; the console just does not act on it.
  const saidByPill = (l: string) => isPriorityLabel(l) || (isTriageLabel(l) && needsTriage(row));
  const other = row.labels.filter((l) => !saidByPill(l));
  const act = async (path: string) => {
    setBusy(true);
    const out = await post(path);
    setBusy(false);
    onDone(out.message);
  };

  return (
    <div className="detail">
      <div className="rail-num">
        #{row.number} · <a href={row.url} target="_blank" rel="noreferrer">github</a>
        {/* Who raised it. The operator asked for it as a reference — the ticket's
            author is who they reply to, and it is the difference between a thing
            the team asked for and a spin-off filed from this machine. */}
        {row.author && (
          <>
            {' · raised by '}
            <a href={`https://github.com/${row.author}`} target="_blank" rel="noreferrer">
              @{row.author}
            </a>
          </>
        )}
        {row.lane && (
          <>
            {' · board: '}
            <strong>{row.lane}</strong>
          </>
        )}
        {other.length > 0 && ' · ' + other.join(' · ')}
      </div>
      <h2 style={{ fontSize: 17, margin: '4px 0 2px' }}>{row.title}</h2>
      <div className="detail-status">
        <UatChip row={row} />
        <Pill row={row} />
        <Provenance row={row} />
        <ParkedChip row={row} />
        <Chip row={row} />
        <ProviderBadge provider={provider} />
        {multiAccount && <AccountBadge name={runsAs} />}
        <span className="note">{row.statusDetail}</span>
        {/* The review line and the pre-merge checklist used to live here, as
            sentence-length spans wedged into a strip built for badges. Both facts
            now belong to WaitingCard below, which has room to say them. */}
      </div>

      {/* FIRST in the pane, above even a send-back. Everything below this card
          is quieter than it would otherwise be — the row has sunk in the list,
          its chip has lost its orange — and this is the sentence that explains
          why, before you wonder. */}
      {/* Above even the parked card: this says whether there is a ticket behind
          any of this, which is the question every card below it presumes. */}
      <OrphanCard row={row} />

      <ParkedCard row={row} onDone={onDone} />

      {/* Above even a live run: this is work that already shipped and came back,
          and the sentence carries the link to the steps to recreate. */}
      <UatCard row={row} />

      {/* A live run comes FIRST — before the spine, before every card. While an
          agent is working, what it is doing is the whole answer to "what is on
          this issue", and the control that stops it belongs beside it. */}
      <LiveCard
        row={row}
        models={models}
        provider={provider}
        runsAs={runsAs}
        longToolMs={longToolMs}
        onDone={onDone}
      />

      <Spine row={row} onDone={onDone} />

      {/* Directly under the spine, because it is the answer to the question the
          spine raises: it says where this is, this says what it is waiting for. */}
      {row.waiting && <PendingCard waiting={row.waiting} issue={row.number} onDone={onDone} />}

      {/* Nothing that asks the operator for an answer is offered while a worker
          is running: the gate on disk during a live run is the one they just
          answered, and a second Approve would resume a session that is already
          going. The live card says the gate has been taken. */}
      {!row.live && row.gate && <GateCard row={row} onDone={onDone} />}
      {/* Asking is the exception to that rule, and deliberately so: a question
          sent while the worker is answering is written down and delivered when
          it stops, so the thread must stay reachable through exactly the window
          where the gate file has been deleted for the resume. */}
      {(row.live || !row.gate) && threadNeedsAttention(row.gateThread) && (
        <GateThreadCard row={row} onDone={onDone} />
      )}
      {row.status !== 'done' && !row.live && !row.gate && row.commentBlock && (
        <BlockedCard row={row} onDone={onDone} onRefresh={onRefresh} />
      )}
      {row.status !== 'done' && !row.live && !row.gate && !row.commentBlock && row.commentRequest && (
        <CommentCard row={row} onDone={onDone} />
      )}
      {!row.live && !row.gate && !row.commentBlock && !row.commentRequest && row.reviewBlock && (
        <ReworkCard
          row={row}
          accounts={accounts}
          models={models}
          defaults={defaults}
          health={health}
          onDone={onDone}
        />
      )}
      {/* Merged, and nothing else is asking for anything. Last in the chain
          because every card above it is a person waiting; this one is work that
          has landed and has a tail. */}
      {!row.live &&
        !row.gate &&
        !row.commentBlock &&
        !row.commentRequest &&
        !row.reviewBlock &&
        row.status === 'pr-merged' &&
        // A red verdict replaces the Stage 9 card rather than sitting beside it:
        // Stage 9's own work is what QA has already acted on, and offering both
        // is offering the wrong one first. `isUatFail` is the SERVER's stamp.
        (isUatFail(row) ? (
          <UatFixCard
            row={row}
            accounts={accounts}
            models={models}
            defaults={defaults}
            health={health}
            onDone={onDone}
          />
        ) : (
          <PostMergeCard
            row={row}
            accounts={accounts}
            models={models}
            defaults={defaults}
            health={health}
            onDone={onDone}
          />
        ))}

      {row.provision && row.provision.phase !== 'failed' && <Preparing row={row} />}

      <ProvisionFailure row={row} onDone={onDone} />

      <FailureNote row={row} />

      {/* What the worker wanted to write to GitHub and was fenced out of. It
          drafted instead; these two links are the operator doing it. */}
      <DraftedWrites row={row} />

      {/* A dev server that vanishes without explanation is a mystery. This is
          the explanation, on the row that caused it. */}
      {row.devServerStop && (
        <p className="note">
          The dev server for this worktree (port {row.devServerStop.port}) was stopped at{' '}
          {new Date(row.devServerStop.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — {row.devServerStop.why}. Start it
          again with <code>npm run dev</code> in the worktree when you need the app.
        </p>
      )}

      {!row.worktree && !row.provision && (
        <CreateWorktree
          key={row.number}
          row={row}
          accounts={accounts}
          models={models}
          defaults={defaults}
          health={health}
          onDone={onDone}
        />
      )}

      <div className="toolbar">
        {row.worktree && (row.status === 'checkpoint' || row.status === 'failed') ? (
          <StartWorker
            key={`start-worker-${row.number}`}
            row={row}
            accounts={accounts}
            models={models}
            defaults={defaults}
            health={health}
            onDone={onDone}
          />
        ) : null}
        {row.status === 'queued' && (
          <button disabled={busy} onClick={() => void act(`/api/issues/${row.number}/dequeue`)}>
            Take out of the queue
          </button>
        )}
        {/* Un-parking is on the card at the top of the pane, where the parked
            row's own explanation is. This is only the way IN. */}
        <ParkControl key={`park-control-${row.number}`} row={row} onDone={onDone} />
        {/* "Stop this worker" lives on the live card at the top of the pane —
            the run and the way to end it are never on different screens. */}
        {row.pr && (
          <a href={row.pr.url} target="_blank" rel="noreferrer">
            PR #{row.pr.number}
          </a>
        )}
      </div>

      {/* The session lock covers the model as well as the account, so this card
          is offered on a single-account machine too — it is the only way to move
          a running piece of work onto a different model. */}
      {row.worktree && row.accountLocked && row.status !== 'active' && (
        <RestartFresh
          key={row.number}
          row={row}
          accounts={accounts}
          models={models}
          defaults={defaults}
          health={health}
          onDone={onDone}
        />
      )}

      {/* HOW THIS ONE IS TRACKING, above the static facts: it is the only
          line here that changes as the ticket moves, and the only one that
          compares it to anything. */}
      <IssueCycleLine issue={row.number} />

      <dl className="facts">
        <dt>agent</dt>
        <dd>{providerLabel(provider)}</dd>
        <dt>branch</dt>
        <dd className="mono">{row.branch ?? '—'}</dd>
        <dt>worktree</dt>
        <dd className="mono">{row.worktree ?? 'none'}</dd>
        <dt>dev port</dt>
        <dd>{row.port ?? '—'}</dd>
        <dt>gates passed</dt>
        <dd>{row.gatesPassed.length ? row.gatesPassed.join(', ') : 'none'}</dd>
        {multiAccount && (
          <>
            <dt>account</dt>
            <dd>
              {runsAs}
              {row.account === null && ' (default — never stamped)'}
            </dd>
          </>
        )}
        <dt>model</dt>
        <dd>
          {modelName(models, row.modelResolved, provider)}
          {row.model === null && ' (not stamped — resolved from the account and the console default)'}
        </dd>
        <dt>last activity</dt>
        <dd>{row.lastActivityAt ? new Date(row.lastActivityAt).toLocaleString() : '—'}</dd>
      </dl>

      {row.resumeCommand ? (
        <>
          <p className="note">Take it over in a terminal — the console will then show it as detached:</p>
          <Copyable text={row.resumeCommand} />
        </>
      ) : (
        <p className="note">No session id on disk for this worktree, so there is no resume command to show.</p>
      )}

      {/* `id` so gate C's evidence section can point at it: the walkthrough is
          long, it belongs at the bottom, and a reference to something with no
          way to reach it is the complaint this card was rebuilt for. */}
      {row.gateReport && (
        <details className="report" id="report">
          <summary>Worker's written report</summary>
          <Markdown source={row.gateReport} />
        </details>
      )}
    </div>
  );
}

const WINDOWS: Array<{ key: SummaryWindow; label: string }> = [
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
];

/**
 * The status post, in the plain-text house format, for pasting into Slack.
 * Nothing is fetched until a window is picked — it costs three GitHub calls, and
 * this page is opened for the grid most of the time. What is rendered here is the
 * same text the Copy button hands over, character for character.
 */
/** Today, in Eastern — the zone the numbers are read in, not this laptop's. */
function etToday(): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return p; // en-CA renders YYYY-MM-DD, which is what a date input wants
}

type CountsReply = {
  range: { from: string; to: string; sinceIso: string; untilIso: string };
  counts: { ticketsStarted: number; prsRaised: number; prsMerged: number; issuesClosed: number };
  beyondAudit: boolean;
  warnings: string[];
};

/**
 * The status panel: four numbers first, the prose second.
 *
 * It used to be three fixed windows — 24h / 7d / 30d counted back from the click
 * — and nine paragraphs of Slack post. The operator wanted the counts, over a
 * single day or a picked range, summarised to match — with the longer written
 * report kept behind its own button rather than generated every time.
 *
 * Then, on finding it folded away at the foot of Overview, the operator asked
 * for the status summary at the top of that tab as a simple tracker, keeping the
 * date selector but defaulting to today. So it is the FIRST thing
 * on that tab, open, and it leads with the four numbers; the dates follow them
 * as a control rather than a question you have to answer to see anything. It
 * still arrives on today, which it always did — what changed is that you now see
 * today without opening anything.
 *
 * Eastern days throughout, because that is where they are read. Three of the
 * four counts come from the console's own audit and cost no read; the report
 * behind the button is the old GitHub-backed post, unchanged.
 */
function SummaryPanel() {
  const today = etToday();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<CountsReply | null>(null);
  const [countsBusy, setCountsBusy] = useState(false);
  const [countsError, setCountsError] = useState<string | null>(null);

  const [picked, setPicked] = useState<SummaryWindow | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadCounts = (f: string, t: string) => {
    setCountsBusy(true);
    setCountsError(null);
    void fetch(`/api/summary/counts?from=${f}&to=${t}`)
      .then(async (r) => {
        const body = (await r.json()) as CountsReply & { message?: string };
        if (r.ok) setData(body);
        else {
          setData(null);
          setCountsError(body.message ?? 'could not read the counts');
        }
      })
      .catch((e: Error) => setCountsError(e.message))
      .finally(() => setCountsBusy(false));
  };

  // The counts are cheap and local, so the panel arrives with today already on
  // screen rather than making you ask for the most common question.
  useEffect(() => {
    loadCounts(today, today);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = (w: SummaryWindow) => {
    setPicked(w);
    setBusy(true);
    setError(null);
    setCopied(false);
    void fetch(`/api/summary?window=${w}`)
      .then(async (r) => {
        const body = (await r.json()) as Summary & { message?: string };
        if (r.ok) setSummary(body);
        else {
          setSummary(null);
          setError(body.message ?? 'could not build the summary');
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  /** The graph runs from here whatever range the tiles show — the operator asked
   *  for a fixed floor of 10 August. It never starts later than the range itself,
   *  so picking an older range widens the graph rather than truncating it. */
  const chartFrom = from < '2026-08-10' ? from : '2026-08-10';

  const tiles: [string, number, string][] = [
    ['Tickets started', data?.counts.ticketsStarted ?? 0, 'moved into In progress on the board'],
    ['PRs raised', data?.counts.prsRaised ?? 0, 'gate D approved — the go-ahead to raise it'],
    ['PRs merged', data?.counts.prsMerged ?? 0, 'merged, so it is on its way to UAT'],
    ['Issues closed', data?.counts.issuesClosed ?? 0, 'closed on GitHub'],
  ];

  const oneDay = from === to;
  /** What the numbers on screen are FOR — read off `data`, not off the inputs,
   *  so it never claims a range that has not been counted yet. */
  const shown = data
    ? data.range.from === data.range.to
      ? data.range.from === today
        ? 'today'
        : data.range.from
      : `${data.range.from} → ${data.range.to}`
    : 'today';
  /** Nothing to go back to when today is already what is on screen — and it is
   *  what is on screen the moment the tab opens. */
  const onToday = from === today && to === today && data?.range.from === today;

  return (
    <Card
      title="Status summary"
      subtitle={`${shown}, in Eastern days`}
      className="wide tracker"
      actions={
        summary ? (
          <>
            <span className="note">read from GitHub {when(summary.generatedAt)}</span>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(summary.markdown).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? 'copied' : 'Copy'}
            </button>
          </>
        ) : undefined
      }
    >
      {/* THE TRACKER, first: four numbers for today, before anything asks you
          for a date. The picker used to sit above this and it made the panel
          read as a form — the operator wanted a simple tracker, and a tracker
          shows the number and then offers to change it. */}
      {/* The tiles and the graph read together: the tiles are the range the
          operator picked, the graph is how it got there. Side by side on a desktop,
          stacked below the fold of a phone — see `.tracker-row`. */}
      <div className="tracker-row">
        <div className="counts-tiles">
          {tiles.map(([label, n, why]) => (
            <div key={label} className="count-tile" title={why}>
              <strong>{countsBusy ? '…' : n}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>
        {/* Deliberately NOT the picked range: the graph answers "how did we get
            here", and starting it where the tiles start would leave one point.
            10 Aug is the floor the operator asked for. */}
        <SummaryChart from={chartFrom} to={to} />
      </div>

      {/* HOW LONG each leg took, under the four counts of how MANY. The same
          range, so the two can never be answering different questions. */}
      <CycleAverages from={chartFrom} to={to} />

      {data && (
        <p className="note">
          {oneDay ? data.range.from : `${data.range.from} → ${data.range.to}`}, Eastern. Started, raised and merged come
          from this console's own audit; issues closed is read from GitHub.
          {data.beyondAudit && ' Part of this range is older than the 30-day audit retention, so those three under-report.'}
        </p>
      )}
      {data && data.warnings.length > 0 && <ErrorLine raw={data.warnings.join('; ')} />}

      {/* The date selector stays, under the numbers it changes. Today is where
          it starts and Today is one click back from anywhere. */}
      <div className="counts-picker">
        <label>
          <span className="note">from</span>
          <input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          <span className="note">to</span>
          <input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="primary" disabled={countsBusy} onClick={() => loadCounts(from, to)}>
          {countsBusy ? 'Counting…' : 'Show'}
        </button>
        <button
          disabled={countsBusy || onToday}
          onClick={() => {
            setFrom(today);
            setTo(today);
            loadCounts(today, today);
          }}
        >
          Today
        </button>
        <span className="note">Eastern time{oneDay ? '' : ' · inclusive of both days'}</span>
      </div>

      {countsError && <ErrorLine raw={countsError} />}

      {/* The long-form post, unchanged and now behind a click — it is a
          different job from "how many", and it costs three GitHub reads. */}
      <details className="summary-report">
        <summary>Generate report — the long post for Slack</summary>
        <div className="toolbar" style={{ margin: '8px 0' }}>
          <span className="seg">
            {WINDOWS.map((w) => (
              <button key={w.key} className={picked === w.key ? 'on' : ''} disabled={busy} onClick={() => load(w.key)}>
                {w.label}
              </button>
            ))}
          </span>
          {picked && !summary && !error && <span className="note">reading GitHub…</span>}
          {!picked && <span className="note">nothing is fetched until you pick a window</span>}
        </div>

        {error && <ErrorLine raw={error} />}
        {summary && summary.warnings.length > 0 && (
          <>
            <ErrorLine raw={`Incomplete — ${summary.warnings.join('; ')}`} />
            <p className="note">
              Those sections say so in the text too, so the post does not read as “nothing happened”.
            </p>
          </>
        )}
        {summary && (
          <div className="summary-text">
            <Markdown source={summary.markdown} />
          </div>
        )}
      </details>
    </Card>
  );
}

const when = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * One anatomy for every block on the Dashboard: a title, an optional one-line
 * subtitle, the content, and the actions bottom-right with whatever stamp says
 * how old the content is.
 *
 * It exists because each block had invented its own — a bare `h4` here, a
 * `.note` acting as a heading there, a Refresh button floating mid-card — and
 * four cards with four shapes is a page you have to read rather than scan.
 */
export function Card({
  title,
  subtitle,
  actions,
  className,
  children,
}: {
  title: string;
  /** One line, never two. If it needs two, it belongs in the disclosure. */
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      <div className="card-head">
        <h3>{title}</h3>
        {subtitle && <p className="card-sub">{subtitle}</p>}
      </div>
      {children}
      {actions && <div className="card-actions">{actions}</div>}
    </section>
  );
}

/** A tool that answers with a rate limit, however it words it. */
const RATE_LIMIT = /rate limit|submitted too quickly|abuse detection/i;

/**
 * A failure, in one line.
 *
 * What these actually look like is
 * `could not read CI: Command failed: gh pr list --repo example-org/example-repo --json
 * number,title,url,headRefName,isDraft,reviewDecision,labels,statusCheckRollup`,
 * and 200 wrapped red characters of that is noise to everybody, including the
 * person who wrote the command. The line says what could not be read and why;
 * the invocation is one click away, because a fix sometimes needs it.
 */
export function shortError(raw: string): string {
  const line = raw.replace(/\s+/g, ' ').trim();
  if (RATE_LIMIT.test(line)) return 'GitHub rate limit — the next read will pick it up';
  const failed = line.match(/Command failed:\s*(\S+)/);
  if (failed) {
    const bin = failed[1]!;
    const tool = bin === 'gh' ? 'GitHub' : bin === 'docker' ? 'Docker' : bin;
    // Whatever the caller said BEFORE the dump is the useful half — "could not
    // read CI" — so it is kept and the invocation is dropped.
    const said = line.slice(0, failed.index).replace(/[:\s—-]+$/, '');
    return said ? `${said} — ${tool} did not answer` : `${tool} did not answer`;
  }
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

/** One red line, with the full text underneath it on a click. A `title`
 *  attribute would do the same on a desktop and nothing at all on a phone. */
function ErrorLine({ raw }: { raw: string }) {
  const short = shortError(raw);
  if (short === raw.replace(/\s+/g, ' ').trim()) return <p className="note err">{short}</p>;
  return (
    <details className="err-line">
      <summary>{short}</summary>
      <pre>{raw}</pre>
    </details>
  );
}

/**
 * Read GitHub now, and say when it was last read.
 *
 * The two halves belong together. The console asks GitHub every fifteen minutes
 * — two exhausted the hourly quota — and at that cadence a page with no age on
 * it is a page that looks live when it is not. So the time GitHub was last read
 * sits next to the button that reads it again, everywhere the button appears.
 */
/**
 * Sync, and when GitHub was last read — ONE control, in the tools group.
 *
 * There were two: a `Refresh` button sitting inside the view switcher, which
 * read as a seventh tab and was the thing the operator kept mis-clicking, and a separate
 * `Sync sources` button buried in the Tickets tab. They refresh different halves
 * (the console's own GitHub poll, and the work-sources snapshot) and no one
 * outside this file would guess which was which, so the button now does both.
 */
function SyncControl({
  state,
  busy,
  onSync,
}: {
  state: ConsoleState;
  busy: boolean;
  onSync: () => void;
}) {
  const at = state.lastPolledAt;
  const every = Number.isFinite(state.pollMs) ? Math.max(1, Math.round(state.pollMs / 60_000)) : null;
  return (
    <span className="refresh">
      <button className="tool" disabled={busy} onClick={onSync}>
        {busy ? 'Syncing…' : 'Sync'}
      </button>
      <span
        className="note read-at"
        title={[
          at ? `read ${ago(Date.now() - Date.parse(at))}` : null,
          every ? `GitHub is read every ${every} min` : 'GitHub is read on a timer',
          'or whenever you press Sync',
        ]
          .filter(Boolean)
          .join(' · ')}
      >
        {at ? `GitHub read ${when(at)}` : 'GitHub not read yet'}
      </span>
    </span>
  );
}

/**
 * AUDIT, in the tools group beside Sync. The operator asked for a recon audit
 * over every open issue that validates what each one's status claims, so that
 * nothing sits stuck without anybody knowing. One click: the server reads GitHub fresh, checks
 * every open row against what its status claims, and the report lands above
 * the rail on the Tickets tab — which is why `onDone` also switches the view
 * there.
 */
function AuditControl({ onDone }: { onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="tool"
      disabled={busy}
      title="Read GitHub, then check every open issue: a blocked row must have a human reason, a draft PR is called out, and anything held past the median of its leg is flagged"
      onClick={() => {
        setBusy(true);
        void post('/api/audit')
          .then((o) => onDone(o.message))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? 'Auditing…' : 'Audit'}
    </button>
  );
}

type RebuildStatus = {
  state: 'idle' | 'building' | 'restarting' | 'failed' | 'done';
  at: string | null;
  log: string;
  canRestart: boolean;
  why: string | null;
};

/**
 * What a rebuild costs, said in front of the click — the same contract as
 * `pauseQuestion`. The worker sentence is the one that matters and it is not a
 * hope: the launch agent abandons its process group, `stop` leaves workers
 * running, and startup re-adopts them by pid. See `orchestrator/src/rebuild.ts`.
 */
const rebuildQuestion =
  'Rebuild the console and restart it?\n\n' +
  'It runs `npm run build` over the working tree as it stands — uncommitted changes included — and then ' +
  'restarts the server through its launch agent. This page reloads itself onto the new bundle when the new ' +
  'server answers.\n\n' +
  'NO WORKER STOPS. Running workers are detached and are re-attached by pid the moment the console is back; ' +
  'their gate files, worktrees and sessions are untouched. A worker mid-turn keeps going throughout — the ' +
  'console simply is not watching for the few seconds it is down.\n\n' +
  'If the build fails, nothing restarts and the console keeps running the code it already has.';

/**
 * REBUILD AND RESTART, in the tools group beside Sync.
 *
 * The awkward part is that the server being restarted is the one this page is
 * asking, so a rebuild cannot be a request that returns an answer. Two signals
 * replace it: `/api/version`'s `buildId`, whose CHANGE is what proves a new
 * server came up (and is the cue to reload, since the old bundle would otherwise
 * keep rendering — the whole reason `StaleBundleBanner` exists), and
 * `/api/system/rebuild`, which is how a FAILED build reports itself, because a
 * failed build leaves no new server to ask.
 */
function RebuildControl({ onSay }: { onSay: (m: string) => void }) {
  const [state, setState] = useState<RebuildStatus['state']>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [blocker, setBlocker] = useState<string | null>(null);
  const startedFrom = useRef<string | null>(null);
  const polling = useRef<number | null>(null);

  // Whether this console can restart itself at all is a property of how it was
  // launched, so it is read once: a button that cannot work should say so before
  // it is pressed, not after.
  useEffect(() => {
    let stop = false;
    void fetch('/api/system/rebuild')
      .then((r) => r.json() as Promise<RebuildStatus>)
      .then((v) => {
        if (stop) return;
        setBlocker(v.canRestart ? null : v.why);
        // A rebuild already in flight when this page loaded — started from
        // another tab, or before it was opened — is this page's business too.
        if (v.state === 'building' || v.state === 'restarting') watch();
      })
      .catch(() => undefined);
    return () => {
      stop = true;
      if (polling.current) window.clearInterval(polling.current);
    };
  }, []);

  /** The last line of the build output that says anything — the actual error. */
  const errorLine = (log: string): string => {
    const lines = log.split('\n').filter((l) => l.trim());
    return lines.at(-1) ?? '';
  };

  const watch = (): void => {
    if (polling.current) window.clearInterval(polling.current);
    polling.current = window.setInterval(() => {
      void fetch('/api/version')
        .then((r) => r.json() as Promise<{ buildId: string | null }>)
        .then((v) => {
          // A DIFFERENT id is a different server: the restart landed, and this
          // page is now the stale half. Reloading is the last step of the click.
          if (v.buildId && startedFrom.current !== null && v.buildId !== startedFrom.current) {
            window.location.reload();
          }
        })
        .catch(() => {
          // The console is down mid-restart. Expected, and not worth saying.
        });
      void fetch('/api/system/rebuild')
        .then((r) => r.json() as Promise<RebuildStatus>)
        .then((v) => {
          setState(v.state);
          if (v.state !== 'failed') return;
          if (polling.current) window.clearInterval(polling.current);
          polling.current = null;
          const line = errorLine(v.log);
          setFailure(line || 'the build failed and wrote no output');
          onSay(`the rebuild failed — the console is still running the code it had. Full log: runs/rebuild.log`);
        })
        .catch(() => undefined);
    }, 2000);
  };

  const click = (): void => {
    if (!confirm(rebuildQuestion)) return;
    setFailure(null);
    // The id to compare against has to be read BEFORE the build starts. Read
    // after, it could already be the new one and the page would never reload.
    void fetch('/api/version')
      .then((r) => r.json() as Promise<{ buildId: string | null }>)
      .then((v) => {
        startedFrom.current = v.buildId;
      })
      .catch(() => {
        startedFrom.current = null;
      })
      .then(() => post('/api/system/rebuild'))
      .then((out) => {
        onSay(out.message);
        if (!out.ok) return;
        setState('building');
        watch();
      })
      .catch((e: Error) => onSay(`the rebuild could not be started — ${e.message}`));
  };

  const busy = state === 'building' || state === 'restarting';
  const label = state === 'restarting' ? 'Restarting…' : state === 'building' ? 'Rebuilding…' : 'Rebuild';
  return (
    <span className="refresh">
      <button className="tool" disabled={busy || blocker !== null} onClick={click} title={blocker ?? rebuildQuestion}>
        {label}
      </button>
      {blocker !== null && (
        <span className="note" title={blocker}>
          cannot restart itself
        </span>
      )}
      {failure !== null && (
        <span className="note err" title={failure}>
          rebuild failed — {failure.length > 70 ? `${failure.slice(0, 70)}…` : failure}
        </span>
      )}
    </span>
  );
}

const GB = 1024 ** 3;
const gbLabel = (b: number | null | undefined): string => (b === null || b === undefined ? 'unknown' : `${(b / GB).toFixed(1)} GB`);

const secsAgo = (iso: string): string => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};

/**
 * What a pause actually costs, said in front of the click.
 *
 * Everything on disk survives — edits, the session, the gate files, the queue —
 * and that is why this lever exists at all. The one honest caveat is the last
 * sentence: it is not a promise that a pause is free, because a pause that lands
 * while the model is mid-response can cost a retried request. Nothing on disk is
 * lost in either case, and the recovery is the resume button that is already there.
 */
const pauseQuestion = (n: number, size: string): string =>
  `Pause the worker on #${n}?\n\n` +
  `It freezes the whole process tree (${size}) with SIGSTOP and gives that memory back to the machine. ` +
  `Nothing is killed: its uncommitted edits, its session, its gate files and anything queued for it are ` +
  `untouched, and Resume picks it straight back up. It GIVES ITS SLOT BACK, so you can park this one and ` +
  `start another issue. What it still holds is memory — the processes are frozen, not gone — so the ` +
  `memory guard may still hold the next worker back.\n\n` +
  `The one caveat: if it happens to be mid-response rather than running a command, the paused connection ` +
  `can drop and that request may be retried or the segment may end as failed — recoverable with one ` +
  `Resume click, and nothing on disk is lost either way.`;

/**
 * The restart-edge question, in ONE place.
 *
 * It is asked from two screens now — the container list on Resources, and the
 * pressure banner that rides every view — so a hand-written second copy would
 * put two different sentences about one act on two different tabs. `name` is
 * null on the banner, which knows the size but not the container.
 *
 * The "what is NOT touched" clause is the reason the dialog is answerable at
 * all. It is never trimmed.
 */
export const restartEdgeQuestion = (name: string | null, size: string): string =>
  `Restart ${name ?? 'the edge runtime container'}?\n\n` +
  `It is using ${size}. This takes about 12 seconds and drops it back to roughly 380 MB. ` +
  `The database is NOT touched and no other container is touched. A worker mid-flight could see an ` +
  `edge function fail while it comes back.`;

/**
 * The header's last clause — the forecast, short enough for one line. The full
 * sentence lives on the Resources tab; this is the part that has to be true at a
 * glance from any view.
 */
function headroomClause(w: WatchReport): string {
  const running = w.workers.filter((x) => !x.paused).length;
  const paused = w.workers.filter((x) => x.paused).length;
  // A paused worker no longer holds a slot, so this stopped being a call to
  // action and became a fact: it is parked, and it is still holding its RAM.
  if (paused > 0 && running === 0) return `${paused} parked, holding memory`;
  if (running === 0) return 'nothing running';
  const spikes = running === 1 ? 'its spike' : running === 2 ? 'both spikes' : `all ${running} spikes`;
  return w.forecast.comfortable ? `room for ${spikes}` : `NOT room for ${spikes}`;
}

/**
 * The loud one. It appears whenever the ladder is above `hold`, on every view,
 * and carries the buttons rather than sending anybody looking for them — the
 * failure it is built against is a dashboard that reported a number and offered
 * nothing to do about it.
 */
function WatchBanner({ state, onDone }: { state: ConsoleState; onDone: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const w = state.watch;
  const anyPaused = Boolean(w?.workers.some((x) => x.paused));
  // A paused worker no longer blocks dispatch, but it is still holding
  // gigabytes and it is still not finishing its issue, so it stays visible from
  // every view — a frozen worker nobody is reminded about is one nobody resumes.
  if (!w || ((w.level === 'ok' || w.level === 'hold') && !anyPaused)) return null;

  const unpaused = w.workers.filter((x) => !x.paused);
  const biggest = [...unpaused].sort((a, b) => b.treeBytes - a.treeBytes)[0] ?? null;
  const paused = w.workers.filter((x) => x.paused);
  const act = (path: string, question: string | null) => {
    if (question && !window.confirm(question)) return;
    setBusy(true);
    void post(path).then((o) => {
      setBusy(false);
      onDone(o.message);
    });
  };

  const quiet = w.level === 'ok' || w.level === 'hold';
  const headline =
    w.level === 'floor'
      ? w.autoPauseFloor
        ? `Memory floor — ${w.sample.freePct}% free. Every running worker has been paused.`
        : `Memory floor — ${w.sample.freePct}% free. The floor would have paused all workers; automatic pause is off.`
      : w.level === 'pause-largest'
        ? `Memory is low — ${w.sample.freePct}% free. Pausing the biggest worker gives its memory straight back.`
        : w.level === 'warn'
          ? `Memory is getting tight — ${w.sample.freePct}% free.`
          : `${paused.length === 1 ? 'A worker is' : `${paused.length} workers are`} parked. ` +
            `Nothing is lost, and the slot is free — you can start another issue. ` +
            `${paused.length === 1 ? 'It is' : 'They are'} still holding memory, so the memory guard may ` +
            `hold the next one until you resume ${paused.length === 1 ? 'it' : 'them'}.`;

  return (
    <div className={`banner ${quiet ? '' : 'warn'}`}>
      <span>
        {headline}
        {!quiet && ` ${w.forecast.sentence}`}
      </span>
      {/* Pausing is only offered while the machine is actually under pressure.
          On a quiet banner — the one that exists purely to say something is
          paused — the only button that belongs is Resume. */}
      {!quiet && biggest && (
        <button
          className="danger"
          disabled={busy}
          onClick={() =>
            act(`/api/issues/${biggest.issue}/pause`, pauseQuestion(biggest.issue, gbLabel(biggest.treeBytes)))
          }
        >
          Pause #{biggest.issue} ({gbLabel(biggest.treeBytes)})
        </button>
      )}
      {!quiet && unpaused.length > 1 && (
        <button
          className="danger"
          disabled={busy}
          onClick={() =>
            act(
              '/api/resources/pause-all',
              `Pause all ${unpaused.length} running workers?\n\n` +
                `Each one is frozen with SIGSTOP and gives its memory back. Nothing is killed and nothing on disk ` +
                `is lost — edits, sessions, gate files and the queue all survive, and each row gets a Resume button.`,
            )
          }
        >
          Pause all {unpaused.length}
        </button>
      )}
      {paused.map((x) => (
        <button key={x.pid} disabled={busy} onClick={() => act(`/api/issues/${x.issue}/unpause`, null)}>
          Resume #{x.issue}
        </button>
      ))}
    </div>
  );
}

/**
 * The machine — ONE card.
 *
 * It used to be two blocks that overlapped: "The machine, measured" (the live
 * watcher sample, per worker) immediately followed by "What is running on this
 * machine" (the on-demand docker/lsof inventory), each with its own heading, its
 * own free-% number and its own idea of how fresh it was. Two machine sections
 * on a page about one machine is why the Dashboard read as documentation.
 *
 * So: one card, one Refresh, one stamp that names both cadences honestly —
 * because they really are two. The live line is at most one tick old (5 s while
 * workers run) off state that is already here; the containers and ports cost a
 * `docker stats` and an `lsof` per port, so they move only on the button. The
 * caveats that make those numbers honest have not gone anywhere; they are in the
 * disclosure at the bottom, where they stop competing with the numbers.
 */
/**
 * SWAP — the memory signal free % cannot give you.
 *
 * Free % answers "is there room right now". Swap answers "has the machine
 * already been paying for the room it is reporting", and the two disagree
 * exactly when it matters: on 2026-08-12 the console read 31% free while swap
 * was 15,137 MB of 16,384 used with 8.37 GB compressed, and the machine was at
 * the cliff.
 *
 * It HOLDS dispatch at the ceiling and does nothing else — no pause, no kill.
 * An unreadable `sysctl` says so, in those words, and the free-% guard carries
 * on alone rather than a missing measurement being scored as a healthy one.
 */
function SwapLine({ state }: { state: ConsoleState }) {
  const r = state.resources;
  if (!r) return null;
  if (r.swapUsedPct === null) {
    return (
      <p className="note">
        Swap could not be read (<code>sysctl -n vm.swapusage</code>), so the free % above is the only memory signal.
      </p>
    );
  }
  const over = r.maxSwapPct > 0 && r.swapUsedPct >= r.maxSwapPct;
  return (
    <p className={`truth-system ${over ? 'bad' : ''}`}>
      swap {r.swapLabel}
      {over
        ? ` — over the ${r.maxSwapPct}% ceiling, so nothing new is being dispatched. Nothing has been paused or stopped.`
        : ` — dispatch holds at ${r.maxSwapPct}%.`}
    </p>
  );
}

function MachinePanel({ state, onDone }: { state: ConsoleState; onDone: (m: string) => void }) {
  const [inv, setInv] = useState<InstanceReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const w = state.watch;

  const load = () => {
    setBusy(true);
    setError(null);
    void fetch('/api/instances')
      .then((r) => r.json() as Promise<InstanceReport>)
      .then(setInv)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(load, []);

  /** Every button on this card: ask first where it matters, say what happened,
   *  and re-read the inventory only when the thing it lists actually changed. */
  const act = (path: string, question: string | null, reload = false) => {
    if (question && !window.confirm(question)) return;
    setBusy(true);
    void post(path).then((o) => {
      setBusy(false);
      onDone(o.message);
      if (reload) load();
    });
  };

  const edge = inv?.containers.find((c) => c.isEdgeRuntime) ?? null;

  return (
    <Card
      title="The machine"
      subtitle="what it has, what is using it, and what happens if the workers all spike at once"
      actions={
        <>
          <span className="note">
            {w ? `live, sampled ${secsAgo(w.sample.at)}` : 'no live sample yet'}
            {inv ? ` · containers and ports read ${when(inv.checkedAt)}` : ''}
          </span>
          <button disabled={busy} onClick={load}>
            {busy ? 'reading…' : 'Refresh'}
          </button>
        </>
      }
    >
      {/* The numbers, first and alone. */}
      {w ? (
        <>
          <p className="truth-system">
            {w.totalBytes > 0 && `${Math.round(w.totalBytes / GB)} GB total · `}
            {w.sample.freePct === null ? 'free % unknown' : `${w.sample.freePct}% free`} ·{' '}
            {gbLabel(w.sample.headroomBytes)} reclaimable headroom
          </p>
          {/* THE SECOND SIGNAL, on its own line because it disagrees with the
              first exactly when that matters. It comes off the machine read
              rather than the watcher's tick: swap fills over minutes. */}
          <SwapLine state={state} />
          <p className={`truth-forecast ${w.forecast.comfortable ? '' : 'bad'}`}>{w.forecast.sentence}</p>
          {w.workers.length === 0 ? (
            <p className="note">no workers running, so there is nothing to measure</p>
          ) : (
            <ul className="truth-workers">
              {w.workers.map((x) => (
                <li key={x.pid}>
                  {x.paused ? (
                    <>
                      <code>#{x.issue}</code>
                      <span className="tag paused">
                        paused by {x.paused.by === 'floor' ? 'the memory floor' : 'you'} at {when(x.paused.at)}
                        {x.paused.reason ? ` (${x.paused.reason})` : ''}
                      </span>
                      <span className="mem">{gbLabel(x.treeBytes)} held</span>
                      <span className="note">
                        {x.stoppedProcs} of {x.procCount} processes stopped
                      </span>
                      <button disabled={busy} onClick={() => act(`/api/issues/${x.issue}/unpause`, null)}>
                        Resume
                      </button>
                    </>
                  ) : (
                    <>
                      <code>
                        #{x.issue} · pid {x.pid}
                      </code>
                      <span className="tag">{x.procCount} procs</span>
                      <span className="mem">{gbLabel(x.treeBytes)} now</span>
                      <span className="note">peak {gbLabel(x.peakTreeBytes ?? x.treeBytes)}</span>
                      {x.lastTool && <span className="note">{x.lastTool}</span>}
                      <button
                        disabled={busy}
                        onClick={() => act(`/api/issues/${x.issue}/pause`, pauseQuestion(x.issue, gbLabel(x.treeBytes)))}
                      >
                        Pause
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="note">no sample yet — the watcher takes one every few seconds</p>
      )}

      {inv && (
        <p className="note totals">
          containers {inv.totals.containerLabel} · dev servers {inv.totals.devServerLabel} · workers{' '}
          {inv.totals.workerLabel}
        </p>
      )}
      {error && <ErrorLine raw={`could not read what is running: ${error}`} />}
      {inv?.notes.map((n) => (
        <ErrorLine key={n} raw={n} />
      ))}
      {!inv && !error && <p className="note">reading docker and the worktree ports…</p>}

      {inv && (
        <div className="inst-groups">
          <div className="inst-group">
            <h4>
              Containers <span className="note">one shared Supabase stack — not one per worktree</span>
            </h4>
            {inv.containers.length === 0 && <p className="note">none reported</p>}
            <ul>
              {inv.containers.map((c) => (
                <li key={c.name}>
                  <code>{c.name}</code>
                  <span className="mem">{c.label}</span>
                  {c.isEdgeRuntime && (
                    <>
                      <span className="tag">the known leaker</span>
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() =>
                          act('/api/resources/restart-edge-runtime', restartEdgeQuestion(c.name, c.label), true)
                        }
                      >
                        Restart it
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className="inst-group">
            <h4>
              Dev servers <span className="note">one per worktree that has one running — usually not all</span>
            </h4>
            {inv.devServers.length === 0 && <p className="note">none running on any worktree port</p>}
            <ul>
              {inv.devServers.map((d) => (
                <li key={d.port}>
                  <code>
                    port {d.port} · pid {d.pid}
                  </code>
                  <span className="mem">{d.label}</span>
                  <span className="tag">{d.issue === null ? 'unattributed' : `#${d.issue}`}</span>
                  {d.stoppable && d.issue !== null ? (
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() =>
                        act(
                          `/api/issues/${d.issue}/stop-dev-server`,
                          `Stop the dev server for #${d.issue}?\n\n` +
                            `This sends SIGTERM to pid ${d.pid}, which is listening on port ${d.port} and running ` +
                            `in ${d.worktree}. It frees ${d.label}. The worker is not touched, and nothing else is. ` +
                            `Start it again with npm run dev in that worktree when you next need the app.`,
                          true,
                        )
                      }
                    >
                      Stop it
                    </button>
                  ) : (
                    <span className="note">{d.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className="inst-group">
            <h4>
              Workers <span className="note">the agent processes this console started</span>
            </h4>
            {inv.workers.length === 0 && <p className="note">none running</p>}
            <ul>
              {inv.workers.map((x) => (
                <li key={x.pid}>
                  <code>
                    #{x.issue} · pid {x.pid}
                  </code>
                  <span className="mem">{x.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {edge === null && inv && <p className="note">the edge runtime container is not running</p>}

      {/* Every caveat that used to shout at body weight, in the one place they
          belong. None of it is gone — it is why the numbers above can be
          believed — but a caveat that competes with the number it qualifies
          makes both unreadable. */}
      <details className="how">
        <summary>How this is measured</summary>
        {w && (
          <p className="note">
            The live line is one <code>ps</code> over the whole process table plus <code>memory_pressure</code> and{' '}
            <code>vm_stat</code>, every {Math.round(w.intervalMs / 1000)}s — under 100 ms a tick, and no network.{' '}
            <code>docker stats</code> and one <code>lsof</code> per worktree port cost a second or two, so the
            containers, dev servers and workers below refresh on the button instead.
          </p>
        )}
        <p className="note">
          The console can itemize its own workers, the containers and the worktree dev servers. Chrome, OrbStack's VM
          overhead and your own terminal sessions are inside the free % but not itemized here.
        </p>
        {w && (
          <>
            <p className="note">
              Tree sizes are RSS sums, which count each process's copy of shared pages — an over-estimate of what these
              workers really cost, and deliberately the safe direction. The forecast models a {gbLabel(w.spikeBytes)}{' '}
              spike per worker (WORKER_HEADROOM_GB), so it is a model, not a measurement.
            </p>
            <p className="note">
              The ladder: dispatch holds under {w.thresholds.minFreePct}% free, a warning at {w.thresholds.warnFreePct}%,
              a one-click pause offered at {w.thresholds.pauseFreePct}%, and at {w.thresholds.floorFreePct}%{' '}
              {w.autoPauseFloor
                ? 'every worker is paused automatically. Automation only ever pauses — it never kills, never restarts and never resumes.'
                : 'the floor would pause every worker, but automatic pause is OFF, so it will only tell you.'}
            </p>
          </>
        )}
        <p className="note">
          A dev server is only ever stopped when you click — here, as part of stopping a worker that is running, or
          when you APPROVE GATE C, which is the moment its last customer walks away: the screenshot capture and your
          own click-through are both over, and nothing between there and the merge needs it. A worker merely PARKING at
          gate C keeps its server, because that is where you QA the app. Port 8080 is never listed and never stopped: it
          is the primary checkout's dev server and it serves edge functions for every worktree.
        </p>
        <p className="note">
          A worker is 0.2–0.5 GB at rest. The spike that matters is <code>npm run validate</code> or jest, at 1–2 GB —
          which is what the headroom check holds a new worker back for.
        </p>
      </details>
    </Card>
  );
}

/** Stamped in by Vite at build time — see ui/vite.config.ts. */
declare const __BUILD_ID__: string;

/**
 * The page and the console disagreeing about which build they are.
 *
 * `npm run build` overwrites `ui/dist` while the console is running, so a
 * refreshed browser gets a NEW page talking to the OLD API it was not built
 * for. Nothing throws: the buttons just quietly stop working, which is exactly
 * what happened to the operator's Approve button. One id each, compared once on load, and
 * the failure becomes a sentence instead of a mystery.
 */
function StaleBundleBanner() {
  const [serverId, setServerId] = useState<string | null>(null);

  useEffect(() => {
    // Running against the Vite dev server, the two ids are MEANT to differ:
    // the page is compiled fresh and the console is serving whatever was last
    // built into dist. Nothing to warn about.
    if (import.meta.env.DEV) return;

    // KEEP CHECKING. This used to run once on mount, which meant it could only
    // ever catch a page opened AFTER a rebuild — never the case that actually
    // happens, which is a page left open WHILE the console is rebuilt under it.
    // The operator had this tab open for hours across several rebuilds. The state stream
    // kept feeding it current data and the old bundle kept rendering it, quietly
    // dropping every field it did not know about: the review line and the
    // pre-merge checklist on #4344 were both being sent and both invisible, so
    // "PR open" was the whole story the page could tell. The operator asked where
    // the visibility had gone. It was in the payload, thrown away by stale code.
    //
    // A dashboard that silently hides new information is worse than one that is
    // down, so this is worth a request every half minute against localhost.
    let stop = false;
    const check = (): void => {
      if (stop) return;
      void fetch('/api/version')
        .then((r) => r.json() as Promise<{ buildId: string | null }>)
        .then((v) => {
          if (!stop) setServerId(v.buildId);
        })
        .catch(() => {
          // A failed check means the console is down or restarting, which the
          // state stream already says loudly. Do not also claim staleness.
        });
    };
    check();
    const timer = setInterval(check, 30_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  if (!serverId || serverId === __BUILD_ID__) return null;
  // Both ids are ISO timestamps, so which side is behind is knowable.
  return (
    <div className="banner warn">
      {__BUILD_ID__ > serverId
        ? 'This page is newer than the console: the UI was rebuilt after the console started, so buttons here can ' +
          'silently do nothing. Restart the console (npm start) and reload the page.'
        : 'This page is older than the console — reload it to pick up the current one. Until you do, buttons here ' +
          'can silently do nothing.'}
    </div>
  );
}

/**
 * Can the model-router decision be made yet?
 *
 * The Settings tab has the full per-model × per-segment table; this is the one
 * sentence that table cannot say by being read. It shows a SNAPSHOT computed by
 * a background job — at console start, then daily — so opening the Dashboard
 * costs nothing, and its age is always on screen.
 *
 * It reports readiness only. No ranking, no trend, no model named as the answer:
 * which model wins is the question the data is being collected to settle, and a
 * card that hints at a conclusion it cannot support is worse than no card.
 *
 * What is VISIBLE is the one-line verdict and the one line that says what would
 * change it. Four paragraphs explaining what a decision would weigh used to sit
 * on top of that verdict at body weight, which buried the only sentence anybody
 * reads this card for; they are in the disclosure now.
 */
function RouterCard() {
  const [snap, setSnap] = useState<MetricsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);

  const read = (path: string, method: 'GET' | 'POST') => {
    setBusy(true);
    void fetch(path, { method })
      .then((r) => r.json() as Promise<{ snapshot: MetricsSnapshot | null }>)
      .then((o) => setSnap(o.snapshot))
      .catch(() => setSnap(null))
      .finally(() => {
        setBusy(false);
        setAsked(true);
      });
  };
  useEffect(() => read('/api/metrics/snapshot', 'GET'), []);

  const recompute = (
    <button disabled={busy} onClick={() => read('/api/metrics/refresh', 'POST')}>
      {busy ? 'reading…' : 'Recompute'}
    </button>
  );

  if (!snap) {
    return asked ? (
      <Card title="The model router" actions={recompute}>
        <p className="note">
          nothing measured yet — the daily job runs when the console starts. <code>runs.jsonl</code> is where it
          reads from.
        </p>
      </Card>
    ) : null;
  }

  const ageMin = Math.round((Date.now() - Date.parse(snap.computedAt)) / 60_000);
  const age = ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin / 60)} h ago`;

  return (
    <Card
      title="The model router"
      subtitle="can you decide yet?"
      actions={
        <>
          <span className="note">
            {snap.totalRuns} run{snap.totalRuns === 1 ? '' : 's'} logged ·{' '}
            {snap.models.length === 0
              ? 'no models yet'
              : `${snap.models.length} model${snap.models.length === 1 ? '' : 's'}`}{' '}
            · computed {age}
          </span>
          {recompute}
        </>
      }
    >
      {/* The answer, and the one line that says what would change it. */}
      <p className={`verdict${snap.readiness.ready ? ' ready' : ''}`}>{snap.readiness.headline}</p>
      {snap.readiness.next && <p className="note">{snap.readiness.next}</p>}
      {snap.error && <ErrorLine raw={`the last refresh was incomplete: ${snap.error}`} />}
      <details className="how">
        <summary>How this is measured</summary>
        <p className="note">
          What a decision would compare, per segment: cost (tokens, time) against quality (rounds of gate feedback
          before approval, first-time approvals, rework rounds, CI red), read against how much code that segment
          actually touched — otherwise the hardest issues make the model that did them look worst. The full table is in
          Settings.
        </p>
      </details>
    </Card>
  );
}

/* ---------------------------------------------------------- actions on you */

/**
 * One action, as a row. The whole feed is READ-ONLY: every row's real button is
 * a link OUT to GitHub. There is no reply box here and there is not going to be
 * one — `comment.ts` remains the only thing in this console that ever writes to
 * GitHub, and it needs a click on the issue card to do it.
 *
 * `a.tier` is the server's stamp, off the one UAT predicate. The page styles it;
 * it never decides it.
 */
function ActionRow({ action, onPick }: { action: Action; onPick: (n: number) => void }) {
  const tone = action.tier === 1 ? 'one' : action.tier === 2 ? 'two' : 'three';
  return (
    <div className={`feed-row ${tone}`}>
      <div className="feed-head">
        <span className={`chip${action.tier === 1 ? ' uat' : ''}`}>{kindLabel(action.kind)}</span>
        <span className="feed-what">
          {action.subject.type === 'pr' ? 'PR ' : ''}#{action.subject.number} — {action.subject.title}
        </span>
        <span className="feed-when">{since(action.eventAt)}</span>
      </div>
      <p className="feed-why">{action.reason}</p>
      {action.detail !== null && <p className="feed-detail">{plainDetail(action.detail)}</p>}
      <div className="feed-links">
        {action.consoleIssue !== null && (
          <button className="linkish" onClick={() => onPick(action.consoleIssue as number)}>
            open in console
          </button>
        )}
        <a href={action.url} target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
      </div>
    </div>
  );
}

function ActionSection({
  tier,
  actions,
  onPick,
}: {
  tier: ActionTier;
  actions: Action[];
  onPick: (n: number) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div className={`feed-sec ${tier === 1 ? 'one' : tier === 2 ? 'two' : 'three'}`}>
      <h4>
        {TIER_TITLE[tier]} · {actions.length}
      </h4>
      <p className="note">{TIER_SUB[tier]}</p>
      {actions.map((a) => (
        <ActionRow key={a.id} action={a} onPick={onPick} />
      ))}
    </div>
  );
}

/**
 * Everything on GitHub that is on the operator, in one card, in the order it should be
 * dealt with. The answer to the question the strip above it asks.
 *
 * Three honesty rules, all of them the console's existing convention:
 *   - the age shown is the age of the DATA, never of the last attempt;
 *   - a failed read keeps the last good rows and says they may be handled, and
 *     never empties the list;
 *   - "nothing needs you" and "we could not ask" are different sentences.
 */
function ActionsCard({ state, onPick }: { state: ConsoleState; onPick: (n: number) => void }) {
  const [busy, setBusy] = useState(false);
  const feed = feedOf(state);
  const list = feed.actions;
  // Tier 3 is FYI — the board moving, a PR merging. It is already excluded from
  // every count, and on the day this was written it was twelve of the seventeen
  // rows on the page. It keeps its place in the card and loses its place on the
  // screen.
  const three = byTier(list, 3);
  return (
    <Card
      title="Actions on you"
      subtitle={
        feed.fetchedAt
          ? `every action on you that lives on GitHub — read ${when(feed.fetchedAt)}`
          : 'every action on you that lives on GitHub'
      }
      className="wide"
      actions={
        <>
          <button
            disabled={busy || list.length === 0}
            onClick={() => {
              setBusy(true);
              void post('/api/actions/seen').finally(() => setBusy(false));
            }}
          >
            Mark all seen
          </button>
          <span className="note">
            it retires the news below — a UAT send-back stays until GitHub says the fix shipped
          </span>
        </>
      }
    >
      {/* Every one of these is a different problem with a different answer, so
          they are separate lines rather than one merged "something is wrong". */}
      {feed.banner && <p className="note err">{feed.banner}</p>}
      {feed.paused && <p className="note err">{feed.paused}</p>}
      {feed.pushProblem && <p className="note err">{feed.pushProblem}</p>}
      {/* The quota was read on every poll and shown nowhere, so the first sign
          of exhaustion was this feed going dark. It stays quiet until low. */}
      {quotaNote(feed.quota) && <p className="note">{quotaNote(feed.quota)}</p>}

      {list.length === 0 ? (
        <p className="note">
          {feed.fetchedAt
            ? `Nothing on GitHub needs you. Checked ${when(feed.fetchedAt)}.`
            : 'GitHub has not been read yet — this fills after the first read.'}
        </p>
      ) : (
        <>
          <ActionSection tier={1} actions={byTier(list, 1)} onPick={onPick} />
          <ActionSection tier={2} actions={byTier(list, 2)} onPick={onPick} />
          {three.length > 0 && (
            <details className="report">
              <summary>FYI — {three.length} more</summary>
              <p className="note">{TIER_SUB[3]}</p>
              {three.map((a) => (
                <ActionRow key={a.id} action={a} onPick={onPick} />
              ))}
            </details>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * In-app notifications.
 *
 * Three rules, and they are the difference between a notifier the operator keeps
 * and one they mute in a week:
 *
 *  1. **The server decides what is worth one.** These are drawn from the named
 *     `action` SSE event, which the orchestrator only emits for something new in
 *     its ledger. Three open tabs cannot toast the same UAT fail three times,
 *     and a tab opened after the fact does not miss it — the server owns "has
 *     this been announced", the tab owns only "have I drawn it".
 *  2. **Fix-first is sticky, everything else fades.** A UAT send-back stays
 *     until it is dismissed; a tier-2 notice clears itself after fifteen
 *     seconds. Neither ever covers the header or a button.
 *  3. **At most three at a time.** A stack of nine is a wall, and a wall gets
 *     ignored exactly like no notification at all.
 */
function Toasts({
  toasts,
  onDismiss,
  onPick,
}: {
  toasts: Action[];
  onDismiss: (id: string) => void;
  onPick: (n: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((a) => (
        <div key={a.id} className={`toast${a.tier === 1 ? ' one' : ''}`}>
          <div className="toast-head">
            <strong>
              {kindLabel(a.kind)} — {a.subject.type === 'pr' ? 'PR ' : ''}#{a.subject.number}
            </strong>
            <button className="x" aria-label="dismiss" onClick={() => onDismiss(a.id)}>
              ×
            </button>
          </div>
          <p>{a.reason}</p>
          <div className="toast-links">
            {a.consoleIssue !== null && (
              <button
                className="linkish"
                onClick={() => {
                  onPick(a.consoleIssue as number);
                  onDismiss(a.id);
                }}
              >
                open in console
              </button>
            )}
            <a href={a.url} target="_blank" rel="noreferrer">
              GitHub ↗
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * What the console has announced, and when.
 *
 * A LOG, not a second copy of the feed. The feed answers "what still needs me"
 * and empties itself as things are dealt with; this answers "what did the
 * console tell me" and does not — which is the question the operator went
 * looking for a bell to answer and could not find one.
 *
 * It reads the same ledger that decides what has already been sent, so the tab
 * cannot disagree with what actually went out. Opening it marks everything read:
 * that is what a bell does, and a per-row read button is a chore.
 */
function NotificationsView({ unread }: { unread: number }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [cleared, setCleared] = useState(false);

  const load = () =>
    fetch('/api/notifications')
      .then((r) => r.json() as Promise<{ entries: LogEntry[] }>)
      .then((o) => setEntries(o.entries))
      // A console that predates this route answers with the page's own HTML,
      // which is not JSON. An empty log is the honest reading of that.
      .catch(() => setEntries([]));

  /**
   * Read on open — and only AFTER the list has been fetched.
   *
   * Firing both at once is a race the reader loses: the POST can settle the
   * ledger before the GET reads it, and the tab then draws every row as already
   * read. The whole point of opening a bell is seeing which ones were new, so
   * the mark-read waits for the list it is about to grey out.
   *
   * Re-run on `unread`, not once on mount. The badge rides the SSE, so one
   * arriving while this tab is already open lit the bell and left the list a
   * snapshot with no way to clear it: the count sat there until the operator
   * navigated away and back, which is the console showing a number and refusing
   * to show the thing behind it. `unread` goes to 0 straight after, so this settles.
   */
  useEffect(() => {
    void load().then(() => post('/api/notifications/read'));
  }, [unread]);

  const clear = () => {
    const ok = window.confirm(
      `Clear the log?\n\n` +
        `It empties this list. It does not touch the actions feed, push, or anything on GitHub — and the ` +
        `console still remembers what it has announced, so nothing is sent twice. A cleared entry cannot be ` +
        `brought back.`,
    );
    if (!ok) return;
    setBusy(true);
    void post('/api/notifications/clear').then(() => {
      setBusy(false);
      setCleared(true);
      load();
    });
  };

  return (
    <div className="grid-wrap">
      <Card
        title="Notifications"
        subtitle="what the console announced and when — newest first"
        className="wide"
        actions={
          <button className="linkish" disabled={busy || (entries?.length ?? 0) === 0} onClick={clear}>
            clear
          </button>
        }
      >
        {entries === null ? (
          <p className="note">reading the log…</p>
        ) : entries.length === 0 ? (
          <p className="note">{cleared ? 'log cleared — new notifications land here' : 'nothing announced yet'}</p>
        ) : (
          <ul className="log">
            {entries.map((e) => (
              <li key={e.id} className={e.read ? '' : 'unread'}>
                <span className="log-when">{since(e.at)}</span>
                <span className={`chip${e.tier === 1 ? ' uat' : ''}`}>{kindLabel(e.kind)}</span>
                {e.subject ? (
                  <a href={e.subject.url} target="_blank" rel="noreferrer">
                    {e.subject.type === 'pr' ? 'PR ' : ''}#{e.subject.number}
                  </a>
                ) : (
                  <span className="note">recorded before the log kept details</span>
                )}
                {e.reason && <span className="log-why">{e.reason}</span>}
                {e.seeded && <span className="note">seen at first read — never announced</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * The off switches, and the phone.
 *
 * It lives in Settings beside the accounts because it is the same kind of thing:
 * a thing about this console that the operator owns. Every control here writes real state
 * on the server — there is no environment variable to edit, and nothing here is
 * remembered only in this browser.
 */
function NotifySettings({
  prefs,
  pushDevices,
  onDone,
}: {
  prefs: NotifyPrefs;
  pushDevices: number;
  onDone: (m: string) => void;
}) {
  const [ready, setReady] = useState<PushReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => void readReadiness().then(setReady);
  useEffect(() => {
    if (pushSupported()) refresh();
  }, []);

  const patch = (body: Record<string, unknown>) => {
    void post('/api/notify/prefs', body).then(() => onDone('notification settings saved'));
  };
  const blocked = ready ? blockedReason(ready) : null;

  return (
    <>
      <h2 style={{ fontSize: 17, margin: '34px 0 8px' }}>Notifications</h2>
      <p>
        The console tells you when something new lands on you on GitHub — a UAT send-back, a review, a comment. Two
        channels: <strong>in the app</strong> while it is open, and <strong>on your phone</strong> when it is not.
      </p>

      <div className="notify-row">
        <span className="notify-what">
          <strong>All notifications</strong>
          <p className="note">off here means nothing announces anywhere; the actions feed still fills.</p>
        </span>
        <label className="switch">
          <input type="checkbox" checked={prefs.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span>{prefs.enabled ? 'On' : 'Off'}</span>
        </label>
      </div>

      <div className="notify-row">
        <span className="notify-what">
          <strong>In the app</strong>
          <p className="note">a small card at the bottom of this page, and a count in the tab title.</p>
        </span>
        <label className="switch">
          <input
            type="checkbox"
            checked={prefs.inApp}
            disabled={!prefs.enabled}
            onChange={(e) => patch({ inApp: e.target.checked })}
          />
          <span>{prefs.inApp ? 'On' : 'Off'}</span>
        </label>
      </div>

      <div className="notify-row">
        <span className="notify-what">
          <strong>On your phone</strong>
          <p className="note">
            {prefs.phone
              ? 'on — pushes are sent to every registered phone while this Mac is awake and the console is running.'
              : 'off — turn this on after registering a phone below.'}
          </p>
        </span>
        <label className="switch">
          <input
            type="checkbox"
            checked={prefs.phone}
            disabled={!prefs.enabled}
            onChange={(e) => patch({ phone: e.target.checked })}
          />
          <span>{prefs.phone ? 'On' : 'Off'}</span>
        </label>
      </div>

      <div className="notify-row">
        <span className="notify-what">
          <strong>What a phone notification may say</strong>
          <p className="note">
            never an issue title, a body, or a customer name — at most the kind and the number.
          </p>
        </span>
        <select
          value={prefs.detail}
          disabled={!prefs.enabled}
          onChange={(e) => patch({ detail: e.target.value })}
        >
          <option value="numbers">Kind and number ("UAT fail — issue #4170")</option>
          <option value="none">Nothing ("New action on you")</option>
        </select>
      </div>

      <h3 style={{ fontSize: 14, margin: '26px 0 6px' }}>Per kind</h3>
      <p className="note">
        <strong>Toast + phone</strong> announces it. <strong>Feed only</strong> puts it in the actions feed and nowhere
        else. Only <strong>{kindLabel(PUSHES_ALONE)}</strong> ever gets a phone notification of its own — everything
        else that announces is rolled into one “N new actions on you” push per read, so a busy afternoon is one buzz and
        not twenty.
      </p>
      {SWITCHABLE.map((k) => (
        <div className="notify-row" key={k.kind}>
          <span className="notify-what">
            <strong>{kindLabel(k.kind)}</strong>
            <p className="note">{k.what}</p>
          </span>
          <select
            value={switchOf(k.kind, prefs.kinds)}
            disabled={!prefs.enabled}
            onChange={(e) => patch({ kinds: { [k.kind]: e.target.value } })}
          >
            {(['push', 'feed', 'off'] as KindSwitch[]).map((s) => (
              <option key={s} value={s}>
                {SWITCH_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
      ))}

      <h3 style={{ fontSize: 14, margin: '26px 0 6px' }}>Your phone</h3>
      {!pushSupported() ? (
        <p className="note">
          This browser cannot receive phone notifications. Open the console on the iPhone — Safari, then Share → Add to
          Home Screen — and turn it on from there.
        </p>
      ) : (
        <>
          <ol className="steps">
            <li>
              <p className="step-title">
                <strong>Open the console on the phone</strong> at its <code>https://</code> address, over Tailscale.
              </p>
              <p className="note">
                Plain <code>http://</code> will not do: no browser will register for push without HTTPS. If the address
                you use is http, run <code>tailscale serve --bg --https=443 127.0.0.1:4400</code> on this Mac and use
                the https one.
              </p>
            </li>
            <li>
              <p className="step-title">
                <strong>Share → Add to Home Screen</strong>, then open the console from that icon.
              </p>
              <p className="note">iPhone only registers for push from the installed icon, never from a Safari tab.</p>
            </li>
            <li>
              <p className="step-title">
                <strong>Press the button below</strong> on the phone and allow the prompt.
              </p>
              <p className="note">The console never asks on its own — it is always your tap.</p>
            </li>
            <li>
              <p className="step-title">
                <strong>Send a test</strong> and check it arrives.
              </p>
            </li>
          </ol>
          {blocked && <p className="note err">{blocked}</p>}
          <div className="toolbar">
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void enablePush()
                  .then((r) => onDone(r.message))
                  .catch((e: Error) => onDone(`could not turn it on: ${e.message}`))
                  .finally(() => {
                    setBusy(false);
                    refresh();
                  });
              }}
            >
              {ready?.subscribed ? 'Re-register this device' : 'Enable phone notifications'}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void post('/api/push/test')
                  .then((r) => onDone(r.message))
                  .finally(() => setBusy(false));
              }}
            >
              Send test push
            </button>
            {ready?.subscribed && (
              <button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void disablePush()
                    .then((r) => onDone(r.message))
                    .finally(() => {
                      setBusy(false);
                      refresh();
                    });
                }}
              >
                Turn off on this device
              </button>
            )}
            <span className="note">{pushDeviceNote(pushDevices, ready?.subscribed === true)}</span>
          </div>
          {/* Anything on the tailnet can register itself — there is no password
              on this console — so a device the operator did not add has to be sayable. */}
          {pushDevices - (ready?.subscribed ? 1 : 0) > 0 && (
            <p className="note">
              A registered device can read every phone notification the console sends. If you do not recognise them
              all, turn phone notifications off on each device you do know about, then enable it again here — that
              leaves only this one.
            </p>
          )}
        </>
      )}

      <details className="report">
        <summary>What leaves this Mac, in plain English</summary>
        <p className="note">
          In-app notifications never leave this Mac. A phone notification is encrypted here and can only be decrypted by
          your phone; it travels through Apple's push service, which can see that a notification was sent, when, and to
          which device — but not what it says. Issue titles, PR contents and customer names are never readable by Apple
          or anyone else in transit, and are never sent to any other company. GitHub data continues to flow only between
          GitHub and this Mac, read-only.
        </p>
        <p className="note">
          Two things worth deciding for yourself. <strong>Nothing notifies while this Mac is asleep or the console is
          stopped</strong> — the Mac is the sender, on every channel. And a notification is <strong>decrypted onto your
          phone's lock screen</strong>, which mirrors to a paired Watch or Mac: that is a work issue number visible to
          anyone looking at your phone. Set “what a phone notification may say” to <em>Nothing</em> if that is not
          acceptable, and check whether your employer is happy for work identifiers to reach a personal device at all.
        </p>
      </details>
    </>
  );
}

/**
 * The one line above the list that says the top priority without switching view.
 * It is only ever drawn when something is fix-first, so it is never furniture.
 */
function FixFirstBanner({ actions, onPick }: { actions: Action[]; onPick: (n: number) => void }) {
  const one = byTier(actions, 1);
  if (one.length === 0) return null;
  return (
    <div className="banner warn">
      <span>{fixFirstLine(actions)}</span>
      {one.map((a) => (
        <button key={a.id} className="linkish" onClick={() => onPick(a.subject.number)}>
          open #{a.subject.number}
        </button>
      ))}
    </div>
  );
}

/**
 * How much room is left, in two numbers.
 *
 * What remains of the five-tile strip that used to head the Dashboard. Three of
 * those tiles were deleted rather than moved: `waiting on you` and `actions on
 * you` were counts of the two cards immediately below them, and `GitHub read`
 * restated a stamp already in the actions card's own subtitle. A strip that
 * summarises the page under it is the definition of overburden.
 *
 * These two are here because they answer a question this tab is FOR, and
 * because the memory tile is the one number that turns red before the machine
 * falls over.
 */
function ResourceStrip({ state }: { state: ConsoleState }) {
  const w = state.watch;
  // The watcher's count when there is one — it knows which workers are frozen,
  // and `activeCount` deliberately still counts a paused worker's slot.
  const running = w ? w.workers.filter((x) => !x.paused).length : state.activeCount;
  const paused = w ? w.workers.filter((x) => x.paused).length : 0;
  const free = w ? w.sample.freePct : (state.resources?.freePct ?? null);
  const tight = Boolean(w && !w.forecast.comfortable);
  // The second signal. Free % said 31% on a night swap was 92% full — one tile
  // could not have told you that, which is why there are two.
  const swap = state.resources?.swapUsedPct ?? null;
  const maxSwap = state.resources?.maxSwapPct ?? 0;

  return (
    <div className="strip">
      <div className={`stat${tight ? ' bad' : ''}`}>
        <span className="v">{free === null ? '—' : `${free}%`}</span>
        <span className="k">memory free</span>
      </div>
      <div className={`stat${swap !== null && maxSwap > 0 && swap >= maxSwap ? ' bad' : ''}`}>
        <span className="v">{swap === null ? '—' : `${swap}%`}</span>
        <span className="k">{swap === null ? 'swap unreadable' : 'swap used'}</span>
      </div>
      <div className="stat">
        <span className="v">
          {running} of {state.maxActive}
        </span>
        <span className="k">workers running{paused > 0 ? ` · ${paused} paused` : ''}</span>
      </div>
    </div>
  );
}

/**
 * The machine, on its own tab.
 *
 * It left the Dashboard because it answers a different question. The Dashboard
 * answers "where is the work and what needs me"; this answers "what is this Mac
 * doing and will it hold". Pressure first, then the inventory, then the
 * telemetry — the order those get asked in.
 *
 * What did NOT move here: the watcher banner and the restart-edge banner. They
 * ride the App shell on every view, because 2026-08-11 was a machine falling
 * over while the console said nothing, and an alarm you have to open a tab to
 * see is not an alarm.
 */
function ResourcesView({ state, onDone }: { state: ConsoleState; onDone: (m: string) => void }) {
  return (
    <div className="grid-wrap">
      <ResourceStrip state={state} />
      <MachinePanel state={state} onDone={onDone} />
      <RouterCard />
    </div>
  );
}

/**
 * The one act that clears each stopped row.
 *
 * Lock-message shape from the copy spec: `<what stopped> — <the one thing that
 * clears it>`. Each clearing clause names a control that genuinely exists on the
 * issue — Start again for a checkpoint or a failure, the gate card's own
 * buttons, the draft comment's Post.
 */
const WAITING_LINE: Partial<Record<WorkerStatus, string>> = {
  'awaiting-post': 'a comment is drafted — read it and post it',
  'reply-received': 'a reply landed — read it and send the worker on',
  rework: 'changes were requested — start the rework',
  checkpoint: 'the worker stopped at a checkpoint — start it again',
  failed: 'the worker failed — read the error and start it again',
  detached: 'you took this one over in a terminal — finish it there',
};

function waitingLine(row: IssueRow): string {
  if (row.status === 'at-gate') return `gate ${row.gate?.gate ?? 'C'} — approve it or send it back`;
  return WAITING_LINE[row.status] ?? CHIP_LABEL[row.status];
}

/**
 * What needs you, as a list rather than a number.
 *
 * The old strip had a `waiting on you` tile — a count, with no way to see what
 * it counted. This is the list behind that number, and it is the second thing on
 * the page because the operator asked for status first and what-needs-them second.
 *
 * An active or queued issue can never appear here, by construction: neither
 * status is in `ORANGE` or `STOPPED`. That answers the operator's point that
 * issues already in progress do not need listing as needing their action, by
 * reading status rather than by filtering a list after the fact — the same rule
 * the actions feed now applies on the server.
 */
function WaitingCard({
  rows,
  accounts,
  onPick,
}: {
  rows: IssueRow[];
  accounts: AccountSummary[];
  onPick: (n: number) => void;
}) {
  const waiting = rows.filter(waitingOnYou);
  return (
    <Card title="Waiting on you — open one to act" className="wide">
      {waiting.length === 0 ? (
        <p className="note">nothing waiting on you</p>
      ) : (
        <ul className="waiting">
          {waiting.map((r) => (
            <li key={r.number}>
              <button className="linkish" onClick={() => onPick(r.number)}>
                #{r.number}
              </button>
              <ProviderBadge provider={providerForRow(r, accounts)} />
              <span className="waiting-what">{waitingLine(r)}</span>
              <span className="note waiting-title">{r.title}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * THE AUDIT REPORT — every open issue, and whether it is where its status says
 * it is. Stuck rows first (a dropped ball: blocked with no reason, a draft PR,
 * a dead worker), slow rows second (held past the median of their leg), and
 * the on-pace rows folded shut behind their count — validated is worth saying,
 * but it is not worth a screen.
 *
 * Every sentence arrives finished from `audit.ts`; nothing is composed here —
 * the same contract as `PendingCard`, and for the same reason.
 */
function AuditPanel({ report, onPick }: { report: AuditReport; onPick: (n: number) => void }) {
  const flagged = report.issues.filter((i) => i.verdict !== 'ok');
  const onPace = report.issues.filter((i) => i.verdict === 'ok');
  const parked = report.parked.length > 0 ? ` · ${report.parked.length} parked, set aside unjudged` : '';
  return (
    <Card
      title="Audit — is every open issue where it says it is?"
      subtitle={`read GitHub and audited ${when(report.at)} — ${report.stuck} stuck · ${report.slow} slow · ${report.ok} on pace${parked}`}
      className="wide"
    >
      {flagged.length === 0 ? (
        <p className="note">nothing is stuck and nothing is past its median — every open issue is moving as it should</p>
      ) : (
        <ul className="waiting">
          {flagged.map((i) => (
            <li key={i.issue}>
              <button className="linkish" onClick={() => onPick(i.issue)}>
                #{i.issue}
              </button>
              <span className={`audit-verdict ${i.verdict}`}>{i.verdict}</span>
              <span className={`chip ${chipClass({ status: i.status, parked: null })}`}>{CHIP_LABEL[i.status]}</span>
              <span className="waiting-what">
                {i.findings.map((f) => f.text).join(' ')}
                {i.phase && <span className="note"> {i.phase}.</span>}
              </span>
              <span className="note waiting-title">{i.title}</span>
            </li>
          ))}
        </ul>
      )}
      {onPace.length > 0 && (
        <details className="audit-on-pace">
          <summary>
            {onPace.length} on pace — status validated, nothing to chase
          </summary>
          <ul className="waiting">
            {onPace.map((i) => (
              <li key={i.issue}>
                <button className="linkish" onClick={() => onPick(i.issue)}>
                  #{i.issue}
                </button>
                <span className={`chip ${chipClass({ status: i.status, parked: null })}`}>{CHIP_LABEL[i.status]}</span>
                <span className="waiting-what">{i.phase ?? i.statusDetail}</span>
                <span className="note waiting-title">{i.title}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function Dashboard({
  rows,
  state,
  onPick,
}: {
  rows: IssueRow[];
  state: ConsoleState;
  onPick: (n: number) => void;
}) {
  return (
    <div className="grid-wrap">
      {/* FIRST on the tab, and open. The operator asked for the status summary
          at the top of the overview as a simple tracker, keeping the date
          selector but defaulting to today. It was the last thing on the page and
          folded shut, which meant the four numbers checked daily
          cost a scroll and a click; the grid below is the detail behind them. */}
      <SummaryPanel />

      <Card
        title="Every ticket in this workspace"
        subtitle="one dot per stage — orange is a gate that has stopped and is waiting for you"
        className="wide"
      >
        <div className="grid-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>ticket</th>
                <th>priority</th>
                <th>raised by</th>
                <th>title</th>
                <th>status</th>
                <th>agent</th>
                <th>stage</th>
                {STAGES.map((s) => (
                  <th key={s.n}>{s.n}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.number}>
                  <td className="n">
                    <button className="linkish" onClick={() => onPick(r.number)}>
                      #{r.number}
                    </button>
                  </td>
                  <td>
                    <span className="tags">
                      {/* First, before the rank: a verdict on shipped work
                          outranks whatever triage decided. */}
                      <UatChip row={r} />
                      <Pill row={r} />
                      {/* No `Provenance` here. The "self-filed" pill said one
                          thing — that this came from this machine — and the
                          handle in the next column says it better, because it
                          also says WHO when it was somebody else — the operator
                          recognises their own handle. The pill stays
                          everywhere else, where there is no column to carry it. */}
                    </span>
                  </td>
                  {/* WHO RAISED IT, not who it is assigned to — every row here is
                      assigned to the operator, so the assignee would be one
                      repeated name.
                      The author is who they reply to, and it is the difference
                      between a thing the team asked for and a spin-off filed from
                      this machine. Linked, like the same handle on the detail. */}
                  <td className="who">
                    {r.author ? (
                      <a href={`https://github.com/${r.author}`} target="_blank" rel="noreferrer">
                        @{r.author}
                      </a>
                    ) : (
                      // GitHub gives no author for a very few old issues, and a
                      // blank cell reads as a rendering fault rather than as an
                      // absence.
                      <span className="note">—</span>
                    )}
                  </td>
                  <td className="t">{r.title}</td>
                  <td>
                    {/* The Dashboard reads the same chipClass, so a parked row
                        is already cold and dashed here. This is the word that
                        says WHICH of the two it is — the status chip beside it
                        is busy saying "AT GATE C", which is the point. The
                        `tags` wrapper is the same one the priority cell uses,
                        and it is what puts a gap between the two chips. */}
                    <span className="tags">
                      <ParkedChip row={r} />
                      <Chip row={r} />
                    </span>
                  </td>
                  <td>
                    <ProviderBadge provider={providerForRow(r, state.accounts)} />
                  </td>
                  <td>{r.stage ?? '—'}</td>
                  {STAGES.map((s) => {
                    const at = r.gate && s.gate === r.gate.gate;
                    const here = r.stage === s.n;
                    const done = (r.stage ?? -1) > s.n;
                    return (
                      <td key={s.n}>
                        <span className={`dot ${at ? 'gate' : here ? 'here' : done ? 'done' : ''}`} />
                      </td>
                    );
                  })}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7 + STAGES.length} className="note">
                    no issues assigned to you
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Second, and only second: what the status above says is on you. */}
      <WaitingCard rows={rows} accounts={state.accounts} onPick={onPick} />

      {/* GitHub's half of the same question. Its tier-3 rows are folded away
          inside it — FYI is not an action, and it was most of the page. */}
      <ActionsCard state={state} onPick={onPick} />
    </div>
  );
}

/**
 * The tabs, in the order the questions get asked: work one issue, see where all
 * of them are, check the machine, read what was announced.
 *
 * `View` is written ONCE and every declaration reads it. It used to be spelled
 * out three times in three different orders and hand-kept in sync, which is a
 * standing invitation for a key to exist in one place and not another — and
 * because `'list'` is the render ladder's fallback branch rather than an
 * explicit test, that failure renders the List view silently instead of
 * throwing.
 */
type View = 'list' | 'grid' | 'resources' | 'notifications' | 'settings' | 'info' | 'sentry';

const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'list', label: 'Tickets' },
  { key: 'grid', label: 'Overview' },
  { key: 'notifications', label: 'Activity' },
  { key: 'sentry', label: 'Sentry' },
  { key: 'resources', label: 'System' },
  { key: 'settings', label: 'Settings' },
  { key: 'info', label: 'Guide' },
];

/**
 * Phone width, in the one place the number lives — it has to agree with the
 * `max-width: 719px` block in styles.css, because below it the rail is not a
 * rail: it is the whole page, and an issue opens OVER it with a Back control.
 * That is a different component tree, not a narrower one, so CSS alone cannot
 * express it.
 */
const NARROW = '(max-width: 719px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

export default function App() {
  const [state, setState] = useState<ConsoleState | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<View>('list');
  const [toast, setToast] = useState<string | null>(null);
  const [health, setHealth] = useState<AccountHealth[]>([]);
  const [sources, setSources] = useState<WorkSourcesSnapshot | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const toastTimer = useRef<number | null>(null);
  /** Notifications this tab has drawn. The SERVER decides what is announced —
   *  this is only "have I shown it here yet". */
  const [notices, setNotices] = useState<Action[]>([]);
  const narrow = useNarrow();

  const dismiss = (id: string) => setNotices((list) => list.filter((n) => n.id !== id));

  useEffect(() => {
    const src = new EventSource('/api/events');
    src.onmessage = (e) => setState(JSON.parse(e.data) as ConsoleState);
    // A named event alongside the state frames: the state says what is true, this
    // says what has just become true. Only the server ever fires it, and only
    // once per action, so three open tabs cannot triple-announce one UAT fail.
    src.addEventListener('action', (e) => {
      const action = JSON.parse((e as MessageEvent).data) as Action;
      setNotices((list) => (list.some((n) => n.id === action.id) ? list : [...list, action].slice(-3)));
      // Tier 1 stays until it is dismissed. Everything else clears itself: an
      // FYI that has to be tidied up by hand is a chore, and chores get muted.
      if (action.tier !== 1) window.setTimeout(() => dismiss(action.id), 15_000);
    });
    return () => src.close();
  }, []);

  useEffect(() => {
    void sourceCall('/api/sources')
      .then((snapshot) => {
        setSources(snapshot);
        setSourceError(null);
      })
      .catch((error: unknown) => setSourceError(error instanceof Error ? error.message : String(error)));
  }, []);

  const multiAccount = (state?.accounts.length ?? 1) > 1;
  const needsAccountHealth =
    multiAccount || (state?.accounts.some((account) => providerOfAccount(account) === 'codex') ?? false);
  const checkAccounts = () => {
    void fetch('/api/accounts')
      .then((r) => r.json())
      .then((o: { accounts: AccountHealth[] }) => setHealth(o.accounts));
  };
  // A picker needs health when it can switch accounts. Codex also needs the
  // provider-specific link/fence result even when it is the only account.
  useEffect(() => {
    if (needsAccountHealth) checkAccounts();
  }, [needsAccountHealth]);

  // Settings re-asks for the doctor while it is open, so running the login
  // command in a terminal turns the row green here on its own. It is a fetch
  // rather than part of the SSE state on purpose: asking for the doctor reloads
  // the registry and emits a change, so driving it off the SSE tick would chase
  // its own tail.
  useEffect(() => {
    if (view !== 'settings') return;
    checkAccounts();
    const timer = window.setInterval(checkAccounts, 5000);
    return () => window.clearInterval(timer);
  }, [view]);

  const say = (m: string) => {
    setToast(m);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  };

  /**
   * Re-read immediately after a state-clearing action. SSE normally carries the
   * same change, but the card should disappear on the click that resolved it,
   * even if this browser is reconnecting its event stream.
   */
  const refreshState = async () => {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error(`state refresh failed (${response.status})`);
    setState((await response.json()) as ConsoleState);
  };

  const refreshSources = async () => {
    setSourceBusy(true);
    setSourceError(null);
    try {
      setSources(await sourceCall('/api/sources/refresh', 'POST'));
      say('Work sources refreshed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSourceError(message);
      say(message);
    } finally {
      setSourceBusy(false);
    }
  };

  /**
   * The count in the tab title — the glance channel that costs nothing and works
   * while the console is in a background tab all day. It respects the in-app
   * switch, because "off" has to mean off everywhere it can be seen.
   */
  const notify = state ? prefsOf(state) : null;
  const pending = state && notify && notify.inApp && notify.enabled ? actionCount(feedOf(state).actions) : 0;
  useEffect(() => {
    document.title = pending > 0 ? `(${pending}) worker console` : 'worker console';
  }, [pending]);

  /** A Settings write: say what happened, and take the fresh doctor with it. */
  const afterAccountWrite = (r: AccountReply) => {
    if (r.accounts) setHealth(r.accounts);
    say(r.message);
  };

  // Above the `!state` guard on purpose: a hook declared after an early return
  // runs on some renders and not others, which is React error #310.
  const [query, setQuery] = useState('');

  if (!state) return <div style={{ padding: 24 }}>connecting…</div>;

  const defaults = defaultsForState(state);
  // One ordering for the rail and the Dashboard both: priority band, then what
  // is waiting on the operator inside it, then most recently updated.
  const rows = sortIssues(state.issues);
  // Filtering only, never reordering: the rail's order IS the priority argument
  // and a search must not quietly restate it.
  const shown = query.trim() === '' ? rows : rows.filter((r) => matchesQuery(r, query));
  // What a wide screen opens when nothing is picked. A send-back comes before a
  // gate: the work has already shipped and a person is waiting on the fix.
  const opensFirst = (r: IssueRow) => isUatFail(r) || ORANGE.includes(r.status);
  // On a phone nothing is selected until it is tapped — the list IS the page,
  // and auto-opening an issue would hide it. On a wide screen the detail pane
  // exists either way, so it falls back to whatever needs the operator first.
  const current = rows.find((r) => r.number === selected) ?? (narrow ? undefined : (rows.find(opensFirst) ?? rows[0]));
  // What is on the operator on THIS machine. Deliberately not merged with the GitHub
  // count beside it in the header: they are two different questions, and one
  // total would answer neither.
  //
  // The SAME predicate the Dashboard's "Waiting on you" card lists, because a
  // header saying two and a card listing three is the console arguing with
  // itself about the one number the operator reads it for.
  const waiting = rows.filter(waitingOnYou).length;
  const mem = state.resources;
  const watch = state.watch;
  const feed = feedOf(state);
  // The bell's badge. `?? 0` because a freshly built page can be talking to a
  // console that has not restarted yet and sends no count at all.
  const unread = state.unreadNotifications ?? 0;

  return (
    <>
      <header>
        <h1>worker console</h1>
        <span className="product-sub">tickets → done</span>
        {/* WORKSPACE. One today, and the picker says so honestly rather than
            pretending: the options are what the server reports, never a
            placeholder, so it can never offer somewhere the console cannot go.
            A second repo and Linear land here as extra entries, and the switch behind
            them is orchestrator work (per-repo polling, gh calls, worktree roots
            and slot accounting) — not something a <select> can fake. Until then
            the second item is the one action that IS real: go add one. */}
        <label className="workspace-pick" title="the workspace this console is driving">
          <span className="meta">workspace</span>
          <select
            value={state.repo}
            onChange={(e) => {
              if (e.target.value === '__add__') setView('settings');
            }}
          >
            {(state.workspaces ?? [state.repo]).map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
            <option value="__add__">Add a workspace…</option>
          </select>
        </label>
        <span className="meta">
          {state.activeCount} of {state.maxActive} active
          {state.queue.length > 0 && ` · ${state.queue.length} queued`}
          {waiting > 0 && ` · ${waiting} waiting on you`}
        </span>
        {/* GitHub's half, on every view. Red when something has come back from
            UAT, because that is the one thing that should pull you off whatever
            you are doing. */}
        {actionCount(feed.actions) > 0 && (
          <span className={`meta ${fixFirstCount(feed.actions) > 0 ? 'bad' : ''}`}>
            {actionCount(feed.actions)} actions on you
            {fixFirstCount(feed.actions) > 0 && ` · ${fixFirstCount(feed.actions)} to fix first`}
          </span>
        )}
        {/* The watcher's numbers when there are any: at most one tick old,
            per-worker, and with the forward-looking clause the poll could never
            produce. It falls back to the 2-minute poll only before the first
            tick has landed — never silently, because the fallback line says
            nothing about workers or spikes. */}
        {watch && !watch.forecast.comfortable ? (
          <span className={`meta ${watch.forecast.comfortable ? '' : 'bad'}`}>
            memory {watch.sample.freePct === null ? '—' : `${watch.sample.freePct}%`} free ·{' '}
            {gbLabel(watch.sample.headroomBytes)} headroom
            {watch.workers.length > 0 &&
              ` · workers ${gbLabel(watch.workers.reduce((t, x) => t + x.treeBytes, 0))} in ${watch.workers.length} tree${watch.workers.length === 1 ? '' : 's'}`}
            {` · ${headroomClause(watch)}`}
          </span>
        ) : null}
        {/* Swap, always beside the free %, from the machine read either way —
            the watcher does not sample it and does not need to: swap fills over
            minutes. It is the number that was missing when "31% free" meant a
            machine at the cliff. */}
        {mem && mem.swapUsedPct !== null && mem.swapUsedPct >= mem.maxSwapPct && (
          <span className={`meta ${mem.swapUsedPct !== null && mem.swapUsedPct >= mem.maxSwapPct ? 'bad' : ''}`}>
            {mem.swapUsedPct === null ? 'swap unreadable' : `swap ${mem.swapUsedPct}% used`}
          </span>
        )}
        <span className="spacer" />
        {/* Four buttons and a Refresh do not fit a phone header without wrapping
            into two rows of half-size targets, so on a narrow screen the switcher
            collapses into the platform's own menu — a select, which is one tap
            and needs no code of its own. */}
        <div className="views" role="group" aria-label="Console view">
          {narrow ? (
            <label className="view-pick">
              <select aria-label="View" value={view} onChange={(e) => setView(e.target.value as View)}>
                {VIEWS.map((v) => (
                  <option key={v.key} value={v.key}>
                    {/* The bell has no room for a badge inside a native select,
                        so the count goes in the words. */}
                    {v.key === 'notifications' && unread > 0 ? `${v.label} (${unread})` : v.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            VIEWS.map((v) => (
              <button
                key={v.key}
                className={view === v.key ? 'on' : ''}
                aria-pressed={view === v.key}
                onClick={() => setView(v.key)}
              >
                {v.label}
                {v.key === 'notifications' && unread > 0 && <span className="badge">{unread}</span>}
              </button>
            ))
          )}
        </div>
        {/* NOT navigation, and now visibly not: the view switcher above is tabs,
            this is the state of the connections plus the two actions that change
            it. They shared a row and a button style before, which is why Refresh
            read as a seventh tab. */}
        <div className="tools" aria-label="connections and sync">
          {(sources?.sources ?? []).map((source) => (
            <span
              key={source.id}
              className={`source-chip ${source.connected ? 'connected' : ''}`}
              title={source.error ?? source.detail}
            >
              {source.name} · {source.connected ? source.itemCount : 'not connected'}
            </span>
          ))}
          <SyncControl
            state={state}
            busy={sourceBusy}
            onSync={() => {
              void post('/api/refresh');
              void refreshSources();
            }}
          />
          <AuditControl
            onDone={(m) => {
              say(m);
              // The report lands on the Tickets tab; go where the answer is.
              setView('list');
            }}
          />
          <RebuildControl onSay={say} />
          <button className="tool" onClick={() => setView('settings')}>
            Connections
          </button>
        </div>
      </header>

      {/* Above the dispatch banner: when the ladder is loud, that is the thing
          to read first, and it carries the buttons that fix it. */}
      <WatchBanner state={state} onDone={say} />

      {/* WHY NOTHING IS STARTING.
          `dispatchHold` first, because it is the reason the QUEUE is frozen and
          it is read fresh off the verdict dispatch itself consults. The
          `resources` line behind it is the two-minute machine read, which is
          what this banner used to show on its own — and the `hold` rung of the
          ladder sits below the level WatchBanner draws at, so a queue frozen on
          a fresh 20%-free sample said nothing anywhere while the queued row
          promised it "runs as soon as a slot frees". One banner, never two: the
          fresher sentence wins. */}
      {(state.dispatchHold ?? (state.resources && !state.resources.ok ? state.resources.reason : null)) && (
        <div className="banner warn">
          <span>{state.dispatchHold ?? state.resources?.reason}</span>
          {state.resources?.edgeRuntimeLabel && (
            <button
              className="danger"
              onClick={() => {
                const ok = window.confirm(restartEdgeQuestion(null, state.resources!.edgeRuntimeLabel!));
                if (ok) void post('/api/resources/restart-edge-runtime').then((o) => say(o.message));
              }}
            >
              Restart edge runtime ({state.resources.edgeRuntimeLabel})
            </button>
          )}
        </div>
      )}
      <StaleBundleBanner />
      {/* What the button just did, said out loud: what it restarted, when, and
          how big it had got — and a restart that FAILED says that too, rather
          than leaving you looking at a button that appeared to do nothing. */}
      {state.lastEdgeReclaim &&
        Date.now() - Date.parse(state.lastEdgeReclaim.at) < 20 * 60 * 1000 &&
        // Neither yet: the restart is still going. Say nothing for those ~12
        // seconds rather than call a running restart a failed one.
        (state.lastEdgeReclaim.ok || state.lastEdgeReclaim.error) &&
        (state.lastEdgeReclaim.ok ? (
          <div className="banner">
            You restarted the edge runtime at {when(state.lastEdgeReclaim.at)} — it had grown to{' '}
            {state.lastEdgeReclaim.grewTo}
            {state.lastEdgeReclaim.freePctBefore !== null && `, with ${state.lastEdgeReclaim.freePctBefore}% free`}. The
            database was not touched.
          </div>
        ) : (
          <div className="banner warn">
            Tried to restart the edge runtime at {when(state.lastEdgeReclaim.at)} and it did not come back:{' '}
            {state.lastEdgeReclaim.error ?? 'no reason given'}. Nothing else was touched — check that Docker is running,
            then click the button again.
          </div>
        ))}
      {state.pollError && <div className="banner warn">{state.pollError}</div>}
      {/* Quiet when the read came back WHOLE — it succeeded and the board below
          is correct, and a warning over a correct board teaches you to ignore
          warnings. `warn` when it came back short, because then the board below
          has rows that cannot say where their PR stands, and that is the one
          version of this line there is something to do about. Either way it is
          said: a degraded read that goes unmentioned is how the console lost 21
          PRs on 2026-09-05. The server decides which; the page renders it. */}
      {state.pollNote && (
        <div className={state.pollNoteWarn ? 'banner warn' : 'banner'}>{state.pollNote}</div>
      )}
      {/* Whatever is fix-first, on every view, above everything the view itself
          draws. It is only ever rendered when something has come back from UAT,
          so it is never furniture. */}
      <FixFirstBanner
        actions={feed.actions}
        onPick={(n) => {
          setSelected(n);
          setView('list');
        }}
      />
      {toast && <div className="banner">{toast}</div>}

      {view === 'info' ? (
        <InfoView />
      ) : view === 'sentry' ? (
        <SentryPanel />
      ) : view === 'settings' ? (
        <SettingsView
          sources={sources}
          sourceError={sourceError}
          sourceBusy={sourceBusy}
          onSourceBusy={setSourceBusy}
          onSources={(snapshot) => {
            setSources(snapshot);
            setSourceError(null);
          }}
          onSourceError={setSourceError}
          health={health}
          models={state.models}
          defaults={defaults}
          notify={notify ?? prefsOf(state)}
          pushDevices={state.pushDevices ?? 0}
          onRefresh={checkAccounts}
          onReply={afterAccountWrite}
          onDone={say}
        />
      ) : view === 'grid' ? (
        <Dashboard
          rows={rows}
          state={state}
          onPick={(n) => {
            setSelected(n);
            setView('list');
          }}
        />
      ) : view === 'resources' ? (
        <ResourcesView state={state} onDone={say} />
      ) : view === 'notifications' ? (
        <NotificationsView unread={unread} />
      ) : (
        <>
          {/* The last audit, until the next replaces it. Above the rail because
              it is an answer the operator just asked for; absent until they have. */}
          {state.audit && (
            <div className="audit-wrap">
              <AuditPanel report={state.audit} onPick={setSelected} />
            </div>
          )}
          <div className={`split ${narrow ? 'narrow' : ''}`}>
          {/* On a phone this is the whole page until an issue is tapped. */}
          {(!narrow || !current) && (
            <div className="rail">
              <div className="rail-search">
                <input
                  type="search"
                  value={query}
                  placeholder="find an issue, a PR number, or words in a title"
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="search tickets"
                />
                {query.trim() !== '' && (
                  <span className="note">
                    {shown.length} of {rows.length}
                    <button className="linkish" onClick={() => setQuery('')}>
                      clear
                    </button>
                  </span>
                )}
              </div>
              {shown.length === 0 && <p className="note rail-empty">nothing matches that</p>}
              {shown.map((r) => (
                <button
                  key={r.number}
                  aria-pressed={current?.number === r.number}
                  className={`rail-item ${current?.number === r.number ? 'on' : ''} ${
                    // Finished work is greyed and compact — still openable, but
                    // it should not cost the same eye-space as live work.
                    r.status === 'done' ? 'finished ' : ''
                  }${
                    // Red beats orange: a send-back is the row to open even if
                    // something else is sitting at a gate. This used to name
                    // `at-gate` alone, so every stopped, failed and detached row
                    // went unmarked — and the CSS then required the row to be
                    // SELECTED before even that mark appeared. See `edgeClass`.
                    edgeClass(r)
                  }`}
                  onClick={() => setSelected(r.number)}
                >
                  <span className="rail-num">
                    #{r.number}
                    {/* The other number you hold in your head. `inherited` means the
                        PR belongs to another issue and this one was folded into it,
                        so it is marked rather than shown as this issue own. */}
                    {r.pr && (
                      <span
                        className="rail-pr"
                        title={r.pr.inherited ? 'folded into PR #' + r.pr.number : 'PR #' + r.pr.number}
                      >
                        PR #{r.pr.number}
                        {r.pr.inherited ? '\u2197' : ''}
                      </span>
                    )}
                  </span>
                  <span className="rail-title">{r.title}</span>
                  <span className="rail-tags">
                    <UatChip row={r} />
                    <Pill row={r} />
                    {/* Where it is in the nine stages, without opening it. Only
                        while there is a worker: a row with no worktree has no
                        stage, and "0 Preflight" on one would be a lie. */}
                    {/* The tracker board column. The operator asked for the
                        GitHub queue column on the issue, to see where it is. */}
                    {r.lane && <span className="chip lane-chip">{r.lane}</span>}
                    {r.stage !== null && r.status !== 'no-worker' && r.status !== 'done' && (
                      <span className="chip stage-chip">
                        {r.stage} · {STAGES.find((st) => st.n === r.stage)?.label ?? '?'}
                      </span>
                    )}
                    <Provenance row={r} />
                    <ProviderBadge provider={providerForRow(r, state.accounts)} />
                    {multiAccount && r.account && <AccountBadge name={r.account} />}
                    {/* Beside the status chip, never instead of it: the status
                        chip still reads "AT GATE C" because the ticket is still
                        at gate C. This says the other half. */}
                    <ParkedChip row={r} />
                    <SuperchargeChip row={r} />
                    <Chip row={r} />
                  </span>
                </button>
              ))}
              {rows.length === 0 && (
                <p className="note" style={{ padding: '12px 16px' }}>
                  no assigned tickets in this configured workspace
                </p>
              )}
            </div>
          )}
          {current ? (
            <div className="detail-pane">
              {narrow && (
                <button className="back" onClick={() => setSelected(null)}>
                  ‹ All tickets
                </button>
              )}
              <Detail
                row={current}
                accounts={state.accounts}
                models={state.models}
                defaults={defaults}
                health={health}
                longToolMs={state.longToolMs}
                onDone={say}
                onRefresh={refreshState}
              />
            </div>
          ) : (
            !narrow && <div className="detail">pick a ticket on the left</div>
          )}
          </div>
        </>
      )}

      {/* Last in the tree, fixed to the bottom of the window: it floats over
          whichever view is up without ever being part of it. */}
      <Toasts
        toasts={notices}
        onDismiss={dismiss}
        onPick={(n) => {
          setSelected(n);
          setView('list');
        }}
      />
    </>
  );
}
