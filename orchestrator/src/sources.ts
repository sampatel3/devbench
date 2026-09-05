import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type WorkSourceId = 'github' | 'linear' | 'sentry';

export type WorkItem = {
  source: WorkSourceId;
  /** Stable across refreshes. Includes the provider so GitHub and Linear ids cannot collide. */
  id: string;
  /** The short identifier a person recognises: owner/repo#123 or ENG-123. */
  key: string;
  title: string;
  url: string;
  status: string;
  updatedAt: string;
  labels: string[];
  priority: string | null;
  repository: string | null;
  project: string | null;
  /** Present only for GitHub. Never infer a Linear identifier into a number. */
  number: number | null;
};

export type WorkSourceStatus = {
  id: WorkSourceId;
  name: string;
  connected: boolean;
  account: string | null;
  detail: string;
  error: string | null;
  itemCount: number;
  /** A safe command to copy when the provider is not connected. */
  connectCommand: string | null;
  /** Where a credential lives. No credential value ever leaves this module. */
  managedBy: 'gh' | 'file' | 'environment' | null;
  /**
   * Sentry only: who "assign to me" resolves to, or null when nobody is set.
   *
   * Deliberately NOT treated as a credential. It is your own address, the panel
   * cannot assign without it, and a field whose value you cannot see is a field
   * you cannot tell is wrong.
   */
  assignAs?: string | null;
};

export type WorkSourcesSnapshot = {
  sources: WorkSourceStatus[];
  items: WorkItem[];
  refreshedAt: string;
};

export type WorkSourceApi = {
  snapshot(refresh?: boolean): Promise<WorkSourcesSnapshot>;
  connectLinear(apiKey: string): Promise<WorkSourcesSnapshot>;
  disconnectLinear(): Promise<WorkSourcesSnapshot>;
  connectSentry(token: string, org: string, email?: string | null): Promise<WorkSourcesSnapshot>;
  /** Who "assign to me" means. Empty clears it, which disables assigning. */
  setSentryIdentity(email: string): Promise<WorkSourcesSnapshot>;
  /** The one Sentry write: assign this issue to you, unless it is already ticketed. */
  assignSentryIssue(id: string): Promise<{ ok: boolean; message: string }>;
  disconnectSentry(): Promise<WorkSourcesSnapshot>;
  /**
   * The unresolved errors from the last refresh, newest first.
   *
   * Served from the snapshot rather than its own request: the triage panel and
   * the header count are two views of ONE read, which is the rule the rest of
   * this console follows about the age of what is on screen.
   */
  /** One issue by id — uncapped and unfiltered, unlike any list read. */
  sentryIssue(id: string): Promise<SentryFacts | null>;
  /** Raise the GitHub issue through Sentry and link it. See the method. */
  createLinkedTicket(
    id: string,
    draft: { title: string; body: string; labels: string[] },
    assignee: string | null,
  ): Promise<{ ok: boolean; message: string; url?: string }>;
  sentryTriage(): SentryTriageItem[];
  /** The environment names the filter offers. Empty when Sentry will not say. */
  sentryEnvironments(): Promise<string[]>;
  /** One environment, one period — the panel’s own read. See the method. */
  sentryIssues(filter?: { environment?: string | null; statsPeriod?: string | null }): Promise<{
    items: SentryTriageItem[];
    capped: boolean;
    error: string | null;
  }>;
};

type CommandRunner = (file: string, args: string[]) => Promise<string>;
type HttpClient = typeof fetch;

export type WorkSourceServiceOptions = {
  credentialsFile: string;
  linearApiKey?: string;
  /**
   * The repo this console works, e.g. `example-org/example-repo`.
   *
   * Only Sentry needs it, and only to answer the one question that makes the
   * triage list worth having: has this error been ticketed HERE already? Sentry
   * records what its GitHub integration filed, so the answer is in the payload.
   */
  repo?: string;
  cacheMs?: number;
  requestTimeoutMs?: number;
  command?: CommandRunner;
  fetch?: HttpClient;
  now?: () => Date;
};

type CredentialsFile = {
  linear?: { apiKey: string };
  /**
   * Sentry, read-only. Deliberately NO environment override, unlike Linear:
   * `SENTRY_AUTH_TOKEN` already exists in this repo family for uploading
   * source maps, and that token is scoped for releases rather than
   * `event:read`. Picking it up automatically would look connected and fail on
   * every read, so the file is the only place this comes from.
   */
  sentry?: {
    token: string;
    org: string;
    /**
     * Who "assign to me" means, as Sentry knows him.
     *
     * Sentry's update endpoint takes a username or a primary email, and the
     * console has no way to ask a token who it belongs to without a scope you
     * have not granted (`member:read`). So it is stored — your own address, not
     * a secret, and kept beside the token rather than guessed at each call.
     * Absent means the panel can list and filter but cannot assign, and says so.
     */
    email?: string;
  };
};

type GithubSearchRow = {
  number?: unknown;
  title?: unknown;
  url?: unknown;
  updatedAt?: unknown;
  repository?: { nameWithOwner?: unknown } | null;
  labels?: Array<{ name?: unknown }> | null;
};

type LinearIssueRow = {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  url?: unknown;
  priority?: unknown;
  updatedAt?: unknown;
  state?: { name?: unknown; type?: unknown } | null;
  team?: { name?: unknown; key?: unknown } | null;
  project?: { name?: unknown } | null;
  labels?: { nodes?: Array<{ name?: unknown }> } | null;
};

type LinearPage = {
  data?: {
    viewer?: {
      id?: unknown;
      name?: unknown;
      email?: unknown;
      assignedIssues?: {
        nodes?: LinearIssueRow[];
        pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
      };
    };
  };
  errors?: Array<{ message?: unknown }>;
};

import {
  hasTicketIn,
  issueNumberIn,
  linkedIssueUrlsOf,
  parseSentryEnvironments,
  parseSentryIssue,
  type SentryFacts,
  parseSentryList,
  sentryApiBase,
  sentryError,
  validSentryOrg,
  validSentryToken,
  type SentryTriageItem,
} from './sentry.js';

/** Sentry's own maximum for this endpoint. Asking for more is silently capped. */
const SENTRY_PAGE = 100;

/**
 * The periods the panel offers, and the only ones it will send.
 *
 * Sentry rejects an unknown `statsPeriod` with a 400, so an unvalidated value
 * from a query string would turn a typo in a URL into a broken panel. 14d is
 * the default because it is the window the operator said they work in.
 */
const SENTRY_PERIODS = new Set(['1h', '24h', '7d', '14d', '30d', '90d']);

function validPeriod(value: unknown): string {
  const period = typeof value === 'string' ? value.trim() : '';
  return SENTRY_PERIODS.has(period) ? period : '14d';
}

const LINEAR_URL = 'https://api.linear.app/graphql';
const GITHUB_LOGIN_COMMAND = 'gh auth login --web';

const realCommand: CommandRunner = async (file, args) => {
  const { stdout } = await run(file, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
};

function firstError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\x1b\[[0-9;]*m/g, '').split('\n').find((line) => line.trim())?.trim() ?? 'unknown error';
}

function linearError(error: unknown, apiKey: string): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of new Set([apiKey, apiKey.trim()])) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  // Defence in depth for provider errors that echo or reformat a conventional key.
  message = message.replace(/lin_api_[a-z0-9_-]+/gi, '[redacted]');
  return firstError(message);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function validLinearKey(value: string): string {
  const key = value.trim();
  if (!key) throw new Error('Enter a Linear personal API key');
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new Error('The Linear API key contains invalid characters');
  return key;
}

function linearPriority(value: unknown): string | null {
  const priorities: Record<number, string | null> = { 0: null, 1: 'Urgent', 2: 'High', 3: 'Normal', 4: 'Low' };
  return typeof value === 'number' && value in priorities ? priorities[value]! : null;
}

export function parseGithubItems(raw: string): WorkItem[] {
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    throw new Error('GitHub returned work items that were not valid JSON');
  }
  if (!Array.isArray(rows)) throw new Error('GitHub returned an unexpected work-item list');

  const items: WorkItem[] = [];
  for (const candidate of rows as GithubSearchRow[]) {
    const number = typeof candidate.number === 'number' ? candidate.number : null;
    const repository = text(candidate.repository?.nameWithOwner);
    const title = text(candidate.title);
    const url = text(candidate.url);
    if (number === null || !repository || !title || !url) continue;
    const key = `${repository}#${number}`;
    items.push({
      source: 'github',
      id: `github:${key}`,
      key,
      title,
      url,
      status: 'Open',
      updatedAt: text(candidate.updatedAt),
      labels: (candidate.labels ?? []).map((label) => text(label.name)).filter(Boolean),
      priority: null,
      repository,
      project: repository,
      number,
    });
  }
  return items;
}

export function parseLinearItems(rows: LinearIssueRow[]): WorkItem[] {
  const items: WorkItem[] = [];
  for (const candidate of rows) {
    const rawId = text(candidate.id);
    const key = text(candidate.identifier);
    const title = text(candidate.title);
    const url = text(candidate.url);
    if (!rawId || !key || !title || !url) continue;
    items.push({
      source: 'linear',
      id: `linear:${rawId}`,
      key,
      title,
      url,
      status: text(candidate.state?.name) || 'Open',
      updatedAt: text(candidate.updatedAt),
      labels: (candidate.labels?.nodes ?? []).map((label) => text(label.name)).filter(Boolean),
      priority: linearPriority(candidate.priority),
      repository: null,
      project: text(candidate.project?.name) || text(candidate.team?.name) || null,
      number: null,
    });
  }
  return items;
}

async function readCredentials(file: string): Promise<CredentialsFile> {
  const raw = await readFile(file, 'utf8').catch(() => null);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: CredentialsFile = {};
    const linear = parsed.linear;
    if (typeof linear === 'object' && linear !== null) {
      const apiKey = text((linear as Record<string, unknown>).apiKey);
      if (apiKey) out.linear = { apiKey };
    }
    const sentry = parsed.sentry;
    if (typeof sentry === 'object' && sentry !== null) {
      const row = sentry as Record<string, unknown>;
      const token = text(row.token);
      const org = text(row.org);
      const email = text(row.email);
      if (token && org) out.sentry = email ? { token, org, email } : { token, org };
    }
    return out;
  } catch {
    return {};
  }
}

/** Atomic and owner-only: this file holds the Linear API key and the Sentry token. */
async function writeCredentials(file: string, credentials: CredentialsFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

const LINEAR_ASSIGNED_QUERY = `query WorkerConsoleAssigned($first: Int!, $after: String, $filter: IssueFilter) {
  viewer {
    id name email
    assignedIssues(first: $first, after: $after, orderBy: updatedAt, filter: $filter) {
      nodes {
        id identifier title url priority updatedAt
        state { name type }
        team { name key }
        project { name }
        labels { nodes { name } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export class WorkSourceService {
  readonly #options: Required<
    Pick<WorkSourceServiceOptions, 'credentialsFile' | 'cacheMs' | 'requestTimeoutMs' | 'command' | 'fetch' | 'now'>
  > &
    Pick<WorkSourceServiceOptions, 'linearApiKey' | 'repo'>;
  #cached: WorkSourcesSnapshot | null = null;
  /** The unresolved errors from the last refresh. One read, two views. */
  #sentryItems: SentryTriageItem[] = [];
  /** The org’s environment names. Read once — they change when somebody deploys
   *  a new one, which is not often enough to re-ask on every panel open. */
  #sentryEnvironments: string[] | null = null;
  /** Filtered panel reads, keyed by `environment|period`. */
  #sentryQueries = new Map<string, { at: number; value: { items: SentryTriageItem[]; capped: boolean; error: string | null } }>();
  #cachedAt = 0;
  #revision = 0;
  #inflight: { revision: number; promise: Promise<WorkSourcesSnapshot> } | null = null;

  constructor(options: WorkSourceServiceOptions) {
    this.#options = {
      credentialsFile: options.credentialsFile,
      linearApiKey: options.linearApiKey?.trim() || undefined,
      repo: options.repo?.trim() || undefined,
      cacheMs: options.cacheMs ?? 60_000,
      requestTimeoutMs: Math.max(1, options.requestTimeoutMs ?? 30_000),
      command: options.command ?? realCommand,
      fetch: options.fetch ?? fetch,
      now: options.now ?? (() => new Date()),
    };
  }

  async snapshot(refresh = false): Promise<WorkSourcesSnapshot> {
    const now = this.#options.now().getTime();
    if (!refresh && this.#cached && now - this.#cachedAt < this.#options.cacheMs) return this.#cached;
    const revision = this.#revision;
    if (this.#inflight?.revision === revision) return this.#inflight.promise;

    const promise = this.#refresh(revision).finally(() => {
      if (this.#inflight?.promise === promise) this.#inflight = null;
    });
    this.#inflight = { revision, promise };
    return promise;
  }

  async connectLinear(apiKey: string): Promise<WorkSourcesSnapshot> {
    const key = validLinearKey(apiKey);
    if (this.#options.linearApiKey) {
      throw new Error('Linear is managed by LINEAR_API_KEY; change or remove that environment variable, then restart');
    }

    // Validate before writing. A mistyped key must not replace a working connection.
    const probe = await this.#readLinear(key);
    if (!probe.status.connected) throw new Error(probe.status.error ?? 'Linear rejected that API key');
    await writeCredentials(this.#options.credentialsFile, { linear: { apiKey: key } });
    this.#revision += 1;
    this.#cached = null;
    return this.snapshot(true);
  }

  async disconnectLinear(): Promise<WorkSourcesSnapshot> {
    if (this.#options.linearApiKey) {
      throw new Error('Linear is managed by LINEAR_API_KEY; remove that environment variable, then restart');
    }
    // Only Linear's own key. This used to unlink the whole file, which was
    // harmless while Linear was the only thing in it and would now disconnect
    // Sentry as a side effect of disconnecting Linear.
    await this.#forget('linear');
    return this.snapshot(true);
  }

  /**
   * CONNECT SENTRY, read-only.
   *
   * Validated before it is written, like Linear's key: a mistyped token must
   * not replace a working connection, and the probe is the same list request
   * the snapshot makes, so "connected" means the exact call the console relies
   * on has succeeded once.
   */
  async connectSentry(token: string, org: string, email?: string | null): Promise<WorkSourcesSnapshot> {
    const t = validSentryToken(token);
    const o = validSentryOrg(org);
    const who = (email ?? '').trim();
    const probe = await this.#readSentry(t, o);
    if (!probe.status.connected) throw new Error(probe.status.error ?? 'Sentry rejected that token');
    const existing = await readCredentials(this.#options.credentialsFile);
    await writeCredentials(this.#options.credentialsFile, {
      ...existing,
      // A reconnect that names nobody keeps whoever was named before: the token is
      // what is being replaced, not the person the panel assigns work to.
      sentry: { token: t, org: o, ...(who ? { email: who } : existing.sentry?.email ? { email: existing.sentry.email } : {}) },
    });
    this.#revision += 1;
    this.#cached = null;
    return this.snapshot(true);
  }

  /**
   * WHO "ASSIGN TO ME" MEANS, set on its own.
   *
   * Its own call rather than part of `connectSentry`, because the token and
   * the identity have different lifetimes: a token gets rotated, and being
   * made to paste a fresh one just to correct a typo in an email address is
   * how a field ends up wrong for ever. Sentry accepts a username or a primary
   * email (`assignedTo`), and it is his own address rather than a secret.
   */
  async setSentryIdentity(email: string): Promise<WorkSourcesSnapshot> {
    const who = email.trim();
    const existing = await readCredentials(this.#options.credentialsFile);
    if (!existing.sentry) throw new Error('Connect Sentry first');
    if (who && /[\u0000-\u001f\u007f,]/.test(who)) {
      throw new Error('That is not a usable Sentry username or email');
    }
    await writeCredentials(this.#options.credentialsFile, {
      ...existing,
      // An empty value CLEARS it, which is the only way back to "cannot
      // assign" — and that has to be reachable, because a wrong identity
      // assigns somebody else's name to work.
      sentry: { token: existing.sentry.token, org: existing.sentry.org, ...(who ? { email: who } : {}) },
    });
    this.#revision += 1;
    this.#cached = null;
    return this.snapshot(true);
  }

  async disconnectSentry(): Promise<WorkSourcesSnapshot> {
    await this.#forget('sentry');
    return this.snapshot(true);
  }

  /**
   * The environment names the panel offers. Empty when Sentry will not say —
   * and the panel then falls back to a free-text box, which is worse but is
   * better than an empty menu.
   */
  async sentryEnvironments(): Promise<string[]> {
    if (this.#sentryEnvironments !== null) return this.#sentryEnvironments;
    const credentials = await readCredentials(this.#options.credentialsFile);
    if (!credentials.sentry) return [];
    const { token, org } = credentials.sentry;
    try {
      const url = `${sentryApiBase(org)}/organizations/${encodeURIComponent(org)}/environments/`;
      const response = await this.#options.fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.#options.requestTimeoutMs),
      });
      if (!response.ok) return [];
      const names = parseSentryEnvironments(await response.json());
      this.#sentryEnvironments = names;
      return names;
    } catch {
      // A failure here costs the menu, not the panel. Never cached, so the
      // next open tries again.
      return [];
    }
  }

  /**
   * ONE Sentry issue, by id.
   *
   * The take path uses this rather than looking the id up in a list, and the
   * reason is a bug this had: the route searched an UNFILTERED read while the
   * panel showed a filtered one, and both are capped at Sentry’s 100. So
   * ACME-FRONTEND-K7 — comfortably inside the top 100 for `aus`, outside it
   * across every environment — could be seen on the row and not found by the
   * button. Silent, and dependent on how old the error was.
   *
   * A read by id has no cap and no filter, so nothing the panel can show is
   * unreachable by the button.
   */
  async sentryIssue(id: string): Promise<SentryFacts | null> {
    const credentials = await readCredentials(this.#options.credentialsFile);
    if (!credentials.sentry) return null;
    const { token, org } = credentials.sentry;
    try {
      const url = `${sentryApiBase(org)}/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(id)}/`;
      const response = await this.#options.fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.#options.requestTimeoutMs),
      });
      if (!response.ok) return null;
      return parseSentryIssue(await response.json());
    } catch {
      return null;
    }
  }

  /**
   * RAISE THE GITHUB ISSUE THROUGH SENTRY, AND LINK IT — one call, the same
   * one Sentry's own "Create GitHub Issue" dialog makes.
   *
   * The operator rejected the prefilled-form version: a "raise a ticket" button
   * that only drops you into GitHub does not link anything back to the Sentry
   * issue. That is right, and the form version left the worst state available:
   * four errors assigned in Sentry with nothing tracking them.
   *
   * THIS ENDPOINT IS NOT IN SENTRY’S PUBLIC DOCS, so its contract was measured
   * against the live org rather than read. What was found, on 2026-09-03:
   *
   *   GET  {org}/issues/{id}/integrations/                 200 — the GitHub
   *        integration, with its id (426726 here). The ORG-WIDE list at
   *        {org}/integrations/ is 403 for an `event:read` token, so the id is
   *        taken from the issue, which is the only place it is needed.
   *   GET  {org}/issues/{id}/integrations/{id}/            400 — "Action is
   *        required and should be either link or create". The contract, stated
   *        by the endpoint itself.
   *   GET  {org}/issues/{id}/integrations/{id}/?action=create
   *        200 — `createIssueConfig`: repo (select, required, choices include
   *        the configured repo), title (string, required), description (textarea),
   *        assignee (select, choices are GitHub logins), labels (multi-select,
   *        choices are the repo’s real labels).
   *
   * Because it is undocumented it is treated as fallible in a way a documented
   * call would not be: the integration id is re-read per issue rather than
   * cached, an unexpected shape is reported rather than assumed past, and the
   * caller is told exactly which step failed.
   *
   * ON THE WRITE FENCE. This makes the console the cause of a GitHub issue
   * without you pressing Submit on GitHub, which `comment.ts` deliberately
   * refuses for `gh issue create`. That is a real widening and it is the
   * operator's, asked for twice. It stays narrow: one issue per click,
   * only through Sentry’s own integration, only into the repo this console is
   * configured for, and only for an error that has no ticket yet.
   */
  async createLinkedTicket(
    id: string,
    draft: { title: string; body: string; labels: string[] },
    assignee: string | null,
  ): Promise<{ ok: boolean; message: string; url?: string }> {
    const credentials = await readCredentials(this.#options.credentialsFile);
    const credential = credentials.sentry;
    if (!credential) return { ok: false, message: 'Sentry is not connected' };
    const repo = this.#options.repo;
    if (!repo) return { ok: false, message: 'no repo configured for this console' };
    const { token, org } = credential;
    const base = `${sentryApiBase(org)}/organizations/${encodeURIComponent(org)}/issues/${encodeURIComponent(id)}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    try {
      // 1. WHICH INTEGRATION, and does this issue already have a ticket? Both
      //    answers are in one read, and the guard is decided on it rather than
      //    on what the panel was showing a minute ago.
      const listed = await this.#options.fetch(`${base}/integrations/`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.#options.requestTimeoutMs),
      });
      if (!listed.ok) {
        return { ok: false, message: `could not read this issue’s integrations — HTTP ${listed.status}` };
      }
      const rows = (await listed.json()) as Array<Record<string, unknown>>;
      const github = Array.isArray(rows)
        ? rows.find((r) => ((r.provider as Record<string, unknown> | undefined)?.key ?? '') === 'github')
        : undefined;
      if (!github) {
        return { ok: false, message: 'this Sentry org has no GitHub integration on that issue' };
      }
      const existing = github.externalIssues;
      if (Array.isArray(existing) && existing.length > 0) {
        const first = existing[0] as Record<string, unknown>;
        return {
          ok: false,
          message: `that error already has a ticket (${String(first.url ?? first.key ?? 'linked')}) — nothing was raised`,
        };
      }
      const integrationId = String(github.id ?? '');
      if (!integrationId) return { ok: false, message: 'the GitHub integration has no id' };

      // 2. CREATE AND LINK. `action: create` is the endpoint’s own word for it.
      // THE VERB IS THE OPERATION on this endpoint, not the `action` parameter:
      // POST creates, PUT links an issue that already exists. Both wrong guesses
      // came back identically — `externalIssue: ["Issue ID is required"]`, PUT
      // asking for the id of the thing to link to — first with `action` in the
      // body and again with it on the query string, which is what ruled the
      // parameter out as the discriminator. `?action=create` matters only to the
      // GET that returns the form config.
      const response = await this.#options.fetch(
        `${base}/integrations/${encodeURIComponent(integrationId)}/`,
        {
        method: 'POST',
        headers,
        body: JSON.stringify({
          repo,
          title: draft.title,
          description: draft.body,
          // Empty string is how the form says "Unassigned"; null would be a
          // different thing and is not one of its choices.
          assignee: assignee ?? '',
          labels: draft.labels,
        }),
        signal: AbortSignal.timeout(this.#options.requestTimeoutMs),
        },
      );
      const text = await response.text();
      if (!response.ok) {
        // Sentry answers a rejected field with a message worth showing rather
        // than a status code: a label that does not exist, a repo the
        // integration cannot see, an assignee who is not a collaborator.
        let why = `Sentry returned HTTP ${response.status}`;
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          const detail = typeof parsed.detail === 'string' ? parsed.detail : null;
          const first = Object.entries(parsed).find(([k]) => k !== 'detail');
          why = detail ?? (first ? `${first[0]}: ${JSON.stringify(first[1])}` : why);
        } catch {
          if (text.trim()) why = `${why} — ${text.slice(0, 200)}`;
        }
        return { ok: false, message: why };
      }
      let url: string | undefined;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const ext = parsed.externalIssues;
        if (Array.isArray(ext) && ext.length > 0) {
          const one = ext[0] as Record<string, unknown>;
          url = typeof one.url === 'string' ? one.url : undefined;
        }
      } catch {
        // A success we cannot read the url out of is still a success. The next
        // read of the panel finds the link either way.
      }
      this.#sentryQueries.clear();
      this.#cached = null;
      return { ok: true, message: url ? `raised and linked ${url}` : 'raised and linked in GitHub', url };
    } catch (error) {
      return { ok: false, message: sentryError(error, token) };
    }
  }

  sentryTriage(): SentryTriageItem[] {
    return this.#sentryItems;
  }

  /**
   * THE PANEL’S OWN READ: unresolved issues in ONE environment, over ONE period.
   *
   * Not served off the snapshot, and that is the whole point. Sentry decides
   * environment membership — an issue fires in `aus` or it does not, and the
   * list endpoint answers that with the `environment` parameter. Filtering the
   * cached all-environments page in the browser would answer a different
   * question: "of the hundred most recent errors anywhere, which mention aus",
   * which is not the same set and is silently smaller.
   *
   * Its own small cache, keyed by the filter, so flipping between `aus` and
   * `uat` twice does not cost four requests.
   */
  async sentryIssues(filter: { environment?: string | null; statsPeriod?: string | null } = {}): Promise<{
    items: SentryTriageItem[];
    capped: boolean;
    error: string | null;
  }> {
    const credentials = await readCredentials(this.#options.credentialsFile);
    if (!credentials.sentry) return { items: [], capped: false, error: 'Sentry is not connected' };
    const environment = (filter.environment ?? '').trim();
    const statsPeriod = validPeriod(filter.statsPeriod);
    const key = `${environment}|${statsPeriod}`;
    const now = this.#options.now().getTime();
    const hit = this.#sentryQueries.get(key);
    if (hit && now - hit.at < this.#options.cacheMs) return hit.value;

    const out = await this.#readSentry(credentials.sentry.token, credentials.sentry.org, {
      environment,
      statsPeriod,
    });
    const value = {
      items: out.items,
      capped: out.items.length >= SENTRY_PAGE,
      error: out.status.error,
    };
    this.#sentryQueries.set(key, { at: now, value });
    return value;
  }

  /**
   * ASSIGN A SENTRY ISSUE TO YOU. The one write this console makes to Sentry.
   *
   * Documented: `PUT /organizations/{org}/issues/{id}/` with `assignedTo`,
   * which needs `event:write` and accepts a username or primary email.
   *
   * THE GUARD IS THE OPERATOR'S RULE, not a courtesy: only an error that is not
   * already linked to a GitHub issue may be assigned. A linked error is already
   * somebody's work, and assigning it would claim work that is running. The
   * check is made HERE rather than only in the browser, against a
   * read taken at the instant of the click, because the page's copy of "is this
   * ticketed" can be a minute old and this is a write.
   */
  async assignSentryIssue(id: string): Promise<{ ok: boolean; message: string }> {
    const credentials = await readCredentials(this.#options.credentialsFile);
    const credential = credentials.sentry;
    if (!credential) return { ok: false, message: 'Sentry is not connected' };
    if (!credential.email) {
      return {
        ok: false,
        message: 'Set your Sentry email in Connections first — assigning needs to know who you are to Sentry',
      };
    }
    const base = sentryApiBase(credential.org);
    const issueUrl = `${base}/organizations/${encodeURIComponent(credential.org)}/issues/${encodeURIComponent(id)}/`;
    try {
      // Re-read THIS issue before writing, so the guard is decided on what is
      // true now rather than on what the panel was showing.
      const fresh = await this.#options.fetch(issueUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.#options.requestTimeoutMs),
      });
      if (!fresh.ok) {
        return { ok: false, message: `could not re-read that Sentry issue — HTTP ${fresh.status}` };
      }
      const raw = (await fresh.json()) as Record<string, unknown>;
      const linked = linkedIssueUrlsOf(raw);
      const repo = this.#options.repo;
      const already = repo ? linked.find((u) => issueNumberIn(u, repo) !== null) : linked[0];
      if (already !== undefined) {
        return {
          ok: false,
          message: `that error already has a ticket (${already}) — nothing was assigned`,
        };
      }
      const response = await this.#options.fetch(issueUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${credential.token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ assignedTo: credential.email }),
        signal: AbortSignal.timeout(this.#options.requestTimeoutMs),
      });
      if (!response.ok) {
        const why =
          response.status === 403
            ? 'that token lacks the event:write scope — recreate it with Issue & Event: Write'
            : `Sentry returned HTTP ${response.status}`;
        return { ok: false, message: why };
      }
      // The panel's cached reads now say the wrong thing about this issue.
      this.#sentryQueries.clear();
      this.#cached = null;
      return { ok: true, message: `assigned to ${credential.email} in Sentry` };
    } catch (error) {
      return { ok: false, message: sentryError(error, credential.token) };
    }
  }

  /** Drop ONE provider's credential, leaving the others exactly as they were. */
  async #forget(which: 'linear' | 'sentry'): Promise<void> {
    const existing = await readCredentials(this.#options.credentialsFile);
    delete existing[which];
    if (Object.keys(existing).length === 0) {
      await unlink(this.#options.credentialsFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    } else {
      await writeCredentials(this.#options.credentialsFile, existing);
    }
    this.#revision += 1;
    this.#cached = null;
  }

  /**
   * ONE list request: unresolved errors, newest first.
   *
   * The count on the chip is the ones with NO ticket in this repo, because that
   * is the number that means anything to you — "12 unresolved" includes every
   * error already being worked in this console, and would go up when you started
   * work rather than down.
   */
  async #readSentry(
    token: string,
    org: string,
    filter: { environment?: string; statsPeriod?: string } = {},
  ): Promise<{ status: WorkSourceStatus; items: SentryTriageItem[] }> {
    const base = sentryApiBase(org);
    const shell: WorkSourceStatus = {
      id: 'sentry',
      name: 'Sentry',
      connected: false,
      account: org,
      detail: 'Connect Sentry to see unresolved errors that have no ticket yet.',
      error: null,
      itemCount: 0,
      connectCommand: null,
      managedBy: 'file',
    };
    try {
      const url = new URL(`${base}/organizations/${encodeURIComponent(org)}/issues/`);
      url.searchParams.set('query', 'is:unresolved');
      url.searchParams.set('statsPeriod', validPeriod(filter.statsPeriod));
      url.searchParams.set('limit', String(SENTRY_PAGE));
      // Sentry takes `environment` repeatedly; one is all the panel offers, and
      // an empty value must be OMITTED rather than sent blank — a blank one is
      // read as an environment literally named "", which matches nothing.
      if (filter.environment) url.searchParams.append('environment', filter.environment);
      const response = await this.#options.fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.#options.requestTimeoutMs),
      });
      if (!response.ok) {
        // 401 and 403 are the two a person can act on, so they are said plainly
        // rather than as a status code.
        const why =
          response.status === 401
            ? 'Sentry rejected the token'
            : response.status === 403
              ? 'that token lacks the event:read scope'
              : `Sentry returned HTTP ${response.status}`;
        return { status: { ...shell, error: why, detail: why }, items: [] };
      }
      const items = parseSentryList(await response.json());
      const repo = this.#options.repo;
      const untriaged = repo ? items.filter((i) => !hasTicketIn(i, repo)) : items;
      // A FULL PAGE IS NOT A TOTAL. The first read against the live org came
      // back with exactly 100 of a 100 limit, and the detail line said "of 100
      // unresolved in the last 14 days" — a page size wearing a total’s
      // clothes, which is the class of lie this console is built against.
      // Until the panel pages properly, the sentence says which it is.
      const capped = items.length >= SENTRY_PAGE;
      return {
        status: {
          ...shell,
          connected: true,
          assignAs: null,
          error: null,
          itemCount: untriaged.length,
          detail: repo
            ? `${untriaged.length} with no ticket in ${repo}, of the ${capped ? `${items.length} most recent` : `${items.length}`} unresolved in the last 14 days`
            : `${capped ? `${items.length} most recent` : `${items.length}`} unresolved in the last 14 days`,
        },
        items,
      };
    } catch (error) {
      const why = sentryError(error, token);
      return { status: { ...shell, error: why, detail: why }, items: [] };
    }
  }

  async #refresh(revision: number): Promise<WorkSourcesSnapshot> {
    const credentials = await readCredentials(this.#options.credentialsFile);
    const linearKey = this.#options.linearApiKey ?? credentials.linear?.apiKey ?? null;
    const linearManagedBy = this.#options.linearApiKey ? 'environment' : linearKey ? 'file' : null;

    const sentryCredential = credentials.sentry ?? null;
    const [github, linear, sentry] = await Promise.all([
      this.#readGithub(),
      linearKey
        ? this.#readLinear(linearKey)
        : Promise.resolve({
            status: {
              id: 'linear' as const,
              name: 'Linear',
              connected: false,
              account: null,
              detail: 'Connect Linear to find active issues assigned to you.',
              error: null,
              itemCount: 0,
              connectCommand: null,
              managedBy: null,
            },
            items: [] as WorkItem[],
          }),
      sentryCredential
        ? this.#readSentry(sentryCredential.token, sentryCredential.org)
        : Promise.resolve({
            status: {
              id: 'sentry' as const,
              name: 'Sentry',
              connected: false,
              account: null,
              detail: 'Connect Sentry to see unresolved errors that have no ticket yet.',
              error: null,
              itemCount: 0,
              connectCommand: null,
              managedBy: null,
              assignAs: null,
            } as WorkSourceStatus,
            items: [] as SentryTriageItem[],
          }),
    ]);
    linear.status.managedBy = linearManagedBy;
    // Stamped here for the same reason `managedBy` is: the read does not know
    // who you are, and the card has to be able to show whether it is right.
    sentry.status.assignAs = sentryCredential?.email ?? null;

    const snapshot: WorkSourcesSnapshot = {
      sources: [github.status, linear.status, sentry.status],
      // Sentry contributes NO `items`, deliberately. This list means "work
      // assigned to me", and an unresolved error is not that until it has a
      // ticket — at which point it is already here as a GitHub issue. The
      // errors live on their own route for the triage panel; see `sentryTriage`.
      items: [...github.items, ...linear.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      refreshedAt: this.#options.now().toISOString(),
    };
    // A connection may have changed while these provider calls were in flight.
    // Resolve stale HTTP requests with the current generation too, otherwise an
    // older browser response could still repaint a successful connect as offline.
    if (revision !== this.#revision) return this.snapshot(false);
    this.#sentryItems = sentry.items;
    this.#cached = snapshot;
    this.#cachedAt = this.#options.now().getTime();
    return snapshot;
  }

  async #readGithub(): Promise<{ status: WorkSourceStatus; items: WorkItem[] }> {
    try {
      const profileRaw = await this.#options.command('gh', ['api', 'user', '--jq', '{login: .login, name: .name}']);
      const profile = JSON.parse(profileRaw) as { login?: unknown; name?: unknown };
      const login = text(profile.login);
      if (!login) throw new Error('GitHub did not return the active account');

      const raw = await this.#options.command('gh', [
        'search',
        'issues',
        '--assignee',
        '@me',
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,title,url,updatedAt,repository,labels',
      ]);
      const items = parseGithubItems(raw);
      const display = text(profile.name);
      return {
        status: {
          id: 'github',
          name: 'GitHub Issues',
          connected: true,
          account: login,
          detail: `${items.length} open issue${items.length === 1 ? '' : 's'} assigned to ${display || `@${login}`}.`,
          error: null,
          itemCount: items.length,
          connectCommand: null,
          managedBy: 'gh',
        },
        items,
      };
    } catch (error) {
      return {
        status: {
          id: 'github',
          name: 'GitHub Issues',
          connected: false,
          account: null,
          detail: 'Sign in with the GitHub CLI, then re-check the connection.',
          error: firstError(error),
          itemCount: 0,
          connectCommand: GITHUB_LOGIN_COMMAND,
          managedBy: 'gh',
        },
        items: [],
      };
    }
  }

  async #readLinear(apiKey: string): Promise<{ status: WorkSourceStatus; items: WorkItem[] }> {
    try {
      const key = validLinearKey(apiKey);
      const rows: LinearIssueRow[] = [];
      let after: string | null = null;
      let account = '';

      // Two pages is enough for a work inbox and prevents a pathological account
      // from turning one Settings refresh into an unbounded API walk.
      for (let page = 0; page < 2; page += 1) {
        const response = await this.#options.fetch(LINEAR_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: key },
          signal: AbortSignal.timeout(this.#options.requestTimeoutMs),
          body: JSON.stringify({
            query: LINEAR_ASSIGNED_QUERY,
            variables: {
              first: 100,
              after,
              filter: { state: { type: { nin: ['completed', 'canceled'] } } },
            },
          }),
        });
        const payload = (await response.json()) as LinearPage;
        const graphError = payload.errors?.map((entry) => text(entry.message)).find(Boolean);
        if (!response.ok || graphError) throw new Error(graphError || `Linear returned HTTP ${response.status}`);

        const viewer = payload.data?.viewer;
        if (!viewer) throw new Error('Linear did not return the connected user');
        account = text(viewer.name) || text(viewer.email);
        rows.push(...(viewer.assignedIssues?.nodes ?? []));
        const pageInfo = viewer.assignedIssues?.pageInfo;
        if (pageInfo?.hasNextPage !== true || !text(pageInfo.endCursor)) break;
        after = text(pageInfo.endCursor);
      }

      const items = parseLinearItems(rows);
      return {
        status: {
          id: 'linear',
          name: 'Linear',
          connected: true,
          account: account || 'connected user',
          detail: `${items.length} active issue${items.length === 1 ? '' : 's'} assigned to ${account || 'you'}.`,
          error: null,
          itemCount: items.length,
          connectCommand: null,
          managedBy: null,
        },
        items,
      };
    } catch (error) {
      return {
        status: {
          id: 'linear',
          name: 'Linear',
          connected: false,
          account: null,
          detail: 'The Linear connection could not be read. Reconnect it with a valid personal API key.',
          error: linearError(error, apiKey),
          itemCount: 0,
          connectCommand: null,
          managedBy: null,
        },
        items: [],
      };
    }
  }
}
