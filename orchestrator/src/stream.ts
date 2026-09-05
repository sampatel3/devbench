import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseCodexUsage, parseResultUsage, type RunUsage } from './metrics.js';
import type { AgentProviderId } from './providers/types.js';

/**
 * A worker's `stream-json` goes to a FILE, and the console tails that file from
 * a byte offset. That single change is what makes a worker survive a console
 * restart: a pipe has exactly one reader and dies with it, a file does not care
 * who is reading it or whether anybody is.
 *
 * ONE FILE PER SESSION, appended across every segment of that session, so the
 * whole conversation's stream stays in one artifact next to `runs.jsonl`. Each
 * run records the size the file had when it started (`startOffset`), which is
 * what keeps one segment's accounting out of the next one's.
 *
 * Two offsets, doing two different jobs:
 *  - `startOffset` — where this segment's output begins. Everything the run
 *    record reports is read from there to the end, once, when the run ends.
 *  - `offset` — how far the live tail has got. It only ever advances past a
 *    NEWLINE, so a half-written line is never parsed, and it is persisted so a
 *    re-attached console picks the stream up exactly where it left off.
 */

const STREAM_SUFFIX = '.stream.jsonl';
const STDERR_SUFFIX = '.stderr.log';
const LAST_MESSAGE_SUFFIX = '.last-message.txt';

export function streamFileFor(dir: string, issue: number, sessionId: string): string {
  return join(dir, `${issue}-${sessionId}${STREAM_SUFFIX}`);
}

export function stderrFileFor(dir: string, issue: number, sessionId: string): string {
  return join(dir, `${issue}-${sessionId}${STDERR_SUFFIX}`);
}

export function lastMessageFileFor(dir: string, issue: number, sessionId: string): string {
  return join(dir, `${issue}-${sessionId}${LAST_MESSAGE_SUFFIX}`);
}

/** Everything one segment's stream says, folded up line by line. */
export type StreamTotals = {
  /** Vendor conversation id learned from the stream. Claude emits it at init;
   *  Codex allocates it in the first `thread.started` event. */
  agentSessionId: string | null;
  turns: number;
  lastText: string | null;
  lastTool: string | null;
  /** WHAT the last tool was asked to do — the command, truncated. "last tool
   *  Bash" is not an answer to "what is it doing"; `npm run ratchet:typecheck`
   *  is. */
  lastToolCommand: string | null;
  /** When that tool call began. Claude supplies the event timestamp; Codex is
   *  stamped when a live watcher first observes its timestamp-less item event.
   *  Historical Codex replay stays null rather than pretending replay time was
   *  the original start time. */
  lastToolAt: string | null;
  /** No `tool_result` has come back for it yet: it is still running. This is
   *  what stops "13 min" being printed against a command that finished in two
   *  seconds while the model thought for the other thirteen. */
  toolRunning: boolean;
  toolCalls: number;
  usage: RunUsage | null;
  resolvedModel: string | null;
  /** what the `result` event called an error, or null */
  resultError: string | null;
  /** Did a `result` event arrive at all? When the console was not there to read
   *  the exit code, this is the only evidence the run actually finished. */
  sawResult: boolean;
};

export function emptyTotals(): StreamTotals {
  return {
    agentSessionId: null,
    turns: 0,
    lastText: null,
    lastTool: null,
    lastToolCommand: null,
    lastToolAt: null,
    toolRunning: false,
    toolCalls: 0,
    usage: null,
    resolvedModel: null,
    resultError: null,
    sawResult: false,
  };
}

const COMMAND_MAX = 90;

/**
 * The one line that says what a tool call is actually doing. Bash carries a
 * `command`, the file tools carry a `file_path`, and anything else falls back to
 * whatever `description` it wrote — an honest "no command visible" beats a
 * guess, so an input with none of them gives null and the card shows the tool
 * name alone, exactly as it did before.
 */
export function toolCommandOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  const raw = [i.command, i.file_path, i.pattern, i.description].find((v) => typeof v === 'string' && v.trim());
  if (typeof raw !== 'string') return null;
  const flat = raw.trim().replace(/\s+/g, ' ');
  return flat.length > COMMAND_MAX ? `${flat.slice(0, COMMAND_MAX - 1)}…` : flat;
}

/**
 * Fold one stream-json line in. Returns a short label for the log, or null when
 * the line was not usable JSON — a stray blank line, or a fragment. Nothing here
 * throws: a stream we cannot parse must never take a worker down.
 */
function parsedLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function applyClaudeStreamLine(t: StreamTotals, msg: Record<string, unknown>): string {
  const at = typeof msg.timestamp === 'string' ? msg.timestamp : null;
  if (msg.type === 'assistant') {
    t.turns += 1;
    const content = (msg.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) t.lastText = b.text.trim();
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        t.lastTool = b.name;
        t.lastToolCommand = toolCommandOf(b.input);
        t.lastToolAt = at;
        t.toolRunning = true;
        t.toolCalls += 1;
      }
    }
  } else if (msg.type === 'user') {
    // The result came back, so whatever it was is over. Nothing here cares
    // WHICH call it belongs to: a stream is in order, and the only thing an
    // out-of-order pair could do is end the clock a beat early.
    const content = (msg.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_result') t.toolRunning = false;
    }
  } else if (msg.type === 'system' && msg.subtype === 'init') {
    if (typeof msg.model === 'string') t.resolvedModel = msg.model;
    if (typeof msg.session_id === 'string') t.agentSessionId = msg.session_id;
  } else if (msg.type === 'result') {
    t.sawResult = true;
    // The segment is over, so nothing is running inside it.
    t.toolRunning = false;
    if (msg.is_error) t.resultError = typeof msg.result === 'string' ? msg.result : 'worker reported an error';
    t.usage = parseResultUsage(msg);
  }
  return `${String(msg.type)}${msg.subtype ? '.' + String(msg.subtype) : ''}`;
}

function errorMessageOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value !== 'object' || value === null) return null;
  const error = value as Record<string, unknown>;
  return typeof error.message === 'string' && error.message.trim() ? error.message.trim() : null;
}

function codexToolOf(item: Record<string, unknown>): { name: string; command: string | null } | null {
  if (item.type === 'command_execution') {
    return { name: 'Bash', command: toolCommandOf({ command: item.command }) };
  }
  if (item.type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const first = changes.find((change): change is Record<string, unknown> => typeof change === 'object' && change !== null);
    return { name: 'apply_patch', command: toolCommandOf({ file_path: first?.path, description: item.description }) };
  }
  if (item.type === 'mcp_tool_call') {
    const server = typeof item.server === 'string' ? item.server : 'mcp';
    const tool = typeof item.tool === 'string' ? item.tool : typeof item.name === 'string' ? item.name : 'tool';
    return { name: `${server}.${tool}`, command: toolCommandOf(item.arguments) };
  }
  return null;
}

function applyCodexStreamLine(
  t: StreamTotals,
  msg: Record<string, unknown>,
  observedAt: string | null,
): string {
  const type = typeof msg.type === 'string' ? msg.type : 'unknown';
  if (type === 'thread.started') {
    if (typeof msg.thread_id === 'string' && msg.thread_id.trim()) t.agentSessionId = msg.thread_id.trim();
  } else if (type === 'item.started' || type === 'item.completed') {
    const item = typeof msg.item === 'object' && msg.item !== null ? (msg.item as Record<string, unknown>) : null;
    // A Codex turn is useful progress only once an agent message completes.
    // `turn.started` merely says the model was invoked; counting it made a run
    // look one turn further along before it had produced anything.
    if (
      type === 'item.completed' &&
      item?.type === 'agent_message' &&
      typeof item.text === 'string' &&
      item.text.trim()
    ) {
      t.turns += 1;
      t.lastText = item.text.trim();
    }
    if (item) {
      const tool = codexToolOf(item);
      if (tool && type === 'item.started') {
        t.lastTool = tool.name;
        t.lastToolCommand = tool.command;
        // Unlike Claude stream events, Codex JSONL item events do not currently
        // carry timestamps. The live tail may supply when it observed the event.
        // Historical readers deliberately supply nothing, so replay time can
        // never masquerade as the original tool start time.
        t.lastToolAt = typeof msg.timestamp === 'string' ? msg.timestamp : observedAt;
        t.toolRunning = true;
        t.toolCalls += 1;
      } else if (tool && type === 'item.completed') {
        // Some Codex item kinds are emitted only as completed. Count them once
        // if no matching start was observed; command executions normally have both.
        const completedOnly = t.lastTool !== tool.name || t.toolRunning === false;
        if (completedOnly) {
          t.lastTool = tool.name;
          t.lastToolCommand = tool.command;
          t.toolCalls += 1;
        }
        t.toolRunning = false;
      }
      // `item.type === "error"` includes non-terminal warnings (notably the
      // explicit hook-trust bypass warning). It is deliberately not a failure.
    }
  } else if (type === 'turn.completed') {
    t.sawResult = true;
    t.toolRunning = false;
    t.usage = parseCodexUsage(msg, t.turns);
  } else if (type === 'turn.failed') {
    t.sawResult = true;
    t.toolRunning = false;
    t.resultError = errorMessageOf(msg.error) ?? errorMessageOf(msg) ?? 'Codex turn failed';
  } else if (type === 'error') {
    t.sawResult = true;
    t.toolRunning = false;
    t.resultError = errorMessageOf(msg) ?? errorMessageOf(msg.error) ?? 'Codex reported an error';
  }
  return type;
}

/** Fold one provider JSONL event into the normalized live/run totals. */
export function applyAgentStreamLine(
  provider: AgentProviderId,
  t: StreamTotals,
  line: string,
  observation: { observedAt?: string | null } = {},
): string | null {
  const msg = parsedLine(line);
  if (!msg) return null;
  return provider === 'codex'
    ? applyCodexStreamLine(t, msg, observation.observedAt ?? null)
    : applyClaudeStreamLine(t, msg);
}

/** Backward-compatible Claude parser used by the existing tests and callers. */
export function applyStreamLine(t: StreamTotals, line: string): string | null {
  return applyAgentStreamLine('claude', t, line);
}

/**
 * The live tail: complete lines only, from a byte offset that only moves past a
 * newline.
 *
 * A worker writes a line in pieces, so a read can land in the middle of one.
 * That half-line is left exactly where it is and re-read next time — which is
 * why the offset is safe to persist and to resume from after a restart: no line
 * is ever parsed twice, and none is ever skipped.
 */
export class StreamTail {
  #file: string;
  #offset: number;

  constructor(file: string, offset = 0) {
    this.#file = file;
    this.#offset = Math.max(0, offset);
  }

  /** Bytes consumed as complete lines. The thing worth persisting. */
  get offset(): number {
    return this.#offset;
  }

  async read(): Promise<string[]> {
    const fh = await open(this.#file, 'r').catch(() => null);
    if (!fh) return [];
    try {
      const { size } = await fh.stat();
      // A file that shrank was replaced under us; start again rather than read
      // from a byte offset that now means something else.
      if (size < this.#offset) this.#offset = 0;
      if (size === this.#offset) return [];
      const buf = Buffer.allocUnsafe(size - this.#offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.#offset);
      const chunk = buf.subarray(0, bytesRead);
      const nl = chunk.lastIndexOf(0x0a);
      if (nl === -1) return []; // nothing complete yet — leave it all for next time
      this.#offset += nl + 1;
      // Splitting on the complete part only: the trailing fragment is not here.
      return chunk.subarray(0, nl).toString('utf8').split('\n');
    } finally {
      await fh.close();
    }
  }
}

/**
 * What one segment cost and did, read from its slice of the stream file in one
 * pass. Every path that ends a run — the child exiting under us, a re-attached
 * worker exiting, or one we find already over after a restart — goes through
 * this, so all three produce the same numbers.
 */
export async function readTotals(
  file: string,
  fromOffset = 0,
  provider: AgentProviderId = 'claude',
): Promise<StreamTotals> {
  const totals = emptyTotals();
  const raw = await readFile(file).catch(() => null);
  if (!raw) return totals;
  for (const line of raw.subarray(Math.max(0, fromOffset)).toString('utf8').split('\n')) {
    applyAgentStreamLine(provider, totals, line);
  }
  return totals;
}

/** The last `bytes` of a file, or ''. Used for the stderr tail, which is why it
 *  reads the END: an unbounded log must not become an unbounded read. */
export async function tailFile(file: string, bytes: number): Promise<string> {
  const fh = await open(file, 'r').catch(() => null);
  if (!fh) return '';
  try {
    const { size } = await fh.stat();
    const from = Math.max(0, size - bytes);
    const buf = Buffer.allocUnsafe(size - from);
    const { bytesRead } = await fh.read(buf, 0, buf.length, from);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await fh.close();
  }
}
