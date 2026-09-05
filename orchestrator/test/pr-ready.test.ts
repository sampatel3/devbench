import { describe, it, expect } from 'vitest';
import { assertCommentOnly, assertPrReadyOnly, markPrReady } from '../src/comment.js';

/**
 * The console's second GitHub write, and the narrowest one: five tokens, the
 * third all digits. It exists because the console could already SEE a draft PR
 * and could only tell them to go and fix it on GitHub — which is how #5469,
 * #5478, #5543, #5546 and #5547 sat complete and unreviewable.
 */
describe('assertPrReadyOnly', () => {
  it('permits exactly the one shape', () => {
    expect(() => assertPrReadyOnly(['pr', 'ready', '5478', '--repo', 'example-org/example-repo'])).not.toThrow();
  });

  it.each([
    [['pr', 'merge', '5478', '--repo', 'example-org/example-repo'], 'a merge wearing the same shape'],
    [['pr', 'close', '5478', '--repo', 'example-org/example-repo'], 'a close'],
    [['pr', 'ready', '5478'], 'no repo'],
    [['pr', 'ready', '5478', '--repo', 'example-org/example-repo', '--extra'], 'a sixth token'],
    [['pr', 'ready', '--repo', 'example-org/example-repo', '5478'], 'the number in the wrong place'],
    [['pr', 'ready', '5478; rm -rf /', '--repo', 'example-org/example-repo'], 'anything but digits where the number goes'],
    [['pr', 'ready', '5478', '--repo', ''], 'an empty repo'],
    [[], 'nothing at all'],
  ])('REFUSES %j — %s', (args) => {
    expect(() => assertPrReadyOnly(args as string[])).toThrow(/only PR write/i);
  });

  it('leaves the comment fence exactly as strict as it was', () => {
    // The two fences are separate on purpose: widening one must not widen the other.
    expect(() => assertCommentOnly(['pr', 'ready', '5478', '--repo', 'example-org/example-repo'])).toThrow(/only post comments/i);
  });
});

describe('markPrReady', () => {
  it('runs the fenced argv and reports success', async () => {
    let seen: string[] = [];
    const out = await markPrReady(5478, 'example-org/example-repo', {
      exec: async (args) => {
        seen = args;
        return { code: 0, stdout: 'ready', stderr: '' };
      },
    });
    expect(out.ok).toBe(true);
    expect(seen).toEqual(['pr', 'ready', '5478', '--repo', 'example-org/example-repo']);
  });

  it('reports gh`s own first line when it fails, rather than smoothing it over', async () => {
    const out = await markPrReady(5478, 'example-org/example-repo', {
      exec: async () => ({ code: 1, stdout: '', stderr: 'GraphQL: Pull request is not a draft\nsecond line' }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('GraphQL: Pull request is not a draft');
  });
});
