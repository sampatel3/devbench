import { describe, it, expect } from 'vitest';
import { decideSupercharge, evidenceShortfall, MAX_AUTO_ROUNDS } from '../src/supercharge.js';
import type { ManualQaStep } from '../src/manual-qa.js';

/**
 * A supercharged run passes its own gates up to D. The only tests worth having
 * are the ones about where it STOPS: at gate D always, and at gate C whenever
 * the captures are not really there.
 *
 * The operator's rule: the evidence is the one thing that really matters, so it
 * has to be there at gate C.
 */
const step = (over: Partial<ManualQaStep> = {}): ManualQaStep =>
  ({
    id: 1,
    rev: 1,
    what: 'open the page',
    url: null,
    before: 'the old total',
    beforeShot: 'docs/issue-pipeline/plans/qa-1/before-1.png',
    after: 'the new total',
    afterShot: 'docs/issue-pipeline/plans/qa-1/after-1.png',
    fixed: null,
    goneShots: [],
    ...over,
  }) as ManualQaStep;

const complete = { steps: [step()], qaDropped: 0, evidenceCount: 2 };

describe('where a supercharged run stops', () => {
  it('stops at gate D — raising the PR is their approval to give', () => {
    const out = decideSupercharge({ issue: 1, gate: 'D', ...complete, autoRounds: 0 });
    expect(out.act).toBe('stop');
    if (out.act === 'stop') expect(out.why).toContain('gate D');
  });

  it('stops at gate E — the hand-over is never automatic', () => {
    expect(decideSupercharge({ issue: 1, gate: 'E', ...complete, autoRounds: 0 }).act).toBe('stop');
  });

  it('does nothing when no gate is open', () => {
    expect(decideSupercharge({ issue: 1, gate: null, ...complete, autoRounds: 0 }).act).toBe('nothing');
  });

  it('refuses to guess at a letter it does not know', () => {
    expect(decideSupercharge({ issue: 1, gate: 'Z', ...complete, autoRounds: 0 }).act).toBe('stop');
  });
});

describe('the plan gates', () => {
  it('passes A and B, and says in the resume that nobody read the plan', () => {
    for (const gate of ['A', 'B']) {
      const out = decideSupercharge({ issue: 42, gate, ...complete, autoRounds: 0 });
      expect(out.act).toBe('pass');
      if (out.act === 'pass') {
        expect(out.message).toContain('It is not a review');
        expect(out.message).toContain('gate D');
      }
    }
  });
});

describe('gate C — the evidence rule', () => {
  it('passes when every step has both legs, the files are there and the gate lists them', () => {
    const out = decideSupercharge({ issue: 42, gate: 'C', ...complete, autoRounds: 0 });
    expect(out.act).toBe('pass');
    // The approval has to say what it is worth: complete, not judged.
    if (out.act === 'pass') expect(out.message).toContain('WHAT WAS NOT CHECKED');
  });

  it('sends back a step missing its after shot', () => {
    const out = decideSupercharge({
      issue: 42,
      gate: 'C',
      steps: [step({ afterShot: null })],
      qaDropped: 0,
      evidenceCount: 2,
      autoRounds: 0,
    });
    expect(out.act).toBe('send-back');
    if (out.act === 'send-back') {
      expect(out.why).toContain('after');
      expect(out.message).toContain('NOT an approval');
    }
  });

  it('sends back a step that names a prior state and shows no picture of it', () => {
    const out = decideSupercharge({
      issue: 42,
      gate: 'C',
      steps: [step({ beforeShot: null })],
      qaDropped: 0,
      evidenceCount: 2,
      autoRounds: 0,
    });
    expect(out.act).toBe('send-back');
  });

  it('accepts the one exception — genuinely new behaviour, declared as both nulls', () => {
    const out = decideSupercharge({
      issue: 42,
      gate: 'C',
      steps: [step({ before: null, beforeShot: null })],
      qaDropped: 0,
      evidenceCount: 1,
      autoRounds: 0,
    });
    expect(out.act).toBe('pass');
  });

  it('sends back a capture that is no longer a file, even though the path is there', () => {
    const out = decideSupercharge({
      issue: 42,
      gate: 'C',
      steps: [step({ goneShots: ['after'] })],
      qaDropped: 0,
      evidenceCount: 2,
      autoRounds: 0,
    });
    expect(out.act).toBe('send-back');
  });

  it('sends back a click-script that came back malformed', () => {
    const out = decideSupercharge({ issue: 42, gate: 'C', steps: [step()], qaDropped: 2, evidenceCount: 2, autoRounds: 0 });
    expect(out.act).toBe('send-back');
    if (out.act === 'send-back') expect(out.why).toContain('malformed');
  });

  it('sends back when there are no QA steps at all', () => {
    const out = decideSupercharge({ issue: 42, gate: 'C', steps: [], qaDropped: 0, evidenceCount: 0, autoRounds: 0 });
    expect(out.act).toBe('send-back');
    if (out.act === 'send-back') expect(out.why).toContain('no QA steps');
  });

  it('sends back complete captures that the gate file lists nowhere — the card would show none', () => {
    const out = decideSupercharge({ issue: 42, gate: 'C', steps: [step()], qaDropped: 0, evidenceCount: 0, autoRounds: 0 });
    expect(out.act).toBe('send-back');
    if (out.act === 'send-back') expect(out.why).toContain('evidence');
  });

  it('hands gate C to the operator once the automatic rounds are spent — it never loops', () => {
    const out = decideSupercharge({
      issue: 42,
      gate: 'C',
      steps: [step({ afterShot: null })],
      qaDropped: 0,
      evidenceCount: 2,
      autoRounds: MAX_AUTO_ROUNDS,
    });
    expect(out.act).toBe('stop');
    if (out.act === 'stop') {
      expect(out.why).toContain('automatic');
      expect(out.why).toContain('yours to decide');
    }
  });

  it('never passes gate C on a shortfall, at any round count', () => {
    for (const rounds of [0, 1, 2, 3, 99]) {
      const out = decideSupercharge({
        issue: 42,
        gate: 'C',
        steps: [step({ afterShot: null })],
        qaDropped: 0,
        evidenceCount: 2,
        autoRounds: rounds,
      });
      expect(out.act).not.toBe('pass');
    }
  });
});

describe('evidenceShortfall', () => {
  it('is null only when there is nothing missing', () => {
    expect(evidenceShortfall(complete)).toBeNull();
  });

  it('reports the script before the pictures — the order a person notices it in', () => {
    expect(evidenceShortfall({ steps: [], qaDropped: 0, evidenceCount: 0 })).toContain('no QA steps');
    expect(evidenceShortfall({ steps: [step({ afterShot: null })], qaDropped: 1, evidenceCount: 0 })).toContain(
      'malformed',
    );
  });
});
