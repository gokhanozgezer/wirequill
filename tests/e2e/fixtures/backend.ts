import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny backend for the end-to-end run.
 *
 * In-process, so a test can change what an endpoint returns between two calls
 * and watch the documentation follow. That is the only way to exercise a
 * structural update from the outside without waiting on a second fixture
 * process (spec sections 160 and 161).
 */

export interface FixtureBackend {
  origin: string;
  /** Switches `/items/{itemId}` to the richer response shape. */
  setItemsVariant(variant: 'minimal' | 'extended'): void;
  close(): Promise<void>;
}

export async function startBackend(): Promise<FixtureBackend> {
  let itemsVariant: 'minimal' | 'extended' = 'minimal';

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://placeholder');

    readBody(request, () => {
      route(url, request, response, itemsVariant);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    setItemsVariant: (variant) => {
      itemsVariant = variant;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function route(
  url: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  itemsVariant: 'minimal' | 'extended',
): void {
  const { pathname } = url;

  if (pathname === '/auth/login') {
    // Real-looking credentials in, real-looking credentials out. The end-to-end
    // secret scan is only worth anything if there is something to find.
    json(response, 200, {
      access_token: 'E2E_TOKEN_SECRET',
      user: { id: 42, email: 'e2e@example.com' },
    });
    return;
  }

  if (pathname === '/products') {
    json(response, 200, { items: [{ id: 1, name: 'Quill' }], total: 1 });
    return;
  }

  if (pathname.startsWith('/products/')) {
    json(response, 200, { id: Number(pathname.slice('/products/'.length)), name: 'Quill' });
    return;
  }

  if (pathname === '/checkout') {
    json(response, 201, { orderId: 1001, status: 'created' });
    return;
  }

  if (pathname.startsWith('/items/')) {
    const id = Number(pathname.slice('/items/'.length));

    if (id === 404) {
      json(response, 404, { error: 'not found' });
      return;
    }

    json(response, 200, itemsVariant === 'minimal' ? { id } : { id, name: 'Ada', archived: false });
    return;
  }

  if (pathname === '/comments') {
    // Rendered as text or not at all. Never as markup (spec sections 109, 168).
    json(response, 200, { name: "<img src=x onerror=alert('xss')>" });
    return;
  }

  json(response, 200, { ok: true, path: pathname, method: request.method });
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');

  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': payload.byteLength,
  });
  response.end(payload);
}

function readBody(request: http.IncomingMessage, done: () => void): void {
  request.on('data', () => undefined);
  request.on('end', done);
  request.resume();
}
