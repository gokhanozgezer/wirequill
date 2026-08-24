import type {
  HeaderParameterEvidence,
  PathParameterEvidence,
  QueryParameterEvidence,
  SecurityEvidence,
} from '../inference/operation/types.js';
import { emptySecurityEvidence } from '../inference/operation/types.js';
import type { MaterializeOptions } from '../inference/schema/materialize-schema.js';
import { selectPublicExamples } from '../examples/example-service.js';
import { readBodyEvidence, readResponseEvidence } from '../processing/body-evidence.js';
import type { StoredExample, StoredOperation } from '../storage/types.js';
import { sha256Hex } from '../utils/ids.js';
import { stableStringify } from '../utils/stable-json.js';
import { buildRequestBody, buildResponses } from './build-bodies.js';
import {
  buildHeaderParameters,
  buildPathParameters,
  buildQueryParameters,
} from './build-parameters.js';
import { buildSecurity } from './build-security.js';
import { buildSummary } from './summaries.js';
import { buildTags } from './tags.js';
import type { OpenApiOperation, OpenApiParameter, PublicOperation } from './types.js';

export interface BuildOperationOptions {
  materialize: MaterializeOptions;
  requiredAfterSamples: number;
}

/**
 * Materialises one stored operation into its public form
 * (spec sections 71 and 72).
 *
 * The stored row is evidence — counts, per parameter, per property, per status.
 * This is the contract derived from it, rebuilt whenever it is asked for rather
 * than stored. Nothing here writes anything.
 */
export function buildPublicOperation(
  operation: StoredOperation,
  examples: readonly StoredExample[],
  options: BuildOperationOptions,
): PublicOperation {
  const publicExamples = selectPublicExamples(examples);
  const bodyOptions = { materialize: options.materialize, publicExamples };

  const parameters: OpenApiParameter[] = [
    ...buildPathParameters(readArray<PathParameterEvidence>(operation.pathParameters)),
    ...buildQueryParameters(
      readArray<QueryParameterEvidence>(operation.queryParameters),
      options.requiredAfterSamples,
    ),
    ...buildHeaderParameters(
      readArray<HeaderParameterEvidence>(operation.headerParameters),
      options.requiredAfterSamples,
    ),
  ];

  const security = buildSecurity(readSecurity(operation.securityEvidence), operation.observedCount);

  const tags = buildTags(operation.pathTemplate);
  const requestBody = buildRequestBody(
    readBodyEvidence(operation.requestBodiesEvidence),
    bodyOptions,
  );

  const responses = buildResponses(readResponseEvidence(operation.responsesEvidence), bodyOptions);

  const built: OpenApiOperation = {
    operationId: operation.operationId,
    summary: buildSummary(operation.method, operation.pathTemplate),
    ...(tags.length > 0 ? { tags } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(security.requirement === undefined ? {} : { security: security.requirement }),
    ...(requestBody === undefined ? {} : { requestBody }),
    // An empty `responses` is invalid in OpenAPI 3.1; the endpoint is still
    // documented, just without a response nobody has seen yet.
    ...(Object.keys(responses).length > 0 ? { responses } : {}),
  };

  return {
    method: operation.method.toLowerCase(),
    path: operation.pathTemplate,
    operation: built,
    securitySchemes: security.schemes,
  };
}

/**
 * Fingerprints an operation's public shape (spec section 70).
 *
 * This is what decides whether `public_revision` moves, so it has to cover
 * exactly what a reader of the documentation would notice and nothing else.
 * Counters are absent from the public operation by construction — there is no
 * `observedCount` in it — so a hundred identical requests fingerprint the same
 * way and the revision stays put.
 */
export function fingerprintOperation(operation: PublicOperation): string {
  return sha256Hex(
    stableStringify({
      method: operation.method,
      path: operation.path,
      operation: operation.operation,
      securitySchemes: operation.securitySchemes,
    }),
  );
}

function readArray<T>(blob: unknown): T[] {
  return Array.isArray(blob) ? (blob as T[]) : [];
}

function readSecurity(blob: unknown): SecurityEvidence {
  if (typeof blob !== 'object' || blob === null || Array.isArray(blob)) {
    return emptySecurityEvidence();
  }

  const candidate = blob as Partial<SecurityEvidence>;

  return {
    bearer: numberOr(candidate.bearer),
    basic: numberOr(candidate.basic),
    other: numberOr(candidate.other),
    apiKeys:
      typeof candidate.apiKeys === 'object' && candidate.apiKeys !== null ? candidate.apiKeys : {},
    unauthenticated: numberOr(candidate.unauthenticated),
  };
}

function numberOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
