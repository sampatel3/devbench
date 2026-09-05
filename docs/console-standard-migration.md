# The Console Standard design contract

The UI is built on Console Standard, a shared design system vendored into this
repo as two packed packages under `vendor/console-standard/`. `ui/index.html`
declares the product, theme and density attributes; `ui/src/console-standard-adapter.css`
maps the console's own class vocabulary onto the system's semantic roles. The
domain UI stays in `App.tsx`.

This file records what that layer commits to and the bar any change to it has to
clear. It is presentation-only by design: it must not change orchestration
behavior, API contracts, issue state, confirmation text, or the local-only runtime
boundary. The orchestrator serves the built UI on loopback; this is not a hosted
application, and nothing here is a step towards making it one.

## The contract

The console declares:

- product: `worker`;
- theme: `light`;
- density: `compact`;
- system sans-serif for operational UI and monospace for identifiers;
- neutral blue for selection;
- amber only when a person must act;
- green only for a worker that is currently running;
- red for failures and destructive actions;
- slate for held, paused, or unavailable states.

Selection and status remain independent. A selected row uses structure
(background and edge); its status remains a labelled semantic state. Conflating
the two is the mistake this rule exists to prevent — you cannot see which row you
picked and what is happening to it if one colour has to carry both.

## Acceptance gates

Any change to the design layer is accepted only when all of the following are
true:

1. The existing orchestrator suite remains green.
2. The UI builds from the exact packed Console Standard packages, with lockfile
   and installed integrities matching the vendored archives.
3. Sanitized visual tests cover 1440, 1024, 768, 390, and 320 pixels.
4. The page has no root-level horizontal overflow at 320 pixels; intentionally
   wide tables scroll inside a labelled region.
5. The primary keyboard path has visible focus and remains operable.
6. Selected, running, waiting, UAT, paused, held, failed, and completed states are
   understandable without colour.
7. No API, DTO, persistence, worker, or server route changes ride along in a
   design change.
8. The previous build stays available as a local rollback target until the new one
   passes smoke testing.

The deterministic UI fixture and the baseline screenshots the visual tests compare
against contain no real tickets, accounts, paths, credentials, or worker output.
Keep it that way: a fixture is the one place a real ticket can reach a committed
file without anyone noticing.

## Running the checks

```bash
cd ui && npm run test:baseline           # Playwright, five viewport widths
cd ui && npm run test:baseline:update    # after an intentional visual change
cd orchestrator && npx vitest run        # gate 1
```

A production dependency audit is expected to report zero vulnerabilities.
Development-only Vite/Vitest/esbuild advisories that need a breaking toolchain
upgrade are documented rather than silently carried: no affected development
server or test fixture is deployed.
