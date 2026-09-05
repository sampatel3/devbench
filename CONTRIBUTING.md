# Contributing

Thank you for wanting to work on this. The console is small on purpose, and the
bar is less about volume than about a change explaining itself.

## Layout

Two npm workspaces:

- `orchestrator/` — the Node server. It polls the tracker, spawns and watches
  workers, owns the state files, and serves the API.
- `ui/` — the React single-page app the console serves from `ui/dist`.

Supporting directories: `docs/` (the manual served at `GET /api/info`),
`scripts/` (the two vetted shell scripts the console is allowed to run), and
`vendor/` (the packed design-system tarballs the UI depends on).

## Build

```bash
npm ci
npm run build
```

`npm run build` builds the UI first and the orchestrator second. The running
console serves `ui/dist`, so restart it after a build: a page loaded after a
rebuild is a new UI talking to an older API, and buttons quietly do nothing. The
build-id banner catches it, but rebuilding and restarting together avoids it.

While you work, `npm run dev` compiles the orchestrator and runs it, and
`npm run dev -w ui` serves the UI from Vite.

## Test

```bash
npm test                                  # the whole orchestrator suite
cd orchestrator && npx vitest run test/config.test.ts   # one file
```

Type-check each workspace:

```bash
cd orchestrator && npx tsc -p tsconfig.json --noEmit
cd ui && npx tsc -p tsconfig.json --noEmit
```

The UI also has a Playwright baseline that renders the app against fixtures and
compares screenshots:

```bash
npm run test:ui-baseline                  # from the repo root
npm run test:baseline:update -w ui        # after a deliberate visual change
```

Update the snapshots only when you meant to change what the page looks like, and
say so in the commit message. A silently refreshed baseline is a regression test
that has stopped testing.

Run the tests that cover what you touched before you open a PR, and the whole
suite before you ask for a review.

## How to write code here

**Comments explain why, not what.** The code already says what it does. A header
comment earns its place by recording the reason the code is shaped this way: the
failure it prevents, the alternative that was tried and did not work, the
constraint that is not visible from the call site. Most of the comments in this
repository are load-bearing in that sense, and several describe real incidents.
Match that. If you delete a comment, be sure you are deleting a stale reason and
not the only record of one.

**Tests accompany changes.** A behaviour change comes with the test that fails
without it. A bug fix comes with the test that reproduces the bug. Tests live in
`orchestrator/test/`, named after the module or the behaviour they cover, and
they redirect `STATE_FILE` so that nothing writes into the real state, run log or
ledger.

**Keep the fences intact.** Several rules are enforced in code rather than by
convention, and a test guards each one: the tracker module exports no writer, the
one comment path refuses any other verb, worktree creation only ever creates,
only an edge-runtime container may be restarted, only an attributable process may
be signalled, and the server binds loopback. If a change needs to cross one of
those lines, say so explicitly in the PR rather than widening the fence quietly.

**Surgical diffs.** Change what the issue asks for. Do not reformat adjacent
code, do not rename things in passing, and match the surrounding style even where
you would have chosen differently.

**Defaults never guess.** A setting that points at somebody's repository, board
or container has no default. Unset means off, or means a clear failure message
naming what to set — never a plausible value the operator does not notice.

## Prose

The console's own writing — gate summaries, drafted comments, PR bodies, the
manual — is plain, second person, present tense. Documentation changes follow the
same voice. Say what a thing does and what it costs; leave out the adjectives.

## Pull requests

Describe what changed for a user first, then why, then what you did not run. Link
the issue. Keep one PR to one change.

By contributing you agree that your contribution is licensed under the Apache
License 2.0, the same as the rest of the project.
