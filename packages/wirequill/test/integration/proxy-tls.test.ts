import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DETERMINISTIC_TEXT, sha256, startFixtureBackend } from '../fixtures/backend.js';
import type { FixtureBackend } from '../fixtures/backend.js';
import { rawRequest } from '../helpers/raw-http.js';
import { startProxyOnly, waitFor } from '../helpers/proxy-harness.js';

/**
 * HTTPS upstream, with and without `--insecure`.
 *
 * The certificate under `test/fixtures/certs` is a self-signed fixture for
 * `localhost`. It is test-only material, not a credential: the private key is
 * in the repository precisely because it protects nothing.
 */

let backend: FixtureBackend;

beforeAll(async () => {
  backend = await startFixtureBackend({ tls: true });
});

afterAll(async () => {
  await backend.close();
});

describe('https upstream', () => {
  it('refuses a self-signed certificate by default', async () => {
    const proxy = await startProxyOnly(backend.origin);

    try {
      const response = await rawRequest(`${proxy.proxyOrigin}/hello`);

      expect(response.status).toBe(502);

      await waitFor(() => proxy.failures.length > 0, 5_000, 'a TLS failure event');
      expect(proxy.failures.at(-1)?.code).toMatch(
        /DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_CERT_ALTNAME_INVALID/,
      );
    } finally {
      await proxy.close();
    }
  });

  it('proxies to a self-signed target when --insecure is set', async () => {
    const proxy = await startProxyOnly(backend.origin, { insecure: true });

    try {
      const response = await rawRequest(`${proxy.proxyOrigin}/hello`);

      expect(response.status).toBe(200);
      expect(response.body.toString('utf8')).toBe('hello');
      expect(proxy.failures).toHaveLength(0);
    } finally {
      await proxy.close();
    }
  });

  it('keeps byte integrity across a TLS upstream', async () => {
    const proxy = await startProxyOnly(backend.origin, { insecure: true });

    try {
      const body = Buffer.from('{\n   "over" :  "tls"\n}\n', 'utf8');

      const upload = await rawRequest(`${proxy.proxyOrigin}/raw-hash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const report = JSON.parse(upload.body.toString('utf8')) as { sha256: string };
      expect(report.sha256).toBe(sha256(body));

      const download = await rawRequest(`${proxy.proxyOrigin}/deterministic`);
      expect(sha256(download.body)).toBe(sha256(DETERMINISTIC_TEXT));
    } finally {
      await proxy.close();
    }
  });

  it('does not require the client to speak TLS to the proxy', async () => {
    const proxy = await startProxyOnly(backend.origin, { insecure: true });

    try {
      // The client connects over plain HTTP; only the upstream leg is TLS.
      expect(proxy.proxyOrigin.startsWith('http://')).toBe(true);

      const response = await rawRequest(`${proxy.proxyOrigin}/hello`);
      expect(response.status).toBe(200);
    } finally {
      await proxy.close();
    }
  });
});
