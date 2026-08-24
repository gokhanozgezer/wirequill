import type { JsonSchema } from '../inference/schema/materialize-schema.js';
import {
  isRequired,
  type HeaderParameterEvidence,
  type PathParameterEvidence,
  type QueryParameterEvidence,
  type QueryPrimitiveType,
} from '../inference/operation/types.js';
import type { SegmentKind } from '../inference/path/types.js';
import type { OpenApiParameter } from './types.js';

/**
 * Turns parameter evidence into OpenAPI parameters (spec sections 74 and 75).
 *
 * Ordering is fixed — path in path order, then query and header alphabetically
 * — so the same evidence always serialises to the same bytes.
 */

/** How a path segment kind is described in a schema. */
const PATH_SCHEMAS: Record<SegmentKind, JsonSchema> = {
  literal: { type: 'string' },
  integer: { type: 'integer' },
  uuid: { type: 'string', format: 'uuid' },
  // No invented `format: objectid` or `format: ulid`: those are not registered
  // formats, and a reader's tooling would not know what to do with them.
  objectId: { type: 'string' },
  ulid: { type: 'string' },
  date: { type: 'string', format: 'date' },
  email: { type: 'string', format: 'email' },
  token: { type: 'string' },
};

export function buildPathParameters(
  evidence: readonly PathParameterEvidence[],
): OpenApiParameter[] {
  return [...evidence]
    .sort((left, right) => left.position - right.position)
    .map((parameter) => ({
      name: parameter.name,
      in: 'path' as const,
      // A path parameter is part of the route; it cannot be optional.
      required: true,
      schema: PATH_SCHEMAS[dominantKind(parameter)],
      example: parameter.syntheticExample,
    }));
}

/** The shape seen most often at this position, ties broken deterministically. */
function dominantKind(parameter: PathParameterEvidence): SegmentKind {
  const entries = Object.entries(parameter.kinds) as [SegmentKind, number][];

  const best = entries
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .at(0);

  return best?.[0] ?? 'literal';
}

export function buildQueryParameters(
  evidence: readonly QueryParameterEvidence[],
  requiredAfterSamples: number,
): OpenApiParameter[] {
  return [...evidence]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((parameter) => {
      const required = isRequiredWithThreshold(parameter, requiredAfterSamples);

      return {
        name: parameter.name,
        in: 'query' as const,
        ...(required ? { required: true } : {}),
        schema: querySchema(parameter),
        // No example: real query values were never persisted, and a synthetic
        // one would be indistinguishable from an observed one to a reader.
      };
    });
}

function isRequiredWithThreshold(
  parameter: QueryParameterEvidence,
  requiredAfterSamples: number,
): boolean {
  return (
    parameter.operationSamples >= requiredAfterSamples &&
    parameter.presentCount === parameter.operationSamples &&
    isRequired(parameter.operationSamples, parameter.presentCount)
  );
}

/**
 * A query parameter's schema.
 *
 * A redacted value has no shape left to read, so it is documented as a plain
 * string rather than guessed at. Where several types were genuinely observed,
 * a union says so instead of picking a winner.
 */
function querySchema(parameter: QueryParameterEvidence): JsonSchema {
  if (parameter.sensitive) {
    return { type: 'string' };
  }

  const repeated = (parameter.typeCounts.array ?? 0) > 0;
  const scalar = scalarSchema(parameter);

  return repeated ? { type: 'array', items: scalar } : scalar;
}

const QUERY_TYPE_ORDER: readonly QueryPrimitiveType[] = ['boolean', 'integer', 'number', 'string'];

function scalarSchema(parameter: QueryParameterEvidence): JsonSchema {
  const present = QUERY_TYPE_ORDER.filter((type) => (parameter.typeCounts[type] ?? 0) > 0);

  if (present.length === 0) {
    return { type: 'string' };
  }

  // Every integer is a number, so seeing both is not a disagreement.
  const types =
    present.includes('integer') && present.includes('number')
      ? present.filter((type) => type !== 'integer')
      : present;

  if (types.length > 1) {
    return { oneOf: types.map((type) => ({ type })) };
  }

  const single = types[0] ?? 'string';
  const format = dominantFormat(parameter, single);

  return format === null ? { type: single } : { type: single, format };
}

/** A format is claimed only when every observed value carried it. */
function dominantFormat(
  parameter: QueryParameterEvidence,
  type: QueryPrimitiveType,
): 'uuid' | 'date' | 'date-time' | null {
  if (type !== 'string') {
    return null;
  }

  const stringCount = parameter.typeCounts.string ?? 0;
  const formats = Object.entries(parameter.formatCounts).filter(([, count]) => count > 0);
  const only = formats.length === 1 ? formats[0] : undefined;

  if (only === undefined || only[1] !== stringCount) {
    return null;
  }

  return only[0] === 'dateTime' ? 'date-time' : (only[0] as 'uuid' | 'date');
}

export function buildHeaderParameters(
  evidence: readonly HeaderParameterEvidence[],
  requiredAfterSamples: number,
): OpenApiParameter[] {
  return [...evidence]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((parameter) => {
      const required =
        parameter.operationSamples >= requiredAfterSamples &&
        parameter.presentCount === parameter.operationSamples;

      return {
        // Canonical casing, so the same header always renders the same way
        // regardless of how a particular client wrote it.
        name: canonicalHeaderName(parameter.name),
        in: 'header' as const,
        ...(required ? { required: true } : {}),
        // Header values are strings on the wire, and WireQuill does not coerce.
        schema: { type: 'string' as const },
      };
    });
}

/** `x-tenant-id` becomes `X-Tenant-Id`. */
export function canonicalHeaderName(name: string): string {
  return name
    .split('-')
    .map((part) => (part === '' ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-');
}
