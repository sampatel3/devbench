/**
 * BOTH LEGS ON EVERY STEP, and the one step that is allowed to show no before.
 *
 * The rule: an after shot and a before shot are both required, unless there is
 * genuinely no before to show — a brand new feature, for instance. Until this
 * existed the console only noticed a gate with NO screenshots at all: a
 * nine-step script where step 3 came back with an after and no before went
 * green, and the tick the operator put on it was a tick on their own memory of
 * what the app used to do.
 *
 * The rule lives twice — `orchestrator/src/manual-qa.ts` for the server's
 * refusal, `ui/src/gate-c.ts` for the button's label — because the two halves of
 * this console share no code. One table drives both, so a rule that drifts fails
 * here rather than in front of the operator.
 */
import { describe, it, expect } from 'vitest';
import { missingShots, missingShotsLine, parseManualQa } from '../src/manual-qa.js';
import {
  acceptedLine,
  approveLockC,
  gateWarnings,
  missingShots as uiMissingShots,
  missingShotsLine as uiMissingShotsLine,
  toAccept,
} from '../../ui/src/gate-c.js';
import { askForMissingShotsPrompt, EVIDENCE_REMINDER } from '../../ui/src/gate.js';
import type { QaProgress } from '../../ui/src/types.js';

const QA = 'docs/issue-pipeline/plans/qa-4404';

/** Steps as a worker actually writes them, through the real parser. */
const steps = (...raw: Array<Record<string, unknown>>) =>
  parseManualQa({ appUrl: 'http://localhost:8106', steps: raw })!.steps;

/**
 * The same steps after the SCAN has stamped them — `goneShots` is the scan's
 * field, not the gate file's, so it is applied here rather than written into the
 * raw object. `worktrees.ts` stat's both legs of every step on every poll; this
 * is that answer, by step id.
 */
const scanned = (
  gone: Record<number, Array<'before' | 'after'>>,
  ...raw: Array<Record<string, unknown>>
) => steps(...raw).map((step) => ({ ...step, goneShots: gone[step.id] ?? [] }));

const both = (id: number) => ({
  id,
  rev: 1,
  do: `Do thing ${id}`,
  before: 'it did nothing',
  beforeShot: `${QA}/s${id}-before.png`,
  after: 'it asks first',
  afterShot: `${QA}/s${id}-after.png`,
});

const table = [
  {
    what: 'a complete step is not missing anything',
    given: [both(1)],
    want: [],
  },
  {
    what: 'genuinely new behaviour — the null PAIR is the statement, and it passes',
    given: [{ ...both(1), before: null, beforeShot: null }],
    want: [],
  },
  {
    what: 'a step that says what it used to do and shows no picture of it',
    given: [{ ...both(1), beforeShot: null }],
    want: [{ id: 1, legs: ['before'] }],
  },
  {
    what: 'a missing after, which has no exception at all',
    given: [{ ...both(1), afterShot: null }],
    want: [{ id: 1, legs: ['after'] }],
  },
  {
    what: 'a step with neither leg — both are named, in order',
    given: [{ ...both(1), beforeShot: null, afterShot: null }],
    want: [{ id: 1, legs: ['before', 'after'] }],
  },
  {
    what: 'new behaviour still owes its after',
    given: [{ ...both(1), before: null, beforeShot: null, afterShot: null }],
    want: [{ id: 1, legs: ['after'] }],
  },
  {
    what: 'only the short steps are named, by their own ids',
    given: [both(1), { ...both(2), afterShot: null }, both(3), { ...both(4), beforeShot: null }],
    want: [
      { id: 2, legs: ['after'] },
      { id: 4, legs: ['before'] },
    ],
  },
  {
    what: 'a shot the parser refused (outside the plans root) counts as missing',
    given: [{ ...both(1), afterShot: '../../.ssh/id_rsa' }],
    want: [{ id: 1, legs: ['after'] }],
  },
];

/**
 * THE SECOND TABLE: a path with nothing behind it.
 *
 * The case that slipped through everything. A step declaring
 * `"afterShot": "qa-5505/after-3.png"` and never writing the file satisfied the
 * table above completely — a path was given — so no warning was raised, Approve
 * stayed open, and the card rendered the browser's own broken-image icon with no
 * words near it — and asking for each missing screenshot by hand, over and over,
 * is not a gate working.
 *
 * The console had the answer the whole time: `worktrees.ts` stat's both legs on
 * every poll and wrote `:gone` into a fingerprint used only to reset a tick.
 * `gone` is that fact, kept.
 */
const goneTable = [
  {
    what: 'a step whose AFTER capture is not on disk, though it named one',
    gone: { 1: ['after' as const] },
    given: [both(1)],
    want: [{ id: 1, legs: ['after'], gone: ['after'] }],
  },
  {
    what: 'a step whose BEFORE capture is not on disk',
    gone: { 1: ['before' as const] },
    given: [both(1)],
    want: [{ id: 1, legs: ['before'], gone: ['before'] }],
  },
  {
    what: 'a step that named two captures and wrote neither',
    gone: { 1: ['before' as const, 'after' as const] },
    given: [both(1)],
    want: [{ id: 1, legs: ['before', 'after'], gone: ['before', 'after'] }],
  },
  {
    what: 'genuinely new behaviour still passes when its after IS on disk',
    gone: {},
    given: [{ ...both(1), before: null, beforeShot: null }],
    want: [],
  },
  {
    what: 'genuinely new behaviour still owes an after that is not there',
    gone: { 1: ['after' as const] },
    given: [{ ...both(1), before: null, beforeShot: null }],
    want: [{ id: 1, legs: ['after'], gone: ['after'] }],
  },
  {
    what: 'a missing path and an absent file on the same step are both named, in leg order',
    gone: { 1: ['after' as const] },
    given: [{ ...both(1), beforeShot: null }],
    want: [{ id: 1, legs: ['before', 'after'], gone: ['after'] }],
  },
  {
    what: 'only the steps whose files are gone are named',
    gone: { 2: ['after' as const] },
    given: [both(1), both(2), both(3)],
    want: [{ id: 2, legs: ['after'], gone: ['after'] }],
  },
  {
    what: 'a step the scan found whole is not accused',
    gone: { 1: [] },
    given: [both(1)],
    want: [],
  },
];

describe('which steps came back without the pictures they owe', () => {
  for (const row of table) {
    it(row.what, () => {
      expect(missingShots(steps(...row.given))).toEqual(row.want);
    });
  }

  it('is the same rule on both sides of the console', () => {
    for (const row of table) {
      // The UI type and the server type are structurally the same step; the
      // point of the assertion is that the two implementations agree.
      expect(uiMissingShots(steps(...row.given))).toEqual(missingShots(steps(...row.given)));
    }
  });

  for (const row of goneTable) {
    it(row.what, () => {
      expect(missingShots(scanned(row.gone, ...row.given))).toEqual(row.want);
    });
  }

  it('is the same rule on both sides for an absent file too', () => {
    for (const row of goneTable) {
      const st = scanned(row.gone, ...row.given);
      expect(uiMissingShots(st)).toEqual(missingShots(st));
    }
  });

  it('accuses nobody when no scan has stamped the step', () => {
    // An older `qaSnapshots` entry, or a unit test with no worktree behind it:
    // `goneShots` is simply absent. The console must not report a file missing
    // on the strength of one it never looked for — the same rule handover.ts
    // keeps, that an unread field is never a verdict in either direction.
    const st = steps(both(1));
    expect(st[0]!.goneShots).toBeUndefined();
    expect(missingShots(st)).toEqual([]);
    expect(uiMissingShots(st)).toEqual([]);
  });

  it('is the SCAN’s field — a worker cannot write itself an alibi', () => {
    // `goneShots` decides whether the gate raises a warning against the worker,
    // so a gate file claiming its own captures are fine would be the worker
    // marking its own homework. The parser reads the nine instruction fields and
    // nothing else, which is the same wall the verdict-shaped keys hit.
    const st = steps({ ...both(1), goneShots: [] });
    expect(st[0]!.goneShots).toBeUndefined();
  });

  it('says the same sentence on both sides', () => {
    const one = [{ id: 3, legs: ['after' as const] }];
    const two = [
      { id: 3, legs: ['after' as const] },
      { id: 5, legs: ['before' as const, 'after' as const] },
    ];
    expect(missingShotsLine(one)).toBe('step 3 is missing its "after" screenshot');
    expect(missingShotsLine([{ id: 3, legs: ['before', 'after'] }])).toBe(
      'step 3 is missing its before and after screenshots',
    );
    expect(missingShotsLine(two)).toBe('2 steps are missing screenshots (3, 5)');
    expect(missingShotsLine([])).toBe('');
    for (const m of [one, two]) expect(uiMissingShotsLine(m)).toBe(missingShotsLine(m));
  });
});

const progress = (total: number, verified: number): QaProgress => ({
  total,
  verified,
  failed: 0,
  unset: total - verified,
  complete: total > 0 && verified === total,
});

const lock = (over: Partial<Parameters<typeof approveLockC>[0]> = {}) =>
  approveLockC({
    progress: progress(6, 6),
    failedIds: [],
    hasQuiz: true,
    quizSubmitted: true,
    typed: false,
    ...over,
  });

const warn = (over: Partial<Parameters<typeof gateWarnings>[0]> = {}) =>
  gateWarnings({
    missingShots: [],
    violation: null,
    droppedSteps: 0,
    droppedQuestions: 0,
    codeSinceQa: null,
    leftUnanswered: [],
    ...over,
  });

describe('a step short of a capture is a warning the operator has to take by hand', () => {
  /**
   * Not a lock. *"i don't think you need the degraded gate, but a warning will
   * suffice ... and i have to explicitly approve the gate"* — so the console's
   * duty is that it cannot be missed and that taking it is deliberate, not that
   * the gate becomes unpassable. A hard lock turned an honest report of a failed
   * capture into a gate nobody could pass.
   */
  it('is raised as the OPERATOR’s call, with the send-back attached', () => {
    const w = warn({ missingShots: [{ id: 3, legs: ['after'] }] });
    expect(w).toHaveLength(1);
    expect(w[0]!.level).toBe('accept');
    expect(w[0]!.title).toBe('Step 3 is missing screenshot evidence');
    expect(w[0]!.detail).toContain('step 3 (after)');
    expect(w[0]!.ask).toBe('shots');
  });

  it('names an absent FILE as its own defect, not as a missing field', () => {
    // The remedy differs, so the words have to. A worker told to "add the
    // missing screenshot" reads its own gate file, sees the path it wrote, and
    // has every reason to think it complied — which is how the same empty box
    // comes back round after round.
    const w = warn({ missingShots: [{ id: 3, legs: ['after'], gone: ['after'] }] });
    expect(w).toHaveLength(1);
    expect(w[0]!.level).toBe('accept');
    expect(w[0]!.detail).toContain('NAMED its "after" capture');
    expect(w[0]!.detail).toContain('not in the worktree');
  });

  it('raises a NEW warning when a missing path becomes an absent file', () => {
    // The acceptance tick is keyed on the warning, so a materially different
    // warning must not inherit it: the operator accepted "the worker did not give
    // which is not the same statement as "the worker gave a path to nothing".
    const path = warn({ missingShots: [{ id: 3, legs: ['after'] }] })[0]!.key;
    const file = warn({ missingShots: [{ id: 3, legs: ['after'], gone: ['after'] }] })[0]!.key;
    expect(file).not.toBe(path);
    // ...and an ordinary missing shot keeps exactly the key it always had, so
    // nothing already accepted resets on the way in.
    expect(path).toBe('missing-shots:3/after');
  });

  it('tells the worker the FILE is the defect, and not to just write the path again', () => {
    const said = askForMissingShotsPrompt([{ id: 3, legs: ['after'], gone: ['after'] }]);
    expect(said).toContain('NAMED a capture that is not in the worktree');
    expect(said).toContain('Do not simply write the path again');
    expect(said).toContain('Check each one exists on disk before you stop');
    // The standing evidence rule still rides with it, as on every other ask.
    expect(said).toContain(EVIDENCE_REMINDER);
  });

  it('leaves the prompt alone when the fields are simply absent', () => {
    const said = askForMissingShotsPrompt([{ id: 3, legs: ['after'] }]);
    expect(said).not.toContain('not in the worktree');
    expect(said).toContain('step 3 ("afterShot")');
  });

  it('holds Approve until the operator ticks it, then opens and says so', () => {
    const w = warn({ missingShots: [{ id: 3, legs: ['after'] }] });
    expect(lock({ toAccept: toAccept(w), accepted: false })).toEqual({
      locked: true,
      label: 'Accept the warning above to approve',
    });
    expect(lock({ toAccept: toAccept(w), accepted: true })).toEqual({
      locked: false,
      label: 'Approve gate C — 1 warning accepted',
    });
  });

  it('counts them when there is more than one to take', () => {
    const w = warn({
      missingShots: [{ id: 3, legs: ['before'] }],
      codeSinceQa: { approvedAt: 'abcdef1234', headNow: '9876543210' },
    });
    expect(toAccept(w)).toHaveLength(2);
    expect(lock({ toAccept: toAccept(w), accepted: false }).label).toBe('Accept the 2 warnings above to approve');
    expect(lock({ toAccept: toAccept(w), accepted: true }).label).toBe('Approve gate C — 2 warnings accepted');
  });

  it('records what he accepted, so the history says the gate passed over it', () => {
    const w = warn({ missingShots: [{ id: 3, legs: ['before', 'after'] }] });
    expect(acceptedLine(w)).toBe(
      'Accepted with this warning outstanding, deliberately:\n- Step 3 is missing screenshot evidence',
    );
    expect(acceptedLine(warn())).toBe(''); // nothing outstanding, nothing claimed
  });

  it('never comes before something the operator has to go and DO', () => {
    const w = toAccept(warn({ missingShots: [{ id: 3, legs: ['after'] }] }));
    // An unticked step, a failed step and an unsubmitted quiz all outrank it:
    // the acceptance is the last thing between the operator and the button, not
    // the first thing they meet on the card.
    expect(lock({ toAccept: w, accepted: false, progress: progress(6, 5) }).label).toBe(
      'Verify 1 more step to approve',
    );
    expect(lock({ toAccept: w, accepted: false, failedIds: [2], progress: progress(6, 5) }).label).toMatch(
      /^Step 2 failed/,
    );
    expect(lock({ toAccept: w, accepted: false, quizSubmitted: false }).label).toBe('Submit the quiz to approve');
  });

  it('opens with no warning at all, exactly as it did before', () => {
    expect(lock({ toAccept: [], accepted: false }).locked).toBe(false);
    expect(lock().locked).toBe(false); // absent reads as none, for callers that predate it
  });
});

describe('the warnings a gate C card shows, in one list', () => {
  it('puts what the operator cannot clear first, and says which is which', () => {
    const w = warn({
      missingShots: [{ id: 3, legs: ['after'] }],
      violation: 'the rework came back without steps 2, 3.',
      droppedSteps: 1,
      droppedQuestions: 2,
      codeSinceQa: { approvedAt: 'abcdef1234', headNow: '9876543210' },
      leftUnanswered: ['is the empty state in scope?'],
    });
    expect(w.map((x) => x.level)).toEqual(['blocking', 'blocking', 'blocking', 'accept', 'accept', 'note']);
    expect(w.map((x) => x.key)).toEqual([
      'rework-violation',
      'dropped-steps',
      'dropped-questions',
      'missing-shots:3/after',
      'code-since-qa:9876543210',
      'left-unanswered',
    ]);
  });

  it('a blocking warning is not the operator’s to accept — the tick cannot clear it', () => {
    const w = warn({ violation: 'the rework dropped 2 screenshots.' });
    expect(toAccept(w)).toEqual([]);
    expect(lock({ violation: 'the rework dropped 2 screenshots.', toAccept: toAccept(w), accepted: true }).locked).toBe(
      true,
    );
  });

  it('the key changes when a new warning arrives, so a stale tick cannot carry', () => {
    const first = toAccept(warn({ missingShots: [{ id: 3, legs: ['after'] }] })).map((x) => x.key);
    const later = toAccept(warn({ missingShots: [{ id: 3, legs: ['before', 'after'] }] })).map((x) => x.key);
    expect(later).not.toEqual(first);
  });

  it('is empty on a clean gate', () => {
    expect(warn()).toEqual([]);
  });
});

describe('the message that goes back for the missing shots', () => {
  const out = askForMissingShotsPrompt([
    { id: 3, legs: ['after'] },
    { id: 5, legs: ['before', 'after'] },
  ]);

  it('names the exact steps and legs, so nine steps are not re-captured for two', () => {
    expect(out).toContain('step 3 ("afterShot")');
    expect(out).toContain('step 5 ("beforeShot" and "afterShot")');
    expect(out).toContain('do not re-run the whole QA');
    expect(out).toContain('never overwriting an existing capture');
  });

  it('carries the exception, so a new-feature step is answered honestly not faked', () => {
    expect(out).toContain('"before": null WITH "beforeShot": null');
    expect(out).toContain('New — nothing to compare');
  });

  it('is not an approval, and re-parks at the same gate', () => {
    expect(out).toContain('NOT an approval');
    expect(out.toLowerCase()).not.toContain('approved');
    expect(out).toContain('stop at gate C again');
  });

  it('ends with the standing evidence reminder, like every other gate C message', () => {
    expect(out.endsWith(EVIDENCE_REMINDER)).toBe(true);
  });
});
