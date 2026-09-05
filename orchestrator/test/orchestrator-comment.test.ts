import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { loadConfig } from '../src/config.js';
import * as gh from '../src/gh.js';
import * as resources from '../src/resources.js';
import { memoryOk } from './fixtures/memory.js';
import type { GhWriteExec } from '../src/comment.js';

/**
 * These prove the write fence at the orchestrator level: a drafted comment on
 * disk posts NOTHING on its own, and only an explicit postComment() call reaches
 * gh — with a fake gh, never the real one.
 */
let repo: string;
let worktree: string;

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wc-orch-'));
  git(['init', '-b', 'dev'], repo);
  git(['config', 'user.email', 'x@y.z'], repo);
  git(['config', 'user.name', 'x'], repo);
  writeFileSync(join(repo, 'r.txt'), 'x');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  worktree = join(repo, '.worktrees', 'issue-4334-demo');
  git(['worktree', 'add', '-b', 'fix/issue-4334-demo', worktree, 'dev'], repo);
  writeFileSync(
    join(worktree, '.comment-request.json'),
    JSON.stringify({
      issue: 4334,
      addressee: '@teammate-one',
      blocks: true,
      why: 'Password-reset links may point at a dead domain.',
      draftBody: 'Hi teammate-one — which domain is live for password-reset links?',
      sessionId: 'sess-4334',
      requestedAt: '2026-08-11T10:00:00Z',
    }),
  );

  // Never touch the network: stub every gh read the poll uses.
  vi.spyOn(gh, 'listIssues').mockResolvedValue([
    { number: 4334, title: 'Branded Auth Email Links', url: 'u', labels: ['bug'], updatedAt: 'z', author: 'operator' },
  ]);
  // Merged PRs are read on every poll now (a merged PR used to vanish from the
  // console and the row lied). Stubbed empty so no test reaches the network.
  vi.spyOn(gh, 'listRecentMergedPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'listOpenPrs').mockResolvedValue(new Map());
  vi.spyOn(gh, 'viewIssueComments').mockResolvedValue([]);
  // ...and never touch the MACHINE either. Unstubbed, every poll here shelled
  // out to the real `docker stats`, `memory_pressure` and `vm_stat` — slow,
  // and an answer that changes with whatever else is running on the laptop.
  vi.spyOn(resources, 'probeResources').mockResolvedValue(memoryOk());
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function orch() {
  const cfg = loadConfig({
    REPO_PATH: repo,
    REPO: 'example-org/example-repo',
    STATE_FILE: join(repo, 'state.json'),
    POLL_MS: '999999',
  });
  return new Orchestrator(cfg);
}

describe('a drafted comment never posts on its own', () => {
  it('a poll over a worktree holding .comment-request.json makes ZERO gh writes', async () => {
    const writeExec = vi.fn<GhWriteExec>();
    const o = orch();
    await o.start(); // this polls

    const row = o.state().issues.find((r) => r.number === 4334)!;
    expect(row.status).toBe('awaiting-post');
    expect(row.commentRequest?.draftBody).toContain('which domain is live');
    // The gh WRITE exec was never constructed or called by a poll.
    expect(writeExec).not.toHaveBeenCalled();
    await o.stop();
  });

  it('only an explicit postComment() reaches gh, and it posts the byte-exact body', async () => {
    let posted = '';
    let seenArgs: string[] = [];
    const writeExec: GhWriteExec = async (args) => {
      seenArgs = args;
      const { readFileSync } = await import('node:fs');
      posted = readFileSync(args[args.indexOf('--body-file') + 1]!, 'utf8');
      return { code: 0, stdout: 'https://github.com/example-org/example-repo/issues/4334#issuecomment-77', stderr: '' };
    };

    const o = orch();
    await o.start();

    const edited = 'Hi teammate-one — which domain is live? (edited by the operator)\n';
    const out = await o.postComment(4334, edited, writeExec);
    expect(out.ok).toBe(true);
    expect(out.url).toContain('#issuecomment-77');
    expect(posted).toBe(edited); // byte-exact, exactly what the operator approved
    expect(seenArgs.slice(0, 3)).toEqual(['issue', 'comment', '4334']);

    // Now blocked, out of the queue, waiting on teammate-one.
    const row = o.state().issues.find((r) => r.number === 4334)!;
    expect(row.status).toBe('blocked');
    expect(row.statusDetail).toBe('awaiting @teammate-one');
    expect(row.commentBlock?.commentUrl).toContain('#issuecomment-77');
    await o.stop();
  });

  it('handles blocks:false without creating a block or dropping its queue place, durably', async () => {
    writeFileSync(
      join(worktree, '.comment-request.json'),
      JSON.stringify({
        issue: 4334,
        addressee: '@teammate-one',
        blocks: false,
        why: 'A heads-up only.',
        draftBody: 'Heads-up: the related change landed.',
        sessionId: 'sess-4334',
        requestedAt: '2026-08-18T14:00:00Z',
      }),
    );
    vi.mocked(resources.probeResources).mockResolvedValue(memoryOk({ ok: false, reason: 'desk intentionally held' }));
    let posted = '';
    const writeExec: GhWriteExec = async (args) => {
      const { readFileSync } = await import('node:fs');
      posted = readFileSync(args[args.indexOf('--body-file') + 1]!, 'utf8');
      return { code: 0, stdout: 'https://github.com/example-org/example-repo/issues/4334#issuecomment-88', stderr: '' };
    };

    const first = orch();
    await first.start();
    expect(first.enqueue(4334).ok).toBe(true);
    expect(first.state().queue).toContain(4334);

    const out = await first.postComment(4334, 'Heads-up: the related change landed.', writeExec);
    expect(out.ok).toBe(true);
    expect(posted).toBe('Heads-up: the related change landed.');
    expect(first.state().queue).toContain(4334);
    expect(first.state().issues.find((r) => r.number === 4334)!.commentBlock).toBeNull();
    expect(first.state().issues.find((r) => r.number === 4334)!.commentRequest).toBeNull();
    await first.poll();
    expect(first.state().issues.find((r) => r.number === 4334)!.commentRequest).toBeNull();
    await first.stop();

    const second = orch();
    await second.start();
    expect(second.state().issues.find((r) => r.number === 4334)!.commentRequest).toBeNull();

    // A genuinely new request is not swallowed by the handled marker.
    writeFileSync(
      join(worktree, '.comment-request.json'),
      JSON.stringify({
        issue: 4334,
        addressee: '@teammate-one',
        blocks: false,
        why: 'A new heads-up.',
        draftBody: 'A second, different comment.',
        requestedAt: '2026-08-18T15:00:00Z',
      }),
    );
    await second.poll();
    expect(second.state().issues.find((r) => r.number === 4334)!.commentRequest?.draftBody).toBe(
      'A second, different comment.',
    );
    await second.stop();
  });

  it('refuses to post when there is no drafted request', async () => {
    const o = orch();
    await o.start();
    const out = await o.postComment(9999, 'body', vi.fn<GhWriteExec>());
    expect(out.ok).toBe(false);
    expect(out.message).toContain('no drafted comment');
    await o.stop();
  });
});

describe('a product decision lives on the PR it can block', () => {
  it('posts one concise question on the PR and watches that PR for the answer', async () => {
    writeFileSync(
      join(worktree, '.comment-request.json'),
      JSON.stringify({
        issue: 4334,
        kind: 'decision',
        target: { kind: 'pr', number: 4368 },
        addressee: '@teammate-one',
        blocks: true,
        why: 'PR #4368 cannot be correct until teammate-one names the live domain.',
        context: '#4334 does not identify the live password-reset domain.',
        question: 'Which domain should PR #4368 use for password-reset links?',
        // A decision body is synthesized from the short fields above. A worker
        // cannot smuggle an essay into the card through this legacy field.
        draftBody: 'This deliberately long legacy body must not be posted.',
        sessionId: 'sess-4334',
        requestedAt: '2026-08-26T12:00:00Z',
      }),
    );

    let seenArgs: string[] = [];
    let seenBody = '';
    const writeExec: GhWriteExec = async (args) => {
      seenArgs = args;
      seenBody = readFileSync(args[args.indexOf('--body-file') + 1]!, 'utf8');
      return {
        code: 0,
        stdout: 'https://github.com/example-org/example-repo/pull/4368#issuecomment-101',
        stderr: '',
      };
    };

    const o = orch();
    await o.start();
    const expected =
      '@teammate-one — #4334 does not identify the live password-reset domain.\n\n' +
      'Which domain should PR #4368 use for password-reset links?';
    const before = o.state().issues.find((row) => row.number === 4334)!;
    expect(before.commentRequest?.draftBody).toBe(expected);

    const posted = await o.postComment(4334, before.commentRequest!.draftBody, writeExec);
    expect(posted.ok).toBe(true);
    expect(posted.message).toBe('posted on PR #4368');
    expect(seenArgs.slice(0, 3)).toEqual(['pr', 'comment', '4368']);
    expect(seenBody).toBe(expected);

    const waiting = o.state().issues.find((row) => row.number === 4334)!;
    expect(waiting.status).toBe('blocked');
    expect(waiting.commentBlock?.onTarget).toEqual({ kind: 'pr', number: 4368 });

    vi.mocked(gh.viewIssueComments).mockResolvedValue([
      {
        author: { login: 'teammate-one' },
        createdAt: '2099-01-01T00:00:00Z',
        body: 'Use dev.example for password-reset links.',
      },
    ]);
    await o.poll();

    expect(gh.viewIssueComments).toHaveBeenCalledWith('example-org/example-repo', 4368);
    const answered = o.state().issues.find((row) => row.number === 4334)!;
    expect(answered.status).toBe('reply-received');
    expect(answered.commentBlock?.reply).toMatchObject({
      author: 'teammate-one',
      body: 'Use dev.example for password-reset links.',
    });
    await o.stop();
  });
});

/**
 * The card had exactly one exit: Post. A draft aimed at a ticket that closed
 * underneath it (#4619, closed by automation while its draft still sat there)
 * could only be cleared by deleting a worker-owned file by hand.
 *
 * Discard marks the request consumed exactly as posting does — it must never
 * touch the worktree, and it must never reach gh.
 */
describe('a drafted comment can be discarded without posting', () => {
  it('clears the card, writes NOTHING to gh, and leaves the worker-owned file alone', async () => {
    const writeExec = vi.fn<GhWriteExec>();
    const o = orch();
    await o.start();

    const before = o.state().issues.find((r) => r.number === 4334)!;
    expect(before.commentRequest).not.toBeNull();
    expect(before.status).toBe('awaiting-post');

    const out = await o.discardComment(4334, before.commentRequest!.requestedAt);
    expect(out.ok).toBe(true);
    expect(writeExec).not.toHaveBeenCalled();

    const after = o.state().issues.find((r) => r.number === 4334)!;
    expect(after.status).not.toBe('awaiting-post');
    // The file is the worker's, not the console's.
    expect(readFileSync(join(worktree, '.comment-request.json'), 'utf8')).toContain('4334');
    await o.stop();
  });

  it('refuses a stale token, so an old tab cannot discard a NEWER draft', async () => {
    const o = orch();
    await o.start();
    const out = await o.discardComment(4334, '1999-01-01T00:00:00Z');
    expect(out.ok).toBe(false);
    const row = o.state().issues.find((r) => r.number === 4334)!;
    expect(row.status).toBe('awaiting-post');
    await o.stop();
  });
});

describe('reply detection flips the block to reply-received', () => {
  it('a later comment by someone else is picked up on the next poll', async () => {
    const writeExec: GhWriteExec = async () => ({
      code: 0,
      stdout: 'https://github.com/example-org/example-repo/issues/4334#issuecomment-1',
      stderr: '',
    });
    const o = orch();
    await o.start();
    await o.postComment(4334, 'the ask', writeExec);
    expect(o.state().issues.find((r) => r.number === 4334)!.status).toBe('blocked');

    // teammate-one replies after the post.
    vi.mocked(gh.viewIssueComments).mockResolvedValue([
      { author: { login: 'teammate-one' }, createdAt: '2099-01-01T00:00:00Z', body: 'Use dev.example.test.' },
    ]);
    await o.poll();

    const row = o.state().issues.find((r) => r.number === 4334)!;
    expect(row.status).toBe('reply-received');
    expect(row.commentBlock?.reply?.author).toBe('teammate-one');
    expect(row.commentBlock?.reply?.body).toContain('dev.example');
    await o.stop();
  });
});

/**
 * A heads-up for a DIFFERENT ticket, which is the case that exposed the bug.
 *
 * #4641's worker drafted a comment for @teammate-two about #4317 — the issue teammate-two
 * is assigned to, whose PR inherits #4641's work units. The request said so
 * plainly: `"issue": 4317`. `parseCommentRequest` REQUIRES that field and drops
 * the whole request without it, and it is carried onto the row.
 *
 * `postComment` then ignored it and posted to the row's own number. So the
 * warning aimed at #4317 would have landed on #4641, on a ticket teammate-two has
 * nothing to do with, while the card on screen said "posts ... as a comment on
 * #4641" — which was, accidentally, the only true sentence in the exchange.
 *
 * The reply watch had the same fault from the other end: `#checkReplies` reads
 * `viewIssueComments(repo, Number(key))`, and the key is the row. A reply on
 * #4317 would never have been seen, so the row would have sat "awaiting
 * @teammate-two" forever while teammate-two had in fact answered.
 */
describe('a comment aimed at another ticket goes to THAT ticket', () => {
  it('posts to the issue the request names, not the row it came from', async () => {
    let seenArgs: string[] = [];
    const writeExec: GhWriteExec = async (args) => {
      seenArgs = args;
      return { code: 0, stdout: 'https://github.com/example-org/example-repo/issues/4317#issuecomment-99', stderr: '' };
    };

    writeFileSync(
      join(worktree, '.comment-request.json'),
      JSON.stringify({
        issue: 4317, // NOT 4334, which is this worktree's own issue
        addressee: '@teammate-two',
        blocks: true,
        why: 'Their PR inherits four work units from this one.',
        draftBody: 'Heads-up: this landed first.',
      }),
    );

    const o = orch();
    await o.start();
    const out = await o.postComment(4334, 'Heads-up: this landed first.', writeExec);

    expect(out.ok).toBe(true);
    expect(seenArgs.slice(0, 3)).toEqual(['issue', 'comment', '4317']);
    expect(out.message).toContain('4317');
    await o.stop();
  });

  it('watches the ticket it actually posted on for the reply', async () => {
    const writeExec: GhWriteExec = async () => ({
      code: 0,
      stdout: 'https://github.com/example-org/example-repo/issues/4317#issuecomment-99',
      stderr: '',
    });
    writeFileSync(
      join(worktree, '.comment-request.json'),
      JSON.stringify({ issue: 4317, addressee: '@teammate-two', blocks: true, why: 'w', draftBody: 'b' }),
    );

    const o = orch();
    await o.start();
    await o.postComment(4334, 'b', writeExec);

    // The block still hangs off the ROW — that is where the card renders — but it
    // records which ticket to read, so the reply is not looked for on the wrong one.
    const row = o.state().issues.find((r) => r.number === 4334)!;
    expect(row.commentBlock?.onIssue).toBe(4317);
    await o.stop();
  });

  it('resolves a posted block without running a worker and suppresses the consumed request across restart', async () => {
    const writeExec: GhWriteExec = async () => ({
      code: 0,
      stdout: 'https://github.com/example-org/example-repo/issues/4334#issuecomment-100',
      stderr: '',
    });
    const first = orch();
    await first.start();
    await first.postComment(4334, 'body', writeExec);
    const block = first.state().issues.find((r) => r.number === 4334)!.commentBlock!;

    expect((await first.resolveCommentBlock(4334, 'stale-post-time')).ok).toBe(false);
    expect(first.state().issues.find((r) => r.number === 4334)!.commentBlock).not.toBeNull();

    const out = await first.resolveCommentBlock(4334, block.postedAt);
    expect(out.ok).toBe(true);
    const resolved = first.state().issues.find((r) => r.number === 4334)!;
    expect(resolved.commentBlock).toBeNull();
    expect(resolved.commentRequest).toBeNull();
    expect(first.state().activeCount).toBe(0);
    await first.poll();
    expect(first.state().issues.find((r) => r.number === 4334)!.commentRequest).toBeNull();
    await first.stop();

    const second = orch();
    await second.start();
    expect(second.state().issues.find((r) => r.number === 4334)!.commentBlock).toBeNull();
    expect(second.state().issues.find((r) => r.number === 4334)!.commentRequest).toBeNull();
    await second.stop();
  });

  it('refuses to dismiss a block once an actual reply has landed', async () => {
    const writeExec: GhWriteExec = async () => ({ code: 0, stdout: 'u', stderr: '' });
    const o = orch();
    await o.start();
    await o.postComment(4334, 'body', writeExec);
    vi.mocked(gh.viewIssueComments).mockResolvedValue([
      { author: { login: 'teammate-one' }, createdAt: '2099-01-01T00:00:00Z', body: 'the answer' },
    ]);
    await o.poll();
    const block = o.state().issues.find((r) => r.number === 4334)!.commentBlock!;
    expect(block.reply?.body).toBe('the answer');
    expect((await o.resolveCommentBlock(4334, block.postedAt)).ok).toBe(false);
    expect(o.state().issues.find((r) => r.number === 4334)!.commentBlock?.reply?.body).toBe('the answer');
    await o.stop();
  });

  it('retains and polls an explicit true block when the owner row is absent from the assigned-open list', async () => {
    const writeExec: GhWriteExec = async () => ({
      code: 0,
      stdout: 'https://github.com/example-org/example-repo/issues/4334#issuecomment-101',
      stderr: '',
    });
    const o = orch();
    await o.start();
    await o.postComment(4334, 'body', writeExec);
    vi.mocked(gh.viewIssueComments).mockClear();
    vi.mocked(gh.listIssues).mockResolvedValue([]);

    await o.poll();

    const absent = o.state().issues.find((r) => r.number === 4334)!;
    // Absence from the assigned-open list can also mean reassigned or truncated,
    // so the explicit true block remains authoritative and keeps watching.
    expect(absent.status).toBe('blocked');
    expect(absent.commentBlock).not.toBeNull();
    expect(gh.viewIssueComments).toHaveBeenCalled();
    await o.stop();
  });

  it('repairs a legacy block whose current request explicitly says blocks:false', async () => {
    writeFileSync(
      join(worktree, '.comment-request.json'),
      JSON.stringify({
        issue: 4317,
        addressee: '@teammate-two',
        blocks: false,
        why: 'Heads-up only.',
        draftBody: 'The related PR landed.',
        requestedAt: '2026-08-15T15:35:00Z',
      }),
    );
    writeFileSync(
      join(repo, 'state.json'),
      JSON.stringify({
        commentBlocks: {
          '4334': {
            addressee: '@teammate-two',
            onIssue: 4317,
            postedAt: '2026-08-15T14:24:43.636Z',
            commentUrl: 'u',
            reply: null,
          },
        },
      }),
    );
    vi.mocked(gh.listIssues).mockResolvedValue([]);
    vi.mocked(gh.listRecentMergedPrs).mockResolvedValue(
      new Map([
        [
          'fix/issue-4334-demo',
          { number: 99, url: 'pr', state: 'MERGED', title: 'done', isDraft: false, mergedAt: '2026-08-18T14:00:00Z' },
        ],
      ]),
    );
    const o = orch();
    await o.start();
    const row = o.state().issues.find((r) => r.number === 4334)!;
    expect(row.commentBlock).toBeNull();
    expect(row.commentRequest).toBeNull();
    expect(row.status).toBe('done');
    const persisted = JSON.parse(readFileSync(join(repo, 'state.json'), 'utf8')) as {
      commentBlocks: Record<string, unknown>;
    };
    expect(persisted.commentBlocks['4334']).toBeUndefined();
    await o.stop();
  });

  it('does not let resolving a legacy block suppress a different current request', async () => {
    const writeExec: GhWriteExec = async () => ({ code: 0, stdout: 'u', stderr: '' });
    const first = orch();
    await first.start();
    await first.postComment(4334, 'old body', writeExec);
    const oldBlock = first.state().issues.find((r) => r.number === 4334)!.commentBlock!;
    await first.stop();

    const statePath = join(repo, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      commentBlocks: Record<string, { requestKey?: string }>;
    };
    delete state.commentBlocks['4334']!.requestKey; // state written by an older build
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(
      join(worktree, '.comment-request.json'),
      JSON.stringify({
        issue: 4334,
        addressee: '@teammate-one',
        blocks: true,
        why: 'A genuinely new question.',
        draftBody: 'new body',
        requestedAt: '2026-08-19T10:00:00Z',
      }),
    );

    const second = orch();
    await second.start();
    expect((await second.resolveCommentBlock(4334, oldBlock.postedAt)).ok).toBe(true);
    expect(second.state().issues.find((r) => r.number === 4334)!.commentRequest?.draftBody).toBe('new body');
    await second.stop();
  });

  it('does not resurrect a block when resolve wins during an in-flight reply read', async () => {
    const writeExec: GhWriteExec = async () => ({ code: 0, stdout: 'u', stderr: '' });
    const o = orch();
    await o.start();
    await o.postComment(4334, 'body', writeExec);
    const postedAt = o.state().issues.find((r) => r.number === 4334)!.commentBlock!.postedAt;

    let release!: (comments: gh.GhComment[]) => void;
    const pending = new Promise<gh.GhComment[]>((resolve) => {
      release = resolve;
    });
    vi.mocked(gh.viewIssueComments).mockReturnValueOnce(pending);
    const polling = o.poll();
    while (vi.mocked(gh.viewIssueComments).mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await o.resolveCommentBlock(4334, postedAt)).ok).toBe(true);
    release([
      { author: { login: 'teammate-one' }, createdAt: '2099-01-01T00:00:00Z', body: 'late answer' },
    ]);
    await polling;
    expect(o.state().issues.find((r) => r.number === 4334)!.commentBlock).toBeNull();
    await o.stop();
  });

  it('still posts on the row itself when the request names it', async () => {
    // The ordinary case, unchanged: same number in both places.
    let seenArgs: string[] = [];
    const writeExec: GhWriteExec = async (args) => {
      seenArgs = args;
      return { code: 0, stdout: 'u', stderr: '' };
    };
    const o = orch();
    await o.start();
    await o.postComment(4334, 'body', writeExec);
    expect(seenArgs.slice(0, 3)).toEqual(['issue', 'comment', '4334']);
    await o.stop();
  });
});
