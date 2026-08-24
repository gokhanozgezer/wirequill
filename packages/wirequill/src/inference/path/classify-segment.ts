import { looksLikeCredential, looksLikeJwt } from '../../redaction/value-patterns.js';
import { isEmailLike, isIsoDate, isUuid } from '../shared/value-shapes.js';
import { isForcedLiteral } from './static-segments.js';
import type { SanitizedPathSegment } from './types.js';

/**
 * Decides what a single path segment is (spec section 32).
 *
 * Only shapes that are unmistakable at a single sighting are treated as
 * dynamic. A run of digits is an identifier; `my-first-post` might be a slug or
 * might be a route, and one sample cannot tell — see `docs/DECISIONS.md`.
 */

const INTEGER = /^[0-9]+$/;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
/** Crockford base32, canonical upper case: no I, L, O or U. */
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function classifySegment(rawSegment: string): SanitizedPathSegment {
  if (rawSegment === '') {
    return { kind: 'literal', value: '', sensitive: false };
  }

  if (isForcedLiteral(rawSegment)) {
    return { kind: 'literal', value: rawSegment, sensitive: false };
  }

  if (INTEGER.test(rawSegment)) {
    return { kind: 'integer', value: rawSegment, sensitive: false };
  }

  if (isUuid(rawSegment)) {
    return { kind: 'uuid', value: rawSegment, sensitive: false };
  }

  if (OBJECT_ID.test(rawSegment)) {
    return { kind: 'objectId', value: rawSegment, sensitive: false };
  }

  if (ULID.test(rawSegment)) {
    return { kind: 'ulid', value: rawSegment, sensitive: false };
  }

  if (isIsoDate(rawSegment)) {
    return { kind: 'date', value: rawSegment, sensitive: false };
  }

  const decoded = safeDecodeSegment(rawSegment);

  if (isEmailLike(decoded)) {
    // Personal data. The address never leaves this function.
    return { kind: 'email', sensitive: true };
  }

  if (looksLikeJwt(decoded) || looksLikeCredential(decoded)) {
    // A password-reset link or a signed URL puts a live credential in the path.
    return { kind: 'token', sensitive: true };
  }

  return { kind: 'literal', value: rawSegment, sensitive: false };
}

/**
 * Percent-decodes one segment, but only when decoding cannot change what the
 * path means (spec section 12).
 *
 * `%2F` decodes to a slash, which would silently move a segment boundary. A
 * decoded value containing a separator is therefore discarded and the original
 * is classified instead. Malformed encoding is not an error either — the
 * segment is simply used as it arrived.
 */
export function safeDecodeSegment(segment: string): string {
  if (!segment.includes('%')) {
    return segment;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return segment;
  }

  if (decoded.includes('/') || decoded.includes('\\')) {
    return segment;
  }

  return decoded;
}

/**
 * Splits a path into segments for classification.
 *
 * Empty segments from a doubled slash are preserved: `//users` and `/users` are
 * different request targets, and collapsing them here would merge two
 * operations that the backend may well route differently.
 */
export function segmentPath(pathname: string): string[] {
  const trimmed = canonicalizePath(pathname);

  if (trimmed === '/') {
    return [];
  }

  return trimmed.slice(1).split('/');
}

/**
 * Removes a trailing slash for identity purposes only (spec section 13).
 *
 * `/users` and `/users/` document the same operation. The proxy still forwards
 * whichever form the client sent; nothing here rewrites a request.
 */
export function canonicalizePath(pathname: string): string {
  if (pathname === '' || !pathname.startsWith('/')) {
    return `/${pathname}`;
  }

  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

export function classifyPath(pathname: string): SanitizedPathSegment[] {
  return segmentPath(pathname).map((segment) => classifySegment(segment));
}
