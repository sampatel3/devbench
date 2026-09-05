import type { ReactNode } from 'react';

/**
 * Enough markdown to read a worker's report, rendered as React elements.
 * Deliberately not a markdown library and deliberately no dangerouslySetInnerHTML:
 * nothing a worker writes can become HTML on this page.
 */

/** A bullet. `•` is here because the status summary is written in the house
 *  format the team posts in chat, which uses that character — the text on
 *  screen is byte-identical to the text the Copy button hands over. */
const BULLET = /^\s*[-*•]\s+/;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) out.push(<code key={`${keyBase}-${i++}`}>{tok.slice(1, -1)}</code>);
    else out.push(<strong key={`${keyBase}-${i++}`}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * One `| a | b |` row split into its cells. Leading and trailing pipes are
 * optional, and `\|` is a literal pipe inside a cell rather than a separator.
 */
function cells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === '\\' && trimmed[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/** A `## heading` turned into an id a contents list can link to. */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type MarkdownSection = { id: string; heading: string | null; body: string };

/**
 * Split a document at its `##` headings so each section can carry an anchor.
 * The heading line stays in the body, so the renderer below still draws it.
 * Fence-aware: a `##` inside a code block is not a heading. Anything before the
 * first `##` comes back as one lead section with no heading and no id.
 */
export function splitSections(source: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let heading: string | null = null;
  let body: string[] = [];
  let inFence = false;

  const flush = () => {
    if (heading === null && !body.some((l) => l.trim())) return;
    sections.push({ id: heading ? headingSlug(heading) : '', heading, body: body.join('\n') });
  };

  for (const line of source.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const m = inFence ? null : /^##\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = m[1]!.trim();
      body = [line];
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

export function Markdown({ source }: { source: string }): ReactNode {
  const lines = source.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!);
      i++;
      blocks.push(<pre key={key++}>{body.join('\n')}</pre>);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = inline(heading[2]!, `h${key}`);
      blocks.push(
        level <= 2 ? <h3 key={key++}>{text}</h3> : <h4 key={key++}>{text}</h4>,
      );
      i++;
      continue;
    }

    if (BULLET.test(line)) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !lines[i]!.startsWith('```') && !/^#{1,4}\s/.test(lines[i]!)) {
        const l = lines[i++]!;
        // A bullet starts an item; anything else before the blank line is that
        // item wrapped onto the next line, not a new paragraph.
        if (BULLET.test(l)) items.push(l.replace(BULLET, ''));
        else items[items.length - 1] = `${items[items.length - 1] ?? ''} ${l.trim()}`;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((it, n) => (
            <li key={n}>{inline(it, `li${key}-${n}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // A GitHub pipe table: header row, `|---|` separator, then body rows. It
    // becomes a real table — the manual's stage table is unreadable any other way
    // — inside a container that scrolls sideways rather than pushing the page out.
    if (line.includes('|') && lines[i + 1]?.match(/^\s*\|?[\s:|-]+\|/)) {
      const head = cells(line);
      i += 2; // the header and its separator
      const body: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|')) body.push(cells(lines[i++]!));
      const k = key++;
      blocks.push(
        <div className="md-table" key={k}>
          <table>
            <thead>
              <tr>
                {head.map((c, n) => (
                  <th key={n}>{inline(c, `th${k}-${n}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {row.map((c, n) => (
                    <td key={n}>{inline(c, `td${k}-${r}-${n}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // A paragraph ends where a list begins, so a section heading written as a
    // plain line above its bullets stays a heading instead of swallowing them.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !lines[i]!.startsWith('```') &&
      !/^#{1,4}\s/.test(lines[i]!) &&
      !BULLET.test(lines[i]!)
    ) {
      para.push(lines[i++]!);
    }
    blocks.push(<p key={key++}>{inline(para.join(' '), `p${key}`)}</p>);
  }

  return <div className="md">{blocks}</div>;
}
