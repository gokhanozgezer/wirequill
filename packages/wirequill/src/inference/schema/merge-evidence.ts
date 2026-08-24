import type {
  ArrayEvidence,
  ObjectEvidence,
  PrimitiveType,
  PropertyEvidence,
  SchemaEvidence,
  StringEvidence,
  StringFormat,
} from './types.js';

/**
 * Folds one body's evidence into what is already known (spec section 46).
 *
 * Every field is a count, so merging is addition, which makes it commutative
 * and associative: `merge(a, b, c)` and `merge(c, a, b)` produce the same
 * evidence. Request order must never change documentation.
 *
 * Neither input is mutated. The result is a fresh tree.
 */
export function mergeEvidence(left: SchemaEvidence, right: SchemaEvidence): SchemaEvidence {
  const merged: SchemaEvidence = {
    observed: left.observed + right.observed,
    typeCounts: addCounts(left.typeCounts, right.typeCounts),
  };

  if (left.incomplete === true || right.incomplete === true) {
    merged.incomplete = true;
  }

  const string = mergeString(left.string, right.string);
  if (string !== undefined) {
    merged.string = string;
  }

  const object = mergeObject(left.object, right.object);
  if (object !== undefined) {
    merged.object = object;
  }

  const array = mergeArray(left.array, right.array);
  if (array !== undefined) {
    merged.array = array;
  }

  return merged;
}

export function mergeAll(evidences: readonly SchemaEvidence[]): SchemaEvidence {
  return evidences.reduce<SchemaEvidence>(
    (accumulated, current) => mergeEvidence(accumulated, current),
    { observed: 0, typeCounts: {} },
  );
}

function mergeString(
  left: StringEvidence | undefined,
  right: StringEvidence | undefined,
): StringEvidence | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }

  return {
    formatCounts: addCounts<StringFormat>(left.formatCounts, right.formatCounts),
    unformattedCount: left.unformattedCount + right.unformattedCount,
  };
}

function mergeObject(
  left: ObjectEvidence | undefined,
  right: ObjectEvidence | undefined,
): ObjectEvidence | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }

  const properties = Object.create(null) as Record<string, PropertyEvidence>;

  for (const key of Object.keys(left.properties)) {
    const entry = left.properties[key];
    if (entry !== undefined) {
      properties[key] = entry;
    }
  }

  for (const key of Object.keys(right.properties)) {
    const incoming = right.properties[key];
    if (incoming === undefined) {
      continue;
    }

    const existing = properties[key];

    // A property missing from one side keeps its own presence count: that is
    // exactly the record of it having been absent from those samples.
    properties[key] =
      existing === undefined
        ? incoming
        : {
            present: existing.present + incoming.present,
            evidence: mergeEvidence(existing.evidence, incoming.evidence),
          };
  }

  return {
    objectSamples: left.objectSamples + right.objectSamples,
    incompleteSamples: left.incompleteSamples + right.incompleteSamples,
    properties,
  };
}

function mergeArray(
  left: ArrayEvidence | undefined,
  right: ArrayEvidence | undefined,
): ArrayEvidence | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }

  const items =
    left.items === undefined
      ? right.items
      : right.items === undefined
        ? left.items
        : mergeEvidence(left.items, right.items);

  return {
    arraySamples: left.arraySamples + right.arraySamples,
    nonEmptyArrays: left.nonEmptyArrays + right.nonEmptyArrays,
    itemsObserved: left.itemsObserved + right.itemsObserved,
    incompleteSamples: left.incompleteSamples + right.incompleteSamples,
    ...(items === undefined ? {} : { items }),
  };
}

function addCounts<K extends PrimitiveType | StringFormat>(
  left: Partial<Record<K, number>>,
  right: Partial<Record<K, number>>,
): Partial<Record<K, number>> {
  const result: Partial<Record<K, number>> = { ...left };

  for (const [key, count] of Object.entries(right) as [K, number][]) {
    result[key] = (result[key] ?? 0) + count;
  }

  return result;
}
