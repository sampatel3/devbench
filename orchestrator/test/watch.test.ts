import { describe, it, expect } from 'vitest';
import {
  EMPTY_WATCH_STATE,
  forecast,
  nextWatchState,
  parsePsForest,
  sampleWorkers,
  treeOf,
  type PsProc,
  type WatchLadderConfig,
  type WatchState,
} from '../src/watch.js';

/**
 * The watcher's arithmetic, at every boundary that matters.
 *
 * It is all pure on purpose. The thing this replaces — "every guard evaluates at
 * DISPATCH and never looks again" — failed because nobody could see what it
 * would do next; a ladder whose every step is an assertion in this file is one
 * you can reason about before it fires on a real machine at 3 a.m.
 */

const GB = 1024 ** 3;

/** `ps -axo pid=,ppid=,pgid=,rss=,stat=` output, RSS in KB. */
const psLine = (pid: number, ppid: number, pgid: number, rssKb: number, stat = 'S') =>
  ` ${pid} ${ppid} ${pgid} ${rssKb} ${stat}`;

/** claude → npm → 9 jest workers, all in the leader's process group: the exact
 *  shape that took the machine down. */
function validateFanOut(rootPid = 8123): string {
  const lines = [
    psLine(1, 0, 1, 20_000),
    psLine(rootPid, 1, rootPid, 400_000),
    psLine(rootPid + 1, rootPid, rootPid, 90_000),
  ];
  for (let i = 0; i < 9; i += 1) lines.push(psLine(rootPid + 10 + i, rootPid + 1, rootPid, 300_000));
  return lines.join('\n') + '\n';
}

describe('parsePsForest', () => {
  it('reads pid, ppid, pgid, RSS in bytes and the state column', () => {
    const [p] = parsePsForest(psLine(8123, 1, 8123, 400_000, 'Ss'));
    expect(p).toEqual({ pid: 8123, ppid: 1, pgid: 8123, rssBytes: 400_000 * 1024, stat: 'Ss' });
  });

  it('skips malformed lines instead of throwing — a partial table still measures something', () => {
    const out = parsePsForest(
      ['', '   ', 'garbage', 'PID PPID PGID RSS STAT', psLine(42, 1, 42, 1000), 'x y z'].join('\n'),
    );
    expect(out.map((p) => p.pid)).toEqual([42]);
  });
});

describe('treeOf', () => {
  it('walks three levels and sums the whole fan-out', () => {
    const procs = parsePsForest(validateFanOut());
    const tree = treeOf(8123, procs);
    expect(tree).toHaveLength(11); // claude + npm + 9 jest workers
    const total = tree.reduce((s, p) => s + p.rssBytes, 0);
    expect(total).toBe((400_000 + 90_000 + 9 * 300_000) * 1024);
  });

  it('returns an EMPTY tree when the root is gone — the run just ended, not an error', () => {
    expect(treeOf(9999, parsePsForest(validateFanOut()))).toEqual([]);
  });

  it('excludes an orphan whose parent has left the snapshot', () => {
    // The npm process is missing, so its jest workers are no longer reachable
    // from the root — they are excluded, not crashed on.
    const procs = parsePsForest(
      [psLine(100, 1, 100, 1000), psLine(300, 200, 100, 5000), psLine(301, 200, 100, 5000)].join('\n'),
    );
    expect(treeOf(100, procs).map((p) => p.pid)).toEqual([100]);
  });

  it('terminates on a ppid cycle a corrupt snapshot could produce', () => {
    const procs: PsProc[] = [
      { pid: 1, ppid: 2, pgid: 1, rssBytes: 10, stat: 'S' },
      { pid: 2, ppid: 1, pgid: 1, rssBytes: 20, stat: 'S' },
    ];
    expect(treeOf(1, procs).map((p) => p.pid)).toEqual([1, 2]);
  });
});

describe('sampleWorkers', () => {
  it('reports the fan-out, the size, the process groups and how many are stopped', () => {
    const procs = parsePsForest(validateFanOut());
    const [w] = sampleWorkers(procs, [{ issue: 4478, pid: 8123 }]);
    expect(w).toMatchObject({ issue: 4478, pid: 8123, procCount: 11, pgids: [8123], stoppedProcs: 0 });
  });

  it('counts a stopped tree, which is how a pause is verified rather than assumed', () => {
    const procs = parsePsForest(
      [psLine(500, 1, 500, 1000, 'Ts'), psLine(501, 500, 500, 1000, 'T'), psLine(502, 500, 500, 1000, 'T')].join('\n'),
    );
    const [w] = sampleWorkers(procs, [{ issue: 1, pid: 500 }]);
    expect(w!.stoppedProcs).toBe(3);
    expect(w!.procCount).toBe(3);
  });

  it("lists every process group in the tree, the leader's own first", () => {
    // One child called setsid and made its own session — the case the per-pgid
    // sweep exists for.
    const procs = parsePsForest(
      [psLine(700, 1, 700, 1000), psLine(701, 700, 700, 1000), psLine(900, 700, 900, 1000)].join('\n'),
    );
    const [w] = sampleWorkers(procs, [{ issue: 2, pid: 700 }]);
    expect(w!.pgids).toEqual([700, 900]);
  });

  it('measures a worker whose pid is not in the snapshot as an empty tree', () => {
    const [w] = sampleWorkers(parsePsForest(validateFanOut()), [{ issue: 3, pid: 4_194_303 }]);
    expect(w).toMatchObject({ procCount: 0, treeBytes: 0, pgids: [], stoppedProcs: 0 });
  });
});

describe('the forecast — the sentence the dashboard could not say', () => {
  const two = (a: number, b: number) => [
    { treeBytes: a, paused: false },
    { treeBytes: b, paused: false },
  ];

  it('spells out the comfortable case exactly', () => {
    const out = forecast({ headroomBytes: 5.2 * GB, spikeBytes: 2 * GB, workers: two(1.5 * GB, 1.2 * GB) });
    expect(out.comfortable).toBe(true);
    expect(out.projectedHeadroomBytes).toBeCloseTo(3.9 * GB, -6);
    expect(out.sentence).toBe(
      '2 workers running. If both hit a 2 GB test spike at once, headroom 5.2 GB → ~3.9 GB — room to spare.',
    );
  });

  it('spells out the case that does NOT fit, and says what happens next', () => {
    // Two small resting trees: almost the whole 2 GB spike is still to come for
    // each of them, so 3.0 GB of headroom is committed nearly twice over.
    const out = forecast({ headroomBytes: 3.0 * GB, spikeBytes: 2 * GB, workers: two(0.5 * GB, 1.3 * GB) });
    expect(out.comfortable).toBe(false);
    expect(out.sentence).toBe(
      '2 workers running. If both hit a 2 GB test spike at once, headroom 3.0 GB → ~0.8 GB — NOT enough. ' +
        'Dispatch is held; the floor pauses workers at 5% free.',
    );
  });

  it('does not promise the floor will act when the floor is switched off', () => {
    const out = forecast({
      headroomBytes: 3.0 * GB,
      spikeBytes: 2 * GB,
      workers: two(0.5 * GB, 1.3 * GB),
      autoPauseFloor: false,
    });
    expect(out.sentence).toContain('automatic pause is off, so nothing will pause on its own');
  });

  it('counts only the UNPAUSED workers — a frozen one is not about to spike', () => {
    const out = forecast({
      headroomBytes: 3.0 * GB,
      spikeBytes: 2 * GB,
      workers: [
        { treeBytes: 1.5 * GB, paused: false },
        { treeBytes: 1.2 * GB, paused: true },
      ],
    });
    expect(out.sentence).toContain('1 worker running. If it hits a 2 GB test spike');
    expect(out.comfortable).toBe(true); // 3.0 − 0.5 = 2.5 GB, room for one more spike
  });

  it('says "nothing left" rather than rounding a negative projection into comfort', () => {
    const out = forecast({ headroomBytes: 0.5 * GB, spikeBytes: 2 * GB, workers: two(0, 0) });
    expect(out.sentence).toContain('→ nothing left');
    expect(out.comfortable).toBe(false);
  });

  it('forecasts nothing when the headroom could not be read, and does not hold dispatch for it', () => {
    const out = forecast({ headroomBytes: null, spikeBytes: 2 * GB, workers: two(GB, GB) });
    expect(out.projectedHeadroomBytes).toBeNull();
    expect(out.comfortable).toBe(true);
    expect(out.sentence).toContain('no forecast');
  });
});

// ------------------------------------------------------------------ the ladder

const CFG: WatchLadderConfig = {
  minFreePct: 25,
  warnFreePct: 15,
  pauseFreePct: 10,
  floorFreePct: 5,
  autoPause: false,
  autoPauseFloor: true,
};

const AT = '2026-08-11T23:12:00.000Z';

function step(
  prev: WatchState,
  freePct: number | null,
  opts: { comfortable?: boolean; anyPaused?: boolean; cfg?: Partial<WatchLadderConfig> } = {},
) {
  return nextWatchState(
    prev,
    {
      at: AT,
      freePct,
      forecastComfortable: opts.comfortable ?? true,
      anyPaused: opts.anyPaused ?? false,
    },
    { ...CFG, ...opts.cfg },
  );
}

/** Feed a run of samples and return the last result. */
function run(freePcts: Array<number | null>, opts: Parameters<typeof step>[2] = {}) {
  let state = { ...EMPTY_WATCH_STATE };
  let last = step(state, freePcts[0]!, opts);
  for (const free of freePcts) {
    last = step(state, free, opts);
    state = last.state;
  }
  return last;
}

describe('the ladder — every threshold at its boundary', () => {
  it('is ok at exactly the floor of the dispatch guard and holds one point under it', () => {
    expect(step(EMPTY_WATCH_STATE, 25).state.level).toBe('ok');
    expect(step(EMPTY_WATCH_STATE, 24.9).state.level).toBe('hold');
  });

  it('holds when the forecast says the committed spikes do not fit, however much is free', () => {
    expect(step(EMPTY_WATCH_STATE, 80, { comfortable: false }).state.level).toBe('hold');
  });

  it('warns only on the SECOND consecutive sample below 15', () => {
    expect(step(EMPTY_WATCH_STATE, 15).state.level).toBe('hold'); // 15 is not below 15
    expect(run([14.9]).state.level).toBe('hold');
    expect(run([14.9, 14.9]).state.level).toBe('warn');
  });

  it('resets the counter the moment a sample comes back above the line', () => {
    expect(run([14.9, 20, 14.9]).state.level).toBe('hold');
  });

  it('offers the pause only on the SECOND consecutive sample below 10', () => {
    expect(step(EMPTY_WATCH_STATE, 10).state.level).toBe('hold');
    expect(run([9.9]).state.level).toBe('hold');
    expect(run([9.9, 9.9]).state.level).toBe('pause-largest');
  });

  it('fires the floor on ONE sample below 5 — jest can take gigabytes inside one tick', () => {
    expect(step(EMPTY_WATCH_STATE, 5).state.level).toBe('hold');
    const out = step(EMPTY_WATCH_STATE, 4.9);
    expect(out.state.level).toBe('floor');
    expect(out.act).toEqual({ kind: 'pause-all' });
    expect(out.state.firedFloorAt).toBe(AT);
  });

  it('NEVER acts on a free % it could not read — an unmeasurable machine gets the old behaviour', () => {
    const out = step({ level: 'floor', belowWarnCount: 5, belowPauseCount: 5, firedFloorAt: null }, null);
    expect(out.act).toBeNull();
    expect(out.state.level).toBe('ok');
    expect(out.state.belowWarnCount).toBe(0);
    expect(out.state.belowPauseCount).toBe(0);
  });

  it('leaves level 3 to a click unless AUTO_PAUSE is opted into', () => {
    expect(run([9.9, 9.9]).act).toBeNull();
    expect(run([9.9, 9.9], { cfg: { autoPause: true } }).act).toEqual({ kind: 'pause-largest' });
  });

  it('with AUTO_PAUSE_FLOOR off, records the level and stamps nothing — the banner does the talking', () => {
    const out = step(EMPTY_WATCH_STATE, 4.9, { cfg: { autoPauseFloor: false } });
    expect(out.state.level).toBe('floor');
    expect(out.act).toBeNull();
    expect(out.state.firedFloorAt).toBeNull();
  });
});

describe('hysteresis and re-arming — the "kept finding new ways to fire" lesson', () => {
  it('holds the warn banner until free % has recovered by three points', () => {
    const warned = run([14.9, 14.9]);
    expect(warned.state.level).toBe('warn');
    expect(step(warned.state, 16).state.level).toBe('warn'); // 15.1 would flap; 16 still does
    expect(step(warned.state, 18).state.level).toBe('hold'); // 15 + 3, and only then
  });

  it('emits its act ONCE per transition, not on every sample inside the level', () => {
    const first = step(EMPTY_WATCH_STATE, 4);
    expect(first.act).toEqual({ kind: 'pause-all' });
    expect(step(first.state, 4, { anyPaused: true }).act).toBeNull();
  });

  it('will not fire again until every worker is resumed AND the machine has recovered', () => {
    // It fires, everything is paused, and the memory comes back — but only
    // because those workers are frozen.
    let s = step(EMPTY_WATCH_STATE, 4).state;
    expect(s.firedFloorAt).toBe(AT);
    s = step(s, 20, { anyPaused: true }).state;
    expect(s.firedFloorAt).toBe(AT); // still spent: the pause is what freed it
    // Dropping back under the floor with a worker still paused does NOTHING.
    const again = step(s, 4, { anyPaused: true });
    expect(again.act).toBeNull();

    // Resumed, and the machine genuinely recovered past pause + 3.
    const rearmed = step(again.state, 13, { anyPaused: false });
    expect(rearmed.state.firedFloorAt).toBeNull();
    expect(step(rearmed.state, 4).act).toEqual({ kind: 'pause-all' });
  });

  it('does not treat a tool going missing as a recovery', () => {
    const fired = step(EMPTY_WATCH_STATE, 4);
    const blind = step(fired.state, null, { anyPaused: false });
    expect(blind.state.firedFloorAt).toBe(AT);
  });
});
