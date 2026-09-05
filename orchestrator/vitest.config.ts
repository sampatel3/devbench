import { defineConfig } from 'vitest/config';

/**
 * The worker cap is not a tuning knob — it is the second half of the fix for the
 * crash on 2026-08-11.
 *
 * Vitest's fork pool defaults to the core count, the same fan-out shape as bare
 * jest, and "agent sessions running this repo's own suite" was one of the three
 * things running when a 16 GB machine went down at ~40 GB of pressure. Two
 * workers is what `WORKER_HEADROOM_GB` already budgets for one console worker,
 * and this suite is node-env and far lighter per worker than a jsdom one.
 *
 * Measured on this machine (10 cores), full suite, 611 tests: **6.9 s at eight
 * workers, 13.3 s at two.** Six and a half seconds, and the fan-out that costs
 * it is the same shape as the one that took the machine down. Observed with
 * `ps`: exactly two `node (vitest N)` forks, never more.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The one thing every test in this suite must be true of: it does not talk
    // to GitHub. See the file — it is a guard, not a convenience.
    setupFiles: ['test/setup/no-github.ts'],
    environment: 'node',
    testTimeout: 20_000,
    maxWorkers: 2,
    minWorkers: 1,
  },
});
