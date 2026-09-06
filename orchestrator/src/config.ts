import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CODEX_MODEL, DEFAULT_MODEL } from './models.js';
import { LEDGER_TTL_DAYS } from './notify.js';

/** Repo root, however the process was launched. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const GB = 1024 ** 3;
const num = (v: string | undefined, fallback: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : fallback);

/** A TCP port, or null. There is deliberately no fallback: the one setting that
 *  uses this decides whether a whole feature runs, and a guessed port would send
 *  a browser at whatever happened to be listening. */
const portOrNull = (v: string | undefined): number | null => {
  const n = Number(v?.trim());
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : null;
};

/**
 * The one container this console offers to restart. A Supabase edge runtime is
 * the only kind of container proven safe to restart here (12s, database
 * untouched, 2.27 GB → 381 MB). See `edgeContainer` below.
 *
 * The name itself is an EXAMPLE and almost certainly not yours: `docker ps`
 * names an edge runtime after the local project it belongs to, so set
 * EDGE_CONTAINER unless your project happens to be called `example-app`.
 */
export const DEFAULT_EDGE_CONTAINER = 'supabase_edge_runtime_example-app_custom';

/** Every Supabase edge-runtime container starts with this. A db, storage or auth
 *  container does not, and restarting one of those is not a safe act. */
export const EDGE_CONTAINER_PREFIX = 'supabase_edge_runtime_';

/**
 * The container name the console measures and offers a manual restart for. An
 * override is honoured only if it is an edge runtime by name — pointing this at
 * `supabase_db_example-app` and getting a database restart is not a thing this
 * console will do, on a click or otherwise — and anything else falls back to the
 * default.
 */
export function edgeContainerName(raw: string | undefined, warn = (l: string) => console.warn(l)): string {
  const name = raw?.trim();
  if (!name) return DEFAULT_EDGE_CONTAINER;
  if (!name.startsWith(EDGE_CONTAINER_PREFIX)) {
    warn(
      `EDGE_CONTAINER='${raw}' is not an edge-runtime container (it must start with '${EDGE_CONTAINER_PREFIX}'), ` +
        `so it is ignored and ${DEFAULT_EDGE_CONTAINER} is used.`,
    );
    return DEFAULT_EDGE_CONTAINER;
  }
  return name;
}

export type Config = ReturnType<typeof loadConfig>;

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export const DEFAULT_CODEX_SANDBOX: CodexSandboxMode = 'danger-full-access';
const CODEX_SANDBOX_MODES: readonly CodexSandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];

/** Codex accepts exactly these three sandbox policies. An explicit typo must
 * never turn into broader access than the operator asked for, so invalid input
 * stops configuration loading instead of falling back to the broad default. */
export function codexSandboxMode(raw: string | undefined): CodexSandboxMode {
  const value = raw?.trim();
  if (!value) return DEFAULT_CODEX_SANDBOX;
  if (CODEX_SANDBOX_MODES.includes(value as CodexSandboxMode)) return value as CodexSandboxMode;
  throw new RangeError(
    `CODEX_SANDBOX='${raw}' is not supported; use ${CODEX_SANDBOX_MODES.join(', ')}.`,
  );
}

/**
 * Which org project the board features act on, or NULL for "there isn't one".
 *
 * Anything that is not a positive whole number reads as off rather than as
 * zero: `BOARD_PROJECT_NUMBER=` in a half-filled environment must disable the
 * board, not aim it at project 0.
 */
export function boardProjectNumber(raw: string | undefined): number | null {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isInteger(n) && n > 0 ? n : null;
}

const on = (v: string | undefined, fallback: boolean): boolean => {
  const s = v?.trim().toLowerCase();
  if (s === undefined || s === '') return fallback;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
};

/**
 * The response ladder has to escalate, not invert.
 *
 * `floor < pause < warn <= minFree` is the whole meaning of the four numbers: a
 * mis-ordered ladder would pause everything before it had ever warned, or warn
 * at a level it also calls fine. Four environment variables is four chances to
 * get that wrong, so a mis-ordered set is refused as a set — all four go back to
 * their defaults together, with a warning — rather than half-honoured.
 */
export function watchLadder(
  raw: { minFreePct: number; warnFreePct: number; pauseFreePct: number; floorFreePct: number },
  defaults: { minFreePct: number; warnFreePct: number; pauseFreePct: number; floorFreePct: number },
  warn = (l: string) => console.warn(l),
): { minFreePct: number; warnFreePct: number; pauseFreePct: number; floorFreePct: number } {
  const ok =
    raw.floorFreePct > 0 &&
    raw.floorFreePct < raw.pauseFreePct &&
    raw.pauseFreePct < raw.warnFreePct &&
    raw.warnFreePct <= raw.minFreePct;
  if (ok) return raw;
  warn(
    `the memory ladder must escalate — floor < pause < warn <= min free %, and got ` +
      `${raw.floorFreePct} / ${raw.pauseFreePct} / ${raw.warnFreePct} / ${raw.minFreePct}. ` +
      `Falling back to the defaults ${defaults.floorFreePct} / ${defaults.pauseFreePct} / ` +
      `${defaults.warnFreePct} / ${defaults.minFreePct}.`,
  );
  return defaults;
}

/**
 * THE THREE SETTINGS WITH NO DEFAULT, and deliberately none.
 *
 * `REPO` is the tracker repo this console polls and adopts issues from,
 * `REPO_PATH` the checkout it cuts worktrees out of, and `ASSIGNEE` the GitHub
 * login whose assigned work it runs. A default for any of them would mean a
 * fresh clone quietly working somebody else's repo under somebody else's name —
 * polling it, adopting its issues, offering to comment on them — so an unset
 * value stays EMPTY and is said out loud here. `gh` then fails on an empty
 * `--repo` at the first call, which is a failure the operator can read; a
 * plausible-looking default is one they never notice.
 */
export function unsetSettingsWarning(names: readonly string[]): string {
  const many = names.length > 1;
  return (
    `${names.join(', ')} ${many ? 'are' : 'is'} not set, so this console has no repo to work. ` +
    `Set ${many ? 'them' : 'it'} in the environment before starting it: REPO as \`owner/name\`, ` +
    `REPO_PATH as the absolute path to your checkout of it, ASSIGNEE as the GitHub login whose ` +
    `assigned issues you want run. There is no default for any of the three on purpose — one ` +
    `would point this console at a repo nobody chose.`
  );
}

/** Said ONCE per process. It is a startup notice: the console loads its config
 *  once, and a test suite that loads it a hundred times must not turn the one
 *  message that matters into a wall nobody reads. */
let saidUnset = false;

export function loadConfig(env = process.env, warn = (l: string) => console.warn(l)) {
  const stateFile = env.STATE_FILE ?? join(repoRoot, 'state.json');
  const repo = env.REPO?.trim() ?? '';
  const repoPath = env.REPO_PATH?.trim() ?? '';
  const assignee = env.ASSIGNEE?.trim() ?? '';
  const unset = [
    repo === '' ? 'REPO' : null,
    repoPath === '' ? 'REPO_PATH' : null,
    assignee === '' ? 'ASSIGNEE' : null,
  ].filter((n): n is string => n !== null);
  if (unset.length > 0 && !saidUnset) {
    saidUnset = true;
    warn(unsetSettingsWarning(unset));
  }
  const ladder = watchLadder(
    {
      minFreePct: num(env.MIN_FREE_PCT, 12),
      warnFreePct: num(env.WARN_FREE_PCT, 10),
      pauseFreePct: num(env.PAUSE_FREE_PCT, 7),
      floorFreePct: num(env.FLOOR_FREE_PCT, 5),
    },
    { minFreePct: 12, warnFreePct: 10, pauseFreePct: 7, floorFreePct: 5 },
  );
  return {
    /** Laptop-only. Never bind anything but loopback — there is no auth here. */
    host: '127.0.0.1',
    port: num(env.PORT, 4400),
    /**
     * The org project board, by NUMBER — a number rather than a name because
     * the write is aimed by project id, and the number is what the board's own
     * URL ends in (`github.com/orgs/<owner>/projects/<number>`).
     *
     * NULL IS OFF, and unset means null. The board is the one place this
     * console writes something a whole team sees, so a guessed number is the
     * worst possible default: it would move cards on whatever project happens
     * to be numbered that in your org. Unset, no card is read and none is
     * moved; everything else about the console works exactly as before.
     */
    boardProjectNumber: boardProjectNumber(env.BOARD_PROJECT_NUMBER),

    repo,
    repoPath,
    assignee,

    /** Also the token burn-rate cap. Raising it is a decision, not a default. */
    // The operator's call, 2026-08-11. Still a burn-rate cap, not a RAM one: parallel workers
    // on one Claude account can hit the Max-plan rolling window together and pause
    // each other, which is why this stayed at 1 until asked. The RAM guard is the
    // second, independent brake — on a 16 GB machine it will often hold the third.
    maxActive: num(env.MAX_ACTIVE, 2),

    // System-memory guard. The free-% floor is the real gate; the reserve gives
    // the footprint ceiling (totalRAM − reserve ≈ 11 GB on a 16 GB machine).
    systemReserveBytes: num(env.SYSTEM_RESERVE_GB, 5) * GB,
    minFreePct: ladder.minFreePct,

    // The SECOND memory signal, and a HOLD only — never a pause, never a kill.
    // Free % measures the room the machine is reporting; swap measures what it
    // has already paid to report it. On 2026-08-12 the console said "31% free"
    // while swap was 15,137 MB of 16,384 used with 8.37 GB compressed, and the
    // machine was at the cliff while the dashboard read comfortable. 85% is
    // high on purpose: swap in normal use sits well under it, so this fires
    // only when the machine is genuinely thrashing rather than merely busy.

    // A single command that has been running this long is SAID SO, loudly, on
    // the card. Nothing acts on it — no pause, no kill, no restart — because a
    // long command is very often a correct one (a full typecheck, a jest run).
    // The failure it is against is silence: a worker sat 13 minutes inside one
    // Bash call and the card said "working, stage 3 · last tool Bash".
    longToolMs: num(env.LONG_TOOL_MIN, 5) * 60_000,

    // The watcher — see watch.ts. Every guard used to evaluate at dispatch and
    // never look again, which is how a machine crashed while the dashboard
    // reported headroom. These are the numbers that make it look again.
    //
    // 5 s while anything is running: jest can allocate gigabytes in seconds, and
    // the tick costs three short-lived processes (<100 ms of work), so it is
    // affordable at that cadence and useless at a slower one. 30 s when nothing
    // of ours is running, because a warning still matters when the operator's own
    // terminal is eating the machine.
    watchIntervalMs: num(env.WATCH_INTERVAL_MS, 5_000),
    watchIdleIntervalMs: num(env.WATCH_IDLE_INTERVAL_MS, 30_000),
    // The ladder. Every step is display or a PAUSE — nothing here kills.
    warnFreePct: ladder.warnFreePct,
    pauseFreePct: ladder.pauseFreePct,
    floorFreePct: ladder.floorFreePct,
    // Level 3 (pause the largest tree at <10 % free) is opt-IN: at that point
    // there is still time for a person to choose which work to stall.
    autoPause: on(env.AUTO_PAUSE, false),
    // Level 4 (pause EVERYTHING at <5 % free) is ON — the operator's decision, 2026-08-11,
    // and the reason is the crash: a floor that only draws a button acts on
    // nothing at 3 a.m., which is exactly when this happened. It is safe to
    // automate where the edge-runtime restart was not, because a pause is
    // reversible and loses nothing on disk, its trigger is one number from one
    // source, and it touches only this console's own children. Set
    // AUTO_PAUSE_FLOOR=0 to make it a button instead.
    autoPauseFloor: on(env.AUTO_PAUSE_FLOOR, true),
    // What we measure, show, and restart on the operator's click — the only way this
    // container is ever restarted. An EDGE_CONTAINER override has to look like
    // an edge runtime to be honoured at all.
    edgeContainer: edgeContainerName(env.EDGE_CONTAINER),

    // What a NEW worker is about to need. Not its resting size (0.2–0.5 GB) but
    // its spike: `npm run validate` / jest takes 1–2 GB, and two workers testing
    // at once is the actual crash risk on a 16 GB machine. MAX_ACTIVE cannot see
    // any of that, so this is the brake that can.
    workerHeadroomBytes: num(env.WORKER_HEADROOM_GB, 2) * GB,

    // How long an instances inventory is held: `docker stats` and `lsof` are not
    // free, and the panel is opened and refreshed by hand.
    instancesTtlMs: num(env.INSTANCES_TTL_MS, 5_000),

    // How often the console ASKS GITHUB. Nothing local rides this timer.
    //
    // Fifteen minutes, not two — the operator's call, 2026-08-12, after a night that
    // exhausted the 5,000/hr GraphQL quota. One poll is five read-only `gh`
    // calls (issues, open PRs, recently-merged PRs, plus a `gh pr view` per
    // tracked PR and a comment read per blocked issue), every two minutes, for
    // ever, with agent sessions querying the same quota alongside it. At two
    // minutes that is 30 polls an hour before a single worker has run.
    //
    // Nothing that reflects one of the operator's own actions waits for this timer:
    // start, resume, stop, pause, unpause, dequeue, reopen, restart-fresh,
    // rework-fresh, post-merge, worktree creation, the edge-runtime restart and
    // every worker ending all fire their own dispatch or their own poll, and the
    // Refresh button forces one on the spot. What this interval really governs
    // is how long an event on GITHUB — a review, a merge, a reply, a new
    // assignment — can sit unnoticed, and fifteen minutes of that is fine. The
    // header says when GitHub was last read, so 15-minute-old data never looks
    // live.
    pollMs: num(env.POLL_MS, 900_000),

    // The LOCAL machine read — memory_pressure, vm_stat and one `docker stats` —
    // which used to ride the GitHub poll and must not follow it out to fifteen
    // minutes: it is what the dispatch banner and the edge-runtime button are
    // drawn from, and it is also the poll-side number `#resourceVerdict` falls
    // back to. It costs no network and no quota, so it keeps the cadence it has
    // always had. The watcher's own 5 s / 30 s ticks are separate again and are
    // untouched by either.
    resourcesMs: num(env.RESOURCES_MS, 120_000),

    // The status summary asks GitHub three extra questions per window. Clicking
    // Daily/Weekly/Monthly back and forth must not hammer the API, so each window's
    // answer is held this long.
    summaryTtlMs: num(env.SUMMARY_TTL_MS, 60_000),

    claudeBin: env.CLAUDE_BIN ?? 'claude',
    codexBin: env.CODEX_BIN ?? 'codex',
    // The bottom of the model precedence chain: the per-issue picker, then the
    // issue's stamp, then the account's own default, then this. An id this build
    // has never heard of is passed straight through — see models.ts.
    workerModel: env.WORKER_MODEL ?? DEFAULT_MODEL,
    /** Codex has its own model namespace and therefore its own fallback. */
    codexWorkerModel: env.CODEX_WORKER_MODEL ?? DEFAULT_CODEX_MODEL,
    // Broad execution is allowed only with the console-owned PreToolUse fence;
    // the provider refuses to launch if that hook is absent or changed.
    codexSandbox: codexSandboxMode(env.CODEX_SANDBOX),
    // A headless `-p` worker has no TTY, so it cannot answer a permission prompt.
    // `acceptEdits` auto-approves file edits but STILL prompts for Bash — and the
    // issue-pipeline skill's Stage 0 preflight is all Bash (git status, gh issue
    // view, docker ps), so an acceptEdits worker stalls on its first command,
    // exits writing nothing, and the UI snaps back to "Start a worker" — what a
    // real run hit on #4329. The real guardrails are the skill's hard rules — never push,
    // never credentials, Gate D before any PR, human Gate E merge, no supabase
    // stop/db:reset — not the per-tool prompt, which an autonomous worker cannot
    // answer anyway. Override with WORKER_PERMISSION_MODE if you ever want prompts.
    workerPermissionMode: env.WORKER_PERMISSION_MODE ?? 'bypassPermissions',

    stateFile,
    // One line per worker run, appended and never rewritten. It is the evidence
    // a future "should we route models automatically?" decision would rest on,
    // so nothing in the console is allowed to edit or prune it.
    //
    // It lives beside the state file rather than at a fixed path, so anything
    // that redirects the console's state — every test does — redirects this too.
    // A test that wrote runs into the real repo would be poisoning the evidence.
    runsFile: env.RUNS_FILE ?? join(dirname(stateFile), 'runs.jsonl'),
    /** The operator's gate decisions, written by the console. See decisions.ts — it exists
     *  so four worker-written stores could be deleted rather than validated. */
    decisionsFile: env.DECISIONS_FILE ?? join(dirname(stateFile), 'decisions.jsonl'),
    // The actions ledger: what has already been announced, the notification
    // preferences, the phone subscriptions and the last good feed. Beside the
    // state file for the same reason runs.jsonl is — every test redirects
    // STATE_FILE, and this follows it, so no test can announce anything or write
    // over the real ledger. Separate FROM state.json because it is written on
    // every poll and state.json is written on nearly every event; keeping them
    // apart keeps each write small.
    actionsFile: env.ACTIONS_FILE ?? join(dirname(stateFile), 'actions.json'),
    // The last successful poll's GitHub reading — issues, both PR maps, blocked
    // notes, lanes and when they were READ — written whole on every good poll
    // and loaded at startup as explicitly-stale seed data. It is what stops a
    // restart inside a bad GitHub hour from blanking the board: the first poll's
    // failure fallbacks land on this instead of on an empty process. Beside the
    // state file for the same reason runs.jsonl is — every test redirects
    // STATE_FILE and this follows it. Separate FROM state.json because it is
    // derived data rewritten whole per poll, and a corrupt copy must cost one
    // stale-looking startup, never a running worker's re-attach row.
    githubSnapshotFile: env.GITHUB_SNAPSHOT_FILE ?? join(dirname(stateFile), 'github-snapshot.json'),
    // The VAPID keypair for phone push, generated on first use and written 0600.
    // It is a SECRET and this repo's .gitignore names its secrets individually,
    // so `push-keys.json` was added there in the same change that created this.
    pushKeysFile: env.PUSH_KEYS_FILE ?? join(dirname(stateFile), 'push-keys.json'),
    // Below this many graphql points left in the current hour, a TIMER poll
    // stops asking for actions — the console must not make a bad hour worse.
    // The operator's Refresh always outranks it, and it lifts the moment the hourly
    // window resets rather than latching for up to 59 minutes. The reading is
    // taken fresh from GET /rate_limit (free) every poll, never from a
    // fifteen-minute-old rider on a bucket the worker sessions drain.
    actionsQuotaFloor: num(env.ACTIONS_QUOTA_FLOOR, 500),
    // How far back an EVENT can be and still count as news. State (a standing
    // UAT fail) ignores this entirely — a to-do does not expire.
    //
    // CAPPED at the notify ledger's TTL, and that is not a style choice. The
    // no-re-notify guarantee rests on an inequality nothing stated: an action
    // has to leave the payload BEFORE its ledger entry is pruned. Set this above
    // the TTL and every long-lived action re-announces itself the moment its
    // entry ages out — the ledger forgets it, the payload still has it, and it
    // reads as new. Silently, on their phone, for ever.
    actionsLookbackDays: Math.min(num(env.ACTIONS_LOOKBACK_DAYS, 7), LEDGER_TTL_DAYS),
    // The master kill switch for every notification channel. NOTIFY=0 and the
    // console still shows the feed, still stamps the row, and says nothing.
    notify: on(env.NOTIFY, true),
    // Every worker's stream-json is written HERE, one file per session, rather
    // than down a pipe. A pipe has one reader and dies with it, which is why
    // restarting the console used to kill every worker mid-run; a file does not
    // care who is reading it. Beside the state file for the same reason
    // runs.jsonl is: redirect the state and a test redirects this too.
    streamDir: env.STREAM_DIR ?? join(dirname(stateFile), 'runs'),
    // How often the console reads what its workers have written, and how often
    // it asks a re-attached worker's pid whether it is still there.
    streamPollMs: num(env.STREAM_POLL_MS, 250),
    // Reading the metrics costs one read-only gh call (for CI), and the Settings
    // tab re-asks on a timer, so the built report is held this long.
    metricsTtlMs: num(env.METRICS_TTL_MS, 60_000),
    // The router-readiness card on the Dashboard is a BACKGROUND job, not a
    // render-time computation: once at startup and then on this interval, with
    // the answer persisted so a console restart shows the last one immediately.
    // Daily is right for a number that moves by a run or two a day.
    //
    // Capped at the largest delay `setInterval` can hold: anything over 2^31−1
    // ms silently becomes a 1 ms timer, so "refresh once a year" would mean
    // "refresh a thousand times a second".
    metricsRefreshMs: Math.min(num(env.METRICS_REFRESH_HOURS, 24) * 3_600_000, 2 ** 31 - 1),
    uiDir: env.UI_DIR ?? null,

    // Work sources are discovery-only: they answer "what is assigned to me?"
    // across GitHub and Linear without changing the existing execution repo.
    // The file contains a Linear personal API key, is gitignored, and is always
    // written mode 0600. LINEAR_API_KEY wins for managed/dev environments.
    connectionsFile: env.CONNECTIONS_FILE ?? join(dirname(stateFile), 'connections.json'),
    linearApiKey: env.LINEAR_API_KEY?.trim() || undefined,
    sourcesTtlMs: num(env.SOURCES_TTL_MS, 60_000),

    // The console's own manual, served by GET /api/info and read at request
    // time — editing the file and refreshing the page is the whole workflow.
    infoFile: env.INFO_FILE ?? join(repoRoot, 'docs', 'INFO.md'),

    // Claude accounts. No accounts.json = one implicit account at ~/.claude, i.e.
    // exactly what the console did before accounts existed. ~/.claude is also the
    // canonical dir every other account symlinks its skills and CLAUDE.md back to.
    accountsFile: env.ACCOUNTS_FILE ?? join(repoRoot, 'accounts.json'),
    canonicalConfigDir: env.CANONICAL_CLAUDE_DIR ?? join(homedir(), '.claude'),
    canonicalCodexDir: env.CANONICAL_CODEX_DIR ?? join(homedir(), '.codex'),
    // The one vetted script the Settings tab may run against an account dir. It
    // only ever makes the two symlinks, and it refuses to replace a real file.
    linkScript: env.LINK_ACCOUNT_SCRIPT ?? join(repoRoot, 'scripts', 'link-account.sh'),
    // The Settings "Check login" button runs a real `claude`. A hung probe must
    // not be able to sit on the UI, so it gets a hard stop.
    loginProbeTimeoutMs: num(env.LOGIN_PROBE_TIMEOUT_MS, 20_000),

    /**
     * THE BEFORE HALF OF EVERY SCREENSHOT PAIR — the dev server running the
     * UNTOUCHED checkout, which is the only place a "before" can come from.
     *
     * Null by default and never guessed, which is a deliberate refusal rather
     * than a missing default. The convention the skill documents is that the
     * primary checkout on 8080 is the before server (`references/gate-c.md`:
     * "If the BEFORE server (primary checkout, port 8080) is up") — and 8080 is
     * also the port `instances.ts` protects by number, because it serves edge
     * functions for every worktree at once. Reading a convention as a default is
     * how a console starts pointing a browser at a port nobody chose, so the
     * operator names it or the console takes no before captures and says so in
     * one line on the card.
     *
     * Setting it to 8080 is fine and is what most machines will want. Driving a
     * port is a read; it is `stopDevServerFor` that may never touch 8080, and
     * that fence is untouched by this one.
     */
    baselinePort: portOrNull(env.BASELINE_PORT),
    /**
     * A Playwright `storageState` file the OPERATOR created — the only auth the
     * capture runner has, and the only one it will ever be given here.
     *
     * The console hands this path to the browser and never opens it. There is no
     * code path in capture.ts that reads, types, stores or logs a credential,
     * and this is the field that keeps it that way: a signed-in capture is one
     * the operator already produced with the repo's own test tooling.
     */
    qaStorageState: env.QA_STORAGE_STATE?.trim() || null,
  };
}
