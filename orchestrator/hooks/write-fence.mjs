#!/usr/bin/env node
/**
 * THE WRITE FENCE — a PreToolUse hook that makes the skill's rule real.
 *
 * A worker once filed a GitHub issue on its own. The skill said, in capitals,
 * not to. Its own resume prompt said it again. The worker ran `gh issue create`
 * anyway, under the operator's account, so nothing on GitHub distinguished that
 * issue from one the operator chose to file.
 *
 * The diagnosis: we had been writing RULES where we needed ENFORCEMENT. A
 * stronger sentence would not have stopped it. This does, because a PreToolUse
 * `deny` is the one thing that outranks `--permission-mode bypassPermissions`
 * (the binary says so itself: "canUseTool will not be invoked … To gate every
 * tool call, use a PreToolUse hook instead"). Verified on this machine: with
 * this hook installed, a denied `touch` left no file behind.
 *
 * WHAT MAY BE WRITTEN — four things, every one of them scoped to the worker's
 * OWN pull request, and every one of them part of raising it:
 *   1. `gh pr create --base dev`      (no --repo; any other base is someone else's PR)
 *   2. `gh pr edit --remove-label changes-requested`   (no PR number = current branch)
 *   3. `gh pr comment --body "@claude …"`              (no PR number = current branch)
 *   4. `git push` of its own branch   (no force, no delete, not at a protected branch)
 * Everything else is the operator's click.
 *
 * TWO DESIGN RULES, both learned the hard way:
 *
 * - IT FAILS CLOSED. The reference gate already on disk in the worked repo
 *   (`.claude/hooks/issue-label-gate.sh`) says "anything we cannot
 *   determine -> exit 0 (allow), never interfere on infrastructure trouble".
 *   That is right for a linter and wrong for a fence. Here, an unknown `gh`
 *   subcommand, an unreadable argument, an unresolvable command word next to
 *   GitHub words, and an internal crash all DENY.
 *
 * - THE REASON IS THE ONLY CHANNEL. `permissionDecisionReason` reaches the model
 *   verbatim, wrapped in nothing, as `is_error: true`. A worker that is only
 *   told "no" retries variants. So every denial names the artefact to draft
 *   instead and says to stop.
 *
 * - A PROGRAM IT CANNOT READ IS REFUSED, NOT RUN. This is the rule the first
 *   version was missing, and a second pass of attacks — driving the hook as a
 *   real process — got a write past it eleven different ways: `echo '…' | bash`,
 *   `bash <<< '…'`, `bash /tmp/x.sh`, `./x.sh` after a `cd`, `bash -c "$CMD"`,
 *   `eval "$(…)"`, `node -e '…execSync("gh …")'`, `xargs gh`, `ssh box gh …`,
 *   `cp $(which gh) /tmp/zz && /tmp/zz issue create`, and `gh${IFS}issue`. So
 *   this fence reads script FILES off disk (following any `cd` on the way),
 *   judges heredoc and herestring bodies that are programs, refuses a program
 *   that arrives on stdin or out of a variable, and judges a gh-shaped command
 *   line whatever the binary in front of it is called.
 *
 * Dependency-free ESM on purpose: it is spawned per Bash call and must not need
 * a build step, a node_modules, or anything this repo compiles.
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// ---------------------------------------------------------------- the reasons

const ALLOWED =
  'The only GitHub writes on the allowlist are, all on YOUR OWN PR: `gh pr create --base dev`; ' +
  '`gh pr edit --remove-label changes-requested`; one `gh pr comment --body "@claude …"`; ' +
  'and `git push` of your own branch.';

const denyIssue = (what) => ({
  allow: false,
  reason:
    `WRITE FENCE: ${what} is the operator's click, not yours. Draft the issue to \`.issue-request.json\` ` +
    '(title, body, labels, board lane, links both ways) and STOP — the console shows it to the operator ' +
    'and they file it in one click. Do not try another spelling of this command.',
});

const denyComment = () => ({
  allow: false,
  reason:
    "WRITE FENCE: commenting on an ISSUE is the operator's click, not yours. Draft it to " +
    '`.comment-request.json` and STOP — the console posts it, as you wrote it, when they click. ' +
    'An `@claude` comment on YOUR OWN PR is allowed; a comment on an issue never is.',
});

const denyBoard = () => ({
  allow: false,
  reason:
    "WRITE FENCE: moving a board card is the operator's click, not yours. Draft it to " +
    '`.board-request.json` (issue number, lane you want, why) and STOP — one click moves it.',
});

const deny = (reason) => ({ allow: false, reason: `WRITE FENCE: ${reason} ${ALLOWED}` });
const ALLOW = { allow: true };

// ------------------------------------------------------------------ the words

const WRAPPERS = new Set([
  'env', 'command', 'builtin', 'exec', 'sudo', 'doas', 'nohup', 'time',
  'nice', 'ionice', 'stdbuf', 'setsid', 'caffeinate', 'timeout', 'gtimeout', 'script',
]);
/** Wrappers whose first bare argument is a duration or a niceness, not the command. */
const WRAPPERS_WITH_OPERAND = new Set(['timeout', 'gtimeout', 'nice', 'ionice']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'eval', 'source', '.']);
const CURLS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh']);
/** Starting another coding agent escapes this process's hook configuration. */
const AGENT_CLIS = new Set(['claude', 'codex']);
/** An expanded command word has lost its executable name by the time this hook
 * sees it. Refuse only argv shapes that are distinctive coding-agent entry
 * points or controls; ordinary `$FORMATTER --check .` remains usable. */
const AGENT_ARG_WORDS = new Set(['exec', 'resume']);
const AGENT_ARG_FLAGS = new Set([
  '-p', '--resume', '--permission-mode', '--allowedTools', '--disallowedTools',
  '--session-id', '--output-format', '--settings',
  '--ask-for-approval', '--sandbox', '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust', '--profile', '--config',
]);

/** A `gh` subcommand group that is a write surface end to end. */
const DENIED_GROUPS = new Set([
  'auth', 'alias', 'secret', 'variable', 'config', 'ssh-key', 'gpg-key',
  'extension', 'ext', 'codespace', 'cs', 'gist', 'org', 'ruleset', 'attestation',
]);
/** Groups we understand well enough to judge verb by verb. Anything else denies. */
const KNOWN_GROUPS = new Set([
  'issue', 'pr', 'run', 'api', 'search', 'project', 'label', 'repo', 'release',
  'workflow', 'cache', 'browse', 'status', 'version', 'help', 'completion',
]);
/** Verbs that only read. `checkout` is a LOCAL write and touches nothing on GitHub. */
const READ_VERBS = new Set([
  'view', 'list', 'ls', 'status', 'checks', 'diff', 'download', 'checkout',
  'item-list', 'field-list', 'log', 'watch',
]);
/** Branches a worker must never push at. Its own branch is the only one it owns. */
const PROTECTED = new Set(['dev', 'main', 'master', 'uat', 'prod', 'production', 'staging', 'release']);
/** Words that make an unresolvable command word (`$TOOL issue create`) a GitHub write. */
const GH_WORDS = new Set(['issue', 'pr', 'api', 'project', 'release', 'label', 'workflow', 'repo', 'gh']);

/**
 * Interpreters that take a PROGRAM as an argument. `node -e '…execSync("gh
 * issue create")'` is not shell, so the scanner cannot judge it word by word —
 * but a GitHub command inside it is still a GitHub write, so the program text
 * is read for one.
 */
const INTERPRETERS = new Map([
  ['node', ['-e', '--eval', '-p', '--print']],
  ['python', ['-c']], ['python3', ['-c']], ['py', ['-c']],
  ['perl', ['-e', '-E']], ['ruby', ['-e']], ['php', ['-r']],
  ['osascript', ['-e']], ['deno', ['--eval']], ['bun', ['-e']],
]);

/**
 * Commands that carry ANOTHER command in their arguments. `ssh box gh issue
 * create` and `find . -exec gh issue create \;` never make `gh` the command
 * word, so without this the tokens would sail past as ordinary arguments.
 * Deliberately a short, named list: a blanket "any bare `gh` token anywhere"
 * rule would fire on prose — on the drafted `.issue-request.json` a denied
 * worker is told to write.
 */
const CARRIERS = new Set([
  'ssh', 'find', 'parallel', 'watch', 'entr', 'su', 'docker', 'podman', 'flock',
  'npx', 'bunx', 'pnpx', 'dlx', 'npm', 'pnpm', 'yarn', 'corepack', 'tmux', 'screen',
]);

/** Commands that run something LATER, where nothing can see it. */
const SCHEDULERS = new Set(['at', 'batch', 'crontab', 'launchctl']);

/**
 * Argument shapes that are a `gh` command line whatever the command is called.
 * `cp $(which gh) /tmp/zz && /tmp/zz issue create` renames the binary; the
 * arguments give it away. Groups like `run` and `repo` are deliberately absent
 * — `npm run build` must not read as `gh run build`.
 */
const LAUNDER_GROUPS = new Set(['issue', 'pr', 'project', 'label', 'release', 'workflow', 'api']);

/** A GitHub command hiding inside program text this fence cannot tokenise. */
const GH_IN_TEXT = /(^|[^\w./-])(gh|hub)\s+(issue|pr|api|project|release|label|workflow|repo|auth|secret|alias|gist|ruleset)\b/i;
const GITHUB_HOST = /\bapi\.github\.com\b/i;
/** A nested agent hidden inside interpreter source. The first branch catches a
 * command string (`execSync("codex exec …")`); the second catches an executable
 * argument (`spawn("codex", …)`) without rejecting harmless prose such as
 * `console.log("codex")`. */
const AGENT_IN_TEXT =
  /(^|[^\w./-])(?:claude|codex)\s+(?:exec|resume|--?[a-z])/i;
const AGENT_EXECUTABLE_IN_TEXT =
  /(?:exec(?:File)?(?:Sync)?|spawn(?:Sync)?|system|popen|Popen|subprocess\.(?:run|call|check_call|check_output))\s*\(\s*(?:\[\s*)?["'`](?:[^"'`\s]*\/)?(?:claude|codex)["'`]\s*[,)]/i;

// --------------------------------------------------------------- the scanner
//
// Prose is not argv. The reference gate's header lists the bypasses found in its
// own review — quoted spans, backslash continuations, `;&|()`, `$(` — and this
// scanner exists to answer all of them at once. Every token carries whether it
// came from a quoted span (so a --body can still be READ without a quoted word
// ever becoming a command word) and whether it contains an expansion (so an
// unresolvable command word can be refused rather than guessed at).

function scan(src) {
  const segments = [];
  const nested = [];
  let cur = [];
  let tv = '';
  let tq = false;
  let texp = false;
  let has = false;
  let fnDef = false;
  // Where this segment's STANDARD INPUT comes from. A shell that is handed its
  // program on stdin (`echo … | bash`, `bash -s`, `bash <<< …`) runs something
  // this fence never sees, so a segment has to remember how it was wired up.
  let pipedIn = false;
  let redirIn = false;
  /** Marks the NEXT token as a redirection target rather than an argument. */
  let pendingRedir = null;
  /** Heredoc delimiters whose body has not been read yet. */
  const pendingHeredocs = [];

  const endTok = () => {
    if (has) {
      const t = { v: tv, q: tq, exp: texp };
      if (pendingRedir) {
        t.r = pendingRedir;
        // `<<'EOF'` is literal; `<<EOF` still expands `$( … )` inside the body.
        if (pendingRedir === 'heredoc') pendingHeredocs.push({ delim: tv, expands: !tq });
        pendingRedir = null;
      }
      cur.push(t);
    }
    tv = '';
    tq = false;
    texp = false;
    has = false;
  };
  const endSeg = (op) => {
    endTok();
    if (cur.length) segments.push({ toks: cur, pipedIn, redirIn, heredocs: [] });
    cur = [];
    pipedIn = op === '|';
    redirIn = false;
  };
  /** Consume `<<EOF` bodies as DATA belonging to the segment that opened them.
   *  This is what keeps `cat > .issue-request.json <<EOF … EOF` — the drafting
   *  path this fence pushes workers onto — from being read as commands, while
   *  `bash <<EOF` still gets its body judged (see judgeShell). */
  const takeHeredocs = (from) => {
    let j = from;
    const owner = segments[segments.length - 1];
    while (pendingHeredocs.length) {
      const h = pendingHeredocs.shift();
      let body = '';
      while (j < src.length) {
        const eol = src.indexOf('\n', j);
        const line = eol === -1 ? src.slice(j) : src.slice(j, eol);
        j = eol === -1 ? src.length : eol + 1;
        if (line.trim() === h.delim.trim()) break;
        body += line + '\n';
      }
      if (owner) owner.heredocs.push(body);
      // An UNQUOTED delimiter means bash still runs whatever `$( … )` the body
      // contains, even though the body itself is data. Judge those.
      if (h.expands) {
        try {
          for (const sub of scan(body).nested) nested.push(sub);
        } catch {
          nested.push(body); // unreadable body: judge the whole thing rather than skip it
        }
      }
    }
    return j;
  };
  const add = (s) => {
    tv += s;
    has = true;
  };

  const n = src.length;
  let i = 0;

  /** Read a balanced `$( … )`, stepping over quoted spans so a `)` inside a
   *  string cannot close it early. */
  const readSub = (start) => {
    let depth = 1;
    let j = start;
    let out = '';
    while (j < n && depth > 0) {
      const c = src[j];
      if (c === '\\') {
        out += c + (src[j + 1] ?? '');
        j += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        const q = c;
        out += c;
        j++;
        while (j < n && src[j] !== q) {
          if (q === '"' && src[j] === '\\') {
            out += src[j] + (src[j + 1] ?? '');
            j += 2;
            continue;
          }
          out += src[j];
          j++;
        }
        out += src[j] ?? '';
        j++;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      out += c;
      j++;
    }
    return { text: out, next: j };
  };

  const readTick = (start) => {
    let j = start;
    let out = '';
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') {
        out += src[j + 1] ?? '';
        j += 2;
        continue;
      }
      out += src[j];
      j++;
    }
    return { text: out, next: j + 1 };
  };

  while (i < n) {
    const c = src[i];

    if (c === '\\') {
      // A line continuation joins, it does not separate.
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      add(src[i + 1] ?? '');
      i += 2;
      continue;
    }

    if (c === "'") {
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== "'") {
        out += src[j];
        j++;
      }
      add(out);
      tq = true;
      i = j + 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') {
          out += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (src[j] === '$' && src[j + 1] === '(') {
          const r = readSub(j + 2);
          nested.push(r.text);
          texp = true;
          j = r.next;
          continue;
        }
        if (src[j] === '`') {
          const r = readTick(j + 1);
          nested.push(r.text);
          texp = true;
          j = r.next;
          continue;
        }
        if (src[j] === '$') texp = true;
        out += src[j];
        j++;
      }
      add(out);
      tq = true;
      i = j + 1;
      continue;
    }

    if (c === '`') {
      const r = readTick(i + 1);
      nested.push(r.text);
      texp = true;
      has = true;
      i = r.next;
      continue;
    }

    if (c === '$' && src[i + 1] === '(') {
      const r = readSub(i + 2);
      nested.push(r.text);
      texp = true;
      has = true;
      i = r.next;
      continue;
    }

    if (c === '$') {
      texp = true;
      add('$');
      i++;
      continue;
    }

    if (c === ' ' || c === '\t') {
      endTok();
      i++;
      continue;
    }

    if (c === '\n' || c === '\r' || c === ';') {
      endSeg(';');
      i++;
      if (pendingHeredocs.length) i = takeHeredocs(i);
      continue;
    }

    // `&&`, `||`, `&`, `|` all end a command. Only a single `|` feeds the next
    // one its standard input.
    if (c === '&' || c === '|') {
      const doubled = src[i + 1] === c;
      endSeg(c === '|' && !doubled ? '|' : ';');
      i += doubled ? 2 : 1;
      continue;
    }

    // A redirection separates the target from the command; it never starts one.
    // How many `<` there are says what the program's input IS: `<file`,
    // `<<DELIM` (a heredoc body), `<<<word` (a herestring).
    if (c === '<' || c === '>') {
      // `2>&1` — a file descriptor glued to the operator is wiring, not an
      // argument. Left in, that `2` reads as a PR number and denies an ALLOWED
      // `gh pr comment … 2>&1`.
      if (has && /^[0-9]+$/.test(tv)) {
        tv = '';
        has = false;
      }
      endTok();
      let lt = 0;
      while (i < n && (src[i] === '<' || src[i] === '>' || src[i] === '&')) {
        if (src[i] === '<') lt++;
        i++;
      }
      if (lt === 2 && src[i] === '-') i++; // `<<-DELIM` strips leading tabs
      pendingRedir = lt === 0 ? 'out' : lt === 1 ? 'file' : lt === 2 ? 'heredoc' : 'herestring';
      if (lt > 0) redirIn = true;
      continue;
    }

    // Grouping. `name(` with a word already in hand is a function definition —
    // a fence-evasion primitive with no honest use inside a Bash tool call.
    if (c === '(' || c === ')' || c === '{' || c === '}') {
      if (c === '(' && has && !tq) fnDef = true;
      endSeg(';');
      i++;
      continue;
    }

    add(c);
    i++;
  }
  endSeg(';');
  if (pendingHeredocs.length) takeHeredocs(n);
  return { segments, nested, fnDef };
}

// ------------------------------------------------------------- reading a file
//
// `echo 'gh issue create …' > /tmp/x.sh && bash /tmp/x.sh` is laundering, and
// no amount of tokenising the tool call can see it — the write is in a FILE.
// So the fence reads the script. It resolves relative paths against the tool
// call's own cwd plus any directory the command `cd`s into on its way, and a
// script it cannot read is REFUSED rather than assumed to be innocent.

const SHELL_SCRIPT = /\.(sh|bash|zsh|ksh)$/;
const SHELL_SHEBANG = /^#!.*\b(sh|bash|zsh|dash|ksh)\b/;
const MAX_SCRIPT_BYTES = 512 * 1024;

function safeCwd() {
  try {
    return process.cwd();
  } catch {
    return '';
  }
}

/** @returns {string | null} the script's text, or null if no candidate read. */
function readScript(p, dirs) {
  if (!p || p.includes('\n')) return null;
  const candidates = p.startsWith('/') ? [p] : (dirs || []).map((d) => resolvePath(d || '', p));
  for (const c of candidates) {
    try {
      const st = statSync(c);
      if (!st.isFile() || st.size > MAX_SCRIPT_BYTES) continue;
      return readFileSync(c, 'utf8');
    } catch {
      // try the next candidate directory
    }
  }
  return null;
}

/** The directory a segment moves the shell into, so a later relative path resolves. */
function cdTarget(toks) {
  const t = toks.filter((x) => !x.r);
  let k = 0;
  while (k < t.length && isAssign(t[k])) k++;
  const w = t[k] ? base(t[k].v) : '';
  if (w !== 'cd' && w !== 'pushd') return null;
  const arg = t.slice(k + 1).find((x) => !isFlag(x));
  if (!arg || arg.exp) return null;
  return arg.v;
}

// ----------------------------------------------------------------- the judges

const isAssign = (t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.v);
const isFlag = (t) => !t.q && t.v.startsWith('-') && t.v !== '-';
const base = (v) => v.replace(/\\/g, '').split('/').pop() ?? v;

/** A flag's value, honouring `--flag=value`, and refusing to swallow the NEXT
 *  flag as a value — the pflag trap the reference gate documents. */
function flagValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    for (const nm of names) {
      if (t.v === nm) {
        const nx = args[i + 1];
        if (!nx || isFlag(nx)) return { found: true, value: null };
        return { found: true, value: nx.v };
      }
      if (t.v.startsWith(nm + '=')) return { found: true, value: t.v.slice(nm.length + 1) };
    }
  }
  return { found: false, value: null };
}

/** The TOKEN a flag was given, so its `exp` survives — a program whose text
 *  comes from `$CMD` is not a program this fence can read. */
function flagToken(args, names) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (isFlag(t) && names.some((nm) => t.v === nm)) return { found: true, tok: args[i + 1] ?? null };
    for (const nm of names) {
      if (t.v.startsWith(nm + '=')) {
        return { found: true, tok: { v: t.v.slice(nm.length + 1), q: t.q, exp: t.exp } };
      }
    }
  }
  return { found: false, tok: null };
}

const hasFlag = (args, names) =>
  args.some((t) => names.some((nm) => t.v === nm || t.v.startsWith(nm + '=')));

/** `$AGENT exec …` and `$AGENT -p …` cannot be resolved to a literal basename,
 * but both are agent-shaped enough that allowing them would defeat the rule
 * against spawning an unfenced nested session. */
function hasAgentShapedArgv(args) {
  return args.some((t) => {
    if (AGENT_ARG_WORDS.has(t.v)) return true;
    const flag = t.v.split('=', 1)[0];
    return AGENT_ARG_FLAGS.has(flag);
  });
}

/** Split `gh`-style args into the flags used and the bare positionals left over. */
function partition(args) {
  const flags = [];
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (isFlag(t)) {
      const eq = t.v.indexOf('=');
      if (eq > 0) {
        flags.push({ name: t.v.slice(0, eq), value: t.v.slice(eq + 1) });
      } else {
        const nx = args[i + 1];
        if (nx && !isFlag(nx)) {
          flags.push({ name: t.v, value: nx.v });
          i++;
        } else {
          flags.push({ name: t.v, value: null });
        }
      }
      continue;
    }
    positionals.push(t);
  }
  return { flags, positionals };
}

function judgeGh(args) {
  // Step over any global flags to reach the group.
  let i = 0;
  while (i < args.length && isFlag(args[i])) {
    const nx = args[i + 1];
    if (nx && !isFlag(nx) && !args[i].v.includes('=')) i++;
    i++;
  }
  const groupTok = args[i];
  if (!groupTok) return ALLOW; // bare `gh` prints help
  if (groupTok.exp) return deny('a `gh` subcommand this fence cannot read cannot be judged, so it is refused.');

  const group = groupTok.v;
  const rest = args.slice(i + 1);
  const verbTok = rest.find((t) => !isFlag(t));
  const verb = verbTok ? verbTok.v : '';
  const after = verbTok ? rest.slice(rest.indexOf(verbTok) + 1) : rest;

  if (DENIED_GROUPS.has(group)) {
    return deny(`\`gh ${group}\` is a write surface end to end and is never yours to run.`);
  }
  if (group === 'search') return ALLOW;
  if (group === 'api') return judgeApi(rest);

  if (group === 'pr' && verb === 'create') return judgePrCreate(after);
  if (group === 'pr' && verb === 'edit') return judgePrEdit(after);
  if (group === 'pr' && verb === 'comment') return judgePrComment(after);

  if (!KNOWN_GROUPS.has(group)) {
    return deny(`\`gh ${group}\` is not a command this fence knows, so it is refused rather than guessed at.`);
  }
  if (!verb || READ_VERBS.has(verb)) return ALLOW;

  if (group === 'issue' && verb === 'create') return denyIssue('filing a GitHub issue');
  if (group === 'issue' && verb === 'comment') return denyComment();
  if (group === 'project') return denyBoard();
  return deny(`\`gh ${group} ${verb}\` writes to GitHub and is not on the allowlist.`);
}

/**
 * Has the operator approved Gate D for this issue?
 *
 * Gate D's entire subject matter IS `gh pr create` — it is the gate where they
 * approve the PR being raised. A PR once went out having never been asked for,
 * and nothing stopped it because this branch allowed the command unconditionally.
 *
 * Reads the console's own decision ledger, whose path arrives in the environment
 * the same way WORKER_SESSION_ID already does. FAILS OPEN when there is no ledger
 * or no issue number: a fence that blocks a sanctioned PR because a file was
 * missing is worse than no fence, and this codebase has been bitten three times by
 * exactly that.
 */
function gateDApproved() {
  const path = process.env.WORKER_DECISIONS_FILE;
  const issue = Number(process.env.WORKER_ISSUE);
  if (!path || !Number.isInteger(issue)) return true; // cannot tell — do not block
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return true; // no ledger yet
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const d = JSON.parse(line);
      if (d.issue === issue && d.gate === 'D' && d.decision === 'approved') return true;
    } catch {
      // torn line; keep looking
    }
  }
  return false;
}

function judgePrCreate(args) {
  if (!gateDApproved()) {
    return deny(
      'the operator has not approved gate D for this issue, and gate D is where they approve the PR being ' +
        'raised. Stop at gate D — write `.gate.json` and exit — rather than opening the PR.',
    );
  }
  if (hasFlag(args, ['--repo', '-R'])) {
    return deny('`gh pr create --repo` opens a PR somewhere other than the repo you are working in.');
  }
  // `dev` is the team's integration branch — the one branch every worker's PR is
  // meant to land on, so it is the only base this fence lets one open against.
  // `-B` is gh's own short form of `--base`. Missing it denied the sanctioned
  // PR open — a fence that blocks the allowlist is worse than no fence.
  const b = flagValue(args, ['--base', '-B']);
  if (!b.found) {
    return deny('`gh pr create` without `--base dev` opens against the repo default branch. Pass `--base dev`.');
  }
  if (b.value !== 'dev') {
    return deny(`\`gh pr create --base ${b.value ?? '?'}\` is not yours to open. The only base you may open against is \`dev\`.`);
  }
  return ALLOW;
}

// A worker owns its own PR body. Stage 7 REQUIRES it to archive each review
// round there ("## Review round N" with the evidence), and this repo's rule is
// that anything to be considered before merge must be IN THE BODY — a merger
// absorbs open items within minutes and reads nothing else. The first cut of
// this fence denied that, so a worker asked the operator to paste a committed
// file into the PR description by hand. Third time this fence forbade a write
// the skill mandates, after `gh pr create -B dev` and the @claude re-review
// comment. A fence that blocks sanctioned work is worse than no fence.
const OWN_PR_EDIT = new Set(['--body', '--body-file', '--title', '--add-label', '--remove-label']);

function judgePrEdit(args) {
  const { flags, positionals } = partition(args);
  if (positionals.length) {
    return deny('`gh pr edit` with a PR number or URL edits a PR that may not be yours. Drop it and it means the PR for your current branch.');
  }
  if (flags.length === 0) {
    return deny('`gh pr edit` with no flags opens an interactive editor, which cannot work headless.');
  }
  for (const f of flags) {
    if (!OWN_PR_EDIT.has(f.name)) {
      return deny(`\`gh pr edit ${f.name}\` is not on the allowlist. On your OWN PR you may set --body, --body-file or --title, and move the changes-requested label.`);
    }
    // Labels stay narrow: the round-signalling one is the worker's to clear;
    // priority and area labels are triage's, not a worker's to award itself.
    if ((f.name === '--add-label' || f.name === '--remove-label') && f.value !== 'changes-requested') {
      return deny(`the only label you may move is \`changes-requested\`, not \`${f.value ?? '?'}\`.`);
    }
  }
  return ALLOW;
}

function judgePrComment(args) {
  const { flags, positionals } = partition(args);
  if (positionals.length) {
    return deny('`gh pr comment` with a PR number or URL comments on a PR that may not be yours. Drop it and it means the PR for your current branch.');
  }
  if (hasFlag(args, ['--body-file', '-F'])) {
    return deny('a comment whose body this fence cannot read cannot be judged. Pass the text inline with `--body`.');
  }
  // `--body "$(cat msg.md)"` is not a forbidden write, it is an unreadable one.
  // Saying so is the difference between one retry and a round trip to the
  // operator for a comment they have already sanctioned.
  const bTok = flagToken(args, ['--body', '-b']);
  if (bTok.found && (!bTok.tok || bTok.tok.exp)) {
    return deny(
      'a comment body built by another command cannot be checked for the `@claude` re-review it has to be. ' +
        'This comment is allowed on your own PR — pass the text inline: `gh pr comment --body "@claude re-review — …"`.',
    );
  }
  const b = flagValue(args, ['--body', '-b']);
  if (!b.value || !/^@claude\b/i.test(b.value.trim())) {
    return denyComment();
  }
  if (flags.some((f) => f.name === '--edit-last')) {
    return deny('`--edit-last` rewrites a comment that is already posted.');
  }
  return ALLOW;
}

function judgeApi(args) {
  const target = args.find((t) => !isFlag(t));
  const method = flagValue(args, ['-X', '--method']);
  const bodyFlags = ['-f', '--field', '-F', '--raw-field', '--input'];

  if (target && target.v === 'graphql') {
    if (hasFlag(args, ['--input'])) {
      return deny('a GraphQL document this fence cannot read cannot be judged, so `gh api graphql --input` is refused.');
    }
    const q = args.find((t) => t.v.startsWith('query='));
    if (!q) return deny('`gh api graphql` without a readable `query=` field is refused rather than guessed at.');
    if (q.v.slice('query='.length).trim().startsWith('@')) {
      return deny('`query=@file` reads the document from a file this fence cannot see, so it is refused. Pass the query inline.');
    }
    if (/\bmutation\b/i.test(q.v)) {
      return deny('a GraphQL mutation writes to GitHub — this is how a board move or a label change gets in through the back door.');
    }
    return ALLOW;
  }

  if (method.found && !/^(GET|HEAD)$/i.test(method.value ?? '')) {
    return apiWriteReason(target, `\`gh api -X ${method.value ?? '?'}\``);
  }
  if (hasFlag(args, bodyFlags)) {
    // `gh api` with fields and no method POSTs. Naming no method is not a read.
    return apiWriteReason(target, '`gh api` with fields');
  }
  return ALLOW;
}

/** Route a raw-API write to the artefact for whatever it was reaching for. */
function apiWriteReason(target, what) {
  const path = target ? target.v : '';
  if (/\/issues(\/|$)/.test(path) && !/\/comments/.test(path) && !/\/labels/.test(path)) {
    return denyIssue(`${what} against \`${path}\``);
  }
  if (/\/comments/.test(path)) return denyComment();
  if (/\/projects?/i.test(path)) return denyBoard();
  return deny(`${what} writes to GitHub, and the raw API is not a way around the allowlist.`);
}

function judgeGit(args) {
  let i = 0;
  while (i < args.length && isFlag(args[i])) {
    if (args[i].v === '-C' || args[i].v === '-c') {
      const val = args[i + 1];
      // `git -c alias.x='!gh issue create' x` is aliasing with extra steps.
      if (args[i].v === '-c' && val && /^alias\./i.test(val.v)) {
        return deny('a git alias defined on the command line renames a command out from under this fence.');
      }
      i++;
    }
    i++;
  }
  const sub = args[i]?.v;
  if (sub === 'config' && args.slice(i + 1).some((t) => /^alias\./i.test(t.v))) {
    return deny('defining a git alias hides what actually runs behind a name this fence cannot follow.');
  }
  if (sub !== 'push') return ALLOW; // git is local; push is the only wire write
  const rest = args.slice(i + 1);

  if (hasFlag(rest, ['--force', '-f', '--force-with-lease', '--force-if-includes'])) {
    return deny('a force push rewrites history someone else may already have.');
  }
  if (hasFlag(rest, ['--delete', '-d', '--mirror', '--all', '--tags', '--follow-tags', '--prune'])) {
    return deny('that push deletes or moves refs beyond your own branch.');
  }

  const positionals = [];
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k];
    if (isFlag(t)) {
      if (['--repo', '-o', '--push-option', '--receive-pack', '--exec'].includes(t.v)) k++;
      continue;
    }
    positionals.push(t.v);
  }
  for (const ref of positionals.slice(1)) {
    if (ref.startsWith('+')) return deny('a `+` refspec is a force push.');
    const dest = (ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref)
      .replace(/^refs\/heads\//, '')
      .toLowerCase();
    if (PROTECTED.has(dest)) {
      return deny(`pushing at \`${dest}\` is never yours to do — you push your own branch and open a PR against \`dev\`.`);
    }
  }
  return ALLOW;
}

function judgeCurl(args) {
  const atGithub = args.some((t) => /(^|[/@.])(api\.)?github\.com/i.test(t.v));
  if (!atGithub) return ALLOW;
  const method = flagValue(args, ['-X', '--request']);
  const bodied = hasFlag(args, [
    '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json',
    '-F', '--form', '-T', '--upload-file',
  ]);
  if ((method.found && !/^(GET|HEAD)$/i.test(method.value ?? '')) || bodied) {
    return deny('reaching the GitHub API with curl is not a way around the allowlist.');
  }
  return ALLOW;
}

function judgeSegment(seg, ctx) {
  // Redirection targets are wiring, not arguments: `2>&1` must not leave a `1`
  // that reads as a PR number, and `> out.log` must not make an allowed
  // `gh pr comment` look like a comment on someone else's PR.
  const toks = seg.toks.filter((t) => !t.r);
  let k = 0;
  while (k < toks.length && isAssign(toks[k])) k++;
  if (k >= toks.length) return ALLOW; // assignments only: nothing ran

  let word = base(toks[k].v);
  let guard = 0;
  while ((WRAPPERS.has(word) || word === 'xargs') && guard++ < 8) {
    if (word === 'xargs') return judgeXargs(toks.slice(k + 1));
    // `env -S 'gh issue create …'` hands env a whole command line in one word.
    if (word === 'env') {
      const s = flagToken(toks.slice(k + 1), ['-S', '--split-string']);
      if (s.found) {
        if (!s.tok || s.tok.exp) return deny('an `env -S` command line this fence cannot read cannot be judged.');
        return decide(s.tok.v, { depth: ctx.depth + 1, dirs: ctx.dirs });
      }
    }
    const operandOk = WRAPPERS_WITH_OPERAND.has(word);
    k++;
    while (
      k < toks.length &&
      (isFlag(toks[k]) || isAssign(toks[k]) || (operandOk && /^[0-9]/.test(toks[k].v)))
    ) {
      k++;
    }
    if (k >= toks.length) return ALLOW;
    word = base(toks[k].v);
  }

  const cmdTok = toks[k];
  const rest = toks.slice(k + 1);

  if (word === 'gh') return judgeGh(rest);
  if (word === 'git') return judgeGit(rest);
  if (word === 'hub') return deny('`hub` is `gh` by another name.');
  if (AGENT_CLIS.has(word)) {
    return deny(
      `a nested \`${word}\` starts a session this fence is not installed in, which is a way around it. ` +
        'Do the work in this session.',
    );
  }
  if (word === 'alias' || word === 'unalias') {
    return deny('aliasing inside a tool call renames commands out from under this fence.');
  }
  if (SCHEDULERS.has(word)) {
    return deny('scheduling a command runs it later, when nothing is watching.');
  }
  // `gh${IFS}issue${IFS}create` is one word here and three to bash.
  if (cmdTok.exp && /(^|[^\w])(gh|hub)([^\w]|$)/i.test(cmdTok.v)) {
    return deny(`\`${cmdTok.v}\` is a \`gh\` command with an expansion spliced into its name, which is a way around this fence.`);
  }
  if (SHELLS.has(word)) return judgeShell(word, rest, ctx, seg);
  if (INTERPRETERS.has(word)) return judgeInterpreter(word, rest, ctx, seg);
  if (CURLS.has(word)) return judgeCurl(rest);

  if (CARRIERS.has(word)) {
    const v = judgeCarried(rest, ctx);
    if (!v.allow) return v;
  }

  // An unresolvable command word sitting next to GitHub words is a laundered
  // `gh`. `$TOOL issue create` must not pass because we cannot read `$TOOL`.
  if (cmdTok.exp && rest.some((t) => GH_WORDS.has(t.v))) {
    return deny(
      `\`${cmdTok.v}\` cannot be resolved, and what follows it is a GitHub command, so it is refused rather than guessed at.`,
    );
  }
  if (cmdTok.exp && hasAgentShapedArgv(rest)) {
    return deny(
      `\`${cmdTok.v}\` cannot be resolved, and its arguments are shaped like a nested coding-agent command. ` +
        'A nested session would not carry this fence, so it is refused rather than guessed at.',
    );
  }

  // A gh command line under another name is still a gh command line. Judged as
  // one — and only a DENY is honoured, so `mytool pr view` stays a read.
  const bare = rest.filter((t) => !isFlag(t));
  if (bare.length > 1 && LAUNDER_GROUPS.has(bare[0].v)) {
    const v = judgeGh(rest);
    if (!v.allow) return v;
  }

  // A script run by name (`./push.sh`) is a script all the same.
  if (!cmdTok.exp && (cmdTok.v.includes('/') || SHELL_SCRIPT.test(word))) {
    const text = readScript(cmdTok.v, ctx.dirs);
    if (text !== null && (SHELL_SCRIPT.test(word) || SHELL_SHEBANG.test(text.slice(0, 200)))) {
      return decide(text, { depth: ctx.depth + 1, dirs: ctx.dirs });
    }
  }
  return ALLOW;
}

/** `xargs` builds the tail of its command from standard input, which this hook
 *  never sees. So `echo 'issue create …' | xargs gh` is only PARTLY visible —
 *  and the invisible part is exactly the subcommand. */
function judgeXargs(rest) {
  // Find the carried command by NAME rather than by position: `xargs -a
  // args.txt gh …` puts a filename where the command would otherwise be.
  const WATCHED = (w) =>
    w === 'gh' || w === 'hub' || w === 'git' || AGENT_CLIS.has(w) ||
    SHELLS.has(w) || INTERPRETERS.has(w) || CURLS.has(w);
  let j = rest.findIndex((t) => !isFlag(t) && !isAssign(t) && WATCHED(base(t.v)));
  if (j < 0) {
    // Nothing watched by name — fall back to the first bare word, which is
    // where the command normally is.
    j = rest.findIndex((t) => !isFlag(t) && !isAssign(t));
  }
  const carried = j >= 0 ? rest[j] : null;
  if (!carried) return ALLOW; // bare `xargs` runs `echo`
  const w = base(carried.v);
  const tail = rest.slice(j + 1);
  const hasVisibleSub = tail.some((t) => !isFlag(t));

  if (w === 'hub') return deny('`hub` is `gh` by another name.');
  if (w === 'gh') {
    if (!hasVisibleSub) {
      return deny('`xargs gh` takes its subcommand from standard input, which this fence cannot read.');
    }
    return judgeGh(tail);
  }
  if (w === 'git') {
    if (!hasVisibleSub) {
      return deny('`xargs git` takes its subcommand from standard input, which this fence cannot read.');
    }
    return judgeGit(tail);
  }
  if (SHELLS.has(w) || INTERPRETERS.has(w) || CURLS.has(w) || AGENT_CLIS.has(w)) {
    return deny(`\`xargs ${w}\` builds a command out of standard input, which this fence cannot read.`);
  }
  return ALLOW;
}

/**
 * A command that carries another one: `ssh box gh issue create`.
 *
 * The carried command must actually LOOK like one — a bare `gh` followed by a
 * subcommand — so that `find . -exec grep gh {} \;` stays what it is: a search
 * for the letters, not a GitHub write.
 */
function judgeCarried(rest, ctx) {
  const looksLikeGh = (t) => t && !isFlag(t) && (KNOWN_GROUPS.has(t.v) || DENIED_GROUPS.has(t.v));
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j];
    if (t.q) {
      // `ssh box 'gh issue create …'` — the whole command arrives as one word.
      const v = decide(t.v, { depth: ctx.depth + 1, dirs: ctx.dirs });
      if (!v.allow) return v;
      continue;
    }
    const w = base(t.v);
    if (AGENT_CLIS.has(w)) {
      return deny(
        `a nested \`${w}\` starts a session this fence is not installed in, which is a way around it. ` +
          'Do the work in this session.',
      );
    }
    if ((w === 'gh' || w === 'hub') && looksLikeGh(rest[j + 1])) {
      if (w === 'hub') return deny('`hub` is `gh` by another name.');
      const v = judgeGh(rest.slice(j + 1));
      if (!v.allow) return v;
    }
    if (w === 'git' && rest[j + 1] && rest[j + 1].v === 'push') {
      const v = judgeGit(rest.slice(j + 1));
      if (!v.allow) return v;
    }
  }
  return ALLOW;
}

function judgeInterpreter(word, rest, ctx, seg) {
  const code = flagToken(rest, INTERPRETERS.get(word) ?? []);
  const refuseText = (text, where) => {
    if (AGENT_IN_TEXT.test(text) || AGENT_EXECUTABLE_IN_TEXT.test(text)) {
      return deny(
        `a nested agent command inside ${where} starts a session this fence is not installed in. ` +
          'Do the work in this session.',
      );
    }
    if (GH_IN_TEXT.test(text)) {
      return deny(`a \`gh\` command inside ${where} is still a GitHub write, and running it through an interpreter is not a way around the allowlist.`);
    }
    if (GITHUB_HOST.test(text)) {
      return deny(`reaching \`api.github.com\` from ${where} is not a way around the allowlist.`);
    }
    return ALLOW;
  };

  if (code.found) {
    // `CODE=…; node -e "$CODE"` is a program this fence never sees.
    if (!code.tok || code.tok.exp) {
      return deny(`a \`${word}\` program this fence cannot read cannot be judged.`);
    }
    return refuseText(code.tok.v, `a \`${word}\` program`);
  }
  for (const body of seg.heredocs) {
    const v = refuseText(body, `a \`${word}\` program`);
    if (!v.allow) return v;
  }
  if (seg.heredocs.length) return ALLOW;
  if (seg.pipedIn || seg.redirIn) {
    return deny(`a \`${word}\` program arriving on standard input cannot be checked, so it is refused.`);
  }
  return ALLOW;
}

function judgeShell(word, rest, ctx, seg) {
  const next = { depth: ctx.depth + 1, dirs: ctx.dirs };
  const unreadable = 'a nested shell whose program this fence cannot read cannot be judged.';

  if (word === 'eval' || word === 'source' || word === '.') {
    // `eval "$(cat draft.sh)"` runs the OUTPUT of another command. There is no
    // text here to judge, so it is refused.
    if (rest.some((t) => t.exp)) {
      return deny('what `eval` runs is produced by another command, which this fence cannot read.');
    }
    const inner = rest.map((t) => t.v).join(' ').trim();
    if (!inner) return ALLOW;
    return decide(inner, next);
  }

  // `-c` may arrive combined (`bash -lc '…'`), which `--flag value` parsing misses.
  const ci = rest.findIndex((t) => !t.q && /^-[a-zA-Z]*c$/.test(t.v));
  const cTok = ci >= 0 ? { found: true, tok: rest[ci + 1] ?? null } : flagToken(rest, ['-c']);
  if (cTok.found) {
    // `CMD='gh issue create'; bash -c "$CMD"` — the program is a variable.
    if (!cTok.tok || cTok.tok.exp) return deny(unreadable);
    return decide(cTok.tok.v, next);
  }

  // `bash <<'EOF' … EOF` — the body IS the program, so judge it.
  for (const body of seg.heredocs) {
    const v = decide(body, next);
    if (!v.allow) return v;
  }
  if (seg.heredocs.length) return ALLOW;

  // `bash <<< 'gh issue create'` — the word IS the program.
  const here = seg.toks.find((t) => t.r === 'herestring');
  if (here) return decide(here.v, next);

  // `bash /tmp/x.sh` — the FILE is the program. Read it, or refuse.
  const file = rest.find((t) => !isFlag(t) && !isAssign(t)) || seg.toks.find((t) => t.r === 'file');
  if (file) {
    if (file.exp) {
      return deny('a script whose path this fence cannot resolve cannot be checked, so it is refused.');
    }
    const text = readScript(file.v, ctx.dirs);
    if (text === null) {
      return deny(
        `\`${word} ${file.v}\` runs a script this fence could not read, and an unread script is refused. ` +
          'Give it as an absolute path, or run the commands inline.',
      );
    }
    return decide(text, next);
  }

  // `echo '…' | bash`, `bash -s` — the program arrives on standard input.
  if (seg.pipedIn || seg.redirIn) {
    return deny('a shell whose program arrives on standard input cannot be checked, so it is refused.');
  }
  return ALLOW;
}

// ------------------------------------------------------------------ the entry

/**
 * @param {string} command
 * @param {{depth?: number, cwd?: string, dirs?: string[]} | number} [ctx]
 *        `cwd` is the tool call's own working directory, as Claude Code reports
 *        it, so a relative `bash scripts/x.sh` resolves to the same file the
 *        worker would run. A bare number is still accepted for the recursive
 *        depth, which is how this was called before scripts were read.
 * @returns {{allow: boolean, reason?: string}}
 */
export function decide(command, ctx = {}) {
  try {
    const c = typeof ctx === 'number' ? { depth: ctx } : (ctx ?? {});
    const depth = c.depth ?? 0;
    let dirs = c.dirs && c.dirs.length ? c.dirs.slice() : [c.cwd || safeCwd()];
    if (depth > 6) return deny('this command nests shells more deeply than can be checked.');
    if (typeof command !== 'string' || command.trim() === '') return ALLOW;

    const { segments, nested, fnDef } = scan(command);
    if (fnDef) {
      return deny('defining a shell function inside a tool call hides what actually runs.');
    }
    for (const seg of segments) {
      const v = judgeSegment(seg, { depth, dirs });
      if (!v.allow) return v;
      // `cd /tmp && bash x.sh` — the second segment's script is not where the
      // tool call started, so follow the shell.
      const target = cdTarget(seg.toks);
      if (target) dirs = [target.startsWith('/') ? target : resolvePath(dirs[0] || '', target), ...dirs];
    }
    for (const src of nested) {
      const v = decide(src, { depth: depth + 1, dirs });
      if (!v.allow) return v;
    }
    return ALLOW;
  } catch {
    // A fence that waves things through when it breaks is not a fence.
    return deny('this command could not be checked, and an unchecked command is refused.');
  }
}

// ------------------------------------------------------------------- the wire

/** The PreToolUse deny envelope. `permissionDecision: "deny"` outranks
 *  bypassPermissions; `permissionDecisionReason` reaches the model verbatim. */
function denyEnvelope(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

function verdictFor(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return deny('this hook could not read the tool call it was asked to check.');
  }
  if (!input || typeof input !== 'object') {
    return deny('this hook could not read the tool call it was asked to check.');
  }
  if (input.tool_name !== 'Bash') return ALLOW;
  const command = input.tool_input?.command;
  if (typeof command !== 'string') {
    return deny('this hook could not read the command it was asked to check.');
  }
  // Claude Code reports the tool call's own cwd; a relative script path has to
  // resolve against the worker's worktree, not against the console's process.
  return decide(command, { cwd: typeof input.cwd === 'string' ? input.cwd : undefined });
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    raw += c;
  });
  process.stdin.on('end', () => {
    let v;
    try {
      v = verdictFor(raw);
    } catch {
      v = deny('this hook could not check the command.');
    }
    if (!v.allow) process.stdout.write(denyEnvelope(v.reason));
    process.exit(0);
  });
  process.stdin.on('error', () => {
    process.stdout.write(denyEnvelope('WRITE FENCE: this hook could not read its input, so the command is refused.'));
    process.exit(0);
  });
}

// Only run the wire when executed as a hook, never when imported by a test.
if (process.argv[1] && process.argv[1].endsWith('write-fence.mjs')) main();
