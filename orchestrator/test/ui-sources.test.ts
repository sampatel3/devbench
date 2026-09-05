import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');

describe('the worker console stays focused on tickets', () => {
  it('has no demo-console route, runtime, navigation or bundle split', () => {
    expect(read('orchestrator/src/server.ts')).not.toContain('/api/demo');
    expect(read('ui/src/main.tsx')).not.toContain('DemoConsole');
    expect(read('ui/src/App.tsx')).not.toContain('/demo-kit');
    expect(read('ui/src/styles.css')).not.toContain('.new-demo');
  });

  it('leads with ticket completion and source connections', () => {
    const app = read('ui/src/App.tsx');
    for (const label of ['Tickets', 'Overview', 'Activity', 'System', 'Settings', 'Guide']) {
      expect(app).toContain(`label: '${label}'`);
    }
    expect(app).toContain('tickets → done');
    expect(app).toContain('Connect where tickets are assigned');

    // Source connections moved OUT of the Tickets tab and into the header, in a
    // group that is deliberately not the view switcher: the old `Work sources`
    // panel put a second heading and a broken expander above the rail, and its
    // `Sync sources` button sat one row under a `Refresh` that looked like a
    // seventh tab. Chips, sync and connections now live together on the right.
    expect(app).toContain('className="tools"');
    expect(app).toContain('source-chip');
    expect(app).toContain('function SyncControl(');
    expect(app).toContain('>\n            Connections\n          </button>');
  });

  /** The panel is gone, and must not drift back: it duplicated the rail, which
   *  already lists every assigned ticket and now has a search over it. */
  it('does not reintroduce the Work sources panel above the rail', () => {
    const app = read('ui/src/App.tsx');
    expect(app).not.toContain('Find assigned tickets, issues and stories');
    expect(app).not.toContain('Show all ${items.length}');
    expect(app).not.toContain('function WorkInbox(');
  });
});

describe('a stale comment wait can be cleared without running a worker', () => {
  const app = read('ui/src/App.tsx');
  const start = app.indexOf('function BlockedCard(');
  const end = app.indexOf('\n/**\n * A PR got a review', start);
  const card = app.slice(start, end);

  it('offers the action only in the no-reply side of the blocked card', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(card.indexOf('Resolved — no reply needed')).toBeGreaterThan(card.indexOf(') : ('));
    expect(card).toContain('This does not run or');
    expect(card).toContain('restart a worker, and it changes nothing on GitHub.');
  });

  it('uses the resolve route and immediately refreshes the displayed state', () => {
    expect(card).toContain(
      'post(`/api/issues/${row.number}/comment-block/resolve`, { postedAt: b.postedAt })',
    );
    expect(card).toContain('if (!out.ok) return;');
    expect(card).toContain('wait resolved; display refresh failed — reload');
    expect(app).toContain("const response = await fetch('/api/state');");
    expect(app).toContain('onRefresh={refreshState}');
  });

  it('never offers stale follow-up actions after the issue is done', () => {
    expect(app).toContain("row.status !== 'done' && !row.live && !row.gate && row.commentBlock");
    expect(app).toContain(
      "row.status !== 'done' && !row.live && !row.gate && !row.commentBlock && row.commentRequest",
    );
  });
});

describe('a drafted decision is one compact question on the surface it affects', () => {
  const app = read('ui/src/App.tsx');
  const start = app.indexOf('function CommentCard(');
  const end = app.indexOf('\n/** The ticket is parked on a posted comment', start);
  const card = app.slice(start, end);

  it('carries the structured kind, target and question in the UI contract', () => {
    const types = read('ui/src/types.ts');
    expect(types).toContain("kind?: 'decision' | 'handoff';");
    expect(types).toContain("target?: { kind: 'issue' | 'pr'; number: number };");
    expect(types).toContain('context?: string;');
    expect(types).toContain('question?: string;');
  });

  it('names the addressee and PR directly instead of saying generic ticket comment', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(card).toContain("const targetLabel = target.kind === 'pr' ? `PR #${target.number}` : `#${target.number}`;");
    expect(card).toContain('`Question for ${addressee} — post on ${targetLabel}?`');
    expect(card).toContain("{isDecision ? 'Post this question' : 'Post this comment'}");
    expect(card).not.toContain('Draft comment — post to the ticket?');
  });

  it('keeps the decision branch compact and leaves workflow detail to handoffs', () => {
    const decisionStart = card.indexOf('{isDecision ? (');
    const handoffStart = card.indexOf(') : (', decisionStart);
    const decision = card.slice(decisionStart, handoffStart);

    expect(decisionStart).toBeGreaterThan(0);
    expect(handoffStart).toBeGreaterThan(decisionStart);
    expect(decision).toContain('<p className="note">{req.why}</p>');
    expect(decision).not.toContain('<dl');
    expect(decision).not.toContain('<dt>why</dt>');
    expect(decision).not.toContain('<dt>after posting</dt>');

    expect(card).toContain('continues — no reply needed');
    expect(card).not.toContain('informational — no reply required');
  });
});
