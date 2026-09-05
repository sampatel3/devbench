/**
 * SUPERCHARGE — a run that passes its own gates up to D, and never past the
 * evidence.
 *
 * What the operator asked for: a run that goes all the way to gate D without
 * human approval, on one condition — the evidence has to be there at gate C. So
 * this is not "skip the gates". Gates A and B are passed because they are
 * decisions ABOUT A PLAN and you have chosen, at start, to take the worker's.
 * Gate C is different in kind: it is the only gate with a mechanical half, and
 * that half is the pictures. A supercharged run passes gate C when the captures
 * are actually there and sends the work BACK when they are not — which is a
 * stricter reading of gate C than a tired human ticking four steps, not a
 * looser one.
 *
 * WHERE IT STOPS. Gate D, always. Gate D is the approval to raise the PR, which
 * is the whole question that gate asks — and a PR is the first thing in this
 * pipeline that leaves the machine. Nothing here can pass it, and nothing here
 * can pass gate E either, which is the hand-over to the team lead.
 *
 * WHY THE PASSES ARE WRITTEN DOWN AS `by: 'supercharge'`. A gate the console
 * passed on a standing instruction is not the same fact as a gate the operator
 * read and approved, and the ledger has to be able to tell them apart. #5402 is
 * the warning: two QUESTIONS typed at gate D were recorded as `approved`, and
 * the result was a ticket whose history said the gate was passed twice while
 * nothing had been decided at all.
 */
import { missingShots, missingShotsLine, type ManualQaStep } from './manual-qa.js';

/** Gate C send-backs a supercharged run will spend before it stops for you. */
export const MAX_AUTO_ROUNDS = 2;

export type SuperchargeAct =
  /** Pass this gate now, with `message` as the resume. */
  | { act: 'pass'; message: string }
  /** Send the work back for the captures it owes, with `message` as the resume. */
  | { act: 'send-back'; message: string; why: string }
  /** Hand it to the operator and switch supercharge off, `why` said in words
   *  they can act on. */
  | { act: 'stop'; why: string }
  /** Not ours to touch. */
  | { act: 'nothing' };

export type SuperchargeInput = {
  issue: number;
  /** The open gate, or null when the worker is not parked at one. */
  gate: string | null;
  /** The click-script's steps, after the console has restored any dropped ones. */
  steps: ManualQaStep[];
  /** Steps the gate file came back malformed. */
  qaDropped: number;
  /** How many captures the gate points at. Zero means the card would show none. */
  evidenceCount: number;
  /** Gate C send-backs already spent on this issue. */
  autoRounds: number;
};

/**
 * The whole rule, as one function, so it can be read and tested without a
 * worktree. It decides nothing about capacity or sessions — the caller owns
 * those, and a refusal there is not a decision, it is a wait.
 */
export function decideSupercharge(input: SuperchargeInput): SuperchargeAct {
  const gate = input.gate;
  if (gate === null) return { act: 'nothing' };

  // Gate D is the stop, and it is a stop rather than a pass on purpose: it is
  // the one gate whose subject matter leaves the machine.
  if (gate === 'D') {
    return {
      act: 'stop',
      why:
        'gate D is where a supercharged run stops. Raising the PR is your approval to give, and gates A, B and C ' +
        'were passed automatically to get here.',
    };
  }
  if (gate === 'E') {
    return { act: 'stop', why: 'gate E is the hand-over to the team lead, which is never automatic.' };
  }

  if (gate === 'A' || gate === 'B') {
    return {
      act: 'pass',
      message: superchargeApproval(gate, input.issue),
    };
  }

  if (gate !== 'C') {
    // An unknown letter is somebody else's gate. Never guessed at.
    return { act: 'stop', why: `gate ${gate} is not one a supercharged run knows how to decide.` };
  }

  // GATE C. Everything below is the evidence rule, and it is the only reason
  // this gate can be passed without a person.
  const short = evidenceShortfall(input);
  if (short === null) {
    return { act: 'pass', message: superchargeApprovalC(input) };
  }
  if (input.autoRounds >= MAX_AUTO_ROUNDS) {
    return {
      act: 'stop',
      why:
        `gate C still has no complete evidence after ${input.autoRounds} automatic ` +
        `${input.autoRounds === 1 ? 'round' : 'rounds'} — ${short}. It is yours to decide.`,
    };
  }
  return { act: 'send-back', why: short, message: superchargeSendBackC(short, input.autoRounds + 1) };
}

/**
 * What gate C is missing, as one sentence, or null when nothing is.
 *
 * The order is the order a person would notice it in: no script at all, then a
 * script that came back broken, then the pictures, then whether the card would
 * show anything.
 */
export function evidenceShortfall(input: Pick<SuperchargeInput, 'steps' | 'qaDropped' | 'evidenceCount'>): string | null {
  if (input.steps.length === 0) return 'there are no QA steps at all, so there is nothing evidence could be attached to';
  if (input.qaDropped > 0) {
    return `${input.qaDropped} step(s) of the click-script came back malformed`;
  }
  const missing = missingShots(input.steps);
  if (missing.length > 0) return missingShotsLine(missing);
  if (input.evidenceCount === 0) {
    return "no capture is listed in the gate file's evidence, so the card would show none";
  }
  return null;
}

/** The resume for a plan gate. It says what it is, because the worker logs it. */
function superchargeApproval(gate: string, issue: number): string {
  return (
    `Gate ${gate} passed automatically — #${issue} is running supercharged, so the console is taking your ` +
    `recommendation at this gate rather than waiting for the operator. Proceed.\n\n` +
    `Two things this does NOT mean. It is not a review: nobody has read your plan, so anything you were ` +
    `relying on a human to catch is still uncaught. And it does not extend past gate D — the PR is the ` +
    `operator's to approve, and they will read the whole thing there. Carry any open question forward to ` +
    `that gate rather than treating this as an answer to it.`
  );
}

/** The gate C resume. It states exactly what was checked, because that is the claim. */
function superchargeApprovalC(input: SuperchargeInput): string {
  return (
    `Gate C passed automatically — #${input.issue} is running supercharged. Proceed to stage 6.\n\n` +
    `WHAT WAS ACTUALLY CHECKED, so you know what this approval is worth: your click-script has ` +
    `${input.steps.length} step(s), none malformed; every step carries both an afterShot and a beforeShot ` +
    `(or declares "before": null with "beforeShot": null for genuinely new behaviour); every one of those ` +
    `captures is a file that is on disk right now; and ${input.evidenceCount} capture(s) are listed in the ` +
    `gate file's evidence. That is the whole check.\n\n` +
    `WHAT WAS NOT CHECKED: nobody clicked through your script, and nobody looked at the pictures. The ` +
    `evidence exists and is complete — it has not been judged. If a step's screenshot shows something you ` +
    `would not want the operator to see, say so at gate D, where they read everything.`
  );
}

/** The gate C send-back. Not a change request about the code — say so first. */
function superchargeSendBackC(short: string, round: number): string {
  return (
    `Gate C is missing evidence: ${short}. This is NOT an approval and NOT a change request about the ` +
    `code — the change may well be right. ${round === 1 ? 'This is the first' : `This is the ${round}${round === 2 ? 'nd' : 'rd'}`} ` +
    `automatic round on this issue, and a supercharged run will not pass gate C without the captures.\n\n` +
    `Capture them yourself with the repo's own Playwright tooling, headless against the local dev server, ` +
    `and stop at gate C again. Every step carries BOTH legs — the WAS shot ("beforeShot") and the AFTER shot ` +
    `("afterShot") — with exactly one exception: genuinely new behaviour, written as "before": null WITH ` +
    `"beforeShot": null. List every capture in .gate.json "evidence" with a caption saying what it shows, ` +
    `and carry the prior evidence forward complete and in order before appending the new shots.\n\n` +
    `If a capture genuinely cannot be taken, do not fake it and do not skip the gate: say which step, which ` +
    `leg, what you ran and the exact error in one "Limits:" line. That stops the automatic rounds and hands ` +
    `it to the operator, which is the right outcome for something only a person can decide.`
  );
}
