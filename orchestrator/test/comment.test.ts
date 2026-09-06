import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCommentOnly,
  runGuardedGhWrite,
  postIssueComment,
  postTargetComment,
  parseCommentRequest,
  commentRequestKey,
  commentTarget,
  detectReply,
  type GhWriteExec,
} from '../src/comment.js';

/**
 * THE FENCE. postIssueComment is the ONLY GitHub write in the codebase, and it
 * is structurally comment-only. Everything that could ever run gh with write
 * intent goes through assertCommentOnly, which permits exactly two things.
 */
describe('assertCommentOnly — the comment-only fence', () => {
  it('permits `issue comment`', () => {
    expect(() => assertCommentOnly(['issue', 'comment', '4334', '--body-file', '/tmp/x'])).not.toThrow();
  });

  it('permits `pr comment`', () => {
    expect(() => assertCommentOnly(['pr', 'comment', '4368', '--body-file', '/tmp/x'])).not.toThrow();
  });

  it.each([
    ['issue', 'edit'],
    ['issue', 'close'],
    ['issue', 'delete'],
    ['issue', 'transfer'],
    ['issue', 'reopen'],
    ['pr', 'merge'],
    ['pr', 'create'],
    ['pr', 'close'],
    ['pr', 'review'],
    ['label', 'create'],
    ['repo', 'delete'],
    ['api', '-X'],
    ['auth', 'logout'],
  ])('REFUSES `%s %s`', (a, b) => {
    expect(() => assertCommentOnly([a, b, 'anything'])).toThrow(/only post comments/i);
  });

  it('REFUSES an empty or truncated argv', () => {
    expect(() => assertCommentOnly([])).toThrow();
    expect(() => assertCommentOnly(['issue'])).toThrow();
  });

  it('REFUSES `issue` followed by a flag masquerading as the subcommand', () => {
    expect(() => assertCommentOnly(['issue', '--comment', 'x'])).toThrow();
  });
});

describe('runGuardedGhWrite — nothing runs unless the fence passes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wc-cmt-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('does not call gh at all when the fence rejects the args', async () => {
    const exec = vi.fn<GhWriteExec>();
    await expect(runGuardedGhWrite(['issue', 'close', '4334'], 'body', exec, dir)).rejects.toThrow(
      /only post comments/i,
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it('writes the body byte-exact to a file and passes --body-file to gh', async () => {
    const body = 'Hi — which domain is live for password-reset links?\n\n— the operator 🌱\n';
    let seenBody = '';
    let seenArgs: string[] = [];
    const exec: GhWriteExec = async (args) => {
      seenArgs = args;
      const bf = args[args.indexOf('--body-file') + 1]!;
      seenBody = readFileSync(bf, 'utf8');
      return { code: 0, stdout: 'https://github.com/example-org/example-repo/issues/4334#issuecomment-1\n', stderr: '' };
    };
    const out = await runGuardedGhWrite(['issue', 'comment', '4334', '--body-file', '__PLACEHOLDER__'], body, exec, dir);
    expect(seenBody).toBe(body); // byte-exact, including the emoji and trailing newline
    expect(seenArgs[0]).toBe('issue');
    expect(seenArgs[1]).toBe('comment');
    expect(out.ok).toBe(true);
    expect(out.url).toBe('https://github.com/example-org/example-repo/issues/4334#issuecomment-1');
  });

  it('reports failure with gh stderr instead of a false success', async () => {
    const exec: GhWriteExec = async () => ({ code: 1, stdout: '', stderr: 'gh: could not resolve to a Repository' });
    const out = await runGuardedGhWrite(['issue', 'comment', '4334', '--body-file', 'x'], 'b', exec, dir);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('could not resolve');
  });
});

describe('postIssueComment — the one write function, end to end with a fake gh', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wc-cmt-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('builds an `issue comment` argv and never anything else', async () => {
    let seen: string[] = [];
    const exec: GhWriteExec = async (args) => {
      seen = args;
      return { code: 0, stdout: 'https://github.com/example-org/example-repo/issues/4334#issuecomment-9', stderr: '' };
    };
    const out = await postIssueComment('example-org/example-repo', 4334, 'the body', { exec, tmpDir: dir });
    expect(seen.slice(0, 3)).toEqual(['issue', 'comment', '4334']);
    expect(seen).toContain('--repo');
    expect(seen).toContain('example-org/example-repo');
    expect(seen).toContain('--body-file');
    expect(out.ok).toBe(true);
    expect(out.url).toContain('#issuecomment-9');
  });

  it('there is no code path in postIssueComment that reaches gh with a non-comment subcommand', async () => {
    // We cannot pass a subcommand in — the function hardcodes it. This asserts the shape.
    const exec: GhWriteExec = async (args) => {
      assertCommentOnly(args); // if postIssueComment ever built something else, this throws
      return { code: 0, stdout: 'url', stderr: '' };
    };
    await expect(postIssueComment('example-org/example-repo', 1, 'b', { exec, tmpDir: dir })).resolves.toMatchObject({ ok: true });
  });
});

describe('postTargetComment — a decision can live with the PR it affects', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wc-pr-cmt-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('posts a PR-targeted question with the same byte-exact, comment-only path', async () => {
    const body = '@teammate-one — #4334 does not name the live domain.\n\nWhich domain should PR #4368 use?';
    let seenArgs: string[] = [];
    let seenBody = '';
    const exec: GhWriteExec = async (args) => {
      seenArgs = args;
      seenBody = readFileSync(args[args.indexOf('--body-file') + 1]!, 'utf8');
      return {
        code: 0,
        stdout: 'https://github.com/example-org/example-repo/pull/4368#issuecomment-10\n',
        stderr: '',
      };
    };

    const out = await postTargetComment('example-org/example-repo', { kind: 'pr', number: 4368 }, body, {
      exec,
      tmpDir: dir,
    });

    expect(seenArgs.slice(0, 3)).toEqual(['pr', 'comment', '4368']);
    expect(seenArgs).toContain('--body-file');
    expect(seenBody).toBe(body);
    expect(out).toEqual({
      ok: true,
      url: 'https://github.com/example-org/example-repo/pull/4368#issuecomment-10',
    });
  });
});

describe('parseCommentRequest — the worker draft on disk', () => {
  const good = {
    issue: 4334,
    addressee: '@teammate-one',
    blocks: true,
    why: 'Password-reset links point at a domain that may be dead.',
    draftBody: 'Hi Chris — which domain is live?',
    sessionId: 'sess-1',
    requestedAt: '2026-08-11T10:00:00Z',
  };

  it('reads a well-formed request', () => {
    const r = parseCommentRequest(JSON.stringify(good));
    expect(r).toEqual(good);
  });

  it('preserves an explicit non-blocking request', () => {
    const r = parseCommentRequest(JSON.stringify({ ...good, blocks: false }));
    expect(r!.blocks).toBe(false);
  });

  it('is null on malformed JSON', () => {
    expect(parseCommentRequest('{ not json')).toBeNull();
  });

  it('is null when there is no draft body to post — we never post nothing', () => {
    expect(parseCommentRequest(JSON.stringify({ ...good, draftBody: '' }))).toBeNull();
    const noBody = { ...good };
    delete (noBody as Record<string, unknown>).draftBody;
    expect(parseCommentRequest(JSON.stringify(noBody))).toBeNull();
  });

  it('is null without an issue number', () => {
    const noIssue = { ...good };
    delete (noIssue as Record<string, unknown>).issue;
    expect(parseCommentRequest(JSON.stringify(noIssue))).toBeNull();
  });

  it('defaults optional fields but keeps the mandatory ones', () => {
    const r = parseCommentRequest(
      JSON.stringify({ issue: 5, draftBody: 'q', addressee: '', why: '', sessionId: null, requestedAt: null }),
    );
    expect(r!.issue).toBe(5);
    expect(r!.draftBody).toBe('q');
    expect(r!.addressee).toBe('');
    expect(r!.blocks).toBe(false);
    expect(r!.sessionId).toBeNull();
  });
});

describe('parseCommentRequest — structured decisions and handoffs', () => {
  const decision = {
    issue: 4334,
    kind: 'decision',
    target: { kind: 'pr', number: 4368 },
    addressee: '@teammate-one',
    blocks: true,
    why: 'PR #4368 cannot be correct until Chris names the live domain.',
    context: '#4334 does not identify the live password-reset domain.',
    question: 'Which domain should PR #4368 use for password-reset links?',
    sessionId: null,
    requestedAt: '2026-08-26T11:20:00Z',
  } as const;

  it('turns a real external decision into one direct question on its PR', () => {
    const parsed = parseCommentRequest(
      JSON.stringify({
        ...decision,
        // A decision is composed from the structured fields. A worker cannot
        // smuggle the old technical appendix into the free-form body.
        draftBody:
          'Every response echoes tenant_id. All-components-skipped reports partial. No rush on the last two.',
      }),
    );

    expect(parsed).toMatchObject({
      issue: 4334,
      kind: 'decision',
      target: { kind: 'pr', number: 4368 },
      blocks: true,
      question: decision.question,
    });
    expect(parsed!.draftBody).toBe(
      '@teammate-one — #4334 does not identify the live password-reset domain.\n\n' +
        'Which domain should PR #4368 use for password-reset links?',
    );
    expect(parsed!.draftBody).not.toMatch(/tenant_id|all-components-skipped|last two/i);
    expect(commentTarget(parsed!)).toEqual({ kind: 'pr', number: 4368 });
  });

  it.each([
    ['does not block', { blocks: false }],
    ['has no named destination', { target: undefined }],
    ['has no named decision owner', { addressee: '' }],
    ['does not explain why product input is required', { why: '' }],
    ['asks no direct question', { question: 'Please advise' }],
    ['bundles two questions', { question: 'Is the hold lifted? Should tenant_id stay?' }],
    ['puts a paragraph in the question field', { question: 'Is the hold lifted?\nHere is an appendix.' }],
    ['puts a paragraph in the context field', { context: 'The issue is on hold.\nThe review is otherwise green.' }],
  ])('rejects a decision that %s', (_label, override) => {
    expect(parseCommentRequest(JSON.stringify({ ...decision, ...override }))).toBeNull();
  });

  it('preserves a required QA handoff on the issue without pretending it needs a reply', () => {
    const body = '**Test Result:** Ready to verify\n\n1. Open the submission.\n2. Confirm the status.';
    const parsed = parseCommentRequest(
      JSON.stringify({
        issue: 2689,
        kind: 'handoff',
        target: { kind: 'issue', number: 2689 },
        addressee: '@qa-owner',
        blocks: false,
        why: 'QA needs the ready-to-verify steps after merge.',
        draftBody: body,
        sessionId: null,
        requestedAt: '2026-08-26T12:00:00Z',
      }),
    );

    expect(parsed).toMatchObject({
      kind: 'handoff',
      target: { kind: 'issue', number: 2689 },
      blocks: false,
      draftBody: body,
    });
    expect(commentTarget(parsed!)).toEqual({ kind: 'issue', number: 2689 });
  });

  it('rejects a handoff that claims to wait for a reply', () => {
    expect(
      parseCommentRequest(
        JSON.stringify({
          issue: 2689,
          kind: 'handoff',
          target: { kind: 'issue', number: 2689 },
          addressee: '@qa-owner',
          blocks: true,
          why: 'QA handoff.',
          draftBody: 'Ready to verify.',
        }),
      ),
    ).toBeNull();
  });

  it('keeps legacy issue drafts valid and gives them their old target', () => {
    const legacy = parseCommentRequest(
      JSON.stringify({
        issue: 4334,
        addressee: '@dev-erin',
        blocks: false,
        why: 'A legacy heads-up.',
        draftBody: 'Legacy body.',
      }),
    )!;

    expect(legacy.kind).toBeUndefined();
    expect(commentTarget(legacy)).toEqual({ kind: 'issue', number: 4334 });
  });

  it('includes the target and kind in the handled-request identity', () => {
    const parsed = parseCommentRequest(JSON.stringify(decision))!;
    const moved = { ...parsed, target: { kind: 'issue' as const, number: 2689 } };
    const handedOff = { ...parsed, kind: 'handoff' as const };

    expect(commentRequestKey(moved)).not.toBe(commentRequestKey(parsed));
    expect(commentRequestKey(handedOff)).not.toBe(commentRequestKey(parsed));
  });

  it('does not treat presentation-only whitespace as a new decision', () => {
    const parsed = parseCommentRequest(JSON.stringify(decision))!;
    const differentlyRendered = { ...parsed, draftBody: parsed.draftBody.replace('\n\n', '\n') };

    expect(commentRequestKey(differentlyRendered)).toBe(commentRequestKey(parsed));
  });
});

describe('detectReply — a reply on the issue, by someone other than the operator, after the post', () => {
  const postedAt = '2026-08-11T10:00:00Z';
  const me = 'operator';

  const comment = (login: string, createdAt: string, body: string) => ({
    author: { login },
    createdAt,
    body,
  });

  it('finds a reply that lands after the post from someone else', () => {
    const reply = detectReply(
      [comment('operator', '2026-08-11T10:00:00Z', 'the ask'), comment('teammate-one', '2026-08-11T11:30:00Z', 'use the dev host')],
      postedAt,
      me,
    );
    expect(reply).not.toBeNull();
    expect(reply!.author).toBe('teammate-one');
    expect(reply!.body).toBe('use the dev host');
  });

  it('ignores the operator’s own later comments — those are not the reply we are waiting for', () => {
    const reply = detectReply([comment('operator', '2026-08-11T12:00:00Z', 'bump')], postedAt, me);
    expect(reply).toBeNull();
  });

  it('ignores comments from before the post', () => {
    const reply = detectReply([comment('teammate-one', '2026-08-10T09:00:00Z', 'old chatter')], postedAt, me);
    expect(reply).toBeNull();
  });

  it('returns the FIRST qualifying reply when several land', () => {
    const reply = detectReply(
      [
        comment('teammate-one', '2026-08-11T11:00:00Z', 'first'),
        comment('someoneElse', '2026-08-11T11:05:00Z', 'second'),
      ],
      postedAt,
      me,
    );
    expect(reply!.body).toBe('first');
  });

  it('is null when there are no comments', () => {
    expect(detectReply([], postedAt, me)).toBeNull();
  });

  it('treats a comment exactly at the post time as not-after (no self-match on our own comment)', () => {
    expect(detectReply([comment('teammate-one', postedAt, 'same instant')], postedAt, me)).toBeNull();
  });
});
