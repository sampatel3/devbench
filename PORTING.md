# Porting the console to your project

Almost everything here is repo-agnostic. This page is the list of parts that are
not, in the order you will hit them, followed by every environment variable and
what it defaults to.

Work through the first three sections and the console runs against your
repository. The rest is tuning.

## 1. The three settings with no default

```bash
export REPO=example-org/example-repo
export REPO_PATH=/absolute/path/to/your/checkout
export ASSIGNEE=your-github-login
```

- `REPO` — the repository whose issues the console polls, as `owner/name`.
- `REPO_PATH` — the absolute path to your checkout of it. Worktrees are cut out
  of this, under `<REPO_PATH>/.worktrees/`.
- `ASSIGNEE` — the GitHub login whose assigned work the console runs. It also
  lists issues that login *raised*, because a worker's spin-off issue is filed as
  you and is often assigned to nobody.

None of the three has a default and none ever will. A default would mean a fresh
clone quietly polling somebody else's repository under somebody else's name. If
one is unset, the console starts, warns once naming what is missing, and then
fails at the first `gh` call — a failure you can read, rather than a plausible
value you never notice.

The console uses the account the local `gh` CLI is already authenticated with. It
does not read, store or ask for a token.

## 2. What the console expects of your repository

These are conventions of the repository being worked, not of the console. Either
adopt them or change the two places that encode them.

**A worktree script.** The console runs `./scripts/git-new-worktree.sh <branch>`
inside `REPO_PATH` to create a worktree, then verifies the directory appeared.
Provide a script at that path that takes a branch name and creates
`<REPO_PATH>/.worktrees/<branch-leaf>/`. Creation is create-only: the console
never deletes or modifies an existing worktree, and every file it writes is
asserted to be inside the worktree it just created. See
`orchestrator/src/provision.ts`.

**Branch names must carry the issue number.** Branches are
`fix/issue-<N>-<slug>` or `feat/issue-<N>-<slug>`, and the worktree directory is
the part after the last `/`. The number is read back out of the branch name in
two places that have no other source for it: matching a pull request to an issue,
and recovering the issue for a worktree found by a scan. If your branches do not
embed the number, change `orchestrator/src/naming.ts` and expect the PR-matching
to need a new source. See `orchestrator/src/worktrees.ts`.

**Per-worktree environment.** After creating a worktree the console symlinks
`.env` and `supabase/.env.local` into it from the parent checkout. Adjust or drop
those in `provision.ts` if your project's local configuration lives elsewhere.

**Dependencies are not installed.** The early stages need no `node_modules`, so
the cost is paid when the worker first builds or tests. A fresh worktree with no
`node_modules` is the expected state, not a broken one.

**Ports.** Each worktree is assigned a dev-server port from a registry, taken
from the range 8081–8200, skipping 8080, 3001 and 3002. Port 8080 is the primary
checkout's dev server and is refused by number wherever the console would signal
a process, not merely skipped when handing ports out. Change the range and the
reserved set in `nextFreePort` in `provision.ts`, and the fence in
`orchestrator/src/instances.ts`.

**The base branch and the pipeline shape** live in the `issue-pipeline` skill,
not in the orchestrator. If your team merges to `main` rather than to an
integration branch, or reviews differently, that is the file to edit.

## 3. The pipeline skill

Every worker is told to apply `issue-pipeline`, and that skill is what defines
the nine stages, the five gates, and the gate-file contract the console reads:

- `.gate.json`, written by the worker when it stops, naming the gate, its
  question and any evidence paths.
- `.gate-history.jsonl`, appended on resume with the whole gate object and your
  verbatim decision.
- `.comment-request.json`, a drafted comment the console shows you and posts only
  on your click.
- `.issue-state.md`, the worker's own stage bookkeeping.

Install it with `./scripts/setup-skills.sh`, which links it into your agent's
config directory. It cannot live in this repository's `.claude/skills`, because a
worker's working directory is inside a worktree of *your* repository. If you fork
the skill, keep those four filenames or the console will not see the worker stop.

Evidence files are served through a fence: resolved inside one worktree,
symlinks followed, anything escaping the evidence directory refused, GET only,
no directory listing, size-capped. If you move where the skill writes evidence,
move `EVIDENCE_ROOT` in `orchestrator/src/evidence.ts` with it.

## 4. The board, if you have one

```bash
export BOARD_PROJECT_NUMBER=3
```

Unset is off, and off is the default: no card is read and none is moved,
everything else works unchanged. The number is the one your project's URL ends in
(`github.com/orgs/<owner>/projects/<number>`).

Turned on, the console makes exactly two automatic moves per issue — one when a
worker first runs on it, one when a pull request opens — and only for an issue it
is already tracking a worktree for. It moves a card forward along
`Backlog → Planned → Ready → In progress → In review → QA → Done` and never
backwards, and it will not move a card out of `QA`, `Done` or `Revisit`, because
a person put it there and it means something the console cannot see. If your
board's lanes are named differently, edit `LANE_ORDER` and `LANE_FOR` in
`orchestrator/src/board.ts`. The status summary's "tickets started" count reads
lane changes into `In progress`, so it follows the same names.

## 5. The local stack and the one restartable container

```bash
export EDGE_CONTAINER=supabase_edge_runtime_<your-project>_custom
```

The memory panel measures one container and offers a manual restart of it. The
default names a project that is almost certainly not yours — `docker ps` names an
edge runtime after the local project it belongs to — so set this or the panel
measures nothing.

The override is honoured only if it still looks like an edge runtime: a name that
does not start with `supabase_edge_runtime_` is refused, logged, and the default
used. There is no configuration that makes this button restart a database.

If your project has no local Supabase stack, leave it unset; the panel reports
what it could not read rather than inventing a figure, and nothing else depends
on it. The console never runs `supabase stop` or a database reset, and never
starts a second stack.

## 6. The review layer

The console reads your pull requests and turns a reviewer's changes-requested
into a rework round you can resume a worker from. It expects:

- reviews arriving as GitHub reviews on the PR, with `CHANGES_REQUESTED` as the
  signal;
- a `changes-requested` label as a convention the worker removes when it has
  fixed a round. A round also clears when the reviewer's latest review is no
  longer changes requested, or when the same reviewer asks again.

If your team never uses that label, the label half of the clearing rule simply
never fires and the other two still work. If your review bots post comments
rather than reviews, `orchestrator/src/review.ts` and `rework.ts` are where to
teach the console about them.

The console posts nothing into a review. Rework is always your click.

## 7. Accounts and models

`accounts.json` at the repository root is machine-local and gitignored;
`accounts.example.json` is the committed shape. No file at all means one implicit
Claude account at `~/.claude`.

Each entry is a provider profile — its directory is the authentication, settings
and conversation boundary for that CLI. Codex profiles must use a dedicated
`CODEX_HOME`, never the interactive `~/.codex`, because the console-owned
fail-closed hook belongs only in a dedicated folder; registration and the linker
each refuse the canonical home independently.

Model ids are a menu, not an allowlist: an id the console has never heard of is
shown as itself and passed through, so a provider rename cannot wedge you.
`WORKER_MODEL` and `CODEX_WORKER_MODEL` set each provider's fallback.

## 8. Linear, if you want it

Discovery can read assigned work from Linear as well as GitHub. Add a personal
API key under **Settings → Connections**, or set `LINEAR_API_KEY` for a managed
environment. The key is stored in an owner-only gitignored file and is never
returned to the browser.

Discovery is read-only. Execution still runs against the configured GitHub code
workspace, so work from another tracker opens in its source.

## Every environment variable

Nothing below needs to be set to get started.

### Workspace

| Variable | Default | What it does |
|---|---|---|
| `REPO` | none | Repository to poll, `owner/name`. Required. |
| `REPO_PATH` | none | Absolute path to the checkout. Required. |
| `ASSIGNEE` | none | GitHub login whose work is run. Required. |
| `BOARD_PROJECT_NUMBER` | unset — board off | Org project number the two automatic lane moves act on. |
| `PORT` | `4400` | Loopback port. The host is always `127.0.0.1`. |

### Workers

| Variable | Default | What it does |
|---|---|---|
| `MAX_ACTIVE` | `2` | Concurrent workers. A burn-rate cap, not a memory one. |
| `CLAUDE_BIN` / `CODEX_BIN` | `claude` / `codex` | Provider executables. |
| `WORKER_MODEL` | `claude-opus-5` | Bottom of the Claude model precedence chain. |
| `CODEX_WORKER_MODEL` | `gpt-5.6-sol` | The same for Codex. |
| `CODEX_SANDBOX` | `danger-full-access` | Codex sandbox policy. An unrecognised value stops startup rather than widening access. |
| `WORKER_PERMISSION_MODE` | `bypassPermissions` | Claude permission mode. A headless worker cannot answer a prompt. |
| `CANONICAL_CLAUDE_DIR` | `~/.claude` | The account other profiles symlink back to. |
| `CANONICAL_CODEX_DIR` | `~/.codex` | The interactive Codex home, which worker profiles may not use. |
| `LINK_ACCOUNT_SCRIPT` | `scripts/link-account.sh` | The one vetted script the console runs against a profile directory. |
| `LOGIN_PROBE_TIMEOUT_MS` | `20000` | Hard stop on the **Check login** probe. |

### Memory guard

| Variable | Default | What it does |
|---|---|---|
| `MIN_FREE_PCT` | `12` | Below this, dispatch holds. |
| `WARN_FREE_PCT` | `10` | Loud banner, two samples in a row. |
| `PAUSE_FREE_PCT` | `7` | Offers to pause the largest worker. |
| `FLOOR_FREE_PCT` | `5` | Pauses every running worker, on one sample. |
| `AUTO_PAUSE` | off | Opt in to the pause-largest step acting on its own. |
| `AUTO_PAUSE_FLOOR` | on | Set `0` to make the floor a button instead. |
| `WORKER_HEADROOM_GB` | `2` | What a new worker's test spike is budgeted at. |
| `SYSTEM_RESERVE_GB` | `5` | Backstop footprint ceiling: total RAM minus this. |
| `EDGE_CONTAINER` | an example name | The one container the restart button acts on. |
| `WATCH_INTERVAL_MS` | `5000` | Watcher tick while workers run. |
| `WATCH_IDLE_INTERVAL_MS` | `30000` | Watcher tick when nothing of ours runs. |
| `LONG_TOOL_MIN` | `5` | Minutes before one command is called out as long-running. Nothing acts on it. |
| `INSTANCES_TTL_MS` | `5000` | How long a `docker stats` / `lsof` inventory is held. |

The four ladder percentages are validated as a set: `floor < pause < warn <= min`.
A mis-ordered set is refused whole and all four fall back to the defaults with a
warning, because a half-honoured ladder pauses before it warns.

### Clocks and quota

| Variable | Default | What it does |
|---|---|---|
| `POLL_MS` | `900000` | How often the console asks GitHub. Nothing you click waits for it. |
| `RESOURCES_MS` | `120000` | The local machine read. Costs no quota. |
| `STREAM_POLL_MS` | `250` | How often worker output is read. |
| `SUMMARY_TTL_MS` | `60000` | How long a status-summary window is cached. |
| `SOURCES_TTL_MS` | `60000` | How long a work-sources snapshot is cached. |
| `METRICS_TTL_MS` | `60000` | How long the built measurement report is held. |
| `METRICS_REFRESH_HOURS` | `24` | How often the measurement snapshot is recomputed in the background. |
| `ACTIONS_QUOTA_FLOOR` | `500` | GraphQL points below which a timer poll stops asking for actions. Your **Sync** always outranks it. |

### Notifications

| Variable | Default | What it does |
|---|---|---|
| `NOTIFY` | on | Master switch for every channel. Off still shows the feed. |
| `ACTIONS_LOOKBACK_DAYS` | `7` | How far back an event counts as news. Capped at the 30-day ledger TTL, so nothing can re-announce itself. |

### File locations

All default to sitting beside `STATE_FILE`, so redirecting the state redirects
everything with it — which is how the test suite keeps out of your real data.

| Variable | Default |
|---|---|
| `STATE_FILE` | `state.json` at the repository root |
| `RUNS_FILE` | `runs.jsonl` beside the state |
| `DECISIONS_FILE` | `decisions.jsonl` beside the state |
| `ACTIONS_FILE` | `actions.json` beside the state |
| `PUSH_KEYS_FILE` | `push-keys.json` beside the state, mode 0600 |
| `CONNECTIONS_FILE` | `connections.json` beside the state, mode 0600 |
| `STREAM_DIR` | `runs/` beside the state |
| `ACCOUNTS_FILE` | `accounts.json` at the repository root |
| `INFO_FILE` | `docs/INFO.md` |
| `UI_DIR` | the built `ui/dist` |
| `LINEAR_API_KEY` | unset; the connections file otherwise |

## What travels unchanged

The gate machinery, the append-only history, the write fences, the resource
watcher and ladder, the accounts and models layer, the measurement log and the
whole UI are project-agnostic. So is the manual: `docs/INFO.md` is served at
`GET /api/info` and read fresh on every request, so it travels with the console
and you can edit it for your team without rebuilding.
