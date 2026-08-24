/**
 * Manual smoke driver for the schema evidence engine.
 *
 * Sends the sample sequence from the phase brief — including sensitive fields
 * with distinctive values — so the inferred schema can be read by hand and the
 * database scanned for leaks. Node only, so it behaves the same in PowerShell.
 */
import http from 'node:http';

const proxyPort = Number(process.argv[2] ?? 3000);
const origin = `http://127.0.0.1:${proxyPort}`;

function request(pathname, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let payload;

    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.byteLength);
    }

    const req = http.request(`${origin}${pathname}`, { method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const samples = [
  { id: 1, name: 'Ada', email: 'ada@example.com', cvv: 123 },
  { id: 2, name: 'Grace', email: 'grace@example.com', cvv: 456 },
  { id: 3, email: 'linus@example.com', cvv: 789 },
];

for (const body of samples) {
  await request('/echo', { method: 'POST', body });
}

// Same operation shape, two different response statuses.
await request('/schema');
await request('/schema/missing');

console.log('smoke traffic sent');
