import { describe, it, expect } from 'vitest';
import { WorkerQueue, selectNext } from '../src/queue.js';
import { loadConfig } from '../src/config.js';

describe('WorkerQueue', () => {
  it('is FIFO when nothing tells it one issue outranks another', () => {
    const q = new WorkerQueue();
    q.enqueue(4336);
    q.enqueue(4334);
    q.enqueue(4342);
    expect(q.list()).toEqual([4336, 4334, 4342]);
  });

  it('ignores a second enqueue of the same issue instead of queueing it twice', () => {
    const q = new WorkerQueue();
    q.enqueue(4336);
    q.enqueue(4336);
    expect(q.list()).toEqual([4336]);
  });

  it('removes an issue from anywhere in the line', () => {
    const q = new WorkerQueue();
    q.enqueue(4336);
    q.enqueue(4334);
    q.enqueue(4342);
    q.remove(4334);
    expect(q.list()).toEqual([4336, 4342]);
  });

  it('reports position so the UI can say "2nd in line"', () => {
    const q = new WorkerQueue();
    q.enqueue(4336);
    q.enqueue(4334);
    expect(q.position(4336)).toBe(1);
    expect(q.position(4334)).toBe(2);
    expect(q.position(9999)).toBe(null);
  });
});

describe('selectNext', () => {
  const resourcesOk = { ok: true as const, reason: '' };

  it('dispatches the head of the queue when there is room', () => {
    const d = selectNext({ queue: [4336, 4334], activeCount: 0, maxActive: 1, resources: resourcesOk });
    expect(d).toEqual({ issue: 4336, reason: 'dispatching' });
  });

  it('holds when MAX_ACTIVE is already reached', () => {
    const d = selectNext({ queue: [4336], activeCount: 1, maxActive: 1, resources: resourcesOk });
    expect(d.issue).toBe(null);
    expect(d.reason).toBe('at capacity: 1 of 1 active');
  });

  it('holds on resources even when there is capacity, and says why', () => {
    const d = selectNext({
      queue: [4336],
      activeCount: 0,
      maxActive: 1,
      resources: { ok: false, reason: 'waiting on resources: 1.2 GB free, need 2.0 GB' },
    });
    expect(d.issue).toBe(null);
    expect(d.reason).toBe('waiting on resources: 1.2 GB free, need 2.0 GB');
  });

  it('says nothing is waiting when the queue is empty', () => {
    const d = selectNext({ queue: [], activeCount: 0, maxActive: 1, resources: resourcesOk });
    expect(d).toEqual({ issue: null, reason: 'queue empty' });
  });

  it('checks capacity before resources, so a full desk is not blamed on RAM', () => {
    const d = selectNext({
      queue: [4336],
      activeCount: 2,
      maxActive: 2,
      resources: { ok: false, reason: 'waiting on resources: 1.2 GB free, need 2.0 GB' },
    });
    expect(d.reason).toBe('at capacity: 2 of 2 active');
  });

  it('lets MAX_ACTIVE above 1 run more than one worker', () => {
    const d = selectNext({ queue: [4342], activeCount: 1, maxActive: 2, resources: resourcesOk });
    expect(d.issue).toBe(4342);
  });
});

describe('the configured cap', () => {
  const resourcesOk = { ok: true as const, reason: '' };

  it('defaults to 2 — two workers may run at once', () => {
    expect(loadConfig({}).maxActive).toBe(2);
  });

  it('lets two run and holds the third', () => {
    const full = selectNext({ queue: [4405], activeCount: 2, maxActive: 2, resources: resourcesOk });
    expect(full.issue).toBeNull();
    expect(full.reason).toContain('2 of 2 active');

    const room = selectNext({ queue: [4405], activeCount: 1, maxActive: 2, resources: resourcesOk });
    expect(room.issue).toBe(4405);
  });

  it('still reports a full desk as capacity, never as a memory problem', () => {
    const d = selectNext({
      queue: [4405],
      activeCount: 2,
      maxActive: 2,
      resources: { ok: false, reason: 'waiting on memory — 9% free, need 25%' },
    });
    expect(d.reason).toContain('capacity');
    expect(d.reason).not.toContain('memory');
  });
});
