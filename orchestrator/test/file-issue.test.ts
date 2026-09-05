/**
 * Filing the spin-off from the console, on the operator's click.
 *
 * The obvious question is why the console cannot create the issue itself — and
 * if it did, why it could not then link the new issue to the one that found it.
 *
 * There IS a reason the WORKER cannot, and it is specific rather than a general
 * distrust of agents: `.github/workflows/issue-dev-autoassign.yml` — "Issue →
 * auto-assign + Ready lane (engineers only)" — stamps the filer as assignee and
 * moves the card to `Ready`. So an issue a worker files never reaches triage; it
 * silently becomes the operator's assigned work, looking exactly like something
 * the team asked for. example-repo#4562 arrived that way.
 *
 * But that consequence is IDENTICAL whether the console files it or the operator
 * presses Submit on GitHub's prefilled form — it is their account either way. So
 * the fence was never buying protection from the automation. It was buying a
 * human DECISION about whether the issue should exist, which a click here
 * preserves exactly.
 *
 * What the prefilled-URL route could never do is the linking half. A browser
 * form hands the new number to GitHub and nothing else; the console never learns
 * it, so parent and child stay unlinked. Filing here, the console knows both
 * numbers at once.
 */
import { describe, it, expect, vi } from 'vitest';
import { assertIssueCreateOnly, createIssue, spinOffBody, type GhWriteExec } from '../src/issues.js';
import type { IssueRequest } from '../src/drafts.js';

const req = (over: Partial<IssueRequest> = {}): IssueRequest => ({
  fromIssue: 4633,
  title: 'fix(drs): digital-asset entropy reads category_counts.usage_categories',
  body: 'The body the worker drafted.',
  labels: ['bug', 'area:enrichment', 'data-integrity'],
  boardLane: null,
  identifiedHow: 'The sibling trace found the same category-count read in the digital-asset scorer.',
  relationship: 'Both paths consume the base issue\'s category counts, but this one changes a separate score.',
  recommendation: 'separate',
  recommendationWhy: 'It changes every digital-asset subscore and needs its own verification.',
  why: 'It changes every digital-asset subscore and needs its own verification.',
  sessionId: null,
  ...over,
});

describe('assertIssueCreateOnly — the console gains ONE more verb, not a general gh', () => {
  it('permits exactly `gh issue create`', () => {
    expect(() => assertIssueCreateOnly(['issue', 'create', '--repo', 'example-org/example-repo'])).not.toThrow();
  });

  it('refuses every other issue verb, including the destructive ones', () => {
    for (const verb of ['close', 'edit', 'delete', 'reopen', 'transfer', 'pin', 'lock']) {
      expect(() => assertIssueCreateOnly(['issue', verb])).toThrow(/refusing/);
    }
  });

  it('refuses pr writes, which belong to the comment path or nowhere', () => {
    expect(() => assertIssueCreateOnly(['pr', 'create'])).toThrow(/refusing/);
    expect(() => assertIssueCreateOnly(['pr', 'merge'])).toThrow(/refusing/);
  });

  it('refuses an empty or malformed argv rather than assuming it is safe', () => {
    expect(() => assertIssueCreateOnly([])).toThrow(/refusing/);
    expect(() => assertIssueCreateOnly(['issue'])).toThrow(/refusing/);
  });
});

describe('spinOffBody — the link the prefilled URL could never carry', () => {
  it('names the parent, so GitHub cross-references it on the parent thread', () => {
    const body = spinOffBody(req());
    expect(body).toContain('Spun off from #4633');
    expect(body).toContain('The body the worker drafted.');
  });

  it('carries the worker\'s reason for it being separate, where a reader will see it', () => {
    expect(spinOffBody(req())).toContain('needs its own verification');
  });

  it('carries discovery, relationship, and the worker recommendation into the filed issue', () => {
    const body = spinOffBody(req());
    expect(body).toContain('**How it was identified:** The sibling trace found');
    expect(body).toContain('**How it relates to #4633:** Both paths consume');
    expect(body).toContain('**Worker recommendation:** File separately.');
  });

  it('omits the parent line entirely when the worker did not name one', () => {
    const body = spinOffBody(req({ fromIssue: null }));
    expect(body).not.toContain('Spun off from');
    expect(body).toContain('The body the worker drafted.');
  });
});

describe('createIssue', () => {
  it('sends title, labels and repo, and reads back the new number', async () => {
    let seen: string[] = [];
    const exec: GhWriteExec = async (args) => {
      seen = args;
      return { code: 0, stdout: 'https://github.com/example-org/example-repo/issues/4671\n', stderr: '' };
    };
    const out = await createIssue('example-org/example-repo', req(), { exec });

    expect(out.ok).toBe(true);
    expect(out.number).toBe(4671);
    expect(out.url).toBe('https://github.com/example-org/example-repo/issues/4671');
    expect(seen.slice(0, 2)).toEqual(['issue', 'create']);
    expect(seen).toContain('--repo');
    expect(seen[seen.indexOf('--repo') + 1]).toBe('example-org/example-repo');
    expect(seen[seen.indexOf('--title') + 1]).toBe(req().title);
    expect(seen[seen.indexOf('--label') + 1]).toBe('bug,area:enrichment,data-integrity');
  });

  it('passes the body by FILE, never on the command line', async () => {
    // The body is long, multi-line and full of backticks and quotes. On an argv
    // it is a quoting accident waiting to happen; `--body-file` has no such edge.
    let seen: string[] = [];
    const exec: GhWriteExec = async (args) => {
      seen = args;
      return { code: 0, stdout: 'https://github.com/example-org/example-repo/issues/1', stderr: '' };
    };
    await createIssue('example-org/example-repo', req({ body: 'line one\n`backtick` and "quotes"\n' }), { exec });
    expect(seen).toContain('--body-file');
    expect(seen).not.toContain('--body');
  });

  it('omits --label when the worker gave none, rather than sending an empty one', async () => {
    let seen: string[] = [];
    const exec: GhWriteExec = async (args) => {
      seen = args;
      return { code: 0, stdout: 'https://github.com/example-org/example-repo/issues/2', stderr: '' };
    };
    await createIssue('example-org/example-repo', req({ labels: [] }), { exec });
    expect(seen).not.toContain('--label');
  });

  it('reports a gh failure rather than claiming an issue exists', async () => {
    const exec: GhWriteExec = async () => ({ code: 1, stdout: '', stderr: 'HTTP 403' });
    const out = await createIssue('example-org/example-repo', req(), { exec });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('403');
    expect(out.number).toBeUndefined();
  });

  it('fails rather than guessing when gh prints something that is not an issue URL', async () => {
    // A number we cannot read is the one thing that must not be invented: it is
    // what the parent gets linked to.
    const exec: GhWriteExec = async () => ({ code: 0, stdout: 'Creating issue in example-org/example-repo\n', stderr: '' });
    const out = await createIssue('example-org/example-repo', req(), { exec });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/could not read/i);
  });

  it('refuses a title the worker left empty, before anything runs', async () => {
    const exec = vi.fn<GhWriteExec>();
    const out = await createIssue('example-org/example-repo', req({ title: '   ' }), { exec });
    expect(out.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});
