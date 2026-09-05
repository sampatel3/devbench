# Gate C — the card formats

Gate C is the big one: the operator runs your QA by hand and answers your
comprehension quiz before deciding. This file carries the two formats its card is
built from — `manualQa` and `quiz` — plus the shape of Gate C's `summary` and the
procedure for a targeted rework. **SKILL.md carries the rules; nothing here
overrides one.**

Read it when you are actually writing `.gate.json` at Gate C: the first time you
stop there, and again on every re-stop.

## The evidence check — run it before EVERY stop at Gate C

Not once, at the top of the stage. Every time, as a checklist, immediately before
you write `.gate.json`: after an answered question, after a rework, after a
reopened gate.

1. **Every step carries both legs, and both are required.** `beforeShot` (what it
   did before this change) and `afterShot` (what it does now). One step, one tick,
   two pictures.
2. **The one free gap is a before leg that cannot exist** — genuinely new
   behaviour, nothing there to photograph — written as `"before": null` WITH
   `"beforeShot": null`. That pair IS the statement, and the card prints "New —
   nothing to compare". There is no equivalent for the after leg: it is the half
   that is always capturable, because the change is in front of you as you write.
   Any other gap raises a warning that names the step and the leg, and the
   operator cannot approve until they have read it and accepted it by hand.
   Costing them a decision is the point; do not spend one you could have captured.
3. **Every capture is listed in `evidence`**, with a caption. The card renders
   `evidence` and nothing else — a capture that is not in it is not displayed, and
   evidence that is not displayed does not count. List the files under
   `<evidence-root>/qa-<issue>/` and check them against the array.
4. **The prior `evidence` is carried forward complete and in order**, with new
   captures appended. Nothing removed, nothing overwritten, nothing deleted.

A path that names no file fails this check exactly like a missing path does: the
console stats both legs on every scan, and a step declaring a capture it never
wrote renders as the browser's broken-image icon under a tick that means nothing.

## `manualQa` — the click-script the operator runs and ticks

```json
"manualQa": {
  "appUrl": "http://localhost:8081",
  "login": { "email": "qa@example.com", "password": "<the documented local-dev password>" },
  "start": "Seed order #1234 in status Sent from the orders list",
  "steps": [
    {
      "id": 1,
      "rev": 1,
      "do": "Open the order and press Withdraw",
      "url": "http://localhost:8081/orders/1234",
      "before": "Withdraw did nothing",
      "beforeShot": "docs/issue-pipeline/plans/qa-4404/s1-before.png",
      "after": "A confirm dialog opens; the order moves to Withdrawn",
      "afterShot": "docs/issue-pipeline/plans/qa-4404/s1-after.png",
      "fix": null
    }
  ]
}
```

Field by field, with the rule that makes each one work:

- **`id`** — a positive integer, 1-based, assigned once and **never renumbered,
  never reused**, for the life of the issue. The operator's ticks are keyed on it.
  A new step takes the next unused number. Never shuffle, never close a gap: a
  duplicate id is moved by the console, and everything that moves loses its tick.
- **`rev`** — `1` on first write. Bump by **exactly 1** when, and only when, you
  have re-done that step in a targeted rework. Bumping clears the tick on that
  step and only that step. Bumping one you did not fix throws away verification
  the operator did by hand; leaving one unbumped on a step you DID fix leaves them
  looking at a stale screenshot under a green tick. Both are defects.
- **`do`** — the action, imperative, **one action**: one verb, one target. A step
  with no `do` is not a step: it is dropped, and the count of dropped steps locks
  the gate rather than passing quietly on the steps that survived. (The parser
  also reads `action` as a synonym; nothing else.)
- **`url`** — the deep link for this step, or `null` when the screen has no
  addressable URL (then put the exact button labels in `do`). **It must be
  `http`/`https` on `localhost`, `127.0.0.1`, or `::1`**, and it is the real port
  of the dev server YOU started in this worktree, still up when you stop. Anything
  else keeps its text and loses its link: the console will not hand a person a
  clickable link that a worker chose, so `appUrl` becomes `null` and the card says
  so.
- **`before` / `beforeShot`, `after` / `afterShot`** — **before and after are two
  halves of ONE step, never two steps.** One question, one tick, both states side
  by side. `before` is one line on what it used to do, `after` one line on what
  they should see now, and the shots are repo-relative paths under the evidence
  root — the same files you list in `evidence`. A path outside that root is
  dropped to `null`, which then reads as a missing capture.
- **`fix`** — `null` on rev 1. On a reworked step, one line: what you changed.
- **`start`** — the fixture state they begin from, and only when a record has to
  be seeded or found first. `null` otherwise. Never repeat the summary's `Start:`
  line here.
- **`login`** — the documented shared local-dev account, both fields or neither.
  The console renders it as copyable text and types it nowhere.
- **At least one step.** An empty `steps` array is not "nothing to check", it is a
  gate with no QA. A change with no UI still has steps: the command to run and
  what its output must say IS a step, with the transcript in `evidence`.
- **No `edgeCases` array.** It is legacy. Anything worth trying is a step with an
  id and a tick; an edge case with no tick is an edge case nobody ran.

**The verdict is the operator's, and no field of yours can carry it.** Only the
named fields above are read: `"verified": true`, `"status": "passed"`, or anything
else verdict-shaped is ignored on the way in. The tick lives in the console's own
state, where you cannot reach it. Do not try.

Inside a step, say the specific thing: exact URLs, exact labels, what "correct"
looks like against what it looked like before. Caveats and scope disclaimers are
banned from steps — doubt goes in `Limits:`, scope in `Confirmed:`, both in
`summary`.

## `quiz` — comprehension, multiple choice

Write the plain-English walkthrough of the whole diff first — per file: what
changed, why, what breaks if it is wrong, and what you are least sure about. That
goes in the report at `reportPath`, and the quiz is built on top of it.

```json
"quiz": {
  "brief": [
    "Withdraw now asks for confirmation before it changes the order",
    "A withdrawn order can no longer be accepted",
    "Withdrawing writes an audit row naming who did it"
  ],
  "questions": [
    {
      "context": "An order's status decides which buttons the customer sees. Withdrawn is terminal — nothing moves out of it.",
      "question": "What happens to a customer who had the order open when it was withdrawn?",
      "options": [
        { "text": "Accept stops working the next time the page loads", "why": "Right. Status is read on load, so the next render drops Accept and shows the withdrawn state — not an error." },
        { "text": "They can still accept it until they log out", "why": "No — that is the old behaviour and the bug this fixes. Step 1's before screenshot shows it happening." },
        { "text": "They get an email telling them it was withdrawn", "why": "No — nothing here sends mail. Notification is a separate surface this change does not touch." }
      ],
      "correct": 0
    }
  ]
}
```

The parser is strict where being lenient would teach the wrong thing:

- **`question` is required**, `options` must be an array of 2–4 items, and every
  option needs both `text` and `why`. **One malformed option voids the whole
  question**, because `correct` is an index: dropping option B silently renumbers
  the answer key under your feet and turns a typo into a confidently wrong lesson.
- **`correct` is an integer index into `options`** and must be in range. The
  console grades locally and instantly against it, with no round trip to you.
- **A voided question is invisible**, so the count of dropped questions leaves
  with the quiz and locks the card. The question most likely to be malformed is
  the honest-limits one — the one that says what this gate does not prove — and a
  silent drop is the worst shape that can take.
- **No usable question at all is not a passed half.** The card shows the missing
  quiz, the gate stays locked, and one click asks you for it.

How to write it:

- **`brief` is a handful of one-line bullets**: what the change DOES, in behaviour
  terms. It never repeats `summary` and it is never prose.
- **Three questions is right most of the time**: one on the behaviour that
  changed, one on the riskiest edge, one on the honest limit. Two is fine for a
  trivial issue. Never pad to a number.
- **Every question ships its own context.** It must be answerable from this card
  alone — `summary`, the QA steps, the evidence captions, and its own `context`.
  Gloss every term inline. If answering needs the diff, the question failed, not
  the reader.
- **Ask about consequences, never implementation.** Test: would the question
  survive a rewrite that keeps the behaviour identical? If so, it is trivia.
- **Exactly one defensibly correct answer.** If two could be argued, the question
  is broken — fix it or cut it. No joke options, no "all of the above", no "which
  is NOT", no near-identical pairs, and keep the lengths comparable so the right
  answer is never reliably the longest.
- **Write every wrong option as a real misunderstanding**, and let its `why` name
  that misunderstanding and point at the evidence on this card that refutes it.
  The `why` on options nobody picked teaches too. Never scold, never hedge.
- **Carry the quiz forward byte for byte on every re-stop**, except any question
  whose answer or reasoning your fix genuinely changed. The console keys a stored
  submission on the questions themselves, so regenerating the quiz asks the
  operator to sit the same exam twice for nothing.

The answer key ships to the page, deliberately: the quiz's authority over the gate
is SUBMITTED, never SCORED. A wrong answer blocks nothing, so peeking wins nothing
a wrong answer would have cost — and the file is in the operator's own worktree
anyway.

## Gate C's `summary` — labelled groups, not prose

At Gate C, `summary` is labelled groups of one-line bullets inside the one JSON
string, newline-separated, in this order and nothing else:

```
Did:       drove the app headlessly on 8081 as the local-dev admin account.
Confirmed: - Withdraw now asks before it changes the order
           - A withdrawn order can no longer be accepted
Limits:    - Customer-side view not driven — no customer fixture on this stack
Start:     Orders list, filtered to Sent.
```

- `Did:` one line. The port and the account are the load-bearing facts.
- `Confirmed:` one bullet per proven behaviour, each mapping to a QA step or a
  capture. A confirmation that maps to neither is not confirmed: prove it or cut
  it.
- `Limits:` one bullet each, only where something is genuinely unproven. No
  limits, omit the group — an empty `Limits:` is itself a claim.
- `Start:` where they begin. A seeding recipe goes in `manualQa.start` and not
  here; never write it twice.
- A bullet that needs a second sentence is hiding a QA step or an evidence
  caption. Move the sentence there rather than appending it.

The card is for running and deciding; the report at `reportPath` is for reading.
Anything that does not fit these groups belongs in the report.

## Targeted rework — the procedure

A failed step comes back as a rework prompt naming that step and quoting the
operator's words. It is not an approval and it is not a request to redo the gate:
re-running the whole QA over a one-step failure is a waste of tokens, time, and
the operator's attention, while the gate box must still hold the full evidence for
the whole issue.

1. **Fix only the named points.** A failing check first where one fits, then the
   fix. Touch nothing else.
2. **Re-capture only the failed step's evidence.** Same harness, same localhost
   port, same account, same fixture. Write a **new file** — `s4-after-rev2.png`,
   never overwriting `s4-after.png`. **Never delete or overwrite a capture:** the
   old one is the record of what the operator saw fail. If your capture script
   drives every step, run only its path for the failed step or write a one-step
   script; re-running the whole thing is the full QA wearing a different hat.
3. **Blast radius — run it, do not photograph it.** From the diff of your own fix,
   list every other QA step that exercises a file, route, or component the fix
   touched. Re-drive those and confirm each `after` still holds. No new
   screenshots: one `Confirmed:` bullet carries it. If one fails, that step joins
   the rework — fix it, re-capture its evidence, bump its rev, and run this check
   again from the new diff. "Do not redo the whole QA" never means "do not fix
   what you just broke".
4. **Rewrite `.gate.json` with everything else carried forward verbatim.** Same
   `issue`, `gate`, `stage`, `sessionId`, `questions`, `thread`, and `quiz`, and a
   FRESH `stoppedAt`. Same `evidence`, complete and in order, with the new
   captures appended and captioned. Same `manualQa`: same `appUrl`, `login`,
   `start`, and every step in the same order with the same ids and the same
   wording on the ones you did not fix. Only the fixed step changes — same `id`,
   `rev` bumped by exactly 1, `fix` set, `after` and `afterShot` pointing at the
   new capture.
5. **Edit only the summary bullets that stopped being true**, and add the
   blast-radius bullet.
6. **Stop at Gate C again.** Do not proceed, and do not touch the PR.

**Never, on a rework:** drop a step, renumber ids, reword a step already verified,
shorten `evidence`, delete or overwrite a capture, or bump a rev on a step you did
not fix. None of these is silent. The console snapshots the click-script and
fingerprints the bytes of every capture before the rework goes out, and names each
of these on the card in plain English — each one locking Approve until you put it
right. A step the console had to restore keeps its tick and still counts, so
shortening the script never shortens the QA.
