/**
 * Content-Type normalisation and classification (spec sections 22, 23, 28).
 *
 * `Application/JSON; Charset=UTF-8` and `application/json` describe the same
 * payload, so everything downstream sees the normalised lower-case media type
 * with the charset split out.
 */

export interface ParsedContentType {
  mediaType: string;
  charset: string | undefined;
}

export type MediaKind =
  'json' | 'form' | 'multipart' | 'event-stream' | 'text' | 'binary' | 'unknown';

export function parseContentType(raw: string | undefined): ParsedContentType | null {
  if (raw === undefined) {
    return null;
  }

  const [typePart, ...parameters] = raw.split(';');
  const mediaType = (typePart ?? '').trim().toLowerCase();

  if (mediaType === '') {
    return null;
  }

  let charset: string | undefined;

  for (const parameter of parameters) {
    const separator = parameter.indexOf('=');
    if (separator < 0) {
      continue;
    }

    const name = parameter.slice(0, separator).trim().toLowerCase();
    if (name !== 'charset') {
      continue;
    }

    charset = parameter
      .slice(separator + 1)
      .trim()
      .toLowerCase()
      .replace(/^"|"$/g, '');
  }

  return { mediaType, charset };
}

const BINARY_MEDIA_TYPES = new Set([
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/wasm',
]);

const BINARY_PREFIXES = ['image/', 'video/', 'audio/', 'font/'];

export function classifyMediaType(mediaType: string | undefined): MediaKind {
  if (mediaType === undefined || mediaType === '') {
    return 'unknown';
  }

  if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
    return 'json';
  }

  if (mediaType === 'application/x-www-form-urlencoded') {
    return 'form';
  }

  if (mediaType.startsWith('multipart/')) {
    return 'multipart';
  }

  if (mediaType === 'text/event-stream') {
    return 'event-stream';
  }

  if (BINARY_MEDIA_TYPES.has(mediaType)) {
    return 'binary';
  }

  if (BINARY_PREFIXES.some((prefix) => mediaType.startsWith(prefix))) {
    return 'binary';
  }

  if (mediaType.startsWith('text/')) {
    return 'text';
  }

  return 'unknown';
}

/** Only UTF-8 is decoded; anything else is reported rather than guessed at. */
export function isSupportedCharset(charset: string | undefined): boolean {
  if (charset === undefined) {
    return true;
  }
  return charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii' || charset === 'ascii';
}

/**
 * Whether a body of this kind is worth retaining.
 *
 * Only structured payloads WireQuill can actually read are kept. Binary and
 * multipart bodies would be retained without ever being understood, and an
 * event stream has no end, so all of them are counted and discarded.
 */
export function shouldRetainBody(kind: MediaKind): boolean {
  return kind === 'json' || kind === 'form';
}

export const SUPPORTED_CONTENT_ENCODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br']);

/** Normalises `Content-Encoding`, ignoring the no-op `identity`. */
export function parseContentEncoding(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }

  // Multiple encodings are legal but vanishingly rare; only the final one is
  // handled, and anything unexpected is reported as unsupported downstream.
  const encoding = raw.split(',').pop()?.trim().toLowerCase() ?? '';

  if (encoding === '' || encoding === 'identity') {
    return null;
  }

  return encoding;
}
