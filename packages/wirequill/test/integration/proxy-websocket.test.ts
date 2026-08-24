import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upgradeRequest } from '../helpers/raw-http.js';
import { startProxyHarness, type ProxyHarness } from '../helpers/proxy-harness.js';

/**
 * Best-effort WebSocket pass-through.
 *
 * What the proxy actually has to get right is the Upgrade negotiation and the
 * bidirectional tunnel that follows, so the fixture completes a real handshake
 * and then echoes raw socket bytes. That exercises the proxy faithfully without
 * adding a WebSocket library, and frame encoding is the client's concern rather
 * than the proxy's.
 */

let harness: ProxyHarness;

beforeAll(async () => {
  harness = await startProxyHarness();
});

afterAll(async () => {
  await harness.close();
});

function handshakeHeaders(): Record<string, string> {
  return {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
  };
}

function readOnce(socket: NodeJS.ReadableStream, timeoutMs = 5_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for tunnel data'));
    }, timeoutMs);

    socket.once('data', (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(chunk);
    });
  });
}

describe('websocket upgrade', () => {
  it('completes the handshake through the proxy', async () => {
    const upgraded = await upgradeRequest(`${harness.proxyOrigin}/socket`, handshakeHeaders());

    try {
      expect(upgraded.statusLine).toContain('101');

      const headerNames = upgraded.headers
        .filter((_, index) => index % 2 === 0)
        .map((name) => name.toLowerCase());

      expect(headerNames).toContain('upgrade');
      expect(headerNames).toContain('sec-websocket-accept');
    } finally {
      upgraded.socket.destroy();
    }
  });

  it('tunnels bytes in both directions', async () => {
    const upgraded = await upgradeRequest(`${harness.proxyOrigin}/socket`, handshakeHeaders());

    try {
      const payload = Buffer.from('wirequill-tunnel-probe', 'utf8');
      upgraded.socket.write(payload);

      const echoed = await readOnce(upgraded.socket);
      expect(echoed.toString('utf8')).toBe(payload.toString('utf8'));
    } finally {
      upgraded.socket.destroy();
    }
  });

  it('shuts down promptly while a tunnel is still open', async () => {
    // A regression guard: Node stops accounting for an upgraded socket, so
    // `server.close()` used to hang until the grace timer fired, which made
    // Ctrl+C feel broken whenever a WebSocket was connected.
    const scoped = await startProxyHarness({ shutdownGraceMs: 10_000 });
    const upgraded = await upgradeRequest(`${scoped.proxyOrigin}/socket`, handshakeHeaders());

    upgraded.socket.write(Buffer.from('still connected', 'utf8'));
    await readOnce(upgraded.socket);

    const startedAt = Date.now();
    await scoped.close();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);
    upgraded.socket.destroy();
  });

  it('keeps proxying HTTP after a tunnel closes', async () => {
    const upgraded = await upgradeRequest(`${harness.proxyOrigin}/socket`, handshakeHeaders());
    upgraded.socket.destroy();

    const { rawRequest } = await import('../helpers/raw-http.js');
    const response = await rawRequest(`${harness.proxyOrigin}/hello`);

    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('hello');
  });
});
