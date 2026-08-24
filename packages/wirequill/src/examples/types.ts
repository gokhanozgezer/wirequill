import type { ExampleDirection } from '../storage/types.js';

/**
 * Identity of an example bucket (spec section 55).
 *
 * A request example and a 200 response example are different documentation, and
 * so are a 200 body and a 404 body. Bucketing on all four keeps them apart.
 */
export interface ExampleBucket {
  direction: ExampleDirection;
  /** `null` for request bodies, which have no status. */
  statusCode: number | null;
  mediaType: string;
}

/** A redacted body ready to be stored, and the hash that dedupes it. */
export interface CandidateExample extends ExampleBucket {
  /** Canonical JSON of the *sanitized* body. Never a raw payload. */
  bodyJson: string;
  bodyHash: string;
}

/**
 * Maximum serialised size of a stored example (spec section 115).
 *
 * The capture limit already caps the body at 1 MiB, but a redacted structure
 * can still serialise large, and documentation gains nothing from a
 * quarter-megabyte sample. Schema evidence is unaffected: the shape is still
 * learned, only the example is skipped.
 */
export const MAX_EXAMPLE_BYTES = 256 * 1024;
