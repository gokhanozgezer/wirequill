import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STREAM_CHUNKS, STREAM_INTERVAL_MS } from '../fixtures/backend.js';
import { streamingRequest } from '../helpers/raw-http.js';
import { startProxyHarness, type ProxyHarness } from '../helpers/proxy-harness.js';

/**
 * Release blocker RB4: the response must not be buffered.
 *
 * Asserting only on the final body would pass even for a proxy that collected
 * the whole response first, so these tests assert on arrival *times*: the first
 * chunk has to reach the client while the upstream response is still open.
 */

let harness: ProxyHarness;

beforeAll(async () => {
  harness = await startProxyHarness();
});

afterAll(async () => {
  await harness.close();
});

describe('streaming responses (RB4)', () => {
  it('delivers the first chunk long before the response ends', async () => {
    const response = await streamingRequest(`${harness.proxyOrigin}/stream`);

    expect(response.status).toBe(200);

    const first = response.chunks[0];
    expect(first).toBeDefined();

    const body = Buffer.concat(response.chunks.map((chunk) => chunk.data)).toString('utf8');
    expect(body).toBe(STREAM_CHUNKS.join(''));

    // The backend emits three chunks spaced STREAM_INTERVAL_MS apart, so the
    // response cannot end before roughly 3 intervals. A buffering proxy would
    // deliver the first chunk at the same moment as the last.
    const firstAt = first?.atMs ?? Number.POSITIVE_INFINITY;
    expect(firstAt).toBeLessThan(response.endedAtMs - STREAM_INTERVAL_MS);
    expect(response.endedAtMs).toBeGreaterThan(STREAM_INTERVAL_MS * 2);
  });

  it('delivers chunks separately rather than as one write', async () => {
    const response = await streamingRequest(`${harness.proxyOrigin}/stream`);

    expect(response.chunks.length).toBeGreaterThan(1);

    // Consecutive chunks must be spread out in time, not emitted back to back.
    const first = response.chunks[0];
    const last = response.chunks.at(-1);
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect((last?.atMs ?? 0) - (first?.atMs ?? 0)).toBeGreaterThan(STREAM_INTERVAL_MS);
  });

  it('streams a server-sent event stream through untouched', async () => {
    const response = await streamingRequest(`${harness.proxyOrigin}/events`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    const first = response.chunks[0];
    expect(first).toBeDefined();
    expect(first?.data.toString('utf8')).toContain('event: tick');

    // The first event arrived well before the stream closed.
    expect(first?.atMs ?? Number.POSITIVE_INFINITY).toBeLessThan(
      response.endedAtMs - STREAM_INTERVAL_MS,
    );

    const body = Buffer.concat(response.chunks.map((chunk) => chunk.data)).toString('utf8');
    expect(body).toContain('{"n":1}');
    expect(body).toContain('{"n":3}');
  });

  it('lets a client read one event and disconnect early', async () => {
    const response = await streamingRequest(`${harness.proxyOrigin}/events`, {
      stopAfterChunks: 1,
    });

    expect(response.chunks).toHaveLength(1);
    expect(response.chunks[0]?.data.toString('utf8')).toContain('{"n":1}');
  });

  it('keeps serving requests after a client aborts a stream', async () => {
    await streamingRequest(`${harness.proxyOrigin}/stream`, { stopAfterChunks: 1 });

    const after = await streamingRequest(`${harness.proxyOrigin}/hello`);
    expect(after.status).toBe(200);
    expect(Buffer.concat(after.chunks.map((chunk) => chunk.data)).toString('utf8')).toBe('hello');
  });
});
