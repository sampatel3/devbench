/**
 * Folding a related finding back into the issue that exposed it.
 *
 * The skill's rule, as the operator put it: a finding surfaced while working an
 * issue should not need an issue of its own, or you get issue > raised issue >
 * raised issue and nobody is helped — folding it into the original has to always
 * be an option. Containment guards against unrelated drive-by fixes; it was never
 * meant to stop a worker finishing the thing it is already on.
 *
 * The console implemented only the filing half, so a drafted spin-off could be
 * agreed to or ignored — never absorbed.
 */

/**
 * The brief a fold resumes the worker with.
 *
 * Two things it must carry beyond "do it here". First, an explicit *do not file*
 * — the draft stays on disk until the worker's next resume, and a worker that
 * re-read it without being told could raise the issue it was just told to
 * absorb. Second, the contract sections have to be redone: folding widens the
 * diff, and a sibling sweep or affected-rows table written against the narrower
 * change is describing work that is no longer what the PR does.
 */
export function foldPrompt(issue: number, title: string): string {
  return (
    `Fold the related finding into #${issue} instead of filing it separately.\n\n` +
    `The draft was: "${title}"\n\n` +
    `Do NOT file it, and do not draft it again — delete .issue-request.json as part ` +
    `of this round. The work comes home to this issue and ships in this PR.\n\n` +
    `Because the diff is now wider than the one already approved, redo the parts of ` +
    `the contract that describe its shape rather than editing round the edges: the ` +
    `sibling sweep, the trace to the wire, and affected rows. Say in the PR body ` +
    `that this was folded in rather than spun off, and why. If a gate's approval no ` +
    `longer covers what the change does, say so and stop at that gate rather than ` +
    `carrying an approval forward onto work it was never given for.`
  );
}
