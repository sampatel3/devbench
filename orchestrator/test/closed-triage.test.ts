import { describe, it, expect } from 'vitest';
import {
  awaitingTriage,
  isClosedIssue,
  needsTriage,
  priorityOf,
  selfFiledNeedsTriage,
  sortIssues,
} from '../../ui/src/priority.js';
import type { Sortable } from '../../ui/src/priority.js';
import type { WorkerStatus } from '../../ui/src/types.js';

/**
 * CLOSED WORK IS OUT OF EVERY TRIAGE SURFACE.
 *
 * 33 of 105 closed issues still carried `needs-triage` when they closed, because
 * nothing in the repo ever takes the label off — and the console cannot take it
 * off either: it never writes labels to GitHub, and that fence is not being
 * loosened for a tidy-up. So it stops ASKING instead. A pill reading "needs
 * triage" over a ticket QA signed off is the list lying about what is left to
 * do, and the caution above the start button is asking him to rank work that has
 * already finished.
 *
 * The label itself is untouched, on GitHub and in the row's own label line. This
 * is exclusion from the question, never from the record.
 */

const row = (over: Partial<Sortable> = {}): Sortable => ({
  labels: ['needs-triage'],
  status: 'no-worker',
  updatedAt: '2026-09-03T18:00:00Z',
  selfFiled: false,
  uatFail: null,
  ...over,
});

/** The shape `state()` synthesizes for a worktree whose issue has closed. */
const CLOSED = { reason: 'closed' as const, closedAt: '2026-09-03T18:03:37Z', assignees: [] };

describe('is this issue closed', () => {
  it('reads the `done` status, which is the ordinary way', () => {
    expect(isClosedIssue(row({ status: 'done' }))).toBe(true);
  });

  it('reads the orphan reason too — the status is decided by something louder', () => {
    // #5697: closed and QA-passed, with a worker still parked on it. Every one of
    // these statuses is returned by `deriveStatus` BEFORE it reaches its closed
    // branch, so the status alone can never see the close.
    const louder: WorkerStatus[] = ['at-gate', 'queued', 'active', 'checkpoint', 'failed', 'blocked'];
    for (const status of louder) {
      expect(isClosedIssue(row({ status, orphan: CLOSED }))).toBe(true);
    }
  });

  it('is false for the three other reasons a row can be orphaned', () => {
    for (const reason of ['not-yours', 'still-open', 'unread'] as const) {
      expect(isClosedIssue(row({ status: 'checkpoint', orphan: { reason, closedAt: null, assignees: [] } }))).toBe(false);
    }
  });

  it('reads an ABSENT orphan as not closed, not as closed', () => {
    // A rebuilt `ui/dist` in front of a server that has not restarted sends no
    // `orphan` at all. The same rule `isParked` and `isUatFail` keep: a field
    // that is not there decides nothing.
    expect(isClosedIssue({ status: 'at-gate' })).toBe(false);
  });
});

describe('whether there is still a triage question', () => {
  it('is the empty priority axis on an open issue — unchanged', () => {
    expect(needsTriage(row())).toBe(true);
    expect(needsTriage(row({ labels: ['P2', 'needs-triage'] }))).toBe(false);
    // The label was never the signal; the empty axis is. An issue with no labels
    // at all is untriaged, which is what the synthesized rows used to trip over.
    expect(needsTriage(row({ labels: [] }))).toBe(true);
  });

  it('is FALSE on a closed issue, whatever the labels still say', () => {
    expect(needsTriage(row({ status: 'done' }))).toBe(false);
    expect(needsTriage(row({ status: 'at-gate', orphan: CLOSED }))).toBe(false);
    expect(needsTriage(row({ labels: [], status: 'done' }))).toBe(false);
  });

  it('leaves the label question itself alone — the label is real and stays readable', () => {
    // `awaitingTriage` is a question about labels and answers it truthfully on a
    // closed issue. It is `needsTriage` that decides whether the console asks,
    // and the row's label line still prints `needs-triage` where the pill has
    // gone quiet. Nothing here hides a fact from GitHub.
    expect(awaitingTriage(['needs-triage'])).toBe(true);
    expect(priorityOf(['needs-triage'])).toBe('untriaged');
  });
});

describe('the caution above the start button', () => {
  it('shows on self-filed backlog nobody has ranked', () => {
    expect(selfFiledNeedsTriage(row({ selfFiled: true }))).toBe(true);
  });

  it('is silent on a closed one — there is no work left to start', () => {
    expect(selfFiledNeedsTriage(row({ selfFiled: true, status: 'done' }))).toBe(false);
    expect(selfFiledNeedsTriage(row({ selfFiled: true, status: 'at-gate', orphan: CLOSED }))).toBe(false);
  });
});

describe('the ordering', () => {
  it('does not sink a closed row twice for a triage answer it will never get', () => {
    // Both are closed and both are self-filed with no rank, so the untriaged
    // tiebreak must not separate them: they tie on it and fall through to the
    // recency key. Before this, one of them was penalised for a label nobody is
    // ever going to remove.
    const older = row({ status: 'done', selfFiled: true, orphan: CLOSED, updatedAt: '2026-09-01T00:00:00Z' });
    const newer = row({ status: 'done', selfFiled: true, orphan: CLOSED, labels: ['P1'], updatedAt: '2026-09-03T00:00:00Z' });
    expect(sortIssues([older, newer])[0]).toBe(newer);
  });

  it('still sinks every closed row to the floor', () => {
    const open = row({ status: 'no-worker', labels: ['P3'] });
    const closed = row({ status: 'done', labels: ['P0'], orphan: CLOSED });
    expect(sortIssues([closed, open])[0]).toBe(open);
  });
});
