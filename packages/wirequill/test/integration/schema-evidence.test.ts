import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  materializeSchema,
  type JsonSchema,
} from '../../src/inference/schema/materialize-schema.js';
import type { SchemaEvidence } from '../../src/inference/schema/types.js';
import type {
  BodyEvidenceByMediaType,
  ResponseEvidenceByStatus,
} from '../../src/processing/body-evidence.js';
import { rawRequest } from '../helpers/raw-http.js';
import { getFreePort } from '../helpers/ports.js';
import {
  startProxyHarness,
  startProxyOnly,
  waitFor,
  type ProxyHarness,
} from '../helpers/proxy-harness.js';

/**
 * Release blockers RB1, RB2, RB3, RB4, RB9, RB10, RB11 and RB12.
 *
 * Everything runs through a real proxy, a real capture pipeline and real
 * SQLite, because schema evidence only matters once it has survived being
 * merged across requests and written to disk.
 */

let harness: ProxyHarness;

afterEach(async () => {
  await harness.close();
});

interface OperationRow {
  observed_count: number;
  request_bodies_evidence_json: string;
  responses_evidence_json: string;
}

function readOperation(target: ProxyHarness): OperationRow {
  target.storage?.close();

  const db = new DatabaseSync(target.databasePath);
  const row = db.prepare('SELECT * FROM operations').get() as unknown as OperationRow;
  db.close();

  return row;
}

function requestSchema(row: OperationRow, mediaType = 'application/json'): JsonSchema {
  const evidence = JSON.parse(row.request_bodies_evidence_json) as BodyEvidenceByMediaType;
  return materializeSchema(evidence[mediaType]?.schemaEvidence ?? null);
}

function responseSchema(
  row: OperationRow,
  status: string,
  mediaType = 'application/json',
): JsonSchema {
  const evidence = JSON.parse(row.responses_evidence_json) as ResponseEvidenceByStatus;
  return materializeSchema(evidence[status]?.content[mediaType]?.schemaEvidence ?? null);
}

async function post(path: string, body: unknown): Promise<void> {
  await rawRequest(`${harness.proxyOrigin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(body)),
  });
}

describe('request body evidence (RB3, RB4, RB9)', () => {
  it('merges properties across samples and derives requiredness', async () => {
    harness = await startProxyHarness();

    await post('/echo', { id: 1, name: 'A' });
    await post('/echo', { id: 2, name: 'B' });
    await post('/echo', { id: 3 });
    await harness.waitForObservations(3);

    const row = readOperation(harness);
    const evidence = JSON.parse(row.request_bodies_evidence_json) as BodyEvidenceByMediaType;
    const bucket = evidence['application/json'];

    expect(bucket?.observedCount).toBe(3);
    expect(bucket?.analyzableCount).toBe(3);

    const object = (bucket?.schemaEvidence as SchemaEvidence).object;
    expect(object?.objectSamples).toBe(3);
    expect(object?.properties.id?.present).toBe(3);
    expect(object?.properties.name?.present).toBe(2);

    expect(requestSchema(row)).toEqual({
      type: 'object',
      properties: { id: { type: 'integer' }, name: { type: 'string' } },
      required: ['id'],
    });
  });

  it('does not create a request bucket for a request without a body', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/schema`);
    await harness.waitForObservations(1);

    expect(readOperation(harness).request_bodies_evidence_json).toBe('{}');
  });

  it('records a form body as an object schema', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: Buffer.from('name=Ada&tag=a&tag=b'),
    });
    await harness.waitForObservations(1);

    const schema = requestSchema(readOperation(harness), 'application/x-www-form-urlencoded');

    expect(schema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        tag: { type: 'array', items: { type: 'string' } },
      },
    });
  });
});

describe('response evidence isolation (RB10)', () => {
  it('keeps a 200 payload and a 404 error body apart', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/schema`);
    await rawRequest(`${harness.proxyOrigin}/schema/missing`);
    await harness.waitForObservations(2);

    harness.storage?.close();
    const db = new DatabaseSync(harness.databasePath);
    const rows = db
      .prepare('SELECT path_template, responses_evidence_json FROM operations')
      .all() as { path_template: string; responses_evidence_json: string }[];
    db.close();

    const ok = rows.find((row) => row.path_template === '/schema');
    const missing = rows.find((row) => row.path_template === '/schema/missing');

    const okSchema = materializeSchema(
      (JSON.parse(ok?.responses_evidence_json ?? '{}') as ResponseEvidenceByStatus)['200']?.content[
        'application/json'
      ]?.schemaEvidence ?? null,
    );
    const missingSchema = materializeSchema(
      (JSON.parse(missing?.responses_evidence_json ?? '{}') as ResponseEvidenceByStatus)['404']
        ?.content['application/json']?.schemaEvidence ?? null,
    );

    expect(okSchema).toEqual({
      type: 'object',
      properties: {
        active: { type: 'boolean' },
        id: { type: 'integer' },
        name: { type: 'string' },
      },
    });
    expect(missingSchema).toEqual({
      type: 'object',
      properties: { code: { type: 'integer' }, error: { type: 'string' } },
    });
  });

  it('separates media types within one status', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/schema/problem`);
    await harness.waitForObservations(1);

    const evidence = JSON.parse(
      readOperation(harness).responses_evidence_json,
    ) as ResponseEvidenceByStatus;
    const content = evidence['404']?.content;

    expect(Object.keys(content ?? {})).toEqual(['application/problem+json']);
    expect(content?.['application/json']).toBeUndefined();
  });

  it('counts a 204 without inventing content', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/no-content`, { method: 'DELETE' });
    await harness.waitForObservations(1);

    const evidence = JSON.parse(
      readOperation(harness).responses_evidence_json,
    ) as ResponseEvidenceByStatus;

    expect(evidence['204']?.observedCount).toBe(1);
    expect(evidence['204']?.content).toEqual({});
  });

  it('merges a nullable field across samples without losing its format', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/schema/nullable?avatar=https://example.com/a.png`);
    await rawRequest(`${harness.proxyOrigin}/schema/nullable?avatar=null`);
    await rawRequest(`${harness.proxyOrigin}/schema/nullable?avatar=https://example.com/b.png`);
    await harness.waitForObservations(3);

    expect(responseSchema(readOperation(harness), '200')).toEqual({
      type: 'object',
      properties: { avatar: { type: ['string', 'null'], format: 'uri' } },
      required: ['avatar'],
    });
  });
});

describe('generated versus real 502 (RB11)', () => {
  it('does not record WireQuill own 502 as the API behaviour', async () => {
    const deadPort = await getFreePort();
    const proxy = await startProxyOnly(`http://127.0.0.1:${String(deadPort)}`);

    try {
      const response = await rawRequest(`${proxy.proxyOrigin}/users`);
      expect(response.status).toBe(502);

      await waitFor(() => proxy.observations.length > 0, 5_000, 'an observation');

      proxy.storage?.close();
      const db = new DatabaseSync(proxy.databasePath);
      const row = db.prepare('SELECT responses_evidence_json FROM operations').get() as
        { responses_evidence_json: string } | undefined;
      db.close();

      // The 502 came from WireQuill because the target was unreachable. It is
      // not something the API did, and documenting it would leave a phantom
      // status behind once the backend came back.
      expect(JSON.parse(row?.responses_evidence_json ?? '{}')).toEqual({});
    } finally {
      await proxy.close();
    }

    harness = await startProxyHarness();
  });

  it('records a 502 the backend really sent', async () => {
    harness = await startProxyHarness();

    const response = await rawRequest(`${harness.proxyOrigin}/schema/bad-gateway`);
    expect(response.status).toBe(502);

    await harness.waitForObservations(1);

    const evidence = JSON.parse(
      readOperation(harness).responses_evidence_json,
    ) as ResponseEvidenceByStatus;

    expect(evidence['502']?.observedCount).toBe(1);
    expect(responseSchema(readOperation(harness), '502')).toEqual({
      type: 'object',
      properties: { error: { type: 'string' } },
    });
  });
});

describe('bodies that cannot be read (RB1)', () => {
  it('counts a truncated body without inferring from it', async () => {
    harness = await startProxyHarness({ captureLimits: { maxBodyBytes: 16 } });

    await post('/echo', { id: 1, name: 'a-value-long-enough-to-be-cut-short' });
    await harness.waitForObservations(1);

    const evidence = JSON.parse(
      readOperation(harness).request_bodies_evidence_json,
    ) as BodyEvidenceByMediaType;
    const bucket = evidence['application/json'];

    // Seen but not understood, and the difference is recorded.
    expect(bucket?.observedCount).toBe(1);
    expect(bucket?.analyzableCount).toBe(0);
    expect(bucket?.schemaEvidence).toBeNull();
    expect(requestSchema(readOperation(harness))).toEqual({});
  });

  it('counts a malformed body without inferring from it', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from('{"broken": '),
    });
    await harness.waitForObservations(1);

    const evidence = JSON.parse(
      readOperation(harness).request_bodies_evidence_json,
    ) as BodyEvidenceByMediaType;

    expect(evidence['application/json']?.observedCount).toBe(1);
    expect(evidence['application/json']?.analyzableCount).toBe(0);
  });

  it('builds no schema tree for a binary body', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(1024, 7),
    });
    await harness.waitForObservations(1);

    const evidence = JSON.parse(
      readOperation(harness).request_bodies_evidence_json,
    ) as BodyEvidenceByMediaType;

    expect(evidence['application/octet-stream']?.analyzableCount).toBe(0);
    expect(evidence['application/octet-stream']?.schemaEvidence).toBeNull();
  });
});

describe('observed_count regression (RB12)', () => {
  it('counts one observation per request, not one per evidence merge', async () => {
    harness = await startProxyHarness();

    await post('/echo', { id: 1 });
    await post('/echo', { id: 2 });
    await post('/echo', { id: 3 });
    await harness.waitForObservations(3);

    // Body evidence merging happens inside the same operation update; it must
    // not increment the sample count a second time.
    expect(readOperation(harness).observed_count).toBe(3);
  });
});

describe('no secret reaches the schema (RB2)', () => {
  it('keeps values out while keeping types in', async () => {
    harness = await startProxyHarness({ verbose: true });

    const body = {
      password: 'SCHEMA_SECRET_PASSWORD',
      email: 'schema-secret@example.com',
      cvv: 987,
      access_token: 'SCHEMA_SECRET_TOKEN',
      nested: { inner: 'SCHEMA_SECRET_NESTED' },
    };

    await post('/echo', body);
    await harness.waitForObservations(1);

    const row = readOperation(harness);
    const database = readFileSync(harness.databasePath).toString('latin1');
    const terminal = [...harness.stdout, ...harness.stderr].join('\n');

    const allValues = [
      'SCHEMA_SECRET_PASSWORD',
      'schema-secret@example.com',
      'SCHEMA_SECRET_TOKEN',
      'SCHEMA_SECRET_NESTED',
    ];

    // Schema evidence carries no observed value, whatever the field was called.
    // This is the schema engine's own guarantee and it does not depend on
    // redaction catching anything.
    for (const value of allValues) {
      expect(row.request_bodies_evidence_json).not.toContain(value);
      expect(terminal).not.toContain(value);
    }

    // Redaction is a separate guarantee, and a narrower one: it covers values
    // under a sensitive field name or with a secret-like shape. `nested.inner`
    // is neither, so it survives — WireQuill does not scan ordinary fields for
    // things that merely look important.
    const redacted = allValues.filter((entry) => entry !== 'SCHEMA_SECRET_NESTED');

    for (const value of redacted) {
      expect(JSON.stringify(harness.observations)).not.toContain(value);
      // Nor into the stored examples, which are built from the redacted body.
      expect(database).not.toContain(value);
    }

    // And the value redaction deliberately keeps does reach the stored example,
    // which is the point of examples: a schema says a field is a string, an
    // example shows what one looks like.
    expect(database).toContain('SCHEMA_SECRET_NESTED');

    // The types survived, which is the point of inferring before redacting.
    expect(requestSchema(row)).toEqual({
      type: 'object',
      properties: {
        access_token: { type: 'string' },
        cvv: { type: 'integer' },
        email: { type: 'string', format: 'email' },
        nested: { type: 'object', properties: { inner: { type: 'string' } } },
        password: { type: 'string' },
      },
    });
  });

  it('carries no numeric value fields that could hold an observed number', async () => {
    harness = await startProxyHarness();

    await post('/echo', { cvv: 987, amount: 12.5 });
    await harness.waitForObservations(1);

    const serialized = readOperation(harness).request_bodies_evidence_json;

    // Rather than scanning for `987`, which would collide with counts, assert
    // that no field capable of holding a value exists at all.
    for (const keyword of [
      'example',
      'examples',
      'default',
      'minimum',
      'maximum',
      'enum',
      'const',
    ]) {
      expect(serialized).not.toContain(`"${keyword}"`);
    }
  });
});
