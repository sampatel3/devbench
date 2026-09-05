/**
 * The rail's search: issue number, PR number, or title.
 *
 * The operator holds two numbers in their head — the issue and the PR — and only
 * one of them was on the rail, so "PR #4623" could not be found at all without
 * first remembering it belonged to #4619. Both are matched here, and the title is
 * the fallback for when they remember the words instead.
 *
 * Numbers match WHOLE, never as substrings: `619` finding #4619 would make the
 * search noisier than the list it is filtering. Text matches loosely, because
 * remembering a phrase exactly is the thing they are trying not to have to do.
 */
export type Searchable = {
  number: number;
  title: string;
  pr: { number: number } | null;
};

export function matchesQuery(row: Searchable, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;

  // "#4619", "PR #4623", "pr4623", "4623" — all of it is one number once the
  // decoration is stripped. Anything left over means they typed words, not a
  // number, and it goes to the text branch below.
  // `^pr\b` looks right and is not: there is no word boundary between the `r`
  // and the `4` of `pr4623`, so that spelling fell through to the title branch
  // and matched nothing. Strip the prefix and any decoration after it instead.
  const asNumber = q.replace(/^pr[\s#]*/, '').replace(/[#\s]/g, '');
  if (/^\d+$/.test(asNumber)) {
    const n = Number(asNumber);
    return row.number === n || row.pr?.number === n;
  }

  return row.title.toLowerCase().includes(q);
}
