import type { GhBlockedNote, GhIssue } from './gh.js';
import type { PullRequest } from './types.js';

/**
 * The last successful poll's GitHub reading, as a file — `github-snapshot.json`,
 * beside `state.json`.
 *
 * Why it exists: on 2026-09-05 a console restart landed inside an hour of
 * exhausted GraphQL quota. Every read of the first poll failed, and each one
 * fell back — correctly — to "the previous in-memory value". But the process was
 * seconds old, so the previous value of everything was EMPTY: no issues, no PR
 * map, no blocked notes, and every row degraded to the bare checkpoint line for
 * up to an hour while nothing was actually wrong. The mid-session behaviour
 * (keep the last good answer, say the stamp stopped moving) was right; the
 * restart just had no last good answer to keep. This file is that answer.
 *
 * It is a SEED, not a cache the console trusts: everything here re-enters memory
 * exactly where a failed poll's fallback would have kept it, `#lastPolledAt`
 * comes back as the snapshot's own `at`, and the first successful poll replaces
 * the lot. The header's "GitHub read HH:MM" therefore stamps the DATA's real
 * age — the rule orchestrator.ts states three times — and nothing built from
 * this file can claim to be live.
 *
 * Separate from `Persisted` on purpose, same reasoning as `actions.json`: it is
 * rewritten whole on every good poll, it is derived (GitHub still holds the
 * truth), and a corrupt copy must cost one stale-looking startup, never a
 * running worker's re-attach row.
 *
 * Serialization lives here rather than in orchestrator.ts so the round-trip can
 * be tested without a console — the convention `parseBlockedNote` follows.
 */
export type GithubSeed = {
  /** When the poll that wrote this actually READ GitHub. It becomes
   *  `#lastPolledAt` on load, which is what keeps the header honest. */
  at: string;
  issues: GhIssue[];
  /** Open and merged kept apart, exactly as in memory, so a failure of either
   *  startup read still falls back to its OWN last good answer. */
  openPrs: Map<string, PullRequest>;
  mergedPrs: Map<string, PullRequest>;
  blockedNotes: Map<number, GhBlockedNote>;
  lanes: Map<number, string>;
};

/** The wire shape: Maps as plain objects, issue numbers as string keys. */
type GithubSnapshotFile = {
  at: string;
  issues: GhIssue[];
  openPrs: Record<string, PullRequest>;
  mergedPrs: Record<string, PullRequest>;
  blockedNotes: Record<string, GhBlockedNote>;
  lanes: Record<string, string>;
};

export function serializeGithubSnapshot(seed: GithubSeed): string {
  const file: GithubSnapshotFile = {
    at: seed.at,
    issues: seed.issues,
    openPrs: Object.fromEntries(seed.openPrs),
    mergedPrs: Object.fromEntries(seed.mergedPrs),
    blockedNotes: Object.fromEntries([...seed.blockedNotes].map(([n, v]) => [String(n), v])),
    lanes: Object.fromEntries([...seed.lanes].map(([n, v]) => [String(n), v])),
  };
  return JSON.stringify(file, null, 2);
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Null for anything that cannot be trusted whole. The console wrote this file
 * atomically, so a refusal means a truncated disk or another build's idea of the
 * shape — and the safe reading of either is the one the console has always had
 * on a first run: start empty and let the poll fill it. Field contents are
 * trusted the way `#load` trusts state.json's; the one field checked hard is
 * `at`, because a seed that cannot say its own age cannot be shown honestly.
 */
export function parseGithubSnapshot(raw: string): GithubSeed | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record(o)) return null;
  if (typeof o.at !== 'string' || !Number.isFinite(Date.parse(o.at))) return null;
  if (!Array.isArray(o.issues)) return null;
  if (!record(o.openPrs) || !record(o.mergedPrs) || !record(o.blockedNotes) || !record(o.lanes)) return null;
  const f = o as unknown as GithubSnapshotFile;
  return {
    at: f.at,
    issues: f.issues,
    openPrs: new Map(Object.entries(f.openPrs)),
    mergedPrs: new Map(Object.entries(f.mergedPrs)),
    blockedNotes: new Map(Object.entries(f.blockedNotes).map(([n, v]) => [Number(n), v])),
    lanes: new Map(Object.entries(f.lanes).map(([n, v]) => [Number(n), v])),
  };
}
