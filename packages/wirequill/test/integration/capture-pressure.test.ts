import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../helpers/raw-http.js';
import { startProxyHarness, waitFor, type ProxyHarness } from '../helpers/proxy-harness.js';

/**
 * What happens when capture cannot keep up (spec sections 20, 82).
 *
 * The rule under test is the one the whole phase rests on: capture may fail,
 * the proxy may not. A backlog costs documentation samples and nothing else.
 */

let harness: ProxyHarness;

afterEach(async () => {
  await harness.close();
});

describe('processing queue under pressure', () => {
  it('drops observations rather than slowing traffic down', async () => {
    // Queue work is captured instead of run, so the queue genuinely fills.
    const deferred: (() => void)[] = [];

    harness = await startProxyHarness({
      captureLimits: { maxPendingObservations: 1 },
      schedule: (task) => deferred.push(task),
    });

    const payload = Buffer.from(JSON.stringify({ filler: 'z'.repeat(2048) }));

    for (let index = 0; index < 6; index += 1) {
      const response = await rawRequest(`${harness.proxyOrigin}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });

      // Every single request succeeded and round-tripped intact.
      expect(response.status).toBe(200);
      expect(response.body.equals(payload)).toBe(true);
    }

    await waitFor(
      () => (harness.pipeline?.stats.dropped ?? 0) > 0,
      5_000,
      'the queue to start dropping',
    );

    const stats = harness.pipeline?.stats;
    expect(stats?.dropped).toBeGreaterThan(0);

    // Dropped observations released their reservation immediately, so the
    // budget only holds what is still queued or in flight.
    expect(stats?.reservedBytes).toBeLessThan(payload.byteLength * 6);

    // Let the deferred work run so shutdown is clean.
    for (const task of deferred.splice(0)) {
      task();
    }
  });

  it('warns once rather than once per dropped request', async () => {
    const deferred: (() => void)[] = [];

    harness = await startProxyHarness({
      captureLimits: { maxPendingObservations: 1 },
      schedule: (task) => deferred.push(task),
    });

    for (let index = 0; index < 6; index += 1) {
      await rawRequest(`${harness.proxyOrigin}/hello`);
    }

    await waitFor(() => (harness.pipeline?.stats.dropped ?? 0) > 1, 5_000, 'more than one drop');

    const warnings = harness.stderr.filter((line) =>
      line.includes('Capture processing is falling behind'),
    );

    expect(warnings).toHaveLength(1);

    for (const task of deferred.splice(0)) {
      task();
    }
  });

  it('releases every reservation once the backlog is worked off', async () => {
    const deferred: (() => void)[] = [];

    harness = await startProxyHarness({
      captureLimits: { maxPendingObservations: 4 },
      schedule: (task) => deferred.push(task),
    });

    for (let index = 0; index < 3; index += 1) {
      await rawRequest(`${harness.proxyOrigin}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ index })),
      });
    }

    await waitFor(() => deferred.length > 0, 5_000, 'queued work');

    // Drain by hand: each task schedules the next one.
    while (deferred.length > 0) {
      const task = deferred.shift();
      task?.();
    }

    await waitFor(
      () => (harness.pipeline?.stats.reservedBytes ?? -1) === 0,
      5_000,
      'the budget to return to zero',
    );

    expect(harness.pipeline?.stats.reservedBytes).toBe(0);
  });
});
