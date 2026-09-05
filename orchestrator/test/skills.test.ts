import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REQUIRED_SKILLS, missingSkills, missingSkillsMessage } from '../src/skills.js';

async function skillsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'skills-check-'));
  await mkdir(join(dir, 'skills'), { recursive: true });
  return join(dir, 'skills');
}

async function realSkill(dir: string, name: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
}

describe('the skills the console names by hand', () => {
  it('names the one skill it requires, and nothing else', () => {
    expect([...REQUIRED_SKILLS]).toEqual(['issue-pipeline']);
  });

  it('reports nothing missing when every required skill resolves', async () => {
    const dir = await skillsDir();
    for (const name of REQUIRED_SKILLS) await realSkill(dir, name);
    expect(await missingSkills(dir)).toEqual([]);
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  it('reports a skill that is simply absent', async () => {
    const dir = await skillsDir();
    expect(await missingSkills(dir)).toEqual(['issue-pipeline']);
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  it('follows a symlink, so a linked skill counts as present', async () => {
    const dir = await skillsDir();
    const elsewhere = await mkdtemp(join(tmpdir(), 'skills-src-'));
    await realSkill(elsewhere, 'issue-pipeline');
    await symlink(join(elsewhere, 'issue-pipeline'), join(dir, 'issue-pipeline'));
    expect(await missingSkills(dir)).toEqual([]);
    await rm(elsewhere, { recursive: true, force: true });
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  // The bug this check exists for. Renaming a skill leaves the old symlink
  // pointing at nothing: the directory entry is still listed, so anything that
  // tests for existence alone reports the skill as fine.
  it('counts a DANGLING symlink as missing', async () => {
    const dir = await skillsDir();
    const elsewhere = await mkdtemp(join(tmpdir(), 'skills-src-'));
    await realSkill(elsewhere, 'issue-pipeline');
    await symlink(join(elsewhere, 'issue-pipeline'), join(dir, 'issue-pipeline'));
    await rm(elsewhere, { recursive: true, force: true });
    expect(await missingSkills(dir)).toEqual(['issue-pipeline']);
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  it('counts a skill directory with no SKILL.md as missing', async () => {
    const dir = await skillsDir();
    await mkdir(join(dir, 'issue-pipeline'), { recursive: true });
    expect(await missingSkills(dir)).toEqual(['issue-pipeline']);
    await rm(join(dir, '..'), { recursive: true, force: true });
  });

  it('reports a missing skills directory as every skill missing', async () => {
    expect(await missingSkills(join(tmpdir(), 'no-such-skills-dir-38f1'))).toEqual(['issue-pipeline']);
  });
});

describe('the boot line', () => {
  it('says nothing when nothing is missing', () => {
    expect(missingSkillsMessage([], '/repo/scripts/setup-skills.sh')).toEqual([]);
  });

  it('names every missing skill and the one command that fixes it', () => {
    const lines = missingSkillsMessage(
      ['issue-pipeline'],
      '/repo/scripts/setup-skills.sh',
    ).join('\n');
    expect(lines).toContain('issue-pipeline');
    expect(lines).toContain('/repo/scripts/setup-skills.sh');
    // The consequence, not just the fact — a worker is told to apply it.
    expect(lines).toContain('every worker');
  });

  it('reads correctly for more than one', () => {
    const lines = missingSkillsMessage(
      ['issue-pipeline', 'writing-style'],
      '/repo/scripts/setup-skills.sh',
    ).join('\n');
    expect(lines).toContain('issue-pipeline, writing-style');
    expect(lines).toContain('them');
  });
});

// The skill this console requires now ships in this repo, so the worker
// communication contract is assertable again out of its own prose. These are
// the clauses the console's behaviour depends on: a worker that asks for
// decisions it could make itself parks work for nothing, and a gate question
// that is really three costs the operator a round trip per part.
describe('the worker communication contract', () => {
  it('decides obvious work, keeps technical reasoning in the PR, and asks one real question', async () => {
    const skill = await readFile(join(process.cwd(), '..', 'skills', 'issue-pipeline', 'SKILL.md'), 'utf8');
    const stopFiles = await readFile(
      join(process.cwd(), '..', 'skills', 'issue-pipeline', 'references', 'stop-files.md'),
      'utf8',
    );

    expect(skill).toContain('If the implementation choice is');
    expect(skill).toContain('decide it, implement it,');
    expect(skill).toContain('document it on the PR');
    expect(skill).toContain('exactly one direct `question`');
    expect(skill).toContain('A merge/review decision belongs on the PR');
    expect(skill).toContain('An old hold is evidence, not automatically a live question');
    expect(stopFiles).toContain('No numbered findings, alternatives, review transcript, or technical appendix.');
  });
});
