import {
  materializeSchema,
  type MaterializeOptions,
} from '../inference/schema/materialize-schema.js';
import type {
  BodyEvidenceByMediaType,
  MediaTypeEvidence,
  ResponseEvidenceByStatus,
} from '../processing/body-evidence.js';
import type { StoredExample } from '../storage/types.js';
import { bucketKey } from '../examples/example-service.js';
import { compareStatusCodes, describeStatus } from './status-descriptions.js';
import type { OpenApiMediaType, OpenApiRequestBody, OpenApiResponse } from './types.js';

/**
 * Request bodies and responses (spec sections 76 to 81).
 *
 * Media types are sorted lexicographically and statuses numerically, so the
 * same evidence always serialises identically.
 */

export interface BodyBuildOptions {
  materialize: MaterializeOptions;
  /** The one example per bucket that documentation shows. */
  publicExamples: Map<string, StoredExample>;
}

export function buildRequestBody(
  evidence: BodyEvidenceByMediaType,
  options: BodyBuildOptions,
): OpenApiRequestBody | undefined {
  const content = buildContent(evidence, null, 'request', options);

  if (Object.keys(content).length === 0) {
    return undefined;
  }

  // `required` is deliberately absent. Observed traffic shows that a body was
  // sent, never that the server would reject a request without one
  // (spec section 77).
  return { content };
}

export function buildResponses(
  evidence: ResponseEvidenceByStatus,
  options: BodyBuildOptions,
): Record<string, OpenApiResponse> {
  const responses: Record<string, OpenApiResponse> = {};

  const statuses = Object.keys(evidence).sort(compareStatusCodes);

  for (const status of statuses) {
    const entry = evidence[status];
    if (entry === undefined) {
      continue;
    }

    const content = buildContent(entry.content, Number(status), 'response', options);
    const response: OpenApiResponse = { description: describeStatus(status) };

    // A 204, a redirect, or any status observed without a body: the status is
    // documented, the content is not invented.
    if (Object.keys(content).length > 0) {
      response.content = content;
    }

    responses[status] = response;
  }

  return responses;
}

/**
 * Builds the `content` map for one direction.
 *
 * A media type that was observed but never readable still appears, as an empty
 * entry. That is a real fact — this endpoint accepts `multipart/form-data` —
 * and dropping it would hide part of the API, while inventing a schema for it
 * would describe something WireQuill never saw (spec section 83).
 */
function buildContent(
  evidence: BodyEvidenceByMediaType,
  statusCode: number | null,
  direction: 'request' | 'response',
  options: BodyBuildOptions,
): Record<string, OpenApiMediaType> {
  const content: Record<string, OpenApiMediaType> = {};

  for (const mediaType of Object.keys(evidence).sort()) {
    const bucket = evidence[mediaType];

    if (bucket === undefined || bucket.observedCount === 0) {
      continue;
    }

    content[mediaType] = buildMediaType(bucket, {
      direction,
      statusCode,
      mediaType,
      options,
    });
  }

  return content;
}

function buildMediaType(
  bucket: MediaTypeEvidence,
  context: {
    direction: 'request' | 'response';
    statusCode: number | null;
    mediaType: string;
    options: BodyBuildOptions;
  },
): OpenApiMediaType {
  const media: OpenApiMediaType = {};

  if (bucket.analyzableCount > 0 && bucket.schemaEvidence !== null) {
    media.schema = materializeSchema(bucket.schemaEvidence, context.options.materialize);
  }

  const example = context.options.publicExamples.get(
    bucketKey({
      direction: context.direction,
      statusCode: context.statusCode,
      mediaType: context.mediaType,
    }),
  );

  if (example !== undefined) {
    media.example = parseExample(example.bodyJson);
  }

  return media;
}

/**
 * Reads a stored example back.
 *
 * The stored text is already canonical, redacted JSON, so parsing it is safe;
 * a row that somehow is not gets skipped rather than breaking the document.
 */
function parseExample(bodyJson: string): unknown {
  try {
    return JSON.parse(bodyJson);
  } catch {
    return undefined;
  }
}
