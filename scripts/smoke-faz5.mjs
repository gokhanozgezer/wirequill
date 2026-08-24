/**
 * Manual smoke driver for OpenAPI generation.
 *
 * Drives the storefront flow from the phase brief, with real secrets in the
 * login exchange so the generated document can be scanned by hand.
 */
import http from 'node:http';

const proxyPort = Number(process.argv[2] ?? 3000);
const origin = `http://127.0.0.1:${proxyPort}`;

function request(pathname, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const merged = { ...headers };
    let payload;

    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      merged['Content-Type'] = 'application/json';
      merged['Content-Length'] = String(payload.byteLength);
    }

    const req = http.request(`${origin}${pathname}`, { method, headers: merged }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const auth = { Authorization: 'Bearer SMOKE_TOKEN_SECRET' };

await request('/auth/login', {
  method: 'POST',
  body: { email: 'smoke@example.com', password: 'SMOKE_PASSWORD_SECRET' },
});

// Three authenticated calls, so a security requirement can be claimed.
for (let index = 0; index < 3; index += 1) {
  await request('/products', { headers: auth });
}

await request('/products/123', { headers: auth });
await request('/cart/items', {
  method: 'POST',
  body: { productId: 42, quantity: 2 },
  headers: auth,
});
await request('/checkout', {
  method: 'POST',
  body: { total: 99.5, currency: 'EUR' },
  headers: auth,
});

console.log('smoke traffic sent');
