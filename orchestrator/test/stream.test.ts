import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StreamTail,
  applyAgentStreamLine,
  applyStreamLine,
  emptyTotals,
  readTotals,
  tailFile,
  toolCommandOf,
} from '../src/stream.js';
import { decideReattach, parsePs, pidAlive } from '../src/reattach.js';

/**
 * The two mechanisms a surviving worker rests on: reading a file somebody else
 * is still writing, and deciding whether a pid we wrote down is still ours.
 *
 * Both are defended here at the level where they can actually be got wrong —
 * a read that lands mid-line, and a pid that has been handed to someone else.
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-stream-'));
  file = join(dir, 'run.stream.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const assistant = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const result = () =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.5 });

describe('tailing a file somebody else is writing', () => {
  it('returns each complete line exactly once', async () => {
    writeFileSync(file, `${assistant('one')}\n${assistant('two')}\n`);
    const tail = new StreamTail(file);
    expect(await tail.read()).toHaveLength(2);
    // Nothing new: the same lines must not come back a second time.
    expect(await tail.read()).toHaveLength(0);

    appendFileSync(file, `${assistant('three')}\n`);
    const more = await tail.read();
    expect(more).toHaveLength(1);
    expect(more[0]).toContain('three');
  });

  /**
   * The boundary the whole design turns on. A worker writes a line in pieces, so
   * a read lands in the middle of one; parsing that half-line would invent an
   * event, and skipping it would lose one. It has to be left where it is.
   */
  it('never parses a half-written line, and picks it up whole next time', async () => {
    writeFileSync(file, `${assistant('one')}\n{"type":"assist`);
    const tail = new StreamTail(file);
    const first = await tail.read();
    expect(first).toHaveLength(1);
    // The offset stops at the newline, NOT at the end of the file.
    expect(tail.offset).toBe(assistant('one').length + 1);

    appendFileSync(file, `ant","message":{"content":[{"type":"text","text":"two"}]}}\n`);
    const second = await tail.read();
    expect(second).toHaveLength(1);
    expect(second[0]).toContain('"two"');
  });

  /**
   * The restart itself: a second tail, built from the offset the first one
   * persisted, over a file that grew across the boundary — including a line that
   * was half-written at the moment the console went away.
   */
  it('resumes from a persisted offset with nothing dropped and nothing repeated', async () => {
    writeFileSync(file, `${assistant('one')}\n${assistant('two')}\n{"type":"assistant","mess`);
    const before = new StreamTail(file);
    const seenBefore = await before.read();
    const persisted = before.offset;
    expect(seenBefore).toHaveLength(2);

    // …console restarts here, mid-line…
    appendFileSync(file, `age":{"content":[{"type":"text","text":"three"}]}}\n${assistant('four')}\n`);

    const after = new StreamTail(file, persisted);
    const seenAfter = await after.read();
    expect(seenAfter).toHaveLength(2);
    expect(seenAfter.join('')).toContain('three');
    expect(seenAfter.join('')).toContain('four');
    // Four lines were written and four were read, once each.
    expect(seenBefore.length + seenAfter.length).toBe(4);
    expect(seenAfter.join('')).not.toContain('"one"');
  });

  it('reports nothing at all until the first line is finished', async () => {
    writeFileSync(file, '{"type":"assistant"');
    const tail = new StreamTail(file);
    expect(await tail.read()).toHaveLength(0);
    expect(tail.offset).toBe(0);
  });

  it('is not upset by a file that is not there', async () => {
    expect(await new StreamTail(join(dir, 'nope.jsonl')).read()).toEqual([]);
  });
});

describe('what a segment says about itself', () => {
  it('reads only its own slice of a file the whole session appends to', async () => {
    writeFileSync(file, `${assistant('previous segment')}\n${result()}\n`);
    const startOffset = Buffer.byteLength(`${assistant('previous segment')}\n${result()}\n`);
    appendFileSync(file, `${assistant('this segment')}\n${result()}\n`);

    const mine = await readTotals(file, startOffset);
    expect(mine.turns).toBe(1); // not 2 — the earlier segment is not ours
    expect(mine.lastText).toBe('this segment');
    expect(mine.sawResult).toBe(true);
  });

  it('says plainly when no result event ever arrived', async () => {
    writeFileSync(file, `${assistant('half a run')}\n`);
    expect((await readTotals(file)).sawResult).toBe(false);
  });

  it('skips a line that is not JSON rather than dying on it', () => {
    const t = emptyTotals();
    expect(applyStreamLine(t, 'not json at all')).toBeNull();
    expect(applyStreamLine(t, '')).toBeNull();
    expect(t.turns).toBe(0);
  });
});

describe('Codex JSONL normalisation', () => {
  it('learns the thread, text, tool activity and usage from a completed turn', () => {
    const totals = emptyTotals();
    const lines = [
      { type: 'thread.started', thread_id: '019-thread' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: { id: 'item-1', type: 'command_execution', command: 'npm test -- --runInBand' },
      },
      {
        type: 'item.completed',
        item: { id: 'item-1', type: 'command_execution', command: 'npm test -- --runInBand', exit_code: 0 },
      },
      { type: 'item.completed', item: { id: 'item-2', type: 'agent_message', text: 'Gate C is ready.' } },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 120,
          cached_input_tokens: 80,
          cache_write_input_tokens: 12,
          output_tokens: 30,
          reasoning_output_tokens: 9,
        },
      },
    ];
    for (const line of lines) applyAgentStreamLine('codex', totals, JSON.stringify(line));

    expect(totals.agentSessionId).toBe('019-thread');
    expect(totals.turns).toBe(1);
    expect(totals.lastTool).toBe('Bash');
    expect(totals.lastToolCommand).toBe('npm test -- --runInBand');
    expect(totals.toolRunning).toBe(false);
    expect(totals.toolCalls).toBe(1);
    expect(totals.lastText).toBe('Gate C is ready.');
    expect(totals.sawResult).toBe(true);
    expect(totals.resultError).toBeNull();
    expect(totals.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      reasoningOutputTokens: 9,
      cacheReadTokens: 80,
      cacheCreationTokens: 12,
      costUsd: null,
      numTurns: 1,
      source: 'codex',
    });
  });

  it('does not turn a non-terminal item warning into a failed run', () => {
    const totals = emptyTotals();
    applyAgentStreamLine(
      'codex',
      totals,
      JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'hook trust bypass warning' } }),
    );
    applyAgentStreamLine('codex', totals, JSON.stringify({ type: 'turn.completed', usage: {} }));
    expect(totals.resultError).toBeNull();
    expect(totals.sawResult).toBe(true);
  });

  it('counts completed agent messages as progress, not a turn merely starting', () => {
    const totals = emptyTotals();
    applyAgentStreamLine('codex', totals, JSON.stringify({ type: 'turn.started' }));
    applyAgentStreamLine(
      'codex',
      totals,
      JSON.stringify({ type: 'item.started', item: { id: 'message-1', type: 'agent_message', text: 'Drafting.' } }),
    );
    expect(totals.turns).toBe(0);
    expect(totals.lastText).toBeNull();

    applyAgentStreamLine(
      'codex',
      totals,
      JSON.stringify({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'Done.' } }),
    );
    expect(totals.turns).toBe(1);
    expect(totals.lastText).toBe('Done.');
  });

  it('timestamps a timestamp-less Codex tool only when it was observed live', () => {
    const line = JSON.stringify({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'command_execution', command: 'npm test' },
    });
    const live = emptyTotals();
    applyAgentStreamLine('codex', live, line, { observedAt: '2026-08-18T12:34:56.000Z' });
    expect(live.lastToolAt).toBe('2026-08-18T12:34:56.000Z');

    const replay = emptyTotals();
    applyAgentStreamLine('codex', replay, line);
    expect(replay.lastToolAt).toBeNull();
  });

  it('counts a tool emitted only as completed exactly once', () => {
    const totals = emptyTotals();
    applyAgentStreamLine(
      'codex',
      totals,
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: 'src/app.ts' }] },
      }),
    );
    expect(totals.lastTool).toBe('apply_patch');
    expect(totals.toolCalls).toBe(1);
    expect(totals.toolRunning).toBe(false);
  });

  it('uses turn.failed as the terminal failure signal', () => {
    const totals = emptyTotals();
    applyAgentStreamLine(
      'codex',
      totals,
      JSON.stringify({ type: 'turn.failed', error: { message: 'model context window exceeded' } }),
    );
    expect(totals.sawResult).toBe(true);
    expect(totals.resultError).toBe('model context window exceeded');
  });
});

describe('tailFile', () => {
  it('returns the END of a file, so an unbounded log is not an unbounded read', async () => {
    writeFileSync(file, 'x'.repeat(5000) + 'THE LAST BIT');
    const got = await tailFile(file, 20);
    expect(got.endsWith('THE LAST BIT')).toBe(true);
    expect(got.length).toBe(20);
  });

  it('is empty for a file that does not exist', async () => {
    expect(await tailFile(join(dir, 'nope.log'), 100)).toBe('');
  });
});

// ------------------------------------------------------------ the pid guard

describe('is that pid still our worker', () => {
  const base = {
    pidAlive: true,
    commandLine: 'node claude -p /issue-pipeline 4336 --session-id sess-abc --output-format stream-json',
    psRan: true,
    sessionId: 'sess-abc',
    streamExists: true,
    streamMtimeMs: 2_000_000,
    startedAtMs: 1_000_000,
  };

  it('re-attaches when the process, its command line and its stream file all agree', () => {
    expect(decideReattach(base)).toEqual({ attach: true, reason: 'still running' });
  });

  it('uses a Codex process identity token when the provider session id is not present in argv', () => {
    const token = '/tmp/worker-console/runs/sess-console.last-message.txt';
    const codex = {
      ...base,
      sessionId: 'sess-console',
      processIdentityToken: token,
      commandLine: `codex exec --json --output-last-message ${token} '$issue-pipeline 4336'`,
    };
    expect(decideReattach(codex)).toEqual({ attach: true, reason: 'still running' });
  });

  it('prefers an explicit identity token over a coincidental session-id match', () => {
    const out = decideReattach({
      ...base,
      processIdentityToken: '/tmp/the-required-output-marker',
      commandLine: `some-other-program --note ${base.sessionId}`,
    });
    expect(out.attach).toBe(false);
    expect(out.reason).toContain('different process');
  });

  it('refuses a dead pid', () => {
    const out = decideReattach({ ...base, pidAlive: false });
    expect(out.attach).toBe(false);
    expect(out.reason).toContain('no longer running');
  });

  /**
   * The dangerous one. The pid is alive, so `process.kill(pid, 0)` says yes —
   * but the number has been recycled and now belongs to something else. Adopting
   * it would mean "Stop this worker" signalling a stranger's process, so the
   * session id has to be there in the command line before we believe it.
   */
  it('refuses a pid that now belongs to a different process', () => {
    const out = decideReattach({ ...base, commandLine: '/usr/bin/some-other-program --unrelated' });
    expect(out.attach).toBe(false);
    expect(out.reason).toContain('different process');
  });

  it('refuses a pid ps has never heard of', () => {
    expect(decideReattach({ ...base, commandLine: null }).attach).toBe(false);
  });

  it('refuses when the stream file is gone — there is nothing left to read', () => {
    const out = decideReattach({ ...base, streamExists: false, streamMtimeMs: null });
    expect(out.attach).toBe(false);
    expect(out.reason).toContain('stream file is gone');
  });

  it('refuses a stream file that predates the run it is supposed to belong to', () => {
    const out = decideReattach({ ...base, streamMtimeMs: 10, startedAtMs: 1_000_000 });
    expect(out.attach).toBe(false);
    expect(out.reason).toContain('predates');
  });

  /** No ps on this machine is not evidence of anything; the file checks stand
   *  on their own rather than the console refusing to re-attach at all. */
  it('falls back to the file checks when ps could not be run', () => {
    expect(decideReattach({ ...base, psRan: false, commandLine: null }).attach).toBe(true);
  });
});

describe('the pid probes themselves', () => {
  it('knows this very process is alive, and that pid 0 tricks are not', () => {
    expect(pidAlive(process.pid)).toBe(true);
    // 2^22 is above every default pid_max; nothing can be running there.
    expect(pidAlive(4_194_303)).toBe(false);
  });

  it('reads pid and full command line out of ps output', () => {
    const map = parsePs('  1234 node /path/claude --session-id abc\n 99 /sbin/launchd\n\n');
    expect(map.get(1234)).toBe('node /path/claude --session-id abc');
    expect(map.get(99)).toBe('/sbin/launchd');
    expect(map.size).toBe(2);
  });
});


/**
 * WHAT IT IS DOING RIGHT NOW.
 *
 * "working, stage 3 · last tool Bash" told the operator nothing while a worker sat 13
 * minutes inside one command. Everything needed to say better was already in
 * the stream on disk — the `tool_use` block carries the command, and the line
 * carries its own timestamp — so this is derivation, not a new probe: nothing
 * here asks the worker process anything.
 */
describe('the current command, read out of the stream', () => {
  const toolUse = (name: string, input: unknown, timestamp: string, id = 'toolu_1') =>
    JSON.stringify({
      type: 'assistant',
      timestamp,
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
  const toolResult = (timestamp: string, id = 'toolu_1') =>
    JSON.stringify({
      type: 'user',
      timestamp,
      message: { content: [{ tool_use_id: id, type: 'tool_result', content: 'done' }] },
    });

  it('takes the command and the time it started off the last tool_use', () => {
    const t = emptyTotals();
    applyStreamLine(t, toolUse('Bash', { command: 'npm run ratchet:typecheck' }, '2026-08-12T09:00:00.000Z'));
    expect(t.lastTool).toBe('Bash');
    expect(t.lastToolCommand).toBe('npm run ratchet:typecheck');
    expect(t.lastToolAt).toBe('2026-08-12T09:00:00.000Z');
    expect(t.toolRunning).toBe(true);
  });

  it('stops the clock when the result comes back — the model thinking is not a stuck command', () => {
    const t = emptyTotals();
    applyStreamLine(t, toolUse('Bash', { command: 'npm test' }, '2026-08-12T09:00:00.000Z'));
    applyStreamLine(t, toolResult('2026-08-12T09:00:02.000Z'));
    expect(t.toolRunning).toBe(false);
    // The command itself is still the last thing it ran, and still says so.
    expect(t.lastToolCommand).toBe('npm test');
  });

  it('the LAST tool_use wins, so a long second command is not hidden behind a quick first', () => {
    const t = emptyTotals();
    applyStreamLine(t, toolUse('Read', { file_path: '/a/b.ts' }, '2026-08-12T09:00:00.000Z', 'toolu_1'));
    applyStreamLine(t, toolResult('2026-08-12T09:00:01.000Z', 'toolu_1'));
    applyStreamLine(t, toolUse('Bash', { command: 'npm run validate' }, '2026-08-12T09:00:02.000Z', 'toolu_2'));
    expect(t.lastToolCommand).toBe('npm run validate');
    expect(t.lastToolAt).toBe('2026-08-12T09:00:02.000Z');
    expect(t.toolRunning).toBe(true);
  });

  it('a finished segment has nothing running, whatever it was doing last', () => {
    const t = emptyTotals();
    applyStreamLine(t, toolUse('Bash', { command: 'npm test' }, '2026-08-12T09:00:00.000Z'));
    applyStreamLine(t, JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
    expect(t.toolRunning).toBe(false);
  });

  it('an empty stream claims no command, and a tool with no readable input says so by staying null', () => {
    expect(emptyTotals().lastToolCommand).toBeNull();
    expect(emptyTotals().toolRunning).toBe(false);
    const t = emptyTotals();
    applyStreamLine(t, toolUse('Task', { subagent_type: 'explore' }, '2026-08-12T09:00:00.000Z'));
    expect(t.lastTool).toBe('Task');
    expect(t.lastToolCommand).toBeNull();
  });
});

describe('toolCommandOf — the one line that says what a call is doing', () => {
  it('prefers the shell command, then the file, then whatever it described', () => {
    expect(toolCommandOf({ command: 'npm run ratchet:typecheck', description: 'Typecheck' })).toBe(
      'npm run ratchet:typecheck',
    );
    expect(toolCommandOf({ file_path: '/repo/src/App.tsx' })).toBe('/repo/src/App.tsx');
    expect(toolCommandOf({ description: 'Look for the failing case' })).toBe('Look for the failing case');
  });

  it('flattens newlines and truncates, so a 40-line heredoc cannot take the card over', () => {
    const out = toolCommandOf({ command: 'echo one\n  echo two' });
    expect(out).toBe('echo one echo two');
    const long = toolCommandOf({ command: 'x'.repeat(500) })!;
    expect(long.length).toBe(90);
    expect(long.endsWith('…')).toBe(true);
  });

  it('is null for an input with nothing to say', () => {
    expect(toolCommandOf(undefined)).toBeNull();
    expect(toolCommandOf({})).toBeNull();
    expect(toolCommandOf({ command: '   ' })).toBeNull();
  });
});
