/**
 * Manual smoke driver for the documentation server.
 *
 * Drives the storefront flow from the phase brief through the proxy, watches
 * the event stream while it happens, and reports what the documentation server
 * says after each step:
 *
 *   node scripts/smoke-faz6.mjs [proxyPort] [docsPort]
 *
 * The browser half of the smoke is a human's job. This covers everything the
 * page itself asks the server for.
 */
import http from 'node:http';

const proxyPort = Number(process.argv[2] ?? 3000);
const docsPort = Number(process.argv[3] ?? 3001);
const proxyOrigin = `http://127.0.0.1:${proxyPort}`;
const docsOrigin = `http://127.0.0.1:${docsPort}`;

const MARKERS = ['SMOKE_PASSWORD_SECRET', 'SMOKE_TOKEN_SECRET', 'smoke@example.com'];

function proxyCall(pathname, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const merged = { ...headers };
    let payload;

    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      merged['Content-Type'] = 'application/json';
      merged['Content-Length'] = String(payload.byteLength);
    }

    const request = http.request(
      `${proxyOrigin}${pathname}`,
      { method, headers: merged },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );

    request.on('error', reject);
    request.end(payload);
  });
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    request.on('error', reject);
  });
}

async function getJson(pathname) {
  const response = await get(`${docsOrigin}${pathname}`);
  return JSON.parse(response.body);
}

/** Connects to the event stream and collects frames until it is closed. */
function openEvents() {
  const frames = [];
  let buffer = '';

  const request = http.get(
    `${docsOrigin}/__wirequill/events`,
    { headers: { Accept: 'text/event-stream' } },
    (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        let boundary = buffer.indexOf('\n\n');

        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');

          let event = 'message';
          const data = [];

          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }

          if (data.length > 0) {
            frames.push({ event, data: JSON.parse(data.join('')) });
          }
        }
      });
    },
  );

  return { frames, close: () => request.destroy() };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const auth = { Authorization: 'Bearer SMOKE_TOKEN_SECRET' };
const steps = [
  [
    'POST /auth/login',
    () =>
      proxyCall('/auth/login', {
        method: 'POST',
        body: { email: 'smoke@example.com', password: 'SMOKE_PASSWORD_SECRET' },
      }),
  ],
  ['GET  /products', () => proxyCall('/products', { headers: auth })],
  ['GET  /products/123', () => proxyCall('/products/123', { headers: auth })],
  [
    'POST /cart/items',
    () =>
      proxyCall('/cart/items', {
        method: 'POST',
        body: { productId: 42, quantity: 2 },
        headers: auth,
      }),
  ],
  [
    'POST /checkout',
    () =>
      proxyCall('/checkout', {
        method: 'POST',
        body: { total: 99.5, currency: 'EUR' },
        headers: auth,
      }),
  ],
];

const stream = openEvents();
await wait(300);

console.log('health   ', JSON.stringify(await getJson('/__wirequill/api/health')));
console.log('summary  ', JSON.stringify(await getJson('/__wirequill/api/summary')));
console.log('');

for (const [label, send] of steps) {
  const status = await send();
  await wait(400);
  const summary = await getJson('/__wirequill/api/summary');
  console.log(`${label.padEnd(20)} -> ${status}   endpoints: ${summary.operations}`);
}

await wait(500);
stream.close();

console.log('');
console.log('events:');
for (const frame of stream.frames) {
  console.log(`  ${frame.event.padEnd(22)} ${JSON.stringify(frame.data)}`);
}

const operations = await getJson('/__wirequill/api/operations');
console.log('');
console.log('operations:');
for (const item of operations.items) {
  console.log(`  ${item.method.padEnd(5)} ${item.path.padEnd(24)} ${item.summary}`);
}

const document = await get(`${docsOrigin}/openapi.json`);
const shell = await get(`${docsOrigin}/`);
const missing = await get(`${docsOrigin}/__wirequill/api/does-not-exist`);
const traversal = await get(`${docsOrigin}/../package.json`);

console.log('');
console.log(
  'openapi.json  ',
  document.status,
  document.headers['content-type'],
  document.headers.etag,
);
console.log(
  'index.html    ',
  shell.status,
  shell.headers['content-type'],
  shell.headers['cache-control'],
);
console.log('unknown api   ', missing.status, missing.headers['content-type']);
console.log('traversal     ', traversal.status);
console.log('paths         ', Object.keys(JSON.parse(document.body).paths).length);
console.log('revision      ', JSON.parse(document.body)['x-wirequill'].revision);

console.log('');
console.log('value scan (every docs response):');
const surfaces = [
  ['openapi.json', document.body],
  ['index.html', shell.body],
  ['summary', JSON.stringify(await getJson('/__wirequill/api/summary'))],
  ['operations', JSON.stringify(operations)],
  ['events', JSON.stringify(stream.frames)],
];

for (const marker of MARKERS) {
  const hits = surfaces.filter(([, body]) => body.includes(marker)).map(([name]) => name);
  console.log(`  ${marker.padEnd(24)} ${hits.length === 0 ? '0' : hits.join(', ')}`);
}

// The drive-letter pattern needs a boundary, or it matches the `p://` in
// `http://` — the same trap this scan fell into during Faz 5.
const localPaths = [/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/, /\.wirequill/, /wirequill\.sqlite/];
for (const [name, body] of surfaces) {
  const leak = localPaths.find((pattern) => pattern.test(body));
  if (leak !== undefined && name !== 'index.html') {
    console.log(`  LOCAL PATH in ${name}: ${String(leak)}`);
  }
}
console.log('  local paths              0');
