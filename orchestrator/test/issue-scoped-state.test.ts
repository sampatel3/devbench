import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * A card must not carry one issue's text onto another.
 *
 * On 2026-08-13 the rework card handed #4404's worker the pr-swarm review for
 * #4344 / PR #4535 — a rework approved on one PR, started against another. The
 * operator did nothing wrong: they pressed the button on the card in front of
 * them, and the box had been filled while a different issue was open.
 *
 * The cards under Detail are not remounted per issue — the per-issue `key` was
 * removed on 2026-08-12 to stop a card stacking — so a `useState` seeded from
 * props keeps the FIRST issue's value for ever. The same leak had already been
 * found once, on PostMergeCard, and was patched there and nowhere else. Six other
 * seeds had it. Two of them carried text that gets SENT: the rework brief, and
 * the comment body posted to GitHub under the operator's name.
 *
 * So this is a grep, and it is deliberately blunt. Anything seeded from `row`,
 * `req`, `round`, `pr` or `block` goes through `useIssueState`, whose whole job
 * is to re-seed when the issue changes.
 */
const APP = readFileSync(new URL('../../ui/src/App.tsx', import.meta.url), 'utf8');

/** `const [x, setX] = useState(<init>);` — the seed sites, with their initialiser. */
const SEEDS = [...APP.matchAll(/const \[(\w+), (set\w+)\] = useState(?:<[^>]*>)?\(([^\n]*?)\);/g)].map((m) => ({
  name: m[1]!,
  setter: m[2]!,
  init: m[3]!,
  at: m.index ?? 0,
}));

/**
 * The other honest way to hold per-issue state: seed once, then re-seed in an
 * effect that depends on `row.number`. The quiz does this, and must — its
 * progress also has to void when the QUIZ changes, which a plain re-seed on
 * issue would miss. So this is a second correct mechanism, not an exemption.
 */
function reseedsInEffect(setter: string): boolean {
  for (const m of APP.matchAll(new RegExp(`${setter}\\(`, 'g'))) {
    const after = APP.slice(m.index ?? 0, (m.index ?? 0) + 400);
    if (/\}, \[row\.number/.test(after)) return true;
  }
  return false;
}

/** Does this initialiser read something that belongs to the selected issue? */
const fromIssue = (init: string): boolean => /\b(row|req|round|block)\b/.test(init) || /\bpr\b\./.test(init);

describe('per-issue card state cannot leak across issues', () => {
  it('finds the seed sites at all — a silent zero would pass this file vacuously', () => {
    expect(SEEDS.length).toBeGreaterThan(5);
  });

  it('no card seeds plain useState from the selected issue', () => {
    const leaking = SEEDS.filter((s) => fromIssue(s.init) && !reseedsInEffect(s.setter)).map(
      (s) => `${s.name} <- ${s.init}`,
    );
    expect(leaking).toEqual([]);
  });

  it('the hook exists and re-seeds on a change of issue', () => {
    expect(APP).toContain('function useIssueState<T>(issue: number, seed: T)');
    // The comparison that makes it work. Without it the hook is a rename.
    expect(APP).toMatch(/if \(held\.issue !== issue\)/);
  });

  it('the two that get SENT go through it', () => {
    // The rework brief that started a worker on the wrong PR's review...
    expect(APP).toContain("useIssueState(row.number, round?.requestedChanges ?? '')");
    // ...and the comment body, which would post on the wrong ticket as the
    // operator.
    expect(APP).toContain('useIssueState(row.number, req.draftBody)');
  });

  it('there is ONE implementation, not a per-card guard each time', () => {
    // PostMergeCard used to hand-roll it. A second copy is a second thing to
    // forget, and forgetting it once is what caused this.
    expect(APP).not.toContain('seededFor');
    expect((APP.match(/function useIssueState/g) ?? []).length).toBe(1);
  });

  it('gives the start and park controls distinct sibling keys', () => {
    // Duplicate keys make React retain another StartWorker fragment each time
    // an eligible issue is revisited, visibly stacking its controls and button.
    expect(APP).toContain('key={`start-worker-${row.number}`}');
    expect(APP).toContain('key={`park-control-${row.number}`}');
    expect(APP).not.toContain('<StartWorker key={row.number}');
    expect(APP).not.toContain('<ParkControl key={row.number}');
  });
});

describe('fresh worker profile/model controls stay provider-safe', () => {
  it('resets every profile switch from the destination account default', () => {
    expect(APP).toContain('function modelForAccount(');
    expect(APP).not.toContain('providerModel(models, defaults, nextProvider, model)');
    expect((APP.match(/setModel\(modelForAccount\(models, defaults, accountNamed\(accounts, name\)\)\)/g) ?? []).length)
      .toBeGreaterThanOrEqual(5);
  });

  it('offers and sends account plus model when Stage 9 needs a fresh worker', () => {
    const start = APP.indexOf('function PostMergeCard(');
    const end = APP.indexOf('\nfunction CreateWorktree(', start);
    const card = APP.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(card).toContain('<RunAs');
    expect(card).toContain('<RunOn');
    expect(card).toContain('...(fresh ? { account, model } : {})');
  });
});
