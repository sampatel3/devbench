import { describe, it, expect } from 'vitest';
import { spunOffFrom } from '../src/parent.js';

/**
 * The operator asked which ticket a spin-off came out of. Three worker-drafted
 * spin-offs sit in their queue under their own name, indistinguishable from work
 * the team asked for.
 *
 * The bodies below are the shapes workers actually write.
 */
describe('which issue a spin-off came out of', () => {
  it('#4472 — "Spun off from #4404 during its Stage 2 sibling sweep."', () => {
    expect(spunOffFrom('Spun off from #4404 during its Stage 2 sibling sweep.')).toBe(4404);
  });

  it('#4562 — "Split out of #4344 (PR #4535), where this was found…"', () => {
    // Note the SECOND number is a PR. Taking the first match, not the first number.
    expect(spunOffFrom('Split out of #4344 (PR #4535), where this was found by the registry.')).toBe(4344);
  });

  it('#4405 — says nothing of the kind, so it says nothing', () => {
    // Its only issue reference is a DENIAL: "Pre-existing and affects all users —
    // not introduced by #4336." A guesser keyed on "first issue number in the
    // body" would record 4336 as the parent, which is the opposite of what the
    // author wrote. An honest null beats a plausible wrong parent, because this
    // number decides whether a ticket gets closed or worked.
    const body =
      '## Scope note\n\n**Pre-existing and affects all users** — not introduced by #4336. ' +
      'That fix only made the sysadmin path match the always-shipping non-sysadmin behaviour. ' +
      'Filed separately because this is a product decision and does not belong in the #4336 PR.';
    expect(spunOffFrom(body)).toBeNull();
  });

  it('reads the other phrasings a worker might reach for', () => {
    expect(spunOffFrom('Found in #4491 during the sweep.')).toBe(4491);
    expect(spunOffFrom('Discovered while working on #4329.')).toBe(4329);
    expect(spunOffFrom('Split off from #4200.')).toBe(4200);
  });

  it('handles an empty or missing body', () => {
    expect(spunOffFrom('')).toBeNull();
    expect(spunOffFrom(null)).toBeNull();
    expect(spunOffFrom(undefined)).toBeNull();
  });

  it('is not fooled by a bare mention', () => {
    expect(spunOffFrom('This is related to #4404 and also touches #4491.')).toBeNull();
  });
});
