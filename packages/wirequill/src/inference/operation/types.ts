import type { SegmentKind } from '../path/types.js';

/**
 * Evidence accumulated about one operation (spec sections 64, 65, 66, 159).
 *
 * Counts, never conclusions. `required` is not stored: it is derived from
 * `presentCount` and `operationSamples` whenever it is asked for, so a fourth
 * request that omits a parameter corrects the answer instead of contradicting a
 * boolean written earlier.
 *
 * Nothing here holds an observed value. Path examples are synthetic and query
 * evidence records shapes, not contents.
 */

export interface PathParameterEvidence {
  name: string;
  position: number;
  observedCount: number;
  /** How often each shape was seen at this position. */
  kinds: Partial<Record<SegmentKind, number>>;
  /** A stand-in value, never something a client actually sent. */
  syntheticExample: string;
}

export type QueryPrimitiveType = 'boolean' | 'integer' | 'number' | 'string';
export type QueryValueFormat = 'uuid' | 'date' | 'dateTime';

export interface QueryParameterEvidence {
  name: string;
  /** Requests seen for this operation while this parameter was being tracked. */
  operationSamples: number;
  presentCount: number;
  /** Requests where the parameter appeared more than once. */
  repeatedCount: number;
  typeCounts: Partial<Record<QueryPrimitiveType | 'array', number>>;
  formatCounts: Partial<Record<QueryValueFormat, number>>;
  /** The value was redacted, so its shape says nothing about its type. */
  sensitive: boolean;
}

export interface HeaderParameterEvidence {
  /** Lower-case, which is how HTTP compares header names. */
  name: string;
  /** The casing the client actually used, for display. */
  displayName: string;
  operationSamples: number;
  presentCount: number;
}

export interface SecurityEvidence {
  bearer: number;
  basic: number;
  other: number;
  apiKeys: Record<string, { location: 'header' | 'query'; count: number }>;
  unauthenticated: number;
}

/** Everything an operation row carries, before OpenAPI exists to render it. */
export interface OperationEvidence {
  pathParameters: PathParameterEvidence[];
  queryParameters: QueryParameterEvidence[];
  headerParameters: HeaderParameterEvidence[];
  security: SecurityEvidence;
}

export function emptySecurityEvidence(): SecurityEvidence {
  return { bearer: 0, basic: 0, other: 0, apiKeys: {}, unauthenticated: 0 };
}

export function emptyOperationEvidence(): OperationEvidence {
  return {
    pathParameters: [],
    queryParameters: [],
    headerParameters: [],
    security: emptySecurityEvidence(),
  };
}

/**
 * Requiredness rule (spec section 38).
 *
 * Three samples is the smallest number that distinguishes a genuinely required
 * parameter from one that simply happened to be present. Below that, WireQuill
 * has not seen enough to claim anything.
 */
export const REQUIRED_AFTER_SAMPLES = 3;

export function isRequired(operationSamples: number, presentCount: number): boolean {
  return operationSamples >= REQUIRED_AFTER_SAMPLES && presentCount === operationSamples;
}
