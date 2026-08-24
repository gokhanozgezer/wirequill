import { describe, expect, it } from 'vitest';
import {
  isRequired,
  REQUIRED_AFTER_SAMPLES,
  emptySecurityEvidence,
} from '../../src/inference/operation/types.js';
import {
  isApiKeyHeader,
  isApiKeyQueryName,
  isCredentialHeader,
  isHeaderParameterCandidate,
} from '../../src/inference/parameters/infer-headers.js';
import {
  inferQueryFormat,
  inferQueryType,
  isRedactedValue,
} from '../../src/inference/parameters/infer-query.js';
import {
  extractSecurityHints,
  mergeSecurityEvidence,
} from '../../src/inference/security/infer-security.js';

describe('query value typing', () => {
  it.each([
    ['true', 'boolean'],
    ['false', 'boolean'],
    ['2', 'integer'],
    ['0', 'integer'],
    ['-10', 'integer'],
    ['4.2', 'number'],
    ['-4.2', 'number'],
    ['0.5', 'number'],
  ])('types %j as %s', (value, expected) => {
    expect(inferQueryType(value)).toBe(expected);
  });

  it.each([
    // A postal code is not the number 123.
    '00123',
    '007',
    '1e3',
    'NaN',
    'Infinity',
    '1.',
    '.5',
    '+5',
    'yes',
    '',
    'true ',
  ])('leaves %j a string', (value) => {
    expect(inferQueryType(value)).toBe('string');
  });

  it('treats negative zero as the integer it means', () => {
    // JSON would render it as `0`, but a query parameter carrying `-0` is an
    // integer parameter, and documenting it as a string would be misleading.
    expect(inferQueryType('-0')).toBe('integer');
  });

  it.each([
    ['550e8400-e29b-41d4-a716-446655440000', 'uuid'],
    ['2026-08-23', 'date'],
    ['2026-08-23T10:00:00Z', 'dateTime'],
    ['2026-08-23t10:00:00+03:00', 'dateTime'],
  ])('detects the %j format as %s', (value, expected) => {
    expect(inferQueryFormat(value)).toBe(expected);
  });

  it.each(['hello', '42', 'not-a-uuid'])('finds no format in %j', (value) => {
    expect(inferQueryFormat(value)).toBeNull();
  });

  it('recognises a redacted value as carrying no shape', () => {
    expect(isRedactedValue('[REDACTED]')).toBe(true);
    expect(isRedactedValue('redacted')).toBe(false);
  });
});

describe('requiredness', () => {
  it('needs three samples before claiming anything', () => {
    expect(REQUIRED_AFTER_SAMPLES).toBe(3);
    expect(isRequired(1, 1)).toBe(false);
    expect(isRequired(2, 2)).toBe(false);
    expect(isRequired(3, 3)).toBe(true);
  });

  it('demotes a parameter as soon as one request omits it', () => {
    expect(isRequired(4, 3)).toBe(false);
    expect(isRequired(10, 9)).toBe(false);
  });
});

describe('header candidates', () => {
  it.each([
    'host',
    'connection',
    'content-length',
    'content-type',
    'accept',
    'accept-encoding',
    'accept-language',
    'user-agent',
    'origin',
    'referer',
    'cache-control',
    'pragma',
    'traceparent',
    'tracestate',
    'baggage',
    'x-request-id',
    'x-correlation-id',
    'sec-fetch-mode',
    'sec-ch-ua',
    'x-forwarded-for',
  ])('does not document %j', (name) => {
    expect(isHeaderParameterCandidate(name)).toBe(false);
  });

  it.each(['x-tenant-id', 'x-api-version', 'x-workspace-id', 'x-feature', 'X-Tenant-Id'])(
    'documents %j',
    (name) => {
      expect(isHeaderParameterCandidate(name)).toBe(true);
    },
  );

  it.each(['authorization', 'cookie', 'x-api-key', 'proxy-authorization'])(
    'routes %j to security evidence instead',
    (name) => {
      expect(isCredentialHeader(name)).toBe(true);
      expect(isHeaderParameterCandidate(name)).toBe(false);
    },
  );

  it.each(['x-api-key', 'api-key', 'apikey'])('recognises %j as an API key header', (name) => {
    expect(isApiKeyHeader(name)).toBe(true);
  });

  it.each(['api_key', 'apikey', 'access_key'])(
    'recognises %j as an API key query parameter',
    (name) => {
      expect(isApiKeyQueryName(name)).toBe(true);
    },
  );
});

describe('security hints', () => {
  const noQuery = new URLSearchParams();

  it('records the bearer scheme without the token', () => {
    const hints = extractSecurityHints(
      { authorization: 'Bearer SUPER_SECRET_TOKEN_VALUE' },
      noQuery,
    );

    expect(hints.authorization).toEqual({ scheme: 'bearer' });
    expect(JSON.stringify(hints)).not.toContain('SUPER_SECRET_TOKEN_VALUE');
  });

  it('records the basic scheme without the credentials', () => {
    const hints = extractSecurityHints({ authorization: 'Basic dXNlcjpwYXNz' }, noQuery);

    expect(hints.authorization).toEqual({ scheme: 'basic' });
    expect(JSON.stringify(hints)).not.toContain('dXNlcjpwYXNz');
  });

  it('falls back to other for an unrecognised scheme', () => {
    expect(extractSecurityHints({ authorization: 'Negotiate abc' }, noQuery).authorization).toEqual(
      { scheme: 'other' },
    );
  });

  it('ignores an empty authorization header', () => {
    expect(extractSecurityHints({ authorization: '   ' }, noQuery).authorization).toBeUndefined();
  });

  it('records API key presence by name only', () => {
    const hints = extractSecurityHints(
      { 'x-api-key': 'REAL_KEY_VALUE', 'x-tenant-id': 'acme' },
      new URLSearchParams('api_key=ANOTHER_REAL_KEY&page=2'),
    );

    expect(hints.apiKeyHeaders).toEqual(['x-api-key']);
    expect(hints.apiKeyQueryParameters).toEqual(['api_key']);
    expect(JSON.stringify(hints)).not.toContain('REAL_KEY_VALUE');
    expect(JSON.stringify(hints)).not.toContain('ANOTHER_REAL_KEY');
  });

  it('produces a deterministic order', () => {
    const hints = extractSecurityHints({ 'x-api-key': 'a', apikey: 'b', 'api-key': 'c' }, noQuery);

    expect(hints.apiKeyHeaders).toEqual(['api-key', 'apikey', 'x-api-key']);
  });
});

describe('security evidence merge', () => {
  it('counts each scheme', () => {
    let evidence = emptySecurityEvidence();

    evidence = mergeSecurityEvidence(evidence, {
      authorization: { scheme: 'bearer' },
      apiKeyHeaders: [],
      apiKeyQueryParameters: [],
    });
    evidence = mergeSecurityEvidence(evidence, {
      authorization: { scheme: 'bearer' },
      apiKeyHeaders: [],
      apiKeyQueryParameters: [],
    });
    evidence = mergeSecurityEvidence(evidence, {
      authorization: { scheme: 'basic' },
      apiKeyHeaders: [],
      apiKeyQueryParameters: [],
    });

    expect(evidence.bearer).toBe(2);
    expect(evidence.basic).toBe(1);
    expect(evidence.unauthenticated).toBe(0);
  });

  it('counts an anonymous request', () => {
    const evidence = mergeSecurityEvidence(emptySecurityEvidence(), {
      apiKeyHeaders: [],
      apiKeyQueryParameters: [],
    });

    expect(evidence.unauthenticated).toBe(1);
    expect(evidence.bearer).toBe(0);
  });

  it('counts API keys by name and location', () => {
    let evidence = emptySecurityEvidence();

    evidence = mergeSecurityEvidence(evidence, {
      apiKeyHeaders: ['x-api-key'],
      apiKeyQueryParameters: ['api_key'],
    });
    evidence = mergeSecurityEvidence(evidence, {
      apiKeyHeaders: ['x-api-key'],
      apiKeyQueryParameters: [],
    });

    expect(evidence.apiKeys['x-api-key']).toEqual({ location: 'header', count: 2 });
    expect(evidence.apiKeys.api_key).toEqual({ location: 'query', count: 1 });
    // An API key is authentication, so these were not anonymous requests.
    expect(evidence.unauthenticated).toBe(0);
  });

  it('does not mutate the evidence it was given', () => {
    const original = emptySecurityEvidence();

    mergeSecurityEvidence(original, {
      authorization: { scheme: 'bearer' },
      apiKeyHeaders: ['x-api-key'],
      apiKeyQueryParameters: [],
    });

    expect(original.bearer).toBe(0);
    expect(original.apiKeys).toEqual({});
  });
});
