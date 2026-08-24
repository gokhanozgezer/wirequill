import {
  TYPE_ORDER,
  type PrimitiveType,
  type SchemaEvidence,
  type StringEvidence,
  type StringFormat,
} from './types.js';

/**
 * The public shape of an inferred schema.
 *
 * Deliberately small. Every field JSON Schema offers that WireQuill could not
 * honestly fill from observed traffic — `enum`, `const`, `pattern`, `minimum`,
 * `maxLength`, `additionalProperties`, `example`, `default` — is absent from
 * this type, so there is no way to emit one by accident.
 */
export interface JsonSchema {
  type?: PrimitiveType | PrimitiveType[];
  format?: StringFormat;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  oneOf?: JsonSchema[];
}

export interface MaterializeOptions {
  /** Object samples needed before a property may be called required. */
  requiredAfterSamples: number;
}

export const DEFAULT_MATERIALIZE_OPTIONS: MaterializeOptions = {
  requiredAfterSamples: 3,
};

/**
 * Derives a JSON Schema from accumulated evidence (spec section 54).
 *
 * Evidence is the source of truth and stays in the database; this is a view of
 * it, recomputed whenever it is needed. Nothing here invents a constraint the
 * traffic did not show, and an empty schema — `{}` — is the honest answer when
 * nothing was observed.
 */
export function materializeSchema(
  evidence: SchemaEvidence | null | undefined,
  options: MaterializeOptions = DEFAULT_MATERIALIZE_OPTIONS,
): JsonSchema {
  if (evidence === null || evidence === undefined || evidence.observed === 0) {
    return {};
  }

  const types = presentTypes(evidence);

  if (types.length === 0) {
    // Observed, but a limit stopped WireQuill from learning what it was.
    return {};
  }

  const nullable = types.includes('null');
  const concrete = orderTypes(types.filter((type) => type !== 'null'));

  if (concrete.length === 0) {
    return { type: 'null' };
  }

  if (concrete.length === 1) {
    const branch = buildBranch(concrete[0] as PrimitiveType, evidence, options);
    return nullable ? withNull(branch) : branch;
  }

  // Genuinely incompatible shapes, such as a field that is sometimes a string
  // and sometimes an object. A union is the truthful answer.
  const branches = concrete.map((type) => buildBranch(type, evidence, options));

  return { oneOf: nullable ? [...branches, { type: 'null' }] : branches };
}

/**
 * Which types were actually seen, with `integer` folded into `number` when both
 * were (spec section 43). Every integer is a number; the reverse is not true.
 */
function presentTypes(evidence: SchemaEvidence): PrimitiveType[] {
  const seen = (Object.entries(evidence.typeCounts) as [PrimitiveType, number][])
    .filter(([, count]) => count > 0)
    .map(([type]) => type);

  if (seen.includes('integer') && seen.includes('number')) {
    return seen.filter((type) => type !== 'integer');
  }

  return seen;
}

/** Canonical order, so a union always reads the same way. */
function orderTypes(types: readonly PrimitiveType[]): PrimitiveType[] {
  return TYPE_ORDER.filter((type) => types.includes(type));
}

/**
 * Adds `null` to a branch.
 *
 * Written as `["string", "null"]` rather than `["null", "string"]`: the real
 * type first is how JSON Schema is read everywhere, and the ordering is still
 * fully determined.
 */
function withNull(schema: JsonSchema): JsonSchema {
  const existing = schema.type;

  if (existing === undefined) {
    return { ...schema, type: 'null' };
  }

  const types = Array.isArray(existing) ? existing : [existing];

  return { ...schema, type: [...types, 'null'] };
}

function buildBranch(
  type: PrimitiveType,
  evidence: SchemaEvidence,
  options: MaterializeOptions,
): JsonSchema {
  switch (type) {
    case 'string':
      return buildString(evidence.string, evidence.typeCounts.string ?? 0);

    case 'array':
      return buildArray(evidence, options);

    case 'object':
      return buildObject(evidence, options);

    default:
      return { type };
  }
}

/**
 * Emits a format only when every string seen at this position had it
 * (spec section 47).
 *
 * Three emails and one arbitrary string is not an email field, and saying so
 * would send a reader looking for a bug that is not there.
 */
function buildString(string: StringEvidence | undefined, stringCount: number): JsonSchema {
  if (string === undefined || string.unformattedCount > 0) {
    return { type: 'string' };
  }

  const formats = (Object.entries(string.formatCounts) as [StringFormat, number][]).filter(
    ([, count]) => count > 0,
  );

  const only = formats.length === 1 ? formats[0] : undefined;

  if (only === undefined || only[1] !== stringCount) {
    return { type: 'string' };
  }

  return { type: 'string', format: only[0] };
}

function buildArray(evidence: SchemaEvidence, options: MaterializeOptions): JsonSchema {
  const items = evidence.array?.items;

  // An array that has only ever been empty says nothing about its items, so
  // `{}` is emitted rather than a guess (spec section 45).
  return { type: 'array', items: materializeSchema(items, options) };
}

function buildObject(evidence: SchemaEvidence, options: MaterializeOptions): JsonSchema {
  const object = evidence.object;

  if (object === undefined) {
    // The type is known; the shape was never examined.
    return { type: 'object' };
  }

  // A null-prototype target. On a plain object, `properties['__proto__'] = x`
  // invokes the prototype setter instead of defining a property: the field
  // would vanish from the schema, and the object's prototype would be replaced
  // by request data.
  const properties = Object.create(null) as Record<string, JsonSchema>;
  const names = Object.keys(object.properties).sort();

  for (const name of names) {
    const property = object.properties[name];
    if (property !== undefined) {
      properties[name] = materializeSchema(property.evidence, options);
    }
  }

  const schema: JsonSchema = { type: 'object', properties };
  const required = requiredProperties(evidence, options);

  if (required.length > 0) {
    schema.required = required;
  }

  return schema;
}

/**
 * Requiredness (spec sections 44, 17).
 *
 * Three conditions, all necessary. Enough samples to mean anything; no sample
 * where traversal stopped early, because a property nobody looked at cannot be
 * called absent; and presence in every single sample.
 */
function requiredProperties(evidence: SchemaEvidence, options: MaterializeOptions): string[] {
  const object = evidence.object;

  if (object === undefined || object.incompleteSamples > 0) {
    return [];
  }

  if (object.objectSamples < options.requiredAfterSamples) {
    return [];
  }

  return Object.keys(object.properties)
    .filter((name) => object.properties[name]?.present === object.objectSamples)
    .sort();
}
