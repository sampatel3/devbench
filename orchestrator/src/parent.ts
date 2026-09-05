/**
 * The issue a spin-off came out of.
 *
 * The operator asked to know which original ticket a spin-off came from. Three
 * spin-offs were sitting in the queue — #4472, #4405, #4562 — each filed under
 * the operator's own name by a worker's draft, each looking exactly like work the
 * team asked for. Which one it came from is the difference between "this is a real
 * ticket" and "this was already fixed in someone else's PR".
 *
 * It reads the phrase the skill tells workers to write. It does NOT guess from
 * "the first issue number in the body": #4405 mentions #4336 twice, both times to
 * say the bug is NOT from there — the body calls it pre-existing and explicitly
 * not introduced by #4336 — and a guesser would have recorded the opposite of what
 * the author wrote. An honest null beats a plausible wrong parent, because this
 * number decides whether the ticket gets closed or worked.
 */
const PATTERNS = [
  /\bspun off from\s+#(\d+)/i,
  /\bsplit out of\s+#(\d+)/i,
  /\bsplit off from\s+#(\d+)/i,
  /\bspun out of\s+#(\d+)/i,
  /\bfound (?:in|while working on)\s+#(\d+)/i,
  /\bdiscovered (?:in|while working on)\s+#(\d+)/i,
];

export function spunOffFrom(body: string | null | undefined): number | null {
  if (!body) return null;
  for (const re of PATTERNS) {
    const m = body.match(re);
    if (m?.[1]) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return null;
}
