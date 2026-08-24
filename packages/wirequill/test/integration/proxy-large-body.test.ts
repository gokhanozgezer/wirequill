import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../fixtures/backend.js';
import { rawRequest } from '../helpers/raw-http.js';
import { startProxyHarness, type ProxyHarness } from '../helpers/proxy-harness.js';

/**
 * Release blocker RB3: large bodies must be forwarded, not accumulated.
 *
 * Hash equality proves the bytes survived. The slow-upload test proves they
 * were streamed: if WireQuill collected the request before opening the upstream
 * connection, the backend would receive the whole payload in one burst and the
 * spread between its first and last chunk would collapse to nothing.
 */

let harness: ProxyHarness;

beforeAll(async () => {
  harness = await startProxyHarness();
});

afterAll(async () => {
  await harness.close();
});

interface HashReport {
  sha256: string;
  bytes: number;
  firstChunkAtMs: number;
  lastChunkAtMs: number;
}

/** Repeating deterministic filler, cheap to build at megabyte scale. */
function payloadOf(size: number): Buffer {
  const block = Buffer.alloc(64 * 1024);
  for (let index = 0; index < block.byteLength; index += 1) {
    block[index] = (index * 31 + 7) % 251;
  }

  const out = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const take = Math.min(block.byteLength, size - offset);
    block.copy(out, offset, 0, take);
    offset += take;
  }
  return out;
}

describe('large request bodies (RB3)', () => {
  it('forwards a 5 MiB body with its hash intact', async () => {
    const body = payloadOf(5 * 1024 * 1024);

    const response = await rawRequest(`${harness.proxyOrigin}/large`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    const report = JSON.parse(response.body.toString('utf8')) as HashReport;

    expect(response.status).toBe(200);
    expect(report.bytes).toBe(body.byteLength);
    expect(report.sha256).toBe(sha256(body));
  });

  it('forwards a 10 MiB body with its hash intact', async () => {
    const body = payloadOf(10 * 1024 * 1024);

    const response = await rawRequest(`${harness.proxyOrigin}/large`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    const report = JSON.parse(response.body.toString('utf8')) as HashReport;

    expect(response.status).toBe(200);
    expect(report.bytes).toBe(10 * 1024 * 1024);
    expect(report.sha256).toBe(sha256(body));
  });

  it('streams the upload instead of buffering it first', async () => {
    const chunk = payloadOf(256 * 1024);
    const chunkCount = 12;
    const gapMs = 40;

    const report = await slowUpload(`${harness.proxyOrigin}/large`, chunk, chunkCount, gapMs);

    expect(report.bytes).toBe(chunk.byteLength * chunkCount);

    // The client spent roughly chunkCount * gapMs sending. A streaming proxy
    // spreads the backend's reads over the same window; a buffering one would
    // deliver everything at once, making this span near zero.
    const spread = report.lastChunkAtMs - report.firstChunkAtMs;
    expect(spread).toBeGreaterThan(gapMs * chunkCount * 0.4);
  });

  it('keeps serving normal traffic after a large upload', async () => {
    const response = await rawRequest(`${harness.proxyOrigin}/hello`);

    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('hello');
  });
});

/** Uploads `chunk` repeatedly with a pause between writes, using chunked framing. */
function slowUpload(
  target: string,
  chunk: Buffer,
  chunkCount: number,
  gapMs: number,
): Promise<HashReport> {
  const url = new URL(target);

  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (data: Buffer) => chunks.push(data));
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as HashReport);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );

    request.on('error', reject);

    let written = 0;
    const timer = setInterval(() => {
      if (written >= chunkCount) {
        clearInterval(timer);
        request.end();
        return;
      }
      written += 1;
      request.write(chunk);
    }, gapMs);
  });
}
