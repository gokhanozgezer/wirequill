/**
 * Path segments that must never become parameters (spec sections 33, 15, 16).
 *
 * `/users/me` and `/users/123` are different operations. Collapsing them would
 * merge an endpoint that takes an identifier with one that does not, and no
 * amount of later evidence recovers the distinction.
 */

/** Words that name an action or a singleton, never an identifier. */
const RESERVED_SEGMENTS = new Set([
  // singletons
  'me',
  'current',
  'self',

  // collection-level actions and reports
  'search',
  'query',
  'status',
  'health',
  'healthz',
  'ready',
  'readiness',
  'live',
  'liveness',
  'metrics',
  'count',
  'summary',
  'stats',

  // authentication flows
  'login',
  'logout',
  'signin',
  'signout',
  'signup',
  'register',
  'verify',
  'callback',
  'oauth',
  'token',
  'refresh',
  'password',
  'reset',
  'forgot',

  // operations on a collection
  'export',
  'import',
  'bulk',
  'batch',
  'archive',
  'restore',
  'activate',
  'deactivate',
  'settings',
  'config',
  'configuration',
  'preview',
  'validate',
  'sync',

  // common namespaces
  'api',
  'rest',
  'internal',
  'public',
  'private',
  'graphql',
  'webhook',
  'webhooks',
]);

/** `v1`, `v2`, `v10` — a version, not an identifier. */
const VERSION_SEGMENT = /^v[0-9]+$/i;

export function isReservedSegment(segment: string): boolean {
  return RESERVED_SEGMENTS.has(segment.toLowerCase());
}

export function isVersionSegment(segment: string): boolean {
  return VERSION_SEGMENT.test(segment);
}

/** True when a segment must stay literal whatever else it looks like. */
export function isForcedLiteral(segment: string): boolean {
  return isReservedSegment(segment) || isVersionSegment(segment);
}

/**
 * Reserved for WireQuill's own routes, so a future docs server never appears in
 * the documentation it serves.
 */
export const INTERNAL_PATH_PREFIX = '/__wirequill';

/**
 * File extensions that mark a static asset rather than an API operation.
 *
 * These requests are still proxied; they simply do not become operations.
 */
export const DEFAULT_STATIC_EXTENSIONS: readonly string[] = [
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.map',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.webm',
  '.mp3',
];
