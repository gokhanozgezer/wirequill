import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Validator } from '@seriousme/openapi-schema-validator';
import {
  getDocs,
  getJson,
  sendDocsRequest,
  startDocsHarness,
  type DocsHarness,
} from '../helpers/docs-harness.js';

/**
 * The documentation HTTP surface (spec sections 30 to 53, 143 and 145).
 *
 * Everything here runs against the real runtime, so a route that answers
 * correctly in isolation but reads the wrong workspace fails here.
 */

let assetRoot: string;
let harness: DocsHarness;

beforeAll(async () => {
  assetRoot = mkdtempSync(path.join(os.tmpdir(), 'wirequill-ui-'));
  mkdirSync(path.join(assetRoot, 'assets'));
  writeFileSync(
    path.join(assetRoot, 'index.html'),
    '<!doctype html><title>WireQuill</title><div id="root"></div>',
  );
  writeFileSync(path.join(assetRoot, 'assets', 'index-ABC123.js'), 'export const ui = 1;');
  writeFileSync(path.join(assetRoot, 'assets', 'index-ABC123.css'), 'body{color:#fff}');

  harness = await startDocsHarness({ assetRoot });

  await harness.call('/schema?id=1');
  await harness.call('/users/1');
  await harness.call('/schema/missing');
  await harness.waitForOperations(3);
});

afterAll(async () => {
  await harness.close();
  rmSync(assetRoot, { recursive: true, force: true });
});

const SUMMARY = '/__wirequill/api/summary';
const HEALTH = '/__wirequill/api/health';
const OPERATIONS = '/__wirequill/api/operations';

interface OperationItem {
  id: string;
  method: string;
  path: string;
  summary: string;
  observedCount: number;
  lastSeenAt: string;
}

describe('GET /openapi.json', () => {
  it('serves a valid OpenAPI 3.1 document', async () => {
    const response = await getDocs(harness.docsOrigin, '/openapi.json');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');

    const { valid, errors } = await new Validator().validate(
      JSON.parse(response.body) as Record<string, unknown>,
    );

    expect(errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it('is the same document the OpenAPI service produces', async () => {
    const served = await getJson<Record<string, unknown>>(harness.docsOrigin, '/openapi.json');

    // The route is a transport, not a second generator (spec sections 33 and 81).
    expect(served).toEqual(harness.runtime.openApi.getDocument());
  });

  it('is pretty-printed, because people read it', async () => {
    const response = await getDocs(harness.docsOrigin, '/openapi.json');
    expect(response.body).toContain('\n  "openapi": "3.1.0"');
  });

  it('answers a matching If-None-Match with 304 and no body', async () => {
    const first = await getDocs(harness.docsOrigin, '/openapi.json');
    const etag = first.headers.etag;

    expect(etag).toMatch(/^W\/"wirequill-\d+"$/);

    const second = await getDocs(harness.docsOrigin, '/openapi.json', {
      'If-None-Match': etag ?? '',
    });

    expect(second.status).toBe(304);
    expect(second.body).toBe('');
    // The validator is an optimisation; the document is still never stored.
    expect(second.headers['cache-control']).toBe('no-store');
  });

  it('sends a full document when the validator does not match', async () => {
    const response = await getDocs(harness.docsOrigin, '/openapi.json', {
      'If-None-Match': 'W/"wirequill-999999"',
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain('"openapi"');
  });
});

describe('internal API', () => {
  it('reports health without anything identifying the machine', async () => {
    const response = await getDocs(harness.docsOrigin, HEALTH);
    const payload = JSON.parse(response.body) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.version).toBe('0.1.0');
    expect(payload.target).toBe(harness.backend.origin);
    expect(payload.docs).toBe(harness.docsOrigin);
    expect(typeof payload.revision).toBe('number');

    // Spec section 35: none of this may appear.
    expect(response.body).not.toContain(harness.projectDir);
    expect(response.body).not.toContain('.wirequill');
    expect(response.body).not.toContain(harness.runtime.workspace.id);
    expect(response.body).not.toContain(harness.runtime.session.id);
  });

  it('summarises the workspace', async () => {
    const summary = await getJson<Record<string, unknown>>(harness.docsOrigin, SUMMARY);

    expect(summary.status).toBe('watching');
    expect(summary.target).toBe(harness.backend.origin);
    expect(summary.proxyUrl).toBe(harness.proxyOrigin);
    expect(summary.docsUrl).toBe(harness.docsOrigin);
    expect(summary.operations).toBe(3);
    expect(summary.observations).toBeGreaterThanOrEqual(3);
    expect(typeof summary.lastObservedAt).toBe('string');
  });

  it('lists operations by path, then by canonical method', async () => {
    const { items } = await getJson<{ items: OperationItem[] }>(harness.docsOrigin, OPERATIONS);

    expect(items.map((item) => item.path)).toEqual([
      '/schema',
      '/schema/missing',
      '/users/{userId}',
    ]);
    expect(items.every((item) => item.method === 'GET')).toBe(true);

    const users = items.find((item) => item.path === '/users/{userId}');
    expect(users?.summary).toBe('Get User');
    expect(users?.observedCount).toBe(1);
  });

  it('serves one operation by id', async () => {
    const { items } = await getJson<{ items: OperationItem[] }>(harness.docsOrigin, OPERATIONS);
    const first = items[0];

    expect(first).toBeDefined();

    const detail = await getJson<Record<string, unknown>>(
      harness.docsOrigin,
      `${OPERATIONS}/${String(first?.id)}`,
    );

    expect(detail.path).toBe(first?.path);
    expect(typeof detail.firstSeenAt).toBe('string');
    expect(typeof detail.publicRevision).toBe('number');
  });

  it('answers an unknown operation id with 404 JSON', async () => {
    const response = await getDocs(harness.docsOrigin, `${OPERATIONS}/not-a-real-id`);

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('answers an unknown API route with 404 JSON, never the application shell', async () => {
    const response = await getDocs(harness.docsOrigin, '/__wirequill/api/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.body).not.toContain('<!doctype html>');
  });

  it('ignores unknown query parameters', async () => {
    const response = await getDocs(harness.docsOrigin, `${SUMMARY}?since=yesterday&x=1`);
    expect(response.status).toBe(200);
  });

  it('sets the same security headers on every response', async () => {
    for (const route of [HEALTH, SUMMARY, OPERATIONS, '/openapi.json', '/']) {
      const response = await getDocs(harness.docsOrigin, route);
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    }
  });
});

describe('static interface', () => {
  it('serves the application shell at the root', async () => {
    const response = await getDocs(harness.docsOrigin, '/');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.body).toContain('<div id="root"></div>');
  });

  it('serves hashed assets as immutable', async () => {
    const script = await getDocs(harness.docsOrigin, '/assets/index-ABC123.js');

    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const styles = await getDocs(harness.docsOrigin, '/assets/index-ABC123.css');
    expect(styles.headers['content-type']).toBe('text/css; charset=utf-8');
  });

  it('refuses to serve anything outside the asset root', async () => {
    writeFileSync(path.join(assetRoot, '..', 'wirequill-traversal.txt'), 'TRAVERSAL_MARKER');

    try {
      for (const attempt of [
        '/../wirequill-traversal.txt',
        '/%2e%2e/wirequill-traversal.txt',
        '/assets/../../wirequill-traversal.txt',
        '/..%5cwirequill-traversal.txt',
      ]) {
        const response = await getDocs(harness.docsOrigin, attempt);
        expect(response.status).toBe(404);
        expect(response.body).not.toContain('TRAVERSAL_MARKER');
      }
    } finally {
      rmSync(path.join(assetRoot, '..', 'wirequill-traversal.txt'), { force: true });
    }
  });

  it('answers a missing hashed asset with 404, never the shell', async () => {
    // A stale index.html asking for a bundle that a newer build renamed. The
    // shell would render and then fail in the browser, which is a worse
    // symptom than a 404 (spec section 114).
    const response = await getDocs(harness.docsOrigin, '/assets/index-DOESNOTEXIST.js');

    expect(response.status).toBe(404);
    expect(response.body).not.toContain('<div id="root"></div>');
  });

  it('survives Windows reserved device names', async () => {
    // `CON`, `NUL` and friends are devices, not files, on Windows. Opening one
    // by accident is a hang or a crash; a 404 is the whole requirement
    // (spec section 41).
    for (const name of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1', 'nul.txt', 'con']) {
      const response = await getDocs(harness.docsOrigin, `/${name}`);
      expect([404, 400], `/${name}`).toContain(response.status);
    }

    // Still alive.
    expect((await getDocs(harness.docsOrigin, '/')).status).toBe(200);
  });

  it('survives malformed percent-encoding', async () => {
    for (const attempt of ['/%', '/%2', '/%ZZ', '/%E0%A4%A', '/assets/%', '/%00']) {
      const response = await getDocs(harness.docsOrigin, attempt);
      expect([400, 404], attempt).toContain(response.status);
    }

    expect((await getDocs(harness.docsOrigin, '/')).status).toBe(200);
  });

  it('survives an absurdly long URL', async () => {
    // Node answers a request line over its own limit itself; either way the
    // process stays up and nothing is served (spec section 43).
    const long = `/${'a'.repeat(12 * 1024)}`;

    const status = await getDocs(harness.docsOrigin, long)
      .then((response) => response.status)
      // A connection reset by Node's own header limit is an acceptable answer.
      .catch(() => 431);

    expect([400, 404, 414, 431]).toContain(status);
    expect((await getDocs(harness.docsOrigin, '/')).status).toBe(200);
  });

  it('does not fall back to the shell for an unknown page', async () => {
    const response = await getDocs(harness.docsOrigin, '/docs/whatever');

    expect(response.status).toBe(404);
    expect(response.body).not.toContain('<div id="root"></div>');
  });

  it('rejects a method the interface never uses', async () => {
    const status = await sendDocsRequest(harness.docsOrigin, SUMMARY, 'POST');
    expect(status).toBe(405);
  });
});

describe('secret safety', () => {
  let secretHarness: DocsHarness;

  beforeAll(async () => {
    secretHarness = await startDocsHarness({ assetRoot });

    await secretHarness.call('/json', {
      method: 'POST',
      body: { email: 'docs@example.com', password: 'DOCS_UI_PASSWORD_SECRET' },
      headers: { Authorization: 'Bearer DOCS_UI_TOKEN_SECRET' },
    });

    await secretHarness.waitForOperations(1);
  });

  afterAll(async () => {
    await secretHarness.close();
  });

  it('exposes no secret and no local path through any docs route', async () => {
    const routes = [HEALTH, SUMMARY, OPERATIONS, '/openapi.json'];

    for (const route of routes) {
      const { body } = await getDocs(secretHarness.docsOrigin, route);

      for (const marker of [
        'DOCS_UI_PASSWORD_SECRET',
        'DOCS_UI_TOKEN_SECRET',
        'docs@example.com',
        secretHarness.projectDir,
        secretHarness.config.storage.databasePath,
        secretHarness.runtime.workspace.id,
      ]) {
        expect(body, `${route} must not contain ${marker}`).not.toContain(marker);
      }
    }
  });
});
