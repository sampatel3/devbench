# Vendored Console Standard packages

The console's UI renders on Console Standard, a design system that ships as two
npm packages. Vendoring the packed artifacts keeps a fresh clone buildable:
`npm install` resolves both from this directory, so you need neither registry
access nor a sibling working tree to build the UI.

| Package | Version | SHA-256 |
|---|---|---|
| `@sampatel3/console-tokens` | `0.1.0-next.0` | `9c3223d1d908767b516ddfb688c3948f134d6c4e56323d561e9a30a9b151a89f` |
| `@sampatel3/console-ui` | `0.1.0-next.0` | `21acb65508ff72e60a70a7bbdf8b5d8c245bbea4d354a81dce3482fc753701b6` |

To check a tarball against the table, run:

```sh
shasum -a 256 vendor/console-standard/*.tgz
```

## What these tarballs no longer carry

Console Standard has a per-product theme layer: each consuming application gets
an accent palette selected by the `data-cs-product` attribute. The upstream
packages carried five such themes, four of them for applications unrelated to
this console. Those four are pruned here, leaving `worker` — the product key
`ui/src/main.tsx` passes to `ConsoleRoot`, and the one that
`ui/src/console-standard-adapter.css` writes rules against.

The palettes live in more than one generated file, so the prune touches each:

- `dist/products/*.css` in `@sampatel3/console-tokens`, now `worker.css` alone.
- The `cs.product` layer of `dist/styles.css`, which inlines the same palettes
  and is the copy the browser actually loads.
- The `products` export in `dist/index.js`, and its duplicate in
  `dist/manifest.json`.
- The `ConsoleProduct` union in the type declarations of both packages, now
  `"worker"`.
- The matching `./products/*.css` subpath exports in `package.json`, which would
  otherwise point at files that are gone.

Two `package.json` descriptions are reworded, and nothing else changes.
`LICENSE`, each package's own `README.md`, and every remaining `dist/` file are
untouched, and both packages are repacked with `npm pack`, so what you get is an
ordinary npm tarball.

Because these are repacked, the hashes above are not the upstream publisher's.
They fix the contents of this directory; they are not a provenance claim, and a
future upstream release will not reproduce them.

## Replacing this directory

Vendoring is an integration bridge, not the distribution model. Once the
packages are published, depend on an immutable registry release instead. Don't
swap it for a `file:` dependency on a sibling checkout — that builds on one
machine and fails on every fresh clone.

If you do replace a tarball in place, update `package-lock.json` in the same
commit. The lockfile pins each archive by `integrity` hash, and npm serves a
cached copy when that hash still matches, so a stale entry either installs the
old package behind your back or fails `npm ci` outright.
