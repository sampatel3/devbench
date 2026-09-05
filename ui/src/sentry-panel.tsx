import { useEffect, useState } from 'react';
import { Card, post } from './App';

/**
 * THE SENTRY PANEL — every unresolved error in one environment, and the two
 * facts that decide whether it is work: has it got a ticket, and has anybody
 * taken it.
 *
 * The operator asked to see every Sentry issue in the console, filtered by
 * environment and time range, showing which errors already have a linked GitHub
 * issue and who that issue is assigned to — so that the errors with neither a
 * ticket nor an owner are the ones left standing.
 *
 * It is its own file rather than the 8,000th line of App.tsx because it owns a
 * whole surface with its own fetches, and nothing else on the page reads any of
 * its state.
 *
 * TWO THINGS ABOUT THE FILTER. The environment goes to SENTRY, not to this
 * table: Sentry decides whether an issue fired in a given environment, and
 * filtering a cached all-environments page here would quietly answer "which of
 * the hundred most recent errors anywhere mention that word", which is a smaller
 * and different set. And it is a text box with suggestions rather than a menu
 * because Sentry's environments endpoint returns nothing for some orgs — the
 * honest fallback, which is tolerable only because a name Sentry does not know
 * comes back as a visible error rather than as an empty table. Measured against
 * a live org: a real environment with no matching errors returns 0 with no error,
 * while `nonsense-env-xyz` returns HTTP 404, and the panel shows the difference.
 *
 * THE SELECTION RULE IS THE OPERATOR'S: only errors that are NOT already linked
 * to a GitHub issue may be assigned from here — so a row with a ticket has no
 * checkbox at all, and the server re-checks at the instant of the click against a
 * fresh read, because this page's copy of "is it ticketed" can be a minute old
 * and assigning is a write.
 */

type SentryRow = {
  id: string;
  shortId: string | null;
  title: string | null;
  culprit: string | null;
  level: string | null;
  priority: string | null;
  category: string | null;
  count: number | null;
  userCount: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  permalink: string | null;
  project: string | null;
  assignee: { kind: 'user' | 'team'; name: string; email: string | null } | null;
  linkedIssueUrls: string[];
};

type SentryTriage = {
  repo: string;
  environment: string | null;
  statsPeriod: string;
  total: number;
  capped: boolean;
  error: string | null;
  items: SentryRow[];
};

/** The periods the server will accept. Kept in step with its own list. */
const PERIODS = ['1h', '24h', '7d', '14d', '30d', '90d'];

/** Sentry's own ordering, so the worst thing is at the top. */
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Priority first, then volume.
 *
 * Priority rather than `level`, because a live org settles the argument: the
 * worst error on it was `level: warning` with 449 events across 375 users.
 * Sorting on level would bury it.
 */
const bySeverity = (a: SentryRow, b: SentryRow): number =>
  (PRIORITY_RANK[a.priority ?? ''] ?? 9) - (PRIORITY_RANK[b.priority ?? ''] ?? 9) || (b.count ?? 0) - (a.count ?? 0);

const ticketOf = (row: SentryRow): string | null => row.linkedIssueUrls[0] ?? null;

/**
 * ERRORS SENTRY SPLIT THAT ARE ONE BUG.
 *
 * Two tickets, #5695 and #5696, were raised minutes apart for two Sentry issues
 * with the same message, the same culprit, the same project, the same first-seen
 * date and 79 and 72 events. Sentry grouped them apart and nothing in either
 * payload separates them beyond the group id — so taking both put two tickets on
 * one bug, and #5696 had to be closed as a duplicate.
 *
 * The console cannot know they are the same, and must not pretend to: it
 * groups on the two fields that MATCHED and says how many share them, before
 * both are ticked. Deciding they are one bug is still yours.
 *
 * Keyed on message AND culprit together. Message alone would flag every "Bad
 * Request" in the org as one bug, which is the opposite mistake and a louder one.
 */
const dupKey = (row: SentryRow): string | null =>
  row.title && row.culprit ? `${row.title}\u0000${row.culprit}` : null;

function duplicateGroups(rows: SentryRow[]): Map<string, SentryRow[]> {
  const byKey = new Map<string, SentryRow[]>();
  for (const row of rows) {
    const key = dupKey(row);
    if (key === null) continue;
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  // Only the ones that actually collide.
  for (const [key, list] of byKey) if (list.length < 2) byKey.delete(key);
  return byKey;
}

/** One issue’s outcome, as it lands. */
type TakeResult = { id: string; label: string; ok: boolean; message: string; url?: string };

/** A take in flight, or the record of one that finished. */
type TakeRun = { total: number; results: TakeResult[]; running: boolean };

/**
 * WHAT THE TAKE IS DOING, bottom right — the operator asked for a toast in the
 * same corner as the new-ticket notification, carrying a progress bar over the
 * Sentry tickets and showing any failure clearly.
 *
 * It borrows the server toasts’ own look (`.toasts`, `.toast`) rather than
 * inventing a third notification style, but it is NOT one of them: those are
 * the server deciding something is worth announcing, and this is the page
 * narrating a job it is running itself.
 *
 * IT DOES NOT LEAVE ON A TIMER WHEN ANYTHING FAILED. A six-second toast is
 * fine for "took 4" and useless for "one of these four did not happen and
 * here is why" — which is the case you actually need to read. Success
 * dismisses itself; failure waits to be dismissed.
 *
 * One caveat, stated because it is real: this sits at the same corner as the
 * server toasts and draws above them, so a gate opening DURING a take will be
 * behind this until it is dismissed. A take lasts seconds, both are
 * dismissible, and the alternative was plumbing panel state up through the
 * whole page to share one container.
 */
function TakeToast({ run, onDismiss }: { run: TakeRun; onDismiss: () => void }) {
  const done = run.results.length;
  const failures = run.results.filter((r) => !r.ok);
  const raised = run.results.filter((r) => r.ok);
  const pct = run.total === 0 ? 0 : Math.round((done / run.total) * 100);
  return (
    <div className="toasts take-toasts" role="status" aria-live="polite">
      <div className={`toast${failures.length > 0 && !run.running ? ' one' : ''}`}>
        <div className="toast-head">
          <strong>
            {run.running
              ? `Taking ${Math.min(done + 1, run.total)} of ${run.total}…`
              : failures.length === 0
                ? `Took ${raised.length} — ticket raised, linked and assigned`
                : `Took ${raised.length} of ${run.total} — ${failures.length} failed`}
          </strong>
          {!run.running && (
            <button className="x" aria-label="dismiss" onClick={onDismiss}>
              ×
            </button>
          )}
        </div>
        {/* The bar is the answer to "is it still going": a take is two writes
            per issue against two other services, and twenty-five of them is
            not instant. `aria-valuenow` so it is not only a colour. */}
        <div
          className="take-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={run.total}
          aria-valuenow={done}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
        {/* FAILURES IN FULL, each with Sentry’s own words. The successes are a
            count: those are visible in the table, where the ticket number now
            is. A failure is the only thing here that cannot be read off a row. */}
        {failures.map((f) => (
          <p key={f.id} className="note err take-fail">
            <strong>{f.label}</strong> — {f.message}
          </p>
        ))}
        {!run.running && raised.length > 0 && (
          <div className="toast-links">
            {raised.slice(0, 6).map((r) =>
              r.url ? (
                <a key={r.id} href={r.url} target="_blank" rel="noreferrer">
                  #{r.url.split('/').pop()} ↗
                </a>
              ) : (
                <span key={r.id} className="note">
                  {r.label}
                </span>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function SentryPanel() {
  // EVERY ENVIRONMENT until you name one. There is no environment this console
  // can guess for your org, and a guessed name is the one failure that looks like
  // an answer: it would show an empty table and read as "nothing is broken". The
  // empty string is passed through as no filter at all — the server drops the
  // parameter — so the first load is honest, says "every environment" in the line
  // under the toolbar, and narrowing it is one keystroke in the box beside it.
  const [environment, setEnvironment] = useState('');
  const [period, setPeriod] = useState('14d');
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [data, setData] = useState<SentryTriage | null>(null);
  const [known, setKnown] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  const [run, setRun] = useState<TakeRun | null>(null);

  const load = (): void => {
    setBusy(true);
    setFailed(null);
    const q = new URLSearchParams({ environment, statsPeriod: period });
    if (!onlyOpen) q.set('all', '1');
    void fetch(`/api/sources/sentry/triage?${q.toString()}`)
      .then((r) => r.json() as Promise<SentryTriage & { ok?: boolean; message?: string }>)
      .then((v) => {
        if (v.ok === false) {
          setFailed(v.message ?? 'Sentry could not be read');
          setData(null);
          return;
        }
        setData(v);
        // Only rows still on screen may stay selected: a refresh that dropped a
        // row must not leave it queued for a write nobody can see any more.
        setChosen((prev) => new Set([...prev].filter((id) => v.items.some((i) => i.id === id))));
      })
      .catch((e: Error) => setFailed(e.message))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    void fetch('/api/sources/sentry/environments')
      .then((r) => r.json() as Promise<{ environments?: string[] }>)
      .then((v) => setKnown(v.environments ?? []))
      .catch(() => setKnown([]));
  }, []);

  useEffect(load, [environment, period, onlyOpen]);

  const rows = [...(data?.items ?? [])].sort(bySeverity);
  const selectable = rows.filter((r) => ticketOf(r) === null);
  const dups = duplicateGroups(rows);
  const allChosen = selectable.length > 0 && selectable.every((r) => chosen.has(r.id));

  /**
   * TAKE: raise the linked GitHub ticket, then assign the error in Sentry.
   *
   * One call per selection rather than two buttons, because two buttons is how
   * four errors ended up assigned in Sentry with nothing tracking them. The
   * server raises the ticket FIRST for the same reason — see the route.
   */
  /**
   * TAKE, one issue per request.
   *
   * The server already processes a selection sequentially — these are writes to
   * two other services and a burst of them is how a rate limit turns a partial
   * success into a mystery — so doing the sequencing HERE costs nothing and buys
   * the thing a single request cannot give: a progress bar that moves, and each
   * outcome the moment it is known rather than all of them at the end.
   */
  const takeAll = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    const labelOf = (id: string): string =>
      rows.find((r) => r.id === id)?.shortId ?? `Sentry ${id}`;
    setBusy(true);
    setRun({ total: ids.length, results: [], running: true });
    const results: TakeResult[] = [];
    for (const id of ids) {
      const out = (await post('/api/sources/sentry/take', { ids: [id] })) as {
        ok: boolean;
        message: string;
        results?: Array<{ id: string; ok: boolean; message: string; url?: string }>;
      };
      const one = out.results?.[0];
      results.push({
        id,
        label: labelOf(id),
        ok: one?.ok ?? out.ok,
        // The per-issue message, not the summary: "took 0 of 1 — <reason>" is
        // the wrapper's sentence and reads oddly about a single row.
        message: one?.message ?? out.message,
        url: one?.url,
      });
      setRun({ total: ids.length, results: [...results], running: true });
    }
    setRun({ total: ids.length, results, running: false });
    setBusy(false);
    setChosen(new Set());
    load();
    // A clean run says so and goes; a run with a failure in it waits, because
    // the failure is the part you have to read.
    if (results.every((r) => r.ok)) window.setTimeout(() => setRun(null), 6000);
  };

  const take = (): void => {
    void takeAll([...chosen]);
  };

  /** The same thing for one row, so a single error does not need a tick first. */
  const takeOne = (row: SentryRow): void => {
    void takeAll([row.id]);
  };

  return (
    <div className="grid-wrap">
      {run && <TakeToast run={run} onDismiss={() => setRun(null)} />}
      <Card
        title="Sentry — unresolved, and whether anybody has it"
        subtitle="the environment and period are Sentry’s own filters, so a row here is one Sentry says fired there"
        className="wide"
      >
        <div className="toolbar sentry-filters">
          <label>
            environment
            <input
              list="sentry-envs"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
              placeholder="every environment"
            />
            <datalist id="sentry-envs">
              {known.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <label>
            period
            <select value={period} onChange={(e) => setPeriod(e.target.value)}>
              {PERIODS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="sentry-only">
            <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />
            only what has no ticket
          </label>
          <button disabled={busy} onClick={load}>
            {busy ? 'Reading…' : 'Re-read Sentry'}
          </button>
          <button className="primary" disabled={busy || chosen.size === 0} onClick={take}>
            {chosen.size === 0 ? 'Take — raise ticket + assign' : `Take ${chosen.size} — raise tickets + assign`}
          </button>
        </div>

        {failed && <p className="note err">{failed}</p>}
        {data?.error && <p className="note err">Sentry: {data.error}</p>}
        {data && (
          <p className="note">
            {data.items.length} shown of {data.capped ? `the ${data.total} most recent` : data.total} unresolved in{' '}
            <strong>{data.environment || 'every environment'}</strong> over {data.statsPeriod}
            {/* A full page is not a total. The panel says which it is looking at
                rather than implying it counted everything there is. */}
            {data.capped && ' — Sentry caps this read at 100, so there are more'}
          </p>
        )}

        <div className="grid-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={allChosen}
                    disabled={selectable.length === 0}
                    title={
                      selectable.length === 0
                        ? 'every row here already has a ticket'
                        : `select all ${selectable.length} without a ticket`
                    }
                    onChange={(e) => setChosen(e.target.checked ? new Set(selectable.map((r) => r.id)) : new Set())}
                  />
                </th>
                <th>priority</th>
                <th>events</th>
                <th>users</th>
                <th>project</th>
                <th>issue</th>
                <th>title</th>
                <th>last seen</th>
                <th>ticket</th>
                <th>assigned in Sentry</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const ticket = ticketOf(row);
                return (
                  <tr key={row.id}>
                    <td>
                      {/* NO CHECKBOX AT ALL on a ticketed row, rather than a
                          disabled one: the rule is that it cannot be assigned,
                          and a control that is present but dead invites the
                          click anyway. The title says why. */}
                      {ticket === null ? (
                        <input
                          type="checkbox"
                          checked={chosen.has(row.id)}
                          onChange={(e) =>
                            setChosen((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(row.id);
                              else next.delete(row.id);
                              return next;
                            })
                          }
                        />
                      ) : (
                        <span className="note" title="already has a ticket, so it is not yours to claim">
                          —
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`chip ${row.priority === 'high' ? 'failed' : 'aside'}`}>
                        {row.priority ?? '—'}
                      </span>
                    </td>
                    <td className="n">{row.count ?? '—'}</td>
                    <td className="n">{row.userCount ?? '—'}</td>
                    <td className="who">{row.project ?? '—'}</td>
                    <td className="who">
                      {row.permalink ? (
                        <a href={row.permalink} target="_blank" rel="noreferrer">
                          {row.shortId ?? row.id}
                        </a>
                      ) : (
                        (row.shortId ?? row.id)
                      )}
                      {(() => {
                        const key = dupKey(row);
                        const group = key === null ? undefined : dups.get(key);
                        if (!group) return null;
                        const others = group.filter((g) => g.id !== row.id);
                        return (
                          <span
                            className="chip aside sentry-dup"
                            title={
                              `Sentry also has ${others.length} other issue${others.length === 1 ? '' : 's'} with this ` +
                              `exact message and culprit: ${others.map((o) => o.shortId ?? o.id).join(', ')}. ` +
                              'They may be one bug split into several — worth checking before you take both, because ' +
                              'two tickets on one bug is two workers doing one job.'
                            }
                          >
                            {group.length}× alike
                          </span>
                        );
                      })()}
                    </td>
                    <td className="t" title={row.culprit ?? undefined}>
                      {row.title ?? '—'}
                      {/* A metric-monitor regression is not an exception, and the
                          row says which rather than letting the title imply it. */}
                      {row.category && row.category !== 'error' && (
                        <span className="chip aside sentry-kind">{row.category}</span>
                      )}
                    </td>
                    <td className="who">{row.lastSeen ? row.lastSeen.slice(0, 16).replace('T', ' ') : '—'}</td>
                    <td className="who">
                      {ticket ? (
                        <a href={ticket} target="_blank" rel="noreferrer">
                          #{ticket.split('/').pop()}
                        </a>
                      ) : (
                        <span className="note">none</span>
                      )}
                    </td>
                    <td className="who">
                      {row.assignee ? (
                        <span title={row.assignee.email ?? undefined}>
                          {row.assignee.kind === 'team' ? '#' : ''}
                          {row.assignee.name}
                        </span>
                      ) : (
                        <span className="note">nobody</span>
                      )}
                    </td>
                    <td>
                      {ticket === null && (
                        <button className="tool" disabled={busy} onClick={() => takeOne(row)} title="raise the linked GitHub ticket and assign this to you in Sentry">
                          Take
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && !busy && (
                <tr>
                  <td colSpan={11} className="note">
                    {failed ?? 'nothing unresolved without a ticket here'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <details className="report">
          <summary>What this panel can and cannot tell you</summary>
          <p className="note">
            <strong>The environment and period are Sentry’s own filters</strong>, sent with the request — so a row here
            is one Sentry says fired in that environment, not one whose text mentions it. An environment name Sentry
            does not know comes back as an error above rather than as an empty table.
          </p>
          <p className="note">
            <strong>“Ticket” is read two ways</strong>, because one is not enough: Sentry’s own record of what its
            GitHub integration filed, and the Sentry link found in a GitHub issue body this console already holds. A
            ticket raised from the button here is invisible to the first — Sentry never learns about it — so without the
            second this list would keep offering back work you had just picked up.
          </p>
          <p className="note">
            <strong>“{'{n}'}× alike” means Sentry has several issues with the identical message and culprit.</strong>{' '}
            They may be one bug it split apart — #5695 and #5696 were exactly that, and closing the second as a
            duplicate is what it cost. The console groups on the two fields that matched and counts them; deciding
            they are one bug is yours, because nothing in Sentry’s payload settles it.
          </p>
          <p className="note">
            <strong>Sentry caps this read at 100 rows.</strong> When the count says “most recent”, there are more than
            are shown, and the way to see them is a narrower environment or a shorter period until it stops saying it.
          </p>
          <p className="note">
            <strong>Take does three things and reports each one.</strong> It raises the GitHub issue{' '}
            <em>through Sentry’s own GitHub integration</em> — so it is authored by <code>app/sentry</code> and appears
            in that error’s External Links, exactly like the tickets Sentry’s dialog raises — with{' '}
            <code>needs-triage</code> and you as assignee; then it assigns the error to you in Sentry. The ticket is
            raised first on purpose: if that fails nothing has happened, whereas the other order can leave an error
            claimed but untracked.
          </p>
          <p className="note">
            <strong>The endpoint it uses is not in Sentry’s public API docs</strong> — it is the one Sentry’s own
            dialog calls, and its contract was measured against this org rather than read. So it is treated as
            fallible: the integration is re-read per issue, and a rejected field comes back as Sentry’s own words
            rather than a status code.
          </p>
        </details>
      </Card>
    </div>
  );
}
