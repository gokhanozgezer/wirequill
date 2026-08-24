import type { Storage } from '../storage/storage.js';
import type { StoredExample } from '../storage/types.js';
import { toIsoString, type Clock } from '../utils/clock.js';
import type { IdGenerator } from '../utils/ids.js';
import type { CandidateExample, ExampleBucket } from './types.js';

export interface ExampleServiceOptions {
  storage: Storage;
  ids: IdGenerator;
  clock: Clock;
  /** Unique examples kept per bucket (spec section 57). */
  maxPerBucket: number;
}

/**
 * Stores a small, bounded set of redacted examples per operation.
 *
 * Only the first example in each bucket is ever published, so the rest exist as
 * headroom for a later phase that wants named examples — and as a reason not to
 * grow the table without limit in the meantime.
 */
export class ExampleService {
  readonly #options: ExampleServiceOptions;

  constructor(options: ExampleServiceOptions) {
    this.#options = options;
  }

  /**
   * Persists candidates that belong in a bucket with room left.
   *
   * Returns the operation's examples as they now stand, so the caller can work
   * out whether public documentation changed without reading them back.
   *
   * A rejected example — duplicate, or a full bucket — is not an error. It is
   * the normal case once an endpoint has been exercised a few times, and it
   * must never fail the operation update it travels with (spec section 60).
   */
  record(
    operationRowId: string,
    candidates: readonly CandidateExample[],
    existing: readonly StoredExample[],
  ): StoredExample[] {
    const result = [...existing];

    for (const candidate of candidates) {
      const stored: StoredExample = {
        id: this.#options.ids.next(),
        operationId: operationRowId,
        direction: candidate.direction,
        statusCode: candidate.statusCode,
        mediaType: candidate.mediaType,
        bodyJson: candidate.bodyJson,
        bodyHash: candidate.bodyHash,
        observedAt: toIsoString(this.#options.clock.now()),
      };

      try {
        if (this.#options.storage.insertExampleIfUnique(stored, this.#options.maxPerBucket)) {
          result.push(stored);
        }
      } catch {
        // A unique-constraint race is an expected condition here, not a
        // failure: the example was already documented by another request.
      }
    }

    return result;
  }
}

export function bucketKey(bucket: ExampleBucket): string {
  return [bucket.direction, bucket.statusCode ?? '-', bucket.mediaType].join(' ');
}

/**
 * Picks the one example per bucket that documentation shows.
 *
 * First observed wins, ordered by observation time and then by id so that a
 * clock with coarse resolution cannot make the choice ambiguous
 * (spec sections 76 and 77).
 */
export function selectPublicExamples(
  examples: readonly StoredExample[],
): Map<string, StoredExample> {
  const ordered = [...examples].sort((left, right) => {
    const byTime = left.observedAt.localeCompare(right.observedAt);
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });

  const chosen = new Map<string, StoredExample>();

  for (const example of ordered) {
    const key = bucketKey(example);
    if (!chosen.has(key)) {
      chosen.set(key, example);
    }
  }

  return chosen;
}

/** True when this candidate would become the first example its bucket has. */
export function isFirstInBucket(
  candidate: CandidateExample,
  existing: readonly StoredExample[],
): boolean {
  const key = bucketKey(candidate);
  return !existing.some((example) => bucketKey(example) === key);
}
