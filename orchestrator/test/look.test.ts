/**
 * What a row LOOKS like — the chip's colour class and the rail's left edge.
 *
 * The ask: colour-code the pills and the issue cards on a system good enough
 * that opening the console makes each row's status, and what is actively
 * happening on it, obvious at a glance.
 *
 * Two facts drove the whole design, both found by reading what the page does
 * today rather than by designing something new:
 *
 *   1. SEVEN of the sixteen statuses got no colour at all — they fell through
 *      the Chip's ternary to `''`. Two of those, `checkpoint` and `detached`,
 *      are work that STOPPED and will never restart itself, and they rendered
 *      pixel-identical to `queued` and `pr-open`, which need nothing from
 *      the operator.
 *   2. The rail's orange left edge was `.rail-item.on.gate` — it required the
 *      row to be SELECTED. So the edge that says "this one is asking you
 *      something" only appeared after the row had already been clicked. Backwards.
 *
 * So: one hue per meaning, no new hues, and the edge answers exactly one
 * question — is this row asking something of me right now?
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chipClass, edgeClass } from '../../ui/src/look.js';
import type { WorkerStatus } from '../../ui/src/types.js';

const row = (status: WorkerStatus, extra: Record<string, unknown> = {}) =>
  ({ status, uatFail: null, waiting: null, parked: null, ...extra }) as Parameters<typeof edgeClass>[0];

/** The operator set it aside, at 10:00 on 17 Aug, with or without saying why. */
const PARKED = (reason: string | null = 'waiting for the design call') => ({ at: '2026-08-17T10:00:00Z', reason });

describe('chipClass — one hue per meaning', () => {
  it('paints the four gates orange: the console is holding a question', () => {
    for (const s of ['at-gate', 'awaiting-post', 'reply-received', 'rework'] as WorkerStatus[]) {
      expect(chipClass(row(s))).toBe('gate');
    }
  });

  it('paints work that STOPPED, which used to be indistinguishable from work that is fine', () => {
    // The headline gap. Both are in STOPPED — "nobody is working these any more,
    // so they are on the operator again" — and both rendered as plain grey text.
    expect(chipClass(row('checkpoint'))).toBe('held');
    expect(chipClass(row('detached'))).toBe('held');
  });

  it('does NOT reuse the paused chip for them, because the square would be a lie', () => {
    // `.chip.paused` carries a solid square documented as the still-counterpart
    // to the live pulse: frozen with SIGSTOP, nothing lost, one click resumes.
    // A checkpoint holds no frozen process and a detached worker is gone. Same
    // colour, different class, no square.
    expect(chipClass(row('paused'))).toBe('paused');
    expect(chipClass(row('checkpoint'))).not.toBe('paused');
  });

  it('shows a machine moving right now, including while the worktree is being built', () => {
    expect(chipClass(row('active'))).toBe('active');
    expect(chipClass(row('preparing'))).toBe('active');
  });

  it('keeps merged green: that one is a fact off GitHub, not an inference', () => {
    // `pr-merged` sinks in the ORDER because QA picks merged work up unasked —
    // six for six. But that is an inference from one repo's habit, and the sort
    // is where it belongs. The chip states the verified fact instead: it landed.
    // Spending BOTH surfaces on the same inference would leave nothing telling
    // the truth if QA's habit ever changed.
    expect(chipClass(row('pr-merged'))).toBe('merged');
  });

  it('leaves grey to mean exactly one thing: somebody else is moving it', () => {
    // `blocked` used to be in this list. It gets the paused treatment instead,
    // so an incomplete-and-waiting row reads as one: a comment sitting
    // unanswered by a named person and a PR under active review
    // by a codeowner team are opposites, and they rendered identically. Grey now
    // means only the healthy one: it is moving, without you.
    // `pr-open` used to be in this list. It came out because the one true
    // sentence covered two unlike states: `queued` has not started and is
    // waiting for a slot HERE, while an open PR is finished and waiting on the
    // team lead. Grey keeps the first; violet took the second.
    for (const s of ['queued'] as WorkerStatus[]) {
      expect(chipClass(row(s))).toBe('');
    }
    expect(chipClass(row('pr-open'))).toBe('handover');
  });

  it('fades what is finished and what has not started', () => {
    expect(chipClass(row('no-worker'))).toBe('none');
    expect(chipClass(row('done'))).toBe('none');
  });

  it('has no fall-through left: every one of the 16 gets a decided class', () => {
    // The bug this whole change fixes was a `: ''` default nobody had revisited.
    // '' is now a CHOICE (grey = someone else's) rather than a leftover, so the
    // test names all sixteen and the map is closed.
    const all: WorkerStatus[] = [
      'no-worker', 'preparing', 'queued', 'active', 'paused', 'at-gate',
      'awaiting-post', 'blocked', 'reply-received', 'rework', 'detached',
      'pr-open', 'pr-merged', 'done', 'checkpoint', 'failed',
    ];
    const seen = all.map((s) => [s, chipClass(row(s))] as const);
    expect(seen.filter(([, c]) => c === '').map(([s]) => s)).toEqual(['queued']);
  });
});

/**
 * PARKED AND BLOCKED — one treatment, two states, and a third kept apart.
 *
 * The ask, in three parts: a ticket can be paused where it stands, staying at
 * its gate but out of the top of the queue and visibly paused; `blocked` gets
 * the same treatment, because both are incomplete and waiting; and neither is
 * the same thing as waiting on external review or input, such as an open PR
 * awaiting review and merge.
 *
 * The third requirement is the one that is easy to lose: an open PR is
 * PROGRESSING WITHOUT THE OPERATOR. It is not stalled and it must not be dressed
 * as stalled.
 */
describe('parked and blocked share one look, and an open PR does not', () => {
  it('paints a parked row aside — whatever its status underneath', () => {
    // Every status the operator might park one at. The treatment is the row's,
    // not the status's, so it has to survive all of them.
    for (const s of ['at-gate', 'checkpoint', 'no-worker', 'active', 'pr-open', 'rework'] as WorkerStatus[]) {
      expect(chipClass(row(s, { parked: PARKED() }))).toBe('aside');
      expect(edgeClass(row(s, { parked: PARKED() }))).toBe('aside');
    }
  });

  it('gives blocked the SAME class — that is the ask, in one line', () => {
    expect(chipClass(row('blocked'))).toBe('aside');
    expect(edgeClass(row('blocked'))).toBe('aside');
  });

  it('does NOT give it to an open PR, which is moving without the operator', () => {
    // `waiting.ts` splits `on` (other people) from `yours` and `blocker.ts`
    // works out who actually holds the merge. Flattening pr-open into the
    // stalled class would throw both away.
    // Its own colour now, and still not the stalled one — which is the point
    // this test was always making: "awaiting merge" and "stalled on a person who
    // owes a reply" are different facts and must not share a look.
    expect(chipClass(row('pr-open'))).toBe('handover');
    expect(edgeClass(row('pr-open', { waiting: { on: 'the codeowner team', note: null, yours: [] } }))).toBe('');
    expect(chipClass(row('pr-merged'))).toBe('merged');
  });

  it('beats the orange gate edge, because the ORDER has already sunk the row', () => {
    // The edge must read what the sort reads. A parked row sitting at the
    // bottom of the list while its edge shouts orange is the two-panels
    // disagreement `waiting.ts` was written to end.
    expect(edgeClass(row('at-gate'))).toBe('gate');
    expect(edgeClass(row('at-gate', { parked: PARKED() }))).toBe('aside');
  });

  it('beats the red send-back edge too, for the same reason', () => {
    const sentBack = { by: 'qa-alice', at: '2026-08-10T09:00:00Z', verdict: 'Fail' as const, url: 'x' };
    expect(edgeClass(row('pr-merged', { uatFail: sentBack }))).toBe('uat');
    expect(edgeClass(row('pr-merged', { uatFail: sentBack, parked: PARKED() }))).toBe('aside');
  });

  it('treats a MISSING parked field as not parked, never as parked', () => {
    // A rebuilt `ui/dist` talking to a server that has not restarted sends rows
    // with no `parked` key at all. `!= null` is what stops the whole board going
    // grey at once — the same guard `uatFail` carries.
    const old = { status: 'at-gate', uatFail: null, waiting: null } as Parameters<typeof edgeClass>[0];
    expect(chipClass(old)).toBe('gate');
    expect(edgeClass(old)).toBe('gate');
  });

  it('records a reason when one was given, and is fine when it was not', () => {
    expect(chipClass(row('at-gate', { parked: PARKED(null) }))).toBe('aside');
    expect(chipClass(row('at-gate', { parked: PARKED('waiting on the design call') }))).toBe('aside');
  });
});

describe('edgeClass — the one question the left edge answers', () => {
  it('shows the orange edge WITHOUT the row being selected', () => {
    // The crux. `.rail-item.on.gate` needed both classes, so the edge only ever
    // appeared on the row already opened.
    expect(edgeClass(row('at-gate'))).toBe('gate');
  });

  it('marks stopped work too, not just the gates', () => {
    // These are the rows the header already counts as "waiting on you".
    for (const s of ['checkpoint', 'failed', 'detached'] as WorkerStatus[]) {
      expect(edgeClass(row(s))).toBe('gate');
    }
  });

  it('leaves work that moves on its own unmarked', () => {
    // `blocked` has left this list too — it does not move on its own, which is
    // the whole reason it now shares the parked treatment. The three that stay
    // are the ones somebody else or something else is actually advancing.
    for (const s of ['active', 'queued', 'pr-open', 'pr-merged', 'preparing'] as WorkerStatus[]) {
      expect(edgeClass(row(s))).toBe('');
    }
  });

  it('does not mark the unstarted backlog — available is not the same as asking', () => {
    // `no-worker` is every newly assigned issue in the repo. Edging them all
    // would turn the signal into wallpaper.
    expect(edgeClass(row('no-worker'))).toBe('');
  });

  /**
   * The edge must read the SAME input the list order reads, or the two disagree
   * on one screen. `isElsewhere` in priority.ts already exempts an open PR whose
   * `waiting.yours` is non-empty — that row does NOT sink, so it can sit high in
   * the list while its own card reads "Not ticked on PR #4547". Without this the
   * position says "yours" and the colour says "not yours".
   */
  it('marks an open PR the console says is holding items of the operator’s', () => {
    const mine = row('pr-open', { waiting: { on: null, note: null, yours: [{ text: 'Not ticked: screenshots', detail: null, url: null }] } });
    expect(edgeClass(mine)).toBe('gate');
  });

  it('leaves an open PR with nothing of the operator’s unmarked', () => {
    const theirs = row('pr-open', { waiting: { on: 'the codeowner team', note: null, yours: [] } });
    expect(edgeClass(theirs)).toBe('');
  });

  it('a UAT send-back outranks every other edge', () => {
    const sentBack = row('at-gate', { uatFail: { by: 'qa-alice', at: '2026-08-10T09:00:00Z', verdict: 'Fail', url: 'u' } });
    expect(edgeClass(sentBack)).toBe('uat');
  });

  it('a Pass verdict is not a send-back, so the edge falls back to the status', () => {
    const passed = row('at-gate', { uatFail: { by: 'qa-alice', at: '2026-08-10T09:00:00Z', verdict: 'Pass', url: 'u' } });
    expect(edgeClass(passed)).toBe('gate');
  });

  it('never edges a closed issue', () => {
    expect(edgeClass(row('done'))).toBe('');
  });
});

/**
 * The CASCADE, measured rather than assumed.
 *
 * `chipClass` and `edgeClass` above decide which class a row gets. This decides
 * whether that class survives contact with the stylesheet, and there is exactly
 * one place it might not: `.rail-item.on` and `.rail-item.aside` have the SAME
 * specificity (0,2,0) and both set `box-shadow`, so the only thing separating
 * them is source order. Get it backwards and a parked row loses its cold edge
 * the moment it is clicked — which is the moment somebody is looking at it.
 *
 * Measured in a browser against the built stylesheet before this was written:
 * `.rail-item.aside` computes `rgb(85,103,122) 2px inset` at opacity 0.72, and
 * `.on.aside` computes 4px at opacity 1. This test is the lock on that.
 */
describe('the parked treatment survives the cascade', () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'src', 'styles.css'),
    'utf8',
  );
  const at = (selector: string) => css.indexOf(selector);

  it('declares an edge and a fade for the shared class, and a selected variant', () => {
    expect(at('.rail-item.aside {')).toBeGreaterThan(-1);
    expect(at('.rail-item.on.aside {')).toBeGreaterThan(-1);
    expect(at('.chip.aside {')).toBeGreaterThan(-1);
  });

  it('puts .rail-item.aside AFTER .rail-item.on — equal specificity, order decides', () => {
    expect(at('.rail-item.aside {')).toBeGreaterThan(at('.rail-item.on {'));
  });

  it('fades it far less than a closed row: parked is work the operator is coming back to', () => {
    const aside = css.slice(at('.rail-item.aside {')).split('}')[0]!;
    const finished = css.slice(at('.rail-item.finished {')).split('}')[0]!;
    expect(aside).toContain('opacity: 0.72');
    expect(finished).toContain('opacity: 0.62');
  });

  it('uses the palette\'s existing cold slate rather than a new hue', () => {
    // `--ice` is already documented as "icebox, a paused worker, and a worktree
    // with nothing running in it". Parked and blocked mean the same thing.
    const aside = css.slice(at('.rail-item.aside {')).split('}')[0]!;
    expect(aside).toContain('var(--ice)');
  });
});
