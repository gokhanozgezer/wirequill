import path from 'node:path';

/**
 * Content types for the static bundle (spec section 48).
 *
 * A fixed table rather than a lookup library: the docs UI is built by Vite and
 * ships inside the package, so exactly which extensions can appear is known at
 * build time. Anything unrecognised is served as a byte stream, which a browser
 * will download rather than execute.
 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

export const FALLBACK_MIME_TYPE = 'application/octet-stream';

export function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? FALLBACK_MIME_TYPE;
}
