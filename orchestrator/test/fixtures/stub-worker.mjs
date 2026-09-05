#!/usr/bin/env node
/**
 * Stands in for `claude` in tests: same argument shape, same stream-json output,
 * same "stop at a gate by exiting" behaviour. It exists because the real binary
 * cannot authenticate on this machine (see spike/NOTES.txt), and because a test
 * that needs a model to think is not a test.
 *
 *   first run  (--session-id <id> -p <prompt>) : writes .gate.json, exits 0
 *   resume     (--resume <id> -p <message>)    : deletes .gate.json, exits 0
 *   -p "FAIL"                                   : exits 1 with an error result
 *   no --output-format                          : the login probe — plain text
 *
 * Two environment knobs let a test control TIME, which is what testing "the
 * console restarted while this was running" needs:
 *
 *   STUB_WAIT_FOR=<path>  nothing more happens until that file appears
 *   STUB_NO_GATE=1        finish cleanly without stopping at a gate
 *   STUB_CHILD=1          spawn a grandchild first, so the pause tests have a
 *                         real process TREE to freeze rather than a lone pid
 *   STUB_CHILD_STAYS=1    keep that grandchild alive if only its parent dies,
 *                         so stop-tree tests can detect an orphaned descendant
 */
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

// Inert unless a test asks for it: records the argv this stub was handed, so
// the fence-wiring test can prove `--settings` actually reached the child on
// BOTH a start and a resume. Writing it anywhere but a test-owned path would
// leave a file in the worktree, so it only happens when the path is given.
if (process.env.STUB_ARGV_FILE) {
  try {
    writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify(argv));
  } catch {
    // A recorder that breaks a run would be worse than one that records nothing.
  }
}

const resumeId = flag('--resume');
const sessionId = resumeId ?? flag('--session-id');
const prompt = flag('-p') ?? '';
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

/**
 * The login probe runs `claude -p "<prompt>"` with no --output-format, so it
 * answers in plain text. The reply says which config dir it was handed — absent
 * or set — because the whole point of the probe is that it gets the SAME
 * environment a real worker gets, and a test has to be able to see that.
 */
if (!argv.includes('--output-format')) {
  const seen = 'CLAUDE_CONFIG_DIR' in process.env ? process.env.CLAUDE_CONFIG_DIR : '(none)';
  if (process.env.STUB_LOGIN === 'out') {
    process.stderr.write('Not logged in · Please run /login\n');
    process.exit(1);
  }
  if (process.env.STUB_LOGIN === 'confused') {
    process.stdout.write('something went sideways\n');
    process.exit(2);
  }
  if (process.env.STUB_LOGIN === 'hang') {
    // The interval is what keeps the event loop alive: without it node notices
    // the loop is empty and exits 13 instead of hanging, which is not the test.
    setInterval(() => {}, 1000);
    await new Promise(() => {}); // never answers; the probe's own timeout must win
  }
  process.stdout.write(`OK config_dir=${seen}\n`);
  process.exit(0);
}

emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: flag('--model') });

/**
 * A grandchild, for the pause tests: `claude → npm → jest` is the tree that
 * actually has to freeze, and a pause that only stopped the root would look
 * identical to one that worked. The child inherits this process's group, which
 * is the whole mechanism under test.
 *
 * It watches for its own abandonment as carefully as its parent does. A test
 * that fails an assertion never reaches its cleanup, and a leaked node process
 * polling a deleted temp directory for ever is exactly what `killSpawnedWorkers`
 * was written after finding five of.
 */
if (process.env.STUB_CHILD) {
  const guard = process.env.STUB_WAIT_FOR ? dirname(process.env.STUB_WAIT_FOR) : process.cwd();
  const staysAfterParent = process.env.STUB_CHILD_STAYS === '1';
  const code = `
    const { existsSync } = require('node:fs');
    const guard = ${JSON.stringify(guard)};
    const staysAfterParent = ${JSON.stringify(staysAfterParent)};
    const deadline = Date.now() + 60000;
    setInterval(() => {
      if ((!staysAfterParent && process.ppid === 1) || !existsSync(guard) || Date.now() > deadline) process.exit(0);
    }, 100);
  `;
  spawn(process.execPath, ['-e', code], { stdio: 'ignore' }).unref();
  // Long enough for the child to exist before anything measures the tree.
  await new Promise((r) => setTimeout(r, 200));
}

// STUB_QA_REWORK is exempt: the rework prompt's own sentinel line says "FAILED
// STEP(S) ONLY", so the substring trigger would fire on every rework and the
// mode could never be exercised. A test that wants a failing rework would set
// its own knob rather than rely on this collision.
if (prompt.includes('FAIL') && !process.env.STUB_QA_REWORK) {
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'I cannot do that.' }] } });
  emit({ type: 'result', subtype: 'success', is_error: true, result: 'stub worker was told to fail', session_id: sessionId });
  process.exit(1);
}

// Stay alive until the test says go. This is how a run can be made to still be
// in flight at a chosen moment — while the console shuts down, say.
//
// It also gives up on its own, because a worker is spawned DETACHED: a test that
// fails an assertion never writes the go file, and this process would otherwise
// poll for it for ever. Its temp directory is removed in `afterEach`, so that
// disappearing is the signal; the deadline is the backstop for anything else.
if (process.env.STUB_WAIT_FOR) {
  const target = process.env.STUB_WAIT_FOR;
  const home = dirname(target);
  const deadline = Date.now() + 60_000;
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } });
  const orphaned = await new Promise((resolve) => {
    const t = setInterval(() => {
      if (existsSync(target)) return clearInterval(t), resolve(false);
      if (!existsSync(home) || Date.now() > deadline) return clearInterval(t), resolve(true);
    }, 25);
  });
  if (orphaned) process.exit(0); // nobody is reading this any more
}

// A run that finishes without stopping at a gate — the other way a segment ends.
if (process.env.STUB_NO_GATE) {
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'done, no gate', session_id: sessionId, num_turns: 1 });
  process.exit(0);
}

if (resumeId) {
  if (existsSync('.gate.json')) unlinkSync('.gate.json');
  writeFileSync(
    'resumed.txt',
    `resumed with: ${prompt}\nconfig dir: ${process.env.CLAUDE_CONFIG_DIR ?? '(none)'}\nmodel: ${flag('--model') ?? '(none)'}\n`,
  );
  /**
   * STUB_COMMIT=1 — build something and COMMIT it during the run.
   *
   * An ask is supposed to make the worker answer and nothing else ("write no
   * other file, run nothing that changes state"), so this is how a test makes a
   * worker do unauthorised work at a gate nobody has decided — while still
   * obediently re-parking at the same gate letter afterwards, which is the one
   * thing the console used to check.
   */
  if (process.env.STUB_COMMIT) {
    writeFileSync('built.txt', 'work at a gate nobody approved');
    const git = (...a) => execFileSync('git', ['-c', 'user.email=x@y.z', '-c', 'user.name=x', ...a], { stdio: 'ignore' });
    git('add', '-A');
    git('commit', '-m', 'built while only answering a question');
  }
  /**
   * STUB_QA_REWORK=1 — a TARGETED REWORK, as a worker would actually do it.
   *
   * It rebuilds `.gate.json` from the prior evidence and click-script the rework
   * prompt carried, bumps the rev of every step named as failed, sets a `fix`
   * line and a NEW capture filename for those, and re-parks at gate C.
   *
   * STUB_QA_DROP_EVIDENCE=1 makes it fumble the merge in the exact way the
   * design is built against: it keeps only its own new capture and drops every
   * screenshot it was told to carry forward. That is the defect the console's
   * snapshot exists to survive, so a test needs a worker that commits it.
   *
   * Four more ways to come back wrong, one per proven defect:
   *
   *   STUB_QA_DROP_STEPS=2,3   return the click-script short of those steps
   *   STUB_QA_STOPPED_AT=<iso> re-park under the SAME stop stamp it was sent at
   *   STUB_QA_DUP_STEP=<id>    emit that step twice, as a copy-pasted merge does
   *   STUB_QA_DELETE_SHOTS=1   keep the manifest, delete the actual image files
   */
  if (process.env.STUB_QA_REWORK) {
    const EV = 'Prior "evidence" to carry forward verbatim';
    const QA = 'Prior "manualQa" to carry forward verbatim';
    const evAt = prompt.indexOf(EV);
    const qaAt = prompt.indexOf(QA);
    const evidence = JSON.parse(prompt.slice(prompt.indexOf('[', evAt), qaAt));
    const manualQa = JSON.parse(prompt.slice(prompt.indexOf('{', qaAt)));
    const issue = Number((process.cwd().match(/issue-(\d+)-/) ?? [])[1] ?? 0);
    const failed = [...prompt.matchAll(/^Step (\d+) \(rev \d+\)/gm)].map((m) => Number(m[1]));
    const shots = [];
    manualQa.steps = manualQa.steps.map((s) => {
      if (!failed.includes(s.id)) return s;
      const shot = `docs/issue-pipeline/plans/qa-${issue}/step${s.id}-after-rev${s.rev + 1}.png`;
      shots.push({ kind: 'screenshot', path: shot, caption: `step ${s.id} — after rework — now rejected` });
      return { ...s, rev: s.rev + 1, fix: 'disabled Confirm until a reason is typed', afterShot: shot };
    });
    const dropped = (process.env.STUB_QA_DROP_STEPS ?? '').split(',').filter(Boolean).map(Number);
    if (dropped.length) manualQa.steps = manualQa.steps.filter((s) => !dropped.includes(s.id));
    if (process.env.STUB_QA_DUP_STEP) {
      const want = Number(process.env.STUB_QA_DUP_STEP);
      const at = manualQa.steps.findIndex((s) => s.id === want);
      if (at !== -1) manualQa.steps.splice(at + 1, 0, { ...manualQa.steps[at] });
    }
    if (process.env.STUB_QA_DELETE_SHOTS) {
      for (const e of evidence) if (existsSync(e.path)) unlinkSync(e.path);
    }
    writeFileSync(
      '.gate.json',
      JSON.stringify({
        issue,
        gate: 'C',
        stage: 5,
        sessionId,
        stoppedAt: process.env.STUB_QA_STOPPED_AT ?? new Date().toISOString(),
        reportPath: null,
        summary: 'Did: fixed the failed step and re-drove it.',
        questions: [],
        evidence: process.env.STUB_QA_DROP_EVIDENCE ? shots : [...evidence, ...shots],
        manualQa,
      }),
    );
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'reworked', session_id: sessionId });
    process.exit(0);
  }

  /**
   * STUB_REPARK=<letter> — answer, and STOP AT THE SAME GATE AGAIN.
   *
   * That is what an ASK is supposed to make a worker do, as opposed to a
   * decision, so this is the knob the ask tests turn. Setting a DIFFERENT letter
   * (or leaving it unset, so the resume above simply carries on) is how the
   * charge-past tests make a worker misbehave on purpose.
   *
   * The answers are derived from the numbered questions in the prompt, so their
   * ids line up with what the console wrote down when the operator clicked — the
   * join the console's merge is built on.
   */
  if (process.env.STUB_REPARK) {
    const gate = process.env.STUB_REPARK.toUpperCase();
    const thread = [...prompt.matchAll(/^ {2}(\d+)\. (.+)$/gm)].map(([, id, q]) => ({
      id: Number(id),
      q,
      a: `answered: ${q}`,
      at: new Date().toISOString(),
    }));
    writeFileSync(
      '.gate.json',
      JSON.stringify({
        issue: Number((process.cwd().match(/issue-(\d+)-/) ?? [])[1] ?? 0),
        gate,
        stage: 5,
        sessionId,
        stoppedAt: new Date().toISOString(),
        reportPath: null,
        summary: 'Your QA, please.',
        questions: ['Does the click-script pass?'],
        thread,
      }),
    );
  }
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm .gate.json' } }] } });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Resumed and carrying on.' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId });
  process.exit(0);
}

emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '.gate.json' } }] } });
writeFileSync(
  '.gate.json',
  JSON.stringify(
    {
      issue: 4336,
      gate: 'C',
      stage: 4,
      sessionId,
      stoppedAt: new Date().toISOString(),
      reportPath: 'docs/issue-pipeline/plans/issue-4336-pr-body.md',
      summary: 'Built the fix and ran my own QA. Your turn: click-script plus three questions.',
      questions: ['Does the click-script pass?', 'What does a non-sysadmin see now?'],
      env_session_id: process.env.WORKER_SESSION_ID ?? null,
      // Absent from the env, not empty: the canonical account must run with no
      // CLAUDE_CONFIG_DIR at all, and a test has to be able to see the difference.
      env_config_dir: 'CLAUDE_CONFIG_DIR' in process.env ? process.env.CLAUDE_CONFIG_DIR : null,
      model_arg: flag('--model'),
      prompt,
    },
    null,
    2,
  ),
);
emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'GATE C — waiting for the operator.' }] } });
// The real CLI's end-of-run accounting, same field names — see metrics.ts.
emit({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'stopped at gate C',
  session_id: sessionId,
  num_turns: 2,
  total_cost_usd: 0.42,
  usage: { input_tokens: 11, cache_creation_input_tokens: 900, cache_read_input_tokens: 5000, output_tokens: 300 },
  modelUsage: {
    [flag('--model') ?? 'unknown']: {
      inputTokens: 11,
      outputTokens: 300,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 900,
      costUSD: 0.42,
    },
  },
});
process.exit(0);
