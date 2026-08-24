/**
 * Shared ceiling on how many captured body bytes may be held in memory at once
 * (spec section 27).
 *
 * Without it, a hundred concurrent uploads each allowed a 1 MiB capture would
 * mean 100 MiB of retained buffers. Reservation happens before bytes are kept,
 * so the limit is enforced rather than merely observed after the fact.
 */
export interface CaptureBudget {
  /** Returns false when the reservation would exceed the budget. */
  tryReserve(bytes: number): boolean;
  release(bytes: number): void;
  readonly reservedBytes: number;
  readonly limitBytes: number;
}

export class InMemoryCaptureBudget implements CaptureBudget {
  readonly #limit: number;
  #reserved = 0;

  constructor(limitBytes: number) {
    this.#limit = limitBytes;
  }

  get reservedBytes(): number {
    return this.#reserved;
  }

  get limitBytes(): number {
    return this.#limit;
  }

  tryReserve(bytes: number): boolean {
    if (bytes <= 0) {
      return true;
    }

    if (this.#reserved + bytes > this.#limit) {
      return false;
    }

    this.#reserved += bytes;
    return true;
  }

  release(bytes: number): void {
    if (bytes <= 0) {
      return;
    }

    // Clamped rather than asserted: a double release must not corrupt the
    // accounting for every request that follows.
    this.#reserved = Math.max(0, this.#reserved - bytes);
  }
}

/** Used where capture is disabled; reserves nothing and never refuses. */
export const UNLIMITED_BUDGET: CaptureBudget = {
  tryReserve: () => true,
  release: () => undefined,
  reservedBytes: 0,
  limitBytes: Number.POSITIVE_INFINITY,
};
