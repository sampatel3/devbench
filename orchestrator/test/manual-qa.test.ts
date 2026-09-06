/**
 * The click-script the console RENDERS AS LINKS — which is the whole reason this
 * needs a fence.
 *
 * The operator's complaint was that the click-script was referenced and
 * unreachable, so the fix is real anchors they can click. That turns a field a
 * worker writes into a link a person is told to follow, and a worker reads issue
 * text, PR comments and web pages. A `https://evil.example/login` in `appUrl`
 * under the heading "sign in here" is a phishing link the console itself asked
 * them to click.
 *
 * So: the app under QA is the LOCAL dev server or it is not a link at all. The
 * text is always kept — an unlinkable url is shown as plain text, never dropped
 * silently, because a step the operator cannot see is a step they cannot check.
 *
 * v2 adds the second fence and the second rule. The fence: screenshot paths are
 * `<img src>` pointed at the evidence route, so they pass the same plans-root
 * check the evidence manifest does. The rule: the ONLY fields read are the nine
 * named ones, because a tick is the operator's and a worker must not be able to
 * write one into the file it owns.
 */
import { describe, it, expect } from 'vitest';
import { parseManualQa } from '../src/manual-qa.js';

const QA = 'docs/issue-pipeline/plans/qa-4336';

const WELL_FORMED = {
  appUrl: 'http://localhost:8106',
  login: { email: 'sysadmin@localdev.test', password: 'localdev123!' },
  start: 'any org with more than one member',
  steps: [
    {
      id: 1,
      rev: 1,
      do: 'Click Organisations in the left nav',
      url: 'http://localhost:8106/organisations',
      // v3. `url` is the thing the operator clicks; `route` is the path the console
      // drives to when it takes the screenshots itself.
      route: '/organisations',
      before: 'the filter pills were shown to every admin',
      beforeShot: `${QA}/s1-before.png`,
      after: 'the pills are there only as system_admin',
      afterShot: `${QA}/s1-after.png`,
    },
  ],
};

describe('parseManualQa', () => {
  it('keeps a well-formed block whole', () => {
    const qa = parseManualQa(WELL_FORMED)!;
    expect(qa.appUrl).toBe('http://localhost:8106');
    expect(qa.login).toEqual({ email: 'sysadmin@localdev.test', password: 'localdev123!' });
    expect(qa.start).toBe('any org with more than one member');
    expect(qa.steps).toHaveLength(1);
    expect(qa.steps[0]).toEqual({
      id: 1,
      rev: 1,
      do: 'Click Organisations in the left nav',
      url: 'http://localhost:8106/organisations',
      route: '/organisations',
      before: 'the filter pills were shown to every admin',
      beforeShot: `${QA}/s1-before.png`,
      after: 'the pills are there only as system_admin',
      afterShot: `${QA}/s1-after.png`,
      fix: null,
      // Always null out of the parser: it is stamped by the worktree scan, which
      // is the only place that can read a file. A worker writing one into
      // `.gate.json` is ignored exactly like a verdict-shaped key.
      shotStamp: null,
    });
  });

  it('accepts 127.0.0.1 as the same machine', () => {
    expect(parseManualQa({ ...WELL_FORMED, appUrl: 'http://127.0.0.1:8106/' })!.appUrl).toBe('http://127.0.0.1:8106/');
  });

  it('REFUSES an off-machine appUrl — the phishing fence', () => {
    const qa = parseManualQa({ ...WELL_FORMED, appUrl: 'https://evil.example/login' })!;
    expect(qa.appUrl).toBeNull();
    // and the rest of the script survives, so the omission is visible
    expect(qa.steps).toHaveLength(1);
  });

  it('REFUSES a javascript: step url — no scriptable href ever reaches the card', () => {
    const qa = parseManualQa({
      ...WELL_FORMED,
      steps: [{ do: 'Click the thing', url: 'javascript:alert(1)', after: 'boom' }],
    })!;
    expect(qa.steps[0]!.url).toBeNull();
    expect(qa.steps[0]!.do).toBe('Click the thing'); // the instruction is still readable
  });

  /**
   * `route` is what the CONSOLE drives a browser to, so an unsafe one is worse
   * than an unsafe `url`: nobody has to click it. The step survives with a null
   * route, which means "not drivable" and puts it back under exactly the rules
   * it had before routes existed. The fence itself is `qaRoute`, exercised in
   * full by capture.test.ts; this is the wiring.
   */
  it('REFUSES a route that is not a path on this machine, and keeps the step', () => {
    const qa = parseManualQa({
      steps: [
        { do: 'Open the list', route: 'http://evil.example/steal', after: 'it is there' },
        { do: 'Open the other list', route: '//evil.example/steal', after: 'it is there' },
        { do: 'Open a third', route: '/quotes/1234', after: 'it is there' },
      ],
    })!;
    expect(qa.steps[0]!.route).toBeNull();
    expect(qa.steps[1]!.route).toBeNull();
    expect(qa.steps[2]!.route).toBe('/quotes/1234');
    expect(qa.steps[0]!.do).toBe('Open the list'); // the instruction stands
  });

  it('REFUSES a look-alike host that only starts with localhost', () => {
    expect(parseManualQa({ ...WELL_FORMED, appUrl: 'http://localhost.evil.example/x' })!.appUrl).toBeNull();
    expect(parseManualQa({ ...WELL_FORMED, appUrl: 'http://localhost@evil.example/x' })!.appUrl).toBeNull();
  });

  it('REFUSES a file: url', () => {
    expect(parseManualQa({ ...WELL_FORMED, appUrl: 'file:///etc/passwd' })!.appUrl).toBeNull();
  });

  /**
   * The shots go straight into an `<img src>` on the evidence route, so a step
   * is a place a worker could point at anything on disk. Same fence, same rule.
   */
  it('REFUSES a screenshot path outside the plans tree, and keeps the step', () => {
    const qa = parseManualQa({
      steps: [
        {
          do: 'Look at it',
          beforeShot: '../../../.ssh/id_rsa',
          afterShot: '/etc/passwd',
          after: 'it is there',
        },
      ],
    })!;
    expect(qa.steps[0]!.beforeShot).toBeNull();
    expect(qa.steps[0]!.afterShot).toBeNull();
    expect(qa.steps[0]!.after).toBe('it is there'); // the words stand; only the src is refused
  });

  /**
   * THE OWNERSHIP RULE. Verdicts live in the console's own state file. If a
   * worker could write one here it could tick its own homework, and the gate
   * would be asserting that the operator checked something they never saw.
   */
  it('IGNORES anything verdict-shaped a worker writes on a step', () => {
    const qa = parseManualQa({
      steps: [
        {
          id: 1,
          rev: 1,
          do: 'Open Organisations',
          verified: true,
          status: 'verified',
          verdict: 'passed',
          checked: true,
          tickedBy: 'operator',
          // Not verdict-shaped, but on the same rule: the parser cannot read a
          // file, so it always writes null here and the scan stamps it after.
          shotStamp: 'a worker cannot fingerprint its own screenshots',
        },
      ],
    })!;
    expect(Object.keys(qa.steps[0]!).sort()).toEqual(
      ['after', 'afterShot', 'before', 'beforeShot', 'do', 'fix', 'id', 'rev', 'route', 'shotStamp', 'url'].sort(),
    );
    expect(qa.steps[0]!.shotStamp).toBeNull();
    expect(JSON.stringify(qa)).not.toContain('verified');
  });

  it('reads a v1 gate file — #4404 still renders on the new card', () => {
    // The legacy adapter: `expected` is the old name for `after`, `preState` for
    // `start`, and a v1 step has no id or rev at all.
    const qa = parseManualQa({
      appUrl: 'http://localhost:8106',
      preState: 'a quote in Sent',
      steps: [
        { do: 'Withdraw it', url: 'http://localhost:8106/quotes', before: 'no warning', expected: 'it asks first' },
        { do: 'Try to accept it', expected: 'Accept is gone' },
      ],
      edgeCases: ['empty reason'],
    })!;
    expect(qa.start).toBe('a quote in Sent');
    expect(qa.steps.map((s) => s.id)).toEqual([1, 2]);
    expect(qa.steps.map((s) => s.rev)).toEqual([1, 1]);
    expect(qa.steps[0]!.after).toBe('it asks first');
    expect(qa.steps[0]!.beforeShot).toBeNull();
    expect(qa.edgeCases).toEqual(['empty reason']); // rendered, never gated
  });

  it('keeps ids unique, so two steps can never share one tick', () => {
    const qa = parseManualQa({
      steps: [
        { id: 1, do: 'first' },
        { id: 1, do: 'second' },
        { id: 1, do: 'third' },
      ],
    })!;
    expect(qa.steps.map((s) => s.id)).toEqual([1, 2, 3]);
    expect(qa.steps.map((s) => s.do)).toEqual(['first', 'second', 'third']); // nothing dropped
  });

  /**
   * ONE duplicated id must not move any OTHER step's id.
   *
   * The ids are what the operator's ticks hang on. A worker's merge that
   * copy-pastes step 1 twice used to cascade — the dup took 2, which pushed the
   * real step 2 to 3 and the real step 3 to 4 — so every step after the duplicate
   * came back holding another step's tick, resolved to unset, and the operator
   * redid QA they had already done with no message of any kind. Ids are claimed
   * first, gaps are filled after, so the blast radius of a copy-paste is the
   * copy-paste.
   */
  it('does not renumber the steps AFTER a duplicated id', () => {
    const qa = parseManualQa({
      steps: [
        { id: 1, rev: 1, do: 'Withdraw a sent quote' },
        { id: 1, rev: 1, do: 'Withdraw a sent quote' }, // the worker's fumbled merge
        { id: 2, rev: 1, do: 'Try to accept it' },
        { id: 3, rev: 1, do: 'Confirm with an empty reason' },
      ],
    })!;
    // Every step that HAS an id of its own keeps it, in the order it was written.
    expect(qa.steps.map((s) => [s.id, s.do])).toEqual([
      [1, 'Withdraw a sent quote'],
      [4, 'Withdraw a sent quote'], // only the duplicate moves
      [2, 'Try to accept it'],
      [3, 'Confirm with an empty reason'],
    ]);
  });

  /**
   * A step the parser could not use is a step the operator will never tick — so
   * the count has to leave the parser with the script. Silently rendering four
   * of five steps is a QA half that passes on 4/5 of itself.
   */
  it('counts the steps it had to drop, so a short script is never silent', () => {
    const qa = parseManualQa({
      steps: [{ do: 'Log in' }, { do: '' }, { url: 'http://localhost:8106' }, 'not a step'],
    })!;
    expect(qa.steps).toHaveLength(1);
    expect(qa.dropped).toBe(3);
    expect(parseManualQa({ steps: [{ do: 'Log in' }] })!.dropped).toBe(0);
  });

  it('is tolerant of everything else a worker can get wrong, and never throws', () => {
    expect(parseManualQa(undefined)).toBeNull();
    expect(parseManualQa(null)).toBeNull();
    expect(parseManualQa('a click script')).toBeNull();
    const bare = parseManualQa({})!;
    expect(bare.appUrl).toBeNull();
    expect(bare.login).toBeNull();
    expect(bare.start).toBeNull();
    expect(bare.steps).toEqual([]);
    expect(bare.edgeCases).toEqual([]);
    const messy = parseManualQa({ steps: 'not an array', edgeCases: [1, 'kept', null], login: { email: 5 } })!;
    expect(messy.steps).toEqual([]);
    expect(messy.edgeCases).toEqual(['kept']);
    expect(messy.login).toBeNull();
    const mangled = parseManualQa({ steps: [{ do: 'go', id: 'four', rev: -2 }] })!;
    expect(mangled.steps[0]).toMatchObject({ id: 1, rev: 1 });
  });

  it('drops a step with nothing to do, and keeps a step with only an instruction', () => {
    const qa = parseManualQa({ steps: [{ url: 'http://localhost:8106' }, { do: 'Log in' }] })!;
    expect(qa.steps).toHaveLength(1);
    expect(qa.steps[0]).toEqual({
      id: 2, // its position — ids are never renumbered to close a gap
      rev: 1,
      do: 'Log in',
      url: null,
      route: null,
      before: null,
      beforeShot: null,
      after: null,
      afterShot: null,
      fix: null,
      // Always null out of the parser: it is stamped by the worktree scan, which
      // is the only place that can read a file. A worker writing one into
      // `.gate.json` is ignored exactly like a verdict-shaped key.
      shotStamp: null,
    });
  });

  it('says a genuinely new behaviour with a null pair, not with prose', () => {
    const qa = parseManualQa({ steps: [{ do: 'Open the new tab', after: 'the tab is there' }] })!;
    expect(qa.steps[0]!.before).toBeNull();
    expect(qa.steps[0]!.beforeShot).toBeNull();
  });
});

/**
 * At one gate C the card said both "The click-script has no steps" and "6 steps
 * came back malformed", which cannot both be the useful thing to know, and the
 * operator asked what had happened.
 *
 * The worker had written six perfectly good steps and keyed the instruction
 * `action` instead of `do`. Every other field it wrote parsed. So six real
 * pieces of QA were thrown away over a synonym, and the operator was told to ask
 * for it again with nothing said about what was wrong — a re-ask that could
 * easily come back identical.
 *
 * `do` stays the documented name. This is the same tolerance the parser already
 * extends to v1's `expected` (read as `after`): a step whose only defect is
 * which word names the instruction is not malformed, it is the same step. It
 * stays safe under this file's governing rule — only instruction-shaped fields
 * are read, never anything verdict-shaped, because the tick is the operator's
 * alone.
 */
describe('an instruction under a synonym is still an instruction', () => {
  it('reads `action` as `do`, the way it already reads `expected` as `after`', () => {
    const qa = parseManualQa({
      appUrl: 'http://localhost:8084',
      steps: [
        { id: 1, rev: 1, action: 'Open the quote package', after: 'v10.1 is shown' },
        { id: 2, rev: 1, action: 'Click the version button', after: 'the list opens' },
      ],
    });
    expect(qa).not.toBeNull();
    expect(qa!.dropped).toBe(0);
    expect(qa!.steps).toHaveLength(2);
    expect(qa!.steps[0]!.do).toBe('Open the quote package');
  });

  it('still drops a step that names no instruction at all', () => {
    // The tolerance is for a synonym, not for a step with nothing to do.
    const qa = parseManualQa({ appUrl: 'http://localhost:8084', steps: [{ id: 1, after: 'something' }] });
    expect(qa!.dropped).toBe(1);
    expect(qa!.steps).toHaveLength(0);
  });

  it('prefers `do` when a worker writes both', () => {
    const qa = parseManualQa({
      appUrl: 'http://localhost:8084',
      steps: [{ id: 1, do: 'the real one', action: 'the other' }],
    });
    expect(qa!.steps[0]!.do).toBe('the real one');
  });
});
