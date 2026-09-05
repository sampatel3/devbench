import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// @ts-expect-error - a dependency-free .mjs hook, deliberately outside tsconfig's rootDir
import { decide } from '../hooks/write-fence.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'write-fence.mjs');

type Verdict = { allow: boolean; reason?: string };
const judge = (cmd: string): Verdict => decide(cmd) as Verdict;

const allows = (cmd: string) => expect(judge(cmd), `expected ALLOW: ${cmd}`).toMatchObject({ allow: true });
const denies = (cmd: string) => expect(judge(cmd), `expected DENY: ${cmd}`).toMatchObject({ allow: false });

/** Run the hook the way Claude Code runs it: JSON on stdin, verdict on stdout. */
function runHook(input: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile('node', [HOOK], { timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin!.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

// ---------------------------------------------------------------- the core pair

describe('the write fence', () => {
  it('DENIES the write that actually happened — gh issue create', () => {
    denies('gh issue create --title "Fix the thing" --body "details" --label bug --label area:rating');
  });

  it('ALLOWS the sanctioned PR open — gh pr create --base dev', () => {
    allows('gh pr create --base dev --title "fix: the thing" --body-file .pr-body.md --draft');
  });
});

// ------------------------------------------------------------- the four allowed

describe('the allowlist — a worker may raise its own PR', () => {
  it('allows gh pr create --base dev', () => {
    allows('gh pr create --base dev --title x --body y');
  });

  it('denies gh pr create against any base but dev', () => {
    denies('gh pr create --base main --title x --body y');
    denies('gh pr create --title x --body y'); // no --base at all: gh would default to the repo default branch
  });

  it('denies gh pr create --repo elsewhere, which leaves the worker its own branch', () => {
    denies('gh pr create --base dev --repo example-org/other-repo --title x --body y');
  });

  it('allows removing changes-requested from its OWN pr (no number = current branch)', () => {
    allows('gh pr edit --remove-label changes-requested');
  });

  it('denies removing changes-requested from a NAMED pr', () => {
    denies('gh pr edit 4446 --remove-label changes-requested');
  });

  it('denies removing any other label, and denies adding one', () => {
    denies('gh pr edit --remove-label needs-triage');
    denies('gh pr edit --add-label ready');
    // One bad flag poisons the whole call, even alongside sanctioned ones.
    denies('gh pr edit --title "new title" --add-label P0');
  });

  it('allows the worker to write its OWN pr body — Stage 7 requires it', () => {
    // The round archive belongs in the body, so a fence that denies this makes
    // the skill impossible to follow and pushes the paste onto the operator.
    allows('gh pr edit --body-file .pr-body.md');
    allows('gh pr edit --title "fix(quote): stop the duplicate send"');
    allows('gh pr edit --remove-label changes-requested --title "new title"');
  });

  it('allows one @claude re-review comment on its OWN pr', () => {
    allows('gh pr comment --body "@claude re-review please, round 2 fixes pushed"');
  });

  it('denies a pr comment that is not an @claude re-review', () => {
    denies('gh pr comment --body "looks good to me"');
  });

  it('denies a pr comment on a NAMED pr, even an @claude one', () => {
    denies('gh pr comment 4446 --body "@claude re-review"');
    denies('gh pr comment https://github.com/example-org/example-repo/pull/4446 --body "@claude re-review"');
  });

  it('denies a pr comment whose body it cannot read', () => {
    denies('gh pr comment --body-file .review.md');
  });

  it('allows git push of its own branch', () => {
    allows('git push -u origin HEAD');
    allows('git push origin issue-4329-stale-version-detection');
    allows('git push');
  });

  it('denies a force push, a delete push, and a push at dev or main', () => {
    denies('git push --force');
    denies('git push -f origin HEAD');
    denies('git push --force-with-lease origin HEAD');
    denies('git push origin --delete issue-4329');
    denies('git push origin HEAD:dev');
    denies('git push origin main');
    denies('git push --tags');
  });
});

// ------------------------------------------------------------- everything else

describe('the denylist — every write that is the operator’s click', () => {
  it('denies issue writes of every shape', () => {
    denies('gh issue create --title x --body y');
    denies('gh issue comment 4336 --body "done"');
    denies('gh issue close 4336');
    denies('gh issue edit 4336 --add-label bug');
    denies('gh issue reopen 4336');
    denies('gh issue transfer 4336 example-org/other-repo');
    denies('gh issue pin 4336');
    denies('gh issue develop 4336');
  });

  it('denies pr writes that end a review or a pr', () => {
    denies('gh pr merge --squash');
    denies('gh pr close');
    denies('gh pr review --approve');
    denies('gh pr review --comment --body "@claude re-review"');
    denies('gh pr ready');
    denies('gh pr lock');
  });

  it('denies board moves', () => {
    denies('gh project item-add 12 --owner example-org --url https://github.com/example-org/example-repo/issues/4336');
    denies('gh project item-edit --id X --field-id Y --project-id Z --single-select-option-id Q');
  });

  it('denies release, repo, label and workflow writes', () => {
    denies('gh release create v1.2.3');
    denies('gh repo edit --default-branch main');
    denies('gh label create shiny --color ff0000');
    denies('gh workflow run deploy.yml');
    denies('gh run cancel 123');
    denies('gh secret set FOO --body bar');
  });

  it('denies auth and alias subcommands outright', () => {
    denies('gh auth login');
    denies('gh auth switch --user operator');
    denies('gh alias set ic "issue create"');
  });

  it('denies an unknown gh subcommand rather than guessing — it fails CLOSED', () => {
    denies('gh frobnicate --wibble');
    denies('gh pr frobnicate');
  });
});

// ------------------------------------------------------------------ still reads

describe('reads stay free — the fence must not cost a round trip', () => {
  it('allows every gh read a worker actually uses', () => {
    allows('gh issue view 4336 --json title,body,labels');
    allows('gh issue list --assignee @me');
    allows('gh pr view --json baseRefName,url,number');
    allows('gh pr checks');
    allows('gh pr diff');
    allows('gh pr list --state open');
    allows('gh run list --limit 5');
    allows('gh run view 123 --log-failed');
    allows('gh api /repos/example-org/example-repo/pulls/4446');
    allows('gh api -X GET /repos/example-org/example-repo/issues/4336/labels');
    allows('gh search issues "stale version"');
    allows('gh project item-list 12 --owner example-org');
    allows('gh label list');
    allows('gh repo view --json defaultBranchRef');
    allows('gh pr checkout 4446');
  });

  it('allows the ordinary non-github commands the matcher also routes here', () => {
    allows('npm test');
    allows('ls -la');
    allows('git status');
    allows('git commit -m "fix: the thing"');
    allows('git log --oneline -20');
    allows('npx tsc --noEmit');
    allows('docker ps');
    allows('cd /Users/operator/Code/example-org/example-repo && npm run build');
    allows('echo "gh issue create is how you would file one" > notes.txt');
  });
});

// ----------------------------------------------------------------- the bypasses

describe('bypass attempts', () => {
  it('cannot be bypassed by cd-ing first', () => {
    denies('cd /Users/operator/Code/example-org/example-repo && gh issue create --title x --body y');
    denies('cd /tmp; gh issue create --title x --body y');
  });

  it('cannot be bypassed by an env-var prefix', () => {
    denies('GH_TOKEN=abc gh issue create --title x --body y');
    denies('ISSUE_LABEL_OVERRIDE=1 gh issue create --title x --body y --label bug');
    denies('env GH_HOST=github.com gh issue create --title x --body y');
  });

  it('cannot be bypassed by gh api with a mutating method', () => {
    denies('gh api -X POST /repos/example-org/example-repo/issues -f title=x -f body=y');
    denies('gh api --method POST /repos/example-org/example-repo/issues -f title=x');
    denies('gh api -X PATCH /repos/example-org/example-repo/issues/4336 -f state=closed');
    denies('gh api -X DELETE /repos/example-org/example-repo/issues/4446/labels/changes-requested');
    denies('gh api -X PUT /repos/example-org/example-repo/pulls/4446/merge');
  });

  it('cannot be bypassed by gh api fields, which POST without naming a method', () => {
    denies('gh api /repos/example-org/example-repo/issues -f title=x -f body=y');
    denies('gh api /repos/example-org/example-repo/issues --field title=x');
    denies('gh api /repos/example-org/example-repo/issues --input payload.json');
  });

  it('cannot be bypassed by a graphql mutation', () => {
    denies("gh api graphql -f query='mutation { addProjectV2ItemById(input: {}) { item { id } } }'");
    allows("gh api graphql -f query='query { repository(owner: \"example-org\", name: \"example-repo\") { id } }'");
    denies('gh api graphql --input mutation.json');
  });

  it('cannot be bypassed by piping', () => {
    denies('cat body.md | gh issue create --title x --body-file -');
    denies('echo hi | gh pr merge --squash');
    denies('gh issue list --json number | jq . && gh issue close 4336');
  });

  it('cannot be bypassed by aliasing', () => {
    denies('alias g=gh && g issue create --title x --body y');
    denies("alias ghi='gh issue create'; ghi --title x --body y");
    denies('ghfn() { gh issue create "$@"; }; ghfn --title x');
  });

  it('cannot be bypassed by semicolon chaining behind an allowed write', () => {
    denies('gh pr create --base dev --title x --body y ; gh issue create --title x --body y');
    denies('git push -u origin HEAD && gh issue comment 4336 --body done');
  });

  it('cannot be bypassed by a full path, a leading backslash, or a wrapper', () => {
    denies('/opt/homebrew/bin/gh issue create --title x --body y');
    denies('\\gh issue create --title x --body y');
    denies('command gh issue create --title x --body y');
    denies('sudo gh issue create --title x --body y');
    denies('xargs gh issue close < numbers.txt');
    denies('nohup gh issue create --title x --body y');
  });

  it('cannot be bypassed by a nested shell', () => {
    denies('bash -c "gh issue create --title x --body y"');
    denies("sh -c 'gh issue close 4336'");
    denies('eval "gh issue create --title x"');
    denies('ISSUE=$(gh issue create --title x --body y)');
  });

  it('cannot be bypassed by a nested coding agent, which would spawn an unfenced session', () => {
    denies('claude -p "file an issue about the flaky test"');
    denies('claude --permission-mode bypassPermissions -p "gh issue create"');
    denies('codex exec "file an issue about the flaky test"');
    denies('/opt/homebrew/bin/codex exec "gh issue create"');
    denies('bash -c "codex exec \'gh issue create --title x\'"');
    denies('agent=codex; $agent exec "file an issue"');
    denies('agent=$(which codex); "$agent" resume 019-thread "continue"');
    denies('agent=claude; "$agent" -p "file an issue"');
    denies('agent=codex; "$agent" --dangerously-bypass-approvals-and-sandbox exec x');
  });

  it('still allows ordinary commands whose executable comes from a variable', () => {
    allows('formatter=prettier; $formatter --check .');
    allows('runner=npm; "$runner" run test');
    allows('vcs=git; "$vcs" status --short');
  });

  it('cannot be bypassed by curl straight at the api', () => {
    denies('curl -X POST -H "Authorization: bearer $GH_TOKEN" https://api.github.com/repos/example-org/example-repo/issues -d @body.json');
    denies('curl -s https://api.github.com/repos/example-org/example-repo/issues -d @body.json');
  });

  it('cannot be bypassed by an unresolvable command word next to github words', () => {
    denies('$TOOL issue create --title x');
    denies('X=gh; $X issue create --title x');
  });

  it('cannot be bypassed by a quoted argument that hides the real one', () => {
    // A --title that MENTIONS an allowed command must not launder a denied one.
    denies('gh issue create --title "gh pr create --base dev" --body y');
    // ...and prose about a denied command must not deny an allowed one.
    allows('gh pr create --base dev --title "stop calling gh issue create" --body y');
  });
});

// ------------------------------------------------------------- the wire contract

describe('the hook process contract', () => {
  it('emits a PreToolUse deny decision on stdout at exit 0', async () => {
    const r = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh issue create --title x --body y' },
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/WRITE FENCE/);
  });

  it('accepts the exact Codex PreToolUse/Bash payload and denies a nested Codex', async () => {
    const r = await runHook({
      hook_event_name: 'PreToolUse',
      session_id: '01992de1-7f62-7cc0-9719-d3a37015234b',
      turn_id: '01992de1-8329-7552-a259-af971d19f5b7',
      tool_name: 'Bash',
      tool_input: { command: 'codex exec "escape this fenced worker"' },
      cwd: '/workspace',
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringMatching(/nested `codex`.*fence is not installed/s),
      },
    });
  });

  it('denies a nested agent hidden behind an expanded command word on the wire', async () => {
    const r = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'agent=$(which codex); "$agent" exec "escape this fenced worker"' },
      cwd: '/workspace',
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringMatching(/cannot be resolved.*nested coding-agent/s),
    });
  });

  it('says nothing at all for an allowed command', async () => {
    const r = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --base dev --title x --body y' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('ignores tools that are not Bash', async () => {
    const r = await runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('FAILS CLOSED on unparseable input rather than waving it through', async () => {
    const r = await runHook('{not json at all');
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('tells the worker what to do instead — the reason is the only channel it has', () => {
    const v = judge('gh issue create --title x --body y');
    expect(v.allow).toBe(false);
    expect(v.reason).toMatch(/\.issue-request\.json/);
    expect(v.reason).toMatch(/stop/i);
  });

  it('points a board move at its own drafted artefact', () => {
    const v = judge('gh project item-edit --id X --field-id Y --project-id Z --single-select-option-id Q');
    expect(v.reason).toMatch(/\.board-request\.json/);
  });

  it('points an issue comment at the artefact that already exists', () => {
    const v = judge('gh issue comment 4336 --body "done"');
    expect(v.reason).toMatch(/\.comment-request\.json/);
  });
});

// ---------------------------------------------------------- the second attack
//
// Everything below was found by attacking the fence AFTER it was built, driving
// the hook as a real process rather than reasoning about the parser. Each of
// these got a write through, or blocked one that is allowed. They are grouped
// by how the write was laundered, and every one of them is a regression test
// for a hole that was open on this machine.

describe('a program the fence cannot read is refused, not run', () => {
  it('denies piping a command INTO a shell — echo … | bash got through', () => {
    denies("echo 'gh issue create -t x -b y' | bash");
    denies("printf '%s' 'gh issue create -t x' | sh");
    denies("echo 'gh issue create' | bash -s");
    denies('echo Z2ggaXNzdWUgY3JlYXRl | base64 -d | bash');
  });

  it('denies a herestring and a process substitution, which are stdin by another name', () => {
    denies("bash <<< 'gh issue create -t x -b y'");
    denies("bash <(printf 'gh issue create -t x')");
  });

  it('judges a heredoc body when the heredoc IS the program', () => {
    denies("bash <<'EOF'\ngh issue create -t x -b y\nEOF");
    denies("node <<'EOF'\nrequire('child_process').execSync('gh issue create')\nEOF");
  });

  it('denies a shell program that comes from a variable', () => {
    denies(`CMD='gh issue create -t x'; bash -c "$CMD"`);
    denies(`CODE='execSync("gh issue create")'; node -e "$CODE"`);
  });

  it('denies eval of another command output — there is no text to judge', () => {
    denies(`eval "$(cat <<'EOF'\ngh issue create -t x\nEOF\n)"`);
  });

  it('reads a -c that arrived combined, as `bash -lc`', () => {
    denies("bash -lc 'gh issue create -t x -b y'");
  });
});

describe('a script FILE is read, not assumed innocent', () => {
  let dir: string;
  let script: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-script-'));
    script = join(dir, 'run.sh');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('denies a write laundered through a script file', () => {
    writeFileSync(script, '#!/bin/bash\ngh issue create -t smuggled -b via-a-file\n');
    denies(`bash ${script}`);
    denies(`zsh ${script}`);
    denies(`source ${script}`);
    denies(`${script}`);
  });

  it('follows the shell into a directory it cd-ed to first', () => {
    writeFileSync(script, 'gh issue create -t x -b y\n');
    denies(`cd ${dir} && bash run.sh`);
    denies(`cd ${dir} && ./run.sh`);
    denies(`bash -c 'cd ${dir} && bash run.sh'`);
  });

  it('refuses a script it could not read — including one written in the same call', () => {
    // The hook runs BEFORE the command, so the file does not exist yet.
    denies(`printf 'gh issue create' > ${script} && bash ${script}`);
  });

  it('still allows a script that only reads', () => {
    writeFileSync(script, '#!/bin/bash\ngh pr checks --watch\ngit status\n');
    allows(`bash ${script}`);
    allows(`${script}`);
  });

  it('resolves a relative script against the tool call cwd it was given', () => {
    writeFileSync(script, 'gh issue create -t x\n');
    expect(decide('bash run.sh', { cwd: dir }) as Verdict).toMatchObject({ allow: false });
  });
});

describe('a command carried inside another command', () => {
  it('denies xargs, which builds its command line out of unreadable stdin', () => {
    denies("echo 'issue create -t x' | xargs gh");
    denies('echo x | xargs -I{} gh issue create -t {} -b y');
    denies('xargs -a args.txt gh issue create -t x');
    denies("echo 'gh issue create' | xargs bash -c");
  });

  it('denies a carrier that hands the write to something else', () => {
    denies('ssh box gh issue create -t x -b y');
    denies('ssh box "gh issue create -t x"');
    denies('ssh box git push origin HEAD:dev');
    denies('find . -name x -exec gh issue create -t x -b y ;');
    denies('watch -n 5 gh issue create -t x');
    denies('parallel gh issue create -t {} ::: a b');
    denies('docker run --rm img gh issue create -t x');
    denies("tmux new-session -d 'gh issue create -t x'");
    denies("screen -dm bash -c 'gh issue create -t x'");
    denies("npx claude -p 'file the issue' --permission-mode bypassPermissions");
    denies("npx codex exec 'file the issue'");
    denies("npx @openai/codex exec 'file the issue'");
    denies("npm exec -- codex exec 'file the issue'");
    denies("pnpm exec codex exec 'file the issue'");
    denies("yarn dlx @openai/codex exec 'file the issue'");
    denies("corepack pnpm exec codex exec 'file the issue'");
    denies("ssh box codex exec 'file the issue'");
    denies("echo exec | xargs codex");
  });

  it('does not mistake the LETTERS gh for a command', () => {
    allows("find . -name '*.ts' -exec grep -l gh {} ;");
    allows('grep -rn gh src/ | head -20');
    allows('which gh && gh --version');
    allows('git diff --name-only | xargs git add');
    allows('xargs -a files.txt rm -f');
  });

  it('denies an interpreter program that shells out to gh', () => {
    denies(`node -e 'require("child_process").execSync("gh issue create -t x")'`);
    denies(`python3 -c 'import os; os.system("gh issue create -t x")'`);
    denies(`node -e 'require("child_process").execSync("codex exec x")'`);
    denies(`node -e 'require("child_process").spawn("codex", ["exec", "x"])'`);
    denies(`python3 -c 'import os; os.system("codex exec x")'`);
    denies(`python3 -c 'import subprocess; subprocess.run(["codex", "exec", "x"])'`);
    denies(`node -e 'fetch("https://api.github.com/repos/x/y/issues",{method:"POST"})'`);
    allows(`node -e 'console.log(1+1)'`);
    allows(`node -e 'console.log("codex")'`);
    allows(`cat pkg.json | python3 -c 'import sys,json; print(json.load(sys.stdin))'`);
  });
});

describe('the write under another name', () => {
  it('denies a gh command line whatever the binary is called', () => {
    denies('cp $(which gh) /tmp/zz && /tmp/zz issue create -t x -b y');
    denies('mytool issue create -t x -b y');
    denies('/tmp/zz pr merge 4562 --squash');
  });

  it('denies an expansion spliced into the command name', () => {
    denies('gh${IFS}issue${IFS}create${IFS}-t${IFS}x');
  });

  it('denies a git alias, which is aliasing with extra steps', () => {
    denies(`git config alias.file '!gh issue create' && git file -t x`);
    denies(`git -c alias.f='!gh issue create -t x' f`);
    allows('git config user.email');
  });

  it('denies scheduling the write for later, when nothing is watching', () => {
    denies("echo 'gh issue create -t x' | at now + 1 minute");
    denies("echo '* * * * * gh issue create' | crontab -");
  });

  it('leaves a command that merely starts with a gh-shaped word alone', () => {
    allows('npm run build');
    allows('mytool pr view 1');
    allows('npx vitest run --pool=forks');
  });
});

describe('the allowlist still works — a fence that blocks the workflow is worse than none', () => {
  it('allows gh pr create with the SHORT base flag', () => {
    // `-B` is gh's own short form. Missing it denied the sanctioned PR open.
    allows("gh pr create -B dev --title 'fix: x' --body y");
    allows('gh pr create --base=dev --fill');
  });

  it('allows an allowed write with its output redirected', () => {
    // `2>&1` used to leave a bare `1` that read as someone else's PR number.
    allows("gh pr comment --body '@claude re-review please' > /tmp/out.log 2>&1");
    allows('git push -u origin HEAD 2>&1 | tail -5');
    allows('gh pr edit --remove-label changes-requested 2>&1');
  });

  it('leaves a DRAFTED artefact alone — that is the path a denial sends them down', () => {
    allows(
      'cat > .issue-request.json <<\'EOF\'\n{"title":"x","why":"denied `gh issue create`, drafted instead"}\nEOF',
    );
    allows('cat > .pr-body.md <<\'EOF\'\nRun `gh pr checks` for CI.\nEOF');
  });

  it('still judges what an UNQUOTED heredoc would actually expand', () => {
    // `<<EOF` (no quotes) runs `$( … )` inside the body; `<<'EOF'` does not.
    denies('cat > x.md <<EOF\n$(gh issue create -t x -b y)\nEOF');
    allows("cat > x.md <<'EOF'\n$(gh issue create -t x -b y)\nEOF");
    allows('cat > x.md <<EOF\nversion $(node -p 1)\nEOF');
  });
});

describe('a denial has to say the right thing, or it costs a round trip', () => {
  it('tells a worker whose comment body it cannot READ that the comment itself is fine', () => {
    // Denying this is right — the fence cannot see the `@claude` it must start
    // with. Denying it AS AN ISSUE COMMENT is not: the worker drafts a
    // `.comment-request.json` and stops, and the operator gets asked for a write Stage 7
    // already sanctions.
    const v = judge('gh pr comment --body "$(cat .msg.md)"');
    expect(v.allow).toBe(false);
    expect(v.reason).not.toMatch(/ISSUE/);
    expect(v.reason).toMatch(/allowed on your own PR/);
    expect(v.reason).toMatch(/inline/);
  });

  it('still denies, by name, a comment on an ISSUE', () => {
    expect(judge('gh issue comment 4562 --body "done"').reason).toMatch(/\.comment-request\.json/);
  });
});
