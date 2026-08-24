import { mergeEvidence } from '../inference/schema/merge-evidence.js';
import type { SchemaEvidence } from '../inference/schema/types.js';
import type { SanitizedBodySummary } from './sanitized-observation.js';

/**
 * How body evidence is grouped and persisted (spec sections 65, 66).
 *
 * Two counts are kept per bucket, and the difference between them matters:
 * `observedCount` is how many bodies of this media type were seen, while
 * `analyzableCount` is how many of them could actually be read. A body that was
 * truncated, malformed or over the capture budget raises the first and not the
 * second, so nobody later mistakes "we saw four and understood three" for
 * "we saw three".
 */
export interface MediaTypeEvidence {
  observedCount: number;
  analyzableCount: number;
  schemaEvidence: SchemaEvidence | null;
}

export type BodyEvidenceByMediaType = Record<string, MediaTypeEvidence>;

export interface StatusEvidence {
  observedCount: number;
  content: BodyEvidenceByMediaType;
}

export type ResponseEvidenceByStatus = Record<string, StatusEvidence>;

/** Media type used when a body arrived without a usable `Content-Type`. */
const UNKNOWN_MEDIA_TYPE = 'application/octet-stream';

/**
 * Folds one request body into the request-body evidence.
 *
 * A request with no body contributes nothing at all: documenting an empty
 * request body bucket for every GET would be noise, not information
 * (spec section 65).
 */
export function mergeRequestBodyEvidence(
  existing: BodyEvidenceByMediaType,
  body: SanitizedBodySummary,
): BodyEvidenceByMediaType {
  if (!hasBody(body)) {
    return existing;
  }

  return mergeIntoBucket(existing, body);
}

/**
 * Folds one response into the response evidence.
 *
 * Buckets are keyed by status code and then by media type, so a 200 payload and
 * a 404 error body never merge into one schema, and `application/json` never
 * merges with `application/problem+json` (spec sections 68 and 69).
 *
 * A status with no body — a 204, a redirect — still counts: knowing an endpoint
 * answers 204 is documentation, even without content.
 */
export function mergeResponseEvidence(
  existing: ResponseEvidenceByStatus,
  statusCode: number | undefined,
  body: SanitizedBodySummary,
): ResponseEvidenceByStatus {
  if (statusCode === undefined) {
    return existing;
  }

  const key = String(statusCode);
  const current = existing[key] ?? { observedCount: 0, content: {} };

  const status: StatusEvidence = {
    observedCount: current.observedCount + 1,
    content: hasBody(body) ? mergeIntoBucket(current.content, body) : current.content,
  };

  return { ...existing, [key]: status };
}

function mergeIntoBucket(
  existing: BodyEvidenceByMediaType,
  body: SanitizedBodySummary,
): BodyEvidenceByMediaType {
  const mediaType = body.mediaType ?? UNKNOWN_MEDIA_TYPE;
  const current = existing[mediaType] ?? {
    observedCount: 0,
    analyzableCount: 0,
    schemaEvidence: null,
  };

  const incoming = body.schemaEvidence;
  const analyzable = incoming !== undefined && incoming !== null;

  const schemaEvidence = !analyzable
    ? current.schemaEvidence
    : current.schemaEvidence === null
      ? incoming
      : mergeEvidence(current.schemaEvidence, incoming);

  return {
    ...existing,
    [mediaType]: {
      observedCount: current.observedCount + 1,
      analyzableCount: current.analyzableCount + (analyzable ? 1 : 0),
      schemaEvidence,
    },
  };
}

/** Bytes actually crossed the wire; an absent body is not an empty one. */
function hasBody(body: SanitizedBodySummary): boolean {
  return body.totalBytes > 0;
}

// ------------------------------------------------------------------- decoding

/**
 * Reads evidence back out of a stored JSON blob.
 *
 * Anything unrecognisable becomes an empty bucket rather than throwing. A row
 * written by a future version, or corrupted on disk, must not stop WireQuill
 * from documenting the next request (spec section 79).
 */
export function readBodyEvidence(blob: unknown): BodyEvidenceByMediaType {
  if (!isRecord(blob)) {
    return {};
  }

  // Null-prototype, because a media type read back from storage is attacker
  // influenced and `result['__proto__'] = x` would replace the prototype.
  const result = Object.create(null) as BodyEvidenceByMediaType;

  for (const [mediaType, value] of Object.entries(blob)) {
    if (!isRecord(value)) {
      continue;
    }

    result[mediaType] = {
      observedCount: numberOr(value.observedCount, 0),
      analyzableCount: numberOr(value.analyzableCount, 0),
      schemaEvidence: isRecord(value.schemaEvidence)
        ? (value.schemaEvidence as unknown as SchemaEvidence)
        : null,
    };
  }

  return result;
}

export function readResponseEvidence(blob: unknown): ResponseEvidenceByStatus {
  if (!isRecord(blob)) {
    return {};
  }

  const result = Object.create(null) as ResponseEvidenceByStatus;

  for (const [status, value] of Object.entries(blob)) {
    if (!isRecord(value)) {
      continue;
    }

    result[status] = {
      observedCount: numberOr(value.observedCount, 0),
      content: readBodyEvidence(value.content),
    };
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
