/**
 * Paperline — the demo store WireQuill demonstrates itself with.
 *
 *   node examples/demo-store/server.mjs
 *
 * Two servers in one process, and no dependencies at all:
 *
 *   8080  the API WireQuill is pointed at
 *   5173  the storefront, plus a reset endpoint the API never sees
 *
 * Everything is in memory and deterministic, so a recording can be repeated as
 * many times as it takes. Restarting the process is a full reset.
 *
 * Nothing here is WireQuill-aware. The store is an ordinary JSON API, which is
 * the point: what the documentation shows is what WireQuill infers from
 * ordinary traffic, not from anything this file tells it.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');

const API_PORT = Number(process.env.DEMO_API_PORT ?? 8080);
const APP_PORT = Number(process.env.DEMO_APP_PORT ?? 5173);
const HOST = '127.0.0.1';

/** The credentials the demo logs in with. Fake, and obviously so. */
const DEMO_EMAIL = 'demo@example.com';
const DEMO_PASSWORD = 'demo-password';

/**
 * Integer ids on purpose.
 *
 * `/products/1` and `/products/2` are what let WireQuill show
 * `/products/{productId}` — one of the two moments in the demo that explain the
 * whole product.
 */
const PRODUCTS = [
  {
    id: 1,
    name: 'Mechanical Keyboard',
    price: 149,
    currency: 'EUR',
    description: 'Tactile switches, aluminium case, no software required.',
    inStock: true,
  },
  {
    id: 2,
    name: 'Studio Headphones',
    price: 219,
    currency: 'EUR',
    description: 'Closed-back, flat response, replaceable earpads.',
    inStock: true,
  },
  {
    id: 3,
    name: 'Desk Lamp',
    price: 89,
    currency: 'EUR',
    description: 'Warm to cool, stepless dimming, matte finish.',
    inStock: true,
  },
  {
    id: 4,
    name: 'Notebook',
    price: 18,
    currency: 'EUR',
    description: 'Dotted, lies flat, 160 pages.',
    inStock: false,
  },
];

function initialState() {
  return { cart: [], orders: 0, loggedIn: false };
}

let state = initialState();

// ------------------------------------------------------------------- the API

const api = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}`);

  readBody(request, (body) => {
    // The storefront is served from another origin, so the browser preflights
    // anything with a JSON body. WireQuill proxies OPTIONS like any other
    // method and documents none of it.
    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }

    try {
      route(url, request, response, body);
    } catch {
      json(response, 500, { error: 'demo store failed' });
    }
  });
});

function route(url, request, response, body) {
  const { pathname } = url;
  const method = request.method ?? 'GET';

  if (pathname === '/auth/login' && method === 'POST') {
    const credentials = parseJson(body);

    if (credentials?.email !== DEMO_EMAIL || credentials.password !== DEMO_PASSWORD) {
      json(response, 401, { error: 'invalid credentials' });
      return;
    }

    state.loggedIn = true;

    // A token-shaped value and an email address, both of which WireQuill
    // redacts before anything reaches its documentation. That is the demo's
    // privacy moment.
    json(response, 200, {
      access_token: 'demo-token-value',
      user: { id: 42, email: DEMO_EMAIL },
    });
    return;
  }

  if (pathname === '/products' && method === 'GET') {
    json(response, 200, {
      items: PRODUCTS.map(({ id, name, price, currency, inStock }) => ({
        id,
        name,
        price,
        currency,
        inStock,
      })),
      total: PRODUCTS.length,
    });
    return;
  }

  if (pathname.startsWith('/products/') && method === 'GET') {
    const id = Number(pathname.slice('/products/'.length));
    const product = PRODUCTS.find((entry) => entry.id === id);

    if (product === undefined) {
      json(response, 404, { error: 'product not found' });
      return;
    }

    json(response, 200, product);
    return;
  }

  if (pathname === '/cart/items' && method === 'POST') {
    const item = parseJson(body);
    const product = PRODUCTS.find((entry) => entry.id === item?.productId);

    if (product === undefined) {
      json(response, 404, { error: 'product not found' });
      return;
    }

    const quantity = Number.isInteger(item?.quantity) && item.quantity > 0 ? item.quantity : 1;
    state.cart.push({ productId: product.id, name: product.name, quantity, price: product.price });

    json(response, 201, {
      itemCount: state.cart.reduce((sum, entry) => sum + entry.quantity, 0),
      subtotal: cartSubtotal(),
      currency: 'EUR',
    });
    return;
  }

  if (pathname === '/checkout' && method === 'POST') {
    if (state.cart.length === 0) {
      json(response, 409, { error: 'cart is empty' });
      return;
    }

    state.orders += 1;
    const total = cartSubtotal();
    state.cart = [];

    json(response, 201, {
      orderId: 1000 + state.orders,
      status: 'confirmed',
      total,
      currency: 'EUR',
    });
    return;
  }

  json(response, 404, { error: 'not found' });
}

function cartSubtotal() {
  return state.cart.reduce((sum, entry) => sum + entry.price * entry.quantity, 0);
}

// ------------------------------------------------------- the storefront

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const app = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}`);

  // The reset lives here rather than on the API, so it never travels through
  // WireQuill and never turns into a sixth documented endpoint.
  if (url.pathname === '/__demo/reset') {
    state = initialState();
    response.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  void serveStatic(url.pathname, response);
});

async function serveStatic(pathname, response) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = path.resolve(publicDir, relative);

  // Containment, for the same reason WireQuill's own static server has it.
  const inside = path.relative(publicDir, candidate);

  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    response.writeHead(404).end('not found');
    return;
  }

  try {
    const file = await readFile(candidate);
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(candidate).toLowerCase()] ?? 'text/plain',
      'Cache-Control': 'no-store',
    });
    response.end(file);
  } catch {
    response.writeHead(404).end('not found');
  }
}

// ------------------------------------------------------------------- helpers

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
  };
}

function json(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');

  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': payload.byteLength,
    ...corsHeaders(),
  });
  response.end(payload);
}

function parseJson(body) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

function readBody(request, done) {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => done(Buffer.concat(chunks)));
  request.on('error', () => done(Buffer.alloc(0)));
}

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      reject(
        new Error(
          error.code === 'EADDRINUSE'
            ? `The demo ${label} needs port ${String(port)}, and something is already using it.`
            : error.message,
        ),
      );
    });
    server.listen(port, HOST, resolve);
  });
}

// ---------------------------------------------------------------------- main

try {
  await listen(api, API_PORT, 'API');
  await listen(app, APP_PORT, 'storefront');
} catch (error) {
  console.error('');
  console.error(error.message);
  console.error('');
  process.exit(1);
}

console.log('');
console.log('Paperline demo store');
console.log('');
console.log(`  Store    http://${HOST}:${String(APP_PORT)}`);
console.log(`  API      http://${HOST}:${String(API_PORT)}`);
console.log('');
console.log('Now, in another terminal:');
console.log('');
console.log(`  npx wirequill --target http://localhost:${String(API_PORT)}`);
console.log('');
console.log('The store sends its API requests through WireQuill by default.');
console.log('');

const shutdown = () => {
  api.closeAllConnections();
  app.closeAllConnections();
  api.close();
  app.close();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
