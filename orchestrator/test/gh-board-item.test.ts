import { describe, it, expect } from 'vitest';
import { parseBoardItem } from '../src/gh.js';

/**
 * One issue's card on ONE named board, read fresh in the same breath as the write
 * that follows it.
 *
 * This deliberately does NOT reuse the omnibus poll's project parse, which takes the
 * first project item carrying any Status and throws the project away. An issue can
 * sit on more than one board, and a write aimed by that parse would land on whichever
 * board GitHub happened to return first. Here the project number is matched.
 *
 * The payload shape below is the real one, taken from a live read of #4546 on
 * 2026-08-13: project 3, one Status field, eight lanes. The ids are neutralised.
 */
const item = (projectNumber: number, lane: string) => ({
  id: `PVTI_item_${projectNumber}`,
  project: { number: projectNumber, id: `PVT_proj_${projectNumber}`, title: `board ${projectNumber}` },
  fieldValueByName: {
    name: lane,
    optionId: 'whatever',
    field: {
      id: 'PVTSSF_status',
      options: [
        { id: 'f75ad846', name: 'Backlog' },
        { id: '08afe404', name: 'Ready' },
        { id: '47fc9ee4', name: 'In progress' },
      ],
    },
  },
});

const payload = (nodes: unknown[]) => ({
  data: { repository: { issue: { projectItems: { nodes } } } },
});

describe('reading one issue’s card on the named board', () => {
  it('returns the ids and the lane', () => {
    const got = parseBoardItem(payload([item(3, 'Ready')]), 3);
    expect(got).not.toBeNull();
    expect(got!.lane).toBe('Ready');
    expect(got!.itemId).toBe('PVTI_item_3');
    expect(got!.projectId).toBe('PVT_proj_3');
    expect(got!.fieldId).toBe('PVTSSF_status');
    expect(got!.optionIdByName['In progress']).toBe('47fc9ee4');
  });

  it('picks the named board when the issue is on more than one', () => {
    // The bug this exists to avoid: aiming a write at whichever board came first.
    const got = parseBoardItem(payload([item(7, 'Done'), item(3, 'Ready')]), 3);
    expect(got!.lane).toBe('Ready');
    expect(got!.projectId).toBe('PVT_proj_3');
  });

  it('returns null when the issue has no card on that board', () => {
    expect(parseBoardItem(payload([item(7, 'Done')]), 3)).toBeNull();
    expect(parseBoardItem(payload([]), 3)).toBeNull();
  });

  it('returns null rather than half a card when the Status value is missing', () => {
    const bare = { id: 'PVTI_x', project: { number: 3, id: 'p' }, fieldValueByName: null };
    expect(parseBoardItem(payload([bare]), 3)).toBeNull();
  });

  it('survives a malformed or error response without throwing', () => {
    // A write must never be aimed by a payload nobody could parse.
    expect(parseBoardItem({ data: { repository: null } }, 3)).toBeNull();
    expect(parseBoardItem({ errors: [{ message: 'Bad credentials' }] }, 3)).toBeNull();
    expect(parseBoardItem(null, 3)).toBeNull();
    expect(parseBoardItem('not json at all', 3)).toBeNull();
  });
});
