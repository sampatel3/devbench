# The stop files — exact shapes

The files you write to the worktree root, field by field. SKILL.md carries the
RULES — when you write each one, what it may never do, and what blocks a gate.
This file carries the SHAPES. If the two ever disagree, SKILL.md wins and this
file is wrong; if this file and the parsers in `orchestrator/src` disagree, the
parsers win and both are wrong.

Every parser here is deliberately tolerant: it never throws, and it drops what it
cannot trust rather than failing the whole file. That is a safety property for the
console, not a licence for you. **A field the parser drops is a field the operator
never sees**, and a gate card missing half its evidence still looks complete.

---

## `.gate.json` — every gate stop

```json
{
  "issue": 4336,
  "gate": "C",
  "stage": 5,
  "sessionId": "<$WORKER_SESSION_ID, or null>",
  "stoppedAt": "2026-08-10T21:14:03Z",
  "reportPath": "docs/issue-pipeline/plans/issue-4336-gate-c.md",
  "summary": "A STRING. One short paragraph everywhere except Gate C, where it is the labelled groups as newline-separated lines inside this one string.",
  "questions": [
    "each question self-contained, and only a decision the operator alone can make"
  ],
  "evidence": [
    { "kind": "screenshot", "path": "docs/issue-pipeline/plans/qa-4336/before.png", "caption": "Filter counts before the fix — the count is wrong" },
    { "kind": "transcript", "path": "docs/issue-pipeline/plans/qa-4336/red-transcripts.md", "caption": "Six guardrails, each red then green" }
  ],
  "manualQa": { "…GATE C ONLY, and mandatory there — shape in references/gate-c.md" },
  "quiz":     { "…GATE C ONLY, and mandatory there — shape in references/gate-c.md" },
  "ci": {
    "state": "green | red | unconfirmed",
    "rollup": "the CI rollup check's own verdict, verbatim — null if it was never emitted",
    "outstanding": ["names of checks that have not reported"],
    "passed": 27
  }
}
```

- **`issue` must be a number and `gate` must be one of `A`–`E`.** Miss either and
  the whole file parses as nothing: no card, no stop, and a worker that looks
  finished. Everything else degrades field by field.
- **`stage`** is the stage the gate CLOSES: A→1, B→2, C→5, D→6, E→8.
- **`sessionId`**: `$WORKER_SESSION_ID` if the environment sets it, else `null`.
- **`stoppedAt`**: UTC ISO 8601, and a FRESH one on every stop. It is a new stop,
  not the old one edited.
- **`reportPath`**: repo-relative, the fullest written artifact for this gate —
  the scope statement, the plan, the walkthrough. `null` when it lives only in
  the message. The console links it; `null` makes the card say so rather than
  passing off `.issue-state.md` as a walkthrough.
- **`summary` is a STRING at every gate**, never an object. Gate C's shape is in
  [gate-c.md](gate-c.md).
- **`questions`** is an array of strings. An empty array means "nothing to decide,
  just approve or don't". At Gate C, comprehension does NOT go here — it goes in
  `quiz`.
- **`manualQa` and `quiz` are Gate C only, and both are mandatory there.** A
  missing one blocks the gate. Neither is ever folded back into `summary`.
- **`ci` is mandatory at Gate E**, and worth including at Gate D once a PR is
  open. Omit it at Gate E and the console states, loudly, that CI was not
  confirmed: silence is a finding, not an absence.

### `ci`, and why it is a field rather than a sentence

`state` is what you SAW. The console re-derives the verdict:

- a `rollup` reading as a failure decides `red` whatever you claimed;
- `state: "green"` with a non-empty `outstanding`, an unreadable `outstanding`, a
  `null` rollup, or a rollup that does not read as passing all come out
  `unconfirmed`;
- **green checks are not a green rollup.** However many individual checks passed,
  a rollup that has not been emitted is not green.

There is no input that turns a bad report into `green`, so report honestly: an
`unconfirmed` you wrote yourself reads far better than a `green` the console
overrules on the card.

### `evidence` items

`{ "kind": "screenshot" | "transcript" | "sql" | "report", "path": "<repo-relative>", "caption": "<one line>" }`

- **`path` and `caption` are both required**, and an item missing either is
  dropped silently. A caption says what to NOTICE, not what the file is.
- **The path must sit under the evidence root** (`docs/issue-pipeline/plans/` by
  default; see `EVIDENCE_ROOT`). Absolute paths and `..` escapes are refused at
  manifest time and again when the file would be served, so they render as
  nothing rather than as a broken image.
- **The file extension decides how it renders, not `kind`.** `.png`, `.jpg`,
  `.gif`, and `.webp` draw inline; everything else is expandable text. `kind` is a
  label for the reader, and an unrecognised one reads as `report`.
- **The file must already exist.** List it after you have written it.
- An empty array is fine for a gate with no artifacts yet — usually A and B.

### `thread` — only when you are answering an ask

```json
"thread": [
  { "id": 1, "q": "<the operator's question, verbatim>", "a": "<your answer>", "at": "2026-08-11T09:02:00Z" }
]
```

`id` joins your answer to the question the console is holding, so an answer under
an id nobody asked is discarded and a paraphrased question changes nothing: the
console is authoritative for what was asked, your file for what you answered.
Answers are write-once — the first one stands. Carry prior entries forward
verbatim so the whole exchange lands in the history when the gate is decided.

### The `.gate-history.jsonl` line

One line per DECIDED round: the whole gate object, plus what unblocked it.

```json
{ "…every field from .gate.json…",
  "decision": "the operator's exact words that unblocked this gate — the resume prompt verbatim",
  "resumedAt": "2026-08-11T09:02:00Z" }
```

Append-only. Never rewrite a line, never re-order, never edit one. The console
re-validates each line with the same parser `.gate.json` uses, joins it to its own
provenance sidecar, and skips anything it cannot read — an audit log with a hole
in it beats one you cannot read at all.

---

## `.comment-request.json` — one decision, or one required handoff

### A product or policy decision

```json
{
  "issue": 4334,
  "kind": "decision",
  "target": { "kind": "pr", "number": 4368 },
  "addressee": "@reviewer-one",
  "blocks": true,
  "why": "one line — what cannot proceed until this person answers",
  "context": "one optional sentence carrying only the context needed to answer",
  "question": "One direct, plain-English question?",
  "sessionId": "<$WORKER_SESSION_ID or null>",
  "requestedAt": "2026-08-11T10:00:00Z"
}
```

The parser refuses the whole request unless every one of these holds, so a
decision that quietly fails to appear is one of them:

- `blocks` is exactly `true`. A decision that nobody has to answer is not one.
- `target` is present, `kind` is `issue` or `pr`, and `number` is a positive
  integer. `issue` is the work item that produced the request; `target` is where
  the comment is posted.
- `addressee` is non-empty — `@login` when you know it.
- `why` is one line, with no newline in it.
- `context`, if present, is one line.
- **`question` is one line, ends with `?`, and contains exactly one `?`.** Two
  questions in one string is two decisions wearing one number.

The console builds the posted comment from `addressee`, `context`, and
`question`; a `draftBody` in a decision request is ignored. What lands is
deliberately small:

```markdown
@reviewer-one — #4334 is still blocked on the production domain.

Which domain should password-reset links use?
```

No numbered findings, alternatives, review transcript, or technical appendix.
Those belong in the PR body.

### A required workflow handoff

```json
{
  "issue": 4334,
  "kind": "handoff",
  "target": { "kind": "issue", "number": 4334 },
  "addressee": "@qa-alice",
  "blocks": false,
  "why": "QA needs the ready-to-verify steps after merge",
  "draftBody": "The complete handoff, ready to post as-is.",
  "sessionId": "<$WORKER_SESSION_ID or null>",
  "requestedAt": "2026-08-11T10:00:00Z"
}
```

A handoff needs `target`, a non-empty `draftBody`, and `blocks` that is not
`true` — the payload itself is the point, and a handoff never pretends to wait
for a reply. The console posts your exact bytes on the operator's click, one
comment per click. It cannot edit, close, label, assign, or merge, and neither
can you.

---

## `.issue-request.json` — a fold-or-separate decision

```json
{
  "fromIssue": 4336,
  "title": "the issue title, as it should appear",
  "labels": ["bug", "area:rating"],
  "boardLane": "Ready",
  "identifiedHow": "one line — the failing test, trace, or observed behaviour that exposed this",
  "relationship": "one line — the mechanism, behaviour, surface, or dependency it shares with #4336",
  "recommendation": "fold",
  "recommendationWhy": "one line — why folding is safer or cheaper than filing separately",
  "draftBody": "The whole issue body, ready to file as-is: what is wrong, where (file:line), the evidence, what the fix likely involves.",
  "sessionId": "<$WORKER_SESSION_ID or null>",
  "requestedAt": "2026-08-13T10:00:00Z"
}
```

- **`title` and `draftBody` are both required.** Without either, there is no
  request and the card never appears.
- **This file records a decision, not a pre-decided spin-off.** `recommendation`
  is exactly `fold` or `separate`; anything else reads as no recommendation at
  all. "Out of scope" is not a reason to file separately.
- **`identifiedHow` names the evidence.** "Found while working" is not evidence.
- **`relationship` explains the link.** "Related" is not an explanation.
- **`boardLane` must be a lane your board actually has** (`LANES` in
  `drafts.ts`); anything else reads as unset.
- **`draftBody` is the whole issue, with no placeholders.** The console adds the
  `Spun off from #<fromIssue>` cross-reference and the structured context itself,
  to both filing paths, so do not write them twice.

The console renders this as a decision card and, if the operator chooses to file,
opens the tracker's own prefilled new-issue form. **The console still writes
nothing**: the operator submits it, there, as themselves.

---

## `.board-request.json` — a tracker lane

```json
{
  "issue": 4336,
  "lane": "In progress",
  "currentLane": "Ready",
  "why": "one line — starting work, or merged and automation did not move it",
  "sessionId": "<$WORKER_SESSION_ID or null>",
  "requestedAt": "2026-08-13T10:00:00Z"
}
```

- `issue` must be a number and `lane` must be non-empty; without both there is no
  request.
- **`currentLane` is what you actually read off the card**, not what you assume.
  If you could not read it, write `null` and say so in `why`. A guess on a board
  the operator reads at a glance is worse than an admission, and both this field
  and `lane` are display only: neither reaches the code that moves a card.
