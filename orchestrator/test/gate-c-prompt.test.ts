/**
 * What gate C's buttons actually send.
 *
 * Gate C is the understanding gate, and every one of these strings is a payload
 * that reaches a real worker — so they are tested here rather than eyeballed in
 * a browser, on the same rule as gate-prompt.test.ts.
 *
 * Two of them exist because of a specific, observed failure: a worker read
 * CLAUDE.md's "never use the MCP browser tools", found `/browse` unregistered,
 * concluded browser QA was impossible, and offered the operator the CHOICE of
 * writing the Playwright script themselves. The prompt that answers that has
 * to name the sanctioned method, and must never read as a gate decision.
 */
import { describe, it, expect } from 'vitest';
import {
  approvalLineC,
  approveCPrompt,
  askForQuizPrompt,
  askForScriptPrompt,
  askForShotsPrompt,
  type GateCRecord,
} from '../../ui/src/gate.js';
import { parseManualQa } from '../src/manual-qa.js';

const TYPED_WORDS = '1. it hides the pills for org admins 2. yes, the empty list case';

/** A clean gate: nine steps ticked, nothing sent back, quiz submitted 2 of 3. */
const RECORD: GateCRecord = {
  qa: { total: 9, verified: 9, reworkedIds: [] },
  quiz: {
    score: 2,
    total: 3,
    lines: [
      { n: 1, right: true, question: 'What does a sysadmin now see?', picked: 'The pills', correct: 'The pills' },
      {
        n: 2,
        right: false,
        question: 'What happens with no orgs?',
        picked: 'It crashes',
        correct: 'An empty list, no pills',
      },
      { n: 3, right: true, question: 'What is not proven here?', picked: 'Mobile', correct: 'Mobile' },
    ],
  },
};

describe('Approve gate C', () => {
  it('states BOTH things gate C requires — QA passed, and understanding', () => {
    expect(approvalLineC).toMatch(/manual QA/i);
    expect(approvalLineC).toMatch(/understand/i);
  });

  it('still says the words the skill waits for', () => {
    // The skill's rule is an explicit approval at this gate. Saying more than
    // "Gate C approved" is the point; saying less would not pass it.
    expect(approvalLineC).toContain('Gate C approved');
  });

  it('leads with the canned line, and adds the record even when the box is empty', () => {
    const p = approveCPrompt('  \n ', RECORD);
    expect(p.startsWith(approvalLineC)).toBe(true);
    expect(p).toContain('QA record: 9 of 9 steps ticked verified by hand.');
    expect(p).not.toContain('I also said');
  });

  /**
   * The bug this whole module exists for: Approve once sent only the canned line
   * and silently dropped three typed answers, and the worker went and took all
   * three of its own recommendations instead.
   */
  it('carries the typed answers — the words-always-go rule, unregressed', () => {
    const p = approveCPrompt(TYPED_WORDS, RECORD);
    expect(p).toContain(TYPED_WORDS);
    expect(p.endsWith(TYPED_WORDS)).toBe(true);
  });

  /**
   * A gate passed OVER a warning has to say so where it lasts. The prompt is
   * what the worker writes into `.gate-history.jsonl` as the decision, so this
   * is the difference between "approved" and "approved with step
   * 3's before-shot still missing" — and the second one is the true sentence.
   */
  it('records the warnings the operator accepted, above their own words', () => {
    const accepted = 'Accepted with this warning outstanding, deliberately:\n- Step 3 is missing screenshot evidence';
    const p = approveCPrompt(TYPED_WORDS, { ...RECORD, accepted });
    expect(p).toContain(accepted);
    expect(p.indexOf(accepted)).toBeLessThan(p.indexOf(TYPED_WORDS));
    expect(p.endsWith(TYPED_WORDS)).toBe(true); // the operator's words are still last
  });

  it('claims nothing when the gate had no warning on it', () => {
    expect(approveCPrompt('', { ...RECORD, accepted: '' })).not.toContain('Accepted with');
    expect(approveCPrompt('', RECORD)).not.toContain('Accepted with');
  });

  it('passes awkward text through verbatim — no summarising, no reformatting', () => {
    const awkward = 'Do NOT touch `useOrgFilter`.\n\n- one\n- two\n\nAnd: "keep the flag name".';
    expect(approveCPrompt(awkward, RECORD)).toContain(awkward);
  });

  /**
   * The approval prompt is what the worker writes into `.gate-history.jsonl` as
   * the `decision`. So the ticks and the graded quiz reach the permanent ledger
   * with no new plumbing — which is the only place they are ever written down
   * outside the console's own state file.
   */
  it('records what was actually checked: the ticks, and every question graded', () => {
    const p = approveCPrompt('', RECORD);
    expect(p).toContain('QA record: 9 of 9 steps ticked verified by hand.');
    expect(p).toContain('Quiz record (2/3):');
    expect(p).toContain('1. right — What does a sysadmin now see?');
    // A miss is named, with what the operator thought and what was true — that is
    // the one thing worth telling the worker about their understanding.
    expect(p).toContain('2. missed — What happens with no orgs? (I picked "It crashes"; the answer was "An empty list, no pills")');
  });

  it('says which steps had to go back, so a fixed step is not silently a clean one', () => {
    const p = approveCPrompt('', { ...RECORD, qa: { total: 9, verified: 9, reworkedIds: [4] } });
    expect(p).toContain('Step 4 failed, was fixed, and was re-verified after the fix.');
    const two = approveCPrompt('', { ...RECORD, qa: { total: 9, verified: 9, reworkedIds: [4, 7] } });
    expect(two).toContain('Steps 4 and 7 failed, were fixed, and were re-verified after the fix.');
  });
});

describe('Ask for the quiz', () => {
  const p = askForQuizPrompt();

  it('says what it is NOT, and re-parks at the same gate', () => {
    expect(p.split('.')[0]).toMatch(/NOT an approval/);
    expect(p).not.toMatch(/\bapproved\b/);
    expect(p).toMatch(/stop at gate C again/i);
  });

  /** It must not cost a QA re-run: that is the waste the whole rework design is about. */
  it('changes no code and re-runs no QA', () => {
    expect(p).toMatch(/change no code/i);
    expect(p).toMatch(/re-run no QA/i);
  });

  it('does not ask the worker to throw away the rest of the gate file', () => {
    expect(p).toMatch(/Keep the summary, evidence and manualQa exactly as they are/);
  });

  it('names the fields the parser reads, so a compliant worker renders', () => {
    for (const field of ['brief', 'questions', 'context', 'question', 'options', 'correct', 'text', 'why']) {
      expect(p).toContain(field);
    }
  });

  it('asks for consequences, not implementation — the rule that makes a question worth answering', () => {
    expect(p).toMatch(/consequences, never implementation/i);
  });
});

describe('Tell it to capture screenshots', () => {
  const p = askForShotsPrompt();

  it('says what it is NOT before it says anything else', () => {
    expect(p.split('.')[0]).toMatch(/NOT an approval/);
    // "approved" is the word the skill matches on to pass a gate. It appears
    // nowhere here, so this can never be read as one.
    expect(p).not.toMatch(/\bapproved\b/);
  });

  it('names the sanctioned method, so "browser QA is impossible" cannot be concluded again', () => {
    expect(p).toContain('Playwright');
    expect(p).toContain('headless');
    expect(p).toContain('page.screenshot');
    expect(p).toMatch(/references\/qa\.md/);
  });

  it('disarms the /browse rule by name rather than leaving the worker to reason about it', () => {
    expect(p).toContain('/browse');
    expect(p).toMatch(/MCP browser tools/);
  });

  it('refuses to let the capture be handed back to the operator — the actual complaint', () => {
    expect(p).toMatch(/never hand the capture back to me/i);
  });

  it('says where the files go and that they must be listed as evidence', () => {
    expect(p).toContain('docs/issue-pipeline/plans/qa-');
    expect(p).toContain('evidence');
  });

  it('re-parks at gate C: this is one more round of the same gate, not the next stage', () => {
    expect(p).toMatch(/stop at gate C again/i);
  });

  it('never uses a real credential', () => {
    expect(p).toMatch(/local-dev account/);
    expect(p).not.toMatch(/UAT|production/i);
  });
});

describe('Ask for the click-script', () => {
  const p = askForScriptPrompt();

  it('says what it is NOT, and re-parks at the same gate', () => {
    expect(p.split('.')[0]).toMatch(/NOT an approval/);
    expect(p).not.toMatch(/\bapproved\b/);
    expect(p).toMatch(/stop at gate C again/i);
  });

  it('asks for the localhost fence and a published credential, in those words', () => {
    expect(p).toMatch(/localhost only/);
    expect(p).toMatch(/never a real credential/);
  });

  it('does not ask the worker to throw away the rest of the gate file', () => {
    expect(p).toMatch(/Keep the summary, questions, evidence and quiz exactly as they are/);
  });

  /**
   * In manual QA the before and the after belong to ONE step, not one step for
   * the before and another for the after. The shape enforces it, but the prompt
   * has to SAY it, or a worker writes "step 4: look at how it was" and "step 5:
   * now look at it" and technically complies with the schema.
   */
  it('says before and after are ONE step, and that the ids carry the ticks', () => {
    expect(p).toMatch(/`before` and `after` are the SAME step/);
    expect(p).toMatch(/never one step for the before and another for the after/);
    expect(p).toMatch(/never renumbered/);
    expect(p).toMatch(/my ticks hang on/);
  });

  /**
   * The load-bearing one. The console can only render STRUCTURE — a click-script
   * in prose is exactly the thing the operator could not reach. So the fields
   * this prompt names have to be the fields the parser reads: if the two ever drift, a
   * worker does as it was told and the card still shows "No click-script."
   */
  it('names fields that parse into a complete click-script', () => {
    const asDescribed = {
      appUrl: 'http://localhost:5173/organisations',
      login: { email: 'sysadmin@localdev.test', password: 'localdev123!' },
      start: 'Seed script creates two orgs; use either.',
      steps: [
        {
          id: 1,
          rev: 1,
          do: 'Click "Organisations" in the left nav',
          url: 'http://localhost:5173/organisations',
          before: 'No pills — the list was unfiltered',
          beforeShot: 'docs/issue-pipeline/plans/qa-4336/s1-before.png',
          after: 'A row of filter pills above the table',
          afterShot: 'docs/issue-pipeline/plans/qa-4336/s1-after.png',
        },
      ],
    };
    for (const field of Object.keys(asDescribed)) expect(p).toContain(field);
    for (const field of ['id', 'rev', 'do', 'url', 'before', 'beforeShot', 'after', 'afterShot']) {
      expect(p).toContain(field);
    }

    const parsed = parseManualQa(asDescribed);
    expect(parsed).not.toBeNull();
    expect(parsed!.appUrl).toBe(asDescribed.appUrl);
    expect(parsed!.login).toEqual(asDescribed.login);
    expect(parsed!.start).toBe(asDescribed.start);
    expect(parsed!.steps).toHaveLength(1);
    expect(parsed!.steps[0]!.after).toBe('A row of filter pills above the table');
    expect(parsed!.steps[0]!.beforeShot).toBe('docs/issue-pipeline/plans/qa-4336/s1-before.png');
    expect(parsed!.steps[0]!.rev).toBe(1);
  });
});

describe('All three red-block prompts', () => {
  it('are never empty — a resume that sends nothing is a dead button', () => {
    expect(askForShotsPrompt().trim().length).toBeGreaterThan(80);
    expect(askForScriptPrompt().trim().length).toBeGreaterThan(80);
    expect(askForQuizPrompt().trim().length).toBeGreaterThan(80);
  });

  it('are stable strings, so the same click always sends the same words', () => {
    expect(askForShotsPrompt()).toBe(askForShotsPrompt());
    expect(askForScriptPrompt()).toBe(askForScriptPrompt());
    expect(askForQuizPrompt()).toBe(askForQuizPrompt());
  });
});
