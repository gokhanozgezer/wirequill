import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DETERMINISTIC_TEXT, sha256 } from '../fixtures/backend.js';
import { rawRequest } from '../helpers/raw-http.js';
import { startProxyHarness, waitFor, type ProxyHarness } from '../helpers/proxy-harness.js';

/**
 * The behaviour a client must not be able to tell apart with WireQuill in the
 * middle: methods, query strings, headers, cookies, redirects and status codes.
 */

let harness: ProxyHarness;

beforeAll(async () => {
  harness = await startProxyHarness();
});

afterAll(async () => {
  await harness.close();
});

interface MethodReport {
  method: string;
}

describe('methods', () => {
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('forwards %s', async (method) => {
    const response = await rawRequest(`${harness.proxyOrigin}/method`, { method });

    expect(response.status).toBe(200);
    const report = JSON.parse(response.body.toString('utf8')) as MethodReport;
    expect(report.method).toBe(method);
  });

  it('forwards HEAD without a body but with the headers intact', async () => {
    const direct = await rawRequest(`${harness.backend.origin}/head`, { method: 'HEAD' });
    const viaProxy = await rawRequest(`${harness.proxyOrigin}/head`, { method: 'HEAD' });

    expect(viaProxy.status).toBe(200);
    expect(viaProxy.body.byteLength).toBe(0);
    expect(direct.body.byteLength).toBe(0);

    expect(viaProxy.headers['content-type']).toBe('application/json');
    expect(viaProxy.headers['content-length']).toBe(String(DETERMINISTIC_TEXT.byteLength));
    expect(viaProxy.headers.etag).toBe('"fixture-etag"');
  });

  it('forwards 204 with no body', async () => {
    const response = await rawRequest(`${harness.proxyOrigin}/no-content`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(response.body.byteLength).toBe(0);
  });
});

describe('query strings', () => {
  it('forwards the query string verbatim, order included', async () => {
    const response = await rawRequest(`${harness.proxyOrigin}/users/123?page=2&tag=a&tag=b&z=1`);

    expect(response.status).toBe(200);
    expect(harness.backend.lastRequest()?.url).toBe('/users/123?page=2&tag=a&tag=b&z=1');
  });

  it('preserves percent-encoding rather than normalising it', async () => {
    const response = await rawRequest(`${harness.proxyOrigin}/users/1?q=a%20b%2Fc&plus=a+b`);

    expect(response.status).toBe(200);
    expect(harness.backend.lastRequest()?.url).toBe('/users/1?q=a%20b%2Fc&plus=a+b');
  });

  it('preserves an empty query value and a bare key', async () => {
    await rawRequest(`${harness.proxyOrigin}/users/1?empty=&bare`);

    expect(harness.backend.lastRequest()?.url).toBe('/users/1?empty=&bare');
  });
});

interface HeaderReport {
  headers: Record<string, string | string[]>;
}

async function headersSeenByBackend(
  headers: Record<string, string>,
): Promise<Record<string, string | string[]>> {
  const response = await rawRequest(`${harness.proxyOrigin}/headers`, { headers });
  expect(response.status).toBe(200);
  return (JSON.parse(response.body.toString('utf8')) as HeaderReport).headers;
}

describe('request headers', () => {
  it('forwards the headers an API client actually sends', async () => {
    const seen = await headersSeenByBackend({
      Authorization: 'Bearer test-token-value',
      Accept: 'application/json',
      'X-Custom-Header': 'custom-value',
      Cookie: 'session=abc; theme=dark',
      Origin: 'http://localhost:5173',
      'User-Agent': 'wirequill-test/1.0',
    });

    expect(seen.authorization).toBe('Bearer test-token-value');
    expect(seen.accept).toBe('application/json');
    expect(seen['x-custom-header']).toBe('custom-value');
    expect(seen.cookie).toBe('session=abc; theme=dark');
    expect(seen.origin).toBe('http://localhost:5173');
    expect(seen['user-agent']).toBe('wirequill-test/1.0');
  });

  it('rewrites Host to the target, and nothing else about the origin', async () => {
    const seen = await headersSeenByBackend({ Accept: 'application/json' });

    // `changeOrigin: true`: the backend sees its own address, exactly as it
    // would if the client had connected to it directly.
    expect(seen.host).toBe(`${harness.backend.host}:${String(harness.backend.port)}`);
  });

  it('does not add forwarding headers the client never sent', async () => {
    const seen = await headersSeenByBackend({ Accept: 'application/json' });

    expect(seen['x-forwarded-for']).toBeUndefined();
    expect(seen['x-forwarded-host']).toBeUndefined();
    expect(seen['x-forwarded-proto']).toBeUndefined();
  });

  it('forwards repeated headers without collapsing them', async () => {
    const response = await rawRequest(`${harness.proxyOrigin}/headers`, {
      headers: { 'X-Repeated': ['one', 'two'] },
    });
    const seen = (JSON.parse(response.body.toString('utf8')) as HeaderReport).headers;

    expect(seen['x-repeated']).toBe('one, two');
  });
});

describe('response headers', () => {
  it('preserves every Set-Cookie separately', async () => {
    const direct = await rawRequest(`${harness.backend.origin}/cookies`);
    const viaProxy = await rawRequest(`${harness.proxyOrigin}/cookies`);

    expect(direct.headers['set-cookie']).toHaveLength(3);
    expect(viaProxy.headers['set-cookie']).toHaveLength(3);
    expect(viaProxy.headers['set-cookie']).toEqual(direct.headers['set-cookie']);
  });

  it('does not rewrite cookie domain, path, SameSite or Secure', async () => {
    const viaProxy = await rawRequest(`${harness.proxyOrigin}/cookies`);
    const cookies = viaProxy.headers['set-cookie'] ?? [];

    expect(cookies).toContain('a=1; Path=/; HttpOnly');
    expect(cookies).toContain(
      'session=xyz; Path=/; Domain=backend.example.test; SameSite=Lax; Secure',
    );
  });

  it('preserves other response headers', async () => {
    const viaProxy = await rawRequest(`${harness.proxyOrigin}/cookies`);

    expect(viaProxy.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(viaProxy.headers['cache-control']).toBe('no-store');
  });

  it('preserves response header key casing', async () => {
    const direct = await rawRequest(`${harness.backend.origin}/headers`);
    const viaProxy = await rawRequest(`${harness.proxyOrigin}/headers`);

    expect(direct.rawHeaders).toContain('X-Fixture-Casing');
    expect(viaProxy.rawHeaders).toContain('X-Fixture-Casing');
  });

  it('preserves Content-Length on a fixed-size response', async () => {
    const viaProxy = await rawRequest(`${harness.proxyOrigin}/deterministic`);

    expect(viaProxy.headers['content-length']).toBe(String(DETERMINISTIC_TEXT.byteLength));
    expect(sha256(viaProxy.body)).toBe(sha256(DETERMINISTIC_TEXT));
  });
});

describe('redirects', () => {
  it('passes a relative redirect through without following it', async () => {
    const response = await rawRequest(`${harness.proxyOrigin}/redirect`);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/hello');
    expect(response.body.byteLength).toBe(0);
  });

  it('does not rewrite an absolute Location header', async () => {
    const response = await rawRequest(`${harness.proxyOrigin}/redirect-absolute`);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('http://backend.example.test/elsewhere');
  });
});

describe('status codes', () => {
  it.each([400, 401, 404, 422, 500, 503])('forwards %i unchanged', async (status) => {
    const response = await rawRequest(`${harness.proxyOrigin}/status/${String(status)}`);

    expect(response.status).toBe(status);
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({ status });
  });
});

describe('traffic metadata', () => {
  it('reports method, path and status without any payload', async () => {
    harness.completed.length = 0;

    await rawRequest(`${harness.proxyOrigin}/users/7?secret=shhh`, {
      headers: { Authorization: 'Bearer must-not-be-recorded' },
    });

    await waitFor(() => harness.completed.length > 0, 5_000, 'a traffic event');

    const event = harness.completed.at(-1);
    expect(event?.method).toBe('GET');
    expect(event?.statusCode).toBe(200);
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);

    // The query string is stripped before the event is emitted. A password
    // reset link or a signed URL carries a live secret in the request target,
    // and this value is printed to the terminal.
    expect(event?.path).toBe('/users/7');
    expect(event?.path).not.toContain('secret');
    expect(event?.path).not.toContain('?');

    // The event carries no header or body material at all.
    expect(JSON.stringify(event)).not.toContain('must-not-be-recorded');
    expect(Object.keys(event ?? {}).sort()).toEqual(['durationMs', 'method', 'path', 'statusCode']);
  });
});
