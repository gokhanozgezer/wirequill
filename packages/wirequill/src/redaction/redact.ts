import {
  isSensitiveFieldName,
  isSensitiveHeaderName,
  normalizeConfiguredNames,
} from './sensitive-names.js';
import { isSensitiveValue } from './value-patterns.js';

export const REDACTED = '[REDACTED]';

/** Replaces a value that sits deeper than the traversal is willing to go. */
export const TOO_DEEP = '[TRUNCATED]';

/**
 * Bounds on traversal (spec sections 45, 46).
 *
 * A hostile payload can nest a thousand levels deep or carry a hundred thousand
 * keys. Redaction runs off the proxy hot path, but it still must not be a way
 * to stall or crash the process.
 */
const MAX_DEPTH = 50;
const MAX_NODES = 50_000;

export interface RedactionRules {
  fields: readonly string[];
  headers: readonly string[];
  query: readonly string[];
}

export interface Redactor {
  value(input: unknown): unknown;
  headers(input: Record<string, string | string[] | undefined>): Record<string, unknown>;
  query(input: URLSearchParams): Record<string, string | string[]>;
}

export function createRedactor(rules: RedactionRules): Redactor {
  const extraFields = normalizeConfiguredNames(rules.fields);
  const extraHeaders = normalizeConfiguredNames(rules.headers);
  const extraQuery = normalizeConfiguredNames(rules.query);

  return {
    value: (input) => redactValue(input, extraFields),
    headers: (input) => redactHeaders(input, extraHeaders),
    query: (input) => redactQuery(input, extraQuery),
  };
}

/**
 * Rebuilds a parsed body with sensitive values replaced.
 *
 * The input is never mutated: the caller still needs the real values in memory
 * for schema inference in a later phase, and mutating shared state under the
 * name "redaction" is exactly the kind of surprise that leaks a secret.
 */
export function redactValue(input: unknown, extraFields: ReadonlySet<string>): unknown {
  const budget = { nodes: 0 };
  return walk(input, extraFields, 0, budget);
}

/** Field-name test bound to one rule set, for the value-shape detectors. */
function nameTest(extra: ReadonlySet<string>): (name: string) => boolean {
  return (name) => isSensitiveFieldName(name, extra);
}

function walk(
  input: unknown,
  extraFields: ReadonlySet<string>,
  depth: number,
  budget: { nodes: number },
): unknown {
  if (depth > MAX_DEPTH) {
    return TOO_DEEP;
  }

  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) {
    return TOO_DEEP;
  }

  if (typeof input === 'string') {
    return isSensitiveValue(input, nameTest(extraFields)) ? REDACTED : input;
  }

  if (input === null || typeof input !== 'object') {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => walk(item, extraFields, depth + 1, budget));
  }

  // A null-prototype target, so a payload carrying `__proto__` or `constructor`
  // writes an ordinary own property instead of touching Object.prototype
  // (spec section 49).
  const output = Object.create(null) as Record<string, unknown>;

  for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
    if (isSensitiveFieldName(key, extraFields)) {
      output[key] = REDACTED;
      continue;
    }

    output[key] = walk(item, extraFields, depth + 1, budget);
  }

  return output;
}

function redactHeaders(
  input: Record<string, string | string[] | undefined>,
  extraHeaders: ReadonlySet<string>,
): Record<string, unknown> {
  const output = Object.create(null) as Record<string, unknown>;

  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }

    if (isSensitiveHeaderName(name, extraHeaders)) {
      // The shape survives so the presence of, say, three Set-Cookie headers is
      // still observable; only the values go.
      output[name] = Array.isArray(value) ? value.map(() => REDACTED) : REDACTED;
      continue;
    }

    const test = nameTest(extraHeaders);

    output[name] = Array.isArray(value)
      ? value.map((entry) => (isSensitiveValue(entry, test) ? REDACTED : entry))
      : isSensitiveValue(value, test)
        ? REDACTED
        : value;
  }

  return output;
}

function redactQuery(
  input: URLSearchParams,
  extraQuery: ReadonlySet<string>,
): Record<string, string | string[]> {
  const output = Object.create(null) as Record<string, string | string[]>;

  for (const key of new Set(input.keys())) {
    const values = input.getAll(key);
    const sensitive = isSensitiveFieldName(key, extraQuery);

    const redacted = values.map((value) =>
      sensitive || isSensitiveValue(value, nameTest(extraQuery)) ? REDACTED : value,
    );

    const single = redacted[0];
    output[key] = redacted.length === 1 && single !== undefined ? single : redacted;
  }

  return output;
}
