import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../helpers/raw-http.js';
import { startProxyHarness, type ProxyHarness } from '../helpers/proxy-harness.js';

/**
 * Release blocker RB3.
 *
 * A path is not a query string, so the redaction built in the previous phase
 * does not cover it — and password-reset links, signed URLs and email-keyed
 * lookups all put live secrets in the request target. Every place a path can
 * come to rest is checked here.
 */

const PATH_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJQQVRIX1NFQ1JFVF9NQVJLRVIifQ.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PATH_CREDENTIAL = 'inv1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p7Q8r9';
const PATH_EMAIL = 'dev%40example.com';

let harness: ProxyHarness;

afterEach(async () => {
  await harness.close();
});

function everythingWritten(target: ProxyHarness): string {
  target.storage?.close();

  const database = readFileSync(target.databasePath).toString('latin1');
  const terminal = [...target.stdout, ...target.stderr].join('\n');
  const observations = JSON.stringify(target.observations);
  const processed = JSON.stringify(target.processed);

  return [database, terminal, observations, processed].join('\n');
}

describe('sensitive path segments (RB3)', () => {
  it('keeps a reset token out of every place a path is recorded', async () => {
    harness = await startProxyHarness({ verbose: true });

    const response = await rawRequest(`${harness.proxyOrigin}/reset-password/${PATH_JWT}`);
    await harness.waitForObservations(1);

    // The backend still received the real path: WireQuill is not a filter.
    expect(response.status).toBe(404);
    expect(harness.backend.lastRequest()?.url).toContain(PATH_JWT);

    const everywhere = everythingWritten(harness);

    expect(everywhere).not.toContain(PATH_JWT);
    expect(everywhere).not.toContain('PATH_SECRET_MARKER');
    expect(everywhere).not.toContain('eyJhbGci');
  });

  it('documents the operation as a token parameter', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/reset-password/${PATH_JWT}`);
    await harness.waitForObservations(1);

    harness.storage?.close();
    const db = new DatabaseSync(harness.databasePath);
    const row = db.prepare('SELECT * FROM operations').get() as Record<string, unknown>;
    db.close();

    expect(row.path_template).toBe('/reset-password/{token}');
    expect(row.operation_id).toBe('getResetPasswordByToken');
    expect(String(row.path_parameters_json)).toContain('example-token');
    expect(String(row.path_parameters_json)).not.toContain('eyJhbGci');
  });

  it('keeps a credential-shaped segment out of everything', async () => {
    harness = await startProxyHarness({ verbose: true });

    await rawRequest(`${harness.proxyOrigin}/invite/${PATH_CREDENTIAL}`);
    await harness.waitForObservations(1);

    expect(everythingWritten(harness)).not.toContain(PATH_CREDENTIAL);
  });

  it('keeps an email address in the path out of everything', async () => {
    harness = await startProxyHarness({ verbose: true });

    // Deliberately a route the fixture does not echo. `/users/:id` reflects the
    // identifier back in its response body, and a value under an ordinary key
    // like `id` is documented as out of scope for redaction: WireQuill does not
    // scan free text for personal data. This test is about the path.
    await rawRequest(`${harness.proxyOrigin}/lookup/${PATH_EMAIL}`);
    await harness.waitForObservations(1);

    const everywhere = everythingWritten(harness);

    expect(everywhere).not.toContain('dev@example.com');
    expect(everywhere).not.toContain(PATH_EMAIL);
    expect(harness.observations.at(-1)?.pathSegments.at(-1)).toEqual({
      kind: 'email',
      sensitive: true,
    });
    expect(harness.processed.at(-1)?.displayPath).toBe('/lookup/{email}');
  });

  it('masks a sensitive segment when no operation could be resolved', async () => {
    harness = await startProxyHarness({ verbose: true });

    // A preflight is proxied but never documented, so there is no template to
    // print. The fallback is the safe path, which must still be safe.
    await rawRequest(`${harness.proxyOrigin}/reset-password/${PATH_JWT}`, {
      method: 'OPTIONS',
    });
    await harness.waitForObservations(1);

    const processed = harness.processed.at(-1);

    expect(processed?.isOperation).toBe(false);
    expect(processed?.displayPath).toBe('/reset-password/[REDACTED]');
    expect(everythingWritten(harness)).not.toContain(PATH_JWT);
  });

  it('does not redact a content-hashed asset filename', async () => {
    harness = await startProxyHarness();

    // A bundle name looks random on purpose. Treating it as a credential would
    // make every build output unreadable for no privacy gain.
    await rawRequest(`${harness.proxyOrigin}/assets/main.a3f9c2e1.js`);
    await harness.waitForObservations(1);

    expect(harness.processed.at(-1)?.displayPath).toBe('/assets/main.a3f9c2e1.js');
    expect(harness.processed.at(-1)?.isOperation).toBe(false);
  });

  it('leaves an ordinary path fully readable', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/users/123`);
    await harness.waitForObservations(1);

    const observation = harness.observations.at(-1);

    expect(observation?.safePath).toBe('/users/123');
    expect(observation?.pathSegments).toEqual([
      { kind: 'literal', value: 'users', sensitive: false },
      { kind: 'integer', value: '123', sensitive: false },
    ]);
  });

  it('exposes no raw path field on the sanitized observation at all', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/reset-password/${PATH_JWT}?token=QUERY_MARKER`);
    await harness.waitForObservations(1);

    const observation = harness.observations.at(-1);

    // There is deliberately no `pathname`: a field holding the original path
    // would be a permanent invitation to leak one.
    expect(observation).not.toHaveProperty('pathname');
    expect(observation).not.toHaveProperty('url');
    expect(JSON.stringify(observation)).not.toContain('QUERY_MARKER');
  });
});
