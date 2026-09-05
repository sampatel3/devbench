import { describe, it, expect } from 'vitest';
import { blockedReason } from '../src/status.js';

/**
 * A `blocked` label has to reach the console as a blocked ROW with the reason on
 * it, the way a parked issue does. Without that, an operator running a lot of
 * tickets at once forgets which one is stuck and why, and asks again a week
 * later.
 *
 * #5674 is the case in full: the fix already existed on dev, there was no diff
 * to raise, and the worker said exactly that at gate E — while the row read
 * "checkpoint — stopped after stage 9", which is true and useless. The finding
 * was three files away in `.gate-history.jsonl`.
 */
const GATE_E =
  'Ready to hand over, and there is no pull request to hand over — which is the finding. ' +
  'Gates C and D skipped deliberately: no code change and no UI surface to QA, no diff to raise.';

describe('blockedReason', () => {
  it('is null without the label — this is not a guess about what looks stuck', () => {
    expect(blockedReason({ labels: ['bug', 'P1'], history: [{ gate: 'E', summary: GATE_E }] })).toBeNull();
    expect(blockedReason({})).toBeNull();
  });

  it('gives the worker`s own first sentence as the reason', () => {
    const said = blockedReason({ labels: ['blocked'], history: [{ gate: 'E', summary: GATE_E }] });
    expect(said).toBe(
      'blocked — Ready to hand over, and there is no pull request to hand over — which is the finding.',
    );
  });

  it('takes the LAST thing said, not the first', () => {
    const said = blockedReason({
      labels: ['blocked'],
      history: [
        { gate: 'A', summary: 'Scope looks right.' },
        { gate: 'E', summary: GATE_E },
      ],
    });
    expect(said).toContain('no pull request to hand over');
  });

  it('says so plainly when nothing has been written yet', () => {
    // "no WORKER has said why" was the old wording, and it stopped being the
    // whole truth once the person who applied the label could be read too.
    expect(blockedReason({ labels: ['blocked'], history: [] })).toBe(
      'labelled blocked on GitHub — nobody has said why yet',
    );
    expect(blockedReason({ labels: ['blocked'], history: [{ gate: 'A', summary: '   ' }] })).toBe(
      'labelled blocked on GitHub — nobody has said why yet',
    );
  });

  it('never returns a fragment: a very short first sentence takes the opening line instead', () => {
    const said = blockedReason({ labels: ['blocked'], history: [{ gate: 'E', summary: 'Done. The real reason is here and it is long enough to matter.' }] });
    expect(said).toContain('The real reason is here');
  });
});

/**
 * The half the console could not see. #5674 carried the worker's sentence above
 * while `dev-carol`, two seconds after applying the label, had written down the
 * actual blocker — as the label's own description in this repo requires:
 * "Cannot proceed on an external dependency. The comment must name what is being
 * waited on."
 *
 * The row said the issue was blocked and named nothing that would explain it.
 * The information was on GitHub the whole time.
 */
const BLOCK_NOTE =
  'Labelled `blocked`, same reason as #5673: `disposition-drain-queue` already carries ' +
  '`assertServiceRole` on `dev`, verified mechanically. **What remains is a promotion, ' +
  'not a code change.**\n\nUnblocks when the fix reaches `main`.';

describe('blockedReason prefers the person who applied the label', () => {
  it('says who said it, and what they said', () => {
    const said = blockedReason({
      labels: ['blocked'],
      history: [{ gate: 'E', summary: GATE_E }],
      blockedNote: { by: 'dev-carol', body: BLOCK_NOTE },
    });
    expect(said).toBe(
      'blocked, per @dev-carol — Labelled blocked, same reason as #5673: disposition-drain-queue ' +
        'already carries assertServiceRole on dev, verified mechanically.',
    );
    // The worker's account of itself is still true and still useless here.
    expect(said).not.toContain('no pull request to hand over');
  });

  it('strips markdown so a status line stays a status line, keeping the words', () => {
    const said = blockedReason({
      labels: ['blocked'],
      blockedNote: { by: 'dev-dave', body: '## Waiting on the `release/2026-09-02` cut. **Nothing to do here.**' },
    });
    expect(said).toBe('blocked, per @dev-dave — Waiting on the release/2026-09-02 cut.');
  });

  it('falls back to the worker when the labeller wrote nothing', () => {
    const said = blockedReason({
      labels: ['blocked'],
      history: [{ gate: 'E', summary: GATE_E }],
      blockedNote: { by: 'dev-carol', body: '   ' },
    });
    expect(said).toContain('no pull request to hand over');
  });

  it('still needs the label — a comment alone does not block anything', () => {
    expect(blockedReason({ labels: ['P1'], blockedNote: { by: 'dev-carol', body: BLOCK_NOTE } })).toBeNull();
  });
});
