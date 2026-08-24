import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest, streamingRequest } from '../helpers/raw-http.js';
import { getFreePort } from '../helpers/ports.js';
import {
  startProxyHarness,
  startProxyOnly,
  waitFor,
  type ProxyHarness,
} from '../helpers/proxy-harness.js';

/**
 * Release blockers RB4, RB5 and RB9, seen from the capture side.
 *
 * Capture must stay bounded, must release what it reserves, and must never be
 * the reason a request behaves differently.
 */

let harness: ProxyHarness;

afterEach(async () => {
  await harness.close();
});

describe('bounded capture', () => {
  it('keeps only the configured slice of a large body (RB4)', async () => {
    harness = await startProxyHarness({ captureLimits: { maxBodyBytes: 1024 } });

    const body = Buffer.alloc(10 * 1024 * 1024, 0x41);

    const response = await rawRequest(`${harness.proxyOrigin}/large`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const report = JSON.parse(response.body.toString('utf8')) as { bytes: number };

    await harness.waitForObservations(1);
    const observed = harness.observations.at(-1)?.request.body;

    // The backend received all of it; WireQuill kept a kilobyte.
    expect(report.bytes).toBe(body.byteLength);
    expect(observed?.totalBytes).toBe(body.byteLength);
    expect(observed?.capturedBytes).toBe(1024);
    expect(observed?.truncated).toBe(true);
    expect(observed?.parseStatus).toBe('truncated');
  });

  it('honours --max-body', async () => {
    harness = await startProxyHarness({ captureLimits: { maxBodyBytes: 512 } });

    await rawRequest(`${harness.proxyOrigin}/large`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.alloc(4096, 0x42),
    });

    await harness.waitForObservations(1);

    expect(harness.observations.at(-1)?.request.body.capturedBytes).toBe(512);
  });

  it('releases the whole budget once processing is done (RB5)', async () => {
    harness = await startProxyHarness();

    for (let index = 0; index < 5; index += 1) {
      await rawRequest(`${harness.proxyOrigin}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ index, filler: 'x'.repeat(4096) })),
      });
    }

    await harness.waitForObservations(5);
    await waitFor(
      () => (harness.pipeline?.stats.reservedBytes ?? -1) === 0,
      5_000,
      'the capture budget to return to zero',
    );

    expect(harness.pipeline?.stats.reservedBytes).toBe(0);
    expect(harness.pipeline?.stats.pending).toBe(0);
  });

  it('stops capturing when the shared budget runs out but keeps proxying', async () => {
    harness = await startProxyHarness({
      captureLimits: { globalCaptureBudgetBytes: 2048, maxBodyBytes: 1024 * 1024 },
    });

    const payload = Buffer.from(JSON.stringify({ filler: 'y'.repeat(4096) }));

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        rawRequest(`${harness.proxyOrigin}/echo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        }),
      ),
    );

    // Every request still succeeded and still round-tripped its body.
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body.byteLength).toBe(payload.byteLength);
    }

    await harness.waitForObservations(8);
    await waitFor(
      () => (harness.pipeline?.stats.reservedBytes ?? -1) === 0,
      5_000,
      'the capture budget to return to zero',
    );

    const exceeded = harness.observations.filter((o) => o.request.body.budgetExceeded);
    expect(exceeded.length).toBeGreaterThan(0);
    expect(harness.pipeline?.stats.reservedBytes).toBe(0);
  });

  it('counts a binary body without keeping it', async () => {
    harness = await startProxyHarness();

    const payload = Buffer.alloc(64 * 1024, 0x7f);

    await rawRequest(`${harness.proxyOrigin}/large`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: payload,
    });

    await harness.waitForObservations(1);
    const observed = harness.observations.at(-1)?.request.body;

    expect(observed?.totalBytes).toBe(payload.byteLength);
    expect(observed?.capturedBytes).toBe(0);
    expect(observed?.parseStatus).toBe('unsupported_binary');
  });

  it('counts a multipart body without parsing it', async () => {
    harness = await startProxyHarness();

    const body = Buffer.from(
      '--abc\r\nContent-Disposition: form-data; name="f"\r\n\r\nvalue\r\n--abc--\r\n',
    );

    await rawRequest(`${harness.proxyOrigin}/large`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=abc' },
      body,
    });

    await harness.waitForObservations(1);
    const observed = harness.observations.at(-1)?.request.body;

    expect(observed?.totalBytes).toBe(body.byteLength);
    expect(observed?.capturedBytes).toBe(0);
    expect(observed?.parseStatus).toBe('unsupported_multipart');
  });

  it('does not buffer a server-sent event stream', async () => {
    harness = await startProxyHarness();

    const response = await streamingRequest(`${harness.proxyOrigin}/events`);

    expect(response.status).toBe(200);

    await harness.waitForObservations(1);
    const observed = harness.observations.at(-1)?.response.body;

    expect(observed?.capturedBytes).toBe(0);
    expect(observed?.totalBytes).toBeGreaterThan(0);
    expect(observed?.parseStatus).toBe('unsupported_event_stream');
  });
});

describe('parsing observed payloads', () => {
  it('understands a JSON request and response', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from('{  "hello" :  "world"  }'),
    });

    await harness.waitForObservations(1);
    const observation = harness.observations.at(-1);

    expect(observation?.request.body.parseStatus).toBe('json');
    expect(observation?.request.body.redacted).toEqual({ hello: 'world' });
    expect(observation?.response.body.parseStatus).toBe('json');
    expect(observation?.response.body.redacted).toEqual({
      id: 42,
      name: 'Ada',
      active: true,
      tags: ['a', 'b'],
    });
  });

  it('understands a urlencoded form', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/large`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: Buffer.from('tag=a&tag=b&password=hunter2&page=2'),
    });

    await harness.waitForObservations(1);
    const redacted = harness.observations.at(-1)?.request.body.redacted as Record<string, unknown>;

    expect(redacted.tag).toEqual(['a', 'b']);
    expect(redacted.page).toBe('2');
    expect(redacted.password).toBe('[REDACTED]');
  });

  it.each([
    ['gzip', '/gzip-json'],
    ['br', '/br-json'],
  ])(
    'decodes a %s capture copy without disturbing the forwarded bytes (RB9)',
    async (encoding, route) => {
      harness = await startProxyHarness();

      const direct = await rawRequest(`${harness.backend.origin}${route}`);
      const viaProxy = await rawRequest(`${harness.proxyOrigin}${route}`);

      // The client still gets the compressed bytes, byte for byte.
      expect(viaProxy.headers['content-encoding']).toBe(encoding);
      expect(viaProxy.body.equals(direct.body)).toBe(true);

      await harness.waitForObservations(1);
      const observation = harness.observations.at(-1);

      // And WireQuill still read the structure out of its own copy.
      expect(observation?.response.body.parseStatus).toBe('json');
      expect(observation?.response.body.redacted).toEqual({
        compressed: true,
        email: '[REDACTED]',
        items: [1, 2, 3],
      });
    },
  );

  it('refuses a decompression bomb without touching the forwarded response', async () => {
    harness = await startProxyHarness({
      captureLimits: { maxDecompressedBodyBytes: 64 * 1024 },
    });

    const direct = await rawRequest(`${harness.backend.origin}/huge-compressed-json`);
    const viaProxy = await rawRequest(`${harness.proxyOrigin}/huge-compressed-json`);

    expect(viaProxy.body.equals(direct.body)).toBe(true);

    await harness.waitForObservations(1);

    expect(harness.observations.at(-1)?.response.body.parseStatus).toBe('decompressed_too_large');
  });

  it('reports malformed JSON without quoting it', async () => {
    harness = await startProxyHarness();

    const response = await rawRequest(`${harness.proxyOrigin}/malformed-json`);

    // The client receives exactly what the backend sent, broken or not.
    expect(response.body.toString('utf8')).toBe('{"broken": ');

    await harness.waitForObservations(1);
    const observation = harness.observations.at(-1);

    expect(observation?.response.body.parseStatus).toBe('invalid_json');
    expect(JSON.stringify(observation)).not.toContain('broken');
  });
});

describe('observation metadata persistence', () => {
  it('writes a row per request, linked to its operation', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from('{"a":1}'),
    });

    await harness.waitForObservations(1);
    harness.storage?.close();

    const db = new DatabaseSync(harness.databasePath);
    const rows = db.prepare('SELECT * FROM observations').all() as Record<string, unknown>[];
    db.close();

    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row?.method).toBe('POST');
    expect(row?.status_code).toBe(200);
    // Faz 3 resolves the operation before the observation is written.
    expect(row?.operation_id).toEqual(expect.any(String));
    expect(row?.request_content_type).toBe('application/json');
    expect(row?.response_content_type).toBe('application/json');
    expect(row?.request_bytes).toBe(7);
    expect(row?.response_bytes).toBeGreaterThan(0);
    expect(row?.request_truncated).toBe(0);
    expect(row?.request_parse_status).toBe('json');
    expect(row?.response_parse_status).toBe('json');
    expect(row?.upstream_error_code).toBeNull();
    expect(typeof row?.duration_ms).toBe('number');
  });

  it('records a truncation flag', async () => {
    harness = await startProxyHarness({ captureLimits: { maxBodyBytes: 16 } });

    await rawRequest(`${harness.proxyOrigin}/large`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.alloc(4096, 0x43),
    });

    await harness.waitForObservations(1);
    harness.storage?.close();

    const db = new DatabaseSync(harness.databasePath);
    const row = db.prepare('SELECT * FROM observations').get() as Record<string, unknown>;
    db.close();

    expect(row.request_truncated).toBe(1);
    expect(row.request_parse_status).toBe('truncated');
  });
});

describe('upstream failure observation', () => {
  it('records the syscall code and stays distinguishable from a real 502', async () => {
    const deadPort = await getFreePort();
    const proxy = await startProxyOnly(`http://127.0.0.1:${String(deadPort)}`);

    try {
      const response = await rawRequest(`${proxy.proxyOrigin}/users`);
      expect(response.status).toBe(502);

      await waitFor(() => proxy.observations.length > 0, 5_000, 'an observation');
      const observation = proxy.observations.at(-1);

      // A generated 502 carries an error code; a backend's own 502 would not.
      expect(observation?.response.statusCode).toBe(502);
      expect(observation?.upstreamErrorCode).toBe('ECONNREFUSED');
      expect(observation?.response.body.parseStatus).toBe('none');
    } finally {
      await proxy.close();
    }

    harness = await startProxyHarness();
  });

  it('leaves the error code empty for a genuine upstream 502', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/status/502`);
    await harness.waitForObservations(1);

    const observation = harness.observations.at(-1);
    expect(observation?.response.statusCode).toBe(502);
    expect(observation?.upstreamErrorCode).toBeUndefined();
  });
});
