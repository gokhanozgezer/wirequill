import type { SanitizedBodySummary } from '../processing/sanitized-observation.js';
import type { ExampleDirection } from '../storage/types.js';
import { sha256Hex } from '../utils/ids.js';
import { stableStringify } from '../utils/stable-json.js';
import { MAX_EXAMPLE_BYTES, type CandidateExample } from './types.js';

/**
 * Turns a sanitized body into a storable example (spec sections 55, 56).
 *
 * ================= SANITIZED INPUT ONLY =================
 *
 * The only input is `SanitizedBodySummary.redacted`, which is the redacted
 * structure produced in the privacy boundary. The raw parsed body is never a
 * source of examples, and there is no code path here that could reach one.
 *
 * The hash is taken over that same sanitized form. Hashing the raw body would
 * create a stable fingerprint of a plaintext secret — a correlation handle for
 * anything that later got hold of the database — for no benefit, since dedupe
 * only ever compares what is actually stored.
 *
 * ========================================================
 */
export function canonicalizeExample(
  body: SanitizedBodySummary,
  direction: ExampleDirection,
  statusCode: number | null,
): CandidateExample | null {
  if (!isEligible(body)) {
    return null;
  }

  const mediaType = body.mediaType;
  if (mediaType === undefined) {
    return null;
  }

  let bodyJson: string;
  try {
    // Canonical form: sorted keys, so an identical body written in a different
    // order dedupes against what is already stored.
    bodyJson = stableStringify(body.redacted);
  } catch {
    // A cyclic or otherwise unserialisable structure is not an example.
    return null;
  }

  if (Buffer.byteLength(bodyJson, 'utf8') > MAX_EXAMPLE_BYTES) {
    return null;
  }

  return {
    direction,
    statusCode,
    mediaType,
    bodyJson,
    bodyHash: sha256Hex(bodyJson),
  };
}

/**
 * Whether a body may be kept as an example at all (spec sections 57, 58).
 *
 * The bar is deliberately the same as for schema inference: WireQuill must have
 * fully read the body. A truncated document would be stored as documentation of
 * a request nobody made, and a binary or multipart body has no readable form to
 * store.
 */
function isEligible(body: SanitizedBodySummary): boolean {
  if (body.truncated || body.budgetExceeded) {
    return false;
  }

  if (body.parseStatus !== 'json' && body.parseStatus !== 'form') {
    return false;
  }

  return body.redacted !== undefined;
}
