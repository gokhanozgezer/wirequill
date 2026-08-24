import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/redaction/redact.js';
import { rawRequest } from '../helpers/raw-http.js';
import { startProxyHarness, type ProxyHarness } from '../helpers/proxy-harness.js';

/**
 * Release blockers RB6, RB7 and RB8.
 *
 * The distinction this file exists to prove: WireQuill forwards traffic
 * verbatim — the backend must receive every secret exactly as the client sent
 * it — while its own observation of that traffic carries none of them.
 */

/** Distinctive markers, so a leak anywhere is unambiguous. */
const SECRETS = {
  bodyPassword: 'ULTRA_SECRET_123',
  bodyToken: 'TOKEN_SECRET_456',
  header: 'HEADER_SECRET_789',
  cookie: 'COOKIE_SECRET_ABC',
  query: 'QUERY_SECRET_XYZ',
} as const;

const ALL_SECRETS = Object.values(SECRETS);

let harness: ProxyHarness;

afterEach(async () => {
  await harness.close();
});

async function sendSecretTraffic(): Promise<void> {
  const body = Buffer.from(
    JSON.stringify({
      email: 'dev@example.com',
      password: SECRETS.bodyPassword,
      access_token: SECRETS.bodyToken,
      nested: { credentials: { password: SECRETS.bodyPassword } },
      users: [{ email: 'a@example.com', access_token: SECRETS.bodyToken }],
      keep: 'visible-value',
    }),
    'utf8',
  );

  await rawRequest(`${harness.proxyOrigin}/headers?token=${SECRETS.query}&page=2`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SECRETS.header}`,
      Cookie: `session=${SECRETS.cookie}`,
    },
    body,
  });

  await harness.waitForObservations(1);
}

describe('forwarding stays verbatim while observation is redacted', () => {
  it('gives the backend every secret exactly as sent', async () => {
    harness = await startProxyHarness();
    await sendSecretTraffic();

    const received = harness.backend.lastRequest();

    // The proxy is not a filter. Redacting forwarded traffic would break the
    // application it sits in front of.
    expect(received?.headers.authorization).toBe(`Bearer ${SECRETS.header}`);
    expect(received?.headers.cookie).toBe(`session=${SECRETS.cookie}`);
    expect(received?.url).toContain(SECRETS.query);
  });

  it('keeps no secret in the sanitized observation (RB8)', async () => {
    harness = await startProxyHarness();
    await sendSecretTraffic();

    const observation = harness.observations.at(-1);
    const serialized = JSON.stringify(observation);

    for (const secret of ALL_SECRETS) {
      expect(serialized).not.toContain(secret);
    }

    expect(observation?.request.headers.authorization).toBe(REDACTED);
    expect(observation?.request.headers.cookie).toBe(REDACTED);
    expect(observation?.request.query.token).toBe(REDACTED);
    expect(observation?.request.query.page).toBe('2');
  });

  it('redacts nested and array payload fields', async () => {
    harness = await startProxyHarness();
    await sendSecretTraffic();

    const redacted = harness.observations.at(-1)?.request.body.redacted as Record<string, unknown>;

    expect(redacted.password).toBe(REDACTED);
    expect(redacted.access_token).toBe(REDACTED);
    expect(redacted.email).toBe(REDACTED);
    expect(redacted.keep).toBe('visible-value');
    expect(redacted.nested).toEqual({ credentials: { password: REDACTED } });
    expect(redacted.users).toEqual([{ email: REDACTED, access_token: REDACTED }]);
  });

  it('never keeps the parsed body alongside the redacted one', async () => {
    harness = await startProxyHarness();
    await sendSecretTraffic();

    const body = harness.observations.at(-1)?.request.body;

    // The parse outcome is recorded; the raw parsed value is not.
    expect(body?.parseStatus).toBe('json');
    expect(body?.parsed).toEqual({ kind: 'json', mediaType: 'application/json' });
  });

  it('redacts a secret carried in a response header (RB8)', async () => {
    harness = await startProxyHarness();

    const response = await rawRequest(`${harness.proxyOrigin}/json-secret`);
    await harness.waitForObservations(1);

    // The client still receives the real header.
    expect(response.headers['set-cookie']).toEqual(['session=SECRET_COOKIE_RESPONSE; Path=/']);
    expect(response.body.toString('utf8')).toContain('RESPONSE_SECRET_PASSWORD');

    const observation = harness.observations.at(-1);
    expect(observation?.response.headers['set-cookie']).toEqual([REDACTED]);
    expect(observation?.response.headers['x-auth-token']).toBe(REDACTED);
    expect(JSON.stringify(observation)).not.toContain('SECRET_COOKIE_RESPONSE');
    expect(JSON.stringify(observation)).not.toContain('RESPONSE_SECRET_PASSWORD');
    expect(JSON.stringify(observation)).not.toContain('RESPONSE_SECRET_TOKEN');
  });

  it('keeps no secret in the terminal output (RB7)', async () => {
    harness = await startProxyHarness({ verbose: true });
    await sendSecretTraffic();

    const printed = [...harness.stdout, ...harness.stderr].join('\n');

    for (const secret of ALL_SECRETS) {
      expect(printed).not.toContain(secret);
    }
  });

  it('keeps the query string out of the traffic log entirely', async () => {
    harness = await startProxyHarness();

    await rawRequest(`${harness.proxyOrigin}/hello?token=TOP_SECRET_QUERY`);
    await harness.waitForObservations(1);

    expect(harness.completed.at(-1)?.path).toBe('/hello');
    expect(JSON.stringify(harness.completed)).not.toContain('TOP_SECRET_QUERY');
  });

  it('keeps no secret on disk (RB6)', async () => {
    harness = await startProxyHarness();
    await sendSecretTraffic();

    // Closing checkpoints the write-ahead log into the main file, so a single
    // read covers everything that was actually persisted.
    harness.storage?.close();

    const contents = readFileSync(harness.databasePath).toString('latin1');

    expect(contents.length).toBeGreaterThan(0);
    for (const secret of ALL_SECRETS) {
      expect(contents).not.toContain(secret);
    }

    // The row really is there; the test is not passing because nothing was written.
    expect(contents).toContain('observations');
  });
});

describe('captured structure survives redaction', () => {
  it('still describes the request accurately', async () => {
    harness = await startProxyHarness();
    await sendSecretTraffic();

    const received = harness.backend.lastRequest();
    const observation = harness.observations.at(-1);

    expect(received?.bodyBytes).toBeGreaterThan(0);
    expect(observation?.method).toBe('POST');
    expect(observation?.safePath).toBe('/headers');
    expect(observation?.request.body.totalBytes).toBe(received?.bodyBytes);
    expect(observation?.response.statusCode).toBe(200);
    expect(observation?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
