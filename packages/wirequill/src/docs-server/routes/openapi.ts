import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DocsContext } from '../context.js';
import { sendJson, sendServerError } from '../response.js';

/**
 * `GET /openapi.json` (spec sections 30 to 33).
 *
 * Serves exactly what `OpenApiService` produces and nothing else. There is no
 * second serialiser, no export variant and no evidence dump: the document the
 * browser renders, the file the Download button saves and the bytes a script
 * pipes into a linter are all this one thing.
 */

export const OPENAPI_ROUTE = '/openapi.json';

/**
 * A weak validator over the revision (spec section 32).
 *
 * Weak because the byte-for-byte determinism this relies on is a property of
 * the generator rather than of HTTP, and because `Cache-Control: no-store`
 * already tells the browser not to reuse the body — this only saves a
 * regeneration for a client that asks politely.
 */
export function openApiEtag(revision: number): string {
  return `W/"wirequill-${String(revision)}"`;
}

export function handleOpenApi(
  context: DocsContext,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  let document: unknown;
  let etag: string;

  try {
    etag = openApiEtag(context.openApi.getRevision());
    document = context.openApi.getDocument();
  } catch {
    // Generation reads persisted evidence, so this is a corrupt row or a closed
    // database, not a request problem. Report it without a stack: a stack would
    // carry values (spec section 134).
    sendServerError(response, 'Could not generate OpenAPI document.');
    return;
  }

  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' });
    response.end();
    return;
  }

  response.setHeader('ETag', etag);
  sendJson(response, 200, document);
}
