import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { EVIDENCE_ROOT, isUnderPlansRoot } from './evidence.js';
import { isWorktreePort, WORKTREE_PORT_MAX, WORKTREE_PORT_MIN } from './instances.js';
import { missingShots, parseManualQa, qaRoute, type ManualQaStep } from './manual-qa.js';

/**
 * THE CONSOLE TAKES THE SCREENSHOTS ITSELF.
 *
 * The operator asked for three things at once: the screenshots should be there
 * every time, consistent between runs, and produced with no human intervention.
 * The third is the one that decides the design — a capture that needs a person
 * to press something is a capture that will be missing on the round where it
 * mattered.
 *
 * What was actually happening, measured across 71 worktrees: workers DO take
 * captures (744 PNGs on disk), but 32 of 53 gate C send-backs were bounces for a
 * null shot leg while the files sat there, and roughly 48% of first gate C
 * rounds in the enforcement era arrived with nothing wired at all. Each of those
 * is a whole human round spent asking for a picture. The click-scripts that were
 * preserved are prose: an `appUrl` in 3 of 15, a login in 1. So the console
 * cannot fix this by asking harder — it has to be able to take the picture.
 *
 * It can, for one specific kind of step: one that says WHICH SCREEN it is on.
 * That is `route` in manual-qa.ts — an app path and nothing else, because a path
 * carries no host and therefore no destination a worker could choose. A step
 * with no route is NOT drivable and keeps every rule it had: the worker's own
 * shots, or the sanctioned `before: null` / `beforeShot: null` pair with a
 * `Limits:` note. Roughly half of all evidence is SQL and transcripts, and that
 * escape is how the honest half of the work stays passable.
 *
 * THE FOUR FENCES, none of which this file may weaken:
 *
 *  1. WHERE IT NAVIGATES. Only `http://127.0.0.1:<port>`, with the port chosen
 *     by the console from its own registry or its own config, never from
 *     anything a worker wrote. `captureUrl` rebuilds the address and then reads
 *     the hostname and port back off the parsed URL — the same two-part guard
 *     `localUrl` uses, for the same reason: a string that starts with the right
 *     characters is not the same as an address that resolves to this machine.
 *  2. WHERE IT WRITES. Only under `docs/issue-pipeline/plans/qa-<issue>/`, on paths
 *     this file composes from integers, and re-checked with `isUnderPlansRoot`
 *     before a byte is written — the same fence the evidence route serves
 *     through, so nothing can be captured that could never be shown.
 *  3. WHAT IT KNOWS. Auth is a Playwright `storageState` file the OPERATOR
 *     configured (`QA_STORAGE_STATE`) and nothing else. No credential is read,
 *     typed, stored or logged here, and there is no code path that could: the
 *     console hands the browser a path and the browser does the rest.
 *  4. WHAT IT REWRITES. It stamps the live `.gate.json` — the SECOND narrow
 *     exception to "the console never writes into a worktree", after
 *     `appendGateHistory`. It is deliberately the most conservative write in the
 *     codebase: every capture is taken first, the file is re-read immediately
 *     before the stamp and refused if its bytes moved, each step's `rev` is
 *     re-checked, only null legs are filled, evidence entries are appended and
 *     never reordered or removed, and the whole thing lands through a temp file
 *     and a rename so a crash cannot leave half a gate file behind.
 *
 * The runner is built around an INJECTABLE `BrowserDriver` so the tests never
 * launch a browser: the fences, the selection, the stamp shapes and the failure
 * lines are all decided by pure functions or by code a fake driver can drive.
 */

export type CaptureLeg = 'before' | 'after';

/** The one viewport every capture is taken at. A comparison between two
 *  pictures of different widths is not a comparison, and the whole complaint
 *  about the pair is that it cannot be told what changed. */
export const VIEWPORT = { width: 1280, height: 800 } as const;

/** After the network goes idle, this much longer. Idle is not settled: a chart
 *  that animates in, a skeleton that swaps, a font that lands late all finish
 *  after the last response. Short enough that ten legs cost four seconds. */
export const SETTLE_MS = 400;

/** A page that will not load in this long is a page the operator needs told
 *  about, not one worth waiting on while a gate sits unanswered. */
export const NAV_TIMEOUT_MS = 15_000;

/** Injected so a test never launches Chromium. Two methods, because two is all
 *  the runner needs: everything else — the viewport, the scale factor, the
 *  animation freeze, the auth state — is fixed inside the real driver where it
 *  belongs, not passed per call where a caller could vary it. */
export type BrowserDriver = {
  /** Navigate to `url`, settle, and write a PNG at `file`. Throws with a
   *  plain-English reason — that reason reaches the card verbatim. */
  shot(input: { url: string; file: string }): Promise<void>;
  /** Always called, including after a failure. Never throws. */
  close(): Promise<void>;
};

export type CaptureDeps = {
  /** Opens a browser, or throws carrying the one-line fix. */
  open: () => Promise<BrowserDriver>;
  /** Is anything listening on this port of this machine? A dev server that is
   *  down is the most likely reason a capture cannot run, and it deserves its
   *  own sentence rather than a navigation error. */
  listens: (port: number) => Promise<boolean>;
  now?: () => Date;
};

export type CaptureInput = {
  issue: number;
  worktree: string;
  /** The worktree's registered dev-server port — the AFTER half. Null when the
   *  worktree registered none, which is a fact, not a zero. */
  port: number | null;
  /** The untouched checkout's dev server — the BEFORE half. Null when the
   *  operator has not configured one; see `BASELINE_PORT` in config.ts. */
  baselinePort: number | null;
  /** An operator-configured Playwright storage state, or null. */
  storageState: string | null;
};

/**
 * What one capture run did, in the shapes the card renders.
 *
 * `line` is composed HERE and never in the browser, on this console's standing
 * rule that the server writes the sentence and the page renders it. It is never
 * empty: a run that captured nothing says why it captured nothing, because the
 * failure this whole file exists to remove is the silent one.
 */
export type CaptureReport = {
  at: string;
  /** One finished sentence for the gate C card. */
  line: string;
  /** Whether anything was written and stamped. */
  ok: boolean;
  /** `<stepId>/<leg>` for every capture written and stamped this run. */
  wrote: string[];
  /**
   * Steps whose before and after captures are byte-identical.
   *
   * A real round caught this: the operator reported that the before and after
   * images looked the same, and a pair that is identical to the byte is either a
   * step pointed at a screen the change does not touch or a baseline server
   * serving the same code.
   * Either way it is not evidence, and the card says so on the step.
   */
  identical: number[];
  /** Everything refused, skipped or failed, one plain line each. */
  notes: string[];
};

/** One leg the runner intends to drive, and what it is for. */
export type DrivableLeg = { stepId: number; rev: number; leg: CaptureLeg; route: string };

/** One capture that was actually written, ready to be stamped into the gate. */
export type Wrote = { stepId: number; rev: number; leg: CaptureLeg; path: string; caption: string };

/**
 * A URL this console is willing to navigate to, or null.
 *
 * The load-bearing half of the route fence. `qaRoute` has already refused the
 * obvious escapes at parse time; this rebuilds the whole address from a port the
 * CONSOLE chose and then re-reads the hostname and port back off the parsed URL,
 * because `new URL('//evil.example/x', base)` is a host and looks like a path.
 * Nothing a worker wrote survives except the path, and only if the path did not
 * change where the path points.
 */
export function captureUrl(port: number, route: string): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const base = `http://127.0.0.1:${port}/`;
  let u: URL;
  try {
    u = new URL(route, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:') return null;
  if (u.hostname !== '127.0.0.1') return null;
  if (u.port !== String(port)) return null;
  if (u.username !== '' || u.password !== '') return null;
  return u.toString();
}

/**
 * Where one capture goes, worktree-relative.
 *
 * Composed from three integers and a fixed word, under a directory of this
 * file's own (`auto/`), so the console's captures and the worker's own never
 * collide and it is obvious in a diff which is which. `rev` is in the name
 * because a reworked step is a new picture: reusing the filename would put a new
 * image under a tick the operator gave the old one, which is the exact failure
 * `shotStamp` was added to catch.
 *
 * Returns null rather than a path when any input is not an integer — this
 * composes an `<img src>` and a filesystem write, and neither takes a guess.
 */
export function shotPath(issue: number, stepId: number, rev: number, leg: CaptureLeg): string | null {
  const ints = [issue, stepId, rev];
  if (ints.some((n) => !Number.isInteger(n) || n <= 0)) return null;
  const path = `${EVIDENCE_ROOT}/qa-${issue}/auto/s${stepId}r${rev}-${leg}.png`;
  // It cannot fail — every segment above is a number or a literal — and it is
  // checked anyway, because this is the path a byte gets written to and the
  // fence is the fence whether or not the input could reach it.
  return isUnderPlansRoot(path) ? path : null;
}

/**
 * WHICH LEGS THE CONSOLE WILL DRIVE, and one line for each one it will not.
 *
 * The set of legs that are OWED is not decided here — it is `missingShots`, the
 * same function the card's warning and the server's refusal already use, so a
 * capture is attempted for exactly the legs the operator would otherwise be
 * asked to accept without. Everything this adds is two subtractions:
 *
 *  - a step with no `route` is not drivable. There is no screen to go to, and
 *    inventing one would be worse than the missing picture.
 *  - a `before` leg is not drivable without a baseline server. The before half
 *    of a comparison has to come from code that does not have the change in it,
 *    and the worktree's own port has the change in it by definition.
 *
 * Both come back as a skipped line rather than as silence.
 */
export function drivableLegs(
  steps: ManualQaStep[],
  opts: { baseline: boolean },
): { legs: DrivableLeg[]; skipped: string[] } {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const legs: DrivableLeg[] = [];
  const skipped: string[] = [];
  const noRoute: number[] = [];
  const noBaseline: number[] = [];

  for (const owed of missingShots(steps)) {
    const step = byId.get(owed.id);
    if (!step) continue;
    // The fence is re-applied rather than the field trusted. `parseManualQa`
    // has already run it, but a step can also arrive from the console's own
    // rework snapshot — written before this field existed, so `route` is
    // absent there rather than null, and `undefined` would build
    // `http://127.0.0.1:8081/undefined` and photograph the wrong screen.
    const route = qaRoute(step.route);
    if (route === null) {
      noRoute.push(step.id);
      continue;
    }
    for (const leg of owed.legs) {
      if (leg === 'before' && !opts.baseline) {
        noBaseline.push(step.id);
        continue;
      }
      legs.push({ stepId: step.id, rev: step.rev, leg, route });
    }
  }

  if (noRoute.length > 0) {
    skipped.push(
      `${noRoute.length === 1 ? 'Step' : 'Steps'} ${noRoute.join(', ')} ${noRoute.length === 1 ? 'has' : 'have'} ` +
        'no "route", so the console cannot drive to the screen — that capture stays the worker\'s.',
    );
  }
  if (noBaseline.length > 0) {
    skipped.push(
      `No BASELINE_PORT is configured, so no "before" could be taken for ` +
        `${noBaseline.length === 1 ? 'step' : 'steps'} ${[...new Set(noBaseline)].join(', ')}. ` +
        'Set it to the port the untouched checkout serves on; nothing is guessed.',
    );
  }
  return { legs, skipped };
}

/**
 * Which of a step's DECLARED captures are not files in the worktree.
 *
 * The same question `worktrees.ts` answers on every scan, asked again here
 * because this runner works off the file on disk rather than off the scan: it is
 * about to rewrite that file, and judging fresh bytes by an older scan's stamps
 * is how a capture gets taken for a picture that is already sitting there.
 */
async function goneLegs(worktree: string, step: ManualQaStep): Promise<Array<'before' | 'after'>> {
  const gone: Array<'before' | 'after'> = [];
  for (const [leg, rel] of [
    ['before', step.beforeShot],
    ['after', step.afterShot],
  ] as const) {
    if (rel === null) continue;
    const s = await stat(join(worktree, rel)).catch(() => null);
    if (s === null || !s.isFile()) gone.push(leg);
  }
  return gone;
}

/** The bytes of one capture, or null when there is no file. Used only to answer
 *  "are these two the same picture", so a hash is enough and the file is never
 *  held in memory beyond the read. */
async function fingerprint(worktree: string, rel: string | null): Promise<string | null> {
  if (rel === null) return null;
  const buf = await readFile(join(worktree, rel)).catch(() => null);
  return buf === null ? null : createHash('sha256').update(buf).digest('hex');
}

/**
 * THE STAMP, as a pure function.
 *
 * It writes the captures into two places, because the console reads them from
 * two places and a picture in only one of them is a picture half the card
 * cannot see:
 *
 *  - the step's own `beforeShot` / `afterShot`, which is what the before/after
 *    pair renders from and what `missingShots` counts;
 *  - the `evidence` array, which is the manifest the evidence box renders.
 *
 * Both parsers were recently made coercive, so a looser shape would survive.
 * This writes the canonical one anyway: the file is also read by workers, by
 * `.gate-history.jsonl` and by the next round's rework, and being lenient about
 * what you accept is not a licence to be lenient about what you emit.
 *
 * MERGING IS CONSERVATIVE AND STATED. A leg is filled only when the file says it
 * is empty, an evidence entry is appended only when no entry already names that
 * path, nothing is reordered, nothing is removed, and a step whose `rev` has
 * moved since the capture was taken is refused rather than stamped — that step
 * has been reworked and the picture is of the old one.
 */
export function stampCaptures(
  raw: unknown,
  wrote: Wrote[],
): { gate: Record<string, unknown> | null; stamped: Wrote[]; refused: string[] } {
  const refused: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { gate: null, stamped: [], refused: ['the gate file is not a JSON object — nothing was stamped'] };
  }
  const r = raw as Record<string, unknown>;
  const qaRaw = r.manualQa;
  if (typeof qaRaw !== 'object' || qaRaw === null || Array.isArray(qaRaw) || !Array.isArray((qaRaw as Record<string, unknown>).steps)) {
    return { gate: null, stamped: [], refused: ['the gate file has no manualQa.steps to stamp into'] };
  }

  // A manifest that is not an array is one this console cannot append to without
  // destroying whatever is in its place. `readEvidence` already shows nothing
  // for it, so the card is unchanged either way — but "append conservatively"
  // means a field the console cannot read is a field it does not overwrite.
  if (r.evidence !== undefined && !Array.isArray(r.evidence)) {
    return { gate: null, stamped: [], refused: ['the gate file\'s `evidence` is not an array — nothing was stamped'] };
  }

  const qa = { ...(qaRaw as Record<string, unknown>) };
  const steps = ((qaRaw as Record<string, unknown>).steps as unknown[]).map((s) =>
    typeof s === 'object' && s !== null && !Array.isArray(s) ? { ...(s as Record<string, unknown>) } : s,
  );
  const evidence: unknown[] = Array.isArray(r.evidence) ? [...r.evidence] : [];
  const listed = new Set(
    evidence
      .map((e) => (typeof e === 'string' ? e : typeof e === 'object' && e !== null ? (e as Record<string, unknown>).path : null))
      .filter((p): p is string => typeof p === 'string'),
  );

  const stamped: Wrote[] = [];
  for (const w of wrote) {
    const index = steps.findIndex(
      (s) => typeof s === 'object' && s !== null && (s as Record<string, unknown>).id === w.stepId,
    );
    if (index < 0) {
      refused.push(`step ${w.stepId} is no longer in the gate file — its ${w.leg} capture was not stamped`);
      continue;
    }
    const step = steps[index] as Record<string, unknown>;
    const rev = typeof step.rev === 'number' ? step.rev : 1;
    if (rev !== w.rev) {
      refused.push(
        `step ${w.stepId} moved to rev ${rev} while the capture was running — its ${w.leg} capture is of rev ${w.rev} and was not stamped`,
      );
      continue;
    }
    const field = w.leg === 'before' ? 'beforeShot' : 'afterShot';
    const held = step[field];
    // Only an EMPTY leg is filled. A leg whose declared file is missing is empty
    // as far as the card is concerned, and the runner only ever captures those
    // two cases — but the file is re-read between the two, so this asks again
    // rather than trusting a decision taken before the browser opened.
    if (typeof held === 'string' && held.trim() !== '') {
      refused.push(`step ${w.stepId} now names its own ${w.leg} capture — the console's was not stamped over it`);
      continue;
    }
    step[field] = w.path;
    if (!listed.has(w.path)) {
      evidence.push({ kind: 'screenshot', path: w.path, caption: w.caption });
      listed.add(w.path);
    }
    stamped.push(w);
  }

  qa.steps = steps;
  return { gate: { ...r, manualQa: qa, evidence }, stamped, refused };
}

/** The gate file this runner reads and stamps. Named here so the one write into
 *  a worktree is aimed at exactly one filename. */
const GATE_FILE = '.gate.json';

/**
 * TAKE THE MISSING CAPTURES FOR ONE ISSUE, AND STAMP THEM IN.
 *
 * The whole run is: read the gate file, work out which legs are owed and
 * drivable, refuse everything that cannot be driven safely with a reason, take
 * every capture, and only then rewrite the gate file once.
 *
 * Nothing here throws. A capture run is a convenience on top of a gate that is
 * already sitting there, and the correct behaviour for every failure is the same
 * one: say what went wrong on the card, in one line, and leave the gate exactly
 * as the worker left it. A silent skip is the one outcome that is not allowed —
 * it is the behaviour this file was written to delete.
 */
export async function captureGateShots(input: CaptureInput, deps: CaptureDeps): Promise<CaptureReport> {
  const at = (deps.now?.() ?? new Date()).toISOString();
  const notes: string[] = [];
  const done = (line: string, extra: Partial<CaptureReport> = {}): CaptureReport => ({
    at,
    line,
    ok: false,
    wrote: [],
    identical: [],
    notes,
    ...extra,
  });

  const gatePath = join(input.worktree, GATE_FILE);
  const before = await readFile(gatePath, 'utf8').catch(() => null);
  if (before === null) return done('There is no gate file in this worktree to capture against.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(before);
  } catch {
    return done('The gate file is not valid JSON — nothing was captured, and nothing was touched.');
  }

  const qa = parseManualQa((parsed as Record<string, unknown>).manualQa);
  const steps = qa?.steps ?? [];
  if (steps.length === 0) return done('The click-script has no steps, so there is nothing to capture.');
  for (const step of steps) step.goneShots = await goneLegs(input.worktree, step);

  const { legs, skipped } = drivableLegs(steps, { baseline: input.baselinePort !== null });
  notes.push(...skipped);
  if (legs.length === 0) {
    const owed = missingShots(steps).length;
    return done(
      owed === 0
        ? 'Every step already has the captures it owes — nothing to take.'
        : `${owed === 1 ? '1 step is' : `${owed} steps are`} missing a capture and none of them is drivable — see below.`,
    );
  }

  // THE PORT FENCE, and it is the same one `instances.ts` states: a port that is
  // not in the worktree registry is a number read out of prose, and this console
  // does not act on one. It matters slightly less here than there — driving a
  // port cannot kill a process — but a capture filed as evidence of a worktree's
  // change has to have come from that worktree's server.
  const wantsAfter = legs.some((l) => l.leg === 'after');
  const wantsBefore = legs.some((l) => l.leg === 'before');
  let afterPort: number | null = null;
  if (wantsAfter) {
    if (input.port === null) {
      notes.push('This worktree has no dev-server port in its registry, so no "after" could be taken.');
    } else if (!isWorktreePort(input.port)) {
      notes.push(
        `Port ${input.port} is not a worktree port (${WORKTREE_PORT_MIN}–${WORKTREE_PORT_MAX}) — refusing to drive ` +
          'a port read out of prose.',
      );
    } else if (!(await deps.listens(input.port))) {
      notes.push(`Nothing is listening on port ${input.port} — start this worktree's dev server and capture again.`);
    } else {
      afterPort = input.port;
    }
  }
  let baselinePort: number | null = null;
  if (wantsBefore && input.baselinePort !== null) {
    if (!(await deps.listens(input.baselinePort))) {
      notes.push(
        `Nothing is listening on the baseline port ${input.baselinePort} — start the untouched checkout's dev ` +
          'server and capture again.',
      );
    } else {
      baselinePort = input.baselinePort;
    }
  }

  const runnable = legs.filter((l) => (l.leg === 'after' ? afterPort !== null : baselinePort !== null));
  if (runnable.length === 0) return done('No capture could be run — see below.');

  // The storage state is a PATH and only a path. It is checked for existence
  // here so a missing file is one clear sentence rather than a browser error,
  // and it is never opened by this console: a file the console does not read is
  // a file it cannot leak.
  if (input.storageState !== null) {
    const s = await stat(input.storageState).catch(() => null);
    if (s === null || !s.isFile()) {
      return done(
        `QA_STORAGE_STATE points at ${input.storageState}, which is not a file — refusing to capture signed-out ` +
          'pages and file them as evidence.',
      );
    }
  }

  let driver: BrowserDriver;
  try {
    driver = await deps.open();
  } catch (e) {
    return done((e as Error).message);
  }

  const wrote: Wrote[] = [];
  const byId = new Map(steps.map((s) => [s.id, s]));
  try {
    for (const leg of runnable) {
      const port = leg.leg === 'after' ? afterPort! : baselinePort!;
      const url = captureUrl(port, leg.route);
      if (url === null) {
        notes.push(`Step ${leg.stepId}: "${leg.route}" is not a route this console will navigate to.`);
        continue;
      }
      const rel = shotPath(input.issue, leg.stepId, leg.rev, leg.leg);
      if (rel === null) {
        notes.push(`Step ${leg.stepId}: no capture path could be composed for its ${leg.leg}.`);
        continue;
      }
      const abs = join(input.worktree, rel);
      const partial = `${abs}.part`;
      try {
        await mkdir(dirname(abs), { recursive: true });
        await driver.shot({ url, file: partial });
        // Rename last, so a capture that dies mid-write never leaves a truncated
        // PNG where the card would render it as a broken picture.
        await rename(partial, abs);
      } catch (e) {
        await rm(partial, { force: true }).catch(() => {});
        notes.push(`Step ${leg.stepId}: the ${leg.leg} capture failed — ${firstLine((e as Error).message)}`);
        continue;
      }
      wrote.push({
        stepId: leg.stepId,
        rev: leg.rev,
        leg: leg.leg,
        path: rel,
        caption: `${byId.get(leg.stepId)?.do ?? `Step ${leg.stepId}`} — ${leg.leg}`,
      });
    }
  } finally {
    await driver.close().catch(() => {});
  }

  if (wrote.length === 0) return done('Every capture failed — see below.');

  // EVERY FILE IS ON DISK BEFORE ANYTHING IS STAMPED. The gate file is re-read
  // at this instant and refused if its bytes moved: a worker that rewrote it
  // while the browser was running has said something newer than anything this
  // run knows, and merging into it blind is how a console silently un-does a
  // worker's own edit.
  const after = await readFile(gatePath, 'utf8').catch(() => null);
  if (after === null) return done('The gate file disappeared while the captures were running — nothing was stamped.');
  if (after !== before) {
    return done(
      'The worker rewrote the gate file while the captures were running, so nothing was stamped. The pictures are ' +
        'on disk — press Capture shots again.',
    );
  }

  const { gate, stamped, refused } = stampCaptures(parsed, wrote);
  notes.push(...refused);
  if (gate === null || stamped.length === 0) return done('Nothing could be stamped into the gate file — see below.');

  const tmp = `${gatePath}.capture`;
  try {
    await writeFile(tmp, `${JSON.stringify(gate, null, 2)}\n`, 'utf8');
    await rename(tmp, gatePath);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    return done(`The gate file could not be written — ${firstLine((e as Error).message)}`);
  }

  // IDENTICAL PAIRS, asked of the files that are on disk NOW rather than of the
  // ones this run wrote. A step whose before came from the worker and whose
  // after came from here is still a pair the operator is about to compare, and
  // it is still worth saying when the two are the same bytes.
  const identical: number[] = [];
  const filled = new Map<number, { before: string | null; after: string | null }>();
  for (const step of steps) {
    filled.set(step.id, { before: step.beforeShot, after: step.afterShot });
  }
  for (const w of stamped) {
    const pair = filled.get(w.stepId);
    if (pair) pair[w.leg] = w.path;
  }
  for (const [id, pair] of filled) {
    if (pair.before === null || pair.after === null) continue;
    const [b, a] = await Promise.all([
      fingerprint(input.worktree, pair.before),
      fingerprint(input.worktree, pair.after),
    ]);
    if (b !== null && b === a) identical.push(id);
  }
  identical.sort((x, y) => x - y);

  return {
    at,
    ok: true,
    line: captureLine(stamped.length, wrote.length, identical, notes.length),
    wrote: stamped.map((w) => `${w.stepId}/${w.leg}`),
    identical,
    notes,
  };
}

/** One sentence for the card. Composed here so the page renders it rather than
 *  assembling its own version of the same counts. */
export function captureLine(stamped: number, taken: number, identical: number[], notes: number): string {
  const shots = `${stamped} screenshot${stamped === 1 ? '' : 's'}`;
  const head =
    stamped === taken
      ? `The console captured and filed ${shots}.`
      : `The console captured ${taken} screenshots and filed ${shots}.`;
  const same =
    identical.length === 0
      ? ''
      : ` ${identical.length === 1 ? `Step ${identical[0]}'s` : `Steps ${identical.join(', ')} have`} before and ` +
        `after ${identical.length === 1 ? 'pictures are' : 'pictures that are'} byte-identical — that pair proves nothing.`;
  const rest = notes === 0 ? '' : ` ${notes} thing${notes === 1 ? '' : 's'} could not be captured — see below.`;
  return `${head}${same}${rest}`;
}

const firstLine = (m: string): string => m.split('\n')[0]?.trim() || 'no reason given';

/**
 * Is anything listening on this port of this machine?
 *
 * A TCP connect rather than an HTTP request: the question is "is the server
 * up", and a dev server that answers 404 on `/` is up. It is aimed at
 * 127.0.0.1 and nowhere else, which is the same fence every other part of this
 * file navigates under.
 */
export const systemListens = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const settle = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(1_500);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });

/** Everything that moves is frozen, belt and braces with Playwright's own
 *  `animations: 'disabled'`: a caret blinking or a spinner mid-turn is a pixel
 *  difference between two runs of the same page, and "always consistent" is one
 *  of the three things the operator asked for. */
const FREEZE = `*, *::before, *::after {
  animation: none !important;
  transition: none !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}`;

/**
 * The real driver.
 *
 * Playwright is imported DYNAMICALLY and on first use, for two reasons that both
 * matter: the console must start on a machine that has no browser package, and
 * nothing should pay to load a browser engine on a poll that captures nothing.
 * Both failure modes it can hit — the package missing, the browser binary
 * missing — come back as one sentence carrying the exact command that fixes it,
 * because "capture failed" with no next step is the silent skip wearing a label.
 */
export function playwrightDriver(opts: { storageState: string | null }): () => Promise<BrowserDriver> {
  return async () => {
    let chromium: typeof import('playwright').chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      return Promise.reject(
        new Error('Playwright is not installed for the console — run `npm install` in orchestrator/ and capture again.'),
      );
    }
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (e) {
      const m = (e as Error).message;
      throw new Error(
        /Executable doesn't exist|playwright install/i.test(m)
          ? 'Chromium is not installed for Playwright — run `npx playwright install chromium` and capture again.'
          : `Chromium would not start — ${firstLine(m)}`,
      );
    }
    const context = await browser.newContext({
      viewport: { ...VIEWPORT },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      // A path, handed straight to the browser. The console never opens it, and
      // there is no other auth path in this build — no credential is read,
      // typed or stored anywhere in this file.
      ...(opts.storageState === null ? {} : { storageState: opts.storageState }),
    });
    return {
      async shot({ url, file }) {
        const page = await context.newPage();
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
          await page.addStyleTag({ content: FREEZE }).catch(() => {});
          await page.waitForTimeout(SETTLE_MS);
          await page.screenshot({ path: file, animations: 'disabled' });
        } finally {
          await page.close().catch(() => {});
        }
      },
      async close() {
        await browser.close().catch(() => {});
      },
    };
  };
}
