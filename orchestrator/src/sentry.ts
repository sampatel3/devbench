/**
 * SENTRY — the console reads it, and never writes to it.
 *
 * A Sentry-connected repo already has half of this connection: Sentry's own
 * GitHub integration files the tickets. #5554 to #5558 in this console were all
 * raised by `app/sentry`, and #5555's body is the whole of what that
 * integration carries:
 *
 *     Sentry Issue: [ACME-BACKEND-CV](https://acme-corp.sentry.io/issues/1234567890/?referrer=github_integration)
 *     Error: send-welcome-email: no published definition matches
 *
 * A title and a link. Everything that decides whether the bug is worth working
 * is on the other side of that link: how many times it fired, how many people
 * it reached, when it started, whether it is still happening, which environment
 * it came from, which release, and the stack. #5555's own Gate B summary is the
 * cost of not having it: the gate closed without knowing which environment
 * fired the event, a question Sentry answers in one call.
 *
 * READ-ONLY, and structurally so: every call this module makes is a GET, the
 * token is asked for with `event:read`, and nothing here can resolve, assign,
 * comment or delete. Raising a GitHub ticket from a Sentry issue does not happen
 * here either — it goes through `newIssueUrl` in drafts.ts, which fills in
 * GitHub's own form for the operator to submit as themselves. `comment.ts` and
 * the pr-ready fence beside it remain the only things in this console that
 * write anywhere.
 *
 * THE TOKEN NEVER APPEARS IN AN ERROR. `sentryError` redacts it the way
 * `linearError` does in sources.ts, by literal and by shape, because a provider
 * that echoes a bad Authorization header back in its own message would
 * otherwise put it on the operator's screen and in the log.
 */

/** What the card needs about one Sentry issue. Every field is optional-safe:
 *  a payload that changes shape must degrade to fewer facts, never to a throw. */
export type SentryFacts = {
  /** Sentry's numeric issue id, as a string — it is an id, never arithmetic. */
  id: string;
  /** The human key, e.g. `ACME-BACKEND-CV`. */
  shortId: string | null;
  title: string | null;
  /** Where it happened, in Sentry's words. */
  culprit: string | null;
  level: string | null;
  /** `unresolved`, `resolved`, `ignored`. The one that says IS THIS STILL LIVE. */
  status: string | null;
  substatus: string | null;
  /** Total events, and people reached. Strings on the wire sometimes; numbers here. */
  count: number | null;
  userCount: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  permalink: string | null;
  project: string | null;
  /** True when Sentry says nothing caught this. */
  unhandled: boolean | null;
  /** Sentry's own high/medium/low. Present on the single-issue read too. */
  priority: string | null;
  /** `error`, `metric`, and so on. */
  category: string | null;
  /** Which environments it actually fired in, commonest first — the #5555 question. */
  environments: Array<{ name: string; count: number | null }>;
  /** Releases it has been seen in, commonest first. */
  releases: Array<{ name: string; count: number | null }>;
  firstRelease: string | null;
  lastRelease: string | null;
};

/** One row of the triage list: an unresolved Sentry issue, and whether it has a ticket yet. */
export type SentryTriageItem = {
  id: string;
  shortId: string | null;
  title: string | null;
  culprit: string | null;
  level: string | null;
  count: number | null;
  userCount: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  permalink: string | null;
  project: string | null;
  /** Sentry’s own assignee. The half of "who has this" that Sentry knows. */
  assignee: SentryAssignee | null;
  /** `error`, `performance`, and so on — a metric-monitor regression is not an
   *  exception, and the panel says which it is rather than implying one. */
  category: string | null;
  /**
   * Sentry's own `high` / `medium` / `low`.
   *
   * A better triage key than `level`: it is computed from volume and trend,
   * where `level` is whatever the code happened to pass the logger. A live org
   * proved the point — one issue was `level: warning` with 484 events across
   * 401 users, which no amount of reading "warning" would tell you.
   */
  priority: string | null;
  /**
   * Does a ticket already exist for this?
   *
   * Read from Sentry's own `integrationIssues` and `annotations`, which is where
   * the GitHub integration records the issue it created. It is the difference
   * between the triage list being useful and it being a second copy of the
   * ticket list.
   */
  linkedIssueUrls: string[];
};

/** A Sentry link found in a GitHub issue body. */
export type SentryLink = { id: string; shortId: string | null; url: string };

/** Who holds a Sentry issue, as Sentry reports it. Null when nobody does. */
export type SentryAssignee = { kind: 'user' | 'team'; name: string; email: string | null };

/** How a triage row got paired with a ticket. Both are believed; neither alone is enough. */
export type TicketLink = {
  /** The GitHub issue number, when the link points into the repo this console works. */
  number: number | null;
  url: string;
  /**
   * `sentry` — Sentry's own record, written by its GitHub integration.
   * `body` — the Sentry id found in a GitHub issue body the console already holds.
   *
   * The second exists because a ticket raised from GitHub’s own form, or by
   * hand, is invisible to the first — and a form-raised ticket is exactly what
   * this console causes. Without it the triage list would keep offering back
   * work that had just been picked up.
   */
  found: 'sentry' | 'body';
};

const NUM = /^[0-9]+$/;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Sentry sends counts as strings about as often as numbers. Both, or null. */
function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && NUM.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * THE SENTRY LINK IN A GITHUB ISSUE BODY, or null.
 *
 * This is the join between the two systems, and it is the integration's own
 * format rather than a convention anybody has to keep: a markdown link whose
 * href is `.../issues/<numeric id>/`, usually with `?referrer=github_integration`
 * and usually with the short id as the link text.
 *
 * Deliberately anchored on the ID IN THE PATH, not on the referrer or the link
 * text: a body someone has edited, quoted or reformatted still carries a usable
 * link, and the id is the only part the API needs. The FIRST such link wins —
 * a worker that pastes a second Sentry link into its own comment must not be
 * able to repoint the card at a different error.
 */
export function sentryLinkFrom(body: unknown): SentryLink | null {
  if (typeof body !== 'string' || body === '') return null;
  // Both the org-subdomain host Sentry writes and the bare one, and any region.
  const href = body.match(/https?:\/\/([a-z0-9-]+\.)*sentry\.io\/(?:organizations\/[^/\s]+\/)?issues\/([0-9]+)/i);
  if (!href) return null;
  const id = href[2]!;
  // The short id, when the link is the markdown the integration writes:
  // `[ACME-BACKEND-CV](https://…/issues/1234567890/…)`. Never invented.
  const labelled = body.match(new RegExp(`\\[([A-Z0-9][A-Z0-9-]*)\\]\\((?=[^)]*issues/${id})`, 'i'));
  return { id, shortId: labelled ? labelled[1]!.toUpperCase() : null, url: href[0] };
}

/** Top values of one aggregated tag, commonest first. */
function tagValues(tags: unknown, key: string): Array<{ name: string; count: number | null }> {
  if (!Array.isArray(tags)) return [];
  const entry = tags.find(
    (t) => typeof t === 'object' && t !== null && str((t as Record<string, unknown>).key) === key,
  );
  if (!entry) return [];
  const top = (entry as Record<string, unknown>).topValues;
  if (!Array.isArray(top)) return [];
  const out: Array<{ name: string; count: number | null }> = [];
  for (const v of top) {
    if (typeof v !== 'object' || v === null) continue;
    const row = v as Record<string, unknown>;
    const name = str(row.value) ?? str(row.name);
    if (name === null) continue;
    out.push({ name, count: num(row.count) });
  }
  return out;
}

/**
 * One issue, normalised. Null only when there is no usable id — without that
 * there is nothing the card could link to or refresh.
 *
 * `tags` is what carries the environment and release distribution, and it is
 * present on the single-issue read but not on the list read. Absent, those two
 * lists come back empty rather than guessed at.
 */
export function parseSentryIssue(raw: unknown): SentryFacts | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (id === null) return null;
  const project = r.project;
  const firstRelease = r.firstRelease;
  const lastRelease = r.lastRelease;
  const metadata = (typeof r.metadata === 'object' && r.metadata !== null ? r.metadata : {}) as Record<
    string,
    unknown
  >;
  return {
    id,
    shortId: str(r.shortId),
    // `metadata.value` is the error's own message and is usually the more
    // specific of the two; `title` is the fallback, never the other way round.
    title: str(metadata.value) ?? str(r.title) ?? str(metadata.title),
    culprit: str(r.culprit),
    level: str(r.level),
    status: str(r.status),
    substatus: str(r.substatus),
    count: num(r.count),
    userCount: num(r.userCount),
    firstSeen: str(r.firstSeen),
    lastSeen: str(r.lastSeen),
    permalink: str(r.permalink),
    project: typeof project === 'object' && project !== null ? str((project as Record<string, unknown>).slug) : null,
    unhandled: typeof r.isUnhandled === 'boolean' ? r.isUnhandled : null,
    priority: str(r.priority),
    category: str(r.issueCategory) ?? str(r.issueType),
    environments: tagValues(r.tags, 'environment'),
    releases: tagValues(r.tags, 'release'),
    firstRelease:
      typeof firstRelease === 'object' && firstRelease !== null
        ? (str((firstRelease as Record<string, unknown>).shortVersion) ??
          str((firstRelease as Record<string, unknown>).version))
        : null,
    lastRelease:
      typeof lastRelease === 'object' && lastRelease !== null
        ? (str((lastRelease as Record<string, unknown>).shortVersion) ??
          str((lastRelease as Record<string, unknown>).version))
        : null,
  };
}

/**
 * Every URL Sentry knows this issue is already linked to.
 *
 * `integrationIssues` is where the GitHub integration records what it filed;
 * `annotations` is the older shape and is still what some payloads carry, as
 * either a bare HTML string or an object. All of them are read, because the one
 * that is missed is the one that would make an already-ticketed error show up
 * on the triage list as new work.
 */
export function linkedIssueUrlsOf(raw: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const push = (u: string | null): void => {
    if (u !== null) out.add(u);
  };
  const fromHtml = (html: string): void => {
    for (const m of html.matchAll(/href="([^"]+)"/g)) push(str(m[1]));
  };
  const integration = raw.integrationIssues;
  if (Array.isArray(integration)) {
    for (const i of integration) {
      if (typeof i !== 'object' || i === null) continue;
      push(str((i as Record<string, unknown>).url));
    }
  }
  const annotations = raw.annotations;
  if (Array.isArray(annotations)) {
    for (const a of annotations) {
      if (typeof a === 'string') fromHtml(a);
      else if (typeof a === 'object' && a !== null) push(str((a as Record<string, unknown>).url));
    }
  }
  return [...out];
}

/** The unresolved list, normalised. Rows with no id are dropped, never guessed. */
export function parseSentryList(raw: unknown): SentryTriageItem[] {
  if (!Array.isArray(raw)) return [];
  const items: SentryTriageItem[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const id = str(r.id);
    if (id === null) continue;
    const project = r.project;
    const metadata = (typeof r.metadata === 'object' && r.metadata !== null ? r.metadata : {}) as Record<
      string,
      unknown
    >;
    items.push({
      id,
      shortId: str(r.shortId),
      title: str(metadata.value) ?? str(r.title) ?? str(metadata.title),
      culprit: str(r.culprit),
      level: str(r.level),
      count: num(r.count),
      userCount: num(r.userCount),
      firstSeen: str(r.firstSeen),
      lastSeen: str(r.lastSeen),
      permalink: str(r.permalink),
      project: typeof project === 'object' && project !== null ? str((project as Record<string, unknown>).slug) : null,
      assignee: assigneeOf(r.assignedTo),
      category: str(r.issueCategory) ?? str(r.issueType),
      priority: str(r.priority),
      linkedIssueUrls: linkedIssueUrlsOf(r),
    });
  }
  return items;
}

/**
 * WHO HOLDS IT. `assignedTo` is an actor object, or absent.
 *
 * A team is reported as a team rather than flattened into a name: "assigned to
 * #platform" and "assigned to a person" are different facts, and only the
 * second means somebody has actually picked it up.
 */
export function assigneeOf(raw: unknown): SentryAssignee | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name) ?? str(r.email) ?? str(r.slug);
  if (name === null) return null;
  return { kind: str(r.type) === 'team' ? 'team' : 'user', name, email: str(r.email) };
}

/**
 * The GitHub issue number in a github.com URL for THIS repo, or null.
 *
 * A plain string search rather than a built regex: the repo name is data, and
 * a dynamic pattern over data is how a `.` in an owner name quietly becomes a
 * wildcard.
 */
export function issueNumberIn(url: string, repo: string): number | null {
  const needle = `github.com/${repo.toLowerCase()}/issues/`;
  const at = url.toLowerCase().indexOf(needle);
  if (at < 0) return null;
  const digits = url.slice(at + needle.length).match(/^[0-9]+/);
  return digits ? Number(digits[0]) : null;
}

/**
 * THE ENVIRONMENT NAMES, from whatever shape the endpoint returns.
 *
 * A typed environment box is the wrong control, and the live org showed why:
 * `production` came back with 0 unresolved (a real environment, nothing in it)
 * while `nonsense-env-xyz` came back HTTP 404. Those look identical on a card
 * that only shows a count, so the filter has to offer the names Sentry admits
 * to rather than accept anything typed at it.
 *
 * Hidden environments are dropped: Sentry hides one when somebody has decided
 * it is not worth looking at, and this list is a menu of things to look at.
 */
export function parseSentryEnvironments(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const row of raw) {
    if (typeof row === 'string') {
      const name = row.trim();
      if (name) out.push(name);
      continue;
    }
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (r.isHidden === true) continue;
    const name = str(r.name) ?? str(r.displayName) ?? str(r.id);
    if (name !== null) out.push(name);
  }
  return [...new Set(out)];
}

/** True when one of the linked URLs is an issue in the repo this console works. */
export function hasTicketIn(item: SentryTriageItem, repo: string): boolean {
  const needle = `/${repo.toLowerCase()}/issues/`;
  return item.linkedIssueUrls.some((u) => u.toLowerCase().includes(needle));
}

/**
 * THE TICKET A SENTRY ISSUE DESERVES, as a draft for GitHub’s own form.
 *
 * The operator does four things by hand on every one of these: set the repo,
 * write the title, paste the Sentry link, then self-assign and add
 * `needs-triage`. GitHub’s new-issue URL carries all four, so the form arrives
 * finished and you press Submit — which is the one step that has to stay
 * yours, because creating an issue is on this console’s write fence.
 *
 * The BODY leads with the Sentry link in the same shape Sentry’s own
 * integration writes it, deliberately: `sentryLinkFrom` finds that shape, so a
 * ticket raised this way is recognised as the pair of this error by the very
 * next poll — with no help from Sentry, which never learns about it.
 */
/**
 * What `ticketDraftFor` actually reads — structural on purpose, so a row from
 * the LIST and a single-issue READ both satisfy it. The take path uses the
 * single-issue read; see `Orchestrator`-side note in the route.
 */
export type TicketSource = Pick<
  SentryTriageItem,
  'id' | 'shortId' | 'title' | 'culprit' | 'level' | 'priority' | 'category' | 'count' | 'userCount' | 'firstSeen' | 'lastSeen' | 'permalink' | 'project'
>;

export function ticketDraftFor(item: TicketSource): { title: string; body: string; labels: string[] } {
  const name = item.shortId ?? `Sentry issue ${item.id}`;
  // WHAT, WHERE, AND WHICH ONE — in that order, and every part earns its place.
  //
  // The first four tickets this raised were #5695, #5696 and #5698, all titled
  // exactly "Bad Request", because the message alone is what Sentry puts in
  // `metadata.value`. Three identical rows in the queue, and a worker picking
  // one up learns nothing until it opens the Sentry link.
  //
  // The culprit is what says WHERE: those three were two different request
  // paths, one of them hit twice. And the short id is what makes the two that
  // share a path distinguishable at all, because
  // #5695 and #5696 share both the message AND the culprit — Sentry grouped
  // them separately and nothing else in the payload tells them apart.
  const message = item.title ?? name;
  const where = item.culprit && !message.includes(item.culprit) ? ` — ${item.culprit}` : '';
  // Skipped when the message already carries it, which is the metric-monitor
  // case: "Critical: p75(measurements.lcp) in the last hour above 4000.0" is
  // already specific and does not want a short id bolted on.
  const which = message === name ? '' : ` (${name})`;
  const title = `${message}${where}${which}`;
  const facts: string[] = [];
  const seen = (iso: string | null): string => (iso ? iso.replace('T', ' ').replace('Z', ' UTC') : 'unknown');
  if (item.priority) facts.push(`- Sentry priority: **${item.priority}**`);
  if (item.level) facts.push(`- Level: ${item.level}`);
  if (item.category) facts.push(`- Kind: ${item.category}`);
  if (item.count !== null) facts.push(`- Events: ${item.count}`);
  if (item.userCount !== null) facts.push(`- Users affected: ${item.userCount}`);
  if (item.project) facts.push(`- Project: ${item.project}`);
  facts.push(`- First seen: ${seen(item.firstSeen)}`);
  facts.push(`- Last seen: ${seen(item.lastSeen)}`);
  if (item.culprit) facts.push(`- Culprit: \`${item.culprit}\``);
  const link = item.permalink ?? `https://sentry.io/issues/${item.id}/`;
  const body = [
    `Sentry Issue: [${name}](${link})`,
    "",
    "```",
    item.title ?? name,
    "```",
    "",
    "**What Sentry knows**",
    ...facts,
    "",
    "_Raised from the worker console’s Sentry panel. The figures above are Sentry’s at the moment the ticket was drafted._",
  ].join('\n');
  return { title, body, labels: ['needs-triage'] };
}

/**
 * A Sentry error message with the token taken out of it — by literal value and
 * by shape. Sentry's tokens are `sntrys_…` (org), `sntryu_…` (user) and a bare
 * 64-hex legacy form, and an auth failure is exactly the case where a service
 * is most likely to quote the header back.
 */
export function sentryError(error: unknown, token: string): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of new Set([token, token.trim()])) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  message = message.replace(/sntry[a-z]_[A-Za-z0-9_-]+/gi, '[redacted]').replace(/\b[0-9a-f]{64}\b/gi, '[redacted]');
  return (
    message
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? 'unknown error'
  );
}

/** Reject a token that could break a header, before it is ever sent. */
export function validSentryToken(value: string): string {
  const token = value.trim();
  if (!token) throw new Error('Enter a Sentry auth token with the event:read scope');
  if (/[\u0000-\u001f\u007f]/.test(token)) throw new Error('The Sentry token contains invalid characters');
  return token;
}

/** `acme-corp`, or whatever slug their Sentry URL carries. */
export function validSentryOrg(value: string): string {
  const org = value.trim().toLowerCase();
  if (!org) throw new Error('Enter your Sentry organisation slug, e.g. acme-corp');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(org)) throw new Error(`'${value}' is not a Sentry organisation slug`);
  return org;
}

/**
 * The host their own URL proves resolves: `https://<org>.sentry.io/api/0`.
 *
 * Sentry is region-partitioned now and `sentry.io/api/0` is not correct for
 * every organisation, but the org subdomain is — it is the host in the link the
 * GitHub integration writes into every one of these tickets.
 */
export function sentryApiBase(org: string, override?: string | null): string {
  const base = (override ?? '').trim();
  return (base !== '' ? base : `https://${org}.sentry.io/api/0`).replace(/\/+$/, '');
}
