import type { CaptureBudget } from './capture-budget.js';

/**
 * Outcome of observing one body (spec section 26).
 *
 * `totalBytes` always reflects everything that crossed the wire, even when
 * nothing was kept: the size of a payload is metadata worth having, while its
 * contents may be far too large, or too sensitive, to retain.
 */
export interface BodyCaptureResult {
  totalBytes: number;
  capturedBytes: number;
  /** Bytes were dropped because the per-body limit was reached. */
  truncated: boolean;
  /** Bytes were dropped because the process-wide budget was exhausted. */
  budgetExceeded: boolean;
  buffer: Buffer | null;
}

export interface BodyCapture {
  observe(chunk: Buffer): void;
  finish(): BodyCaptureResult;
  /** Returns the reserved memory. Idempotent, and safe after `finish()`. */
  release(): void;
}

export interface BoundedBodyCaptureOptions {
  /** Maximum bytes retained for this body. */
  limitBytes: number;
  budget: CaptureBudget;
}

/**
 * Keeps at most `limitBytes` of a body while counting all of it.
 *
 * Every retained chunk is copied. Node hands out slices of a shared read pool,
 * so holding the original would pin the whole pool and make the budget's
 * accounting a fiction.
 */
export class BoundedBodyCapture implements BodyCapture {
  readonly #limit: number;
  readonly #budget: CaptureBudget;
  readonly #chunks: Buffer[] = [];

  #totalBytes = 0;
  #capturedBytes = 0;
  #reservedBytes = 0;
  #truncated = false;
  #budgetExceeded = false;
  #released = false;
  #finished: BodyCaptureResult | null = null;

  constructor(options: BoundedBodyCaptureOptions) {
    this.#limit = Math.max(0, options.limitBytes);
    this.#budget = options.budget;
  }

  observe(chunk: Buffer): void {
    if (chunk.byteLength === 0) {
      return;
    }

    // Counted unconditionally: size is metadata and stays accurate even once
    // retention has stopped.
    this.#totalBytes += chunk.byteLength;

    if (this.#released || this.#truncated || this.#budgetExceeded) {
      return;
    }

    const remaining = this.#limit - this.#capturedBytes;
    if (remaining <= 0) {
      this.#truncated = true;
      return;
    }

    const take = Math.min(remaining, chunk.byteLength);

    if (!this.#budget.tryReserve(take)) {
      this.#budgetExceeded = true;
      return;
    }

    this.#reservedBytes += take;
    this.#chunks.push(Buffer.from(chunk.subarray(0, take)));
    this.#capturedBytes += take;

    if (take < chunk.byteLength) {
      this.#truncated = true;
    }
  }

  finish(): BodyCaptureResult {
    if (this.#finished !== null) {
      return this.#finished;
    }

    this.#finished = {
      totalBytes: this.#totalBytes,
      capturedBytes: this.#capturedBytes,
      truncated: this.#truncated,
      budgetExceeded: this.#budgetExceeded,
      buffer: this.#released || this.#chunks.length === 0 ? null : Buffer.concat(this.#chunks),
    };

    return this.#finished;
  }

  release(): void {
    if (this.#released) {
      return;
    }

    this.#released = true;
    this.#budget.release(this.#reservedBytes);
    this.#reservedBytes = 0;
    this.#chunks.length = 0;

    if (this.#finished !== null) {
      // Drop the buffer reference too, so a retained result cannot keep the
      // payload alive after its memory has been accounted as free.
      this.#finished = { ...this.#finished, buffer: null };
    }
  }
}

/**
 * Counts a body without retaining any of it.
 *
 * Used where the payload is known to be unhelpful or unsafe to keep — binary
 * uploads, multipart forms, event streams — so that size metadata survives
 * while the content never enters memory.
 */
export class MetadataOnlyBodyCapture implements BodyCapture {
  #totalBytes = 0;

  observe(chunk: Buffer): void {
    this.#totalBytes += chunk.byteLength;
  }

  finish(): BodyCaptureResult {
    return {
      totalBytes: this.#totalBytes,
      capturedBytes: 0,
      truncated: false,
      budgetExceeded: false,
      buffer: null,
    };
  }

  release(): void {
    // Nothing was reserved and nothing was kept.
  }
}
