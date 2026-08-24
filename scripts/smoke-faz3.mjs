/**
 * Manual smoke driver for endpoint discovery.
 *
 * Sends the traffic from the phase brief, including a real credential in a
 * path, so the terminal output can be read by hand. Node only, so it behaves
 * the same in PowerShell as anywhere else.
 */
import http from 'node:http';

const proxyPort = Number(process.argv[2] ?? 3000);
const origin = `http://127.0.0.1:${proxyPort}`;

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJTTU9LRV9QQVRIX1NFQ1JFVCJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

function request(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${origin}${pathname}`, { method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

const calls = [
  ['/users/123?page=1', {}],
  ['/users/456?page=2', {}],
  ['/users/me', {}],
  [
    '/api/v1/orders/550e8400-e29b-41d4-a716-446655440000',
    { Authorization: 'Bearer SMOKE_HEADER_SECRET' },
  ],
  [`/reset-password/${JWT}`, {}],
  ['/assets/main.a3f9c2e1.js', {}],
];

for (const [pathname, headers] of calls) {
  await request(pathname, headers);
}

console.log('smoke traffic sent');
