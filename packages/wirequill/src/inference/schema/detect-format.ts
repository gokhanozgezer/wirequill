import {
  ipVersion,
  isAbsoluteUri,
  isEmailLike,
  isIsoDate,
  isIsoDateTime,
  isUuid,
} from '../shared/value-shapes.js';
import { FORMAT_ORDER, type StringFormat } from './types.js';

/**
 * Classifies a string into at most one format (spec sections 47, 32).
 *
 * One format per value, chosen in a fixed order, so the answer never depends on
 * which check happened to run first. The value itself is read and discarded —
 * only the resulting label is ever recorded.
 */
export function detectFormat(value: string, maxInspectedLength: number): StringFormat | null {
  // A very long string is typed but not inspected: running six pattern tests
  // over a megabyte of text buys nothing, since the answer is `string` either
  // way for anything that large.
  if (value.length === 0 || value.length > maxInspectedLength) {
    return null;
  }

  for (const format of FORMAT_ORDER) {
    if (matches(format, value)) {
      return format;
    }
  }

  return null;
}

function matches(format: StringFormat, value: string): boolean {
  switch (format) {
    case 'uuid':
      return isUuid(value);
    case 'date-time':
      return isIsoDateTime(value);
    case 'date':
      return isIsoDate(value);
    case 'email':
      return isEmailLike(value);
    case 'ipv4':
      return ipVersion(value) === 4;
    case 'ipv6':
      return ipVersion(value) === 6;
    case 'uri':
      return isAbsoluteUri(value);
  }
}
