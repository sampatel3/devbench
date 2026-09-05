/**
 * Who a comment reaches.
 *
 * The operator asked for the handle to be visible before posting: a team's
 * comments go to whoever raised the ticket, that is a small set of people, and
 * the card should say which of them this one reaches.
 *
 * The comment card used to print the worker's raw `addressee` field, and when
 * that was empty, the words "(whoever is on the ticket)" — which names nobody
 * and sends the operator to GitHub to find out. These are posted under the
 * operator's own name, so the handle has to be on the card, and it has to be
 * right.
 *
 * The rule is simple: address the person who RAISED the issue. So that is the
 * fallback, and an addressee who did not raise it gets said out loud rather than
 * blocked — a code owner or someone named in the thread is often the right
 * target, and the operator is the one clicking Post.
 */
export type Addressee = {
  /** '@handle', or '' when nobody could be worked out. */
  handle: string;
  /** False means: do not print a handle, print the reason. */
  known: boolean;
  /** One line for the card, saying where the handle came from. */
  why: string;
};

export type AddresseeInput = {
  /** What the worker asked for, with or without a leading @. */
  addressee?: string | null;
  /** The GitHub login that opened the issue. */
  issueAuthor?: string | null;
  /** The operator's own login, so a comment is never addressed to themselves. */
  me?: string | null;
};

function bare(s: string | null | undefined): string {
  return (s ?? '').trim().replace(/^@+/, '');
}

export function commentAddressee(input: AddresseeInput): Addressee {
  const asked = bare(input.addressee);
  const author = bare(input.issueAuthor);
  const me = bare(input.me);

  const isMe = (h: string): boolean => me !== '' && h.toLowerCase() === me.toLowerCase();

  if (asked !== '') {
    if (isMe(asked)) {
      return { handle: '', known: false, why: 'you raised this issue, so there is nobody here to ask.' };
    }
    if (author !== '' && asked.toLowerCase() !== author.toLowerCase()) {
      return {
        handle: `@${asked}`,
        known: true,
        why: `the worker chose them; they did not raise this issue — ${author} did.`,
      };
    }
    return { handle: `@${asked}`, known: true, why: 'they raised this issue.' };
  }

  if (author !== '') {
    if (isMe(author)) {
      return { handle: '', known: false, why: 'you raised this issue, so there is nobody here to ask.' };
    }
    return { handle: `@${author}`, known: true, why: 'they raised this issue.' };
  }

  return { handle: '', known: false, why: 'nobody could be worked out — no addressee, and no issue author.' };
}
