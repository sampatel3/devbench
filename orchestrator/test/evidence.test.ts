import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEvidence, resolveEvidencePath, EVIDENCE_ROOT } from '../src/evidence.js';

describe('parseEvidence — the manifest inside .gate.json', () => {
  it('keeps well-formed items', () => {
    const items = parseEvidence([
      { kind: 'screenshot', path: 'docs/issue-pipeline/plans/qa-4336/after.png', caption: 'after' },
      { kind: 'sql', path: 'docs/issue-pipeline/plans/qa-4336/rows.txt', caption: '849 rows' },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      kind: 'screenshot',
      path: 'docs/issue-pipeline/plans/qa-4336/after.png',
      caption: 'after',
      isImage: true,
    });
    expect(items[1]!.isImage).toBe(false);
  });

  it('marks png/jpg/jpeg/gif/webp as images regardless of the declared kind', () => {
    const items = parseEvidence([
      { kind: 'report', path: 'docs/issue-pipeline/plans/qa-1/x.jpeg', caption: 'c' },
      { kind: 'screenshot', path: 'docs/issue-pipeline/plans/qa-1/y.txt', caption: 'c' },
    ]);
    expect(items[0]!.isImage).toBe(true); // .jpeg wins over kind:report
    expect(items[1]!.isImage).toBe(false); // .txt is not an image even if kind says screenshot
  });

  it('is empty for a missing or non-array manifest', () => {
    expect(parseEvidence(undefined)).toEqual([]);
    expect(parseEvidence(null)).toEqual([]);
    expect(parseEvidence('nope')).toEqual([]);
  });

  it('drops items missing a path or with a non-string caption', () => {
    const items = parseEvidence([
      { kind: 'sql', caption: 'no path' },
      { kind: 'sql', path: 'docs/issue-pipeline/plans/qa-1/a.txt', caption: 42 },
      { kind: 'sql', path: 'docs/issue-pipeline/plans/qa-1/b.txt', caption: 'ok' },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.path).toBe('docs/issue-pipeline/plans/qa-1/b.txt');
  });

  it('defaults an unknown kind to report, never trusts it blindly', () => {
    const items = parseEvidence([{ kind: 'malware', path: 'docs/issue-pipeline/plans/qa-1/a.txt', caption: 'c' }]);
    expect(items[0]!.kind).toBe('report');
  });

  it('drops a path that does not sit under docs/issue-pipeline/plans/ at manifest time', () => {
    const items = parseEvidence([
      { kind: 'sql', path: 'docs/issue-pipeline/plans/qa-1/ok.txt', caption: 'c' },
      { kind: 'sql', path: 'src/secrets.ts', caption: 'nope' },
      { kind: 'sql', path: '../../../etc/passwd', caption: 'nope' },
    ]);
    expect(items.map((i) => i.path)).toEqual(['docs/issue-pipeline/plans/qa-1/ok.txt']);
  });
});

/**
 * THE FENCE. Serving a file out of a worktree is a path-traversal vector, so the
 * resolver refuses anything that escapes docs/issue-pipeline/plans/ inside that one
 * worktree — proven with a `..` escape, an absolute path, and a symlink that
 * points out of the tree.
 */
describe('resolveEvidencePath — path-traversal fence', () => {
  let worktree: string;
  let plans: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'wc-evi-'));
    plans = join(worktree, EVIDENCE_ROOT);
    mkdirSync(join(plans, 'qa-4336'), { recursive: true });
    writeFileSync(join(plans, 'qa-4336', 'after.png'), 'PNGDATA');
    // A secret that lives OUTSIDE the plans tree but inside the worktree.
    writeFileSync(join(worktree, 'secret.txt'), 'do not serve me');
  });
  afterEach(() => rmSync(worktree, { recursive: true, force: true }));

  it('resolves a real file under docs/issue-pipeline/plans/', () => {
    const r = resolveEvidencePath(worktree, 'docs/issue-pipeline/plans/qa-4336/after.png');
    expect(r.ok).toBe(true);
    // The resolver returns the realpath (symlinks followed), so compare against realpath.
    expect(r.absPath).toBe(realpathSync(join(plans, 'qa-4336', 'after.png')));
  });

  it('REFUSES a ../ escape to a home-directory key', () => {
    const r = resolveEvidencePath(worktree, '../../../.ssh/id_rsa');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('outside');
  });

  it('REFUSES an absolute path', () => {
    const r = resolveEvidencePath(worktree, '/etc/passwd');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('outside');
  });

  it('REFUSES a file that exists in the worktree but outside the plans tree', () => {
    const r = resolveEvidencePath(worktree, 'secret.txt');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('outside');
  });

  it('REFUSES a path that traverses up and back into plans of a DIFFERENT worktree', () => {
    const r = resolveEvidencePath(worktree, 'docs/issue-pipeline/plans/../../../../other/docs/issue-pipeline/plans/x.png');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('outside');
  });

  it('REFUSES a symlink inside the plans tree that points outside it', () => {
    symlinkSync(join(worktree, 'secret.txt'), join(plans, 'qa-4336', 'leak.txt'));
    const r = resolveEvidencePath(worktree, 'docs/issue-pipeline/plans/qa-4336/leak.txt');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('outside');
  });

  it('REFUSES a file that is not there (no information leak on existence beyond the fence)', () => {
    const r = resolveEvidencePath(worktree, 'docs/issue-pipeline/plans/qa-4336/missing.png');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not found');
  });

  it('refuses when there is no worktree at all', () => {
    const r = resolveEvidencePath(null, 'docs/issue-pipeline/plans/qa-4336/after.png');
    expect(r.ok).toBe(false);
  });
});
