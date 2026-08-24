import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { isRequired } from '../../src/inference/operation/types.js';
import type {
  HeaderParameterEvidence,
  PathParameterEvidence,
  QueryParameterEvidence,
  SecurityEvidence,
} from '../../src/inference/operation/types.js';
import { rawRequest } from '../helpers/raw-http.js';
import { startProxyHarness, type ProxyHarness } from '../helpers/proxy-harness.js';

/**
 * Release blockers RB1, RB2, RB4, RB5, RB6, RB7 and RB8.
 *
 * Everything here goes through a real proxy, a real capture pipeline and real
 * SQLite, because operation identity is only meaningful once it survives
 * persistence.
 */

let harness: ProxyHarness;

afterEach(async () => {
  await harness.close();
});

interface OperationRow {
  id: string;
  method: string;
  path_template: string;
  operation_id: string;
  observed_count: number;
  first_seen_at: string;
  last_seen_at: string;
  path_parameters_json: string;
  query_parameters_json: string;
  header_parameters_json: string;
  security_evidence_json: string;
  request_bodies_evidence_json: string;
  responses_evidence_json: string;
}

/** Reads the operations table after closing the pipeline's own handle. */
function readOperations(target: ProxyHarness): OperationRow[] {
  target.storage?.close();

  const db = new DatabaseSync(target.databasePath);
  const rows = db
    .prepare('SELECT * FROM operations ORDER BY path_template, method')
    .all() as unknown as OperationRow[];
  db.close();

  return rows;
}

function readObservations(target: ProxyHarness): Record<string, unknown>[] {
  const db = new DatabaseSync(target.databasePath);
  const rows = db.prepare('SELECT * FROM observations ORDER BY observed_at').all() as Record<
    string,
    unknown
  >[];
  db.close();

  return rows;
}

async function get(path: string, headers: Record<string, string> = {}): Promise<void> {
  await rawRequest(`${harness.proxyOrigin}${path}`, { headers });
}

describe('operation merging', () => {
  it('collapses identifier variants into one operation (RB1, RB4)', async () => {
    harness = await startProxyHarness();

    await get('/users/1');
    await get('/users/2');
    await get('/users/3');
    await harness.waitForObservations(3);

    const operations = readOperations(harness);

    expect(operations).toHaveLength(1);
    expect(operations[0]?.path_template).toBe('/users/{userId}');
    expect(operations[0]?.method).toBe('GET');
    expect(operations[0]?.observed_count).toBe(3);
    expect(operations[0]?.operation_id).toBe('getUsersByUserId');
  });

  it('keeps a singleton route separate from an identifier route (RB2)', async () => {
    harness = await startProxyHarness();

    await get('/users/me');
    await get('/users/123');
    await harness.waitForObservations(2);

    const templates = readOperations(harness).map((row) => row.path_template);

    expect(templates).toEqual(['/users/123'.replace('123', '{userId}'), '/users/me'].sort());
  });

  it('keeps API versions apart', async () => {
    harness = await startProxyHarness();

    await get('/api/v1/users/1');
    await get('/api/v2/users/1');
    await harness.waitForObservations(2);

    expect(readOperations(harness).map((row) => row.path_template)).toEqual([
      '/api/v1/users/{userId}',
      '/api/v2/users/{userId}',
    ]);
  });

  it('separates operations by method (RB5)', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/users/1`);
    await rawRequest(`${harness.proxyOrigin}/users/1`, { method: 'PATCH' });
    await rawRequest(`${harness.proxyOrigin}/users/1`, { method: 'DELETE' });
    await harness.waitForObservations(3);

    const operations = readOperations(harness);

    expect(operations).toHaveLength(3);
    expect(operations.map((row) => row.method).sort()).toEqual(['DELETE', 'GET', 'PATCH']);

    // One template, three distinct rows and three distinct readable ids.
    expect(new Set(operations.map((row) => row.path_template)).size).toBe(1);
    expect(new Set(operations.map((row) => row.id)).size).toBe(3);
    expect(new Set(operations.map((row) => row.operation_id)).size).toBe(3);
  });

  it('records path parameter evidence with a synthetic example', async () => {
    harness = await startProxyHarness();

    await get('/users/987654');
    await harness.waitForObservations(1);

    const row = readOperations(harness)[0];
    const parameters = JSON.parse(row?.path_parameters_json ?? '[]') as PathParameterEvidence[];

    expect(parameters).toHaveLength(1);
    expect(parameters[0]?.name).toBe('userId');
    expect(parameters[0]?.position).toBe(1);
    expect(parameters[0]?.kinds.integer).toBe(1);

    // The example is a stand-in, never the value a client actually sent.
    expect(parameters[0]?.syntheticExample).toBe('123');
    expect(row?.path_parameters_json).not.toContain('987654');
  });

  it('records no request body evidence for a request that had none', async () => {
    harness = await startProxyHarness();

    await get('/users/1');
    await harness.waitForObservations(1);

    const row = readOperations(harness)[0];

    // A GET with no body must not create an empty request-body bucket.
    expect(row?.request_bodies_evidence_json).toBe('{}');
    // The response, on the other hand, is real and is recorded.
    expect(row?.responses_evidence_json).toContain('"200"');
  });

  it('tracks first and last seen', async () => {
    harness = await startProxyHarness();

    await get('/users/1');
    await harness.waitForObservations(1);
    await get('/users/2');
    await harness.waitForObservations(2);

    const row = readOperations(harness)[0];

    expect(row?.first_seen_at).toBeDefined();
    expect(row?.last_seen_at).toBeDefined();
    expect(Date.parse(row?.last_seen_at ?? '')).toBeGreaterThanOrEqual(
      Date.parse(row?.first_seen_at ?? ''),
    );
  });
});

describe('query evidence (RB6)', () => {
  it('counts presence against samples and demotes an optional parameter', async () => {
    harness = await startProxyHarness();

    await get('/products?page=1');
    await get('/products?page=2');
    await get('/products?page=3');
    await harness.waitForObservations(3);

    let parameters = JSON.parse(
      readOperations(harness)[0]?.query_parameters_json ?? '[]',
    ) as QueryParameterEvidence[];
    let page = parameters.find((entry) => entry.name === 'page');

    expect(page?.presentCount).toBe(3);
    expect(page?.operationSamples).toBe(3);
    expect(isRequired(page?.operationSamples ?? 0, page?.presentCount ?? 0)).toBe(true);

    // A fourth request without the parameter corrects the answer.
    await harness.close();
    harness = await startProxyHarness();

    await get('/products?page=1');
    await get('/products?page=2');
    await get('/products?page=3');
    await get('/products');
    await harness.waitForObservations(4);

    parameters = JSON.parse(
      readOperations(harness)[0]?.query_parameters_json ?? '[]',
    ) as QueryParameterEvidence[];
    page = parameters.find((entry) => entry.name === 'page');

    expect(page?.presentCount).toBe(3);
    expect(page?.operationSamples).toBe(4);
    expect(isRequired(page?.operationSamples ?? 0, page?.presentCount ?? 0)).toBe(false);
  });

  it('types query values conservatively', async () => {
    harness = await startProxyHarness();

    await get('/products?page=2&price=4.2&active=true&postal=00123');
    await harness.waitForObservations(1);

    const parameters = JSON.parse(
      readOperations(harness)[0]?.query_parameters_json ?? '[]',
    ) as QueryParameterEvidence[];
    const byName = new Map(parameters.map((entry) => [entry.name, entry]));

    expect(byName.get('page')?.typeCounts.integer).toBe(1);
    expect(byName.get('price')?.typeCounts.number).toBe(1);
    expect(byName.get('active')?.typeCounts.boolean).toBe(1);
    expect(byName.get('postal')?.typeCounts.string).toBe(1);
  });

  it('records a repeated parameter as an array', async () => {
    harness = await startProxyHarness();

    await get('/products?tag=a&tag=b');
    await harness.waitForObservations(1);

    const parameters = JSON.parse(
      readOperations(harness)[0]?.query_parameters_json ?? '[]',
    ) as QueryParameterEvidence[];
    const tag = parameters.find((entry) => entry.name === 'tag');

    expect(tag?.typeCounts.array).toBe(1);
    expect(tag?.typeCounts.string).toBe(2);
    expect(tag?.repeatedCount).toBe(1);
    // Repetition within one request still counts as one sample.
    expect(tag?.presentCount).toBe(1);
  });

  it('marks a redacted parameter as sensitive without guessing its type', async () => {
    harness = await startProxyHarness();

    await get('/products?token=QUERY_SECRET_VALUE_MARKER');
    await harness.waitForObservations(1);

    const row = readOperations(harness)[0];
    const parameters = JSON.parse(row?.query_parameters_json ?? '[]') as QueryParameterEvidence[];
    const token = parameters.find((entry) => entry.name === 'token');

    expect(token?.sensitive).toBe(true);
    expect(row?.query_parameters_json).not.toContain('QUERY_SECRET_VALUE_MARKER');
  });
});

describe('header evidence', () => {
  it('documents a custom header and ignores the noise around it', async () => {
    harness = await startProxyHarness();

    await get('/users/1', {
      'X-Tenant-Id': 'acme',
      'User-Agent': 'wirequill-test/1.0',
      Referer: 'http://localhost:5173/',
      traceparent: '00-abc-def-01',
      'X-Request-Id': 'req-1',
    });
    await harness.waitForObservations(1);

    const parameters = JSON.parse(
      readOperations(harness)[0]?.header_parameters_json ?? '[]',
    ) as HeaderParameterEvidence[];
    const names = parameters.map((entry) => entry.name);

    expect(names).toContain('x-tenant-id');
    expect(names).not.toContain('user-agent');
    expect(names).not.toContain('referer');
    expect(names).not.toContain('traceparent');
    expect(names).not.toContain('x-request-id');
    expect(names).not.toContain('host');
  });
});

describe('security evidence (RB7)', () => {
  it('records the scheme without the credential', async () => {
    harness = await startProxyHarness();

    await get('/users/1', { Authorization: 'Bearer SECURITY_SECRET_MARKER' });
    await get('/users/2', { Authorization: 'Bearer SECURITY_SECRET_MARKER' });
    await get('/users/3');
    await harness.waitForObservations(3);

    const row = readOperations(harness)[0];
    const security = JSON.parse(row?.security_evidence_json ?? '{}') as SecurityEvidence;

    expect(security.bearer).toBe(2);
    expect(security.unauthenticated).toBe(1);
    expect(row?.security_evidence_json).not.toContain('SECURITY_SECRET_MARKER');
  });

  it('records an API key by name only', async () => {
    harness = await startProxyHarness();

    await get('/users/1', { 'X-Api-Key': 'APIKEY_SECRET_MARKER' });
    await harness.waitForObservations(1);

    const row = readOperations(harness)[0];
    const security = JSON.parse(row?.security_evidence_json ?? '{}') as SecurityEvidence;

    expect(security.apiKeys['x-api-key']).toEqual({ location: 'header', count: 1 });
    expect(security.unauthenticated).toBe(0);
    expect(row?.security_evidence_json).not.toContain('APIKEY_SECRET_MARKER');
  });
});

describe('observation linkage (RB8)', () => {
  it('points every new observation at its operation', async () => {
    harness = await startProxyHarness();

    await get('/users/1');
    await get('/users/2');
    await harness.waitForObservations(2);

    const operations = readOperations(harness);
    const observations = readObservations(harness);

    expect(observations).toHaveLength(2);
    for (const observation of observations) {
      expect(observation.operation_id).toBe(operations[0]?.id);
    }
  });

  it('leaves an ineligible request unlinked but still recorded', async () => {
    harness = await startProxyHarness();

    await get('/assets/app.js');
    await harness.waitForObservations(1);

    const operations = readOperations(harness);
    const observations = readObservations(harness);

    // Proxied and observed, but not an API operation.
    expect(operations).toHaveLength(0);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.operation_id).toBeNull();
  });

  it('does not document a preflight request', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/users/1`, { method: 'OPTIONS' });
    await harness.waitForObservations(1);

    expect(readOperations(harness)).toHaveLength(0);
  });
});

describe('discovery reporting', () => {
  it('marks only the first sighting as discovered', async () => {
    harness = await startProxyHarness();

    await get('/users/1');
    await harness.waitForObservations(1);
    await get('/users/2');
    await harness.waitForObservations(2);
    await get('/users/me');
    await harness.waitForObservations(3);

    expect(harness.processed.map((entry) => [entry.displayPath, entry.discovered])).toEqual([
      ['/users/{userId}', true],
      ['/users/{userId}', false],
      ['/users/me', true],
    ]);
  });

  it('prints the template rather than the request path', async () => {
    harness = await startProxyHarness();

    await get('/users/987654');
    await harness.waitForObservations(1);

    const printed = harness.stdout.join('\n');

    expect(printed).toContain('/users/{userId}');
    expect(printed).not.toContain('987654');
  });
});
