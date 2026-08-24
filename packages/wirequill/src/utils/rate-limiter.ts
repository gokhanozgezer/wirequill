import type { Clock } from './clock.js';

/**
 * Lets a repeated warning through at most once per window (spec section 116).
 *
 * Capture pressure is a per-request condition: without this, a backlog would
 * print one warning per request and bury the traffic the developer is actually
 * watching.
 */
export class RateLimiter {
  readonly #windowMs: number;
  readonly #clock: Clock;
  readonly #lastAllowed = new Map<string, number>();

  constructor(windowMs: number, clock: Clock) {
    this.#windowMs = windowMs;
    this.#clock = clock;
  }

  allow(key: string): boolean {
    const now = this.#clock.now().getTime();
    const previous = this.#lastAllowed.get(key);

    if (previous !== undefined && now - previous < this.#windowMs) {
      return false;
    }

    this.#lastAllowed.set(key, now);
    return true;
  }

  reset(): void {
    this.#lastAllowed.clear();
  }
}
