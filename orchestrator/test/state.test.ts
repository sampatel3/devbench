import { describe, it, expect } from 'vitest';
import { gateFileOrRefusal, parseGateFile, parseIssueState } from '../src/state.js';

describe('parseGateFile', () => {
  const good = JSON.stringify({
    issue: 4336,
    gate: 'C',
    stage: 4,
    sessionId: '607391ba-49a4-4966-bd9e-8aa8790f16bb',
    stoppedAt: '2026-08-10T21:14:03Z',
    reportPath: 'docs/issue-pipeline/plans/issue-4336-pr-body.md',
    summary: 'Stopped for your QA pass.',
    questions: ['Does the click-script pass?', 'Anything unclear in the walkthrough?'],
  });

  it('reads a well-formed gate file', () => {
    const g = parseGateFile(good);
    expect(g).not.toBeNull();
    expect(g!.issue).toBe(4336);
    expect(g!.gate).toBe('C');
    expect(g!.stage).toBe(4);
    expect(g!.questions).toHaveLength(2);
    expect(g!.reportPath).toBe('docs/issue-pipeline/plans/issue-4336-pr-body.md');
  });

  it('returns null on malformed JSON rather than throwing', () => {
    expect(parseGateFile('{ this is not json')).toBeNull();
  });

  it('returns null when the gate letter is not A-E — a bad gate must not park a worker', () => {
    expect(parseGateFile(JSON.stringify({ issue: 1, gate: 'Z', summary: '' }))).toBeNull();
    expect(parseGateFile(JSON.stringify({ issue: 1, summary: '' }))).toBeNull();
  });

  it('lower-cases gates are accepted and normalised', () => {
    expect(parseGateFile(JSON.stringify({ issue: 1, gate: 'c', summary: 'x' }))!.gate).toBe('C');
  });

  it('tolerates the optional fields being absent', () => {
    const g = parseGateFile(JSON.stringify({ issue: 4342, gate: 'D', summary: 'ready' }));
    expect(g).toEqual({
      issue: 4342,
      gate: 'D',
      stage: null,
      sessionId: null,
      stoppedAt: null,
      reportPath: null,
      summary: 'ready',
      questions: [],
      // Absent CI at gate D is genuinely nothing to say — CI is not the question
      // until the handover. At gate E the same absence is `unconfirmed` instead,
      // because there silence IS the finding (gate-ci.test.ts).
      ci: null,
    });
  });

  it('drops non-string questions instead of rendering [object Object]', () => {
    const g = parseGateFile(JSON.stringify({ issue: 1, gate: 'A', summary: 's', questions: ['ok', { a: 1 }, 3] }));
    expect(g!.questions).toEqual(['ok']);
  });

  it('returns null when issue is missing — we would not know whose gate it is', () => {
    expect(parseGateFile(JSON.stringify({ gate: 'A', summary: 's' }))).toBeNull();
  });
});

/**
 * Null is the right answer for `.gate.json` — "this worker is not parked" needs
 * no explanation. It is the wrong answer for a line of `.gate-history.jsonl`,
 * where it means a round is gone: two of them went missing on this machine
 * because workers wrote invented gate letters. Same rules, one extra sentence.
 */
describe('gateFileOrRefusal — the same parse, saying why it refused', () => {
  const refusal = (o: unknown) => {
    const r = gateFileOrRefusal(typeof o === 'string' ? o : JSON.stringify(o));
    return 'refused' in r ? r.refused : null;
  };

  it('names an invented gate letter, verbatim — that is what makes it findable', () => {
    expect(refusal({ issue: 4400, gate: 'B-postscript', summary: 's' })).toBe("bad gate letter 'B-postscript'");
    expect(refusal({ issue: 4400, gate: 'B-resume-note', summary: 's' })).toBe("bad gate letter 'B-resume-note'");
  });

  it('tells "no letter at all" apart from "a letter we do not allow"', () => {
    expect(refusal({ issue: 4400, summary: 's' })).toBe('no gate letter');
    expect(refusal({ issue: 4400, gate: 3, summary: 's' })).toBe('bad gate letter \'3\'');
  });

  it('names the other two refusals', () => {
    expect(refusal('{ half a line')).toBe('not valid JSON');
    expect(refusal('"a string"')).toBe('not a JSON object');
    expect(refusal({ gate: 'A', summary: 's' })).toBe('no issue number');
  });

  it('truncates a runaway value so one bad line cannot take over a card', () => {
    const said = refusal({ issue: 1, gate: 'B'.repeat(300), summary: 's' })!;
    expect(said.length).toBeLessThan(60);
    expect(said.endsWith("…'")).toBe(true);
  });

  it('agrees with parseGateFile on every input — one rule, one place', () => {
    for (const raw of ['{ half a line', '"x"', '{"issue":1}', '{"issue":1,"gate":"c","summary":"s"}']) {
      const r = gateFileOrRefusal(raw);
      expect(parseGateFile(raw)).toEqual('gate' in r ? r.gate : null);
    }
  });
});

describe('parseIssueState', () => {
  // Trimmed from the real .worktrees/issue-4336-org-sysadmin-filter-pills/.issue-state.md
  const md4336 = `# Issue #4336 — Organizations Sysadmin Filter Pills Bug

- **Branch**: \`fix/issue-4336-org-sysadmin-filter-pills\` (0 commits ahead of origin/dev)
- **Worktree**: \`.worktrees/issue-4336-org-sysadmin-filter-pills\`
- **Dev-server port**: **8083** — never started, per D5
- **Stage reached**: 4 complete — **STOPPED AT GATE C**
- **Gates passed**: A ✅, B ✅ (both approved by coordinator). C — awaiting the operator.
`;

  // Trimmed from the real .worktrees/issue-4334-branded-auth-email-links/.issue-state.md
  const md4334 = `# Issue #4334 — Branded Auth Email Links

- **Branch**: \`fix/issue-4334-branded-auth-email-links\`
- **Dev-server port**: **8081** (8080 primary/dev, 8082 = #4342, 8083 = #4336) — NOT started this run
- **Stage reached**: 2 complete — **awaiting GATE A + GATE B** (scope + plan sign-off)
- **Gates passed**: none
`;

  const md4342 = `# Issue #4342 — Quote Preview Notice Pills + 100% Default Zoom

- **Branch**: \`feat/issue-4342-quote-preview-notice-pills\`
- **Dev server**: http://localhost:8082 (running)
- **Stage reached**: 7 — PR #4368 open, awaiting review / GATE E (merge)
- **Gates passed**: A (scope), B (plan), C (manual QA + comprehension), D (raise PR)
`;

  it('reads #4336 as stopped at Gate C, stage 4, gates A and B passed', () => {
    const s = parseIssueState(md4336);
    expect(s.stage).toBe(4);
    expect(s.stoppedAtGate).toBe('C');
    expect(s.gatesPassed).toEqual(['A', 'B']);
    expect(s.port).toBe(8083);
    expect(s.branch).toBe('fix/issue-4336-org-sysadmin-filter-pills');
  });

  it('reads #4334 as stage 2 with no gate stop recorded and no gates passed', () => {
    const s = parseIssueState(md4334);
    expect(s.stage).toBe(2);
    expect(s.stoppedAtGate).toBeNull();
    expect(s.gatesPassed).toEqual([]);
    expect(s.port).toBe(8081);
  });

  it('does not read "awaiting GATE E" in a stage line as a recorded stop', () => {
    // #4342 is at stage 7 with a PR open. "awaiting review / GATE E" is prose about
    // what comes next, not a worker parked at a gate. Only "STOPPED AT GATE x" counts.
    const s = parseIssueState(md4342);
    expect(s.stoppedAtGate).toBeNull();
    expect(s.stage).toBe(7);
    expect(s.gatesPassed).toEqual(['A', 'B', 'C', 'D']);
  });

  it('survives a file with none of the fields', () => {
    expect(parseIssueState('# nothing here')).toEqual({
      stage: null,
      gatesPassed: [],
      stoppedAtGate: null,
      port: null,
      branch: null,
    });
  });
});
