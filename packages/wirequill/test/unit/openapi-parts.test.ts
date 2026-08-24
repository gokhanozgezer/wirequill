import { describe, expect, it } from 'vitest';
import { emptySecurityEvidence } from '../../src/inference/operation/types.js';
import type {
  HeaderParameterEvidence,
  PathParameterEvidence,
  QueryParameterEvidence,
} from '../../src/inference/operation/types.js';
import { canonicalizeExample } from '../../src/examples/canonicalize-example.js';
import {
  bucketKey,
  isFirstInBucket,
  selectPublicExamples,
} from '../../src/examples/example-service.js';
import { MAX_EXAMPLE_BYTES } from '../../src/examples/types.js';
import {
  buildHeaderParameters,
  buildPathParameters,
  buildQueryParameters,
  canonicalHeaderName,
} from '../../src/openapi/build-parameters.js';
import { buildSecurity } from '../../src/openapi/build-security.js';
import { buildSummary } from '../../src/openapi/summaries.js';
import { buildTags } from '../../src/openapi/tags.js';
import { compareStatusCodes, describeStatus } from '../../src/openapi/status-descriptions.js';
import { friendlyPackageName } from '../../src/openapi/build-document.js';
import type { SanitizedBodySummary } from '../../src/processing/sanitized-observation.js';
import type { StoredExample } from '../../src/storage/types.js';

describe('summaries', () => {
  it.each([
    ['GET', '/users', 'List Users'],
    ['GET', '/users/{userId}', 'Get User'],
    ['POST', '/users', 'Create User'],
    ['PUT', '/users/{userId}', 'Update User'],
    ['PATCH', '/users/{userId}', 'Update User'],
    ['DELETE', '/users/{userId}', 'Delete User'],
    ['GET', '/carts/{cartId}/items', 'List Items'],
    ['POST', '/carts/{cartId}/items', 'Create Item'],
    ['GET', '/carts/{cartId}/items/{itemId}', 'Get Item'],
    ['GET', '/api/v1/users/{userId}', 'Get User'],
    ['GET', '/categories', 'List Categories'],
    ['POST', '/categories', 'Create Category'],
  ])('%s %s becomes %j', (method, path, expected) => {
    expect(buildSummary(method, path)).toBe(expected);
  });

  it.each([
    ['POST', '/auth/login', 'Login'],
    ['POST', '/auth/logout', 'Logout'],
    ['GET', '/health', 'Health'],
    ['GET', '/products/search', 'Search'],
    ['POST', '/users/{userId}/activate', 'Activate User'],
    ['POST', '/orders/{orderId}/cancel', 'Cancel Order'],
    ['POST', '/orders/{orderId}/archive', 'Archive Order'],
  ])('%s %s becomes %j', (method, path, expected) => {
    expect(buildSummary(method, path)).toBe(expected);
  });

  it('falls back to method and path when the route says nothing', () => {
    // No resource to name and no known action: better to restate the route than
    // to guess at what it does.
    expect(buildSummary('GET', '/')).toBe('GET /');
    expect(buildSummary('TRACE', '/users')).toBe('TRACE /users');
  });

  it('is stable across calls', () => {
    expect(buildSummary('GET', '/users/{userId}')).toBe(buildSummary('GET', '/users/{userId}'));
  });
});

describe('tags', () => {
  it.each([
    ['/api/v1/users/{userId}', ['Users']],
    ['/carts/{cartId}/items', ['Carts']],
    ['/auth/login', ['Auth']],
    ['/products', ['Products']],
    ['/api/v2/internal/orders', ['Orders']],
    ['/user-profiles/{id}', ['User Profiles']],
  ])('tags %j as %j', (path, expected) => {
    expect(buildTags(path)).toEqual(expected);
  });

  it('leaves an untaggable path untagged rather than mislabelled', () => {
    expect(buildTags('/')).toEqual([]);
    expect(buildTags('/{id}')).toEqual([]);
    expect(buildTags('/api/v1')).toEqual([]);
  });
});

describe('path parameters', () => {
  function pathEvidence(
    name: string,
    kind: keyof PathParameterEvidence['kinds'],
    syntheticExample: string,
  ): PathParameterEvidence {
    return {
      name,
      position: 1,
      observedCount: 1,
      kinds: { [kind]: 1 },
      syntheticExample,
    };
  }

  it.each([
    ['integer', { type: 'integer' }, '123'],
    ['uuid', { type: 'string', format: 'uuid' }, '550e8400-e29b-41d4-a716-446655440000'],
    ['date', { type: 'string', format: 'date' }, '2026-01-15'],
    ['email', { type: 'string', format: 'email' }, 'user@example.com'],
    ['token', { type: 'string' }, 'example-token'],
  ])('materialises a %s parameter', (kind, schema, example) => {
    const [parameter] = buildPathParameters([
      pathEvidence('id', kind as keyof PathParameterEvidence['kinds'], example),
    ]);

    expect(parameter).toEqual({
      name: 'id',
      in: 'path',
      required: true,
      schema,
      example,
    });
  });

  it.each(['objectId', 'ulid'])('does not invent a format for %s', (kind) => {
    const [parameter] = buildPathParameters([
      pathEvidence('id', kind as keyof PathParameterEvidence['kinds'], 'x'),
    ]);

    // `format: objectid` is not a registered format; tooling would not know it.
    expect(parameter?.schema).toEqual({ type: 'string' });
  });

  it('keeps path order', () => {
    const parameters = buildPathParameters([
      {
        name: 'itemId',
        position: 3,
        observedCount: 1,
        kinds: { integer: 1 },
        syntheticExample: '123',
      },
      {
        name: 'cartId',
        position: 1,
        observedCount: 1,
        kinds: { integer: 1 },
        syntheticExample: '123',
      },
    ]);

    expect(parameters.map((parameter) => parameter.name)).toEqual(['cartId', 'itemId']);
  });
});

describe('query parameters', () => {
  function queryEvidence(overrides: Partial<QueryParameterEvidence>): QueryParameterEvidence {
    return {
      name: 'page',
      operationSamples: 1,
      presentCount: 1,
      repeatedCount: 0,
      typeCounts: {},
      formatCounts: {},
      sensitive: false,
      ...overrides,
    };
  }

  it.each([
    [{ integer: 1 }, { type: 'integer' }],
    [{ number: 1 }, { type: 'number' }],
    [{ boolean: 1 }, { type: 'boolean' }],
    [{ string: 1 }, { type: 'string' }],
    [{ integer: 1, number: 1 }, { type: 'number' }],
  ])('types %j as %j', (typeCounts, schema) => {
    const [parameter] = buildQueryParameters([queryEvidence({ typeCounts })], 3);
    expect(parameter?.schema).toEqual(schema);
  });

  it('materialises a repeated parameter as an array', () => {
    const [parameter] = buildQueryParameters(
      [queryEvidence({ name: 'tag', typeCounts: { array: 1, string: 2 } })],
      3,
    );

    expect(parameter?.schema).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('unions genuinely mixed types rather than picking one', () => {
    const [parameter] = buildQueryParameters(
      [queryEvidence({ typeCounts: { integer: 2, string: 1 } })],
      3,
    );

    expect(parameter?.schema).toEqual({
      oneOf: [{ type: 'integer' }, { type: 'string' }],
    });
  });

  it('claims a format only when every value carried it', () => {
    const withFormat = buildQueryParameters(
      [queryEvidence({ typeCounts: { string: 2 }, formatCounts: { uuid: 2 } })],
      3,
    );
    expect(withFormat[0]?.schema).toEqual({ type: 'string', format: 'uuid' });

    const mixed = buildQueryParameters(
      [queryEvidence({ typeCounts: { string: 3 }, formatCounts: { uuid: 2 } })],
      3,
    );
    expect(mixed[0]?.schema).toEqual({ type: 'string' });
  });

  it('documents a redacted parameter as a plain string with no example', () => {
    const [parameter] = buildQueryParameters(
      [queryEvidence({ name: 'token', sensitive: true, typeCounts: { string: 3 } })],
      3,
    );

    expect(parameter?.schema).toEqual({ type: 'string' });
    expect(parameter?.example).toBeUndefined();
  });

  it('marks a parameter required only after enough samples', () => {
    const two = buildQueryParameters(
      [queryEvidence({ operationSamples: 2, presentCount: 2, typeCounts: { integer: 2 } })],
      3,
    );
    expect(two[0]?.required).toBeUndefined();

    const three = buildQueryParameters(
      [queryEvidence({ operationSamples: 3, presentCount: 3, typeCounts: { integer: 3 } })],
      3,
    );
    expect(three[0]?.required).toBe(true);

    const missed = buildQueryParameters(
      [queryEvidence({ operationSamples: 4, presentCount: 3, typeCounts: { integer: 3 } })],
      3,
    );
    expect(missed[0]?.required).toBeUndefined();
  });

  it('never emits an example for a query parameter', () => {
    const [parameter] = buildQueryParameters([queryEvidence({ typeCounts: { integer: 3 } })], 3);

    // Real values were never persisted, and a synthetic one would be
    // indistinguishable from an observed one to a reader.
    expect(parameter?.example).toBeUndefined();
  });

  it('sorts alphabetically', () => {
    const parameters = buildQueryParameters(
      [queryEvidence({ name: 'zebra' }), queryEvidence({ name: 'alpha' })],
      3,
    );

    expect(parameters.map((parameter) => parameter.name)).toEqual(['alpha', 'zebra']);
  });
});

describe('header parameters', () => {
  function headerEvidence(overrides: Partial<HeaderParameterEvidence>): HeaderParameterEvidence {
    return {
      name: 'x-tenant-id',
      displayName: 'X-Tenant-Id',
      operationSamples: 1,
      presentCount: 1,
      ...overrides,
    };
  }

  it('materialises a custom header as a string', () => {
    const [parameter] = buildHeaderParameters([headerEvidence({})], 3);

    expect(parameter).toEqual({
      name: 'X-Tenant-Id',
      in: 'header',
      schema: { type: 'string' },
    });
  });

  it.each([
    ['x-tenant-id', 'X-Tenant-Id'],
    ['x-api-version', 'X-Api-Version'],
    ['content-type', 'Content-Type'],
  ])('canonicalises %j to %j', (input, expected) => {
    expect(canonicalHeaderName(input)).toBe(expected);
  });

  it('marks a header required only after enough samples', () => {
    const [parameter] = buildHeaderParameters(
      [headerEvidence({ operationSamples: 3, presentCount: 3 })],
      3,
    );

    expect(parameter?.required).toBe(true);
  });
});

describe('security', () => {
  it('describes a bearer scheme without any credential', () => {
    const { schemes } = buildSecurity({ ...emptySecurityEvidence(), bearer: 3 }, 3);

    expect(schemes).toEqual({ bearerAuth: { type: 'http', scheme: 'bearer' } });
  });

  it('describes a basic scheme', () => {
    const { schemes, requirement } = buildSecurity({ ...emptySecurityEvidence(), basic: 3 }, 3);

    expect(schemes).toEqual({ basicAuth: { type: 'http', scheme: 'basic' } });
    expect(requirement).toEqual([{ basicAuth: [] }]);
  });

  it('describes an API key header', () => {
    const evidence = {
      ...emptySecurityEvidence(),
      apiKeys: { 'x-api-key': { location: 'header' as const, count: 3 } },
    };

    const { schemes, requirement } = buildSecurity(evidence, 3);

    expect(schemes).toEqual({
      'apiKey_header_x-api-key': { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
    });
    expect(requirement).toEqual([{ 'apiKey_header_x-api-key': [] }]);
  });

  it('sanitises a scheme name so it is a valid component key', () => {
    const evidence = {
      ...emptySecurityEvidence(),
      apiKeys: { 'weird key!': { location: 'query' as const, count: 3 } },
    };

    const { schemes } = buildSecurity(evidence, 3);

    // OpenAPI restricts component keys to [A-Za-z0-9._-].
    expect(Object.keys(schemes)).toEqual(['apiKey_query_weird_key_']);
    expect(Object.keys(schemes)[0]).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('claims a requirement only when one mechanism covered every sample', () => {
    expect(buildSecurity({ ...emptySecurityEvidence(), bearer: 3 }, 3).requirement).toEqual([
      { bearerAuth: [] },
    ]);

    // Too few samples to conclude anything.
    expect(buildSecurity({ ...emptySecurityEvidence(), bearer: 2 }, 2).requirement).toBeUndefined();

    // One anonymous call proves the endpoint is reachable without a token.
    expect(
      buildSecurity({ ...emptySecurityEvidence(), bearer: 3, unauthenticated: 1 }, 4).requirement,
    ).toBeUndefined();

    // Two mechanisms: whether they were required together or interchangeably
    // is not visible from traffic.
    expect(
      buildSecurity({ ...emptySecurityEvidence(), bearer: 3, basic: 3 }, 3).requirement,
    ).toBeUndefined();
  });

  it('still describes schemes even when no requirement is claimed', () => {
    const { schemes, requirement } = buildSecurity(
      { ...emptySecurityEvidence(), bearer: 1, unauthenticated: 5 },
      6,
    );

    expect(schemes).toEqual({ bearerAuth: { type: 'http', scheme: 'bearer' } });
    expect(requirement).toBeUndefined();
  });
});

describe('status descriptions', () => {
  it.each([
    ['200', 'Successful response'],
    ['201', 'Resource created'],
    ['204', 'No content'],
    ['400', 'Bad request'],
    ['404', 'Not found'],
    ['422', 'Validation error'],
    ['500', 'Internal server error'],
    ['502', 'Bad gateway'],
  ])('describes %s', (status, expected) => {
    expect(describeStatus(status)).toBe(expected);
  });

  it('describes an unknown status without inventing meaning', () => {
    expect(describeStatus('418')).toBe('Observed 418 response');
  });

  it('sorts numerically with non-numeric keys last', () => {
    const sorted = ['default', '500', '200', '404', '201'].sort(compareStatusCodes);
    expect(sorted).toEqual(['200', '201', '404', '500', 'default']);
  });
});

describe('package names', () => {
  it.each([
    ['@acme/backend-api', 'Acme Backend API'],
    ['acme-api', 'Acme API'],
    ['my_service', 'My Service API'],
    ['@scope/thing', 'Scope Thing API'],
  ])('formats %j as %j', (input, expected) => {
    expect(friendlyPackageName(input)).toBe(expected);
  });

  it('returns null when there is no name', () => {
    expect(friendlyPackageName(null)).toBeNull();
    expect(friendlyPackageName('  ')).toBeNull();
  });
});

describe('examples', () => {
  function body(overrides: Partial<SanitizedBodySummary> = {}): SanitizedBodySummary {
    return {
      parsed: { kind: 'json', mediaType: 'application/json', value: undefined },
      redacted: { email: '[REDACTED]', id: 42 },
      schemaEvidence: null,
      totalBytes: 40,
      capturedBytes: 40,
      truncated: false,
      budgetExceeded: false,
      mediaType: 'application/json',
      parseStatus: 'json',
      ...overrides,
    };
  }

  it('canonicalises a redacted body', () => {
    const candidate = canonicalizeExample(body(), 'request', null);

    expect(candidate?.mediaType).toBe('application/json');
    expect(candidate?.statusCode).toBeNull();
    expect(candidate?.bodyJson).toBe('{"email":"[REDACTED]","id":42}');
    expect(candidate?.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same hash for the same body written differently', () => {
    const first = canonicalizeExample(body({ redacted: { a: 1, b: 2 } }), 'request', null);
    const second = canonicalizeExample(body({ redacted: { b: 2, a: 1 } }), 'request', null);

    expect(second?.bodyHash).toBe(first?.bodyHash);
  });

  it.each([
    ['truncated', { truncated: true }],
    ['over budget', { budgetExceeded: true }],
    ['malformed', { parseStatus: 'invalid_json' }],
    ['binary', { parseStatus: 'unsupported_binary' }],
    ['without a media type', { mediaType: undefined }],
  ])('refuses a %s body', (_label, overrides) => {
    expect(canonicalizeExample(body(overrides), 'request', null)).toBeNull();
  });

  it('refuses a body that serialises past the size limit', () => {
    const huge = { blob: 'x'.repeat(MAX_EXAMPLE_BYTES + 1) };

    expect(canonicalizeExample(body({ redacted: huge }), 'request', null)).toBeNull();
  });

  it('separates buckets by direction, status and media type', () => {
    const keys = new Set([
      bucketKey({ direction: 'request', statusCode: null, mediaType: 'application/json' }),
      bucketKey({ direction: 'response', statusCode: 200, mediaType: 'application/json' }),
      bucketKey({ direction: 'response', statusCode: 404, mediaType: 'application/json' }),
      bucketKey({ direction: 'response', statusCode: 200, mediaType: 'application/problem+json' }),
    ]);

    expect(keys.size).toBe(4);
  });

  it('picks the first example per bucket, deterministically', () => {
    const examples: StoredExample[] = [
      stored('b', '2026-08-23T10:00:01.000Z', 200),
      stored('a', '2026-08-23T10:00:00.000Z', 200),
      stored('c', '2026-08-23T10:00:00.000Z', 404),
    ];

    const chosen = selectPublicExamples(examples);

    expect(chosen.get('response 200 application/json')?.id).toBe('a');
    expect(chosen.get('response 404 application/json')?.id).toBe('c');
  });

  it('breaks a timestamp tie on id', () => {
    const examples: StoredExample[] = [
      stored('zebra', '2026-08-23T10:00:00.000Z', 200),
      stored('alpha', '2026-08-23T10:00:00.000Z', 200),
    ];

    expect(selectPublicExamples(examples).get('response 200 application/json')?.id).toBe('alpha');
  });

  it('knows whether a candidate would be the first in its bucket', () => {
    const candidate = canonicalizeExample(body(), 'response', 200);
    expect(candidate).not.toBeNull();

    expect(isFirstInBucket(candidate!, [])).toBe(true);
    expect(isFirstInBucket(candidate!, [stored('x', '2026-08-23T10:00:00.000Z', 200)])).toBe(false);
    expect(isFirstInBucket(candidate!, [stored('x', '2026-08-23T10:00:00.000Z', 404)])).toBe(true);
  });
});

function stored(id: string, observedAt: string, statusCode: number): StoredExample {
  return {
    id,
    operationId: 'op',
    direction: 'response',
    statusCode,
    mediaType: 'application/json',
    bodyJson: '{}',
    bodyHash: `hash-${id}`,
    observedAt,
  };
}
