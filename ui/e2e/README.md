# Deterministic UI baseline

This suite renders the current Worker Console UI against a typed, sanitised
fixture. It replaces the event stream in the browser and intercepts every
`/api/*` request, so it never reads a real ticket, account, path, credential, or
evidence file.

The maximum-contract fixture covers UAT return, gate, running, paused, waiting,
held, failed, completed, and unstarted work. The suite also walks every primary view,
checks both dense tables, loading/error/empty/confirmation states, a native
confirmation dialog, keyboard operation, and root overflow at 1440, 1024, 768,
390, and 320 pixels. Before each visual comparison it scans the rendered text,
field values, and external destinations for production identifiers or paths.

Run the checked-in baseline from the repository root:

```sh
npm run test:ui-baseline
```

Only update the images after reviewing an intentional UI change at all five
widths:

```sh
npm run test:baseline:update -w ui
```
