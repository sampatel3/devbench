import { describe, it, expect } from 'vitest';
import { commentAddressee } from '../src/addressee.js';

/**
 * The house rule the operator works to is that a comment goes to whoever created
 * the ticket — in practice a handful of the same people — so the card has to
 * say plainly who it will be @-ing.
 *
 * The card showed the worker's `addressee` field and, when it was empty, the
 * words "(whoever is on the ticket)" — which names nobody and sends the operator
 * off to look. The comment posts under their own name, so the one fact that must
 * be unmissable is WHO it reaches.
 */
describe('who the comment is addressed to', () => {
  it('uses what the worker asked for, normalised to an @handle', () => {
    const a = commentAddressee({ addressee: 'teammate-one', issueAuthor: 'reviewer-one' });
    expect(a.handle).toBe('@teammate-one');
    expect(a.known).toBe(true);
  });

  it('does not double the @ when the worker already wrote one', () => {
    expect(commentAddressee({ addressee: '@teammate-one', issueAuthor: null }).handle).toBe('@teammate-one');
  });

  it('falls back to whoever RAISED the ticket — the operator’s own rule for who to ask', () => {
    const a = commentAddressee({ addressee: '', issueAuthor: 'reviewer-one' });
    expect(a.handle).toBe('@reviewer-one');
    expect(a.why).toContain('raised this issue');
  });

  it('says the addressee IS the person who raised it, when they are', () => {
    // Worth saying out loud: it confirms the worker picked the right person
    // rather than someone it happened to find in the thread.
    const a = commentAddressee({ addressee: 'reviewer-one', issueAuthor: 'reviewer-one' });
    expect(a.why).toContain('raised this issue');
  });

  it('flags an addressee who did NOT raise the ticket, without refusing it', () => {
    // Sometimes right — a code owner, someone named in the thread — so this
    // informs rather than blocks. The operator is the one clicking Post.
    const a = commentAddressee({ addressee: 'teammate-one', issueAuthor: 'reviewer-one' });
    expect(a.why).toContain('did not raise');
    expect(a.why).toContain('reviewer-one');
  });

  it('is honest when nobody can be worked out', () => {
    const a = commentAddressee({ addressee: '', issueAuthor: null });
    expect(a.known).toBe(false);
    expect(a.handle).toBe('');
    expect(a.why).toContain('nobody');
  });

  it('never addresses the operator to themselves', () => {
    // A worker filing under the operator's account would otherwise "ask" them a
    // question on their own ticket, which reaches no one who can answer it.
    const a = commentAddressee({ addressee: '', issueAuthor: 'operator', me: 'operator' });
    expect(a.known).toBe(false);
    expect(a.why).toContain('you raised');
  });
});
