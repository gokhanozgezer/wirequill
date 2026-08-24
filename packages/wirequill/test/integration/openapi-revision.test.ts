import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../helpers/raw-http.js';
import { startProxyHarness, type ProxyHarness } from '../helpers/proxy-harness.js';

/**
 * Release blockers RB3, RB11 and RB12.
 *
 * A revision has to move when the contract moves and stay put when it does not.
 * Getting the second half wrong is what makes a "docs changed" indicator
 * useless: a revision that ticks on every request tells a reader nothing.
 */

let harness: ProxyHarness;

afterEach(async () => {
  await harness.close();
});

function publicRevision(target: ProxyHarness, pathTemplate: string): number {
  const db = new DatabaseSync(target.databasePath);
  const row = db
    .prepare('SELECT public_revision FROM operations WHERE path_template = ?')
    .get(pathTemplate) as { public_revision: number } | undefined;
  db.close();

  return row?.public_revision ?? 0;
}

function countExamples(target: ProxyHarness): number {
  const db = new DatabaseSync(target.databasePath);
  const row = db.prepare('SELECT COUNT(*) AS c FROM examples').get() as { c: number };
  db.close();

  return row.c;
}

async function post(path: string, body: unknown) {
  await rawRequest(`${harness.proxyOrigin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(body)),
  });
}

describe('revision stays put on repetition (RB11)', () => {
  it('moves once across ten identical requests, not once per request', async () => {
    harness = await startProxyHarness();

    await post('/echo', { id: 1, name: 'A' });
    await harness.waitForObservations(1);
    expect(publicRevision(harness, '/echo')).toBe(1);

    await post('/echo', { id: 1, name: 'A' });
    await harness.waitForObservations(2);
    expect(publicRevision(harness, '/echo')).toBe(1);

    // The third sample is the one that turns requiredness on, which a reader
    // does see. That is a real change and it earns exactly one bump.
    await post('/echo', { id: 1, name: 'A' });
    await harness.waitForObservations(3);
    const settled = publicRevision(harness, '/echo');
    expect(settled).toBe(2);

    // Everything after it is genuinely the same document.
    for (let index = 0; index < 7; index += 1) {
      await post('/echo', { id: 1, name: 'A' });
    }
    await harness.waitForObservations(10);

    expect(publicRevision(harness, '/echo')).toBe(settled);
  });

  it('does not move for a different value of the same shape', async () => {
    harness = await startProxyHarness();

    await post('/echo', { id: 1, name: 'A' });
    await harness.waitForObservations(1);

    await post('/echo', { id: 2, name: 'B' });
    await post('/echo', { id: 3, name: 'C' });
    await harness.waitForObservations(3);

    // Requiredness turns on at the third sample, which *is* a public change.
    // What must not have happened is a bump per request.
    expect(publicRevision(harness, '/echo')).toBeLessThanOrEqual(2);
  });

  it('does not move for a second unique example', async () => {
    harness = await startProxyHarness();

    await post('/echo', { id: 1 });
    await harness.waitForObservations(1);
    const afterFirst = publicRevision(harness, '/echo');

    // A different body of the same shape: stored as a second example, but the
    // document shows only the first, so nothing public changed.
    await post('/echo', { id: 2 });
    await harness.waitForObservations(2);

    expect(countExamples(harness)).toBeGreaterThan(1);
    expect(publicRevision(harness, '/echo')).toBe(afterFirst);
  });
});

describe('revision moves on a real change (RB12)', () => {
  it('starts at one for a newly discovered operation', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/schema`);
    await harness.waitForObservations(1);

    expect(publicRevision(harness, '/schema')).toBe(1);
  });

  it('moves when a new response status appears', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/status/200`);
    await harness.waitForObservations(1);
    const before = publicRevision(harness, '/status/200');

    await rawRequest(`${harness.proxyOrigin}/status/200`);
    await harness.waitForObservations(2);

    expect(publicRevision(harness, '/status/200')).toBe(before);
  });

  it('moves when a response gains a field', async () => {
    harness = await startProxyHarness();

    await post('/echo', { id: 1 });
    await harness.waitForObservations(1);
    const before = publicRevision(harness, '/echo');

    await post('/echo', { id: 2, name: 'Ada' });
    await harness.waitForObservations(2);

    expect(publicRevision(harness, '/echo')).toBe(before + 1);
  });

  it('moves when requiredness flips on and off', async () => {
    harness = await startProxyHarness();

    await post('/echo', { id: 1, name: 'A' });
    await post('/echo', { id: 2, name: 'B' });
    await harness.waitForObservations(2);
    const beforeRequired = publicRevision(harness, '/echo');

    // Third identical-shaped sample: `id` and `name` become required.
    await post('/echo', { id: 3, name: 'C' });
    await harness.waitForObservations(3);
    const afterRequired = publicRevision(harness, '/echo');
    expect(afterRequired).toBe(beforeRequired + 1);

    // Fourth sample without `name`: it becomes optional again.
    await post('/echo', { id: 4 });
    await harness.waitForObservations(4);

    expect(publicRevision(harness, '/echo')).toBe(afterRequired + 1);
  });
});

describe('document revision and cache', () => {
  it('sums operation revisions, so it is a pure function of the evidence', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/schema`);
    await rawRequest(`${harness.proxyOrigin}/hello`);
    await harness.waitForObservations(2);

    const revision = harness.openApi.getRevision();

    expect(revision).toBe(publicRevision(harness, '/schema') + publicRevision(harness, '/hello'));
    expect(harness.openApi.getDocument()['x-wirequill'].revision).toBe(revision);
  });

  it('rebuilds only after something public changed', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/schema`);
    await harness.waitForObservations(1);

    harness.openApi.getDocument();
    expect(harness.openApi.isDirty).toBe(false);

    // An identical request changes nothing public, so the cache stays warm.
    await rawRequest(`${harness.proxyOrigin}/schema`);
    await harness.waitForObservations(2);
    expect(harness.openApi.isDirty).toBe(false);

    // A new endpoint does change the document.
    await rawRequest(`${harness.proxyOrigin}/hello`);
    await harness.waitForObservations(3);
    expect(harness.openApi.isDirty).toBe(true);

    expect(Object.keys(harness.openApi.getDocument().paths)).toEqual(['/hello', '/schema']);
  });
});

describe('example bounds (RB3)', () => {
  it('keeps at most three unique examples per bucket', async () => {
    harness = await startProxyHarness();

    for (let index = 0; index < 6; index += 1) {
      await post('/echo', { id: index });
    }
    await harness.waitForObservations(6);

    const db = new DatabaseSync(harness.databasePath);
    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM examples WHERE direction = 'request'")
      .get() as { c: number };
    db.close();

    expect(rows.c).toBe(3);
  });

  it('stores a duplicate body only once', async () => {
    harness = await startProxyHarness();

    for (let index = 0; index < 4; index += 1) {
      await post('/echo', { id: 1, name: 'same' });
    }
    await harness.waitForObservations(4);

    const db = new DatabaseSync(harness.databasePath);
    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM examples WHERE direction = 'request'")
      .get() as { c: number };
    db.close();

    expect(rows.c).toBe(1);
  });

  it('separates request and response buckets', async () => {
    harness = await startProxyHarness();

    await post('/echo', { id: 1 });
    await harness.waitForObservations(1);

    const db = new DatabaseSync(harness.databasePath);
    const rows = db
      .prepare('SELECT direction, status_code FROM examples ORDER BY direction')
      .all() as { direction: string; status_code: number | null }[];
    db.close();

    expect(rows).toEqual([
      { direction: 'request', status_code: null },
      { direction: 'response', status_code: 200 },
    ]);
  });

  it('separates response statuses', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/schema`);
    await rawRequest(`${harness.proxyOrigin}/schema/missing`);
    await harness.waitForObservations(2);

    const db = new DatabaseSync(harness.databasePath);
    const statuses = db
      .prepare("SELECT DISTINCT status_code FROM examples WHERE direction = 'response'")
      .all() as { status_code: number }[];
    db.close();

    expect(statuses.map((row) => row.status_code).sort()).toEqual([200, 404]);
  });

  it('stores no example for a body it could not read', async () => {
    harness = await startProxyHarness({ captureLimits: { maxBodyBytes: 16 } });

    await post('/echo', { id: 1, filler: 'long enough to be truncated by the limit' });
    await harness.waitForObservations(1);

    expect(countExamples(harness)).toBe(0);
  });
});
