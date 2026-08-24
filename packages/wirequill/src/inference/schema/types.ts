/**
 * Schema evidence (spec sections 41 to 48).
 *
 * ============================ VALUE-FREE ============================
 *
 * This structure records what WireQuill has *seen* about a body's shape, never
 * what was in it. There is no `example`, no `default`, no `minimum`, no
 * `enum` — not because those fields are unimplemented, but because every one of
 * them would carry an observed value out of the privacy boundary.
 *
 * A property called `password` is part of the schema; the password is not.
 *
 * ====================================================================
 *
 * Evidence is the source of truth and is what gets persisted. A JSON Schema is
 * derived from it on demand. Merging two materialised schemas instead would
 * throw away the presence counts that make requiredness answerable.
 */

export type PrimitiveType =
  'null' | 'boolean' | 'integer' | 'number' | 'string' | 'array' | 'object';

/**
 * Canonical ordering for every union WireQuill emits.
 *
 * `null` is absent here and always appended last, because a nullable string
 * reads as `["string", "null"]` to anyone who has read JSON Schema before.
 */
export const TYPE_ORDER: readonly PrimitiveType[] = [
  'boolean',
  'integer',
  'number',
  'string',
  'array',
  'object',
];

export type StringFormat = 'uuid' | 'date' | 'date-time' | 'email' | 'uri' | 'ipv4' | 'ipv6';

/** Priority order when a value could match more than one format. */
export const FORMAT_ORDER: readonly StringFormat[] = [
  'uuid',
  'date-time',
  'date',
  'email',
  'ipv4',
  'ipv6',
  'uri',
];

export interface StringEvidence {
  formatCounts: Partial<Record<StringFormat, number>>;
  /** Strings that matched no known format. */
  unformattedCount: number;
}

export interface PropertyEvidence {
  /** Object samples in which this property was present. */
  present: number;
  evidence: SchemaEvidence;
}

export interface ObjectEvidence {
  objectSamples: number;
  /**
   * Samples where traversal stopped early — a property limit, a node budget.
   *
   * Any value above zero disables requiredness for this node: a property that
   * was never looked at cannot be reported as absent.
   */
  incompleteSamples: number;
  properties: Record<string, PropertyEvidence>;
}

export interface ArrayEvidence {
  arraySamples: number;
  nonEmptyArrays: number;
  /** Items actually inspected, which the inspection limit may cap. */
  itemsObserved: number;
  incompleteSamples: number;
  items?: SchemaEvidence | undefined;
}

export interface SchemaEvidence {
  /** Values seen at this position across every sample. */
  observed: number;
  typeCounts: Partial<Record<PrimitiveType, number>>;
  /** A limit stopped this node from being fully described. */
  incomplete?: boolean | undefined;
  string?: StringEvidence | undefined;
  object?: ObjectEvidence | undefined;
  array?: ArrayEvidence | undefined;
}

export function emptyEvidence(): SchemaEvidence {
  return { observed: 0, typeCounts: {} };
}

/** True when nothing has been observed and nothing can be said. */
export function isEmptyEvidence(evidence: SchemaEvidence | null | undefined): boolean {
  return evidence === undefined || evidence === null || evidence.observed === 0;
}
