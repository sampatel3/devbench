import { useEffect, useState } from 'react';

/**
 * THE CUMULATIVE GRAPH beside the four numbers.
 *
 * The operator asked for a cumulative line graph beside the summary tiles,
 * running from the start of the range.
 *
 * Cumulative rather than daily on purpose, and it is what was asked for: a daily
 * bar of "3 PRs merged" is noise at this volume, while a line that only ever
 * goes up answers the question the four tiles cannot — is the rate holding, and
 * is merging keeping up with raising. Two lines drifting apart is the whole
 * point of drawing it.
 *
 * FOUR LINES, LABELLED AT THE END rather than in a legend, so no colour has to
 * be remembered. The colours are the ones this console already assigns those
 * meanings — violet for the PR path, green for landed, slate for a thing set
 * going — rather than a fresh chart palette that would say something different
 * from every chip on the page.
 *
 * WHAT IT REFUSES TO DRAW. The notify ledger keeps 30 days and two of these four
 * series come out of it, so a range reaching further back would slope up from a
 * flat zero and read as "nothing happened then" — a lie the shape of a graph
 * tells much more convincingly than a number does. Anything before `auditFrom`
 * is greyed and said in words.
 */

type Day = {
  day: string;
  ticketsStarted: number;
  prsRaised: number;
  prsMerged: number;
  issuesClosed: number;
};

type Series = { days: Day[]; auditFrom: string; warnings: string[] };

type Line = { key: keyof Omit<Day, 'day'>; label: string; colour: string };

/** The four, in the order the tiles above them read. */
const LINES: Line[] = [
  { key: 'ticketsStarted', label: 'started', colour: 'var(--ice)' },
  { key: 'prsRaised', label: 'raised', colour: 'var(--handover)' },
  { key: 'prsMerged', label: 'merged', colour: 'var(--ok)' },
  { key: 'issuesClosed', label: 'closed', colour: 'var(--ink)' },
];

// Sized for an ASIDE, not a panel. It annotates the four numbers beside it and
// should never compete with them for the eye.
const W = 320;
const H = 96;
const PAD = { top: 8, right: 46, bottom: 14, left: 24 };

export function SummaryChart({ from, to }: { from: string; to: string }) {
  const [series, setSeries] = useState<Series | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    setError(null);
    void fetch(`/api/summary/series?from=${from}&to=${to}`)
      .then((r) => r.json() as Promise<Series & { ok?: boolean; message?: string }>)
      .then((v) => {
        if (stop) return;
        if (v.ok === false) {
          setError(v.message ?? 'could not read the series');
          setSeries(null);
          return;
        }
        setSeries(v);
      })
      .catch((e: Error) => !stop && setError(e.message));
    return () => {
      stop = true;
    };
  }, [from, to]);

  if (error) return <p className="note err">{error}</p>;
  if (!series || series.days.length < 2) return null;

  // Running totals, which is the whole point: each point is everything up to
  // and including that day.
  const running = { ticketsStarted: 0, prsRaised: 0, prsMerged: 0, issuesClosed: 0 };
  const points = series.days.map((d) => {
    running.ticketsStarted += d.ticketsStarted;
    running.prsRaised += d.prsRaised;
    running.prsMerged += d.prsMerged;
    running.issuesClosed += d.issuesClosed;
    return { day: d.day, ...running };
  });

  const last = points[points.length - 1]!;
  const peak = Math.max(1, ...LINES.map((l) => last[l.key]));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number): number => PAD.left + (points.length === 1 ? 0 : (i / (points.length - 1)) * plotW);
  const y = (v: number): number => PAD.top + plotH - (v / peak) * plotH;

  const path = (line: Line): string =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p[line.key]).toFixed(1)}`).join(' ');

  // Where the audit stops being able to answer. Everything left of it is drawn,
  // but greyed and captioned, because a flat line there means "not recorded",
  // not "nothing happened".
  const shortIndex = series.days.findIndex((d) => d.day >= series.auditFrom);
  const partial = shortIndex > 0;

  /**
   * The end labels, pushed apart so none is drawn over another.
   *
   * Sorted by where the line actually ends, then each one shoved down until it
   * clears the one above by `LABEL_GAP`. Order is preserved, so a label is
   * never moved PAST a line it does not belong to — it is only ever nudged.
   */
  const LABEL_GAP = 10;
  const labelRows = LINES.map((line) => ({
    key: line.key,
    colour: line.colour,
    text: `${last[line.key]} ${line.label}`,
    y: y(last[line.key]) + 3,
  }))
    .sort((a, b) => a.y - b.y)
    .map((row, i, all) => {
      const above = i === 0 ? null : all[i - 1]!.y;
      const pushed = above !== null && row.y - above < LABEL_GAP ? above + LABEL_GAP : row.y;
      all[i]!.y = pushed;
      return { ...row, y: pushed };
    });

  return (
    <div className="summary-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="cumulative totals over the range">
        {/* Two gridlines only — nought and the peak. More would be furniture. */}
        {[0, peak].map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="chart-grid" />
            <text x={PAD.left - 6} y={y(v) + 3} className="chart-tick" textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {partial && (
          <>
            <rect x={PAD.left} y={PAD.top} width={x(shortIndex) - PAD.left} height={plotH} className="chart-outside" />
            <text x={PAD.left + 3} y={PAD.top + 10} className="chart-tick">
              before the audit
            </text>
          </>
        )}
        {LINES.map((line) => (
          <path key={line.key} d={path(line)} fill="none" stroke={line.colour} strokeWidth={1.6} />
        ))}
        {/* Labelled at the end of its own line, so nothing has to be looked up —
            and pushed apart when the lines finish close together, which at this
            volume they always do: 107 started, 113 raised, 96 merged, 95 closed
            put all four labels inside eleven pixels and drew them on top of one
            another. Each label keeps its own colour, so which line it belongs to
            survives being nudged. */}
        {labelRows.map((row) => (
          <text key={row.key} x={W - PAD.right + 5} y={row.y} className="chart-label" fill={row.colour}>
            {row.text}
          </text>
        ))}
        <text x={PAD.left} y={H - 5} className="chart-tick">
          {points[0]!.day.slice(5)}
        </text>
        <text x={W - PAD.right} y={H - 5} className="chart-tick" textAnchor="end">
          {last.day.slice(5)}
        </text>
      </svg>
      {partial && (
        <p className="note">
          The audit keeps 30 days, so started, raised and merged are incomplete before {series.auditFrom} — the flat
          part is missing data, not a quiet week.
        </p>
      )}
    </div>
  );
}
