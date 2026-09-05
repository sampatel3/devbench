import { describe, it, expect } from 'vitest';
import { why } from '../src/why.js';

/**
 * The operator reported always getting an error when restarting the edge runtime
 * — and the message was always the same: "Command failed: docker restart
 * supabase_edge_runtime_example-app_custom."
 *
 * That is line ONE of Node's execFile error. Line two is the reason:
 *
 *   Command failed: docker restart <name>
 *   Error response from daemon: No such container: <name>
 *
 * The console did `.message.split('\n')[0]`, keeping the line that just repeats
 * the command back and discarding the only informative one. So every failure of
 * this button looked identical and unexplained, and neither of us could tell
 * afterwards what had actually gone wrong at 10:31.
 */
describe('the reason a command failed', () => {
  it('takes the daemon’s line, not the echo of the command', () => {
    const e = new Error(
      'Command failed: docker restart supabase_edge_runtime_example-app_custom\n' +
        'Error response from daemon: No such container: supabase_edge_runtime_example-app_custom\n',
    );
    expect(why(e)).toBe('Error response from daemon: No such container: supabase_edge_runtime_example-app_custom');
  });

  it('falls back to the first line when there is nothing else', () => {
    expect(why(new Error('Command failed: docker restart x'))).toBe('Command failed: docker restart x');
  });

  it('keeps an ordinary one-line error unchanged', () => {
    expect(why(new Error('connect ECONNREFUSED 127.0.0.1:4400'))).toBe('connect ECONNREFUSED 127.0.0.1:4400');
  });

  it('skips blank lines rather than returning emptiness', () => {
    expect(why(new Error('Command failed: x\n\n\nreal reason here\n'))).toBe('real reason here');
  });

  it('says something rather than nothing when the error is empty', () => {
    expect(why(new Error(''))).toBe('no reason given');
  });

  it('caps a runaway stderr rather than pasting a wall onto the card', () => {
    const long = 'y'.repeat(600);
    expect(why(new Error(`Command failed: x\n${long}`)).length).toBeLessThanOrEqual(300);
  });
});
