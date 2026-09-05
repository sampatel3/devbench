/**
 * IS THIS AN APPROVAL, OR A QUESTION TYPED INTO THE APPROVAL BOX?
 *
 * #5402 is the whole reason this exists. Twice at gate D, a question about what
 * the change was supposed to look like was typed into the approve field and the
 * button was pressed — both plainly questions, both ending in a question mark,
 * neither saying yes to anything.
 *
 * The console recorded both as `decision: 'approved'`, so the ledger said gate D
 * was passed twice. The worker read them as what they were, answered the second
 * one and ended its turn — correct behaviour for an answer, and no `.gate.json`
 * is written for one. The ticket then sat for a day as "checkpoint — stopped
 * after stage 6" with gates A-D passed and no PR, and there was no single place
 * where anything was wrong: the console had a gate approved, the worker had
 * answered a question, and the work had stopped between the two readings.
 *
 * There is already a route that does this correctly — `/ask` sends the question,
 * decides nothing, remembers what was asked, and checks the worker comes back to
 * the same gate. The failure was never a missing feature; it was that the wrong
 * button accepted the input. So this refuses at the moment of the click.
 *
 * DELIBERATELY CONSERVATIVE. Refusing a real approval is worse than letting a
 * question through, because a refused approval stalls work while a question
 * recorded as an approval is at least recoverable (`reopenGate`). So ANY word
 * that says yes makes it an approval, whatever else it contains: "Approved, but
 * why did you do it that way?" is an approval with a question attached, and that
 * is a perfectly ordinary thing to send.
 */

/**
 * Any of these, as a whole word, means yes.
 *
 * Word boundaries matter more than the list does: `ok` inside "broken" and `yes`
 * inside "eyes" would both defeat this — and "broken" is a word one of #5402's
 * own questions used.
 */
const SAYS_YES =
  /\b(approve[ds]?|approving|approval|proceed|proceeds|go ahead|goahead|lgtm|ship it|ship|merge it|agreed|agree|yes|yep|yeah|ok|okay|fine|sounds good|do it|carry on|continue|good to go|green light)\b/i;

/**
 * True when this message asks something and never says yes — the shape that
 * belongs on Ask, not on Approve.
 *
 * A message with no question mark in it is never caught here. That is the whole
 * test for "is this a question": it is the operator's own punctuation, it needs
 * no parsing, and it cannot be wrong about English.
 */
export function readsAsQuestion(message: string): boolean {
  const said = message.trim();
  if (said === '') return false;
  if (!said.includes('?')) return false;
  return !SAYS_YES.test(said);
}

/**
 * The refusal, which has to teach rather than block: it names the button that
 * does want this input, and the one word that would make it an approval.
 *
 * It quotes nothing back — the message is still in the box being looked at.
 */
export function questionNotApprovalRefusal(gate: string): string {
  return (
    `That reads as a question, not an approval of gate ${gate}, so nothing was sent.\n\n` +
    `Use Ask instead: it sends the question on its own, decides no gate, remembers what you asked, and the ` +
    `worker comes back to this same gate with the answer. Approve would have recorded gate ${gate} as passed ` +
    `while the worker went off and answered you — which is exactly how #5402 ended up on a checkpoint with ` +
    `gates A-D passed and no PR.\n\n` +
    `If you did mean to approve as well as ask, say so in the message — "approved", "proceed", "go ahead" — ` +
    `and send it again. A question alongside a yes is fine and goes through untouched.`
  );
}
