#!/usr/bin/env node
/** A deterministic stand-in for `codex exec --json` and `codex exec resume`. */
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1];
};
const execAt = argv.indexOf('exec');
const isResume = argv[execAt + 1] === 'resume';
const tail = argv.slice(execAt + (isResume ? 2 : 1));
const optionValue = new Set(['--output-last-message', '-o', '--output-schema']);
const positional = [];
for (let i = 0; i < tail.length; i += 1) {
  const arg = tail[i];
  if (optionValue.has(arg)) {
    i += 1;
    continue;
  }
  if (arg.startsWith('-')) continue;
  positional.push(arg);
}
const threadId = isResume ? positional[0] : (process.env.STUB_CODEX_THREAD ?? '01900000-0000-7000-8000-000000004336');
const prompt = isResume ? (positional[1] ?? '') : (positional[0] ?? '');
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (process.env.STUB_ARGV_FILE) {
  writeFileSync(
    process.env.STUB_ARGV_FILE,
    JSON.stringify({ argv, codexHome: process.env.CODEX_HOME ?? null, workerSessionId: process.env.WORKER_SESSION_ID ?? null }),
  );
}

emit({ type: 'thread.started', thread_id: threadId });
emit({ type: 'turn.started' });

if (process.env.STUB_WAIT_FOR) {
  const target = process.env.STUB_WAIT_FOR;
  const home = dirname(target);
  emit({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'Working on it.' } });
  const deadline = Date.now() + 60_000;
  const orphaned = await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (existsSync(target)) return clearInterval(timer), resolve(false);
      if (!existsSync(home) || Date.now() > deadline) return clearInterval(timer), resolve(true);
    }, 25);
  });
  if (orphaned) process.exit(0);
}

if (process.env.STUB_CODEX_FAIL) {
  emit({ type: 'turn.failed', error: { message: 'stub Codex was told to fail' } });
  process.exit(1);
}

const lastMessageFile = flag('--output-last-message') ?? flag('-o');
const finish = (text) => {
  if (lastMessageFile) writeFileSync(lastMessageFile, text);
  emit({
    type: 'turn.completed',
    usage: {
      input_tokens: 17,
      cached_input_tokens: 7,
      cache_write_input_tokens: 3,
      output_tokens: 11,
      reasoning_output_tokens: 2,
    },
  });
};

if (isResume) {
  if (existsSync('.gate.json')) unlinkSync('.gate.json');
  writeFileSync(
    'resumed-codex.txt',
    `thread: ${threadId}\nprompt: ${prompt}\ncodex home: ${process.env.CODEX_HOME ?? '(none)'}\nmodel: ${flag('-m') ?? '(none)'}\n`,
  );
  emit({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'rm .gate.json' } });
  emit({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'rm .gate.json', exit_code: 0 } });
  emit({ type: 'item.completed', item: { id: 'message-2', type: 'agent_message', text: 'Resumed and carrying on.' } });
  finish('Resumed and carrying on.');
  process.exit(0);
}

if (process.env.STUB_NO_GATE) {
  emit({ type: 'item.completed', item: { id: 'message-3', type: 'agent_message', text: 'Finished.' } });
  finish('Finished.');
  process.exit(0);
}

emit({ type: 'item.started', item: { id: 'patch-1', type: 'file_change', changes: [{ path: '.gate.json' }] } });
writeFileSync(
  join(process.cwd(), '.gate.json'),
  JSON.stringify({
    issue: 4336,
    gate: 'C',
    stage: 4,
    sessionId: process.env.WORKER_SESSION_ID ?? null,
    stoppedAt: new Date().toISOString(),
    reportPath: null,
    summary: 'Codex reached Gate C.',
    questions: ['Does the click-script pass?'],
    provider_thread_id: threadId,
    env_codex_home: process.env.CODEX_HOME ?? null,
    model_arg: flag('-m'),
    prompt,
  }),
);
emit({ type: 'item.completed', item: { id: 'patch-1', type: 'file_change', changes: [{ path: '.gate.json' }] } });
emit({ type: 'item.completed', item: { id: 'message-4', type: 'agent_message', text: 'GATE C — waiting.' } });
finish('GATE C — waiting.');
process.exit(0);
