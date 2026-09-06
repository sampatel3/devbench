import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEvidence, readEvidence, evidenceWarning, resolveEvidencePath, EVIDENCE_ROOT } from '../src/evidence.js';

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

  it('drops an entry with no path at all — there is nothing there to show', () => {
    const items = parseEvidence([{ kind: 'sql', caption: 'no path' }, { kind: 'sql', path: '', caption: 'empty' }]);
    expect(items).toEqual([]);
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
 * THE 130 THAT VANISHED.
 *
 * Read across 13 live worktrees this parser was dropping 130 entries: 100 bare
 * strings, 18 objects whose only fault was a missing caption, and 2 paths
 * outside the plans root. #4698 stopped at Gate C with twelve real screenshots
 * on disk, an empty evidence box on the card, and an approval given without
 * them. Everything recoverable is now coerced; the rest leaves with a reason.
 */
describe('parseEvidence — coercion, because a container is not the content', () => {
  it('reads a bare string as the path it obviously is — the 100-entry case', () => {
    const items = parseEvidence([
      'docs/issue-pipeline/plans/qa-4698/s1-after.png',
      'docs/issue-pipeline/plans/qa-4698/rows.sql',
      'docs/issue-pipeline/plans/qa-4698/notes.md',
    ]);
    expect(items).toEqual([
      { kind: 'screenshot', path: 'docs/issue-pipeline/plans/qa-4698/s1-after.png', caption: '', isImage: true },
      { kind: 'sql', path: 'docs/issue-pipeline/plans/qa-4698/rows.sql', caption: '', isImage: false },
      { kind: 'report', path: 'docs/issue-pipeline/plans/qa-4698/notes.md', caption: '', isImage: false },
    ]);
  });

  it('keeps an entry whose only fault is a missing caption — the picture beats the sentence about it', () => {
    const items = parseEvidence([
      { kind: 'screenshot', path: 'docs/issue-pipeline/plans/qa-1/a.png' },
      { kind: 'sql', path: 'docs/issue-pipeline/plans/qa-1/b.txt', caption: 42 },
    ]);
    expect(items.map((i) => [i.path, i.caption])).toEqual([
      ['docs/issue-pipeline/plans/qa-1/a.png', ''],
      ['docs/issue-pipeline/plans/qa-1/b.txt', ''],
    ]);
  });

  it('keeps a declared kind over the one the extension implies', () => {
    // Inference only fills a gap; it never overrules the worker.
    const items = parseEvidence([{ kind: 'transcript', path: 'docs/issue-pipeline/plans/qa-1/run.png' }]);
    expect(items[0]!.kind).toBe('transcript');
    expect(items[0]!.isImage).toBe(true); // …and how it RENDERS is still the extension's call
  });

  it('never throws, whatever the worker writes', () => {
    for (const junk of [null, 7, [null], [7], [[]], [{}], ['']]) {
      expect(() => parseEvidence(junk)).not.toThrow();
    }
  });
});

describe('readEvidence — what it refused, and why', () => {
  it('says nothing when it kept everything', () => {
    const { items, dropped } = readEvidence(['docs/issue-pipeline/plans/qa-1/a.png']);
    expect(items).toHaveLength(1);
    expect(dropped).toEqual([]);
    expect(evidenceWarning(dropped)).toBeNull();
  });

  /**
   * THE FENCE IS NOT WEAKENED — it is made audible. `isUnderPlansRoot` refuses
   * exactly what it always refused; the change is that the refusal now leaves
   * with the path attached instead of vanishing into an empty box.
   */
  it('REFUSES a path outside the plans root, loudly, and never returns it as an item', () => {
    const { items, dropped } = readEvidence([
      { kind: 'sql', path: 'docs/issue-pipeline/plans/qa-1/ok.txt', caption: 'c' },
      { kind: 'screenshot', path: 'src/secrets.ts', caption: 'nope' },
      '../../../etc/passwd',
    ]);
    expect(items.map((i) => i.path)).toEqual(['docs/issue-pipeline/plans/qa-1/ok.txt']);
    expect(dropped).toEqual([
      { path: 'src/secrets.ts', reason: `outside ${EVIDENCE_ROOT}/` },
      { path: '../../../etc/passwd', reason: `outside ${EVIDENCE_ROOT}/` },
    ]);
    expect(evidenceWarning(dropped)).toBe(
      `2 evidence entries could not be shown — outside ${EVIDENCE_ROOT}/ (src/secrets.ts); ` +
        `outside ${EVIDENCE_ROOT}/ (../../../etc/passwd)`,
    );
  });

  it('an absolute path is outside the tree, coerced or not', () => {
    const { items, dropped } = readEvidence(['/etc/passwd', { path: '/Users/operator/.ssh/id_rsa', caption: 'x' }]);
    expect(items).toEqual([]);
    expect(dropped.map((d) => d.path)).toEqual(['/etc/passwd', '/Users/operator/.ssh/id_rsa']);
  });

  it('names an entry with no path at all rather than counting it as evidence', () => {
    const { items, dropped } = readEvidence([{ kind: 'sql', caption: 'no path' }, 42, null]);
    expect(items).toEqual([]);
    expect(dropped).toEqual([
      { path: '', reason: 'no path' },
      { path: '', reason: 'no path' },
      { path: '', reason: 'no path' },
    ]);
    expect(evidenceWarning(dropped)).toBe('3 evidence entries could not be shown — no path; no path; no path');
  });

  it('counts one as one — the line is read by a person', () => {
    expect(evidenceWarning([{ path: 'src/x.png', reason: 'outside docs/issue-pipeline/plans/' }])).toBe(
      '1 evidence entry could not be shown — outside docs/issue-pipeline/plans/ (src/x.png)',
    );
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
