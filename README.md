<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo.svg" alt="DevBench" width="300">
</picture>

> **Archived, and not maintained.** This was a personal tool, published as a
> snapshot rather than grown as a project. Most of what it does — a worktree per
> task, parallel agents, diffs and a browser beside them — is now done better and
> for free by [Orca](https://github.com/stablyai/orca). The two ideas here that
> are still worth taking are that **a gate can be a process exit** (the worker
> writes a file and dies, so waiting for a human costs nothing and five gates are
> affordable) and that **the harness, not the agent, should produce the evidence**
> for a human review. The code stays up for anyone who wants to read those parts.

An operator's console for running coding-agent workers against tracker issues,
with five human gates.

DevBench runs on your laptop. It reads the issues assigned to you, cuts a git
worktree for one of them, and starts a Claude Code or Codex worker inside it.
The worker walks a nine-stage pipeline and stops at five gates. At each gate it
writes a file and exits, and nothing moves until you approve it, answer it, or
send it back. A waiting worker is not a paused process — it has exited, so it
costs no compute and no tokens.

The console never merges, never pushes, and never closes, edits, labels or
assigns an issue — it cannot, because the module that talks to your tracker
contains only read calls. Its one write on an issue or PR is a comment a worker
drafted, that you read, that you clicked, posted byte-exact. Its only other write
anywhere is a project-board lane, twice per issue, and only if you turn the board
on by naming it.

It binds `127.0.0.1:4400` and nothing else. There is no authentication, and
there is not going to be — see [SECURITY.md](SECURITY.md).

## What you need

- Node 20 or later.
- `gh`, the GitHub CLI, already signed in.
- Claude Code, Codex, or both, on your `PATH` and signed in.
- A git checkout of the repository you want the work done in. DevBench cuts
  worktrees out of it; it is not the same repository as this one.
- macOS, for the memory guard. Everything else works anywhere Node does; off
  macOS the guard reports that it cannot measure rather than guessing.

## Quick start

### 1. Install

```bash
git clone <your-fork> devbench
cd devbench
npm ci
```

### 2. Build both workspaces

```bash
npm run build
```

This builds the UI and then the orchestrator. The running console serves
`ui/dist`, so a rebuild without a restart leaves a new page talking to an older
API — the page carries a build id, the console reports the one it started with,
and a mismatch shows a banner telling you which one to reload. Rebuild and
restart together.

### 3. Point it at a repository

```bash
export REPO=example-org/example-repo
export REPO_PATH=/absolute/path/to/your/checkout
export ASSIGNEE=your-github-login
```

These three have no defaults, deliberately. `REPO` is the repository whose
issues the console polls and adopts, `REPO_PATH` is the checkout it cuts
worktrees out of, and `ASSIGNEE` is the login whose assigned work it runs. A
default for any of them would mean a fresh clone quietly working somebody else's
repository under somebody else's name. Leave one unset and the console says so
at startup and then fails on the first `gh` call, which is a failure you can
read.

Everything else has a working default. To see what else you can set, and what a
new team has to change, read [PORTING.md](PORTING.md).

### 4. Start it

```bash
npm start
```

Open <http://127.0.0.1:4400>.

### 5. Install the pipeline skill

```bash
./scripts/setup-skills.sh
```

Every worker the console spawns is told to apply the `issue-pipeline` skill,
which is what turns a bare agent into the nine stages and five gates. The skill
cannot live in this repository's own `.claude/skills`: a worker runs with its
working directory inside a worktree of *your* repository, so a project-scoped
skill here would be invisible to every one of them. The script links it into
your agent's config directory instead, and is safe to re-run.

A worker that cannot find a skill is never told so. It is simply instructed to
apply something that is not there, and the only symptom is prose that quietly
stops following the guide. The console checks at startup for that reason and
prints `SKILLS MISSING` with the command above. It still starts — a missing
skill is not a reason to be unable to work a ticket — so restart it once you
have run the script.

### 6. Start your first worker

Pick an issue in the left rail. Choose the account under **Run as** and the model
under **Run on**, press **Create a worktree…**, and confirm the commands it shows
you. Then press **Start a worker**. It runs the preflight and stops at gate A
with a scope for you to read. Nothing is built until you answer.

### 7. Optional: let the console take the screenshots

Gate C asks you to check the change by hand, and the evidence for it — a before
and an after of every screen the work touched — used to be the worker's job to
remember. It forgot often enough that missing captures became the single
commonest reason a gate went back, so the console takes them itself.

```bash
npx playwright install chromium
export BASELINE_PORT=8080          # a dev server on your untouched checkout
export QA_STORAGE_STATE=/absolute/path/to/storage-state.json   # optional
```

For every QA step that names a route, the console drives both servers — the
baseline for the *before*, the worktree's own for the *after* — at a fixed
viewport with animations frozen, writes the images into the issue's evidence
directory, and stamps them into the gate before the card ever reaches you.

`BASELINE_PORT` has no default on purpose: a console that guessed a port would
photograph whatever happened to be listening on it and call that your baseline.
`QA_STORAGE_STATE` is a Playwright storage state for captures that need a signed-in
session; the console hands the file to the browser and never opens it, and no
credential is ever read, stored or typed. Leave either unset and the capture
simply says which one it needs — steps a browser cannot drive (a SQL check, a
transcript) keep the sanctioned empty pair and a note saying why.

## The five gates

| Gate | After | What you decide |
|---|---|---|
| **A** | Scope | Is this the right problem? Nothing is built until you answer. |
| **B** | Plan | Approve the approach, after the sweeps that are expected to change it. |
| **C** | Understanding | Your own manual QA passed, **and** you can explain the change. Either failing loops back to the build. |
| **D** | Pre-PR | Approve raising the PR. You see the body and the diff stat first. |
| **E** | Merge | You merge, or tell the team it is ready. Never the agent. |

Your reply is literally the resume prompt: what you type is what the worker
reads, verbatim, and both halves are appended to an append-only gate history so
any passed gate can be reopened and shown as it was decided.

## Philosophy

**Gates are exits, not pauses.** A stop that costs money is a stop people learn
to skip. Every gate ends the worker process, so an issue can sit at gate C for a
week at no cost, and there is never a reason to wave one through to free the
machine.

**Fences are code, not conventions.** The console cannot edit, close, label,
assign or merge anything: the GitHub module contains only `list` and `view`
calls, the single comment path throws on any verb but `issue comment` and
`pr comment`, and a test guards the module against ever exporting a writer.
Worktree creation may bring a worktree into existence and do nothing else. One container
may be restarted, by name prefix, on your click. A process is signalled only
when it can be attributed to a worker or to a dev server inside that worker's
worktree. No credential is ever read, stored or displayed; logging in is always
you, in a terminal.

**Honest measurement, or none.** Every worker run appends one line to an
append-only log — tokens, cost, duration, files touched, which gate it stopped
at, how many attempts that gate had already taken. Later signals are joined at
read time rather than written back. A number that could not be read is left out
rather than defaulted, because "no PR" and "no rework" are different answers.
There are no rankings, no trend arrows, no recommended model and no automatic
router: any cell under five runs is marked as unable to support a routing
decision, and a difference between two small cells is not a finding.

**A read it could not make is never dressed as a fact.** GitHub goes away —
sometimes loudly, sometimes as a cost limit whose counters still read full. When
a read fails the console keeps the previous answer and stamps the age of the
*data*, never of the attempt; when it has no previous answer it says so on the
row rather than inventing one, because a row that reports a healthy worker as
dead will send you to restart work that already merged. The merged-PR read has a
second road through the REST API for the day the first one is refused, a restart
reloads the last good read instead of booting blind, and the banner names every
failed read rather than the first.

## Where to read next

- [docs/INFO.md](docs/INFO.md) — the full manual: the nine stages, the review
  layer, the memory ladder, accounts and models, and what the console will and
  will not touch. The console serves it at `GET /api/info` and renders it in the
  **Guide** tab, read fresh on every request.
- [PORTING.md](PORTING.md) — what a new team has to configure.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to build, test and write here.
- [SECURITY.md](SECURITY.md) — the localhost-only design, and how to report a
  problem.

## License

Apache License 2.0. See [LICENSE](LICENSE).
