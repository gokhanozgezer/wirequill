/**
 * Manual smoke driver for the capture phase.
 *
 * Sends the traffic a developer would send on a first run — including secrets —
 * so the terminal output and the database can be inspected by hand. Node only,
 * so it behaves the same in PowerShell as anywhere else.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import { gzipSync } from 'node:zlib';

const proxyPort = Number(process.argv[2] ?? 3000);
const origin = `http://127.0.0.1:${proxyPort}`;

function request(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const merged = { ...headers };
    if (body !== undefined) {
      merged['Content-Length'] = String(body.byteLength);
    }

    const req = http.request(`${origin}${pathname}`, { method, headers: merged }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

const secretBody = Buffer.from(
  JSON.stringify({
    email: 'dev@example.com',
    password: 'SMOKE_SECRET_PASSWORD',
    access_token: 'SMOKE_SECRET_TOKEN',
    keep: 'visible',
  }),
);

console.log('1. plain JSON POST');
console.log(
  '  ',
  (
    await request('/raw-hash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from('{"hello":"world"}'),
    })
  ).status,
);

console.log('2. secret JSON POST with Authorization, Cookie and a query secret');
const secretResponse = await request('/raw-hash?token=SMOKE_SECRET_QUERY', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer SMOKE_SECRET_HEADER',
    Cookie: 'session=SMOKE_SECRET_COOKIE',
  },
  body: secretBody,
});
const reported = JSON.parse(secretResponse.body.toString());
const expected = createHash('sha256').update(secretBody).digest('hex');
console.log('   backend hash matches client:', reported.sha256 === expected);

console.log('3. 10 MiB POST');
const big = Buffer.alloc(10 * 1024 * 1024, 0x41);
const bigResponse = await request('/raw-hash', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: big,
});
const bigReport = JSON.parse(bigResponse.body.toString());
console.log('   backend received all bytes:', bigReport.bytes === big.byteLength);
console.log(
  '   backend hash matches client:',
  bigReport.sha256 === createHash('sha256').update(big).digest('hex'),
);

console.log('4. gzip JSON POST');
const gz = gzipSync(Buffer.from('{"compressed":true,"password":"SMOKE_SECRET_GZIP"}'));
console.log(
  '  ',
  (
    await request('/raw-hash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: gz,
    })
  ).status,
);

console.log('5. streaming GET');
const streamed = await request('/stream');
console.log('   chunks:', streamed.body.toString().trim().split('\n').length);

console.log('6. binary POST');
console.log(
  '  ',
  (
    await request('/raw-hash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(64 * 1024, 7),
    })
  ).status,
);

console.log('done');
