import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * WHEN the decision runs, which is the half that broke.
 *
 * #5555 had supercharge on, had already had gate A passed automatically by the
 * same code, then parked at gate B and sat there. The operator saw the only thing
 * on offer: a supercharged run still asking for gate B approval. Nothing was
 * wrong with `decideSupercharge` — `supercharge.test.ts` covers that, and it had
 * just driven #5558 through A, B, a gate C send-back for two missing
 * screenshots, C, and a stop at D. What was wrong was that the verdict was
 * reached from `#scans` inside `poll()`, and:
 *
 *   - `poll()` returns immediately when a poll is already running, so the
 *     `poll()` the exit handler fires to "pick up .gate.json" is a no-op on a
 *     busy console — and then nothing decided the gate until the fifteen-minute
 *     timer came round.
 *   - `#scans` is shared with the watcher and generation-guarded, so even a poll
 *     that does run can leave the gate unseen for a cycle.
 *
 * A unit test cannot easily stage that interleaving, so these assertions hold
 * the wiring instead: read the file, and be called from the exit path.
 */
const SRC = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');

/** The method body, brace-matched — a fixed window stops covering the tail the
 *  moment the method grows, which is a test that checks less than it claims. */
function autoDecideBody(): string {
  const start = SRC.indexOf('async #autoDecideSuperchargedGates()');
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

describe('the supercharged decision is reached from the disk, not from the scan', () => {
  const body = autoDecideBody();

  it('has a body to check at all', () => {
    expect(body).not.toBe('');
  });

  it('reads the gate file itself', () => {
    expect(body).toContain('GATE_FILE');
    expect(body).toContain('readGateFile(scan.path)');
  });

  it('decides on the letter it just read, never on the scan`s copy', () => {
    // The bug in one line: `scan.gate.gate` here is a letter that may be a
    // cycle old, or absent while the file is on disk.
    expect(body).not.toContain('scan.gate.gate');
    expect(body).toContain('gate: live.gate');
  });

  it('keys the once-per-round guard to the bytes it read', () => {
    expect(body).toContain('roundKey');
    expect(body).not.toContain('lastGateHash === scan.gateHash');
  });

  it('still makes gate C wait for the scan, because the evidence stamps come from it', () => {
    // `stampShots` runs in the scan, so a fresh-bytes verdict with stale stamps
    // could send work back for a capture that is sitting right there.
    expect(body).toContain("live.gate === 'C'");
    expect(body).toContain('gateHashOf(raw)');
  });

  it('leaves a gate file that does not parse alone', () => {
    expect(body).toContain('if (!live) continue;');
  });
});

describe('it runs when a worker settles, not only inside a poll', () => {
  it('is called from the run-settled handler, right after the poll it cannot rely on', () => {
    const settled = SRC.indexOf('pick up .gate.json and any state file the worker wrote');
    expect(settled).toBeGreaterThan(-1);
    const after = SRC.slice(settled, settled + 900);
    expect(after).toContain('await this.#autoDecideSuperchargedGates();');
  });

  it('is still called from the poll as well — a gate that appeared while the console was down', () => {
    const inPoll = SRC.indexOf('await this.#applyBoardMoves();');
    expect(inPoll).toBeGreaterThan(-1);
    expect(SRC.slice(inPoll, inPoll + 700)).toContain('await this.#autoDecideSuperchargedGates();');
  });

  it('poll() really does bail when one is in flight — the premise of all of the above', () => {
    // If this ever stops being true the exit-path call becomes belt-and-braces
    // rather than the fix, and this test should be the thing that says so.
    const poll = SRC.indexOf('async poll(');
    expect(SRC.slice(poll, poll + 200)).toContain('if (this.#polling) return false;');
  });
});

/**
 * A held pass is still the console's, not the operator's.
 *
 * With two slots and four supercharged issues, most passes arrive at capacity
 * and are held in `pendingResume` for `#dispatch` to replay — and `#dispatch` is
 * the only party that writes the ledger line for them. It had no way of knowing
 * the console had composed those words, so every pass that WAITED was recorded
 * as one they made: the exact confusion `by: 'supercharge'` exists to prevent, and
 * #5402's lesson in the other direction.
 */
describe('a supercharged pass keeps its authorship through a hold', () => {
  it('marks the hold, beside the send-back mark it is modelled on', () => {
    expect(SRC).toContain('superchargeResumes: Record<string, true>;');
    expect(SRC).toContain("if (by === 'supercharge') this.#persisted.superchargeResumes[key] = true;");
  });

  it('passes `by` into the hold from both hold sites', () => {
    expect(SRC).toContain('initialHold, sentBack, opts.by)');
    expect(SRC).toContain('delayedHold, sentBack, opts.by)');
  });

  it('reads the mark back at dispatch, before it is consumed', () => {
    const at = SRC.indexOf('const heldWasSupercharge');
    expect(at).toBeGreaterThan(-1);
    const consumed = SRC.indexOf('delete this.#persisted.superchargeResumes[key];');
    expect(consumed).toBeGreaterThan(-1);
    // The read has to come before any consumption in the dispatch path.
    const resumeCall = SRC.indexOf('fromDispatch: true,', at);
    expect(resumeCall).toBeGreaterThan(at);
    expect(SRC.slice(resumeCall, resumeCall + 300)).toContain("by: 'supercharge'");
  });
});
