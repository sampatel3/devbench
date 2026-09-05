/**
 * The pre-merge checklist a worker writes into the PR body.
 *
 * Workers had taken to ending a PR body with a "Pre-merge checklist" — real,
 * useful items, some of which are the operator's to do and none of which the
 * console could see. PR #4535 carried two: one filed issue (ticked) and one
 * production flag check (not). The operator's objection was the obvious one: the
 * agent cannot recommend a PR checklist and then leave the console unable to say
 * what its status is, or what the operator is waiting on.
 *
 * A checklist the agent invents and leaves somewhere nobody watches is worse
 * than no checklist, because it looks like tracking. The body is already on the
 * PR object, so the outstanding items cost nothing to read.
 *
 * Deliberately a markdown reader and not a parser: GitHub renders `- [ ]` task
 * lists from the body, and that is the whole contract.
 */
export type Checklist = {
  total: number;
  done: number;
  /** The unticked items, as plain single-line text. */
  outstanding: string[];
};

const ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;

/** Markdown that is noise on a card. The words are the point. */
function plain(s: string): string {
  return s
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseChecklist(body: string | null | undefined): Checklist {
  const out: Checklist = { total: 0, done: 0, outstanding: [] };
  if (!body) return out;

  const lines = body.split('\n');
  let fenced = false;
  // The item currently being accumulated, so a wrapped line joins it rather than
  // being dropped — the second item on #4535 wraps, and its tail carried the
  // entire meaning of the item: the condition it had to be done before.
  let open: { checked: boolean; text: string } | null = null;

  const flush = (): void => {
    if (!open) return;
    out.total += 1;
    if (open.checked) out.done += 1;
    else out.outstanding.push(plain(open.text));
    open = null;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      // A checkbox inside a fence is documentation, not work.
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const m = line.match(ITEM);
    if (m) {
      flush();
      open = { checked: m[1]!.toLowerCase() === 'x', text: m[2] ?? '' };
      continue;
    }
    // A continuation is an indented, non-empty line under an open item.
    if (open && line.trim() !== '' && /^\s+\S/.test(line)) {
      open.text += ` ${line.trim()}`;
      continue;
    }
    flush();
  }
  flush();
  return out;
}
