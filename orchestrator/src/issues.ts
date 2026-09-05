import { execFile } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spinOffBody, type IssueRequest } from './drafts.js';

export { spinOffBody } from './drafts.js';

/**
 * Filing a spin-off issue, on the operator's click. The console's SECOND GitHub
 * write.
 *
 * The operator asked why the console could not file the issue itself, and pointed
 * out that whatever files it can also link it back to the parent in the same act.
 *
 * There IS a reason the WORKER may not, and it is specific rather than a general
 * distrust: a repo whose autoassign workflow stamps the filer as assignee and
 * moves the card straight to `Ready` never lets a worker-filed issue reach
 * triage. It silently becomes the operator's assigned work looking exactly like
 * something the team asked for. #4562 arrived that way, against an explicit
 * instruction, and was found days later.
 *
 * But that consequence is IDENTICAL whether the console files it or the operator
 * presses Submit on GitHub's prefilled form — it is their account either way. So
 * the fence was never buying protection from the automation. It was buying a
 * human DECISION about whether the issue should exist at all, and a click here
 * preserves that exactly: nothing files itself, ever.
 *
 * What the prefilled URL could never do is the second half of that ask. A browser
 * form hands the new number to GitHub and to nobody else, so the console never
 * learns it and parent and child stay unlinked. Filing here, the console holds
 * both numbers at the same moment.
 *
 * The fence is kept narrow the same way `comment.ts` keeps its own: this module
 * can do exactly `gh issue create` and there is deliberately no general
 * `gh(args)` write helper. Close, edit, label, assign, delete, merge have no
 * path to a process from here.
 */

export type GhWriteExec = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Throws unless the first two argv tokens are exactly `issue create`. */
export function assertIssueCreateOnly(args: string[]): void {
  if (args[0] !== 'issue' || args[1] !== 'create') {
    const shown = args.slice(0, 2).join(' ') || '(nothing)';
    throw new Error(
      `refusing: the console may only FILE an issue, not \`gh ${shown}\`. Creating is the only issue write it can do.`,
    );
  }
}

const realGhExec: GhWriteExec = (args) =>
  new Promise((resolve) => {
    execFile('gh', args, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? ((err as { code?: number }).code ?? 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });

/** `gh issue create` prints the new issue's URL. The number is the last segment. */
function numberFrom(stdout: string): number | null {
  const url = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  const m = url.match(/\/issues\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export async function createIssue(
  repo: string,
  r: IssueRequest,
  opts?: { exec?: GhWriteExec; tmpDir?: string },
): Promise<{ ok: boolean; number?: number; url?: string; error?: string }> {
  const title = r.title.trim();
  if (!title) return { ok: false, error: 'refusing to file an issue with no title' };

  const exec = opts?.exec ?? realGhExec;
  const dir = opts?.tmpDir ?? tmpdir();
  const bodyFile = join(dir, `wc-issue-${randomUUID()}.md`);

  // The subcommand is hardcoded; nothing the caller passes can change it. The
  // body goes by FILE — it is long, multi-line and full of backticks and quotes,
  // which on an argv is a quoting accident waiting to happen.
  const args = ['issue', 'create', '--repo', repo, '--title', title, '--body-file', bodyFile];
  if (r.labels.length) args.push('--label', r.labels.join(','));

  assertIssueCreateOnly(args);
  await writeFile(bodyFile, spinOffBody(r), 'utf8');

  try {
    const { code, stdout, stderr } = await exec(args);
    if (code !== 0) return { ok: false, error: stderr.trim() || `gh exited with code ${code}` };
    const number = numberFrom(stdout);
    // The one thing that must never be guessed: it is what the parent gets
    // linked to, and a wrong number links the wrong ticket.
    if (number === null) {
      return { ok: false, error: `could not read the new issue number from gh: ${stdout.trim().slice(0, 120)}` };
    }
    return { ok: true, number, url: stdout.trim().split('\n').filter(Boolean).pop() };
  } finally {
    await unlink(bodyFile).catch(() => {});
  }
}
