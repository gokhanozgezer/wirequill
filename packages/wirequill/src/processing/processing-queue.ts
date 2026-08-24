/**
 * Bounded in-process work queue (spec sections 61, 116).
 *
 * Parsing, decompressing and redacting must not happen while a response is
 * being forwarded, so completed captures are queued and handled on a later
 * turn of the event loop. The queue is bounded because an unbounded one is
 * just a memory leak that waits for a traffic burst.
 */

export interface ProcessingQueueOptions<T> {
  maxPending: number;
  process: (item: T) => void;
  /** Called when an item is dropped, so its memory can be released at once. */
  onDrop: (item: T) => void;
  /** Called on the first drop and then no more often than the rate limit. */
  onPressure?: (() => void) | undefined;
  /** Schedules the next processing turn. Overridden in tests. */
  schedule?: ((task: () => void) => void) | undefined;
}

export interface ProcessingQueueStats {
  processed: number;
  dropped: number;
  failed: number;
  pending: number;
}

export class ProcessingQueue<T> {
  readonly #options: ProcessingQueueOptions<T>;
  readonly #schedule: (task: () => void) => void;
  readonly #items: T[] = [];

  #processed = 0;
  #dropped = 0;
  #failed = 0;
  #running = false;
  #draining: (() => void)[] = [];

  constructor(options: ProcessingQueueOptions<T>) {
    this.#options = options;
    this.#schedule = options.schedule ?? ((task) => setImmediate(task));
  }

  get stats(): ProcessingQueueStats {
    return {
      processed: this.#processed,
      dropped: this.#dropped,
      failed: this.#failed,
      pending: this.#items.length,
    };
  }

  /** Returns false when the item was dropped because the queue is full. */
  enqueue(item: T): boolean {
    if (this.#items.length >= this.#options.maxPending) {
      this.#dropped += 1;
      this.#options.onPressure?.();
      this.#options.onDrop(item);
      return false;
    }

    this.#items.push(item);
    this.#pump();
    return true;
  }

  /**
   * Waits for the queue to empty, or for the deadline, whichever comes first.
   * Shutdown must stay responsive, so a backlog is abandoned rather than
   * holding Ctrl+C hostage — the items dropped are documentation samples.
   */
  async drain(timeoutMs: number): Promise<void> {
    if (this.#items.length === 0 && !this.#running) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        finish();
      }, timeoutMs);
      timer.unref();

      const finish = (): void => {
        clearTimeout(timer);
        this.#draining = this.#draining.filter((callback) => callback !== finish);
        resolve();
      };

      this.#draining.push(finish);
      this.#pump();
    });

    // Anything still queued after the deadline is released rather than leaked.
    this.clear();
  }

  /** Drops everything still queued, releasing each item. */
  clear(): void {
    for (const item of this.#items.splice(0)) {
      this.#options.onDrop(item);
    }
  }

  #pump(): void {
    if (this.#running) {
      return;
    }

    const item = this.#items.shift();
    if (item === undefined) {
      this.#settleDrain();
      return;
    }

    this.#running = true;

    this.#schedule(() => {
      try {
        this.#options.process(item);
        this.#processed += 1;
      } catch {
        // A failure to understand one payload is not a reason to stop
        // understanding the next one, and the message could quote the body.
        this.#failed += 1;
      } finally {
        this.#running = false;
        this.#pump();
      }
    });
  }

  #settleDrain(): void {
    for (const callback of this.#draining.splice(0)) {
      callback();
    }
  }
}
