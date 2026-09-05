/**
 * The decisions gate C's card makes, as pure functions.
 *
 * Two of them, and they are here rather than inside the component because each
 * one is a rule the operator stated and a rule is worth testing without a
 * browser:
 *
 *  - `approveLockC` — WHY Approve is locked, written as the button's own label.
 *    One blocker at a time, in a fixed order, so the reason is never a paragraph
 *    and never a tooltip to hunt for.
 *  - `parseGateSummary` — the summary as labelled bullets. A 250-word block at
 *    the top of a gate C was reported as too wordy to read, and asked to be
 *    bulleted. A worker that writes the labelled shape gets rendered as bullets;
 *    one that writes a paragraph anyway gets clamped rather than expanded,
 *    because the console must not make an essay worse.
 */
import type { ManualQaStep, QaProgress } from './types';

/** One step that came back without a capture it owed, and which leg(s) are gone.
 *
 *  `gone` is the subset of `legs` that NAMED a file which is not there, rather
 *  than naming nothing. Present only when non-empty. */
export type MissingShot = { id: number; legs: Array<'before' | 'after'>; gone?: Array<'before' | 'after'> };

/**
 * WHICH STEPS CAME BACK WITHOUT THE PICTURES THEY OWE.
 *
 * The operator's rule: an after shot and a before shot are both required, unless
 * there is no before to photograph — a genuinely new feature. Two lines, one
 * exception:
 *
 *  - `afterShot` is required on every step, with no exception. It is the half
 *    that is always capturable — the change is in front of the worker as it
 *    writes — so a step without one is a claim about what the app does now with
 *    nothing behind it.
 *  - `beforeShot` is required on every step that SAYS what it used to do. The
 *    one exception is `"before": null` with `"beforeShot": null`, the gate
 *    file's way of saying the behaviour is genuinely new and there was nothing
 *    to photograph. That pair IS the statement, and the card prints "New —
 *    nothing to compare" for it.
 *
 * The case this exists to catch is a step that names a prior behaviour and shows
 * no picture of it: you are being asked to take the before on trust, which is the
 * one thing screenshots exist to stop.
 *
 * `orchestrator/src/manual-qa.ts` holds the same rule for the server's own
 * refusal — the two halves of this console share no code — and
 * `gate-c-missing-shots.test.ts` runs both over one table.
 */
export function missingShots(steps: ManualQaStep[]): MissingShot[] {
  const out: MissingShot[] = [];
  for (const step of steps) {
    // A DECLARED path with no file behind it owes the same picture as no path.
    // It is the case that used to slip through both halves of this rule: the
    // gate went green over a step whose only evidence was a broken image.
    const gone = step.goneShots ?? [];
    const legs: Array<'before' | 'after'> = [];
    // `before` non-null is the step's own claim that there WAS a prior state.
    if ((step.beforeShot === null && step.before !== null) || gone.includes('before')) legs.push('before');
    if (step.afterShot === null || gone.includes('after')) legs.push('after');
    if (legs.length > 0) {
      const absent = legs.filter((l) => gone.includes(l));
      out.push(absent.length > 0 ? { id: step.id, legs, gone: absent } : { id: step.id, legs });
    }
  }
  return out;
}

/** The missing captures as one sentence, so the button label and the server's
 *  refusal say the same thing. */
export function missingShotsLine(missing: MissingShot[]): string {
  if (missing.length === 0) return '';
  if (missing.length > 1) {
    return `${missing.length} steps are missing screenshots (${missing.map((m) => m.id).join(', ')})`;
  }
  const one = missing[0]!;
  const legs = one.legs.length === 2 ? 'its before and after screenshots' : `its "${one.legs[0]}" screenshot`;
  return `step ${one.id} is missing ${legs}`;
}

/**
 * ONE WARNING, AS THE CARD SHOWS IT.
 *
 * The operator asked for warnings to be clear in the console. Before this they
 * were scattered — a grey note under the click-script for a short rework, an
 * orange line at the top for code landing after the QA, a red block inside
 * section 2, a fourth thing inside the quiz — each styled by whoever added it,
 * and the button's label the only place that said whether any of them actually
 * stopped anything. So every warning is now one of these, in one place, and its
 * `level` says what it costs you:
 *
 *  - `blocking` — the card is showing LESS than the gate is being asked to pass
 *    (a rework that came back short, entries the parsers had to drop). Approve
 *    stays shut whatever you do, because the thing to fix is not yours to accept.
 *  - `accept` — real, and your call. Approve opens once you tick that you have
 *    read it, and what you accepted rides into the approval and the gate history.
 *  - `note` — worth knowing, costs nothing.
 *
 * `ask` names the one-click send-back where there is one, so the message that
 * fixes a warning sits inside the block that raises it.
 */
export type GateWarning = {
  /** Stable across repaints — the acceptance is keyed on the set of these. */
  key: string;
  level: 'blocking' | 'accept' | 'note';
  title: string;
  detail: string;
  ask?: 'shots' | 'script' | 'quiz';
};

/**
 * Every warning outstanding on a gate C card, most costly first.
 *
 * Pure, so the set you are shown and the set your approval records are the same
 * list computed once — and so this can be tested without a browser, like the
 * lock it feeds.
 */
export function gateWarnings(input: {
  missingShots: MissingShot[];
  /** The console's accusation about the last rework's return, or null. */
  violation: string | null;
  droppedSteps: number;
  droppedQuestions: number;
  /** Commits on the branch that landed after the QA you are looking at. */
  codeSinceQa: { approvedAt: string; headNow: string } | null;
  /** Questions you left unanswered at the last gate you approved. */
  leftUnanswered: string[];
}): GateWarning[] {
  const out: GateWarning[] = [];

  if (input.violation) {
    out.push({
      key: 'rework-violation',
      level: 'blocking',
      title: 'The last rework came back short',
      // Capitalised: the accusation is composed as a clause ("the rework came
      // back without steps 2, 3") and it lands here as the first sentence after
      // a bold title.
      detail: `${input.violation.charAt(0).toUpperCase()}${input.violation.slice(1)} Send feedback asking for it back — this one is not yours to accept.`,
    });
  }
  if (input.droppedSteps > 0) {
    const n = input.droppedSteps;
    out.push({
      key: 'dropped-steps',
      level: 'blocking',
      title: `${n} QA step${n === 1 ? '' : 's'} came back malformed`,
      detail:
        `${n === 1 ? 'One step' : `${n} steps`} could not be read and ${n === 1 ? 'is' : 'are'} not on this card, ` +
        'so the click-script you can see is shorter than the one the worker wrote.',
      ask: 'script',
    });
  }
  if (input.droppedQuestions > 0) {
    const n = input.droppedQuestions;
    out.push({
      key: 'dropped-questions',
      level: 'blocking',
      title: `${n} quiz question${n === 1 ? '' : 's'} came back malformed`,
      detail: 'This quiz is shorter than the one the worker wrote, and a voided question is invisible otherwise.',
      ask: 'quiz',
    });
  }
  if (input.missingShots.length > 0) {
    const m = input.missingShots;
    // The steps whose capture was NAMED and is not on disk. Worth its own
    // sentence: "add the missing screenshot" is the wrong instruction for a
    // worker that already wrote the field, and it is the difference between
    // asking for evidence and asking for the file it promised.
    const absent = m.filter((x) => (x.gone?.length ?? 0) > 0);
    out.push({
      // Gone-ness is part of the identity, so a leg that goes from "no path" to
      // "path with no file" raises a NEW warning rather than inheriting the tick
      // given to the old one. Appended only when there is some, so an ordinary
      // missing shot keeps the key it has always had.
      key:
        `missing-shots:${m.map((x) => `${x.id}/${x.legs.join('+')}`).join(',')}` +
        (absent.length > 0 ? `!gone:${absent.map((x) => `${x.id}/${x.gone!.join('+')}`).join(',')}` : ''),
      level: 'accept',
      title:
        m.length === 1
          ? `Step ${m[0]!.id} is missing screenshot evidence`
          : `${m.length} steps are missing screenshot evidence`,
      detail:
        'Both legs are required on every step — the was and the after. Missing: ' +
        m.map((x) => `step ${x.id} (${x.legs.join(' and ')})`).join(', ') +
        '. The only step that may show no before is one where there was nothing there before — a new feature — ' +
        'and the worker says that by leaving both the before and its shot empty.' +
        (absent.length > 0
          ? ' ' +
            (absent.length === 1 && absent[0]!.gone!.length === 1
              ? `Step ${absent[0]!.id} NAMED its "${absent[0]!.gone![0]}" capture and that file is not in the worktree`
              : `These named a capture that is not in the worktree: ${absent
                  .map((x) => `step ${x.id} (${x.gone!.join(' and ')})`)
                  .join(', ')}`) +
            ' — the path is in the gate file and the picture never was, which is what the empty box on the step is.'
          : '') +
        ' Ask for the shot, or accept the gate without it.',
      ask: 'shots',
    });
  }
  if (input.codeSinceQa) {
    out.push({
      key: `code-since-qa:${input.codeSinceQa.headNow}`,
      level: 'accept',
      title: 'Code has landed since your QA',
      detail:
        `You approved gate C against ${input.codeSinceQa.approvedAt.slice(0, 9)}; the branch is now on ` +
        `${input.codeSinceQa.headNow.slice(0, 9)}. Your walkthrough did not cover it.`,
    });
  }
  if (input.leftUnanswered.length > 0) {
    const n = input.leftUnanswered.length;
    out.push({
      key: 'left-unanswered',
      level: 'note',
      title: `You left ${n === 1 ? 'a question' : `${n} questions`} unanswered at the last gate you approved`,
      detail: `The worker will have picked its own answer: ${input.leftUnanswered.map((q) => `“${q}”`).join('; ')}`,
    });
  }
  return out;
}

/** The warnings you have to tick before Approve opens. */
export const toAccept = (warnings: GateWarning[]): GateWarning[] => warnings.filter((w) => w.level === 'accept');

/** The ones no tick can clear. */
export const blocking = (warnings: GateWarning[]): GateWarning[] => warnings.filter((w) => w.level === 'blocking');

/** What the approval records: one line per warning you accepted. */
export function acceptedLine(warnings: GateWarning[]): string {
  const list = toAccept(warnings);
  if (list.length === 0) return '';
  return [
    `Accepted with ${list.length === 1 ? 'this warning' : `these ${list.length} warnings`} outstanding, deliberately:`,
    ...list.map((w) => `- ${w.title}`),
  ].join('\n');
}

/** What the Approve button says right now, and whether it can be pressed. */
export type ApproveLock = { locked: boolean; label: string };

/**
 * Approve unlocks when EVERY step is ticked verified AND the quiz has been
 * submitted. Getting a quiz answer wrong blocks nothing — the wrong answer is
 * where the learning is. Skipping the quiz does block.
 *
 * The order is the order you can act in: a failed step needs a decision before an
 * unset one is worth counting, and the quiz is the half you can finish in a
 * minute at your desk. Zero steps locks it too — that closes the loophole of a
 * worker emitting an empty `steps` array to skip QA altogether.
 */
export function approveLockC(input: {
  progress: QaProgress | null;
  /** The steps you have ticked Failed, by id, in step order. */
  failedIds: number[];
  hasQuiz: boolean;
  quizSubmitted: boolean;
  /** Something is typed in the box — it rides with the approval either way. */
  typed: boolean;
  /**
   * What the console found wrong with the last rework's return, or null.
   *
   * This is the wire that was missing. The console already computed the
   * accusation — a rework that came back without seven of nine steps — and
   * rendered it as a grey note whose own words are "before you approve", while
   * the button read "verify 1 more step" and went green. The counts were true
   * about the steps that survived; the worker had chosen how many that was.
   */
  violation?: string | null;
  /** Entries the click-script parser could not use. Invisible on the card. */
  droppedSteps?: number;
  /** Questions the quiz parser had to void. Also invisible on the card. */
  droppedQuestions?: number;
  /**
   * Warnings that are real but YOURS to take — `level: 'accept'` from
   * `gateWarnings`, missing before/after evidence among them.
   *
   * They do not lock the gate, they lock it until you say you have read them.
   * The operator ruled against a degraded-gate mode: a warning suffices, so long
   * as the gate is still approved explicitly. The console's job is that the
   * warning cannot be missed and that accepting one is a deliberate act on the
   * record — not that the gate becomes unpassable, which is how an honest report
   * of a failed capture turns into a dead end.
   */
  toAccept?: GateWarning[];
  /** You have ticked that you read them. Keyed on the set, so a new warning
   *  arriving on a later round clears the tick rather than inheriting it. */
  accepted?: boolean;
}): ApproveLock {
  const p = input.progress;
  if (!p || p.total === 0) return { locked: true, label: 'No QA steps yet — ask for the click-script' };
  // Ahead of the ticks, because it is about whether the thing you are ticking is
  // the whole thing. A count is only worth reading once its denominator is.
  if (input.violation) {
    return { locked: true, label: 'The rework came back short — read the note and send feedback' };
  }
  const ds = input.droppedSteps ?? 0;
  if (ds > 0) {
    return { locked: true, label: `${ds} QA step${ds === 1 ? '' : 's'} came back malformed — ask for the click-script again` };
  }
  const dq = input.droppedQuestions ?? 0;
  if (dq > 0) {
    return { locked: true, label: `${dq} quiz question${dq === 1 ? '' : 's'} came back malformed — ask for the quiz again` };
  }
  if (input.failedIds.length === 1) {
    return { locked: true, label: `Step ${input.failedIds[0]} failed — send it back or change your tick` };
  }
  if (input.failedIds.length > 1) {
    return { locked: true, label: `${input.failedIds.length} steps failed — send them back` };
  }
  if (p.unset > 0) {
    return { locked: true, label: `Verify ${p.unset} more step${p.unset === 1 ? '' : 's'} to approve` };
  }
  if (!input.hasQuiz) return { locked: true, label: 'No quiz yet — ask for it' };
  if (!input.quizSubmitted) return { locked: true, label: 'Submit the quiz to approve' };
  // LAST, deliberately. Everything above is something to go and do; this is the
  // one blocker that is a statement about what you have read, and it should be
  // the last thing between you and the button rather than the first thing you
  // meet.
  const accept = input.toAccept ?? [];
  if (accept.length > 0 && input.accepted !== true) {
    return {
      locked: true,
      label: `Accept the ${accept.length === 1 ? 'warning' : `${accept.length} warnings`} above to approve`,
    };
  }
  if (accept.length > 0) {
    return {
      locked: false,
      label: input.typed
        ? 'Approve with these answers, warnings accepted'
        : `Approve gate C — ${accept.length === 1 ? '1 warning' : `${accept.length} warnings`} accepted`,
    };
  }
  return { locked: false, label: input.typed ? 'Approve with these answers' : 'Approve gate C' };
}

/** One labelled group of the summary. */
export type SummaryGroup = { label: string; items: string[] };

/**
 * The summary, structured. `prose` is whatever refused to be a bullet — kept,
 * never dropped, and clamped by the card.
 */
export type GateSummary = { degraded: string | null; groups: SummaryGroup[]; prose: string | null };

/** The four labels, and every spelling of them worth accepting. */
const LABELS: Array<[RegExp, string]> = [
  [/^(what i did|did|i did)$/i, 'What I did'],
  [/^(what i confirmed|confirmed|confirms)$/i, 'What I confirmed'],
  [/^(honest limits|limits|limit|not proven)$/i, 'Honest limits'],
  [/^(where to start|start|first)$/i, 'Where to start'],
];

/** Strip markdown emphasis and list markers so `**Did:**` and `- Did:` both land. */
const bare = (line: string): string => line.replace(/^[\s>#*_•-]+/, '').replace(/[\s*_]+$/, '');

/**
 * Parse a gate summary into labelled bullets.
 *
 * Deliberately lossless: anything that is not a recognised label or a bullet
 * under one becomes `prose`, so a worker that ignores the shape still has every
 * word it wrote on the card. The console's answer to an essay is to CLAMP it,
 * never to swallow it.
 */
export function parseGateSummary(raw: string): GateSummary {
  const out: GateSummary = { degraded: null, groups: [], prose: null };
  const lead: string[] = [];
  let group: SummaryGroup | null = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const text = bare(line);
    if (!text) continue;

    // DEGRADED is the skill's own first line and outranks everything: it says
    // the run itself was compromised, which is not a bullet about the change.
    if (/^degraded\b/i.test(text)) {
      out.degraded = text.replace(/^degraded[:\s-]*/i, '').trim() || text;
      continue;
    }

    // A label only counts if it IS one of the four — which is also why a bullet
    // may carry one ("- Did: ...") without a sentence like "Note: ..." ever
    // opening a group of its own.
    const colon = text.indexOf(':');
    if (colon > 0 && colon <= 24) {
      const found = LABELS.find(([re]) => re.test(text.slice(0, colon).trim()));
      if (found) {
        group = { label: found[1], items: [] };
        out.groups.push(group);
        const rest = text.slice(colon + 1).trim().replace(/^[\s*_•-]+/, '');
        if (rest) group.items.push(rest);
        continue;
      }
    }

    if (group) {
      group.items.push(text.replace(/^[\s*_•-]+/, ''));
      continue;
    }
    lead.push(text);
  }

  // No labels at all: the whole thing is prose, and the card clamps it.
  if (out.groups.length === 0) {
    const all = raw.trim();
    return { degraded: out.degraded, groups: [], prose: all || null };
  }
  out.groups = out.groups.filter((g) => g.items.length > 0);
  out.prose = lead.length > 0 ? lead.join(' ') : null;
  return out;
}
