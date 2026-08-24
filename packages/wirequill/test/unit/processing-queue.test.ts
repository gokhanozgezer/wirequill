import { describe, expect, it, vi } from 'vitest';
import { ProcessingQueue } from '../../src/processing/processing-queue.js';
import { RateLimiter } from '../../src/utils/rate-limiter.js';
import { fixedClock } from '../../src/utils/clock.js';

interface Item {
  id: number;
  released: boolean;
}

function makeItem(id: number): Item {
  return { id, released: false };
}

/** Runs queued work synchronously so tests never wait on the event loop. */
function immediateSchedule(task: () => void): void {
  task();
}

describe('ProcessingQueue', () => {
  it('processes items in order', () => {
    const seen: number[] = [];
    const queue = new ProcessingQueue<Item>({
      maxPending: 10,
      process: (item) => seen.push(item.id),
      onDrop: () => undefined,
      schedule: immediateSchedule,
    });

    queue.enqueue(makeItem(1));
    queue.enqueue(makeItem(2));
    queue.enqueue(makeItem(3));

    expect(seen).toEqual([1, 2, 3]);
    expect(queue.stats.processed).toBe(3);
  });

  it('drops and releases once full', () => {
    const dropped: Item[] = [];
    const pending: (() => void)[] = [];

    const queue = new ProcessingQueue<Item>({
      maxPending: 1,
      process: () => undefined,
      onDrop: (item) => {
        item.released = true;
        dropped.push(item);
      },
      // Nothing runs until a test releases it, so the queue really fills up.
      schedule: (task) => pending.push(task),
    });

    expect(queue.enqueue(makeItem(1))).toBe(true);
    expect(queue.enqueue(makeItem(2))).toBe(true);
    expect(queue.enqueue(makeItem(3))).toBe(false);
    expect(queue.enqueue(makeItem(4))).toBe(false);

    expect(dropped.map((item) => item.id)).toEqual([3, 4]);
    expect(dropped.every((item) => item.released)).toBe(true);
    expect(queue.stats.dropped).toBe(2);
  });

  it('reports pressure when it starts dropping', () => {
    const onPressure = vi.fn();
    const pending: (() => void)[] = [];

    const queue = new ProcessingQueue<Item>({
      maxPending: 1,
      process: () => undefined,
      onDrop: () => undefined,
      onPressure,
      schedule: (task) => pending.push(task),
    });

    queue.enqueue(makeItem(1));
    queue.enqueue(makeItem(2));
    queue.enqueue(makeItem(3));

    expect(onPressure).toHaveBeenCalledOnce();
  });

  it('keeps working after a failing item', () => {
    const seen: number[] = [];
    const queue = new ProcessingQueue<Item>({
      maxPending: 10,
      process: (item) => {
        if (item.id === 2) {
          throw new Error('parser exploded');
        }
        seen.push(item.id);
      },
      onDrop: () => undefined,
      schedule: immediateSchedule,
    });

    queue.enqueue(makeItem(1));
    queue.enqueue(makeItem(2));
    queue.enqueue(makeItem(3));

    expect(seen).toEqual([1, 3]);
    expect(queue.stats.failed).toBe(1);
    expect(queue.stats.processed).toBe(2);
  });

  it('drains what it has', async () => {
    const seen: number[] = [];
    const queue = new ProcessingQueue<Item>({
      maxPending: 10,
      process: (item) => seen.push(item.id),
      onDrop: () => undefined,
    });

    queue.enqueue(makeItem(1));
    queue.enqueue(makeItem(2));

    await queue.drain(2_000);

    expect(seen).toEqual([1, 2]);
    expect(queue.stats.pending).toBe(0);
  });

  it('gives up on a backlog rather than blocking shutdown', async () => {
    const released: number[] = [];
    const queue = new ProcessingQueue<Item>({
      maxPending: 100,
      process: () => undefined,
      onDrop: (item) => released.push(item.id),
      // Work that never runs, standing in for a processor that has stalled.
      schedule: () => undefined,
    });

    queue.enqueue(makeItem(1));
    queue.enqueue(makeItem(2));

    const startedAt = Date.now();
    await queue.drain(50);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    // Everything abandoned is still released, so no memory is stranded.
    expect(released).toEqual([2]);
    expect(queue.stats.pending).toBe(0);
  });

  it('returns immediately when there is nothing to drain', async () => {
    const queue = new ProcessingQueue<Item>({
      maxPending: 10,
      process: () => undefined,
      onDrop: () => undefined,
    });

    await expect(queue.drain(5_000)).resolves.toBeUndefined();
  });

  it('releases everything it is holding when cleared', () => {
    const released: number[] = [];
    const queue = new ProcessingQueue<Item>({
      maxPending: 10,
      process: () => undefined,
      onDrop: (item) => released.push(item.id),
      schedule: () => undefined,
    });

    queue.enqueue(makeItem(1));
    queue.enqueue(makeItem(2));
    queue.clear();

    expect(released).toEqual([2]);
    expect(queue.stats.pending).toBe(0);
  });
});

describe('RateLimiter', () => {
  it('allows the first call and suppresses the rest of the window', () => {
    let now = new Date('2026-08-23T10:00:00.000Z').getTime();
    const limiter = new RateLimiter(30_000, { now: () => new Date(now) });

    expect(limiter.allow('queue-full')).toBe(true);
    expect(limiter.allow('queue-full')).toBe(false);

    now += 29_000;
    expect(limiter.allow('queue-full')).toBe(false);

    now += 2_000;
    expect(limiter.allow('queue-full')).toBe(true);
  });

  it('tracks keys independently', () => {
    const limiter = new RateLimiter(30_000, fixedClock('2026-08-23T10:00:00.000Z'));

    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('b')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
  });
});
