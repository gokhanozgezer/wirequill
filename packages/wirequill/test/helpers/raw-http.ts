import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';

/**
 * A deliberately low-level HTTP client for the proxy tests.
 *
 * `fetch`/undici transparently decompresses responses and normalises headers,
 * which would hide exactly the bugs these tests exist to catch. `node:http`
 * sends no `Accept-Encoding` of its own, never decompresses, never follows
 * redirects, and exposes `rawHeaders`, so the bytes asserted on are the bytes
 * that crossed the wire.
 */

export interface RawResponse {
  status: number;
  statusMessage: string;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  body: Buffer;
}

export interface RawRequestOptions {
  method?: string;
  headers?: Record<string, string | string[]>;
  /** Sent verbatim. A Buffer is written as-is with a Content-Length. */
  body?: Buffer;
  /** Written as separate writes with no Content-Length, forcing chunked framing. */
  chunkedBody?: Buffer[];
  insecure?: boolean;
}

export function rawRequest(target: string, options: RawRequestOptions = {}): Promise<RawResponse> {
  const url = new URL(target);
  const transport = url.protocol === 'https:' ? https : http;
  const headers = withContentLength(options);

  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: options.method ?? 'GET',
        headers,
        ...(url.protocol === 'https:' && options.insecure === true
          ? { rejectUnauthorized: false }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            statusMessage: response.statusMessage ?? '',
            headers: response.headers,
            rawHeaders: response.rawHeaders,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', reject);
      },
    );

    request.on('error', reject);

    if (options.chunkedBody !== undefined) {
      for (const chunk of options.chunkedBody) {
        request.write(chunk);
      }
      request.end();
      return;
    }

    request.end(options.body);
  });
}

/**
 * Adds an explicit `Content-Length` for bodies on methods where Node would
 * otherwise send no framing at all.
 *
 * Node only enables chunked-by-default for PUT, POST and PATCH. Handing a body
 * to `end()` on a DELETE therefore writes the bytes with neither a length nor
 * chunked framing, and the receiving server reads them as the start of a second
 * request. Real clients always set the header; the test client must too, so
 * that a DELETE-with-body test measures the proxy rather than this helper.
 */
function withContentLength(options: RawRequestOptions): Record<string, string | string[]> {
  const headers = { ...(options.headers ?? {}) };

  if (options.body === undefined || options.chunkedBody !== undefined) {
    return headers;
  }

  const alreadySet = Object.keys(headers).some((key) => key.toLowerCase() === 'content-length');

  if (!alreadySet) {
    headers['Content-Length'] = String(options.body.byteLength);
  }

  return headers;
}

export interface StreamedChunk {
  /** Milliseconds since the request was sent. */
  atMs: number;
  data: Buffer;
}

export interface StreamedResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  chunks: StreamedChunk[];
  /** Milliseconds since the request was sent, when the response ended. */
  endedAtMs: number;
}

/**
 * Records when each response chunk arrives, so a test can prove that the first
 * chunk reached the client before the upstream response finished.
 */
export function streamingRequest(
  target: string,
  options: RawRequestOptions & { stopAfterChunks?: number } = {},
): Promise<StreamedResponse> {
  const url = new URL(target);
  const transport = url.protocol === 'https:' ? https : http;
  const startedAt = process.hrtime.bigint();
  const since = (): number => Number(process.hrtime.bigint() - startedAt) / 1e6;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        ...(url.protocol === 'https:' && options.insecure === true
          ? { rejectUnauthorized: false }
          : {}),
      },
      (response) => {
        const chunks: StreamedChunk[] = [];

        const finish = (): void => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            chunks,
            endedAtMs: since(),
          });
        };

        response.on('data', (data: Buffer) => {
          chunks.push({ atMs: since(), data });

          if (options.stopAfterChunks !== undefined && chunks.length >= options.stopAfterChunks) {
            response.destroy();
            finish();
          }
        });

        response.on('end', finish);
        response.on('error', (error: NodeJS.ErrnoException) => {
          // A deliberate early destroy surfaces here; it is not a failure.
          if (chunks.length > 0) {
            finish();
            return;
          }
          reject(error);
        });
      },
    );

    request.on('error', reject);
    request.end(options.body);
  });
}

export interface UpgradeResult {
  statusLine: string;
  headers: string[];
  socket: Socket;
}

/** Performs an HTTP Upgrade handshake and hands back the raw tunnel socket. */
export function upgradeRequest(
  target: string,
  headers: Record<string, string>,
): Promise<UpgradeResult> {
  const url = new URL(target);

  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'GET', headers });

    request.on('upgrade', (response, socket: Socket) => {
      resolve({
        statusLine: `HTTP/${response.httpVersion} ${String(response.statusCode)}`,
        headers: response.rawHeaders,
        socket,
      });
    });

    request.on('response', (response) => {
      reject(new Error(`upgrade refused with status ${String(response.statusCode)}`));
    });

    request.on('error', reject);
    request.end();
  });
}
