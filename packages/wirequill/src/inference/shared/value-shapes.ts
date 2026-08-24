import net from 'node:net';

/**
 * Shape tests shared by every inference layer.
 *
 * A UUID in a path segment, a UUID in a query value and a UUID in a JSON body
 * are the same thing, and three copies of the same regex is three chances for
 * them to drift apart.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/**
 * RFC 3339 date-time.
 *
 * `Date.parse` alone accepts far too much — `"2026"` and `"Aug 23 2026"` both
 * parse — so the shape is checked first and the calendar second.
 */
const ISO_DATE_TIME =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$/;

/** Conservative, not RFC 5322: one `@`, a dot in the domain, no whitespace. */
const EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function isEmailLike(value: string): boolean {
  return EMAIL.test(value);
}

/** A real calendar date: `2026-02-31` is a shape, not a date. */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);

  if (match === null) {
    return false;
  }

  const [, year, month, day] = match;
  return isRealDate(Number(year), Number(month), Number(day));
}

export function isIsoDateTime(value: string): boolean {
  const match = ISO_DATE_TIME.exec(value);

  if (match === null) {
    return false;
  }

  const [, year, month, day, hour, minute, second] = match;

  if (!isRealDate(Number(year), Number(month), Number(day))) {
    return false;
  }

  // A leap second is legal in RFC 3339, so 60 is allowed.
  return Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 60;
}

/** An absolute URI. A relative path like `/users/1` is not one. */
export function isAbsoluteUri(value: string): boolean {
  if (!value.includes(':')) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol.length > 1;
  } catch {
    return false;
  }
}

export function ipVersion(value: string): 4 | 6 | null {
  const version = net.isIP(value);
  return version === 4 || version === 6 ? version : null;
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));

  // Rejects 2026-02-31, which Date would otherwise roll forward into March.
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day
  );
}
