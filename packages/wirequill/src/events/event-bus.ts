import type { WireQuillEvent } from './types.js';

export type WireQuillEventListener = (event: WireQuillEvent) => void;

/**
 * Process-local event bus (spec sections 54 and 127).
 *
 * One instance, created by the composition root and handed to whoever needs it.
 * Not a module-level singleton on purpose: two runtimes in one test process
 * would otherwise see each other's traffic, and a leaked listener would outlive
 * the run that registered it.
 */
export class WireQuillEventBus {
  readonly #listeners = new Set<WireQuillEventListener>();

  /** Returns a disposer. Calling it twice is safe. */
  subscribe(listener: WireQuillEventListener): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Delivers an event to every subscriber.
   *
   * A throwing listener is isolated: this runs on the tail of request
   * processing, and a browser that disconnected mid-write must not turn into a
   * failed observation — let alone a failed proxied request (spec section 129).
   *
   * The error itself is deliberately not logged. It would arrive here holding
   * whatever the listener was doing with the payload, and the terminal policy
   * has no way to tell a safe message from a leaked one.
   */
  emit(event: WireQuillEvent): void {
    // A copy, so a listener that unsubscribes during delivery cannot mutate the
    // set being iterated.
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Intentionally empty: see above.
      }
    }
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  clear(): void {
    this.#listeners.clear();
  }
}
