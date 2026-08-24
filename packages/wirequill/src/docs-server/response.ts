import type { ServerResponse } from 'node:http';

/**
 * Response helpers for the docs server.
 *
 * Everything the server sends goes through here, for the same reason all
 * terminal writing goes through `Output`: one place to enforce the headers, and
 * one place to be sure a body is JSON rather than HTML with data interpolated
 * into it (spec section 111).
 */

/**
 * Sent on every response (spec section 52).
 *
 * `nosniff` matters more here than it looks: the static bundle is served from
 * the same origin as the API, and a browser that guesses the type of an asset
 * could execute something that was meant to be downloaded. `no-referrer` keeps
 * a local URL — which carries a port a firewall might care about — out of any
 * navigation that leaves the page.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  // Pretty-printed: this is a local developer tool, and `/openapi.json` is
  // something people actually open and read (spec section 31).
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

export function sendNotFound(response: ServerResponse): void {
  // JSON, not the SPA shell: a mistyped API route should read as a mistyped API
  // route, not as a page that silently renders (spec section 41).
  sendJson(response, 404, { error: 'Not found.' });
}

export function sendMethodNotAllowed(response: ServerResponse): void {
  sendJson(response, 405, { error: 'Method not allowed.' });
}

/**
 * A failure the user can see but not act on.
 *
 * No stack, no evidence, no path. The UI shows a reconnect state and the next
 * request usually succeeds; if it does not, the terminal is where the developer
 * looks.
 */
export function sendServerError(response: ServerResponse, message: string): void {
  sendJson(response, 500, { error: message });
}
