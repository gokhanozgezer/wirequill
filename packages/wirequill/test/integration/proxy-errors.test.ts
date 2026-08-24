import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load-config.js';
import { HttpProxyServer } from '../../src/proxy/proxy-server.js';
import { ProxyEventBus } from '../../src/proxy/proxy-events.js';
import { UPSTREAM_ERROR_BODY } from '../../src/proxy/proxy-errors.js';
import { WireQuillError } from '../../src/utils/errors.js';
import { rawRequest } from '../helpers/raw-http.js';
import { getFreePort, occupyPort } from '../helpers/ports.js';
import { startProxyOnly, waitFor } from '../helpers/proxy-harness.js';

function makeProjectDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wirequill-proxy-err-'));
  mkdirSync(path.join(dir, '.git'));
  return dir;
}

describe('unreachable target', () => {
  it('answers 502 and stays alive', async () => {
    const deadPort = await getFreePort();
    const proxy = await startProxyOnly(`http://127.0.0.1:${String(deadPort)}`);

    try {
      const first = await rawRequest(`${proxy.proxyOrigin}/users`);

      expect(first.status).toBe(502);
      expect(first.body.toString('utf8')).toBe(UPSTREAM_ERROR_BODY);

      // The proxy is still serving: a second request behaves identically
      // rather than hitting a dead process.
      const second = await rawRequest(`${proxy.proxyOrigin}/anything-else`);
      expect(second.status).toBe(502);
    } finally {
      await proxy.close();
    }
  });

  it('reports the failure as metadata only', async () => {
    const deadPort = await getFreePort();
    const proxy = await startProxyOnly(`http://127.0.0.1:${String(deadPort)}`);

    try {
      await rawRequest(`${proxy.proxyOrigin}/users`, {
        method: 'POST',
        headers: { Authorization: 'Bearer must-not-leak', Cookie: 'session=must-not-leak' },
        body: Buffer.from('{"password":"ULTRA_SECRET_123"}', 'utf8'),
      });

      await waitFor(() => proxy.failures.length > 0, 5_000, 'an upstream failure event');

      const failure = proxy.failures.at(-1);
      expect(failure?.method).toBe('POST');
      expect(failure?.path).toBe('/users');
      expect(failure?.code).toBe('ECONNREFUSED');

      expect(JSON.stringify(proxy.failures)).not.toContain('must-not-leak');
      expect(JSON.stringify(proxy.failures)).not.toContain('ULTRA_SECRET_123');
    } finally {
      await proxy.close();
    }
  });

  it('never leaks the request URL, host or a stack trace into the error body', async () => {
    const deadPort = await getFreePort();
    const proxy = await startProxyOnly(`http://127.0.0.1:${String(deadPort)}`);

    try {
      const response = await rawRequest(`${proxy.proxyOrigin}/internal/secret-path`, {
        headers: { Authorization: 'Bearer must-not-leak' },
      });
      const body = response.body.toString('utf8');

      expect(body).toBe(UPSTREAM_ERROR_BODY);
      expect(body).not.toContain('secret-path');
      expect(body).not.toContain('127.0.0.1');
      expect(body).not.toContain('ECONNREFUSED');
      expect(body).not.toContain('must-not-leak');
      expect(body).not.toContain('at ');
      expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    } finally {
      await proxy.close();
    }
  });
});

describe('port conflicts', () => {
  it('refuses to start with an actionable error and no random fallback', async () => {
    const port = await getFreePort();
    const occupied = await occupyPort(port);
    const projectDir = makeProjectDir();

    try {
      const config = loadConfig(
        { target: 'http://localhost:8080', port: String(port) },
        { cwd: projectDir, env: {} },
      );
      const proxy = new HttpProxyServer({ config, events: new ProxyEventBus() });

      await expect(proxy.start()).rejects.toThrowError(WireQuillError);

      await proxy.start().catch((error: unknown) => {
        const wireQuillError = error as WireQuillError;
        expect(wireQuillError.code).toBe('PORT_IN_USE');
        expect(wireQuillError.message).toBe(`Port ${String(port)} is already in use.`);
        expect(wireQuillError.hint).toContain('wirequill --target http://localhost:8080 --port');
      });

      // The port is still held by the other listener: nothing was stolen and no
      // alternative port was silently chosen.
      expect(proxy.address().port).toBe(port);
    } finally {
      await occupied.close();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('leaves the port free after a successful start and stop', async () => {
    const proxy = await startProxyOnly('http://127.0.0.1:1');
    const { proxyPort } = proxy;

    await proxy.close();

    // Binding again proves the listener really let go.
    const reclaimed = await occupyPort(proxyPort);
    await reclaimed.close();
  });
});

describe('shutdown', () => {
  it('stops accepting connections once stopped', async () => {
    const proxy = await startProxyOnly('http://127.0.0.1:1');
    const origin = proxy.proxyOrigin;

    await proxy.close();

    await expect(rawRequest(`${origin}/hello`)).rejects.toMatchObject({
      code: expect.stringMatching(/ECONNREFUSED|ECONNRESET/) as unknown as string,
    });
  });

  it('is safe to stop twice', async () => {
    const proxy = await startProxyOnly('http://127.0.0.1:1');

    await proxy.close();
    await expect(proxy.close()).resolves.toBeUndefined();
  });
});
