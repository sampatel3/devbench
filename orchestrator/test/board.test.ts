import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decideBoardMove, assertBoardMoveOnly, moveBoardItem, type BoardFacts } from '../src/board.js';

/**
 * An issue sitting in 'Ready' while a worker is actively building it should move
 * itself to 'In Progress'.
 *
 * The first framing of the rule was "Backlog, if created by me, may also move" —
 * but the console has no signal that means "the operator filed this". `selfFiled`
 * is `issue.author === cfg.assignee`, i.e. "filed under the operator's account",
 * which is true of every worker spin-off filed by a click: #4472, #4562 and #4405
 * are all sitting in Backlog reading `selfFiled: true`, and all three are
 * worker-originated and untriaged. So the sharper split won instead:
 *
 *   IN PROGRESS IS A FACT — a worker the operator started is running, and the
 *   board is just catching up. Automatic, from any lane.
 *   READY IS A CLAIM — it tells the team something is queued for work. That stays
 *   the operator's card to click.
 *
 * The gate is therefore not who filed the issue but whether the OPERATOR started
 * the worker, which the console knows first-hand and nothing outside it can forge.
 *
 * Note what `BoardFacts` cannot express: there is no field for a requested lane and
 * none for a source lane read off the worker's file. The destination is a literal in
 * board.ts and the current lane comes from a fresh read. A worker's
 * `.board-request.json` contributes exactly one bit — that a move was drafted.
 */
const OPTIONS = Object.freeze({
  Backlog: 'f75ad846',
  Planned: '4263c4d4',
  Ready: '08afe404',
  Revisit: '310f868f',
  'In progress': '47fc9ee4',
  'In review': '4cc61d42',
  QA: '51cd1a5b',
  Done: '98236657',
});

const facts = (over: Partial<BoardFacts> = {}): BoardFacts => ({
  issue: 4546,
  milestone: 'started',
  createdByOperator: true,
  issueClosed: false,
  alreadyDecided: false,
  card: { lane: 'Ready', optionIdByName: OPTIONS },
  ...over,
});

describe('the lifecycle the board should follow', () => {
  it('a ticket that starts moves to In progress', () => {
    const d = decideBoardMove(facts());
    expect(d.act).toBe('move');
    if (d.act === 'move') expect(d.to).toBe('In progress');
  });

  it('a PR opening moves it to In review — even though it already moved once', () => {
    // THE BUG THE OPERATOR HIT. The guard used to be "one move per issue,
    // ever", so a card that reached In progress could never move again: #4404, #4344 and #4329 all
    // sat there with open PRs. The guard is per MILESTONE now.
    const d = decideBoardMove(facts({ milestone: 'pr-open', card: { lane: 'In progress', optionIdByName: OPTIONS } }));
    expect(d.act).toBe('move');
    if (d.act === 'move') {
      expect(d.to).toBe('In review');
      expect(d.optionId).toBe('4cc61d42');
    }
  });

  it('each milestone fires exactly once, so moving a card back still sticks', () => {
    expect(decideBoardMove(facts({ alreadyDecided: true })).act).toBe('none');
    // ...and the OTHER milestone is unaffected by that.
    expect(decideBoardMove(facts({ milestone: 'pr-open', alreadyDecided: false })).act).toBe('move');
  });

  it('never drags a card out of a lane a person put it in', () => {
    // QA means somebody is testing it. Done and Revisit are verdicts.
    for (const lane of ['QA', 'Done', 'Revisit']) {
      const d = decideBoardMove(facts({ milestone: 'pr-open', card: { lane, optionIdByName: OPTIONS } }));
      expect(d.act, lane).toBe('none');
    }
  });

  it('starts a Backlog card the operator raised, and leaves the team’s alone', () => {
    const mine = decideBoardMove(facts({ card: { lane: 'Backlog', optionIdByName: OPTIONS } }));
    expect(mine.act).toBe('move');
    const theirs = decideBoardMove(facts({ createdByOperator: false, card: { lane: 'Backlog', optionIdByName: OPTIONS } }));
    expect(theirs.act).toBe('card');
    expect(theirs.reason).toContain('you did not raise it');
  });

  it('spends the milestone when somebody got there first', () => {
    const d = decideBoardMove(facts({ card: { lane: 'In progress', optionIdByName: OPTIONS } }));
    expect(d.act).toBe('record');
    expect(d.spend).toBe(true);
  });

  it('refuses on a closed issue, or a card it could not read', () => {
    expect(decideBoardMove(facts({ issueClosed: true })).act).toBe('card');
    expect(decideBoardMove(facts({ card: null })).act).toBe('card');
  });

  it('refuses rather than guessing when the lane is missing from the board', () => {
    const { 'In review': _gone, ...rest } = OPTIONS;
    expect(decideBoardMove(facts({ milestone: 'pr-open', card: { lane: 'Ready', optionIdByName: rest } })).act).toBe('card');
  });
});

/**
 * The write itself. This is the SECOND GitHub write in the whole codebase — the
 * first being `postIssueComment`, whose header calls itself "the ONLY GitHub-write
 * in this codebase". So it carries the same shape of guard: a fence that runs
 * before any process is spawned, an argv built here rather than assembled from
 * anything a worker can influence, and honest failure.
 */
describe('the board write cannot become another write', () => {
  it('permits exactly `gh project item-edit` and nothing else', () => {
    expect(() => assertBoardMoveOnly(['project', 'item-edit', '--id', 'x'])).not.toThrow();
    for (const argv of [
      ['issue', 'edit', '--add-label', 'P0'],
      ['issue', 'comment', '1'],
      ['project', 'item-delete', '--id', 'x'],
      ['project', 'item-add'],
      ['api', 'graphql', '-f', 'query=mutation{}'],
      ['pr', 'merge'],
      [],
    ]) {
      expect(() => assertBoardMoveOnly(argv), argv.join(' ')).toThrow();
    }
  });

  it('builds an argv with only ids, and sends it once', async () => {
    const seen: string[][] = [];
    const out = await moveBoardItem(
      { itemId: 'ITEM', projectId: 'PROJ', fieldId: 'FIELD', optionId: '47fc9ee4' },
      async (args) => {
        seen.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
    );
    expect(out.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      'project', 'item-edit',
      '--id', 'ITEM',
      '--project-id', 'PROJ',
      '--field-id', 'FIELD',
      '--single-select-option-id', '47fc9ee4',
    ]);
  });

  it('reports a failure instead of claiming it moved', async () => {
    const out = await moveBoardItem(
      { itemId: 'i', projectId: 'p', fieldId: 'f', optionId: 'o' },
      async () => ({ code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible' }),
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain('403');
  });
});

/**
 * The wiring, asserted against the source — the class of bug this codebase has
 * shipped before (a correct function fed the wrong variable, inert for weeks).
 * A board move is a WRITE, so the call sites matter more here than anywhere.
 */
describe('the board writer is wired where it is safe', () => {
  const ORCH = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');
  const APP = readFileSync(new URL('../../ui/src/App.tsx', import.meta.url), 'utf8');

  it('runs from poll() and from nowhere else', () => {
    // state() is called once per open tab per change event. A write there would
    // fire many times a minute off caches only a poll refreshes.
    expect(ORCH).toContain('async #applyBoardMoves('); // declared once
    expect((ORCH.match(/this\.#applyBoardMoves\(\)/g) ?? []).length).toBe(1); // called once
    expect(ORCH).toContain('await this.#applyBoardMoves();');
  });

  it('reads "created by me" off GitHub’s issue author, not off selfFiled', () => {
    // "Created by me" is already tracked on GitHub: every issue carries the user
    // who opened it, so the console does not need a second signal for it.
    const fn = ORCH.slice(ORCH.indexOf('async #applyBoardMoves'), ORCH.indexOf('async createWorktree('));
    expect(fn).toContain('issue.author === this.#cfg.assignee');
  });

  it('never touches a card for an issue with no worktree', () => {
    const fn = ORCH.slice(ORCH.indexOf('async #applyBoardMoves'), ORCH.indexOf('async createWorktree('));
    // Iterating the SCANS is what guarantees it: a scan is a worktree, and a
    // worktree exists only because the operator asked for one. No worktree, no
    // card touched.
    expect(fn).toContain('for (const scan of this.#scans)');
    // And the milestones are the console's own facts, not a worker's draft file.
    expect(fn).toContain("milestones.push('started')");
    expect(fn).toContain("milestones.push('pr-open')");
  });

  it('records a move ONLY after a successful write', () => {
    // Recording a move that failed would both lie on the row and burn the single
    // sanction this issue gets, leaving the card stuck for good.
    const fn = ORCH.slice(ORCH.indexOf('async #applyBoardMoves'), ORCH.indexOf('async createWorktree('));
    expect(fn).toMatch(/if \(!out\.ok\) \{[\s\S]{0,200}continue;/);
    // The failure check comes before the record that follows a WRITE. (The other
    // `boardMoves[key] =` is the cheap-pre-check path, which never writes at all.)
    expect(fn.indexOf('if (!out.ok)')).toBeLessThan(fn.lastIndexOf('this.#persisted.boardMoves[key] ='));
  });

  it('tells the feed about its own writes, so it does not report them as news', () => {
    expect(ORCH).toContain('ownBoardMoves: new Map(');
  });

  it('the card stops asking once the move is applied', () => {
    expect(APP).toContain('{brd?.applied && (');
    expect(APP).toContain('{brd && !brd.applied && (');
    // The applied branch carries no link — it is not a request.
    const applied = APP.slice(APP.indexOf('{brd?.applied && ('), APP.indexOf('{brd && !brd.applied && ('));
    expect(applied).not.toContain('btn-link');
    expect(applied).toContain('will not be moved again');
  });
});

/**
 * #4596 read `In review` on the board and then went BACK to `In progress`.
 *
 * The move log tells the story: `4596:pr-open  In review → In review` recorded on
 * one poll — the card was already there, so the milestone was spent without a
 * write — and then `started` fired on a later poll and dragged it backwards.
 *
 * Milestones do not arrive in lifecycle order. A worker can be running long after
 * its PR is open, and the console can notice either fact first. So "forward only"
 * has to be a rule about the LANES, not an assumption about the sequence.
 */
describe('a milestone never walks a card backwards', () => {
  it('start does not drag a card back out of In review', () => {
    const d = decideBoardMove(facts({ milestone: 'started', card: { lane: 'In review', optionIdByName: OPTIONS } }));
    expect(d.act).toBe('record'); // spent, so it stops asking — but nothing written
    expect(d.spend).toBe(true);
    expect(d.reason).toContain('already past');
  });

  it('nor out of a lane further along still', () => {
    for (const lane of ['QA', 'Done']) {
      expect(decideBoardMove(facts({ milestone: 'started', card: { lane, optionIdByName: OPTIONS } })).act).toBe('none');
    }
  });

  it('but still moves forward from every earlier lane', () => {
    for (const lane of ['Backlog', 'Planned', 'Ready']) {
      expect(decideBoardMove(facts({ milestone: 'started', card: { lane, optionIdByName: OPTIONS } })).act, lane).toBe('move');
    }
    expect(decideBoardMove(facts({ milestone: 'pr-open', card: { lane: 'In progress', optionIdByName: OPTIONS } })).act).toBe('move');
  });
});

/**
 * Every issue was closed, merged or sitting at stage 7 with its PR open, and the
 * board still showed cards stranded in `In progress`.
 *
 * Because the milestone was keyed on a PR being OPEN **right now**. If the
 * console was not watching at the moment the PR was raised — it was down, the
 * feature did not exist yet, or the PR merged quickly — the card was stranded on
 * `In progress` and nothing would ever move it. #4329's PR #4594 and #4546's
 * #4570 both merged before it could fire.
 *
 * A merged PR WAS submitted for review. Since the console never moves a card to
 * `QA`, `In review` is where it rests until a person moves it on. This lives in
 * the caller rather than here — the decision function is told the milestone, not
 * asked to work it out — so it is asserted against the source.
 */
describe('a merged PR still counts as having been submitted', () => {
  const ORCH2 = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');

  it('fires the pr-open milestone for OPEN and MERGED alike', () => {
    // Now expressed once, as a shared predicate, so the issue's own PR and a
    // referencing PR cannot drift apart on what "submitted" means.
    expect(ORCH2).toContain("st === 'OPEN' || st === 'MERGED'");
  });

  it('and not for a CLOSED one — that PR was abandoned, not reviewed', () => {
    expect(ORCH2).not.toContain("st === 'CLOSED'");
  });
});

/**
 * #4562 sat in `In progress` although its work had gone into the original
 * issue's PR: it should have moved to `In review` and then to done alongside
 * that issue, because the two are linked.
 *
 * Correct. #4562's fix was folded into PR #4535 — the PR for #4344 — and that
 * PR's body carries `Closes #4562`. So #4562 HAS been submitted for review; it
 * simply has no PR on a branch of its own, and the milestone was keyed on the
 * branch. Folded-in work sat on `In progress` for ever.
 *
 * The console already fetched every PR referencing each issue, and read it only
 * for the merged-PR signal. Asserted against the source, because the caller
 * decides which milestones apply.
 *
 * `Closes #4562` was the reason all along, and the milestone used to take the
 * cross-reference on its own word. On 2026-08-21 PR #5006 — #5000's work, which
 * names #5002 in prose as work it did not do — moved #5002's card from `Ready`
 * to `In review` on an issue nobody had started. A board move is the one place a
 * wrong guess leaves the laptop, so the milestone now asks `ownsIssue`, the same
 * question the row asks before it inherits a PR.
 */
describe('work folded into another issue’s PR still reaches In review', () => {
  const ORCH3 = readFileSync(new URL('../src/orchestrator.ts', import.meta.url), 'utf8');

  it('counts a referencing PR, not just the issue’s own branch', () => {
    expect(ORCH3).toContain('const referenced = (this.#referencingFull.get(scan.issue)');
    expect(ORCH3).toContain('if ((pr && submitted(pr.state)) || referenced)');
  });

  it('counts only one that SAYS it closes this issue — not a mention', () => {
    expect(ORCH3).toContain('ownsIssue(refPr, r.headRefName, scan.issue)');
  });

  it('holds referencing PRs from the poll that already fetched them', () => {
    expect(ORCH3).toContain('this.#referencingFull = new Map(');
    expect(ORCH3).toContain('i.referencingPrs');
  });

  it('applies the same submitted test to both — open or merged, never closed', () => {
    expect(ORCH3).toContain("const submitted = (st: string): boolean => st === 'OPEN' || st === 'MERGED';");
  });
});
