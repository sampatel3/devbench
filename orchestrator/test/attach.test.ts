/**
 * Handing a worker a screenshot.
 *
 * Evidence only ever travelled one way: a worker wrote files under
 * `docs/issue-pipeline/plans/` and the console served them read-only to the operator
 * (`resolveEvidencePath`). There was no way in. So when QA failed #4847 with two
 * screenshots, the worker could not look at them — it asked the operator to
 * describe what they showed, and stalled at a gate on a question a picture
 * answers instantly. The operator has to be able to hand evidence back the other
 * way, or a gate turns into a game of describing images in prose.
 *
 * This is the naming and fencing half. The write is far more dangerous than the
 * read it mirrors, so it is stricter: a generated name, one fixed directory, an
 * extension allowlist, and a size cap.
 */
import { describe, it, expect } from 'vitest';
import { attachmentName, resolveAttachmentTarget, ATTACH_DIR, MAX_ATTACH_BYTES } from '../src/attach.js';

const WT = '/tmp/wt-4847';

describe('the filename is generated, never taken from the client', () => {
  it('keeps a readable stem and the extension, and stamps it', () => {
    const n = attachmentName('security-details page 5.PNG', new Date('2026-08-20T09:15:00Z'));
    expect(n).toMatch(/^20260820-0915-security-details-page-5\.png$/);
  });

  /** Traversal, separators and NUL cannot survive into the stored name. */
  it('strips anything that could climb out of the directory', () => {
    for (const bad of ['../../etc/passwd.png', 'a/b/c.png', '..\\win.png', 'x\0y.png']) {
      const n = attachmentName(bad, new Date('2026-08-20T09:15:00Z'));
      expect(n).not.toMatch(/[/\\]/);
      expect(n).not.toContain('..');
      expect(n).not.toContain('\0');
    }
  });

  it('falls back to a generic stem rather than an empty name', () => {
    expect(attachmentName('.png', new Date('2026-08-20T09:15:00Z'))).toBe('20260820-0915-attachment.png');
    expect(attachmentName('', new Date('2026-08-20T09:15:00Z'))).toBe('20260820-0915-attachment.bin');
  });
});

describe('what may be written, and where', () => {
  it('accepts the image types a screenshot actually arrives as', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf']) {
      expect(resolveAttachmentTarget(WT, `shot.${ext}`, 1000).ok).toBe(true);
    }
  });

  /** An allowlist, not a denylist: anything executable or scripted is refused
   *  by virtue of not being named, which is the safe direction. */
  it('refuses everything else, including things that merely look like images', () => {
    for (const bad of ['shot.svg', 'shot.html', 'shot.sh', 'shot.js', 'shot.png.sh', 'shot']) {
      const out = resolveAttachmentTarget(WT, bad, 1000);
      expect(out.ok).toBe(false);
      expect(out.reason).toMatch(/type/i);
    }
  });

  it('lands in one fixed directory inside the worktree, and nowhere else', () => {
    const out = resolveAttachmentTarget(WT, 'shot.png', 1000);
    expect(out.ok).toBe(true);
    expect(out.absPath!.startsWith(`${WT}/${ATTACH_DIR}/`)).toBe(true);
    expect(out.repoRelative!.startsWith(`${ATTACH_DIR}/`)).toBe(true);
  });

  it('refuses without a worktree rather than writing somewhere arbitrary', () => {
    expect(resolveAttachmentTarget(null, 'shot.png', 1000).ok).toBe(false);
  });

  it('caps the size, so a paste cannot fill the disk', () => {
    expect(resolveAttachmentTarget(WT, 'shot.png', MAX_ATTACH_BYTES).ok).toBe(true);
    const over = resolveAttachmentTarget(WT, 'shot.png', MAX_ATTACH_BYTES + 1);
    expect(over.ok).toBe(false);
    expect(over.reason).toMatch(/too large/i);
  });

  it('refuses an empty file, which is always a failed upload', () => {
    expect(resolveAttachmentTarget(WT, 'shot.png', 0).ok).toBe(false);
  });
});
