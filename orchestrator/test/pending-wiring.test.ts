import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The wiring, not the functions.
 *
 * This codebase has already shipped a derivation that was correct, unit-tested,
 * and wired to the wrong variable: `reviewOutstanding` was fed `reviewBlock?.rounds`,
 * which is null in exactly the case the function exists for, so it was inert for
 * weeks while its own tests passed (see the comment at its call site).
 *
 * `openQuestion` is more exposed than that, because its only live example — the operator's
 * unanswered production-flag question on #4344 — was deleted from GitHub before
 * the wiring could be demonstrated against it. Nothing on the board exercises the
 * path today, so these assertions stand in for the run I could not do.
 */
const SRC = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');

/**
 * The whole `waiting({ ... })` argument, brace-matched rather than sliced to a
 * fixed width — a fixed window silently stops covering the tail of the call the
 * moment the call grows, which is a test that quietly checks less than it says.
 */
function waitingCall(): string {
  const start = SRC.indexOf('waiting({');
  if (start < 0) return '';
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  return SRC.slice(start);
}

describe('the pending card is wired to the values it claims to read', () => {
  it('fills the open-question map from the SAME payload the actions feed uses', () => {
    // Not a second GitHub call: the comments are already in `payload.issues` and
    // were being dropped. If this ever becomes its own fetch, it is a cost that
    // should be argued for, not one that appears by accident.
    expect(SRC).toContain('openQuestion(i.comments, this.#cfg.assignee)');
    expect(SRC).toMatch(/this\.#openQuestions = new Map\(/);
  });

  it('reads that map on the row, rather than recomputing it per render', () => {
    expect(SRC).toContain('openQuestion: this.#openQuestions.get(issue.number) ?? null');
  });

  it('feeds waiting() the review round HISTORY, not the block', () => {
    // The exact shape of the bug that shipped inert last time. `reviewBlock` is
    // null once the operator answers a round, which is precisely when the card must still
    // say the reviewer has not cleared it.
    const call = waitingCall();
    expect(call).toContain('reviewOutstanding(reviewHistory');
    expect(call).not.toContain('reviewOutstanding(reviewBlock');
  });

  it('feeds waiting() a real liveness value, so a running worker suppresses the card', () => {
    const call = waitingCall();
    expect(call).toContain('live: live !== null');
  });

  it('gives waiting() the handover verdict UNGATED', () => {
    // handover.why was previously only reachable through `row.gate?.gate === 'E'`,
    // which is null on every PR-open row — the reason the operator could see "PR open" and
    // nothing about who was holding it.
    const call = waitingCall();
    expect(call).toContain('handover: handoverBlock(');
    expect(call).not.toContain("gate?.gate === 'E'");
  });
});

describe('the facts moved off the badge strip and did not get duplicated', () => {
  const APP = readFileSync(new URL('../../ui/src/App.tsx', import.meta.url), 'utf8');

  it('no longer wedges the review line and checklist into the chip row', () => {
    // The exact chip-strip class, not any string containing it — `note warn-line`
    // is a paragraph on the gate card and is a different thing entirely.
    expect(APP).not.toMatch(/className="note warn"/);
    expect(APP).not.toContain('pre-merge done ·');
  });

  it('never collapses a list of real work into a count', () => {
    // "2 still open" told them a number and hid the two things they had to do.
    expect(APP).not.toContain('still open`');
  });

  it('mounts the card where the spine leaves off', () => {
    const spine = APP.indexOf('<Spine row={row}');
    const card = APP.indexOf('<PendingCard waiting=');
    expect(spine).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(spine);
    // Above the dev-server note and everything else that is plumbing.
    expect(card).toBeLessThan(APP.indexOf('The dev server for this worktree'));
  });
});
