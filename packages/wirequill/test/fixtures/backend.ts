import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import type { AddressInfo, Socket } from 'node:net';

/**
 * The backend WireQuill is pointed at in integration tests.
 *
 * It is deliberately built on bare `node:http`: no framework and, above all, no
 * body parser. Several tests assert on the exact bytes the backend received, so
 * nothing may touch the request stream except the recorder that hashes it.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  bodyBytes: number;
  bodySha256: string;
  /** Milliseconds from the handler starting to the first body chunk arriving. */
  firstChunkAtMs: number;
  /** Milliseconds from the handler starting to the body ending. */
  lastChunkAtMs: number;
}

export interface FixtureBackend {
  origin: string;
  host: string;
  port: number;
  protocol: 'http' | 'https';
  requests: RecordedRequest[];
  lastRequest(): RecordedRequest | undefined;
  reset(): void;
  close(): Promise<void>;
}

export interface FixtureBackendOptions {
  tls?: boolean;
  host?: string;
}

/** Deterministic payload used by the response byte-integrity tests. */
export const DETERMINISTIC_TEXT = Buffer.from(
  '{\n   "hello" :  "world",\n   "numbers": [1,2,3],\n   "unicode": "sağlık ✓ 日本語"\n}\n',
  'utf8',
);

/** Deterministic pseudo-binary payload; stable across runs so hashes are stable. */
export const DETERMINISTIC_BINARY = createDeterministicBytes(1024 * 1024);

const GZIP_PAYLOAD = gzipSync(DETERMINISTIC_TEXT);
const DEFLATE_PAYLOAD = deflateSync(DETERMINISTIC_TEXT);
const BROTLI_PAYLOAD = brotliCompressSync(DETERMINISTIC_TEXT);

/** A readable JSON document, used to prove capture-copy decompression works. */
export const JSON_DOCUMENT = Buffer.from(
  JSON.stringify({ compressed: true, email: 'dev@example.com', items: [1, 2, 3] }),
  'utf8',
);

const GZIP_JSON_PAYLOAD = gzipSync(JSON_DOCUMENT);
const BROTLI_JSON_PAYLOAD = brotliCompressSync(JSON_DOCUMENT);

/**
 * Compresses to a few kilobytes and expands to 8 MiB, well past the default
 * decompressed ceiling. The client still receives the compressed bytes intact.
 */
const GZIP_BOMB_PAYLOAD = gzipSync(
  Buffer.from(`{"filler":"${'a'.repeat(8 * 1024 * 1024)}"}`, 'utf8'),
);

const certificateDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'certs');

export function readTestCertificate(): { key: Buffer; cert: Buffer } {
  return {
    key: readFileSync(path.join(certificateDirectory, 'localhost-key.pem')),
    cert: readFileSync(path.join(certificateDirectory, 'localhost-cert.pem')),
  };
}

export async function startFixtureBackend(
  options: FixtureBackendOptions = {},
): Promise<FixtureBackend> {
  const host = options.host ?? '127.0.0.1';
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    route(req, res, requests);
  };

  const server =
    options.tls === true
      ? https.createServer(readTestCertificate(), handler)
      : http.createServer(handler);

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('secureConnection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  // A minimal upgrade endpoint so the proxy's WebSocket tunnel can be exercised
  // without pulling in a WebSocket library.
  server.on('upgrade', (req, socket: Socket, head: Buffer) => {
    handleUpgrade(req, socket, head);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const protocol = options.tls === true ? 'https' : 'http';

  return {
    origin: `${protocol}://${host}:${String(address.port)}`,
    host,
    port: address.port,
    protocol,
    requests,
    lastRequest: () => requests.at(-1),
    reset: () => {
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
        server.close(() => {
          resolve();
        });
      }),
  };
}

// ---------------------------------------------------------------------- routes

function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requests: RecordedRequest[],
): void {
  const url = new URL(req.url ?? '/', 'http://placeholder');
  const pathname = url.pathname;

  switch (true) {
    case pathname === '/hello':
      withBody(req, requests, () => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('hello');
      });
      return;

    case pathname.startsWith('/users/'):
      withBody(req, requests, () => {
        const id = pathname.slice('/users/'.length);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, query: Object.fromEntries(url.searchParams) }));
      });
      return;

    case pathname === '/echo':
      echoRawBody(req, res, requests);
      return;

    case pathname === '/raw-hash':
    case pathname === '/large':
      hashRawBody(req, res, requests);
      return;

    case pathname === '/no-content':
      withBody(req, requests, () => {
        res.writeHead(204);
        res.end();
      });
      return;

    case pathname === '/head':
      withBody(req, requests, () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': String(DETERMINISTIC_TEXT.byteLength),
          ETag: '"fixture-etag"',
        });
        // Node suppresses the body for HEAD; other methods get the real payload.
        res.end(req.method === 'HEAD' ? undefined : DETERMINISTIC_TEXT);
      });
      return;

    case pathname === '/gzip':
      withBody(req, requests, () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Content-Length': String(GZIP_PAYLOAD.byteLength),
        });
        res.end(GZIP_PAYLOAD);
      });
      return;

    case pathname === '/deflate':
      withBody(req, requests, () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Encoding': 'deflate',
          'Content-Length': String(DEFLATE_PAYLOAD.byteLength),
        });
        res.end(DEFLATE_PAYLOAD);
      });
      return;

    case pathname === '/brotli':
      withBody(req, requests, () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Encoding': 'br',
          'Content-Length': String(BROTLI_PAYLOAD.byteLength),
        });
        res.end(BROTLI_PAYLOAD);
      });
      return;

    case pathname === '/binary':
      withBody(req, requests, () => {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(DETERMINISTIC_BINARY.byteLength),
        });
        res.end(DETERMINISTIC_BINARY);
      });
      return;

    case pathname === '/schema':
      // Echoes back a stable object, so response schema evidence is testable.
      withBody(req, requests, () => {
        const id = url.searchParams.get('id') ?? '1';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: Number(id), name: 'Ada', active: true }));
      });
      return;

    case pathname === '/schema/missing':
      withBody(req, requests, () => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found', code: 404 }));
      });
      return;

    case pathname === '/schema/problem':
      withBody(req, requests, () => {
        res.writeHead(404, { 'Content-Type': 'application/problem+json' });
        res.end(JSON.stringify({ type: 'about:blank', title: 'Not Found' }));
      });
      return;

    case pathname === '/schema/nullable':
      withBody(req, requests, () => {
        const avatar = url.searchParams.get('avatar');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ avatar: avatar === 'null' ? null : avatar }));
      });
      return;

    case pathname === '/schema/bad-gateway':
      // A genuine upstream 502, as opposed to one WireQuill generates.
      withBody(req, requests, () => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream failed' }));
      });
      return;

    case pathname === '/json':
      withBody(req, requests, () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 42, name: 'Ada', active: true, tags: ['a', 'b'] }));
      });
      return;

    case pathname === '/json-secret':
      withBody(req, requests, () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'session=SECRET_COOKIE_RESPONSE; Path=/',
          'X-Auth-Token': 'HEADER_SECRET_RESPONSE',
        });
        res.end(
          JSON.stringify({
            email: 'dev@example.com',
            password: 'RESPONSE_SECRET_PASSWORD',
            access_token: 'RESPONSE_SECRET_TOKEN',
            profile: { id: 7 },
          }),
        );
      });
      return;

    case pathname === '/gzip-json':
      withBody(req, requests, () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Content-Length': String(GZIP_JSON_PAYLOAD.byteLength),
        });
        res.end(GZIP_JSON_PAYLOAD);
      });
      return;

    case pathname === '/br-json':
      withBody(req, requests, () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Encoding': 'br',
          'Content-Length': String(BROTLI_JSON_PAYLOAD.byteLength),
        });
        res.end(BROTLI_JSON_PAYLOAD);
      });
      return;

    case pathname === '/huge-compressed-json':
      withBody(req, requests, () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
          'Content-Length': String(GZIP_BOMB_PAYLOAD.byteLength),
        });
        res.end(GZIP_BOMB_PAYLOAD);
      });
      return;

    case pathname === '/malformed-json':
      withBody(req, requests, () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"broken": ');
      });
      return;

    case pathname === '/deterministic':
      withBody(req, requests, () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': String(DETERMINISTIC_TEXT.byteLength),
        });
        res.end(DETERMINISTIC_TEXT);
      });
      return;

    case pathname === '/chunked':
      withBody(req, requests, () => {
        // No Content-Length, so Node frames the response as chunked.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write(DETERMINISTIC_TEXT.subarray(0, 20));
        res.write(DETERMINISTIC_TEXT.subarray(20));
        res.end();
      });
      return;

    case pathname === '/redirect':
      withBody(req, requests, () => {
        res.writeHead(302, { Location: '/hello' });
        res.end();
      });
      return;

    case pathname === '/redirect-absolute':
      withBody(req, requests, () => {
        res.writeHead(302, { Location: 'http://backend.example.test/elsewhere' });
        res.end();
      });
      return;

    case pathname === '/cookies':
      withBody(req, requests, () => {
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Set-Cookie': [
            'a=1; Path=/; HttpOnly',
            'b=2; Path=/',
            'session=xyz; Path=/; Domain=backend.example.test; SameSite=Lax; Secure',
          ],
          'Cache-Control': 'no-store',
        });
        res.end('cookies');
      });
      return;

    case pathname === '/headers':
      withBody(req, requests, () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Fixture-Casing': 'preserved',
        });
        res.end(JSON.stringify({ headers: req.headers, rawHeaders: req.rawHeaders }));
      });
      return;

    case pathname === '/stream':
      streamChunks(req, res, requests);
      return;

    case pathname === '/events':
      streamEvents(req, res, requests);
      return;

    case pathname.startsWith('/status/'):
      withBody(req, requests, () => {
        const code = Number(pathname.slice('/status/'.length));
        res.writeHead(Number.isInteger(code) ? code : 500, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ status: code }));
      });
      return;

    case pathname === '/method':
      withBody(req, requests, () => {
        res.writeHead(200, { 'Content-Type': 'application/json', Allow: 'GET, POST, OPTIONS' });
        res.end(JSON.stringify({ method: req.method }));
      });
      return;

    default:
      withBody(req, requests, () => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
  }
}

// ------------------------------------------------------------------- recording

/**
 * Consumes the request stream, records exactly what arrived, then runs the
 * handler. Hashing is incremental so a 10 MiB upload never sits in memory.
 */
function withBody(
  req: http.IncomingMessage,
  requests: RecordedRequest[],
  done: (record: RecordedRequest) => void,
): void {
  const hash = createHash('sha256');
  const startedAt = process.hrtime.bigint();
  const since = (): number => Number(process.hrtime.bigint() - startedAt) / 1e6;

  let bytes = 0;
  let firstChunkAtMs = -1;

  req.on('data', (chunk: Buffer) => {
    if (firstChunkAtMs < 0) {
      firstChunkAtMs = since();
    }
    hash.update(chunk);
    bytes += chunk.byteLength;
  });

  req.on('end', () => {
    const record: RecordedRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      rawHeaders: req.rawHeaders,
      bodyBytes: bytes,
      bodySha256: hash.digest('hex'),
      firstChunkAtMs: firstChunkAtMs < 0 ? 0 : firstChunkAtMs,
      lastChunkAtMs: since(),
    };
    requests.push(record);
    done(record);
  });

  req.on('error', () => {
    // The client went away mid-upload; nothing to record.
  });
}

/** Echoes the received bytes back verbatim, for response-integrity assertions. */
function echoRawBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requests: RecordedRequest[],
): void {
  const chunks: Buffer[] = [];
  const hash = createHash('sha256');
  let bytes = 0;

  req.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    hash.update(chunk);
    bytes += chunk.byteLength;
  });

  req.on('end', () => {
    const body = Buffer.concat(chunks);
    requests.push({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      rawHeaders: req.rawHeaders,
      bodyBytes: bytes,
      bodySha256: hash.digest('hex'),
      firstChunkAtMs: 0,
      lastChunkAtMs: 0,
    });

    res.writeHead(200, {
      'Content-Type': req.headers['content-type'] ?? 'application/octet-stream',
      'Content-Length': String(body.byteLength),
    });
    res.end(body);
  });
}

/** Reports the SHA-256 of the raw bytes received, without holding them. */
function hashRawBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requests: RecordedRequest[],
): void {
  withBody(req, requests, (record) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        sha256: record.bodySha256,
        bytes: record.bodyBytes,
        contentType: req.headers['content-type'] ?? null,
        transferEncoding: req.headers['transfer-encoding'] ?? null,
        contentLength: req.headers['content-length'] ?? null,
        firstChunkAtMs: record.firstChunkAtMs,
        lastChunkAtMs: record.lastChunkAtMs,
      }),
    );
  });
}

// ------------------------------------------------------------------- streaming

export const STREAM_CHUNKS = ['chunk-1', 'chunk-2', 'chunk-3'] as const;
export const STREAM_INTERVAL_MS = 80;

function streamChunks(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requests: RecordedRequest[],
): void {
  withBody(req, requests, () => {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    });

    let index = 0;
    const timer = setInterval(() => {
      const chunk = STREAM_CHUNKS[index];
      index += 1;

      if (chunk === undefined) {
        clearInterval(timer);
        res.end();
        return;
      }

      res.write(chunk);
    }, STREAM_INTERVAL_MS);

    res.on('close', () => {
      clearInterval(timer);
    });
  });
}

function streamEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requests: RecordedRequest[],
): void {
  withBody(req, requests, () => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let index = 0;
    const timer = setInterval(() => {
      index += 1;

      if (index > 3) {
        clearInterval(timer);
        res.end();
        return;
      }

      res.write(`event: tick\ndata: {"n":${String(index)}}\n\n`);
    }, STREAM_INTERVAL_MS);

    res.on('close', () => {
      clearInterval(timer);
    });
  });
}

// --------------------------------------------------------------------- upgrade

/**
 * Completes a WebSocket handshake and then echoes raw socket bytes.
 *
 * Real frame parsing is not needed: what the proxy has to get right is the
 * upgrade negotiation and the bidirectional tunnel, and echoing raw bytes tests
 * exactly that without adding a WebSocket dependency.
 */
function handleUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
  const key = req.headers['sec-websocket-key'];

  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }

  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  );

  if (head.byteLength > 0) {
    socket.write(head);
  }

  socket.on('data', (chunk: Buffer) => {
    socket.write(chunk);
  });
  socket.on('error', () => {
    socket.destroy();
  });
}

// ---------------------------------------------------------------------- helpers

/**
 * A stable pseudo-random buffer.
 *
 * `crypto.randomBytes` would change every run, which makes a failing hash test
 * impossible to reproduce; this is seeded and deterministic.
 */
function createDeterministicBytes(size: number): Buffer {
  const out = Buffer.allocUnsafe(size);
  let block = createHash('sha256').update('wirequill-fixture-seed').digest();
  let offset = 0;

  while (offset < size) {
    const take = Math.min(block.byteLength, size - offset);
    block.copy(out, offset, 0, take);
    offset += take;
    block = createHash('sha256').update(block).digest();
  }

  return out;
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Only used where a genuinely unpredictable payload is wanted. */
export function randomPayload(size: number): Buffer {
  return randomBytes(size);
}
