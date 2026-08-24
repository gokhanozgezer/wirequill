/**
 * Deterministic JSON serialisation used for fingerprints and example dedupe.
 *
 * Rules (spec section 160):
 * - object keys are sorted
 * - array order is preserved
 * - cyclic values are not expected and throw rather than silently truncating
 */
export function stableStringify(value: unknown): string {
  return serialise(value, new Set());
}

function serialise(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return 'null';
  }

  const type = typeof value;

  if (type === 'number') {
    return Number.isFinite(value as number) ? JSON.stringify(value) : 'null';
  }

  if (type === 'string' || type === 'boolean') {
    return JSON.stringify(value) as string;
  }

  if (type === 'bigint') {
    throw new TypeError('stableStringify does not support bigint values');
  }

  if (type !== 'object') {
    // undefined, function and symbol have no JSON representation.
    return 'null';
  }

  const objectValue = value as object;

  if (seen.has(objectValue)) {
    throw new TypeError('stableStringify does not support cyclic values');
  }
  seen.add(objectValue);

  try {
    if (Array.isArray(objectValue)) {
      const items = objectValue.map((item) => serialise(item, seen));
      return `[${items.join(',')}]`;
    }

    const record = objectValue as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries: string[] = [];

    for (const key of keys) {
      const entry = record[key];
      if (entry === undefined) {
        // Matches JSON.stringify: undefined properties are omitted.
        continue;
      }
      entries.push(`${JSON.stringify(key)}:${serialise(entry, seen)}`);
    }

    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(objectValue);
  }
}
