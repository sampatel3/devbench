import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendGateProvenance, parseGateHistory } from '../src/history.js';

describe('parseGateHistory — the append-only .gate-history.jsonl', () => {
  const line = (o: unknown) => JSON.stringify(o);

  const c = {
    issue: 4400,
    gate: 'C',
    stage: 4,
    sessionId: 'sess-abc',
    stoppedAt: '2026-08-11T09:00:00Z',
    reportPath: 'docs/issue-pipeline/plans/issue-4400-pr-body.md',
    summary: 'Built it, QA passed, three questions.',
    questions: ['Does the click-script pass?', 'What does an empty value show?'],
    evidence: [{ kind: 'screenshot', path: 'docs/issue-pipeline/plans/qa-4400/after.png', caption: 'after' }],
    decision: 'Gate C approved, proceed.',
    resumedAt: '2026-08-11T09:05:00Z',
  };

  it('reads one record with its decision and evidence', () => {
    const h = parseGateHistory(line(c));
    expect(h).toHaveLength(1);
    expect(h[0]!.gate).toBe('C');
    expect(h[0]!.decision).toBe('Gate C approved, proceed.');
    expect(h[0]!.questions).toHaveLength(2);
    expect(h[0]!.evidence[0]!.isImage).toBe(true);
    expect(h[0]!.resumedAt).toBe('2026-08-11T09:05:00Z');
    expect(h[0]!.provider).toBeNull();
  });

  it('joins append-only provider/model/session provenance without guessing old gates', () => {
    const provenance = JSON.stringify({
      issue: 4400,
      gate: 'C',
      sessionId: 'sess-abc',
      stoppedAt: '2026-08-11T09:00:00Z',
      provider: 'codex',
      account: 'codex-work',
      model: 'gpt-5.6-sol',
      agentSessionId: '019-codex-thread',
      recordedAt: '2026-08-11T09:01:00Z',
    });
    const record = parseGateHistory(line(c), provenance)[0]!;
    expect(record).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      agentSessionId: '019-codex-thread',
    });
  });

  it('appends provenance once per gate stop and joins repeated stops to the right round', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-gate-provenance-'));
    const file = join(dir, '.gate-provenance.jsonl');
    const first = {
      issue: 4400,
      gate: 'C' as const,
      sessionId: 'sess-abc',
      stoppedAt: '2026-08-11T09:00:00Z',
      provider: 'codex' as const,
      account: 'codex-work',
      model: 'gpt-5.6-sol',
      agentSessionId: 'codex-thread-first',
      recordedAt: '2026-08-11T09:01:00Z',
    };
    const second = {
      ...first,
      stoppedAt: '2026-08-11T10:00:00Z',
      model: 'gpt-5.6-terra',
      agentSessionId: 'codex-thread-second',
      recordedAt: '2026-08-11T10:01:00Z',
    };

    try {
      await appendGateProvenance(file, first);
      await appendGateProvenance(file, first);
      await appendGateProvenance(file, second);
      const raw = readFileSync(file, 'utf8');
      expect(raw.trim().split('\n')).toHaveLength(2);

      const rounds = parseGateHistory(
        [line(c), line({ ...c, stoppedAt: second.stoppedAt })].join('\n'),
        raw,
      );
      expect(rounds.map((round) => [round.model, round.agentSessionId])).toEqual([
        ['gpt-5.6-sol', 'codex-thread-first'],
        ['gpt-5.6-terra', 'codex-thread-second'],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The click-script and the quiz have to reach the permanent record too.
   *
   * A decided gate used to lose the whole QA the moment it was decided — the
   * `.gate.json` went into this log and nothing read `manualQa` back out. With
   * per-step ticks and a rework trail carried on those steps, that loss is the
   * record of what the operator checked by hand and what came back fixed. Those
   * verdicts are not here and never will be: they ride into `decision` inside
   * the approval the operator sent, which is the same trick the thread uses.
   */
  it('keeps the click-script and the quiz — a decided gate C no longer loses its QA', () => {
    const withQa = {
      ...c,
      manualQa: {
        appUrl: 'http://localhost:8106',
        start: 'a quote in Sent',
        steps: [
          {
            id: 1,
            rev: 2,
            do: 'Confirm with an empty reason',
            before: 'the modal accepted it',
            after: 'Confirm stays disabled',
            afterShot: 'docs/issue-pipeline/plans/qa-4400/s1-after-rev2.png',
            fix: 'disabled Confirm until a reason is typed',
          },
        ],
      },
      quiz: {
        brief: ['Withdraw asks first'],
        questions: [
          {
            question: 'What happens on an empty reason?',
            options: [
              { text: 'Confirm stays disabled', why: 'A reason is now required.' },
              { text: 'It withdraws anyway', why: 'That was the bug.' },
            ],
            correct: 0,
          },
        ],
      },
      decision: 'Gate C approved — every QA step verified by hand, quiz submitted (2/2). Proceed.',
    };
    const r = parseGateHistory(line(withQa))[0]!;
    expect(r.manualQa!.steps[0]!.rev).toBe(2);
    expect(r.manualQa!.steps[0]!.fix).toBe('disabled Confirm until a reason is typed');
    expect(r.manualQa!.start).toBe('a quote in Sent');
    expect(r.quiz!.questions[0]!.correct).toBe(0);
    // And how the ticks get here at all: inside the operator's own words.
    expect(r.decision).toContain('every QA step verified by hand');
  });

  it('has a null click-script and quiz on every record written before they existed', () => {
    const r = parseGateHistory(line(c))[0]!;
    expect(r.manualQa).toBeNull();
    expect(r.quiz).toBeNull();
  });

  it('reads many lines in file order — the audit trail is chronological', () => {
    const a = { ...c, gate: 'A', decision: 'Scope looks right.' };
    const b = { ...c, gate: 'B', decision: 'Plan approved.' };
    const h = parseGateHistory([line(a), line(b), line(c)].join('\n'));
    expect(h.map((r) => r.gate)).toEqual(['A', 'B', 'C']);
    expect(h.map((r) => r.decision)).toEqual(['Scope looks right.', 'Plan approved.', 'Gate C approved, proceed.']);
  });

  it('skips a corrupt line instead of throwing away the whole log', () => {
    const h = parseGateHistory([line(c), '{ half a line', line({ ...c, gate: 'D' })].join('\n'));
    expect(h.map((r) => r.gate)).toEqual(['C', 'D']);
  });

  it('ignores blank lines and trailing newline', () => {
    expect(parseGateHistory(`\n${line(c)}\n\n`)).toHaveLength(1);
  });

  it('tolerates a record with no decision recorded (older worker, or crash before resume)', () => {
    const noDecision = { ...c };
    delete (noDecision as Record<string, unknown>).decision;
    const h = parseGateHistory(line(noDecision));
    expect(h[0]!.decision).toBeNull();
  });

  it('drops a line that is not a valid gate record', () => {
    expect(parseGateHistory(line({ hello: 'world' }))).toEqual([]);
    expect(parseGateHistory(line({ issue: 1, gate: 'Z', summary: 'x' }))).toEqual([]);
  });

  it('is empty for an empty file', () => {
    expect(parseGateHistory('')).toEqual([]);
  });

  it('carries an empty evidence array when the record had none', () => {
    const noEvidence = { ...c, evidence: undefined };
    const h = parseGateHistory(line(noEvidence));
    expect(h[0]!.evidence).toEqual([]);
  });

  /**
   * The back-and-forth at a gate BEFORE it is decided is part of how that
   * decision was reached, so it belongs in the permanent record beside the
   * decision itself — not only on a card that disappears when the gate closes.
   */
  it('carries the question thread the worker wrote into the decided gate file', () => {
    const withThread = {
      ...c,
      thread: [
        { id: 1, q: 'which table does the role come from?', a: 'org_members', at: '2026-08-12T10:05:00.000Z' },
        { id: 2, q: 'and a NULL role?', a: 'treated as no role at all', at: '2026-08-12T10:09:00.000Z' },
      ],
    };
    const h = parseGateHistory(line(withThread));
    expect(h[0]!.thread).toHaveLength(2);
    expect(h[0]!.thread[1]!.q).toBe('and a NULL role?');
    expect(h[0]!.thread[1]!.a).toBe('treated as no role at all');
  });

  it('keeps the rest of a record whose thread is corrupt — a bad field is not a lost round', () => {
    const h = parseGateHistory(line({ ...c, thread: 'not an array' }));
    expect(h).toHaveLength(1);
    expect(h[0]!.thread).toEqual([]);
    expect(h[0]!.decision).toBe(c.decision);
  });

  it('carries an empty thread for every record written before asking existed', () => {
    expect(parseGateHistory(line(c))[0]!.thread).toEqual([]);
  });
});
