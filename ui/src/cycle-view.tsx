import { useEffect, useState } from 'react';

/**
 * HOW LONG EACH LEG TOOK — the three averages, and one ticket against them.
 *
 * The operator asked for the minutes between each pair of moments — ticket
 * assigned to PR raised, PR raised to merged, merged to closed — as an average,
 * and for each ticket to be readable against those averages.
 *
 * THE MEDIAN IS THE YARDSTICK, and the mean is shown beside it rather than
 * instead of it. Measured on a live console over four weeks: start → PR raised
 * had a median of 10h 30m and a mean of 18h 8m. One ticket that sat over a
 * weekend is the difference, and judging an ordinary ticket against the mean
 * would call most of them fast.
 *
 * EVERY AVERAGE CARRIES ITS `n`. An average of two is not an average, and the
 * verdict is withheld entirely below `MIN_SAMPLE` — see `compare` in cycle.ts,
 * which is where the rule lives rather than here.
 */

type Stat = { n: number; medianMin: number | null; meanMin: number | null };
type Legs = { toRaise: number | null; toMerge: number | null; toClose: number | null };
type LegKey = keyof Legs;

type Trend = 'better' | 'worse' | 'flat';

type IssueCycle = {
  issue: number;
  /** The four moments AND the three legs. The legs are nested, as the server
   *  sends them — reading them flat made this component render nothing at
   *  all, silently, because every leg came back `undefined`. */
  mine: { issue: number; legs: Legs } | null;
  summary: Record<LegKey, Stat>;
  warnings: string[];
};

const LEGS: Array<{ key: LegKey; label: string }> = [
  { key: 'toRaise', label: 'start → PR raised' },
  { key: 'toMerge', label: 'PR raised → merged' },
  { key: 'toClose', label: 'merged → closed' },
];

/** Kept in step with `humanMinutes` in cycle.ts — same rule, same shape. */
function human(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—';
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  const d = Math.floor(min / (60 * 24));
  const h = Math.round((min % (60 * 24)) / 60);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

const MIN_SAMPLE = 5;
const NEAR_PCT = 0.15;

function verdictOf(value: number | null, stat: Stat): 'faster' | 'slower' | 'typical' | null {
  if (value === null || stat.medianMin === null || stat.n < MIN_SAMPLE) return null;
  const band = Math.max(1, stat.medianMin * NEAR_PCT);
  if (value < stat.medianMin - band) return 'faster';
  if (value > stat.medianMin + band) return 'slower';
  return 'typical';
}

/**
 * The three legs for ONE ticket, against the median of the rest.
 *
 * Rendered on the ticket's own card, because that is where the question is
 * asked: you are looking at this ticket and want to know whether it is dragging.
 */
export function IssueCycleLine({ issue }: { issue: number }) {
  const [data, setData] = useState<IssueCycle | null>(null);

  useEffect(() => {
    let stop = false;
    setData(null);
    void fetch(`/api/issues/${issue}/cycle`)
      .then((r) => r.json() as Promise<IssueCycle & { ok?: boolean }>)
      .then((v) => !stop && v.ok !== false && setData(v))
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [issue]);

  // Nothing measurable yet is the ordinary case for a ticket that has just
  // started, and it says nothing rather than printing three em dashes.
  const measured = data?.mine ? LEGS.filter((l) => data.mine!.legs[l.key] !== null) : [];
  if (measured.length === 0) return null;

  return (
    <p className="note cycle-line">
      {measured.map((leg, i) => {
        const mine = data!.mine!.legs[leg.key];
        const stat = data!.summary[leg.key];
        const verdict = verdictOf(mine, stat);
        return (
          <span key={leg.key}>
            {i > 0 && ' · '}
            {leg.label} <strong>{human(mine)}</strong>
            {verdict === null ? (
              // Below the sample floor there is no honest comparison to draw, so
              // the figure stands on its own rather than being dressed up.
              ''
            ) : (
              <span className={`cycle-verdict ${verdict}`} title={`median ${human(stat.medianMin)} across ${stat.n}`}>
                {verdict === 'typical' ? 'about usual' : verdict}
              </span>
            )}
          </span>
        );
      })}
    </p>
  );
}

/**
 * The three averages, for the Status summary.
 *
 * Read over the same range the tiles show, so a number here and a number there
 * can never be answering different questions.
 */
export function CycleAverages({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<{
    summary: Record<LegKey, Stat>;
    recent: Record<LegKey, Stat>;
    recentDays: number;
    trend: Record<LegKey, Trend | null>;
    warnings: string[];
  } | null>(null);

  useEffect(() => {
    let stop = false;
    void fetch(`/api/summary/cycle?from=${from}&to=${to}`)
      .then(
        (r) =>
          r.json() as Promise<{
            summary: Record<LegKey, Stat>;
            recent: Record<LegKey, Stat>;
            recentDays: number;
            trend: Record<LegKey, Trend | null>;
            warnings: string[];
            ok?: boolean;
          }>,
      )
      .then((v) => !stop && v.ok !== false && setData(v))
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [from, to]);

  if (!data) return null;
  const any = LEGS.some((l) => data.summary[l.key].n > 0);
  if (!any) return null;

  return (
    <div className="cycle-averages">
      {LEGS.map((leg) => {
        const stat = data.summary[leg.key];
        return (
          <div key={leg.key} className="cycle-stat" title={`mean ${human(stat.meanMin)} — the median is the one to read`}>
            <strong>{human(stat.medianMin)}</strong>
            <span>{leg.label}</span>
            {/* The n, always. An average of two is not an average, and the
                verdict on a ticket is withheld entirely below five. */}
            <span className="note">
              median of {stat.n}
              {stat.meanMin !== null && stat.meanMin !== stat.medianMin ? ` · mean ${human(stat.meanMin)}` : ''}
            </span>
            {/* THE LAST SEVEN DAYS, against the range above it. This is the
                line that answers "is it improving" — the level on its own
                cannot. `better` means SHORTER, because these are durations. */}
            {(() => {
              const week = data.recent[leg.key];
              if (week.medianMin === null) {
                return <span className="note cycle-week">nothing finished in {data.recentDays}d</span>;
              }
              const dir = data.trend[leg.key];
              return (
                <span className={`note cycle-week${dir === null ? '' : ` ${dir}`}`}>
                  {data.recentDays}d: {human(week.medianMin)} (of {week.n})
                  {dir === 'better' ? ' ↓ better' : dir === 'worse' ? ' ↑ worse' : dir === 'flat' ? ' · level' : ''}
                </span>
              );
            })()}
          </div>
        );
      })}
      {data.warnings.map((w) => (
        <p key={w} className="note err cycle-warn">
          {w}
        </p>
      ))}
    </div>
  );
}
