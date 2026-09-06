import express from 'express';
import { existsSync, createReadStream, readFileSync, openSync, fstatSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { Config } from './config.js';
import type { Orchestrator } from './orchestrator.js';
import { isSummaryWindow } from './summary.js';
import { WorkSourceService, type WorkSourceApi } from './sources.js';
import { readRebuildStatus, startRebuild } from './rebuild.js';
import { etDayOf } from './counts.js';
import { hasTicketIn, ticketDraftFor } from './sentry.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Evidence is QA artifacts — screenshots, transcripts, SQL dumps. 25 MB is plenty. */
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function resolveUiDir(cfg: Config): string | null {
  const candidates = [cfg.uiDir, join(here, '..', '..', 'ui', 'dist'), join(here, '..', 'public')].filter(
    (c): c is string => typeof c === 'string',
  );
  return candidates.find((c) => existsSync(join(c, 'index.html'))) ?? null;
}

/**
 * The build id of the UI this server started with, read ONCE.
 *
 * `npm run build` overwrites `ui/dist` underneath a console that is already
 * running, so the browser loads a NEW page and talks to an OLD API. Nothing
 * errors; buttons just quietly do nothing, which is what happened to the
 * operator's Approve button one afternoon. The page carries the id it was compiled with, this is
 * the id the running server was started with, and `GET /api/version` lets the
 * page notice the difference and say so instead of dying silently.
 *
 * Reading it once is the whole point: re-reading per request would report the
 * newly built id and the mismatch would vanish exactly when it matters.
 */
function readBuildId(uiDir: string | null): string | null {
  if (!uiDir) return null;
  try {
    return readFileSync(join(uiDir, 'build-id.txt'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function createServer(
  cfg: Config,
  orch: Orchestrator,
  sourcesOverride?: WorkSourceApi,
): express.Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const buildId = readBuildId(resolveUiDir(cfg));
  const startedAt = new Date().toISOString();

  const sources =
    sourcesOverride ??
    new WorkSourceService({
      credentialsFile: cfg.connectionsFile,
      linearApiKey: cfg.linearApiKey,
      cacheMs: cfg.sourcesTtlMs,
      // Sentry alone needs this, to answer "has this error been ticketed here
      // already" from Sentry's own record of what its integration filed.
      repo: cfg.repo,
    });

  /**
   * Which UI this running console was started with. The page compares it with
   * the id it was built with and shows a plain "reload" banner on a mismatch —
   * see `readBuildId`. Null means there is no built UI here at all (running the
   * Vite dev server), and the page then says nothing.
   */
  app.get('/api/version', (_req, res) => res.json({ buildId, startedAt }));

  /**
   * REBUILD AND RESTART. Its own two routes rather than one, because the answer
   * to a rebuild does not come back on the request that started it: the server
   * this page is talking to is the thing being restarted. The POST reports only
   * that the script is away; the GET is how a failure — which leaves no new
   * server to ask — still reaches the page, carrying the build log.
   *
   * No worker stops for this. See `rebuild.ts` for why that is structural
   * rather than hopeful.
   */
  app.get('/api/system/rebuild', (_req, res) => res.json(readRebuildStatus(cfg.streamDir)));

  app.post('/api/system/rebuild', (_req, res) => {
    const out = startRebuild({ repoRoot: join(here, '..', '..'), streamDir: cfg.streamDir });
    res.status(out.ok ? 200 : 409).json(out);
  });

  app.get('/api/state', (_req, res) => res.json(orch.state()));

  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = () => res.write(`data: ${JSON.stringify(orch.state())}\n\n`);
    send();
    orch.on('change', send);
    /**
     * A named `action` event, alongside the unnamed state frames.
     *
     * The toast has to be server-decided, not diffed per tab: three open tabs
     * diffing the feed themselves would toast the same UAT fail three times,
     * and a tab opened after the console had already announced it would never
     * see it at all. The server owns "has this been announced" (the ledger);
     * a tab owns only "have I drawn it".
     */
    const announce = (action: unknown) => res.write(`event: action\ndata: ${JSON.stringify(action)}\n\n`);
    orch.on('action', announce);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(beat);
      orch.off('change', send);
      orch.off('action', announce);
    });
  });

  /**
   * The console's own manual, `docs/INFO.md`. Read at request time and never
   * cached, so editing the file and refreshing the page is the whole workflow.
   * One markdown file is the source of truth; this only hands it over.
   */
  app.get('/api/info', async (_req, res) => {
    const markdown = await readFile(cfg.infoFile, 'utf8').catch(() => null);
    if (markdown === null) {
      return res.status(404).json({ ok: false, message: `no manual at ${cfg.infoFile}` });
    }
    res.json({ markdown });
  });

  /**
   * The status summary for one window — the plain-text post for Slack. Read-only:
   * three `gh list` calls, cached per window, and a formatter. The window is the
   * whole input, so anything but the three known ones is a 400 rather than a
   * quietly-defaulted answer to a question nobody asked.
   */
  /**
   * The four counts for an Eastern day or range. `from`/`to` are plain
   * YYYY-MM-DD, exactly what a date input hands over.
   */
  app.get('/api/summary/counts', async (req, res) => {
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? from);
    if (!ymd.test(from) || !ymd.test(to)) {
      return res.status(400).json({ ok: false, message: 'from/to must be YYYY-MM-DD' });
    }
    res.json(await orch.counts(from, to));
  });

  /**
   * ONE issue's legs, and the averages to read them against.
   *
   * The card asks for its own row rather than the page fetching every issue
   * and picking one out: a comparison is only meaningful beside the summary
   * that produced it, so both travel together and can never be from two
   * different reads.
   */
  app.get('/api/issues/:n/cycle', async (req, res) => {
    const issue = Number(req.params.n);
    if (!Number.isInteger(issue)) return res.status(400).json({ ok: false, message: 'which issue?' });
    // Thirty days: the ledger's own retention, so asking for more would widen
    // the window without widening the data behind it.
    const to = etDayOf(new Date().toISOString());
    const from = etDayOf(new Date(Date.now() - 30 * 86_400_000).toISOString());
    const out = await orch.cycle(from, to);
    const mine = out.perIssue.find((row) => row.issue === issue) ?? null;
    res.json({
      issue,
      mine,
      summary: out.summary,
      recent: out.recent,
      recentDays: out.recentDays,
      trend: out.trend,
      warnings: out.warnings,
    });
  });

  /**
   * HOW LONG EACH LEG TAKES, per issue and on average.
   *
   * Same date validation as the other two summary reads, and the same single
   * GitHub call behind it.
   */
  app.get("/api/summary/cycle", async (req, res) => {
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? from);
    if (!ymd.test(from) || !ymd.test(to)) {
      return res.status(400).json({ ok: false, message: "from/to must be YYYY-MM-DD" });
    }
    res.json(await orch.cycle(from, to));
  });

  /**
   * The four numbers PER DAY, for the cumulative graph beside them.
   *
   * Same validation as `/counts`, and the same single GitHub read behind it —
   * a month of days costs what one range costs.
   */
  app.get('/api/summary/series', async (req, res) => {
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const from = String(req.query.from ?? '');
    const to = String(req.query.to ?? from);
    if (!ymd.test(from) || !ymd.test(to)) {
      return res.status(400).json({ ok: false, message: 'from/to must be YYYY-MM-DD' });
    }
    res.json(await orch.series(from, to));
  });

  app.get('/api/summary', async (req, res) => {
    const window = req.query.window;
    if (!isSummaryWindow(window)) {
      return res.status(400).json({
        ok: false,
        message: `window must be daily, weekly or monthly — got '${String(window ?? '')}'`,
      });
    }
    res.json(await orch.summary(window));
  });

  /**
   * The per-model × per-segment table, built from the append-only `runs.jsonl`
   * and joined at read time with the live gate history, rework rounds and CI.
   * Read-only, cached for `metricsTtlMs`. It reports sample counts and refuses
   * to imply a conclusion those counts cannot support — see metrics.ts.
   */
  app.get('/api/metrics', async (_req, res) => res.json(await orch.metrics()));

  /**
   * The Dashboard's router-readiness card: the last SNAPSHOT, computed by the
   * background job. This route computes nothing — no file scan, no gh call —
   * which is why the Dashboard may ask for it on every open.
   */
  app.get('/api/metrics/snapshot', (_req, res) => res.json({ snapshot: orch.metricsSnapshot() }));

  /** "Recompute now" — the same job the daily timer runs. */
  app.post('/api/metrics/refresh', async (_req, res) => res.json({ snapshot: await orch.refreshMetricsSnapshot() }));

  // ------------------------------------------------------------- work sources

  /** Read-only discovery across the accounts this laptop has connected. */
  app.get('/api/sources', async (_req, res) => {
    try {
      res.json(await sources.snapshot(false));
    } catch (error) {
      res.status(500).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Re-check provider auth and assignments now, bypassing the short cache. */
  app.post('/api/sources/refresh', async (_req, res) => {
    try {
      res.json(await sources.snapshot(true));
    } catch (error) {
      res.status(502).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  /** GitHub credentials remain owned by gh. This verifies that login and reads its assignments. */
  app.post('/api/sources/github/connect', async (_req, res) => {
    try {
      res.json(await sources.snapshot(true));
    } catch (error) {
      res.status(502).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Validate a Linear personal API key before storing it in the owner-only local credential file. */
  app.put('/api/sources/linear', async (req, res) => {
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : '';
    try {
      res.json(await sources.connectLinear(apiKey));
    } catch (error) {
      res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete('/api/sources/linear', async (_req, res) => {
    try {
      res.json(await sources.disconnectLinear());
    } catch (error) {
      res.status(409).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * Validate a Sentry auth token and org slug, then store them in the same
   * owner-only credential file as Linear's key. Read-only: the scope asked for
   * is `event:read`, and nothing in this console can write to Sentry.
   */
  app.put('/api/sources/sentry', async (req, res) => {
    const body = req.body as { token?: unknown; org?: unknown; email?: unknown } | undefined;
    const token = typeof body?.token === 'string' ? body.token : '';
    const org = typeof body?.org === 'string' ? body.org : '';
    const email = typeof body?.email === 'string' ? body.email : null;
    try {
      res.json(await sources.connectSentry(token, org, email));
    } catch (error) {
      // The message is already redacted by `sentryError` on the read path; a
      // validation throw here never contains the token either.
      res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * WHO "assign to me" means, set without re-entering the token.
   *
   * An empty value clears it, which is the only way back to "cannot assign" —
   * and that has to be reachable, because a wrong identity puts somebody else's
   * name on the work.
   */
  app.put('/api/sources/sentry/identity', async (req, res) => {
    const email = typeof (req.body as { email?: unknown } | undefined)?.email === 'string' ? (req.body as { email: string }).email : '';
    try {
      res.json(await sources.setSentryIdentity(email));
    } catch (error) {
      res.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * TAKE ONE OR MORE SENTRY ERRORS: raise the linked GitHub ticket, then
   * assign the error in Sentry. What the operator asked for is one click: select
   * one or more Sentry errors, claim them, and have each one raise a GitHub
   * issue that links back to the Sentry error, is assigned to them, and carries
   * the `needs-triage` label.
   *
   * THE TICKET IS RAISED FIRST, deliberately. If the ticket fails, nothing has
   * happened and the row is exactly as it was; if the Sentry assignment failed
   * first instead, the ticket would still need raising and the panel would show
   * an error they had apparently claimed but not ticketed — which is the state
   * this whole call exists to stop them ending up in.
   *
   * Each id is decided on its own: one row that turns out to be ticketed
   * already takes itself out and the rest go through, because refusing the
   * whole selection for one stale row would be the console being precious
   * about a race it can simply report.
   */
  app.post('/api/sources/sentry/take', async (req, res) => {
    const body = req.body as { ids?: unknown } | undefined;
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((v): v is string => typeof v === 'string' && /^[0-9]+$/.test(v))
      : [];
    if (ids.length === 0) return res.status(400).json({ ok: false, message: 'which Sentry issues?' });
    if (ids.length > 25) {
      return res.status(400).json({ ok: false, message: 'at most 25 at a time — each one raises a real issue' });
    }

    const results: Array<{ id: string; ok: boolean; message: string; url?: string }> = [];
    for (const id of ids) {
      // Sequential: these are writes to two other services, and a burst of
      // them is how a rate limit turns a partial success into a mystery.
      //
      // READ BY ID, not out of a list. This used to search an unfiltered list
      // read while the panel showed a filtered one, both capped at 100 — so an
      // error old enough to fall outside the unfiltered page was visible on the
      // row and unreachable by the button (ACME-FRONTEND-K7, last seen 6 days
      // before the rest). A read by id has neither a cap nor a filter.
      const item = await sources.sentryIssue(id);
      if (!item) {
        results.push({
          id,
          ok: false,
          message: 'Sentry would not return that issue — it may have been deleted or merged',
        });
        continue;
      }
      const draft = ticketDraftFor(item);
      const raised = await sources.createLinkedTicket(id, draft, cfg.assignee);
      if (!raised.ok) {
        results.push({ id, ok: false, message: raised.message });
        continue;
      }
      const assigned = await sources.assignSentryIssue(id);
      results.push({
        id,
        // The TICKET is the thing that had to happen. A ticket raised whose
        // Sentry assignment then failed is a success with a caveat, not a
        // failure — and saying otherwise would invite a second click that
        // raised a duplicate.
        ok: true,
        message: assigned.ok ? raised.message : `${raised.message}, but not assigned in Sentry — ${assigned.message}`,
        url: raised.url,
      });
    }
    const done = results.filter((r) => r.ok).length;
    res.json({
      ok: done > 0,
      message:
        done === results.length
          ? `took ${done} — ticket raised, linked and assigned`
          : `took ${done} of ${results.length} — ${results.filter((r) => !r.ok).map((r) => r.message)[0]}`,
      results,
    });
  });
  app.delete('/api/sources/sentry', async (_req, res) => {
    try {
      res.json(await sources.disconnectSentry());
    } catch (error) {
      res.status(409).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  /**
   * THE TRIAGE LIST: unresolved errors, and whether each already has a ticket
   * in this repo.
   *
   * Served from the last snapshot rather than its own request, so the panel and
   * the header count can never disagree about what Sentry said. `?all=1` keeps
   * the ones already ticketed, which is the view for "what is Sentry seeing",
   * as against the default "what still needs a ticket".
   */
  /** The environment names the panel’s filter offers. */
  app.get('/api/sources/sentry/environments', async (_req, res) => {
    try {
      res.json({ environments: await sources.sentryEnvironments() });
    } catch (error) {
      res.status(502).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/sources/sentry/triage', async (req, res) => {
    try {
      const environment = typeof req.query.environment === 'string' ? req.query.environment : null;
      const statsPeriod = typeof req.query.statsPeriod === 'string' ? req.query.statsPeriod : null;
      const read = await sources.sentryIssues({ environment, statsPeriod });
      const all = String(req.query.all ?? '') === '1';
      const shown = all ? read.items : read.items.filter((i) => !hasTicketIn(i, cfg.repo));
      res.json({
        repo: cfg.repo,
        environment,
        statsPeriod: statsPeriod ?? '14d',
        // `capped` is the honest half of `total`: a full page is not a total, and
        // the panel has to be able to say so rather than implying it counted.
        total: read.items.length,
        capped: read.capped,
        error: read.error,
        items: shown,
      });
    } catch (error) {
      res.status(502).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  /** The account doctor: booleans about each Claude account's config dir. */
  app.get('/api/accounts', async (_req, res) => {
    res.json({ accounts: await orch.accountsReport() });
  });

  /**
   * The Settings tab's registry edits. All three write ONE file — `accounts.json`
   * at the repo root — and reload the registry live; no account config directory
   * is created, modified or deleted, and removing an account removes the registry
   * ENTRY only. Each replies with the fresh doctor report so the tab is current.
   */
  const withReport = async (out: { ok: boolean; message: string; output?: string }) => ({
    ...out,
    accounts: await orch.accountsReport(),
  });

  app.post('/api/accounts', async (req, res) => {
    const body = req.body as { name?: unknown; configDir?: unknown; provider?: unknown } | undefined;
    const rawProvider = body?.provider ?? 'claude';
    if (rawProvider !== 'claude' && rawProvider !== 'codex') {
      return res.status(409).json(
        await withReport({ ok: false, message: `unknown agent provider '${String(rawProvider)}'` }),
      );
    }
    const out = await orch.addAccount(
      String(body?.name ?? ''),
      String(body?.configDir ?? ''),
      rawProvider,
    );
    res.status(out.ok ? 200 : 409).json(await withReport(out));
  });

  app.put('/api/accounts/default', async (req, res) => {
    const name = String((req.body as { name?: unknown } | undefined)?.name ?? '');
    const out = await orch.setDefaultAccount(name);
    res.status(out.ok ? 200 : 409).json(await withReport(out));
  });

  /** An account's default model — one more line in the same file. An empty
   *  string clears it, back to the console default. */
  app.put('/api/accounts/:name/model', async (req, res) => {
    const model = String((req.body as { model?: unknown } | undefined)?.model ?? '');
    const out = await orch.setAccountModel(String(req.params.name), model);
    res.status(out.ok ? 200 : 409).json(await withReport(out));
  });

  app.delete('/api/accounts/:name', async (req, res) => {
    const out = await orch.removeAccount(String(req.params.name));
    res.status(out.ok ? 200 : 409).json(await withReport(out));
  });

  /**
   * Run `scripts/link-account.sh <configDir>` for one registered account and hand
   * its output back verbatim.
   *
   * FENCE NOTE: this is the single, deliberate relaxation of "the console never
   * writes into an account config dir" (docs/PLAN.md, v1.3). The write is not
   * performed here — it is performed by that one vetted script, which makes two
   * symlinks back to the canonical `~/.claude`, is idempotent, and refuses to
   * replace a real file or directory. Nothing else in the console writes there,
   * and the only argument ever passed is a config dir already in the registry.
   */
  app.post('/api/accounts/:name/link', async (req, res) => {
    const out = await orch.linkAccount(String(req.params.name));
    res.status(out.ok ? 200 : 409).json(await withReport(out));
  });

  /**
   * The definitive login check for one account. POST because it spawns a
   * process, not because it changes anything: it writes no account file and no
   * state file. It runs a real `claude`, so it costs a token or two — which is
   * why it is a button and never a timer.
   */
  app.post('/api/accounts/:name/check-login', async (req, res) => {
    const out = await orch.checkAccountLogin(String(req.params.name));
    res.status(out.ok ? 200 : 409).json(await withReport(out));
  });

  /** A string body field, or null — the shape every picker sends. */
  const pick = (body: unknown, field: string): string | null => {
    const v = (body as Record<string, unknown> | undefined)?.[field];
    return typeof v === 'string' && v ? v : null;
  };

  app.post('/api/issues/:n/start', (req, res) => {
    // `supercharge` is a standing instruction, so it is read strictly: only a
    // literal `true` turns it on. A missing field leaves whatever the issue
    // already had alone, which is what every existing caller means.
    const raw = (req.body as { supercharge?: unknown } | undefined)?.supercharge;
    const supercharge = raw === true ? true : raw === false ? false : undefined;
    const out = orch.enqueue(Number(req.params.n), pick(req.body, 'account'), pick(req.body, 'model'), {
      supercharge,
    });
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * Abandon this issue's session and start a new one — the only way to change
   * either the account or the model, since a session fixes both. The worktree,
   * branch and gate history survive.
   */
  app.post('/api/issues/:n/restart-fresh', async (req, res) => {
    const account = String((req.body as { account?: unknown } | undefined)?.account ?? '').trim();
    if (!account) return res.status(400).json({ ok: false, message: 'which account?' });
    const out = await orch.restartFresh(Number(req.params.n), account, pick(req.body, 'model'));
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * Mark this issue's PR ready for review. No body: there is one PR on the row
   * and one thing to do to it, and the console re-reads which PR that is at the
   * instant of the click rather than trusting a number the page has been holding.
   */
  app.post('/api/issues/:n/pr-ready', async (req, res) => {
    const out = await orch.markPrReadyForReview(Number(req.params.n));
    res.status(out.ok ? 200 : 409).json(out);
  });

  app.post('/api/issues/:n/dequeue', (req, res) => res.json(orch.dequeue(Number(req.params.n))));

  /** What the confirm dialog shows. Read-only: nothing runs on this call. */
  app.get('/api/issues/:n/worktree-plan', (req, res) => {
    const out = orch.worktreePlan(Number(req.params.n));
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * The confirmed create. Create-only; the provisioner re-checks the fence itself.
   * `account` is the picker's choice on that same card — the account the first
   * worker in this worktree will spawn under.
   */
  app.post('/api/issues/:n/worktree', async (req, res) => {
    const out = await orch.createWorktree(
      Number(req.params.n),
      pick(req.body, 'account'),
      pick(req.body, 'model'),
    );
    res.status(out.ok ? 200 : 409).json(out);
  });

  /** Read-only recovery preview: exact head, branch, path, port and command. */
  app.get('/api/issues/:n/worktree/continue-existing-plan', async (req, res) => {
    const out = await orch.existingWorktreePlan(Number(req.params.n));
    res.status(out.ok ? 200 : 409).json(out);
  });

  /** Restore the canonical worktree from the exact branch a create refusal found. */
  app.post('/api/issues/:n/worktree/continue-existing', async (req, res) => {
    const body = req.body as { head?: unknown; port?: unknown; mode?: unknown } | undefined;
    const expectedHead = String(body?.head ?? '').trim() || undefined;
    const expectedMode = body?.mode === 'restore' || body?.mode === 'use-existing' ? body.mode : undefined;
    const expectedPort = body?.port === null ? null : Number(body?.port);
    const validPort = expectedPort === null || (Number.isInteger(expectedPort) && expectedPort > 0);
    if (!expectedHead || !expectedMode || !validPort) {
      return res.status(400).json({ ok: false, message: 'review the recovery plan first' });
    }
    const out = await orch.continueExistingWorktree(Number(req.params.n), expectedHead, expectedPort, expectedMode);
    res.status(out.ok ? 200 : 409).json(out);
  });

  app.post('/api/issues/:n/resume', async (req, res) => {
    const message = String((req.body as { message?: unknown })?.message ?? '').trim();
    if (!message) return res.status(400).json({ ok: false, message: 'a resume needs a message' });
    // `decision` says which button was pressed, so the ledger records whether the
    // gate was passed or the work sent back. Absent defaults to approved, which is
    // what every existing caller means.
    const raw = (req.body as { decision?: unknown })?.decision;
    const decision = raw === 'feedback' ? ('feedback' as const) : ('approved' as const);
    const out = await orch.resume(Number(req.params.n), message, { decision });
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * Pass gate C. Its own route rather than a client-composed `/resume` for the
   * same reason `/ask` and `/qa-rework` are: gate C is the one gate with a
   * mechanical half, and only the console can recompute it from the state on
   * disk at the instant of the decision rather than from a row the page has been
   * holding. The message is still yours, composed and carried verbatim.
   */
  app.post('/api/issues/:n/approve-c', async (req, res) => {
    const message = String((req.body as { message?: unknown } | undefined)?.message ?? '').trim();
    if (!message) return res.status(400).json({ ok: false, message: 'an approval needs a message' });
    const out = await orch.approveGateC(Number(req.params.n), message);
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * Take back a gate decision: send the worker back to the stage that gate
   * governs, with the correction. It is not a code rewind — see
   * `Orchestrator.reopenGate` — and the reversal is appended to the issue's
   * reopening record, never written over the original round.
   *
   * Both inputs are required and both are checked again in the orchestrator,
   * which is the only place that knows whether that gate was ever passed.
   */
  /**
   * ASK at an open gate without deciding it — the third act on a gate card.
   *
   * It is a route of its own rather than a client-composed `/resume` because the
   * console has to KNOW this is a question: it must skip everything a decision
   * does (clearing a comment block, stamping a rework round), remember what was
   * asked, and check afterwards that the worker came back to the same gate. A
   * page cannot be trusted to compose that, and nothing here writes to GitHub.
   */
  app.post('/api/issues/:n/ask', async (req, res) => {
    const question = String((req.body as { question?: unknown } | undefined)?.question ?? '').trim();
    if (!question) return res.status(400).json({ ok: false, message: 'a question needs words' });
    const out = await orch.ask(Number(req.params.n), question);
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * TAKE THE MISSING SCREENSHOTS AGAIN, on your click.
   *
   * The automatic pass runs inside the poll that first sees a gate C, so this
   * button is for the second time round: the dev server was down, the baseline
   * was not up yet, or you want the pair retaken. There is no body — WHICH
   * captures are owed is computed from the gate file, never sent by the page,
   * which is what keeps the browser from being able to name a destination.
   *
   * It writes into a worktree, so the orchestrator refuses it while that
   * worktree's worker is running.
   */
  app.post('/api/issues/:n/capture', async (req, res) => {
    const out = await orch.captureShots(Number(req.params.n));
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * You tick one manual-QA step: verified, or failed with what you saw.
   *
   * The tick is yours, so it is written to the console's own state file and
   * nowhere a worker can reach. This route touches no worktree file, spawns
   * nothing and posts nothing — it is legal even while a worker is running, and
   * the orchestrator stamps the time so the page cannot backdate one.
   */
  app.post('/api/issues/:n/qa-verdict', async (req, res) => {
    const body = req.body as { stepId?: unknown; rev?: unknown; status?: unknown; note?: unknown } | undefined;
    const stepId = Number(body?.stepId);
    const rev = Number(body?.rev);
    const status = String(body?.status ?? '');
    if (!Number.isInteger(stepId) || !Number.isInteger(rev)) {
      return res.status(400).json({ ok: false, message: 'which step, at which revision?' });
    }
    if (status !== 'verified' && status !== 'failed' && status !== 'cleared') {
      return res.status(400).json({ ok: false, message: 'a tick is verified, failed or cleared' });
    }
    const note = body?.note === undefined || body?.note === null ? null : String(body.note);
    const out = await orch.setQaVerdict(Number(req.params.n), { stepId, rev, status, note });
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * Send the failed QA steps back to Build, and nothing else.
   *
   * Its own route rather than a client-composed `/resume` for the same reason
   * `/ask` is: only the console can snapshot the evidence and the click-script
   * before the worker rewrites `.gate.json`, and that snapshot is what makes the
   * whole issue's evidence survive a targeted fix. There is no body — which
   * steps go back is decided by the ticks you already set.
   */
  app.post('/api/issues/:n/qa-rework', async (req, res) => {
    const out = await orch.qaRework(Number(req.params.n));
    res.status(out.ok ? 200 : 409).json(out);
  });

  app.post('/api/issues/:n/reopen-gate', async (req, res) => {
    const body = req.body as { gate?: unknown; message?: unknown } | undefined;
    const gate = String(body?.gate ?? '').trim();
    const message = String(body?.message ?? '').trim();
    if (!gate) return res.status(400).json({ ok: false, message: 'which gate?' });
    if (!message) {
      return res.status(400).json({ ok: false, message: 'reopening a gate needs to say what changed' });
    }
    const out = await orch.reopenGate(Number(req.params.n), gate, message);
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * Start the rework with a NEW worker: for a PR whose work happened outside the
   * console there is no session to resume, so this spawns one against the
   * existing worktree with `/issue-pipeline <N> resume` plus the brief.
   */
  app.post('/api/issues/:n/rework-fresh', async (req, res) => {
    const brief = String((req.body as { brief?: unknown } | undefined)?.brief ?? '').trim();
    if (!brief) return res.status(400).json({ ok: false, message: 'a rework needs a brief' });
    const out = await orch.reworkFresh(
      Number(req.params.n),
      brief,
      pick(req.body, 'account'),
      pick(req.body, 'model'),
    );
    res.status(out.ok ? 200 : 409).json(out);
  });

  app.post('/api/issues/:n/stop', async (req, res) => res.json(await orch.stopWorker(Number(req.params.n))));

  /**
   * Freeze one worker's process tree, and thaw it again. SIGSTOP / SIGCONT, and
   * the ONLY route that signals a worker other than `stop`.
   *
   * A pause throws NOTHING away: uncommitted edits, the session transcript, the
   * gate files and the queue are all on disk and untouched. It holds its slot on
   * purpose, so nothing backfills the memory it just gave back.
   *
   * Un-pausing is always a click. The memory floor may pause on its own; nothing
   * in this console ever resumes on its own, which is what stops it flapping.
   */
  app.post('/api/issues/:n/pause', async (req, res) => {
    const reason = String((req.body as { reason?: unknown } | undefined)?.reason ?? '').trim();
    const out = await orch.pauseWorker(Number(req.params.n), 'you', reason || 'you paused it from the console');
    res.status(out.ok ? 200 : 409).json(out);
  });

  app.post('/api/issues/:n/unpause', async (req, res) => {
    const out = await orch.unpauseWorker(Number(req.params.n));
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * PARK / UN-PARK — a decision about a TICKET, not a signal to a process.
   *
   * Deliberately not folded into `/pause` above, and named apart from it for the
   * same reason `ParkedStamp` is named apart from `PausedStamp`: `/pause` sends
   * SIGSTOP to a running worker and is also the memory floor's own lever, while
   * this writes one line of state and signals nothing. A ticket with no worker
   * at all can be parked; only a running one can be paused.
   *
   * The reason is OPTIONAL, unlike the one on `reopen-gate` below. Reopening a
   * gate reverses a decision other people are working from, so it must say what
   * changed. Parking is you telling yourself something, and a text box you have
   * to fill in before you can put a ticket down is a text box that stops you
   * putting tickets down.
   */
  app.post('/api/issues/:n/park', async (req, res) => {
    const reason = String((req.body as { reason?: unknown } | undefined)?.reason ?? '');
    const out = await orch.parkIssue(Number(req.params.n), reason);
    res.status(out.ok ? 200 : 409).json(out);
  });

  app.post('/api/issues/:n/unpark', async (req, res) => {
    const out = await orch.unparkIssue(Number(req.params.n));
    res.status(out.ok ? 200 : 409).json(out);
  });

  /** Pause everything, on the banner's button — the same act the floor takes,
   *  taken deliberately. */
  app.post('/api/resources/pause-all', async (req, res) => {
    const reason = String((req.body as { reason?: unknown } | undefined)?.reason ?? '').trim();
    const out = await orch.pauseAllWorkers('you', reason || 'you paused everything from the console');
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * Run Stage 9 on an issue whose PR merged: move the board card, choose the
   * verification path, draft the QA comment. The prompt is the textarea's
   * content, byte-exact.
   *
   * It writes nothing to GitHub. The prompt tells the worker to draft the QA
   * comment as `.comment-request.json` and stop, which routes it back through
   * the existing CommentCard → your click → guarded comment path — still the
   * only GitHub write in the codebase.
   */
  app.post('/api/issues/:n/post-merge', async (req, res) => {
    const body = req.body as { prompt?: unknown } | undefined;
    const prompt = String(body?.prompt ?? '').trim();
    if (!prompt) return res.status(400).json({ ok: false, message: 'Stage 9 needs an instruction' });
    const out = await orch.postMergeStart(
      Number(req.params.n),
      prompt,
      pick(req.body, 'account'),
      pick(req.body, 'model'),
    );
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * Post a worker's drafted third-party comment to its named issue or PR. This is the only route that
   * writes to GitHub, and it does so only with the body in this request, only
   * when you click. One comment per call.
   */
  app.post('/api/issues/:n/comment', async (req, res) => {
    const body = String((req.body as { body?: unknown })?.body ?? '');
    if (!body.trim()) return res.status(400).json({ ok: false, message: 'refusing to post an empty comment' });
    const out = await orch.postComment(Number(req.params.n), body);
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * Throw a drafted comment away without posting it. No GitHub write, no worker,
   * no touching the worktree — the mirror image of the Post route above.
   */
  app.post('/api/issues/:n/comment/discard', async (req, res) => {
    const requestedAt = String((req.body as { requestedAt?: unknown } | undefined)?.requestedAt ?? '').trim();
    if (!requestedAt) return res.status(400).json({ ok: false, message: 'which draft?' });
    const out = await orch.discardComment(Number(req.params.n), requestedAt);
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * Dismiss one still-unanswered posted-comment wait without touching GitHub or
   * starting a worker. `postedAt` is the compare-and-clear token from the row;
   * a stale browser tab cannot clear a newer wait that replaced it.
   */
  app.post('/api/issues/:n/comment-block/resolve', async (req, res) => {
    const postedAt = String((req.body as { postedAt?: unknown } | undefined)?.postedAt ?? '').trim();
    if (!postedAt) return res.status(400).json({ ok: false, message: 'which posted comment block?' });
    const out = await orch.resolveCommentBlock(Number(req.params.n), postedAt);
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * File the drafted spin-off. The console's SECOND GitHub write, and it is as
   * narrow as the first: `gh issue create` and nothing else, on your click, one
   * issue per call. The body is not taken from this request — it is the draft on
   * disk plus the parent link — so there is nothing here for a caller to inject.
   */
  /**
   * Save a screenshot or document into the issue's worktree so the worker can
   * read it. The only console write into a worktree; fenced in `attach.ts`.
   */
  app.post('/api/issues/:n/attach', async (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown; data?: unknown };
    const name = String(body.name ?? '');
    const data = String(body.data ?? '');
    if (!data) return res.status(400).json({ ok: false, message: 'no file data' });
    const out = await orch.attach(Number(req.params.n), name, data);
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * Fold a drafted spin-off into its parent instead of filing it. No GitHub
   * write of any kind — the mirror image of the route below.
   */
  app.post('/api/issues/:n/fold-spin-off', async (req, res) => {
    const out = await orch.foldSpinOff(Number(req.params.n));
    res.status(out.ok ? 200 : 409).json(out);
  });

  app.post('/api/issues/:n/file-spin-off', async (req, res) => {
    const out = await orch.fileSpinOff(Number(req.params.n));
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * Read-only evidence file server. GET only, no directory listing, size-capped.
   * The path-traversal fence lives in orch.evidenceFile / resolveEvidencePath —
   * this route only shapes the response.
   */
  app.get('/api/issues/:n/evidence', (req, res) => {
    const requested = String(req.query.path ?? '');
    const resolved = orch.evidenceFile(Number(req.params.n), requested);
    if (!resolved.ok || !resolved.absPath) {
      // A file that is not there and a path we REFUSE are different answers, and
      // conflating them made every missing screenshot read as a security refusal.
      const missing = resolved.reason.startsWith('not found');
      return res
        .status(missing ? 404 : 403)
        .type('text/plain')
        .send(resolved.reason);
    }
    // OPEN ONCE, then answer entirely from that descriptor — never touch the
    // path a second time. The gap between "this file is servable" and "these are
    // its bytes" is not theoretical here: a worker rewrites `after.png` in place
    // every round and the no-cache header below makes the card re-fetch on every
    // render, so the gap is entered during exactly the activity this endpoint
    // exists for. Stat-then-reopen let a file that vanished, shrank, or was
    // swapped mid-request be measured as one thing and served as another.
    let fd: number;
    try {
      fd = openSync(resolved.absPath, 'r');
    } catch (e) {
      // A directory opens fine on macOS and throws EISDIR on Linux. Both are the
      // same refusal — "that is not a file" — and must not read as a missing one.
      if ((e as NodeJS.ErrnoException).code === 'EISDIR') {
        return res.status(403).type('text/plain').send('refusing: not a regular file');
      }
      // Anything else — gone between the resolve and here, or unreadable. This
      // used to be an unhandled 'error' on the stream below, and since nothing
      // in this process handles `uncaughtException`, it killed the console.
      return res.status(404).type('text/plain').send('not found: could not open the evidence file');
    }
    let size: number;
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) {
        closeSync(fd);
        return res.status(403).type('text/plain').send('refusing: not a regular file');
      }
      size = st.size;
    } catch {
      closeSync(fd);
      return res.status(404).type('text/plain').send('not found: could not open the evidence file');
    }
    if (size > MAX_EVIDENCE_BYTES) {
      closeSync(fd);
      return res
        .status(413)
        .type('text/plain')
        .send(`evidence file is ${(size / 1048576).toFixed(1)} MB, over the ${MAX_EVIDENCE_BYTES / 1048576} MB cap`);
    }
    res.type(CONTENT_TYPES[extname(resolved.absPath).toLowerCase()] ?? 'text/plain; charset=utf-8');
    res.setHeader('Content-Length', String(size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Load-bearing at gate C: rounds reuse filenames (`after.png` is `after.png`
    // every round), so the <img> URL is identical between them. Cached, the
    // browser shows round 1's screenshot as round 2's proof — stale evidence
    // presented as fresh is the exact failure this endpoint exists to prevent.
    res.setHeader('Cache-Control', 'no-cache');
    // `.pipe()` forwards data, NOT errors. A read that fails after the open — a
    // disk error, the worktree pulled out from under us — has to be caught here
    // or it is an unhandled 'error' event, which in this process means exit.
    const body = createReadStream('', { fd, autoClose: true });
    body.on('error', () => {
      if (res.headersSent) return void res.destroy();
      res.removeHeader('Content-Length');
      res.status(500).type('text/plain').send('the evidence file could not be read');
    });
    body.pipe(res);
  });

  /**
   * The inventory: what is running and what it costs. READ-ONLY — `docker
   * stats`, `lsof` and `ps`, nothing else — and cached for a few seconds because
   * those three are not free. Anything it could not read comes back in `notes`.
   */
  app.get('/api/instances', async (_req, res) => res.json(await orch.instances()));

  /**
   * Stop ONE worktree's dev server, on your click.
   *
   * The request names the ISSUE, never a pid or a port: the console re-resolves
   * the worktree, its registered port and the listening process itself, so a
   * stale (or hostile) page cannot ask it to kill something else. The refusal
   * rules live in instances.ts — port 8080 always, a working directory outside
   * that worktree always.
   */
  app.post('/api/issues/:n/stop-dev-server', async (req, res) => {
    const out = await orch.stopDevServerFor(Number(req.params.n), 'you stopped it from the instances panel');
    res.status(out.ok ? 200 : 409).json(out);
  });

  /**
   * Restart the edge runtime — the ONE container the console may restart, by
   * exact name, and the only container operation that exists here at all. There
   * is no stop, no remove, no prune, and no `supabase stop` / `db:reset`.
   *
   * It happens here and nowhere else: this route is the only caller, and it only
   * runs when you click the button.
   */
  app.post('/api/resources/restart-edge-runtime', async (_req, res) => {
    const out = await orch.reclaimEdgeRuntime();
    res.status(out.ok ? 200 : 500).json(out);
  });

  /**
   * Read GitHub NOW. The one thing that does not wait for the fifteen-minute
   * timer, and the reason that timer can be fifteen minutes at all: when you
   * know something has changed on GitHub, the answer is one click away.
   *
   * It also refreshes the local machine read, because `poll` still takes one —
   * a Refresh that left half the page on an older number would be the kind of
   * partial truth this console is built against.
   */
  app.post('/api/refresh', async (_req, res) => {
    // `manual` is not decoration: the quota brake stands aside for a person. A
    // timer poll declines to read when the graphql window is nearly spent, and
    // You pressing Refresh outranks that every time.
    const ran = await orch.poll({ manual: true });
    // A poll already in flight drops this one on the floor. Saying "read GitHub
    // just now" for it is the one answer you cannot check, and you press this
    // button precisely when the feed looks stale.
    res.json(
      ran
        ? { ok: true, message: 'read GitHub just now' }
        : { ok: true, message: 'a read was already running — this one was skipped, not repeated' },
    );
  });

  /**
   * AUDIT every open issue: read GitHub fresh, then validate what each row's
   * status claims — a blocked issue has a human reason, a draft PR is named as
   * the trap it is, and anything held past the median of its leg is called
   * slow. The report rides `state()` down the SSE, so this returns only the
   * one-line summary for the toast.
   */
  app.post('/api/audit', async (_req, res) => {
    res.json(await orch.audit());
  });

  // ------------------------------------------------------- actions on you

  /**
   * "I have seen these." It retires the tier 2–3 news; a tier-1 UAT send-back is
   * deliberately untouched, because a to-do does not expire because you looked
   * at it — that one clears when GitHub says the fix shipped.
   */
  app.post('/api/actions/seen', async (_req, res) => res.json(await orch.markActionsSeen()));

  // ------------------------------------------------- what has been announced

  /**
   * The log of everything the console has announced, newest first.
   *
   * Read off the ledger that already decides what has been sent, so there is one
   * record and not two. Its own route rather than a field on the state frame:
   * the whole history is far bigger than the handful of rows the feed carries,
   * and it is read when the tab is opened, not on every tick.
   */
  app.get('/api/notifications', async (_req, res) => res.json(await orch.notifications()));

  /** Opening the tab reads it. There are no per-row buttons — a bell you have to
   *  tidy up by hand is a chore, and chores get muted. */
  app.post('/api/notifications/read', async (_req, res) => res.json(await orch.markNotificationsRead()));

  /** Empty the list. It hides entries, it never deletes them: the ledger is also
   *  what stops a notification being sent twice. */
  app.post('/api/notifications/clear', async (_req, res) => res.json(await orch.clearNotifications()));

  /** The PUBLIC half of the VAPID pair, for `PushManager.subscribe`. The private
   *  half never leaves `push-keys.json` (0600, gitignored). */
  app.get('/api/push/vapid', (_req, res) => res.json({ publicKey: orch.vapidPublicKey() }));

  /**
   * Register a phone.
   *
   * The shape is validated rather than trusted: this console binds loopback and
   * has no auth by design, but Tailscale Serve proxies the whole tailnet at it,
   * so this route is reachable from any device on the tailnet. Storing junk here
   * would mean the push loop failing for ever on a malformed endpoint; storing a
   * non-https endpoint would mean posting your notifications, in the clear, at
   * whatever host was named.
   */
  app.post('/api/push/subscribe', async (req, res) => {
    const sub = req.body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const endpoint = typeof sub?.endpoint === 'string' ? sub.endpoint : '';
    const p256dh = typeof sub?.keys?.p256dh === 'string' ? sub.keys.p256dh : '';
    const auth = typeof sub?.keys?.auth === 'string' ? sub.keys.auth : '';
    if (!endpoint || !p256dh || !auth) {
      return res.status(400).json({ ok: false, message: 'a push subscription needs an endpoint and both keys' });
    }
    if (!endpoint.startsWith('https://')) {
      return res.status(400).json({ ok: false, message: 'a push endpoint is always https' });
    }
    const saved = await orch.savePushSubscription({ endpoint, keys: { p256dh, auth } });
    // A refusal is a refusal: 409 rather than a 200 the page reads as success.
    res.status(saved.ok ? 200 : 409).json(saved);
  });

  app.post('/api/push/unsubscribe', async (req, res) => {
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    if (!endpoint) return res.status(400).json({ ok: false, message: 'which subscription?' });
    res.json(await orch.removePushSubscription(endpoint));
  });

  /**
   * Prove the whole chain, on a click: keys, subscription, relay, and the
   * phone's own permission. Four things that each fail silently and only matter
   * when the operator is away from the desk, so there has to be a way to ask.
   *
   * It carries no work data — not a title, not a number. Still read-only as far
   * as GitHub is concerned: this posts to a push endpoint, never to GitHub.
   */
  app.post('/api/push/test', async (_req, res) => res.json(await orch.sendTestPush()));

  /**
   * The off switches, edited in the app. A patch, so the page can flip one thing
   * without having to send back a whole preferences object it might be a version
   * behind on.
   */
  app.post('/api/notify/prefs', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kinds = (body.kinds ?? {}) as Record<string, unknown>;
    const allowed = new Set(['push', 'feed', 'off']);
    for (const [kind, value] of Object.entries(kinds)) {
      if (!allowed.has(String(value))) {
        return res.status(400).json({ ok: false, message: `'${String(value)}' is not a switch for ${kind}` });
      }
    }
    const patch: Record<string, unknown> = {};
    for (const key of ['enabled', 'inApp', 'phone'] as const) {
      if (typeof body[key] === 'boolean') patch[key] = body[key];
    }
    if (body.detail === 'numbers' || body.detail === 'none') patch.detail = body.detail;
    if (Object.keys(kinds).length > 0) patch.kinds = kinds;
    res.json(await orch.setNotifyPrefs(patch));
  });

  const uiDir = resolveUiDir(cfg);
  if (uiDir) {
    app.use(express.static(uiDir));
    app.get('*', (_req, res) => res.sendFile(join(uiDir, 'index.html')));
  } else {
    app.get('/', (_req, res) =>
      res
        .status(503)
        .type('text/plain')
        .send('UI is not built. Run: npm run build'),
    );
  }
  return app;
}

export function listen(app: express.Express, cfg: Config): Promise<Server> {
  return new Promise((resolve) => {
    // 127.0.0.1 only. There is no auth here and there is not going to be.
    const server = app.listen(cfg.port, cfg.host, () => resolve(server));
  });
}
