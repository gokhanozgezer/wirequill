/**
 * Minimal backend for manual smoke testing on Windows.
 *
 * Node only, so it runs the same in PowerShell, cmd and any POSIX shell:
 *
 *   node scripts/fixture-backend.mjs 8080
 */
import { createHash } from 'node:crypto';
import http from 'node:http';

const port = Number(process.argv[2] ?? 8080);

const server = http.createServer((req, res) => {
  const hash = createHash('sha256');
  let bytes = 0;

  req.on('data', (chunk) => {
    hash.update(chunk);
    bytes += chunk.byteLength;
  });

  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://placeholder');

    if (url.pathname === '/hello') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('hello');
      return;
    }

    if (url.pathname === '/raw-hash') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sha256: hash.digest('hex'), bytes }));
      return;
    }

    if (url.pathname === '/auth/login') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: 'SMOKE_TOKEN_SECRET',
          user: { id: 42, email: 'smoke@example.com' },
        }),
      );
      return;
    }

    if (url.pathname === '/products') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: 1, name: 'Notebook', price: 12.5 }]));
      return;
    }

    if (url.pathname.startsWith('/products/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 123, name: 'Notebook', price: 12.5, inStock: true }));
      return;
    }

    if (url.pathname === '/cart/items') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ itemId: 7, quantity: 2 }));
      return;
    }

    if (url.pathname === '/checkout') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ orderId: '550e8400-e29b-41d4-a716-446655440000', total: 99.5 }));
      return;
    }

    if (url.pathname === '/schema') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1, name: 'Ada', active: true }));
      return;
    }

    if (url.pathname === '/schema/missing') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', code: 404 }));
      return;
    }

    if (url.pathname === '/cookies') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Set-Cookie': ['a=1; Path=/; HttpOnly', 'b=2; Path=/'],
      });
      res.end('cookies');
      return;
    }

    if (url.pathname === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      let index = 0;
      const timer = setInterval(() => {
        index += 1;
        if (index > 3) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(`chunk-${index}\n`);
      }, 300);
      res.on('close', () => clearInterval(timer));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, path: url.pathname, bytes }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fixture backend listening on http://127.0.0.1:${port}`);
});
