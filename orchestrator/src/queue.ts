/**
 * The queue is a line of issues waiting to go ACTIVE (a worker actually
 * streaming/building).
 *
 * It used to be FIFO and deliberately dumb, on the reasoning that `MAX_ACTIVE`
 * was 1 and "a priority scheme on a queue of one is a decision nobody made".
 * Both halves of that stopped being true: the cap defaults to 2, and the queue
 * routinely holds nine. Watching it pick, the operator said it looked like it was
 * choosing either at random or by arrival, when what it should always take first
 * is UAT failures, then P0, P1, P2 and P3 in that order.
 *
 * It was the second of those. Arrival order is not random, it is just
 * uninformative: a P3 chore enqueued at 09:00 went before a P1 enqueued at
 * 09:05, and a send-back from UAT waited behind both.
 *
 * So the line now has ONE ordering, and it lives here:
 *
 *   1. sent back from UAT        — a human tested shipped work and rejected it
 *   2. sent back by the operator — read at a gate and handed back
 *   3. the priority band         — P0, P1, P2, P3, then untriaged, then icebox
 *   4. when it was enqueued      — FIFO inside a band, unchanged
 *
 * The fourth key is why this is a re-ordering and not a re-write: two tickets
 * that triage ranked the same are still served in the order they were asked
 * for, so nothing starves and the line is still predictable.
 *
 * KEY 2 IS ABOVE THE BAND, and that is the whole of the operator's second
 * instruction: a sent-back P1 outranks a P1 nobody has sent back, and a sent-back
 * P2 outranks a P1 nobody has sent back — because failures are resolved first and
 * immediately, and only then does the line progress the highest-priority tickets
 * towards a PR.
 *
 * Both halves of that are one rule read in order. A ticket the operator has sent
 * back is a FAILURE — they looked at the work and it was not right — and a failure
 * costs more the longer it sits: the worktree, the dev server and the session are
 * all still alive, the QA context is fresh, and the round is a fix rather than a
 * build. A ticket nobody has sent back is work that has not started, and starting
 * a P1 before finishing a failed P2 buys a second unfinished thing. So: clear the
 * failures, then serve the bands, which is what makes "raise PRs on the highest
 * priority tickets" true of the tickets that can actually reach a PR.
 *
 * It sits BELOW the UAT key rather than joining it, on the operator's own
 * exception: none of this applies to UAT fails, which are always top. A UAT
 * send-back is work a person tested after it shipped; a gate send-back is work
 * that never left. The first is always worse.
 *
 * **This is the same order the rail draws**, deliberately — `ui/src/priority.ts`
 * puts the UAT send-back above every band and ranks the bands `P0 … P3,
 * untriaged, icebox` for exactly the reasons written up there (untriaged still
 * wants an answer; icebox has had one). The list the operator reads and the line
 * the dispatcher serves must not disagree about which ticket is next, so the band
 * order below is copied from that file and must be changed with it. It is
 * copied rather than imported because the orchestrator's `tsconfig` has
 * `rootDir: src` — `orchestrator/src` cannot reach into `ui/src` at build time,
 * which is the same reason `types.ts` exists twice. `test/queue-priority.test.ts`
 * imports both and fails if the two ever drift.
 *
 * The rail's other rules — the parked/done sinks, whose court it is in, the
 * self-filed tiebreak — are deliberately NOT here. They order a list a person
 * reads; this orders a line a dispatcher serves, and the two are different
 * questions. A parked issue is not in this line at all (parking dequeues it),
 * and a closed one has nothing to dispatch.
 */

/** The repo's priority axis, most urgent first. Mirrors `BANDS` in
 *  `ui/src/priority.ts` — see the note above. */
export type Band = 'P0' | 'P1' | 'P2' | 'P3' | 'untriaged' | 'icebox';

export const BANDS: readonly Band[] = ['P0', 'P1', 'P2', 'P3', 'untriaged', 'icebox'];

const FROM_LABEL: Record<string, Band> = { p0: 'P0', p1: 'P1', p2: 'P2', p3: 'P3', icebox: 'icebox' };

const rank = (b: Band): number => BANDS.indexOf(b);

/**
 * The band an issue sits in, read off its labels. Two priority labels on one
 * issue is a triage mistake rather than a state to model, so the most urgent
 * wins — `P2` + `icebox` is dispatched as P2 and never sinks out of sight.
 *
 * No label at all is `untriaged`, which is NOT P2: P2 is the stated default for
 * real work, but nobody has said so about this issue yet.
 */
export function bandOf(labels: readonly string[]): Band {
  let found: Band | null = null;
  for (const label of labels) {
    const b = FROM_LABEL[label.trim().toLowerCase()];
    if (b && (found === null || rank(b) < rank(found))) found = b;
  }
  return found ?? 'untriaged';
}

/** Everything the line's ordering reads about one queued issue. The orchestrator
 *  supplies it; nothing in here fetches. */
export type Weight = {
  /** A human tested the shipped work in UAT and sent it back. Above every band. */
  uatFail: boolean;
  /**
   * The operator read this at a gate and handed it back — a failed QA step, a
   * question, a feedback answer, a gate taken back. Above every band, below
   * `uatFail`.
   *
   * It is deliberately NOT "there is something parked on this issue": an
   * APPROVAL is parked the same way and is not a failure. An approved gate is
   * work moving forward and it waits its turn in its band, which is where the
   * second point above puts it — the bands are what decide who progresses to a PR.
   */
  sentBack: boolean;
  band: Band;
};

/** What the queue asks about an issue when it needs to order itself. */
export type Weigh = (issue: number) => Weight;

/**
 * The weight of an issue nothing is known about: no send-back, and unranked.
 *
 * `untriaged` rather than `P2` on purpose, and it is the safe default in both
 * directions — an issue whose labels the console has not read yet neither
 * jumps the P-bands nor sinks below icebox; it sits where an unlabelled issue
 * sits, and arrival order still separates it from its neighbours.
 */
const UNKNOWN: Weight = { uatFail: false, sentBack: false, band: 'untriaged' };

const FLAT: Weigh = () => UNKNOWN;

/**
 * Order a line. `arrivals` is in enqueue order and that order is the last key,
 * so this is a stable sort over it — `Array.prototype.sort` has been required
 * to be stable since ES2019, which is what makes "FIFO inside a band" true
 * rather than merely usual.
 *
 * Pure, and exported, because the ordering is the part worth testing without an
 * orchestrator around it.
 */
export function orderQueue(arrivals: readonly number[], weigh: Weigh = FLAT): number[] {
  // Weighed ONCE per issue rather than once per comparison: `weigh` reaches into
  // the issue list and the actions feed, and a comparator that does that is
  // O(n² · m) on every render of every row.
  const weights = new Map<number, Weight>();
  for (const issue of arrivals) weights.set(issue, weigh(issue));
  const of = (issue: number): Weight => weights.get(issue) ?? UNKNOWN;

  return [...arrivals].sort((a, b) => {
    const wa = of(a);
    const wb = of(b);
    const uat = Number(wb.uatFail) - Number(wa.uatFail);
    if (uat !== 0) return uat;
    // The operator's own send-back, above the band. Two are then ranked against
    // each other by band, which is what `orderQueue` doing nothing else here
    // gets for free: the next key IS the band.
    const sentBack = Number(wb.sentBack) - Number(wa.sentBack);
    if (sentBack !== 0) return sentBack;
    return rank(wa.band) - rank(wb.band);
  });
}

export class WorkerQueue {
  /** Arrival order, and only arrival order. The ordering is applied on the way
   *  out so that a label added while an issue waits takes effect immediately —
   *  storing a sorted line would freeze each ticket's rank at enqueue time. */
  #line: number[] = [];
  readonly #weigh: Weigh;

  /** Without a `weigh` the line is flat and therefore FIFO, which is what every
   *  caller that does not care about priority (and every test of the plumbing)
   *  wants. */
  constructor(weigh: Weigh = FLAT) {
    this.#weigh = weigh;
  }

  /** Idempotent: an issue already in line keeps its ARRIVAL place. Re-enqueuing
   *  must not be a way to jump the line, and it happens on its own — a resume
   *  that finds a broken profile puts its claim straight back. */
  enqueue(issue: number): void {
    if (!this.#line.includes(issue)) this.#line.push(issue);
  }

  remove(issue: number): void {
    this.#line = this.#line.filter((n) => n !== issue);
  }

  /** The line in the order it will be served: UAT send-backs, then the
   *  operator's own send-backs, then bands, then arrival. Every caller —
   *  dispatch, the state frame, the "2 in line" the row prints — reads this one
   *  list, so they cannot disagree. */
  list(): number[] {
    return orderQueue(this.#line, this.#weigh);
  }

  /** The order they were asked for, ignoring priority. Only the audit wants it. */
  arrivals(): number[] {
    return [...this.#line];
  }

  /** 1-based place in line, or null if not queued. Reads the SERVED order, so a
   *  P1 enqueued last correctly reads "next up". */
  position(issue: number): number | null {
    const i = this.list().indexOf(issue);
    return i === -1 ? null : i + 1;
  }
}

export type ResourceVerdict = { ok: boolean; reason: string };

export type SelectNextInput = {
  /** Already in served order — see `orderQueue`. This function takes the head
   *  and does not re-rank, so that "who is next" has exactly one definition and
   *  the position the UI prints is the issue that actually starts. */
  queue: number[];
  activeCount: number;
  maxActive: number;
  resources: ResourceVerdict;
};

/**
 * Pure decision: who, if anyone, starts now — and if nobody, the plain-English
 * reason the UI shows. Capacity is checked before resources so a full desk is
 * never reported as a RAM problem.
 */
export function selectNext(input: SelectNextInput): { issue: number | null; reason: string } {
  const { queue, activeCount, maxActive, resources } = input;
  if (queue.length === 0) return { issue: null, reason: 'queue empty' };
  if (activeCount >= maxActive) {
    return { issue: null, reason: `at capacity: ${activeCount} of ${maxActive} active` };
  }
  if (!resources.ok) return { issue: null, reason: resources.reason };
  return { issue: queue[0]!, reason: 'dispatching' };
}
