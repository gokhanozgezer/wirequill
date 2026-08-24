/**
 * Which request headers are worth documenting (spec sections 39, 34).
 *
 * Almost none of them. A browser sends a dozen headers that describe the
 * browser, and a tracing stack adds several more; documenting those as API
 * parameters would bury the two headers that actually matter — a tenant, an
 * API version — under noise nobody wrote.
 */

/** Headers that describe the client, the connection or the payload. */
const NOISE_HEADERS = new Set([
  // connection and routing
  'host',
  'connection',
  'keep-alive',
  'upgrade',
  'via',
  'forwarded',
  'te',
  'trailer',
  'expect',

  // payload description, not parameters
  'content-length',
  'content-type',
  'content-encoding',
  'content-language',
  'content-md5',
  'transfer-encoding',

  // client preferences
  'accept',
  'accept-encoding',
  'accept-language',
  'accept-charset',
  'user-agent',
  'dnt',
  'upgrade-insecure-requests',

  // browsing context
  'origin',
  'referer',
  'referrer-policy',

  // caching and conditionals
  'cache-control',
  'pragma',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'if-range',
  'range',
  'date',
  'etag',

  // distributed tracing
  'traceparent',
  'tracestate',
  'baggage',
  'x-request-id',
  'x-correlation-id',
  'x-trace-id',
  'x-b3-traceid',
  'x-b3-spanid',
  'x-b3-sampled',

  // proxy artefacts
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
]);

/** Whole families of headers the browser adds on its own. */
const NOISE_PREFIXES = ['sec-', 'fetch-', 'cf-', 'cdn-'];

/**
 * Headers that carry credentials.
 *
 * These are real API inputs, but they belong in security evidence rather than
 * in a parameter list, and their values are already redacted.
 */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-session-token',
  'x-amz-security-token',
]);

export function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADERS.has(name.toLowerCase());
}

/** True when a header should become a documented parameter. */
export function isHeaderParameterCandidate(name: string): boolean {
  const lower = name.toLowerCase();

  if (NOISE_HEADERS.has(lower) || CREDENTIAL_HEADERS.has(lower)) {
    return false;
  }

  return !NOISE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Query parameter names that identify an API key by convention. */
const API_KEY_QUERY_NAMES = new Set([
  'api_key',
  'apikey',
  'api-key',
  'access_key',
  'accesskey',
  'key',
  'subscription-key',
]);

export function isApiKeyQueryName(name: string): boolean {
  return API_KEY_QUERY_NAMES.has(name.toLowerCase());
}

/** Header names that identify an API key by convention. */
const API_KEY_HEADERS = new Set([
  'x-api-key',
  'api-key',
  'apikey',
  'x-subscription-key',
  'x-functions-key',
]);

export function isApiKeyHeader(name: string): boolean {
  return API_KEY_HEADERS.has(name.toLowerCase());
}
