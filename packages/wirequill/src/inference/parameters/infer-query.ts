import { REDACTED } from '../../redaction/redact.js';
import { isIsoDate, isIsoDateTime, isUuid } from '../shared/value-shapes.js';
import type { QueryPrimitiveType, QueryValueFormat } from '../operation/types.js';

/**
 * Query value typing (spec sections 37, 42).
 *
 * Conservative on purpose. `00123` is a postal code, not the number 123, and
 * turning it into an integer would document an API that rejects the value the
 * documentation suggests. Anything that is not unambiguous stays a string.
 */

/** No leading zeros, optional sign: the form JSON would round-trip. */
const CANONICAL_INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
const CANONICAL_DECIMAL = /^-?(?:0|[1-9][0-9]*)\.[0-9]+$/;

export function inferQueryType(value: string): QueryPrimitiveType {
  if (value === 'true' || value === 'false') {
    return 'boolean';
  }

  if (CANONICAL_INTEGER.test(value)) {
    return 'integer';
  }

  if (CANONICAL_DECIMAL.test(value)) {
    return 'number';
  }

  // `1e3`, `NaN` and `Infinity` are numbers to JavaScript and strings to every
  // query-string parser a backend is likely to use.
  return 'string';
}

export function inferQueryFormat(value: string): QueryValueFormat | null {
  if (isUuid(value)) {
    return 'uuid';
  }

  if (isIsoDateTime(value)) {
    return 'dateTime';
  }

  if (isIsoDate(value)) {
    return 'date';
  }

  return null;
}

/** A redacted value carries no shape, so nothing may be concluded from it. */
export function isRedactedValue(value: string): boolean {
  return value === REDACTED;
}
