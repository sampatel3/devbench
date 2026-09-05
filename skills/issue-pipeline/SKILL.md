---
name: issue-pipeline
description: Work one tracker issue end to end (assigned → merged → closed) under the console's five manual gates, stopping at each one for the operator's own QA and understanding. Use when starting, resuming, or closing out an issue the console dispatched. Invoke as /issue-pipeline <issue-number>, or /issue-pipeline <issue-number> resume to pick up mid-flight.
---

# issue-pipeline — one issue, start to finish

Work exactly one issue through ten stages (0–9). Five of those stages end at a
**gate**: a stop where the operator, a person, decides whether the work goes on.
**Never pass a gate on your own, and never read silence, a task notification, or
a question as approval.** A gate passes when a later message from the operator
says so in words.

This skill is the **contract with the console**, not a description of any one
team's process. Everything here is parsed by code in `orchestrator/src`
(`state.ts`, `manual-qa.ts`, `quiz.ts`, `history.ts`, `drafts.ts`, `comment.ts`)
and enforced by `orchestrator/hooks/write-fence.mjs`. Where this file and those
parsers ever disagree, the parsers win and this file is a bug.

The exact JSON shapes live in
[references/stop-files.md](references/stop-files.md); Gate C's two formats live
in [references/gate-c.md](references/gate-c.md). Read each once, the first time
you write one.

## The console is watching files, not prose

You run headless, detached, in a git worktree of the repo. Nobody reads your
terminal. The console polls the worktree and builds the operator's card out of
the files you write there, so **a stop nobody can see is a stop that did not
happen**.

Four environment variables arrive with you, and each means something:

- `WORKER_ISSUE` — the issue number you are working. One worker, one issue.
- `WORKER_SESSION_ID` — the console's own id for this run. It is the `sessionId`
  in every file you write. Never invent one; write `null` when it is unset.
- `WORKER_DECISIONS_FILE` — the console's append-only ledger of what the operator
  decided. Read-only for you, and the write fence reads it to check Gate D.
- `WORKER_PROVIDER` — which agent runtime you are.

## The stages, and which gate closes which

| Stage | What it is | Ends at |
| --- | --- | --- |
| 0 | Preflight: read the issue, the worktree, the branch, the tracker card | — |
| 1 | Scope: what this issue is and is not | **Gate A** |
| 2 | Plan: how you intend to do it, and what you will not touch | **Gate B** |
| 3 | Build | — |
| 4 | Validate: your OWN QA first, with the evidence captured | — |
| 5 | The operator's QA and understanding | **Gate C** |
| 6 | Pre-PR: the diff, the PR body, the branch | **Gate D** |
| 7 | PR and review rounds | — |
| 8 | Merge | **Gate E** |
| 9 | Post-merge: hand off, close out (merge ≠ done) | — |

**`.gate.json`'s `stage` is the stage the gate CLOSES**, and the console
hard-codes the table: **A→1, B→2, C→5, D→6, E→8.** It is not "the last stage I
finished", which is one lower and makes the console's spine disagree with its own
card. A Gate B re-stop from the middle of Stage 3 is still `"stage": 2`: Stage 2's
gate is the one you are reopening.

## `.issue-state.md` — the two lines a machine reads

Keep `.issue-state.md` in the worktree root current: stage reached, gates passed,
dev-server port, branch, open questions. On `resume`, read it first and continue
from what it says.

Two of its lines are parsed (`parseIssueState` in `state.ts`), and the parser
takes the FIRST match of each:

- `**Stage reached**: <n>`
- `**Gates passed**: <letters>` — a letter whose own text says `awaiting`,
  `pending`, `not yet`, `outstanding`, or `todo` does not count as passed.

**Rewrite both in place at the end of every stage.** Appending a new `## Stage N`
section and leaving the headers alone is the observed failure: the header goes
stale, a resumed worker restarts from a stage it finished two days ago, and the
console reports a gate as open that the operator has already decided.

`**Dev-server port**: <port>` and `` **Branch**: `<name>` `` are read too, so keep
them honest. The literal string `STOPPED AT GATE <letter>` is the only prose the
console reads as a recorded stop — "awaiting Gate E" is prose about what comes
next, not a stop.

## How a gate stop works

1. Finish the stage's work.
2. Write `.gate.json` to the worktree root — **the last thing you do**.
3. **Exit.** A parked worker is not a running process. Do not idle, do not poll
   for a reply, do not open a prompt and wait.

`.gate.json` is validated by `parseGateFile`. A file it cannot trust is treated
as no file at all, and a worker that exits with no gate file reads as finished
rather than parked — so get `issue` and `gate` right before anything else, and
write the file atomically enough that a half-written one is never observed.

## What comes back, and which of the three it is

Every resume arrives as a message. Read the FIRST line before you do anything: it
tells you which of these three you are in.

**A decision.** The operator's own words, passing the gate or sending the work
back. This is the only thing that passes a gate. Approval is explicit; anything
you have to interpret is not approval.

**An ask** — the message opens `GATE <x> QUESTION — NOT A DECISION`. The operator
is asking BEFORE deciding, and the gate is still open. Answer each question in
plain English, then rewrite `.gate.json` exactly as it was — same `issue`, same
`gate` letter, same `stage`, `sessionId`, `summary`, `questions`, `evidence`,
`manualQa`, and `quiz` — plus a top-level `thread` array carrying the prior
exchange verbatim and one new entry per question. Carry every QA step forward
with the SAME `id` and the SAME `rev`: those two numbers are what the operator's
per-step ticks hang on. Then stop again, at the same gate. **Do not append to
`.gate-history.jsonl`** — this round is not decided yet.

**A targeted rework** (Gate C only). The operator ran your click-script and ticked
one or more steps as failed. Fix only what they named, re-capture only that
step's evidence, carry everything else forward byte for byte, and stop at Gate C
again. The full procedure is in [references/gate-c.md](references/gate-c.md).

In all three cases: answering, fixing, and rewriting the gate file are not
passing the gate. Only the operator's explicit words do that.

## On resume, before anything else

**Append the decided gate to `.gate-history.jsonl`, then clear the request files.**

One JSON object per line, append-only, never rewritten: the whole `.gate.json`
you had written, plus `decision` (the operator's exact words that unblocked it —
the resume prompt verbatim) and `resumedAt`. If the file does not exist, this
line creates it. A line the parser cannot read is skipped, so a torn line costs
one round of history rather than all of it.

**The console deletes `.gate.json` when it resumes you**, so the object you append
is the one you wrote, from your own context — not a file you can re-read. Write
what you actually know. Never reconstruct a `sessionId` or a `stoppedAt` by
guessing: an audit trail of invented timestamps is worse than a gap, because
nothing on the card says which fields were remembered.

Delete `.comment-request.json`, `.issue-request.json`, and `.board-request.json`
at the same point if you wrote one. They belong to you and nothing else removes
them, so a stale draft goes on offering the operator an action about work that is
already done.

## You draft; the operator acts

Three files, each a thing the operator does with one click or does not do at all.
Writing one is **never** a substitute for stopping, and never permission to act.

**`.comment-request.json`** — one real decision only a named person can make, or a
required workflow handoff. You never run `gh issue comment`: commenting on an
issue is not sanctioned at any stage, for any reason.

A decision request marks a real product decision, not a heads-up. Before you write
one, prove the issue, the code, the history, and the current review state do not
already answer it. If the implementation choice is clear, implied, conventional,
or cheap to reverse, decide it, implement it, and record the disposition in the PR
body. Do not ask somebody to confirm an answer you already have. A reviewer
finding with a clear fix is work: fix it and document it on the PR.

A decision request uses `kind: "decision"`, names an issue or a PR in `target`,
and carries exactly one direct `question` plus at most one short `context` line.
The console builds the posted comment from those fields, so a `draftBody`, a
numbered list, or a review transcript in a decision request is ignored or
refused. It always has `blocks: true`: if nobody has to answer, there is no
decision to request. A merge/review decision belongs on the PR; a product
requirement belongs on the issue. Never duplicate it on both.

**An old hold is evidence, not automatically a live question.** Read what happened
after it — later comments, assignment, board moves, the current review state. If
those events released the work and the issue already decides the behaviour,
proceed and record that chronology in the PR. Ask only when the hold is still
operative and a named person must actually decide something.

**`.issue-request.json`** — a related finding that needs a fold-or-separate
decision. The file carries your recommendation; it does not pre-decide that the
finding is a separate issue. Folding into the issue you are on is the default.
You never run `gh issue create`.

**`.board-request.json`** — a tracker lane you believe is wrong. Read the card
first; if it is already right there is nothing to draft. A lane request never
blocks you.

Say each draft in the gate summary or the handover too. The file is the action
surface, not a substitute for explaining the round.

**Before you write `.issue-request.json` or `.board-request.json`, add its name to
`.git/info/exclude`.** The gate files are excluded already; these two are not, so
they are the only ones git will happily stage — and one `git add -A` puts a draft
issue body about work you decided not to do into your branch and into the PR
diff. Stage what you changed by name.

## Hard rules — every stage, no exceptions

- **You are read-only on GitHub, apart from your own pull request.** The write
  fence (`orchestrator/hooks/write-fence.mjs`) is a PreToolUse hook that DENIES
  everything else — including through `gh api`, `curl`, a nested shell, an alias,
  or a nested agent. It outranks any permission mode you were launched with. A
  denial is not an invitation to find another spelling: draft the artefact it
  names and stop.
- **Never open the PR before Gate D is approved.** Gate D's whole subject is the
  PR being raised, and the fence checks the console's decision ledger before it
  allows `gh pr create`. Stop at Gate D — write `.gate.json` and exit — rather
  than opening it. The fence also refuses `--repo` and requires the integration
  base branch its allowlist names, so read the allowlist rather than guessing.
- **Never push anything but your own branch.** No force push, no delete, no push
  at a protected branch, never `--no-verify`, and never amend a published commit.
- **Never start another coding agent**, and never signal a process you did not
  start. Ports, containers, and databases are shared with every other worker on
  this machine: a reset destroys another session's fixtures mid-QA. If you
  believe shared state is genuinely wrong, that is a gate stop with the evidence,
  not a command you run.
- **Write prose files with Write and Edit, never through a shell interpreter.**
  No `python3 - <<'PY'`, no `node -e`, no `sed -i`, no `cat > file <<EOF`. The
  reason is not style: the fence reads any program handed to an interpreter,
  because that is the classic way to launder a forbidden command past a scanner,
  and it cannot tell a string literal from a statement. The moment your prose
  quotes one of these rules, the fence sees the forbidden phrase inside a program
  and refuses. The refusal is the fence working; the wasted turn is avoidable.
- **Never fake evidence.** A screenshot you did not take, a check you did not
  run, and a CI verdict you did not see are the three things that make every gate
  after them worthless. If a capture will not run, say which step, which leg,
  what you ran, and the exact error, in one `Limits:` bullet — the operator is
  deciding whether to accept it.
- **Report what you saw; do not declare the verdict.** `ci.state` is your
  observation. The console re-derives green from the rollup and the outstanding
  checks, holds its own read of the same PR, and overrules a `green` that either
  contradicts — out loud, on the card.

## Making this skill fit your repo

Nothing above depends on one team's conventions, but four things do and each has
one place to set it:

- **The evidence root.** Every path you write in `evidence`, `beforeShot`, and
  `afterShot` is repo-relative and must sit under the console's evidence root —
  `docs/issue-pipeline/plans/` unless your console changes `EVIDENCE_ROOT` in
  `orchestrator/src/evidence.ts`. Anything else is refused at manifest time and
  again at serve time, so it renders as nothing at all. Put this issue's captures
  in `<evidence-root>/qa-<issue>/`.
- **The base branch and the PR allowlist** — `orchestrator/hooks/write-fence.mjs`.
- **The tracker lanes** the console will show you — `LANES` in
  `orchestrator/src/drafts.ts`. A lane your board does not have reads as "could
  not tell".
- **Branch naming, ports, and the local stack** — your repo's own conventions.
  Add them to this file's fork, under the hard rules, and keep them enforced
  somewhere a rule alone cannot be ignored.
