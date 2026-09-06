/**
 * THE CONSOLE TAKING ITS OWN SCREENSHOTS.
 *
 * The operator asked for screenshots that are always there, always consistent,
 * and generated with no human intervention. Measured behind that ask: 32 of 53
 * gate C send-backs were bounces for a null shot leg while 744 PNGs sat on disk
 * across 71 worktrees, and ~48% of first gate C rounds arrived with nothing
 * wired at all.
 *
 * The runner drives a browser, so every test here injects a FAKE one. That is
 * not only for speed — it is what makes the fences testable at all. The two that
 * matter cannot be observed from outside a real Chromium:
 *
 *  - the URL it navigates to is built by the console from a port in its own
 *    registry, never from anything a worker wrote. The fake records every url it
 *    is handed, so an escape is an assertion rather than a hope.
 *  - the file it writes is under the plans root. The fake writes real bytes to
 *    the real path it is given, into a real temp worktree, so a path that
 *    escaped would escape here too.
 *
 * The stamp is a pure function and is tested as one; the identical-pair warning
 * and the failure lines are asserted through the whole runner, because their
 * whole value is that they reach the card.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  captureGateShots,
  captureUrl,
  drivableLegs,
  shotPath,
  stampCaptures,
  type BrowserDriver,
  type CaptureDeps,
  type Wrote,
} from '../src/capture.js';
import { parseManualQa, qaRoute, type ManualQaStep } from '../src/manual-qa.js';

const ISSUE = 4404;
const PLANS = 'docs/issue-pipeline/plans';
const PORT = 8093; // a worktree port, as instances.ts defines them
const BASELINE = 8080; // the primary checkout, named by the operator and never guessed

let worktree: string;

/** Every url the fake driver was asked for, in order. The port fence is only
 *  provable by looking at this. */
let visited: string[];
/** Files the fake wrote, so a path fence failure shows up as a real file in a
 *  real place rather than as a string comparison. */
let written: string[];

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'capture-'));
  visited = [];
  written = [];
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

/** A driver that writes deterministic bytes, one distinct picture per url. */
const fakeDriver = (opts: { bytes?: (url: string) => string; fail?: (url: string) => string | null } = {}): CaptureDeps['open'] => {
  const driver: BrowserDriver = {
    async shot({ url, file }) {
      visited.push(url);
      const why = opts.fail?.(url) ?? null;
      if (why !== null) throw new Error(why);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, opts.bytes?.(url) ?? `png-for-${url}`);
      written.push(file);
    },
    async close() {},
  };
  return async () => driver;
};

const deps = (
  open: CaptureDeps['open'],
  listens: (port: number) => Promise<boolean> = async () => true,
): CaptureDeps => ({ open, listens, now: () => new Date('2026-09-05T09:00:00.000Z') });

/** Write a `.gate.json` holding this click-script, and nothing else that matters. */
const gateFile = (steps: Array<Record<string, unknown>>, evidence: unknown[] = []) => {
  const gate = {
    issue: ISSUE,
    gate: 'C',
    stage: 5,
    sessionId: 'abc',
    stoppedAt: '2026-09-05T08:00:00.000Z',
    summary: 'Did: the thing',
    questions: [],
    evidence,
    manualQa: { appUrl: `http://localhost:${PORT}`, steps },
  };
  writeFileSync(join(worktree, '.gate.json'), JSON.stringify(gate, null, 2));
  return gate;
};

const readGate = () => JSON.parse(readFileSync(join(worktree, '.gate.json'), 'utf8')) as Record<string, unknown>;

/** One step, missing both captures and drivable. */
const step = (over: Record<string, unknown> = {}) => ({
  id: 1,
  rev: 1,
  do: 'Open the quote and press Withdraw',
  route: '/quotes/1234',
  before: 'Withdraw did nothing',
  beforeShot: null,
  after: 'The quote moves to Withdrawn',
  afterShot: null,
  ...over,
});

const run = (open: CaptureDeps['open'], over: Partial<Parameters<typeof captureGateShots>[0]> = {}, listens?: (p: number) => Promise<boolean>) =>
  captureGateShots(
    { issue: ISSUE, worktree, port: PORT, baselinePort: BASELINE, storageState: null, ...over },
    deps(open, listens),
  );

// ------------------------------------------------------------ the route fence

describe('qaRoute — what the console will accept as a screen to drive to', () => {
  it('keeps an ordinary app path, query and fragment included', () => {
    expect(qaRoute('/quotes/1234')).toBe('/quotes/1234');
    expect(qaRoute('/quotes?status=sent#tab')).toBe('/quotes?status=sent#tab');
  });

  it('REFUSES a protocol-relative path — it looks like a path and it is a host', () => {
    expect(qaRoute('//evil.example/x')).toBeNull();
  });

  it('REFUSES an absolute url, on any scheme', () => {
    expect(qaRoute('http://evil.example/x')).toBeNull();
    expect(qaRoute('https://localhost:8093/x')).toBeNull();
    expect(qaRoute('javascript:alert(1)')).toBeNull();
    expect(qaRoute('file:///etc/passwd')).toBeNull();
  });

  it('REFUSES a relative path — there is no current page to be relative to', () => {
    expect(qaRoute('quotes/1234')).toBeNull();
  });

  it('REFUSES a backslash, which browsers normalise into the authority', () => {
    expect(qaRoute('/\\evil.example')).toBeNull();
  });

  it('REFUSES whitespace and control characters', () => {
    expect(qaRoute('/quotes /1234')).toBeNull();
    expect(qaRoute('/quotes\n/1234')).toBeNull();
    // Written as an escape: a literal NUL in a source file is invisible in a diff.
    expect(qaRoute('/quotes\u0000')).toBeNull();
  });

  it('REFUSES a `..` segment — the capture is evidence about the step it is filed under', () => {
    expect(qaRoute('/quotes/../admin')).toBeNull();
  });

  it('reads nothing but a string', () => {
    expect(qaRoute(null)).toBeNull();
    expect(qaRoute(42)).toBeNull();
    expect(qaRoute({ href: '/x' })).toBeNull();
  });
});

describe('captureUrl — the fence that actually decides where a browser goes', () => {
  it('builds the address from the port the console chose', () => {
    expect(captureUrl(PORT, '/quotes/1234')).toBe(`http://127.0.0.1:${PORT}/quotes/1234`);
  });

  /**
   * THE ONE THAT MATTERS. `qaRoute` refuses this at parse time, so this can only
   * be reached by a caller passing an unfenced string — and it still must not
   * leave this machine. `new URL('//evil.example/x', base)` resolves to a
   * different HOST, which is why the hostname is read back off the parsed url.
   */
  it('REFUSES a route that resolves off this machine', () => {
    expect(captureUrl(PORT, '//evil.example/x')).toBeNull();
    expect(captureUrl(PORT, 'http://evil.example/x')).toBeNull();
    expect(captureUrl(PORT, 'https://127.0.0.1:8093/x')).toBeNull();
  });

  it('REFUSES a route that changes the port out from under the console', () => {
    expect(captureUrl(PORT, '//127.0.0.1:9999/x')).toBeNull();
  });

  it('REFUSES credentials in the address', () => {
    expect(captureUrl(PORT, '//user:pass@127.0.0.1:8093/x')).toBeNull();
  });

  it('REFUSES a port that is not a port', () => {
    expect(captureUrl(0, '/x')).toBeNull();
    expect(captureUrl(70_000, '/x')).toBeNull();
    expect(captureUrl(8.5, '/x')).toBeNull();
  });
});

// ------------------------------------------------------------- the path fence

describe('shotPath — where a capture is allowed to land', () => {
  it('puts it under the issue\'s plans directory, keyed by step and revision', () => {
    expect(shotPath(4404, 3, 2, 'after')).toBe(`${PLANS}/qa-4404/auto/s3r2-after.png`);
  });

  it('is under the plans root, which is what the evidence route will serve', () => {
    expect(shotPath(4404, 1, 1, 'before')!.startsWith(`${PLANS}/`)).toBe(true);
  });

  it('refuses anything that is not a positive integer, rather than composing a path from it', () => {
    expect(shotPath(-1, 1, 1, 'after')).toBeNull();
    expect(shotPath(4404, 0, 1, 'after')).toBeNull();
    expect(shotPath(4404, 1, 1.5, 'after')).toBeNull();
  });
});

// -------------------------------------------------------- drivable selection

/** Steps as a worker writes them, through the real parser, with the scan's own
 *  `goneShots` applied on top — the runner does the same. */
const steps = (raw: Array<Record<string, unknown>>, gone: Record<number, Array<'before' | 'after'>> = {}): ManualQaStep[] => {
  const parsed = parseManualQa({ steps: raw })!.steps;
  for (const s of parsed) s.goneShots = gone[s.id] ?? [];
  return parsed;
};

describe('drivableLegs', () => {
  it('drives exactly the legs `missingShots` says are owed', () => {
    const { legs } = drivableLegs(steps([step()]), { baseline: true });
    expect(legs.map((l) => l.leg).sort()).toEqual(['after', 'before']);
  });

  it('leaves a step that already has both captures alone', () => {
    const { legs } = drivableLegs(
      steps([step({ beforeShot: `${PLANS}/qa-4404/b.png`, afterShot: `${PLANS}/qa-4404/a.png` })]),
      { baseline: true },
    );
    expect(legs).toEqual([]);
  });

  /** The sanctioned escape: genuinely new behaviour owes no before, so nothing
   *  is driven for it and nothing is complained about either. */
  it('drives only the after for a step that declares itself new', () => {
    const { legs, skipped } = drivableLegs(steps([step({ before: null, beforeShot: null })]), { baseline: true });
    expect(legs.map((l) => l.leg)).toEqual(['after']);
    expect(skipped).toEqual([]);
  });

  it('re-drives a leg whose declared file is not in the worktree', () => {
    const owed = steps([step({ afterShot: `${PLANS}/qa-4404/gone.png`, before: null, beforeShot: null })], {
      1: ['after'],
    });
    const { legs } = drivableLegs(owed, { baseline: true });
    expect(legs.map((l) => l.leg)).toEqual(['after']);
  });

  it('SKIPS a step with no route, and says so rather than inventing a screen', () => {
    const { legs, skipped } = drivableLegs(steps([step({ route: null })]), { baseline: true });
    expect(legs).toEqual([]);
    expect(skipped.join(' ')).toContain('no "route"');
  });

  it('SKIPS the before leg with no baseline configured, and names the setting', () => {
    const { legs, skipped } = drivableLegs(steps([step()]), { baseline: false });
    expect(legs.map((l) => l.leg)).toEqual(['after']);
    expect(skipped.join(' ')).toContain('BASELINE_PORT');
  });

  it('carries the step revision, so a capture can be refused if the step moves', () => {
    const { legs } = drivableLegs(steps([step({ rev: 3 })]), { baseline: true });
    expect(legs.every((l) => l.rev === 3)).toBe(true);
  });
});

// ---------------------------------------------------------------- the stamp

describe('stampCaptures — the shapes the parsers accept', () => {
  const wrote = (over: Partial<Wrote> = {}): Wrote => ({
    stepId: 1,
    rev: 1,
    leg: 'after',
    path: `${PLANS}/qa-4404/auto/s1r1-after.png`,
    caption: 'Open the quote and press Withdraw — after',
    ...over,
  });

  const gate = (over: Record<string, unknown> = {}) => ({
    issue: ISSUE,
    gate: 'C',
    evidence: [],
    manualQa: { steps: [step()] },
    ...over,
  });

  it('writes the leg onto the step AND appends the canonical evidence entry', () => {
    const { gate: out, stamped, refused } = stampCaptures(gate(), [wrote()]);
    expect(refused).toEqual([]);
    expect(stamped).toHaveLength(1);
    const qa = (out as { manualQa: { steps: Array<Record<string, unknown>> } }).manualQa;
    expect(qa.steps[0]!.afterShot).toBe(`${PLANS}/qa-4404/auto/s1r1-after.png`);
    expect((out as { evidence: unknown[] }).evidence).toEqual([
      {
        kind: 'screenshot',
        path: `${PLANS}/qa-4404/auto/s1r1-after.png`,
        caption: 'Open the quote and press Withdraw — after',
      },
    ]);
  });

  /** What lands has to survive the parsers on the other side, both of which are
   *  the real ones — a shape that only this file agrees with is not a shape. */
  it('lands in a gate file the real parsers read back whole', () => {
    const { gate: out } = stampCaptures(gate(), [wrote(), wrote({ leg: 'before', path: `${PLANS}/qa-4404/auto/s1r1-before.png` })]);
    const qa = parseManualQa((out as Record<string, unknown>).manualQa)!;
    expect(qa.steps[0]!.afterShot).toBe(`${PLANS}/qa-4404/auto/s1r1-after.png`);
    expect(qa.steps[0]!.beforeShot).toBe(`${PLANS}/qa-4404/auto/s1r1-before.png`);
  });

  it('keeps every other field of the gate file untouched', () => {
    const { gate: out } = stampCaptures(gate({ summary: 'Did: it', questions: ['why?'] }), [wrote()]);
    expect((out as Record<string, unknown>).summary).toBe('Did: it');
    expect((out as Record<string, unknown>).questions).toEqual(['why?']);
    expect((out as Record<string, unknown>).issue).toBe(ISSUE);
  });

  it('appends to existing evidence rather than replacing it, and never twice', () => {
    const existing = [{ kind: 'transcript', path: `${PLANS}/qa-4404/red-green.txt`, caption: 'guardrail' }];
    const { gate: out } = stampCaptures(gate({ evidence: existing }), [wrote(), wrote()]);
    const ev = (out as { evidence: unknown[] }).evidence;
    expect(ev).toHaveLength(2);
    expect(ev[0]).toEqual(existing[0]);
  });

  it('does not double-list a path the manifest already names as a bare string', () => {
    const { gate: out } = stampCaptures(gate({ evidence: [`${PLANS}/qa-4404/auto/s1r1-after.png`] }), [wrote()]);
    expect((out as { evidence: unknown[] }).evidence).toHaveLength(1);
  });

  /** A reworked step is a different step. Stamping a picture of the old one
   *  under the new one is exactly the failure `shotStamp` exists to catch. */
  it('REFUSES a step whose rev moved while the capture was running', () => {
    const { stamped, refused } = stampCaptures(gate({ manualQa: { steps: [step({ rev: 2 })] } }), [wrote({ rev: 1 })]);
    expect(stamped).toEqual([]);
    expect(refused[0]).toContain('moved to rev 2');
  });

  it('REFUSES to write over a leg the worker has since filled itself', () => {
    const held = `${PLANS}/qa-4404/worker-after.png`;
    const { stamped, refused } = stampCaptures(gate({ manualQa: { steps: [step({ afterShot: held })] } }), [wrote()]);
    expect(stamped).toEqual([]);
    expect(refused[0]).toContain('names its own after capture');
  });

  it('REFUSES a step that is no longer in the file', () => {
    const { stamped, refused } = stampCaptures(gate({ manualQa: { steps: [step({ id: 7 })] } }), [wrote()]);
    expect(stamped).toEqual([]);
    expect(refused[0]).toContain('no longer in the gate file');
  });

  it('stamps nothing into a gate file it cannot read', () => {
    expect(stampCaptures('not an object', [wrote()]).gate).toBeNull();
    expect(stampCaptures({ manualQa: {} }, [wrote()]).gate).toBeNull();
    expect(stampCaptures(null, [wrote()]).gate).toBeNull();
  });

  /** Appending conservatively means a field the console cannot read is a field
   *  it does not overwrite — even one the card already shows nothing for. */
  it('REFUSES to touch an `evidence` that is not an array', () => {
    const out = stampCaptures(gate({ evidence: { s1: 'after.png' } }), [wrote()]);
    expect(out.gate).toBeNull();
    expect(out.refused[0]).toContain('not an array');
  });

  it('creates the manifest when the gate file has none at all', () => {
    const { gate: out } = stampCaptures({ issue: ISSUE, manualQa: { steps: [step()] } }, [wrote()]);
    expect((out as { evidence: unknown[] }).evidence).toHaveLength(1);
  });
});

// ------------------------------------------------------------- the whole run

describe('captureGateShots — end to end, with a fake browser', () => {
  it('captures both legs, files them, and stamps the live gate file', async () => {
    gateFile([step()]);
    const report = await run(fakeDriver());

    expect(report.ok).toBe(true);
    expect(report.wrote.sort()).toEqual(['1/after', '1/before']);
    expect(report.line).toContain('2 screenshots');

    const gate = readGate();
    const qa = parseManualQa(gate.manualQa)!;
    expect(qa.steps[0]!.beforeShot).toBe(`${PLANS}/qa-4404/auto/s1r1-before.png`);
    expect(qa.steps[0]!.afterShot).toBe(`${PLANS}/qa-4404/auto/s1r1-after.png`);
    expect(gate.evidence).toHaveLength(2);
    // and the pictures are really there
    expect(existsSync(join(worktree, qa.steps[0]!.afterShot!))).toBe(true);
  });

  /** THE PORT FENCE, seen from the only place it is visible: the addresses the
   *  browser was actually handed. */
  it('drives the worktree port for the after and the baseline for the before, and nothing else', async () => {
    gateFile([step()]);
    await run(fakeDriver());
    expect(visited.sort()).toEqual([
      `http://127.0.0.1:${BASELINE}/quotes/1234`,
      `http://127.0.0.1:${PORT}/quotes/1234`,
    ]);
  });

  /**
   * A WORKER-SUPPLIED ABSOLUTE URL IS REFUSED. It cannot reach the driver at
   * all: `parseManualQa` drops it at the route fence, so the step becomes
   * undrivable and is reported rather than driven.
   */
  it('REFUSES a worker-supplied absolute url and never navigates to it', async () => {
    gateFile([step({ route: 'http://evil.example/steal' })]);
    const report = await run(fakeDriver());
    expect(visited).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.notes.join(' ')).toContain('no "route"');
  });

  it('REFUSES a protocol-relative route and never leaves this machine', async () => {
    gateFile([step({ route: '//evil.example/steal' })]);
    await run(fakeDriver());
    expect(visited).toEqual([]);
  });

  /** THE PATH FENCE, seen the same way: every byte written landed under the
   *  plans root of this worktree and nowhere else. */
  it('writes only under the issue\'s plans directory', async () => {
    gateFile([step()]);
    await run(fakeDriver());
    expect(written).toHaveLength(2);
    for (const file of written) {
      expect(file.startsWith(join(worktree, PLANS, `qa-${ISSUE}`))).toBe(true);
    }
  });

  it('refuses to drive a port that is not in the worktree registry', async () => {
    gateFile([step({ before: null, beforeShot: null })]);
    const report = await run(fakeDriver(), { port: 8080, baselinePort: null });
    expect(visited).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.notes.join(' ')).toContain('not a worktree port');
  });

  it('says the dev server is down rather than failing at the browser', async () => {
    gateFile([step({ before: null, beforeShot: null })]);
    const report = await run(fakeDriver(), { baselinePort: null }, async () => false);
    expect(visited).toEqual([]);
    expect(report.notes.join(' ')).toContain(`Nothing is listening on port ${PORT}`);
    expect(report.line).toContain('No capture could be run');
  });

  it('takes no before with no baseline configured, and names the setting', async () => {
    gateFile([step()]);
    const report = await run(fakeDriver(), { baselinePort: null });
    expect(report.ok).toBe(true);
    expect(report.wrote).toEqual(['1/after']);
    expect(report.notes.join(' ')).toContain('BASELINE_PORT');
    expect(parseManualQa(readGate().manualQa)!.steps[0]!.beforeShot).toBeNull();
  });

  /** The operator reported a before and an after that looked the same.
   *  Byte-identical is the only version of that claim the console can make on
   *  its own. */
  it('warns when the before and after are the same picture, byte for byte', async () => {
    gateFile([step()]);
    const report = await run(fakeDriver({ bytes: () => 'the same picture' }));
    expect(report.ok).toBe(true);
    expect(report.identical).toEqual([1]);
    expect(report.line).toContain('byte-identical');
  });

  it('does not warn when the pair genuinely differs', async () => {
    gateFile([step()]);
    const report = await run(fakeDriver());
    expect(report.identical).toEqual([]);
    expect(report.line).not.toContain('byte-identical');
  });

  // ------------------------------------------------------ failure is never silent

  it('says WHY a browser could not be opened, with the command that fixes it', async () => {
    gateFile([step()]);
    const report = await run(async () => {
      throw new Error('Chromium is not installed for Playwright — run `npx playwright install chromium` and capture again.');
    });
    expect(report.ok).toBe(false);
    expect(report.line).toContain('npx playwright install chromium');
    // and nothing was stamped
    expect(parseManualQa(readGate().manualQa)!.steps[0]!.afterShot).toBeNull();
  });

  it('names the step and the leg when one capture fails, and still files the rest', async () => {
    gateFile([step()]);
    const report = await run(
      fakeDriver({ fail: (url) => (url.includes(String(BASELINE)) ? 'net::ERR_CONNECTION_REFUSED' : null) }),
    );
    expect(report.ok).toBe(true);
    expect(report.wrote).toEqual(['1/after']);
    expect(report.notes.join(' ')).toContain('the before capture failed — net::ERR_CONNECTION_REFUSED');
  });

  it('leaves a partial file nowhere when a capture dies mid-write', async () => {
    gateFile([step({ before: null, beforeShot: null })]);
    await run(fakeDriver({ fail: () => 'crashed' }), { baselinePort: null });
    expect(existsSync(join(worktree, PLANS, `qa-${ISSUE}`, 'auto', 's1r1-after.png.part'))).toBe(false);
  });

  it('says so when there is nothing to capture, rather than saying nothing', async () => {
    gateFile([step({ beforeShot: `${PLANS}/qa-4404/b.png`, afterShot: `${PLANS}/qa-4404/a.png` })]);
    mkdirSync(join(worktree, PLANS, `qa-${ISSUE}`), { recursive: true });
    writeFileSync(join(worktree, PLANS, `qa-${ISSUE}`, 'b.png'), 'b');
    writeFileSync(join(worktree, PLANS, `qa-${ISSUE}`, 'a.png'), 'a');
    const report = await run(fakeDriver());
    expect(report.line).toContain('Every step already has the captures it owes');
    expect(visited).toEqual([]);
  });

  it('says so when the steps are all undrivable', async () => {
    gateFile([step({ route: null })]);
    const report = await run(fakeDriver());
    expect(report.line).toContain('none of them is drivable');
  });

  it('says so when there is no gate file at all', async () => {
    const report = await run(fakeDriver());
    expect(report.line).toContain('no gate file');
  });

  it('touches nothing when the gate file is not valid JSON', async () => {
    writeFileSync(join(worktree, '.gate.json'), '{ broken');
    const report = await run(fakeDriver());
    expect(report.line).toContain('not valid JSON');
    expect(readFileSync(join(worktree, '.gate.json'), 'utf8')).toBe('{ broken');
  });

  /**
   * THE CONSERVATIVE MERGE. A worker that rewrote `.gate.json` while the browser
   * was running has said something newer than anything this run knows, and
   * merging into it blind is how a console silently un-does a worker's edit.
   */
  it('stamps NOTHING when the worker rewrote the gate file mid-run', async () => {
    gateFile([step()]);
    const rewritten = { ...readGate(), summary: 'Did: something else entirely' };
    const open: CaptureDeps['open'] = async () => ({
      async shot({ url, file }) {
        visited.push(url);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `png-for-${url}`);
        writeFileSync(join(worktree, '.gate.json'), JSON.stringify(rewritten, null, 2));
      },
      async close() {},
    });
    const report = await run(open);
    expect(report.ok).toBe(false);
    expect(report.line).toContain('rewrote the gate file');
    expect(readGate().summary).toBe('Did: something else entirely');
    expect(parseManualQa(readGate().manualQa)!.steps[0]!.afterShot).toBeNull();
  });

  it('refuses the whole run when the configured storage state is not a file', async () => {
    gateFile([step()]);
    const report = await run(fakeDriver(), { storageState: join(worktree, 'nope.json') });
    expect(report.ok).toBe(false);
    expect(report.line).toContain('QA_STORAGE_STATE');
    expect(visited).toEqual([]);
  });

  it('runs with a storage state that is there, and never reads it', async () => {
    gateFile([step({ before: null, beforeShot: null })]);
    const state = join(worktree, 'auth.json');
    writeFileSync(state, '{"cookies":[]}');
    const report = await run(fakeDriver(), { storageState: state, baselinePort: null });
    expect(report.ok).toBe(true);
  });
});
