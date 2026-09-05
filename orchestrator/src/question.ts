import type { GhActionsComment } from './gh.js';

/**
 * A question the operator asked on an issue that nobody has answered.
 *
 * #4344 carried one for fifteen hours — a request that somebody with production
 * access go and check a flag — and the console had no idea. The operator had no
 * way to see it, and so no way to know what still needed following up.
 *
 * The console's only comment tracking was `commentBlock`, which is written from
 * exactly one path (a worker drafts `.comment-request.json`, the operator clicks
 * Post) and is deleted unconditionally on any resume. So a question asked any
 * other way was
 * invisible, and one asked through the console would still have been wiped by the
 * next rework — while the question sat unanswered. This asks a narrower thing of
 * data GitHub already sends every poll, and nothing here can erase it.
 *
 * It costs no request: the actions poll already fetches the last 10 comments per
 * assigned issue. Because that window is anchored at the NEWEST end, the comment
 * this predicate cares about is always inside it.
 */
export type OpenQuestion = {
  /** ISO timestamp of the comment. */
  askedAt: string;
  /** Its opening line, so the card can say what was asked without the wall. */
  firstLine: string;
  /** Straight to the comment on GitHub. */
  url: string;
};

const at = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** The first non-empty line, trimmed — same shape the actions feed uses. */
const firstLine = (body: string): string | null => {
  const l = body.split('\n').find((x) => x.trim() !== '');
  if (l === undefined) return null;
  const trimmed = l.trim();
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}…` : trimmed;
};

export function openQuestion(comments: GhActionsComment[], me: string): OpenQuestion | null {
  if (comments.length === 0) return null;

  // Newest by timestamp, not by array position: relying on GitHub's ordering is
  // how a predicate quietly starts answering a different question than its name.
  const mine = [...comments]
    .filter((c) => c.author.login.toLowerCase() === me.toLowerCase() && c.author.typename === 'User')
    .sort((a, b) => at(b.createdAt) - at(a.createdAt))[0];
  if (!mine) return null;

  // The strict half. Without it this fires on every `@claude re-review` trigger —
  // five of the six threads the operator has commented on here are exactly that.
  // The honest cost is a question phrased without a question mark, which this
  // will miss; the alternative was a card that cried wolf on every rework.
  //
  // Read off my LAST word rather than my last question: if I have since said
  // something that is not a question, the thread is mine again and there is
  // nothing outstanding to chase.
  if (!mine.body.includes('?')) return null;

  // Has a PERSON spoken since? A bot has not answered anything — these threads
  // carry constant CI and review-bot noise, and if that counted the question
  // would disappear the moment a check reported.
  const answered = comments.some(
    (c) =>
      c.author.typename === 'User' &&
      c.author.login.toLowerCase() !== me.toLowerCase() &&
      at(c.createdAt) > at(mine.createdAt),
  );
  if (answered) return null;

  const line = firstLine(mine.body);
  if (line === null) return null;

  return { askedAt: mine.createdAt, firstLine: line, url: mine.url };
}
