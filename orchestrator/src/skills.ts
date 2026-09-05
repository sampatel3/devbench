import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The skills `SKILLS_RULE` names by hand.
 *
 * A rule that names a skill the machine does not have is worse than no rule:
 * the worker is told to apply something that is not there, and the only symptom
 * is prose that quietly stops following the guide — in every gate card, with
 * nobody looking. So the console checks at boot instead.
 *
 * ADVISORY, NEVER A REFUSAL. A missing writing skill is not a reason to be
 * unable to work a ticket, and a fresh clone has to start before anyone has
 * anything to install it with. The check prints and the console carries on.
 *
 * The skill cannot live in this repo's own `.claude/skills`. Workers run with
 * `cwd` set to a worktree of the repo being worked (`worker.ts`), so a
 * project-scoped skill here would be invisible to every one of them. It has to
 * be reachable from the account config dir instead, which is what
 * `scripts/setup-skills.sh` arranges.
 */
export const REQUIRED_SKILLS = ['issue-pipeline'] as const;

/**
 * Which of `required` do not resolve under `skillsDir`.
 *
 * Present means `<skillsDir>/<name>/SKILL.md` opens. That deliberately follows
 * symlinks, because every one of these arrives as a symlink and a DANGLING one
 * is the failure this exists to catch: the directory entry is still listed, so
 * a check for existence alone reports the skill as fine. Renaming a skill in
 * its source repo is all it takes.
 */
export async function missingSkills(
  skillsDir: string,
  required: readonly string[] = REQUIRED_SKILLS,
): Promise<string[]> {
  const checked = await Promise.all(
    required.map(async (name) => {
      try {
        await readFile(join(skillsDir, name, 'SKILL.md'), 'utf8');
        return null;
      } catch {
        return name;
      }
    }),
  );
  return checked.filter((name): name is string => name !== null);
}

/**
 * The boot lines: what is missing, what it costs, and the one command that fixes
 * it. Empty when nothing is missing, so the caller loops over it and prints
 * nothing on a healthy machine.
 *
 * A WARNING, and worded as one. It says the console still starts, because a
 * line that reads like a refusal on a fresh clone sends people looking for a
 * failure that has not happened.
 */
export function missingSkillsMessage(
  missing: readonly string[],
  setupScript: string,
): string[] {
  if (missing.length === 0) return [];
  const it = missing.length === 1 ? 'it' : 'them';
  return [
    `  SKILLS MISSING  ${missing.join(', ')} — every worker is told to apply ${it} and will not find ${it}`,
    `                  the console still starts; gate prose just stops following the guide`,
    `                  fix: ${setupScript}`,
  ];
}
