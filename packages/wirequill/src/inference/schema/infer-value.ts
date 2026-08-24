import { detectFormat } from './detect-format.js';
import {
  createBudget,
  spendNode,
  DEFAULT_SCHEMA_LIMITS,
  type SchemaBudget,
  type SchemaLimits,
} from './limits.js';
import { mergeEvidence } from './merge-evidence.js';
import type {
  ObjectEvidence,
  PrimitiveType,
  PropertyEvidence,
  SchemaEvidence,
  StringEvidence,
} from './types.js';

/**
 * Turns one parsed body into value-free structural evidence
 * (spec sections 42, 43, 45).
 *
 * ================= CALLED WITH RAW, RETURNS SAFE =================
 *
 * The input is the body exactly as it was parsed, before redaction. That is
 * deliberate and it is the only way this can work: inferring from a redacted
 * body would see `"[REDACTED]"` where a `cvv: 123` had been and record it as a
 * string, and an email would lose its format.
 *
 * The output carries no value from the input. Property names survive — they are
 * the schema — but every leaf is reduced to a type, an optional format label,
 * and a count.
 *
 * ================================================================
 */
export function inferSchemaEvidence(
  value: unknown,
  limits: SchemaLimits = DEFAULT_SCHEMA_LIMITS,
): SchemaEvidence {
  return infer(value, 0, createBudget(limits));
}

function infer(value: unknown, depth: number, budget: SchemaBudget): SchemaEvidence {
  // Both limits produce the same answer: name the type, admit that the rest was
  // not examined, and stop. Claiming more would be inventing structure.
  if (depth > budget.limits.maxDepth || !spendNode(budget)) {
    return typeOnly(value);
  }

  if (value === null) {
    return counted('null');
  }

  switch (typeof value) {
    case 'boolean':
      return counted('boolean');

    case 'number':
      return counted(Number.isInteger(value) ? 'integer' : 'number');

    case 'string':
      return inferString(value, budget.limits);

    case 'object':
      return Array.isArray(value)
        ? inferArray(value, depth, budget)
        : inferObject(value as Record<string, unknown>, depth, budget);

    default:
      // `undefined`, a function, a symbol: not reachable from JSON.parse, and
      // nothing truthful can be said about them.
      return { observed: 1, typeCounts: {}, incomplete: true };
  }
}

function inferString(value: string, limits: SchemaLimits): SchemaEvidence {
  const format = detectFormat(value, limits.maxFormatDetectionLength);

  const string: StringEvidence =
    format === null
      ? { formatCounts: {}, unformattedCount: 1 }
      : { formatCounts: { [format]: 1 }, unformattedCount: 0 };

  return { observed: 1, typeCounts: { string: 1 }, string };
}

function inferArray(value: unknown[], depth: number, budget: SchemaBudget): SchemaEvidence {
  const inspected = Math.min(value.length, budget.limits.maxArrayItems);
  const truncated = value.length > inspected;

  let items: SchemaEvidence | undefined;

  for (let index = 0; index < inspected; index += 1) {
    const itemEvidence = infer(value[index], depth + 1, budget);
    items = items === undefined ? itemEvidence : mergeEvidence(items, itemEvidence);
  }

  const array = {
    arraySamples: 1,
    nonEmptyArrays: value.length > 0 ? 1 : 0,
    itemsObserved: inspected,
    incompleteSamples: truncated ? 1 : 0,
    ...(items === undefined ? {} : { items }),
  };

  return {
    observed: 1,
    typeCounts: { array: 1 },
    ...(truncated ? { incomplete: true } : {}),
    array,
  };
}

function inferObject(
  value: Record<string, unknown>,
  depth: number,
  budget: SchemaBudget,
): SchemaEvidence {
  // Sorted, so a body with more properties than the limit always contributes
  // the same subset rather than whichever ones happened to be serialised first.
  const keys = Object.keys(value).sort();
  const inspected = Math.min(keys.length, budget.limits.maxProperties);

  // A null-prototype dictionary, so a body carrying `__proto__` or
  // `constructor` writes an ordinary own property (spec section 49).
  const properties = Object.create(null) as Record<string, PropertyEvidence>;

  let skipped = keys.length > inspected;

  for (let index = 0; index < inspected; index += 1) {
    const key = keys[index];

    if (key === undefined || !isUsablePropertyName(key, budget.limits)) {
      // A key this hostile is not a field name any API meant to expose.
      skipped = true;
      continue;
    }

    properties[key] = { present: 1, evidence: infer(value[key], depth + 1, budget) };
  }

  const object: ObjectEvidence = {
    objectSamples: 1,
    incompleteSamples: skipped ? 1 : 0,
    properties,
  };

  return {
    observed: 1,
    typeCounts: { object: 1 },
    ...(skipped ? { incomplete: true } : {}),
    object,
  };
}

/**
 * A property name has to survive being stored and displayed.
 *
 * Rejected rather than rewritten: a truncated or stripped key would be a field
 * name that does not exist, which is worse documentation than an admittedly
 * incomplete object.
 */
function isUsablePropertyName(key: string, limits: SchemaLimits): boolean {
  if (key.length === 0 || key.length > limits.maxPropertyNameLength) {
    return false;
  }

  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }

  return true;
}

function counted(type: PrimitiveType): SchemaEvidence {
  return { observed: 1, typeCounts: { [type]: 1 } };
}

/** Records what a value is without descending into it. */
function typeOnly(value: unknown): SchemaEvidence {
  const type = primitiveTypeOf(value);

  return type === null
    ? { observed: 1, typeCounts: {}, incomplete: true }
    : { observed: 1, typeCounts: { [type]: 1 }, incomplete: true };
}

function primitiveTypeOf(value: unknown): PrimitiveType | null {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'string':
      return 'string';
    case 'object':
      return Array.isArray(value) ? 'array' : 'object';
    default:
      return null;
  }
}
