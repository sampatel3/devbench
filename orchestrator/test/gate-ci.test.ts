import { describe, it, expect } from 'vitest';
import { parseGateCi } from '../src/ci.js';
import { parseGateFile } from '../src/state.js';

/**
 * At Gate E on 2026-08-13 a worker wrote a paragraph saying 27 checks were green
 * and then, in its last sentence, that the `CI Success` rollup had not actually
 * been emitted yet. Stage 7's own rule is that "a handover that does not say CI
 * is green is a handover of an unknown" — and prose satisfied that rule while
 * saying the opposite.
 *
 * So CI stops being a sentence and becomes a field. The parser is deliberately
 * suspicious: a worker does not get to ASSERT green, it reports what it saw and
 * the console decides what that adds up to. Every path that is not provably
 * green resolves to `unconfirmed`, which the card says loudly.
 */
describe('CI at a gate is a field, not a paragraph', () => {
  it('is UNCONFIRMED at Gate E when the worker said nothing at all', () => {
    const ci = parseGateCi(undefined, 'E');
    expect(ci).not.toBeNull();
    expect(ci!.state).toBe('unconfirmed');
    expect(ci!.note).toMatch(/did not say/i);
  });

  it('refuses "green" while the rollup has not been emitted — the #4535 case, exactly', () => {
    const ci = parseGateCi(
      { state: 'green', rollup: null, outstanding: ['CI Success'], passed: 27 },
      'E',
    );
    expect(ci!.state).toBe('unconfirmed');
    // The card has to name what is missing, or this is prose again.
    expect(ci!.outstanding).toContain('CI Success');
    expect(ci!.note).toMatch(/CI Success/);
  });

  it('refuses "green" with checks still outstanding, however many passed', () => {
    const ci = parseGateCi({ state: 'green', rollup: 'SUCCESS', outstanding: ['e2e'] }, 'E');
    expect(ci!.state).toBe('unconfirmed');
    expect(ci!.note).toMatch(/e2e/);
  });

  it('refuses "green" when the rollup itself reads as a failure', () => {
    const ci = parseGateCi({ state: 'green', rollup: 'FAILURE', outstanding: [] }, 'E');
    expect(ci!.state).toBe('red');
  });

  it('accepts green only when the rollup landed and nothing is outstanding', () => {
    const ci = parseGateCi({ state: 'green', rollup: 'CI Success — SUCCESS', outstanding: [] }, 'E');
    expect(ci!.state).toBe('green');
    expect(ci!.rollup).toBe('CI Success — SUCCESS');
  });

  it('reports red as red, and keeps what failed', () => {
    const ci = parseGateCi({ state: 'red', rollup: 'FAILURE', outstanding: ['unit-tests'] }, 'E');
    expect(ci!.state).toBe('red');
    expect(ci!.outstanding).toEqual(['unit-tests']);
  });

  it('treats a state it does not recognise as unconfirmed, never as green', () => {
    expect(parseGateCi({ state: 'probably fine', rollup: 'x', outstanding: [] }, 'E')!.state).toBe('unconfirmed');
    expect(parseGateCi({ state: 'GREEN ISH', rollup: 'x', outstanding: [] }, 'E')!.state).toBe('unconfirmed');
  });

  it('is null before Gate E when nothing was reported — CI is not the question yet', () => {
    expect(parseGateCi(undefined, 'C')).toBeNull();
    expect(parseGateCi(undefined, 'A')).toBeNull();
  });

  it('still parses CI at an earlier gate when the worker did report it', () => {
    const ci = parseGateCi({ state: 'red', rollup: 'FAILURE', outstanding: ['lint'] }, 'D');
    expect(ci!.state).toBe('red');
  });

  it('survives rubbish in the field rather than throwing it away silently', () => {
    expect(parseGateCi('all good!', 'E')!.state).toBe('unconfirmed');
    expect(parseGateCi(42, 'E')!.state).toBe('unconfirmed');
    expect(parseGateCi({ state: 'green', outstanding: 'lots' }, 'E')!.state).toBe('unconfirmed');
  });
});

describe('the gate file carries it', () => {
  const base = { issue: 4336, gate: 'E', stage: 8, summary: 's', questions: [] };

  it('reads `ci` off .gate.json instead of dropping it on the floor', () => {
    const g = parseGateFile(
      JSON.stringify({ ...base, ci: { state: 'green', rollup: 'CI Success — SUCCESS', outstanding: [] } }),
    );
    expect(g!.ci).not.toBeNull();
    expect(g!.ci!.state).toBe('green');
  });

  it('stamps a Gate E with no `ci` as unconfirmed — silence is not green', () => {
    // Until now `parseGateFile` built its object field by field and unknown keys
    // vanished with no error, so a worker writing `ci` would have had it
    // discarded — and a worker writing nothing looked identical to one that
    // checked. Both now surface as unconfirmed.
    const g = parseGateFile(JSON.stringify(base));
    expect(g!.ci!.state).toBe('unconfirmed');
  });

  it('leaves an earlier gate alone', () => {
    const g = parseGateFile(JSON.stringify({ ...base, gate: 'B' }));
    expect(g!.ci).toBeNull();
  });
});
