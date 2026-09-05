/**
 * The manual QA click-script, structured — the operator's second requirement at
 * gate C.
 *
 * The worker already writes the click-script in prose. Prose is not clickable:
 * the operator was being asked to run a click-script with no way of telling how
 * to reach the thing it talked about, and the fix is that the console renders the
 * app URL, the login and each step's deep link as things they can actually click.
 *
 * Which is exactly why this file is a fence as well as a parser. A worker reads
 * issue bodies, PR comments and web pages; the moment the console turns a field
 * a worker wrote into an anchor a person is told to follow, "sign in here" is a
 * phishing vector. The QA target is the LOCAL dev server or it is not a link:
 * anything else keeps its text and loses its href, because a step the operator
 * cannot read is a step they cannot check.
 *
 * v2 — three changes, all asked for by the operator:
 *
 *  - the before and the after belong in ONE question, not one point for the
 *    before and another for the after. So a step carries BOTH states and both
 *    captures. There is no shape here that can express a before-step and an
 *    after-step as two separate numbers.
 *  - every point needs a tick that confirms it was verified. The tick itself is
 *    NOT in this file and never can be — see the verdict-shaped-key rule below.
 *  - a failed step comes back fixed, so a step has an `id` that never moves and
 *    a `rev` that moves exactly once per fix. Those two numbers are the join
 *    key the operator's ticks hang on, which is what lets one step be re-checked
 *    while the other nine keep the ticks already given them.
 */
import { isUnderPlansRoot } from './evidence.js';

export type ManualQaStep = {
  /** Stable, 1-based, assigned once by the worker. Never renumbered and never
   *  reused for the life of the issue — the operator's ticks are keyed on it. */
  id: number;
  /** 1 on first emit, bumped by exactly 1 each time this step is sent back and
   *  fixed. A tick set against an older revision is not a tick on this one. */
  rev: number;
  /** What to do, in the operator's hands. */
  do: string;
  /** A deep link straight to it, or null when there is none we will link to. */
  url: string | null;
  /** What this did BEFORE the change — the half that makes the after meaningful.
   *  null WITH a null `beforeShot` is the signal for genuinely new behaviour;
   *  the card says "New — nothing to compare" rather than inventing prose. */
  before: string | null;
  /** The BEFORE capture, worktree-relative, under the plans root or dropped. */
  beforeShot: string | null;
  /** What the operator should see now. */
  after: string | null;
  /** The AFTER capture, same fence. */
  afterShot: string | null;
  /** rev > 1 only: what the fix changed. Null on a step that never failed. */
  fix: string | null;
  /**
   * A fingerprint of the BYTES behind `beforeShot` and `afterShot`, stamped by
   * the worktree scan — never by this parser, which cannot read a file and must
   * stay pure. Null when neither capture is on disk.
   *
   * It is here because `stepHash` needs it and the path cannot carry it: the
   * evidence route's own comment says "rounds reuse filenames (`after.png` is
   * `after.png` every round)" and it serves `no-cache`, so a capture rewritten in
   * place put a NEW picture on the card underneath a tick the operator gave the
   * old one. A step whose picture moved is not the step they verified.
   */
  shotStamp: string | null;
  /**
   * Which of the captures this step DECLARED are not files in the worktree.
   *
   * Stamped by the scan beside `shotStamp`, from the same `stat` — and unlike
   * `shotStamp` it is a fact the card can read rather than a fingerprint. It is
   * deliberately NOT part of `stepHash`: a capture that vanished already moves
   * the stamp and resets the tick, and adding a second input would have
   * invalidated every tick on disk the moment this shipped.
   *
   * It exists because a path with no file behind it defeated every check here.
   * `missingShots` asked only whether a path was given, so a step declaring
   * `"afterShot": "qa-5505/after-3.png"` and never writing the file passed
   * clean: no warning, nothing to accept, and a card that rendered the browser's
   * own broken-image icon with no words anywhere near it. On seeing a whole
   * click-script of them, the operator reported that the screenshots simply do
   * not appear and that they end up asking for the evidence step by step, which
   * happens far too often to be a one-off.
   *
   * Absent (an older snapshot, or a step no scan has stamped) reads as `[]` —
   * nothing known to be gone. The console must not accuse a worker on the
   * strength of a file it never looked for.
   */
  goneShots?: Array<'before' | 'after'>;
};

export type ManualQa = {
  /** The running app. Null when the worker gave something we refuse to link. */
  appUrl: string | null;
  /** The documented shared local-dev account. Rendered for copying; the console
   *  never types it anywhere, and nothing but a localhost app is ever linked. */
  login: { email: string; password: string } | null;
  /** The state the operator starts from. Renames v1's `preState`, which is still
   *  read. */
  start: string | null;
  steps: ManualQaStep[];
  /**
   * How many entries in `steps` this parser could not use.
   *
   * A dropped step is invisible on the card, and Approve counts the steps it can
   * see — so a worker that emits five steps with an empty `do` on the fourth gets
   * a gate that passes on 4/5 of its own QA with nobody ever told there was a
   * fifth. The parser still drops it (a step with no instruction cannot be
   * followed), but the count leaves with the script and the card locks on it.
   */
  dropped: number;
  /** Legacy only. A v2 worker writes no edge cases — anything worth trying is a
   *  step, because only a step can be ticked. Rendered, never gated. */
  edgeCases: string[];
};

/** One step that came back without a capture it owed, and which leg(s) are gone.
 *
 *  `gone` is the subset of `legs` that NAMED a file which is not there, as
 *  opposed to naming nothing at all. Both are the same failure to the operator —
 *  they cannot see the evidence — but only the second is a worker that forgot to
 *  write the field, and the message that goes back has to say which it was.
 *  Present only when it is non-empty, so a step short of a path reads exactly as
 *  it always did. */
export type MissingShot = { id: number; legs: Array<'before' | 'after'>; gone?: Array<'before' | 'after'> };

/**
 * WHICH STEPS CAME BACK WITHOUT THE PICTURES THEY OWE.
 *
 * The operator's rule: both the after capture and the before capture are
 * required, unless there is genuinely no before to show — a new feature. So the
 * rule is two lines long and has exactly one exception:
 *
 *  - `afterShot` is required on every step, with no exception. A step with no
 *    after capture is a claim about what the app does now with nothing behind
 *    it, and it is the half that is always capturable — the change is in front
 *    of the worker as it writes.
 *  - `beforeShot` is required on every step that SAYS what it used to do. The
 *    exception is the pair `"before": null` with `"beforeShot": null`, which is
 *    the gate file's way of saying the behaviour is genuinely new and there was
 *    nothing there to photograph. That pair IS the statement, and the card
 *    prints "New — nothing to compare" for it.
 *
 * A step that names a prior behaviour and shows no picture of it is the case
 * this catches: the operator is asked to take the before on trust, which is the
 * one thing screenshots exist to stop. What comes back from here locks Approve,
 * on the card and again in `approveGateC`.
 *
 * The `ui/src/gate-c.ts` copy of this rule is the same rule for the button's
 * label; `gate-c-missing-shots.test.ts` runs both over one table.
 */
export function missingShots(steps: ManualQaStep[]): MissingShot[] {
  const out: MissingShot[] = [];
  for (const step of steps) {
    // A path that names no file owes the same picture as no path at all. See
    // `ManualQaStep.goneShots`: the console has stat'd both legs on every scan
    // since they were fetched and this rule was the one place not asking.
    const gone = step.goneShots ?? [];
    const legs: Array<'before' | 'after'> = [];
    // `before` non-null is the step's own claim that there WAS a prior state.
    if ((step.beforeShot === null && step.before !== null) || gone.includes('before')) legs.push('before');
    if (step.afterShot === null || gone.includes('after')) legs.push('after');
    if (legs.length > 0) {
      // `gone` can never name a leg the step left null — the scan skips a null
      // path — so the new-behaviour exception above is untouched by it.
      const absent = legs.filter((l) => gone.includes(l));
      out.push(absent.length > 0 ? { id: step.id, legs, gone: absent } : { id: step.id, legs });
    }
  }
  return out;
}

/**
 * The missing captures as one sentence — the same words in the button's label
 * and in the server's refusal, so a refused click reads as the sentence the
 * operator would have seen had the page been a moment fresher.
 */
export function missingShotsLine(missing: MissingShot[]): string {
  if (missing.length === 0) return '';
  if (missing.length > 1) {
    return `${missing.length} steps are missing screenshots (${missing.map((m) => m.id).join(', ')})`;
  }
  const one = missing[0]!;
  const legs = one.legs.length === 2 ? 'its before and after screenshots' : `its "${one.legs[0]}" screenshot`;
  return `step ${one.id} is missing ${legs}`;
}

/** localhost, or the same thing by number. Nothing else is ever a link. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * A url we are willing to put an href on, or null.
 *
 * `new URL` is the parser rather than a regex on purpose: `http://localhost@evil.example/`
 * and `http://localhost.evil.example/` both begin with the right characters and
 * neither is this machine. Only the parsed HOSTNAME is consulted.
 */
export function localUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!LOCAL_HOSTS.has(u.hostname)) return null;
  return raw;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * A screenshot path we are willing to render, or null.
 *
 * The same fence the evidence manifest uses, for the same reason: these paths go
 * straight into an `<img src>` pointed at the evidence route, and a step is a
 * place a worker could write `../../.ssh/id_rsa`. The route refuses it too — this
 * is the manifest-time half, so a path that could never be served is never shown
 * as a broken image either.
 */
const shot = (v: unknown): string | null => {
  const p = str(v);
  return p !== null && isUnderPlansRoot(p) ? p : null;
};

const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;

/**
 * Parse the `manualQa` block out of a raw `.gate.json`. Tolerant like
 * `parseEvidence`: never throws, drops what it cannot trust, and keeps the rest
 * so a partly-malformed script is still usable rather than invisible.
 *
 * THE RULE THAT MATTERS: only the nine named step fields are read. A worker
 * writing `"verified": true`, `"status": "verified"` or anything else
 * verdict-shaped gets it silently ignored, because the tick is the operator's
 * and lives in the console's own state file where no worker can reach it. This
 * parser is
 * the first of the four walls around that — a worker cannot smuggle a tick
 * through the file it does own.
 */
export function parseManualQa(raw: unknown): ManualQa | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  let login: ManualQa['login'] = null;
  if (typeof r.login === 'object' && r.login !== null) {
    const l = r.login as Record<string, unknown>;
    if (typeof l.email === 'string' && typeof l.password === 'string') {
      login = { email: l.email, password: l.password };
    }
  }

  const steps: ManualQaStep[] = [];
  let dropped = 0;
  if (Array.isArray(r.steps)) {
    // The usable steps first, each still carrying whatever id it asked for.
    const usable: Array<{ want: number | null; index: number; step: Omit<ManualQaStep, 'id'> }> = [];
    r.steps.forEach((item, index) => {
      if (typeof item !== 'object' || item === null) {
        dropped += 1;
        return;
      }
      const s = item as Record<string, unknown>;
      // `do` is the documented name. `action` is read too, for the same reason
      // `expected` is read as `after` below: #4546's worker wrote six sound
      // steps under that synonym and every one was thrown away, leaving the
      // operator a card that said both "no steps" and "6 malformed" and told
      // them to ask again without saying what was wrong. A step whose only
      // defect is which
      // word names the instruction is not malformed — it is the same step.
      // Still safe under this file's governing rule: only instruction-shaped
      // fields are ever read, never anything verdict-shaped.
      const what = str(s.do) ?? str(s.action);
      if (!what) {
        dropped += 1; // a step with no instruction is not a step
        return;
      }
      usable.push({
        want: int(s.id),
        index,
        step: {
          rev: int(s.rev) ?? 1,
          do: what,
          url: localUrl(s.url),
          before: str(s.before),
          beforeShot: shot(s.beforeShot),
          // A v1 step ({do,url,before,expected}) parses as a v2 step with
          // `expected` read as `after`, so #4404's gate file still renders.
          after: str(s.after) ?? str(s.expected),
          afterShot: shot(s.afterShot),
          fix: str(s.fix),
          shotStamp: null, // stamped by the scan; see ManualQaStep.shotStamp
        },
      });
    });

    /**
     * IDS ARE CLAIMED BEFORE ANY GAP IS FILLED, and that order is the whole
     * point. The operator's ticks hang on the id, so an id that moves takes a
     * tick with it. Walking up from a collision in one pass cascaded: a worker
     * whose merge copy-pasted step 1 gave the duplicate id 2, which pushed the
     * real step 2 to 3 and the real step 3 to 4 — so every step after the
     * duplicate came back holding the previous step's identity, resolved to
     * unset, and the operator silently redid QA they had already done. Two passes
     * keep the blast radius of a copy-paste to the copy-paste itself.
     *
     * A step is still never dropped for a bad id: it is a step the operator
     * cannot see and therefore cannot check, and an unticked extra step LOCKS the
     * gate, which is the safe direction. Only the duplicate moves.
     */
    const owner = new Map<number, number>();
    usable.forEach((u, i) => {
      if (u.want !== null && !owner.has(u.want)) owner.set(u.want, i);
    });
    const taken = new Set(owner.keys());
    usable.forEach((u, i) => {
      let id: number;
      if (u.want !== null && owner.get(u.want) === i) {
        id = u.want; // its own id, claimed in the first pass
      } else {
        id = u.want ?? u.index + 1;
        while (taken.has(id)) id += 1;
        taken.add(id);
      }
      steps.push({ id, ...u.step });
    });
  }

  return {
    appUrl: localUrl(r.appUrl),
    login,
    start: str(r.start) ?? str(r.preState),
    steps,
    dropped,
    edgeCases: Array.isArray(r.edgeCases) ? r.edgeCases.filter((e): e is string => typeof e === 'string') : [],
  };
}
