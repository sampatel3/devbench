# How this works — issue to closed

The console's own manual: how an issue travels from filed to closed, what the
nine stages and five gates are, what the review layer does, what this console is
allowed to touch, how accounts and models work, and what to change to point it at
another repo.

It is one file — `docs/INFO.md` — served at `GET /api/info` and read fresh on
every request. Edit it and refresh the page.

**If a banner says this page and the console disagree, believe it.** `npm run
build` overwrites `ui/dist`, which the *running* console serves — so a page
loaded after a rebuild is a new UI talking to an older API. Nothing errors;
buttons just quietly do nothing, which is how an Approve click can appear to be
ignored. The page carries a build id, the console reports the one it started
with, and a mismatch shows a plain banner: *restart the console and reload*, or
*reload this page*.

Sources: the `issue-pipeline` skill and the code. Where a section describes how
issues are labelled, closed or moved on a board, it is describing **one team's
conventions as an example** — the parts your own team configures are marked as
such, and the parts the console itself depends on say so.

---

## Start here — using the console

### Point it at a repo first

Three settings have no sensible default, so there is none: the console warns at
startup and the affected views stay empty until you set them.

| Setting | What it is |
|---|---|
| `REPO` | the tracker repo to poll, as `owner/name` |
| `REPO_PATH` | the absolute path to your checkout of it, the one worktrees are cut from |
| `ASSIGNEE` | the GitHub login whose assigned and authored issues make up your queue |

A wrong default here is worse than a missing one — it would poll somebody else's
repository and adopt somebody else's issues — so the console never guesses.
`BOARD_PROJECT_NUMBER` is the same argument taken further: unset means there is
no board, no card is read and none is moved. See **Porting this to a new
project** for the rest.

### On a fresh clone, install the skills first

```bash
./scripts/setup-skills.sh
```

The console names skills to every worker it spawns, and the one it checks for is
`issue-pipeline`, which ships in this repo. It cannot live in this repo's own
`.claude/skills`, because a worker runs with its working directory inside a
worktree of the repo being worked, not here — a project-scoped skill would be
invisible to every one of them. So it is linked into the account config
directory instead, and that is what the script does. It also picks up any shared
skills you keep in a separate repository beside this one (`CLAUDE_SKILLS_DIR`
points elsewhere), and it never overwrites anything that is not a symlink it
already owns.

A worker that cannot find a skill is never told so. It is simply instructed to
apply something that is not there, and the only symptom is prose that quietly
stops following the guide — in every gate card, with nobody looking. The console
checks at startup for that reason, and prints `SKILLS MISSING` with the command
above if one fails to resolve. It still starts: a missing writing skill is not a
reason to be unable to work a ticket.

### The six tabs

| Tab | What it is for |
|---|---|
| **Tickets** | The working view. Every ticket on the left, the selected one on the right. |
| **Overview** | One row per ticket, one dot per stage — the whole workspace at a glance. Also the status summary. |
| **Activity** | What GitHub has done that needs you: reviews, replies, verdicts, assignments. |
| **System** | Memory, containers, dev servers, the resource ladder, pause. |
| **Settings** | Accounts, connections, alerts, and the measurement table. |
| **Guide** | This page. |

To the right of them, behind a divider, sit things that are **not** navigation:
the source chips (`GitHub Issues · 21`, `Linear · not connected`), **Sync**, when
GitHub was last read, and **Connections**. Sync refreshes both halves at once —
the console's own GitHub poll and the work-sources snapshot.

Top left is the **workspace picker**. One workspace today (`REPO` / `REPO_PATH`);
its options are what the server actually reports, never a placeholder. Adding a
second is orchestrator work — per-repo polling, `gh` calls, worktree roots and
slot accounting — so until then the only other option is the one that does
something: *Add a workspace…*, which opens Connections.

### The rail, and finding things in it

The left rail lists every ticket. Each row shows the issue number, **the PR number
beside it**, the title, and chips: priority, board lane, stage, provenance and
status. A PR marked `↗` belongs to another issue that this one was folded into.

**Search** sits at the top of the rail. It matches an issue number, a PR number
(`4623`, `PR #4623`, `pr4623`) or words in a title. Numbers match whole, so `619`
does not drag in `4619`. It filters only — it never reorders, because the order is
the argument about what to do next.

**The order** is: whose hands it is in (yours → your worker's → unstarted →
elsewhere), then priority band, then what is waiting on you, then most recently
updated. A queued ticket sinks because nothing is waiting on you — the dispatcher
starts it, not you. The selected row has a solid background, a thick left edge,
and keeps its status colour on that edge.

### What you actually click

Orange always means the same thing: it needs you.

- **A gate card** — Approve, Send feedback, or Ask a question. Typing in the box
  and pressing Approve sends *both*, verbatim.
- **A comment card** — a worker drafted a comment. **Post this comment** sends it
  byte-exact; **Discard draft** throws it away without posting.
- **A rework card** — a reviewer requested changes; one click resumes the worker
  with your brief.
- **A send-back card** — QA failed it in UAT; **Start the fix** opens the round.
- **Run Stage 9** — after a merge: hand the card to QA, choose the verification
  path, draft the QA script.
- **Start a worker** / **Create a worktree…** — with **Run as** and **Run on**
  pickers beside them.
- **Park this issue** — set it aside; it sinks and stops asking.

### Where the settings are

**Settings** holds how the machine is configured: accounts and their login state,
work-source connections, alert and push preferences, and the measurement table.
**System** holds what the machine is doing right now: memory, containers, dev
servers, the ladder and pause.

---

## The map

One issue at a time, one worktree, one agent session, five places the machine
stops and waits for you. Work never flows past a gate on its own, and a waiting
worker is not a running process — it has exited, so it costs nothing.

```
issue filed → labels/triage → assigned → worker (9 stages, 5 gates)
  → PR to the integration branch → automated reviews → rework rounds
  → you merge (Gate E) → promotion through your environments
  → QA verification on the issue → closed
```

The console covers the middle: from "this issue has a worktree" to "the PR is
merged". Filing, triage and assignment happen on GitHub; promotion, QA and closing
are Stage 9, tracked on the issue.

The branch names either side of that middle are your team's. The examples in this
manual use `dev` for the integration branch and a `dev → test → main` promotion
train, because that is a common shape and a concrete one is easier to read than a
placeholder. Nothing in the console requires those names.

## Work sources

**Tickets** discovers assigned work from GitHub, Linear, or both. GitHub uses the
account already authenticated by the local `gh` CLI. Linear uses a personal API
key entered under **Settings → Connections**; the key stays in an owner-only,
gitignored file and is never returned to the browser.

Discovery is read-only: it identifies work, it does not comment on, close or
change it. Execution still runs against the configured GitHub code workspace, so
work from other repositories opens in its source until a code-workspace mapping
and a provider-neutral worker protocol exist.

## The GitHub issue lifecycle

Two kinds of thing live in this section, and it is worth knowing which you are
reading.

- **What the console depends on.** Priority labels, the issue number in the
  branch name, the board lanes it will write. Change these and code changes with
  them.
- **Example conventions.** Everything about label axes, triage workflows,
  promotion branches and QA verdict wording is one team's setup, kept concrete
  because a worked example is easier to adapt than a blank. Your team's will
  differ, and nothing breaks when it does.

### What the console depends on

**Priority comes from labels, and the console reads five of them by name.** `p0`,
`p1`, `p2`, `p3` and `icebox`, case-insensitively. They set the dispatch band (see
**Which queued ticket goes next**) and the priority pill on every row. Two
priority labels on one issue is a triage mistake rather than a state to model, so
the most urgent wins.

**Untriaged is read from the absence of those five, not from a label.** An issue
carrying none of them sorts as untriaged — above icebox, below `p3`, and
deliberately not treated as `p2`, which is a stated default for real work rather
than something anyone has said about this issue. A `needs-triage` label is
therefore never read: it means the same thing the missing priority already says.
That is what keeps the pill honest when the two disagree — an issue with a
priority *and* a stale `needs-triage` shows the priority.

**Every branch embeds its issue number.** `fix/issue-<N>-<slug>` or
`feat/issue-<N>-<slug>`. The worktree directory takes the last path segment, so
the worktree scanner reads the number back out of the directory name, and board
automation that parses branch names finds it too. A branch without the number is
a worktree the console cannot attribute to anything.

**`Closes #N` does not close an issue from a side branch.** GitHub auto-closes
only on merges into the default branch, so a PR based on an integration branch
closes nothing on merge. The keyword still belongs in the body — it is how a
person reads the link — but do not expect a closure from it, and do not expect
GitHub's Development panel to show a linked PR either. Match PRs to issues by
branch, which is what the console does.

### The console moves two board lanes

It used to move none, and anything you read saying so is out of date. It now
makes exactly two moves, on two milestones it already holds without asking
anyone:

| Milestone | Meaning | Lane written |
|---|---|---|
| `started` | a worker has run on this issue | `In progress` |
| `pr-open` | a pull request is open for it | `In review` |

Both are facts about work the console can see. Everything past them is a claim:
`QA` says the work is ready to be verified by somebody, and that stays your
click.

Six rules fence it in, and each exists because of a way it went wrong:

- **Off unless you turn it on.** `BOARD_PROJECT_NUMBER` unset means no card is
  read and no card is moved. A guessed project number would move cards on
  whatever project happens to be numbered that in your org, which is the worst
  outcome available.
- **One move per milestone, per issue — not one move per issue.** An earlier cut
  allowed a single automatic move ever, so a card that reached `In progress`
  could never reach `In review` for the life of the state file. Cards sat on `In
  progress` behind open PRs because of it. Per-milestone still means dragging a
  card back sticks: the milestone that moved it is already spent.
- **Never out of a lane a person chose.** `QA`, `Done` and `Revisit` mean
  something the console cannot see, so a card sitting on one is left alone.
- **Never backwards.** The lanes have a lifecycle order — `Backlog`, `Planned`,
  `Ready`, `In progress`, `In review`, `QA`, `Done` — and a milestone may only
  move a card forward along it. Milestones do not arrive in order: `pr-open` can
  resolve on one poll and `started` fire on the next, which is exactly how a card
  once went `In review` → `In progress`.
- **`Backlog` needs your name on the issue.** A card the team parked in `Backlog`
  is their triage decision. The console moves out of it only for an issue you
  raised.
- **Fail closed.** The lane is read fresh in the same call as the write, never
  carried across a poll boundary, and a read that fails means no move. This
  codebase keeps the last good value when a read fails, which is right for a
  label and wrong for a write.

The write itself is `gh project item-edit`, aimed by ids assembled here and
guarded by an assertion that refuses any other `gh` subcommand. **A worker still
cannot touch the board**: the fence attached to worker processes denies every
board write, and it was not widened for this.

### Example conventions

The rest of this section is one team's setup. Read it as a worked example.

**Labels on three axes** — one type, one `area:*`, and an `env:*` on bugs — with
a workflow that lifts issue-form answers into labels and manages `needs-triage`.
**Priority stays human** in that setup; a missing priority is normal and is
triage's job. Priority labels also drift from the severity argued in the body, so
read the body.

**Assignment can be automated for issues filed by engineers.** A workflow assigns
the author and adds the issue to the board as `Ready` — but typically only for
logins on an allowlist, and only when the issue is opened. That allowlist is why
some of your own issues arrive assigned to nobody.

**Issues close in one of three ways**, and it is worth knowing which yours does:
QA closes it with a verdict comment; an automatic close fires when the promotion
train reaches the default branch; or a person closes it with a re-verification
comment. In the observed setup the automatic path was **nondeterministic** — the
same promotion PR closed two issues and silently did not close a third — and
merge-to-close gaps ran from under two hours to over two days.

"Merged", "in QA", "promoted" and "closed" are four separate states, and **the
weak link is closed-unverified**: an issue can auto-close at promotion with no QA
evidence attached to it at all. On a customer-reported production bug that is a
bad way to find out. It is why the skill makes you choose the verification path
immediately after the merge — a cherry-pick to the release branch when QA must
verify before production, otherwise the daily train can put the fix in prod, and
close the issue, before QA sees it.

**QA verdicts arrive as free text on the issue, with no label.** The console
parses them, and what it looks for is a heading: `**Test Result:** Pass`, or a
standalone `**Pass:**`, `**Partial Pass:**` or `**Fail:**`. Four gates guard that
parse — a bare regex would let a bot comment, or the console's own worker running
`gh` as you, light up top priority and push to your phone. This is the one example
convention the console hard-codes: if your team words a verdict differently,
`uat.ts` is the single place that decides what one looks like.

### Where your issues come from

Not everything in your queue was handed to you. **Workers spin issues off** — a
worker that finds a real problem outside its scope files it rather than dragging
it into the change, and files it **as you**. So an issue this laptop raised twenty
minutes ago can look exactly like triaged work a teammate gave you.

The console lists issues **assigned to you or raised by you**. Assigned-only was
the original query, and it hid a whole normal category: where autoassign only
writes an assignee for allowlisted logins on `opened`, a spin-off you file is
often assigned to nobody. Issues sat on GitHub, invisible here, for exactly that
reason.

Two chips answer different questions:

- **`needs triage`** — the priority pill, when nobody has ranked it. A
  `needs-triage` label means the same thing, so it is never shown twice; an issue
  with a priority *and* a stale label shows the priority. A teammate's issue reads
  `needs triage` as often as yours.
- **`self-filed`** — raised from this machine, by you or by a worker. Provenance
  and nothing else.

**The pair together is the one to look at twice**: an issue you filed that nobody
has ranked has had no agreement from outside this laptop. The start card says so
above the button, and the ordering sinks it inside its band — never out of the
band, never hidden. The status report marks the same issues, so a post pasted into
a team channel does not hand machine-generated backlog to the team as agreed work.

## The worker

**One provider conversation per issue.** The selected account chooses the provider
as well as the profile.

- Claude: `claude -p "/issue-pipeline <N>" --session-id <uuid> --model <model>
  --permission-mode bypassPermissions --output-format stream-json --verbose`
- Codex: `CODEX_HOME=<dir> codex -a never -C <worktree> -s <sandbox> -m <model>
  exec --json --output-last-message <file> "$issue-pipeline <N>"`

**There are two ids because Codex chooses its own.** The console always mints a
UUID first — it owns the run files, gate environment and row identity. For Claude
that UUID is also the conversation id (`--session-id`). Codex supplies a second id
on its first `thread.started` event, persisted immediately as `agentSessionId`;
without it a Codex run is not resumable.

**A gate stop is a process exit.** The worker writes `.gate.json` and exits. The
console sees the file and shows the card. Nothing runs while it waits, so a parked
worker costs no compute and no tokens. Your message is literally the resume prompt.

**Workers survive a console restart.** A worker is spawned **detached**, and its
JSONL stream goes to a file rather than down a pipe — a pipe has one reader and
dies with it, which is why restarting the console used to kill every run in
flight. Stopping the console **stops watching and kills nothing**; it says how
many it left running. On start it reads `runningRuns` from `state.json` and either
**re-attaches** from the exact byte offset (the row says so — it is not a fresh
start) or **reconciles** a run that finished while it was away, through the same
ending the live path uses.

A run is adopted only when three things agree: the pid is alive, its command line
still carries that provider's identity token, and the stream file exists and is
not older than the run. That makes a **recycled pid** detectable rather than
merely unlikely. Anything less is reconciled, never adopted.

**The only thing that kills a worker is you** — the **Stop this worker** button,
which asks first. Restarting the console is not that path.

**Gate history is append-only.** On resume the worker appends the whole gate
object plus your verbatim decision to `.gate-history.jsonl`, so any passed gate can
be expanded to show what was asked and how you answered. Runtime identity
(provider, profile, model, session) is a separate console-owned record joined at
read time — never a sidecar written into the worktree, where `git add -A` could
sweep it into a PR.

**Reopening a gate.** Expand a passed gate and there is **Reopen gate X**. Saying
what changed is required. The worker is resumed with your correction and sent back
to the stage that gate governs (A → 1, B → 2, C → 5, D → 6, E → 8). **It does not
rewind code** — nothing is undone or reverted; the worker says what it is redoing
before it redoes it. The original round stays in history exactly as you decided
it, with the reopening appended beside it.

**Approve sends what you typed.** With text in the box the button reads *Approve
with these answers* and sends both. It used to drop the box silently, which is how
a gate came to be recorded as approved with no answers at all.

**QA evidence is attached to the gate, not just the PR.** `.gate.json` carries an
`evidence` array of paths under `docs/issue-pipeline/plans/`; screenshots render
inline, transcripts and SQL as expandable text — so you review evidence at Gate C,
before anything is pushed.

**Terminal takeover.** Every row shows `claude --resume <id>` or `CODEX_HOME=…
codex … resume <thread-id>`. Two owners of one conversation fork it, so the
console watches that provider's transcript modification time; if the file for
**our** id moves while we are not running it, the row goes **detached**. An
unrelated session in the same worktree does not trigger it.

**Worktrees, ports and one shared database.** Each issue gets its own worktree and
branch from the repo's worktree script, with `.env` and any local service env
files symlinked in. **Dependencies are not installed** — stages 0–2 need no
`node_modules`, so the gigabyte or so is spent when the worker first needs to
build or test. A fresh worktree with no `node_modules` is the expected state, not
a broken one. Ports come from a registry: 8080 for the primary checkout,
worktrees from 8081, and two more ports held back for other local services. There
is exactly **one** local Supabase stack shared by every worktree.

**Headless workers cannot answer permission prompts.** Claude uses
`bypassPermissions` with its write fence attached to every start and resume via
inline `--settings`. Codex uses `-a never` and `CODEX_SANDBOX`, with broad
execution allowed only behind the console-owned fail-closed fence in
`$CODEX_HOME/hooks.json` — read and verified before every spawn; missing,
unreadable or changed means **do not spawn**. Every invocation pins
`-c features.hooks=true` and `--ignore-user-config`, so a profile or repository
cannot disable the fence. The shared policy denies out-of-policy GitHub writes and
nested `claude`/`codex` escapes. The guardrail is the skill plus an attached,
fail-closed fence — never a prompt no autonomous worker could answer.

## The nine stages and five gates

| Stage | What happens | Gate | What you decide |
|---|---|---|---|
| 0 Preflight | Worktree, branch, shared local services, board lane. Every `file:line` citation in the issue is re-checked — on one issue five of them were stale. | — | — |
| 1 Scope | Problem in plain English, acceptance criteria, in/out of scope, risks, open questions, each claim cited. | **A** | Is this the right problem? Nothing is built until you answer. |
| 2 Plan | The three checks that shape the code: sibling sweep, trace to the wire (producer → every consumer → strictest gate), affected rows (per-env SELECT-only counts). | **B** | Approve the plan. The sweeps are expected to change it — on one issue the sweep inverted the issue's own premise. |
| 3 Build | TDD. Every guardrail test is broken on purpose, shown red, restored, shown green; the transcript goes in the PR. | — | — |
| 4 Validate | Targeted tests and E2E, capped. Then the worker drives the real app, screenshots before/after on two ports, and compares console errors against the untouched checkout. | — | — |
| 5 Understanding | Plain-English walkthrough including "what I'm least sure about", comprehension questions both ways, and an exact click-script for you. | **C** | The big one. Passes only when your manual QA passed **and** you can explain the change. Either failing loops back to Build. |
| 6 Pre-PR | Sync from the integration branch, change-impact, adversarial passes, and the PR body: what changed for a user → screenshots → why → preflight → scope → the four contract sections → evidence → what was not run. | **D** | Approve raising the PR. You see the body and the diff stat first. |
| 7 PR and review | `gh pr create` against the integration branch, verified afterwards, then the review rounds. | — | — |
| 8 Merge | Pre-merge checklist: every DECISION NEEDED has a disposition, deferrals have issue numbers, merge-sequencing risks cross-commented. | **E** | You merge, or tell the team it is ready. Never the agent. |
| 9 Post-merge | Hand the card to QA, choose the verification path, hand QA a ready script, track to closure. Merge is not done. | — | — |

What each gate has actually caught:

- **A** — building the wrong thing from a stale issue, five wrong citations in the
  body.
- **B** — fixing one instance of a class: the change needed all seven mounts, not
  the four the issue named.
- **C** — green tests over a broken screen: a panel rendering 90% transparent that
  all eighteen acceptance criteria missed.
- **D** — findings the reviewer would have made instead: two tests asserting
  nothing, two user-facing bugs.
- **E** — an agent shipping to production.

## The review layer

**Several layers fire, and this is the shape of one setup.** An automated review
workflow runs when a PR is opened, reopened or marked ready — **not on pushes**,
so a new round needs a fresh mention to trigger it. An on-demand review you
summon by comment is the second. The third is a multi-model review panel that
looks at security, adversarial cases, senior judgement, verification and design
in separate passes, and it produces most of the real blocking findings.

**A DRAFT GETS NO REVIEW AT ALL.** GitHub dispatches no CODEOWNERS review
request while a PR is a draft, and a review workflow that fires on
`ready_for_review` fires on nothing else — so a draft has no reviewer, no review
workflow and no way to acquire either by waiting. `reviewDecision` still reads
`REVIEW_REQUIRED`, which is the trap: it names a requirement, not a person.
Marking the PR ready is the only thing that starts anything. Two issues sat at
Stage 7 for weeks on this, every gate green, while the console reported them as
awaiting a codeowner — see `waiting.ts`/`blocker.ts`, which now say whose click it
is.

**Nothing may ever approve.** In the observed setup there are zero APPROVED
reviews across every PR studied; the panel's terminal verdict on sensitive
surfaces is `human-review-needed` by design. CHANGES_REQUESTED is the normal
state of a healthy PR there. Find out which your repo is, and if it is this one,
do not wait for a green check that is not coming.

**A `changes-requested` label is a convention, not a state machine.** After
fixing a round the worker removes it explicitly and requests re-review.

**How the console surfaces it.** Every poll reads the open PR (read-only). A
CHANGES_REQUESTED review newer than the last recorded round, from anyone but you,
becomes a **rework** round: the row turns orange with the reviewer, the PR and the
requested changes in an editable box. One click resumes the *same* worker. **The
console posts nothing here.** When the PR was made outside the console there is no
session to resume, so the button becomes **Start fresh worker for rework** — a new
session spawned with `/issue-pipeline <N> resume` plus your brief.

**Rounds resolve themselves.** Rework often happens elsewhere, and an orange card
for an ask dealt with days ago is a card that lies. Every poll clears the round on
any of three read-only signals: the reviewer's latest review is no longer changes
requested; the same reviewer has asked **again** (the old round closes, a new one
opens); or the label is gone **and** a commit landed after the ask. That last one
needs both halves — clearing an ask that is still real loses you the ask. There is
no "mark handled" button, and **rounds are never deleted**: each keeps how it
resolved. Only one round is actionable at a time.

**Round two is usually created by round one** — on one PR both of the round-two
HIGH findings were remedies from round one. Fix the class, not the cited line, and
sweep your own remedies hardest. **And merges are fast** — 17 seconds after a
verdict has happened, and the merger absorbs open items silently, so anything you
want considered must be in the body before the verdict.

### When the PR merges — the row follows the work

The console used to learn about PRs only from the **open** list, so a merged PR
vanished: the row's PR went null, the stage fell back to `.issue-state.md`, and
finished work read **"checkpoint — stopped after stage 7"**. Three issues read
that way on one morning, behind three merged PRs.

One extra read-only list per poll now asks for recently-merged PRs by head branch.
On a branch collision the **open** PR wins: branches get reused, and a new open PR
on a branch whose last PR merged is the live work. If that call fails the previous
answer is kept rather than emptied.

**An issue folded into another issue's PR still finds it.** A PR is matched by head
branch, so an issue whose fix rode inside a different issue's PR matched nothing
and read `checkpoint` for ever. The timeline already names every PR that references
an issue, each with its head branch, so those are resolved through the same branch
map. The result is marked `inherited` and shown with `↗`: a cross-reference is only
a mention, so a PR on a branch the console never fetched is skipped rather than
faked.

What changes on the row: it reads **merged**, at stage 9, and names the PR, in
green — merged work is a state with an action available, not a demand, and it
leaves the waiting-on-you count. A rework round the merge overtook resolves itself
as *"overtaken by events"*, and no new round can open on a merged PR. The same
holds for a worktree whose issue has closed. The detail pane offers **Run Stage
9**, prefilled and editable.

**The write fence holds through all of it.** The skill has the worker post the QA
comment; a console worker may not. The prompt sends it to
`kind: "handoff"` `.comment-request.json`, which comes back as the comment card and waits for your
click — or your **Discard draft**, when the moment has passed.

## How often the console looks — three clocks, not one

| Clock | Every | What it reads | Cost |
|---|---|---|---|
| **The GitHub poll** | **15 min** | issues, open PRs, recently-merged PRs, the review on each tracked PR, replies on blocked issues, a worktree scan | five-plus `gh` calls against the hourly quota |
| **The machine read** | 2 min | `memory_pressure`, `vm_stat`, one `docker stats` | local, ~1–2 s, no quota |
| **The watcher** | 5 s running / 30 s idle | one `ps` over the table, `memory_pressure`, `vm_stat` | local, under 100 ms |

The GitHub poll was two minutes until a night of it exhausted the 5,000/hour
GraphQL quota — 30 polls an hour, for ever, with agent sessions querying the same
quota alongside it.

**Nothing you do waits for it.** Every action — starting, answering, feedback,
stopping, pausing, dequeuing, reopening, rework, Stage 9, creating a worktree,
posting a comment, restarting the edge runtime — fires its own dispatch or poll on
the spot, and every worker that ends runs a full poll. So does **Sync**, the
deliberate escape hatch. What the fifteen minutes governs is how long an event
**on GitHub** can sit unnoticed, which is why the header stamps when GitHub was
last read. Fifteen-minute-old data must never look live.

The memory clocks are independent: slowing the GitHub poll was not allowed to slow
the guard that keeps this laptop up. `POLL_MS`, `RESOURCES_MS`,
`WATCH_INTERVAL_MS` and `WATCH_IDLE_INTERVAL_MS` set the four numbers separately.

## The status summary

On the **Overview**, under *Status summary*. Two things, in order.

**The counts, first.** Pick a day, or a range, and get four numbers:

| Count | Where it comes from |
|---|---|
| **Tickets started** | lane changes into `In progress` |
| **PRs raised** | gate D approvals — the go-ahead to raise the PR |
| **PRs merged** | merges the console announced |
| **Issues closed** | one read-only `gh issue list --state closed` |

**Days are Eastern days** — `America/New_York`, not UTC and not this laptop's
zone, because that is the working day these numbers describe. It is computed
through the IANA database rather than a fixed offset, so the winter half of the
year is not quietly an hour out: a day opens at 04:00Z in summer and 05:00Z in
winter. Ranges are inclusive of both ends. The zone is a constant in `counts.ts`;
if your team's day is somewhere else, that is the one line to change.

**Three of the four cost no network read**, because the console already has them.
The notification ledger keys every lane change and every merge it has announced —
`lane-change:issue#123:In progress:2026-08-12T06:22:30Z` — and `decisions.jsonl`
keys every gate D. Only *issues closed* has no audit entry, because nothing
announces a closure, so it keeps one GitHub read.

**The audit horizon is 30 days.** Settled ledger entries are pruned after
`LEDGER_TTL_DAYS`, so a range older than a month under-reports those three; the
panel says so rather than quietly shrinking. Tickets started counts **distinct
tickets**, not moves — a ticket bounced back and restarted is one ticket.

**The long report, second**, behind *Generate report*. It writes the status post
for a rolling window (daily, weekly, monthly) as plain text you can paste into a
team channel; **Copy** puts exactly what is on screen on the clipboard, character
for character. It costs three GitHub reads, which is why it is behind a click.

**"Waiting on a person" comes first** in that post, because it is the only part
somebody must act on: a worker stopped at a gate, a review requesting changes with
the rework not started, an open PR nobody has approved, a comment with no reply, a
session you took over in a terminal. Then **Issues Closed**, **PRs Merged**, **PRs
In Review** (with where CI stands), **In QA** — merged PR, issue still open, the
verification limbo between the two — then **In progress**, and last **No worker /
not started**, so an assigned issue with nothing behind it cannot quietly vanish
from your own status post.

**In progress is built by subtraction** — whatever the other sections have not
spoken for. That is the point: a status invented next month still comes out on the
post instead of falling through a gap. A section with nothing in it is left out; a
section that could not be **read** says `could not fetch — <what failed>`, because
an empty heading would claim nothing happened when the truth is that we do not
know.

## What is actually using your memory

Measured on this machine, not assumed.

**There is exactly ONE Supabase stack**, shared by every worktree. A worktree does
not get its own containers or database; starting a fifth worker does not start a
fifth stack. The containers you see are the same whether one issue is in flight or
five.

**One container is the whole problem.** The Supabase **edge runtime** container
had grown to **2.27 GB**. Restarting it took **12 seconds**, dropped it to **381
MB**, and took system free memory from **33% to 46%**. The database is a different
container and stays up. This is the leak, and the only container the console will
ever restart. `docker ps` names an edge runtime after the local project it belongs
to — `supabase_edge_runtime_<project>_custom` — so set `EDGE_CONTAINER` unless the
built-in example name happens to match yours.

**What scales per worker is small, until it tests.** A worker process is 0.2–0.5
GB while thinking; the spike is the number that matters — a full jest run takes
**1–2 GB** for its length. Two workers testing at the same moment is the real crash
risk on a 16 GB laptop, and `MAX_ACTIVE`, which counts workers, cannot see it.

**Dev servers are not one per worktree** — a worker only starts the app when it
needs it. One still up while its worker is parked at a gate is pure cost.

**The guard.** New dispatch is held below 25% free, and a new worker also needs
`WORKER_HEADROOM_GB` (default 2 GB) for itself and its test spike, with a
footprint ceiling of total RAM minus a 5 GB reserve as a backstop. **Swap is the
second signal**, holding at 85%: free % measures the room the machine reports,
swap measures what it has already paid to report it, and they disagree exactly
when it matters — one night the console read *31% free* while swap was 15,137 MB
of 16,384 with 8.37 GB compressed, and the machine was at the cliff. It is a
**hold only**: nothing is paused, killed or restarted over it, and `MAX_SWAP_PCT`
moves the ceiling. A reading that cannot be taken says so; a measurement nobody
took is never scored as a healthy one. Off macOS the guard allows and says so.
Running and gate-waiting workers are never touched — waiting costs nothing.

**`MAX_ACTIVE` is a burn-rate cap, default 2.** Total spend is roughly the same
serial or parallel, but parallel workers hit the subscription's rolling window
together and pause everything at once. Raising it is a deliberate decision.

**Which queued ticket goes next.** The line is ordered by what the work IS, not by
when it joined: **a UAT send-back first, then P0, P1, P2, P3, then unranked, then
icebox** — and inside a band, in the order the tickets were queued, so nothing
starves. It is the same order the rail draws (`ui/src/priority.ts`), so the row at
the top of your list is the row the dispatcher will start; the "next up" and "3 in
line" a queued row prints are places in that order. The rank is re-read on every
pass, so labelling a waiting ticket P0 moves it now rather than at the next
restart. The line used to be plain FIFO, which was a fair rule for a queue of one
and a wrong one for a queue of nine.

### The four controls

**1. The machine card (System).** Live numbers from the watcher's last tick — free
%, reclaimable headroom, the forecast, and a row per running worker with its tree
size and observed peak — over a read-only inventory: every container with its
memory (the edge runtime marked as the known leaker), every dev server on a
worktree's registered port with the issue it belongs to, this console's own
workers, and totals. The inventory costs a `docker stats` and an `lsof` per port,
so it is fetched on **Refresh** and held for a few seconds, never on the live tick
— and one stamp names both ages, so the two cadences are never conflated. Missing
`docker`, missing `lsof`, or a non-macOS machine: it reports what it can and says
what it could not read, with the command it ran one click below. The caveats that
make the numbers honest — the RSS over-count, the 2 GB-per-worker forecast model,
what cannot be itemized, the ladder's thresholds — live in **How this is
measured** at the foot of the card.

**2. Restart edge runtime — a button, on your click, and nothing else.** The
dialog says exactly what happens: about 12 seconds, back to roughly 380 MB, the
database not touched, no other container touched, and a worker mid-flight could
see an edge function fail while it comes back. That last sentence is why it is a
button: it is a judgement about work you can see and the console cannot. While a
restart is in flight nothing new is started into it — dispatch and resume both
hold with their own reason — and a second click is refused rather than starting a
second restart. When it comes back the banner says what it did; a restart that
does **not** come back says that instead, with the reason. `EDGE_CONTAINER` can
move the name, but only to another edge runtime: anything not starting
`supabase_edge_runtime_` is refused and logged. There is no way — override, config
or otherwise — to make this button restart the database.

**3. Dev servers are stopped only when you say so.** An earlier cut stopped a
worktree's dev server when its worker **parked** at a gate; that was wrong and is
gone — **gate C is your own QA of the running app**, and the screenshot capture
drives the same server, so stopping it there takes the app away at the exact
moment you need it. **Approving gate C is different** and does stop it: that is
the moment its last customer walks away — one sat on port 8083 for a whole day. It
is still your click, and it goes down the same guarded path as the button: the
process must be listening on that worktree's registered port **and** have its
working directory inside that worktree. Port 8080 is never touched. A stop that
fails is logged and dropped — your approval has already been taken, and a dev
server that will not die must never make a gate decision read as failed. Nothing
else stops one; when the console does, the row says when and why.

**4. Stop this worker frees what the worker caused** — it kills the provider
process *and* the worktree's dev server, so stopping actually returns memory, and
the confirm dialog says so first. When nothing was running it does nothing at all:
a stop of an idle issue must not quietly become a bare dev-server kill, because
that server may be the app you have open at a gate.

The two holds read differently on purpose: *18% free, need 25%* is the machine
being uncomfortable now; *1.4 GB free, a worker needs ~2 GB of headroom* is there
being no room for what the next one is about to do. A full desk is reported as
capacity, never as a memory problem.

### Why there is no automatic restart

The console used to restart the edge runtime by itself, when it was fat, the
machine was tight and no worker was running. It is gone deliberately, and it is
not coming back.

**Two full adversarial review rounds each found a blocking defect, and both were
the same shape.** The automatic path had to answer one question — *is a worker
running right now?* — and that question kept having more answers than the code
checked.

- **Round 1.** At startup the console is still working out which workers are
  alive. Re-attachment happens one at a time, and reconciling a dead entry ends in
  a full poll — so that poll asked "how many workers are running?" while live
  workers further down the list had not been attached yet, got told *none*, and
  restarted the edge runtime out from under two running workers.
- **Round 2.** A **detached** worker — one you took over in a terminal — is not
  the console's process at all, so it is invisible to the count. And a restart
  could begin during a dispatch that had passed its resource check but had not yet
  registered its worker.

Each round closed one hole and revealed another. That is the signal: the question
is not answerable from where the automatic path stands. And the trade was never
close — one click, against pulling the edge functions out from under a live worker
mid-run. The button stays; the automation does not. What is left is honest: the
panel shows the container's size, the banner says when memory is short, you decide.

## Watching the workers while they run

**The failure this fixes.** This machine crashed once at about 40 GB of memory
pressure. The chain is verified, not guessed: bare `jest` on ten cores takes nine
worker processes, each holding a full TS/React heap at 1–2 GB. Two console workers
both reached Stage 4, whose validate step ends in that test — about **eighteen
heavy node processes** — alongside agent sessions running this repo's own uncapped
vitest suite, a container runtime and local Supabase at ~3 GB, dev servers and
desktop apps.

The monitoring failed in one specific way, and it is the thing to remember:
**every guard evaluated at DISPATCH and never looked again.** "Is there room to
start another worker?" was asked once, before the spike it was budgeting for
existed. So the dashboard printed "34% free · 2.7 GB headroom" from a poll up to
two minutes old, and pretended there was room while the machine went down.

Three things were needed, and all three are here: cap the test fan-out, watch the
workers while they run, and give the floor something it can actually do.

**The cap** cannot be an environment variable — jest has none, and the console
cannot reach inside `npm run validate` to the test step it ends with. So it lives
in the instruction the worker follows: Stage 4 runs every step of validate except
the test step, then `npx jest --maxWorkers=2` on its own. It is a hard rule in the
skill and is appended to the prompt of every fresh spawn — belt to those braces
for a worker running an older copy — but **never** to a resume: resume prompts are
your words, recorded verbatim in gate history, and the console does not edit them.

**The watcher** samples every 5 s while workers run and 30 s when idle: one `ps`
over the whole table plus `memory_pressure` and `vm_stat`, under 100 ms. It
attributes each worker's whole process tree, keeps its observed peak, and feeds
both the forecast and the ladder.

**The panel refuses to claim what it cannot measure.** RSS over-counts shared
pages; the forecast models roughly 2 GB per worker; what the console cannot
itemize is named as unitemized rather than folded silently into a total.

**The ladder.** Five levels, on the watcher's cadence. A mis-ordered set
(`floor < pause < warn ≤ min`) is refused as a set and falls back to the defaults
with a warning.

| Level | Trigger | What happens | Automatic? |
|---|---|---|---|
| ok | ≥25% free and the forecast fits | nothing | — |
| hold | <25% free, or the forecast says the committed spikes do not fit | stop dispatching; the banner says why | yes — it is the absence of an act |
| warn | <15% free, two samples in a row | loud banner on every view, with the pause buttons on it | yes, display only |
| pause largest | <10% free, two samples in a row | one-click **Pause #NNNN (3.1 GB)**, biggest tree first | **click** — `AUTO_PAUSE=1` opts in |
| floor | <5% free, **one sample** | **pauses every running worker** | **yes, by default** — `AUTO_PAUSE_FLOOR=0` turns it off |

The floor acts on a **single** sample where the levels above it want two, because
jest can allocate gigabytes in seconds: a two-sample confirmation at a 5 s cadence
is a 10 s blind window, and at 5% free the machine is seconds from the cliff.

**Pause is the lever that throws nothing away.** It freezes a worker with SIGSTOP
— it keeps its slot and its memory and loses no work — and it only ever restarts
on a click. The automation never resumes anything.

**What survives.**

| Intervention | Uncommitted edits | Session transcript | Gate files / history | Queue + pending resume | Risk of loss |
|---|---|---|---|---|---|
| **Pause (SIGSTOP)** | survive (on disk) | survives (jsonl on disk, appended as it goes) | survive | survive | see the caveat |
| **Resume (SIGCONT)** | survive | survives | survive | survive | none |
| **Stop this worker** (your click) | survive | survives; session resumable | survive | survives | loses the in-flight segment's progress since its last tool result |
| **Restart edge runtime** (your click) | survive | survives | survive | survive | a mid-flight worker's edge call can fail |

**The one honest caveat.** What a pause interrupts depends on what the worker was
doing at that instant. During a **tool run** — the common case at the moment we
would pause, because the trigger is a test spike — there is no HTTP request in
flight at all, so nothing is lost.

## What the console will and will not touch

Enforced in code, not by convention.

- **GitHub is read-only, with exactly two exceptions.** `gh.ts` contains only
  `list` and `view` calls, and a test guards the module against ever exporting a
  writer, by name. The two writes each have their own fence and their own module.
  The console cannot edit, close, label, assign or merge, and there is no general
  `gh()` taking arbitrary write arguments.
- **Write one: a comment you approved.** An issue or PR comment goes through
  `assertCommentOnly`, which throws on any first two tokens other than
  `issue comment` or `pr comment`. **Workers never write to GitHub.** They draft
  `.comment-request.json`; a real product decision contains one question and
  optional one-line context, while a required workflow handoff carries its full
  text. The console posts the text you approved on the named issue or PR,
  byte-exact, one comment per click, and shows the URL. A decision always waits
  for its answer; a handoff never does. A draft can also be **discarded** without
  posting — that marks it consumed and never touches the worktree file, which
  belongs to the worker.
- **Write two: a board lane, on two milestones, into two lanes.** `In progress`
  when a worker has run and `In review` when a PR is open, once each per issue,
  never backwards, never out of `QA`, `Done` or `Revisit`, never out of `Backlog`
  on an issue you did not raise, and not at all unless `BOARD_PROJECT_NUMBER` is
  set. `assertBoardMoveOnly` throws on anything but `gh project item-edit`, the
  argv is built from ids here rather than from anything a worker can influence,
  and the worker's own fence still denies every board write a worker attempts.
  See **The console moves two board lanes**.
- **Worktree creation is create-only, forever.** It may bring a worktree that does
  not exist into existence and nothing else: it never deletes, never modifies an
  existing worktree, every file it writes is asserted to be inside the worktree it
  just created, and it shows you the exact commands first.
- **Never `supabase stop`, never `db:reset`** on the shared stack, never a second
  stack, and ports only from the registry.
- **One container may be restarted, by exact name, on your click.** No other
  container is stopped, restarted or removed, nothing is pruned, and nothing
  restarts anything by itself.
- **A process is only signalled when it can be attributed** — a worker it started,
  or a dev server both listening on that worktree's registered port and running
  inside that worktree. Port 8080 is refused by number.
- **Evidence files are served through a fence** — resolved inside that one
  worktree, symlinks followed, anything escaping `docs/issue-pipeline/plans/`
  refused. GET only, no directory listing, size-capped.
- **No credential is ever typed, read, stored or displayed.** Not by a worker, not
  by the console. The doctor reports booleans about files only. Logging in is
  always you, in a terminal.
- **Account directories get exactly one write path** — **Link worker files**,
  which runs one vetted script on your click, is idempotent, and never replaces a
  conflicting real file or foreign symlink. Removing an account deletes a line
  from `accounts.json` and nothing on disk.
- **Gates D and E are always human.** No auto-PR, no auto-merge, ever.
- **Localhost only.** It binds 127.0.0.1:4400. There is no authentication and
  there is not going to be.

## Claude accounts and Codex profiles

Workers can run under different accounts while the workflow, shared skills and
durable instructions stay identical. Each registry entry is a provider profile:
its folder is the authentication, settings and conversation boundary for that CLI.

**Claude isolation.** `CLAUDE_CONFIG_DIR=<dir>` relocates credentials,
`projects/` (the transcripts), `skills/`, `CLAUDE.md` and settings. A fresh
directory is genuinely isolated — it reports "Not logged in" rather than falling
back to the default account.

**Codex always gets a dedicated `CODEX_HOME`**, relocating authentication,
configuration, logs and `sessions/` rollouts. Worker profiles may **not** use the
interactive `~/.codex`: the console-owned fail-closed hook belongs only in a
dedicated folder such as `~/.codex-work`. Registration rejects the canonical home,
and the linker refuses it independently. Inherited `CODEX*`, `OPENAI*`,
`CHATGPT*`, `CLAUDE*` and `ANTHROPIC*` selectors are stripped first, so the host
agent cannot leak its identity into the worker.

**The default account is addressed by NOT naming it.** Setting
`CLAUDE_CONFIG_DIR=~/.claude` is *not* the same as leaving the variable unset —
which is what this console assumed, and what broke every worker on the default
account. Same stripped environment both times: unset, `claude -p` answers; set to
that exact default path, it says **"Not logged in · Please run /login"**. The
default account's credentials live in the macOS Keychain, so naming the directory
makes Claude Code look for a credentials *file*, find none, and refuse to start.
So a worker on the canonical account runs with the variable absent; only a
non-canonical account gets it set. The same rule decides the login command —
plain `claude /login` for the default, `CLAUDE_CONFIG_DIR=<dir> claude /login`
otherwise — from one helper, so Settings and the failed-worker card cannot drift
apart.

**A failed worker hands you the fix**: the exact login line for that issue's
profile — the Claude forms above, or `CODEX_HOME=<dir> codex login`. An account
registered but never signed in is a real state, and should look like a next step
rather than a mystery.

**The registry** is `accounts.json` at this repo's root (machine-local and
gitignored; `accounts.example.json` is the committed shape):

```json
{
  "default": "personal",
  "accounts": [
    { "name": "personal", "provider": "claude", "configDir": "~/.claude" },
    { "name": "work", "provider": "claude", "configDir": "~/.claude-work", "model": "claude-sonnet-5" },
    { "name": "codex", "provider": "codex", "configDir": "~/.codex-worker", "model": "gpt-5.6-sol" }
  ]
}
```

`provider` is `claude` or `codex`, and may be omitted only for backward
compatibility. No file at all means one implicit Claude account `personal` at
`~/.claude` — exactly the behaviour before accounts existed. A malformed file
falls back to the same rather than stopping the console.

**Where the picker lives.** **Run as** sits next to every button that begins work:
the **Create a worktree…** card, the start card, and the fresh-start card when a
PR made outside the console needs rework. It is visible even with a single account
— then reading `Run as: personal (default)`, greyed out — and the new-worktree
confirm dialog repeats the choice as `runs as`, so the account is on screen at the
moment you commit to it.

**Settings manages accounts.** It lists every profile with the doctor's verdict
and does three things: add one (name, provider, config directory, prefilled and
picked up live — no restart); **Link worker files**, which runs the
provider-specific command and prints what it did; and hand you the login command
to run in a terminal. The add flow is numbered — add it, link it, log it in, watch
it go green — and any unhealthy profile states its next step rather than making
you infer it. It also sets the default and removes one; removing takes out the
registry entry only, never a directory, and refuses an account any issue is
stamped with, naming those issues.

**One profile and provider per issue**, recorded as `accountByIssue` and
`providerByIssue`; missing provider stamps from older state mean Claude. Every
start and resume uses that same pair, with the environment cleaned of both vendors
first. **Locked once a session exists** — a transcript and its conversation live
inside one profile, so the picker greys out and points at **Restart fresh**. A
stamp alone never locks: a worktree created under an account that has never run
can still be switched, right up to the first spawn.

**Restart fresh is the only switch.** It abandons the conversation and mints a new
console id under the new profile; Codex then emits a new thread id on its first
event. The worktree, branch, commits, `.issue-state.md` and the whole
`.gate-history.jsonl` survive untouched — they are account-independent by
construction — and the new session reads them to pick the work back up. The live
`.gate.json` is cleared, because it names the session being abandoned. No session
is ever transferred between profiles or providers.

**Transcripts are profile-scoped.** Claude sessions live at
`<configDir>/projects/<dashed-cwd>/<session-id>.jsonl`; Codex rollouts under
`<CODEX_HOME>/sessions/`, found by the provider thread id.

**Consistency by symlink.** `scripts/link-account.sh <dir>` creates `skills` and
`CLAUDE.md` symlinks to the canonical sources; the `codex` form links `skills` and
`AGENTS.md` to the same places, and writes the one console-owned `hooks.json` — a
`PreToolUse`/`Bash` command using the absolute Node executable and shipped
`write-fence.mjs`. It writes only when absent, or accepts it when byte-identical;
a different real file, directory or symlink is never replaced. Provider-owned
settings are deliberately not linked. The link script is the **only** thing the
console runs against a profile directory.

**Is it actually signed in? Press the button.** File signals are hints only:
Claude may keep the canonical login in the Keychain, so no credential file means
*can't tell*, and Codex's `auth.json` being absent is not "logged out" either.
**Check Claude login** runs one real minimal prompt under that profile; **Check
Codex login** runs the non-model `codex login status`; **Check every login** does
all of them. The result is signed in, **not** signed in with the exact command, or
*couldn't tell* — never a false pass. It runs only on your click, is remembered
with its timestamp, and greys out after ten minutes, because a terminal login can
change underneath the console. Each probe uses the same cleaned,
provider-specific environment as a real worker.

## Choosing a model

Every worker is spawned with a model named explicitly. The selected profile
determines the namespace and menu; switching **Run as** from Claude to Codex
switches the model picker too.

| Claude model | id | When you would pick it |
|---|---|---|
| Opus 5 | `claude-opus-5` | The Claude default. Work where being wrong is expensive: the plan sweeps, the build, anything a rework round would punish. |
| Fable 5 | `claude-fable-5` | Writing-heavy stages — the scope at gate A, the walkthrough at gate C, the PR body at gate D. |
| Sonnet 5 | `claude-sonnet-5` | A change already well specified: the plan is approved and the work is mostly typing it out. |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | Small mechanical edits, and dry runs of the machinery where you do not need it to think. |

| Codex model | id | When you would pick it |
|---|---|---|
| GPT-5.6-Sol | `gpt-5.6-sol` | The Codex default and strongest choice for difficult implementation, debugging and high-consequence work. |
| GPT-5.6-Terra | `gpt-5.6-terra` | Balanced everyday agentic coding where speed and reliable execution both matter. |
| GPT-5.6-Luna | `gpt-5.6-luna` | Fast, economical mechanical edits, routine checks and tightly specified changes. |
| GPT-5.5 | `gpt-5.5` | Complex coding and research on the previous frontier generation. |
| GPT-5.4 | `gpt-5.4` | General coding that does not need the newest Codex reasoning. |
| GPT-5.4-Mini | `gpt-5.4-mini` | Small, fast, cost-efficient targeted edits and routine operations. |
| GPT-5.3-Codex-Spark | `gpt-5.3-codex-spark` | Ultra-fast coding where latency matters more than newest-generation reasoning. |

**Where the choice lives.** Next to **Run as**, on the same three cards, and each
account also carries a default on its card in **Settings**.

**The precedence chain**, most specific first:

```
the picker on this preflight → what the issue is stamped with
  → the account's own default → that provider's console default
```

Claude's console default is `WORKER_MODEL` (else `claude-opus-5`); Codex uses the
separate `CODEX_WORKER_MODEL` (else `gpt-5.6-sol`) — exactly the shape of account
choice, so there is one rule rather than two. Provider, profile and model stamp
together at **spawn**. A worktree with no session can still switch; a live
conversation locks all three, because it cannot move profiles and a measured
segment cannot span models. **Restart fresh** is the only switch, and an old
provider's model stamp is never carried into a new provider's namespace.

**The list is a menu, not a whitelist.** A model id this console has never heard
of — a custom fallback, an account default, or an id from before a rename — is
shown as itself and passed through (`claude --model` or `codex -m`). Refusing it
would mean a provider rename could wedge the console.

## What the console measures

One line is appended to `runs.jsonl` (beside `state.json`) every time a worker
runs. The file is **append-only**: nothing rewrites, prunes or deletes from it,
and a malformed line is skipped on read rather than being fatal — an audit log you
cannot read at all is worse than one with a hole in it.

**The unit is a segment, not a stage.** A worker runs from spawn, or from a
resume, until it stops at a gate and exits. That stretch is the only span with one
model in force from end to end. Stages are the worker's own bookkeeping inside a
segment; segments are where the switch points are.

Each line holds:

- **identity** — issue, provider, the gate it stopped at, model, the model the CLI
  actually resolved, profile, start, end, duration, console session id, provider
  `agentSessionId`, and why it ended: `gate`, `exited-no-gate` or `error`;
- **what it cost** — input, output, reasoning-output, cache-read and
  cache-creation tokens, total cost, assistant turns and tool calls. Codex reports
  no subscription dollar cost, so Codex cost stays **null**. Any field the
  provider did not carry is null, never a plausible zero;
- **how hard the work was** — files changed, insertions and deletions in that
  segment's commits (read-only git), whether it touched `supabase/migrations/**`,
  the issue's labels, and the stage range. This is here so quality can be read
  against difficulty: without it, the hardest issues make the best model look
  worst;
- **quality, so far as it is known** — how many times that gate had already been
  attempted when this run stopped at it.

**The later signals are joined at read time, not written back.** Whether a gate
passed first time, the rework rounds that land days afterwards, whether CI went
red — none are known when a run ends, and writing them in later would mean
rewriting an append-only file. So the table joins the log against the live gate
history, the review rounds and one read-only `gh pr list` when you open it. A
signal that cannot be read is left out rather than defaulted: an issue with no PR
contributes nothing to the rework rate, which is a different answer from zero.

**The table is under Settings**, because it is about how the machine is
configured. Each aggregate cell is scoped by provider, model and segment, lists
the profiles and provider session ids in it, and keeps reasoning output as its own
median — so two providers with the same model string, or two different profile
histories, are never silently collapsed.

**The Overview answers the one question the table cannot: can you decide yet?**
One sentence — *"Not yet — all 14 runs so far are under Opus 5, and one model
cannot be compared with itself"*, or *"There is enough to compare now: gate C has
7 Opus 5 / 6 Sonnet 5"* — with what would change the answer underneath it. **The
criterion most easily missed is the first**: each provider's default tends to be
the only model in its runs until you deliberately pick another, and no amount of
waiting makes a single-model log comparable. The card names the way out — pick a
different model on a couple of issues, and the other side starts to exist.

What a decision would compare, per segment: **cost** (tokens, duration) against
**quality** (rounds of gate feedback, first-time-approval rate, rework rounds, CI
red), read against how much code that segment touched, so that difficulty does not
masquerade as model quality.

**It is a background job, not a page that computes.** The snapshot is built at
start and every `METRICS_REFRESH_HOURS` (default 24), persisted with the time it
was computed — so a restart shows the last answer immediately, always carrying its
own age. **Recompute now** runs it on demand. A failed refresh keeps the last good
figures and says the refresh failed; it never shows a stale answer dressed up as a
fresh one.

**What it will not do.** No rankings, no trend arrows, no "recommended model", and
deliberately **no automatic router**. Every figure carries the number of runs
behind it, and any cell under five runs is marked and called out as unable to
support a routing decision. With `MAX_ACTIVE` at 2, n stays small for a long
while: a difference between two small cells is not a finding, it is two small
cells. The router waits for the data, because building it now would mean guessing
the answer and then measuring against the guess.

## Porting this to a new project

Almost everything here is repo-agnostic. These are the parts that are not.

**Set these before you start.** The console warns at startup for each one that is
missing, and the views that need it stay empty rather than showing you somebody
else's work:

| Setting | What it is | Unset means |
|---|---|---|
| `REPO` | the tracker repo, `owner/name` | no issues are polled |
| `REPO_PATH` | the checkout worktrees are cut from | no worktree can be created |
| `ASSIGNEE` | the GitHub login whose queue this is | nothing is adopted |
| `BOARD_PROJECT_NUMBER` | the org project number in the board's own URL | the board is off — no card is read, none is moved |
| `EDGE_CONTAINER` | the Supabase edge runtime to measure and offer to restart | an example name that is probably not yours |

**Then these, which are code or convention rather than configuration:**

- The worktree script and the port registry — 8080 for the primary checkout,
  8081 upwards for worktrees, two reserved.
- The board's lane names. The console's lifecycle order is `Backlog`, `Planned`,
  `Ready`, `In progress`, `In review`, `QA`, `Done`, and it writes only the middle
  two.
- The `issue-pipeline` skill, and the gate-file contract it writes.
- The review layer's expectations — which workflow reviews a PR, what a panel
  verdict looks like, and whether a `changes-requested` label is in play.
- The QA verdict wording the console parses on the issue.
- The priority labels: `p0`–`p3` and `icebox`. Both sides keep their own copy of
  that axis (`orchestrator/src/summary.ts`, `ui/src/priority.ts`) because they
  share no code, so rename one and you must rename both.

The manual travels with it: copying the console to another project carries
`docs/INFO.md` along, and this section is the list of paragraphs to rewrite.

## Labelling an issue you file yourself

`gh issue create` does **not** go through an issue form, so it bypasses any
workflow that turns form answers into labels, and it lands carrying whatever you
passed and nothing else. Pass your team's axes explicitly.

**One team's example, for shape.** Every issue says three things there, and a bug
says four:

| | Pick one | Whose call |
|---|---|---|
| Priority | `p0` `p1` `p2` `p3` `icebox` | You or triage |
| Type | `bug` `feature` `tech-debt` `chore` `docs` `spike` `epic` `runbook` | You |
| Area | one `area:*` | You |
| Environment | one `env:*` — **required on bugs** | You |

**The priority row is the one the console reads**, and only those five names: they
set the dispatch band and the priority pill. The other three rows are your team's,
and the console neither reads nor requires them.

**Priority is not required and should not be guessed** — leave it off and triage
will set it. An issue with no priority is correctly labelled, not unfinished; the
console reads it as untriaged and the pill says `needs triage`.

The assignee and board lane are set for you only if your team automates that and
your login is on its allowlist; filed by anyone else, the issue stays unassigned.
That is why the console lists issues you **raised** as well as issues you were
assigned.

**A worker's drafted issue** works the same way: it is filed as you, from this
machine, and comes back into your queue marked `self-filed`. If it also has no
priority, nobody outside this laptop has agreed it is worth doing — which is
exactly what the two chips together are telling you.
