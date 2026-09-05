import type { GateLetter } from './types.js';

/**
 * Is CI green? — a field, because a paragraph could not be trusted.
 *
 * At Gate E on 2026-08-13 a worker wrote that 27 checks were green and then, in
 * its closing sentence, that the `CI Success` rollup had not been emitted yet.
 * Stage 7's rule — *"a handover that does not say CI is green is a handover of an
 * unknown"* — was satisfied by the paragraph and contradicted by it at the same
 * time. Nothing in the console could tell, because CI only existed as prose.
 *
 * The design decision that follows: **a worker reports what it saw; it does not
 * get to declare the verdict.** `state: "green"` is a claim, and this checks it
 * against the two things that actually decide it — did the rollup land, and is
 * anything still outstanding. Every path that is not provably green comes out
 * `unconfirmed`, which the card says loudly. There is no path from a bad input
 * to `green`.
 */
export type CiState = 'green' | 'red' | 'unconfirmed';

export type GateCi = {
  state: CiState;
  /** The `CI Success` rollup's own verdict, verbatim. Null = never emitted. */
  rollup: string | null;
  /** Checks the worker knows have not reported yet. */
  outstanding: string[];
  /** How many checks it saw pass, if it counted. Never evidence on its own —
   *  27 of them were green in the run that caused this. */
  passed: number | null;
  /** One line for the card, in the operator's terms. Loud when it is not green. */
  note: string;
};

const FAILING = /\b(fail|failure|failing|error|cancelled|canceled|timed[_ -]?out)\b/i;
const PASSING = /\b(success|succeeded|passed|green|completed)\b/i;

const unconfirmed = (note: string, rollup: string | null, outstanding: string[], passed: number | null): GateCi => ({
  state: 'unconfirmed',
  rollup,
  outstanding,
  passed,
  note,
});

/**
 * @param value the raw `ci` field from `.gate.json`, whatever it turned out to be.
 * @param gate  which gate is being handed over.
 * @returns null only when CI is not yet the question AND nothing was reported.
 *          At Gate E it is NEVER null: silence is a finding, not an absence.
 */
export function parseGateCi(value: unknown, gate: GateLetter): GateCi | null {
  if (value === undefined || value === null) {
    if (gate !== 'E') return null;
    return unconfirmed(
      'the worker did not say whether CI is green — a handover that does not say CI is green is a handover of an unknown',
      null,
      [],
      null,
    );
  }

  if (typeof value !== 'object') {
    return unconfirmed(`CI was reported as \`${String(value)}\`, which says nothing checkable`, null, [], null);
  }

  const r = value as Record<string, unknown>;
  const rollup = typeof r.rollup === 'string' && r.rollup.trim() !== '' ? r.rollup.trim() : null;
  const passed = typeof r.passed === 'number' ? r.passed : null;

  // A malformed `outstanding` is itself a reason not to trust the claim, so it
  // is kept as unknown rather than quietly read as "nothing outstanding".
  const outstandingOk = r.outstanding === undefined || Array.isArray(r.outstanding);
  const outstanding = Array.isArray(r.outstanding)
    ? r.outstanding.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    : [];

  const claimed = typeof r.state === 'string' ? r.state.trim().toLowerCase() : '';

  // A rollup that reads as a failure decides it, whatever the worker claimed.
  if (rollup && FAILING.test(rollup)) {
    return {
      state: 'red',
      rollup,
      outstanding,
      passed,
      note: `CI is RED — the rollup says \`${rollup}\``,
    };
  }

  if (claimed === 'red') {
    return {
      state: 'red',
      rollup,
      outstanding,
      passed,
      note: outstanding.length
        ? `CI is RED — failing: ${outstanding.join(', ')}`
        : 'CI is RED',
    };
  }

  if (claimed === 'green') {
    if (!outstandingOk) {
      return unconfirmed('CI was reported green, but the list of outstanding checks was unreadable', rollup, [], passed);
    }
    if (outstanding.length) {
      return unconfirmed(
        `CI was reported green, but these checks have not reported: ${outstanding.join(', ')}`,
        rollup,
        outstanding,
        passed,
      );
    }
    if (!rollup) {
      return unconfirmed(
        'CI was reported green, but the `CI Success` rollup has not been emitted — green checks are not a green rollup',
        null,
        [],
        passed,
      );
    }
    if (!PASSING.test(rollup)) {
      return unconfirmed(`CI was reported green, but the rollup reads \`${rollup}\``, rollup, outstanding, passed);
    }
    return {
      state: 'green',
      rollup,
      outstanding: [],
      passed,
      note: `CI is green — ${rollup}`,
    };
  }

  if (claimed === 'unconfirmed') {
    return unconfirmed(
      outstanding.length
        ? `CI is unconfirmed — still waiting on: ${outstanding.join(', ')}`
        : 'CI is unconfirmed — the worker could not confirm it',
      rollup,
      outstanding,
      passed,
    );
  }

  return unconfirmed(
    `CI state \`${typeof r.state === 'string' ? r.state : '(missing)'}\` is not one of green / red / unconfirmed`,
    rollup,
    outstanding,
    passed,
  );
}
