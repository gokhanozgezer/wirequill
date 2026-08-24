import { describe, expect, it } from 'vitest';
import { createRedactor, redactValue, REDACTED, TOO_DEEP } from '../../src/redaction/redact.js';
import { isSensitiveFieldName, normalizeFieldName } from '../../src/redaction/sensitive-names.js';
import {
  looksLikeAuthorizationValue,
  looksLikeCredential,
  looksLikeJwt,
  looksLikePrivateKey,
  looksLikeSensitivePair,
} from '../../src/redaction/value-patterns.js';

const NO_EXTRA = new Set<string>();

function redactor(overrides: Partial<Parameters<typeof createRedactor>[0]> = {}) {
  return createRedactor({ fields: [], headers: [], query: [], ...overrides });
}

describe('normalizeFieldName', () => {
  it.each([
    ['accessToken', 'access_token'],
    ['access_token', 'access_token'],
    ['access-token', 'access_token'],
    ['AccessToken', 'access_token'],
    ['ACCESS_TOKEN', 'access_token'],
    ['X-API-Key', 'x_api_key'],
    ['apiKey', 'api_key'],
    ['user.email', 'user_email'],
    ['  spaced  name ', 'spaced_name'],
  ])('folds %j to %j', (input, expected) => {
    expect(normalizeFieldName(input)).toBe(expected);
  });
});

describe('isSensitiveFieldName', () => {
  it.each([
    'password',
    'passwd',
    'pwd',
    'secret',
    'client_secret',
    'private_key',
    'access_token',
    'refresh_token',
    'id_token',
    'token',
    'api_key',
    'apiKey',
    'API-KEY',
    'authorization',
    'cookie',
    'session',
    'session_id',
    'card_number',
    'credit_card',
    'cvv',
    'cvc',
    'email',
    'email_address',
    'user_email',
    'accessToken',
    'userPassword',
    'billing_email',
    'csrf_token',
  ])('treats %j as sensitive', (name) => {
    expect(isSensitiveFieldName(name, NO_EXTRA)).toBe(true);
  });

  // These are the reason matching is not a substring search.
  it.each([
    'monkey',
    'tokenizer',
    'passwordPolicy',
    'password_policy',
    'public_key',
    'publicKey',
    'keyboard',
    'secretary',
    'id',
    'user_id',
    'email_verified',
    'name',
    'description',
    'tokens_remaining',
    'sessionless',
  ])('leaves %j alone', (name) => {
    expect(isSensitiveFieldName(name, NO_EXTRA)).toBe(false);
  });

  it('honours configured extra field names', () => {
    expect(isSensitiveFieldName('internalRef', new Set(['internal_ref']))).toBe(true);
  });
});

describe('redactValue', () => {
  it('replaces a sensitive field', () => {
    expect(redactValue({ password: 'secret' }, NO_EXTRA)).toEqual({ password: REDACTED });
  });

  it('keeps the rest of the object intact', () => {
    expect(redactValue({ id: 42, name: 'Ada', password: 'secret' }, NO_EXTRA)).toEqual({
      id: 42,
      name: 'Ada',
      password: REDACTED,
    });
  });

  it('redacts nested fields', () => {
    const input = { user: { credentials: { password: 'secret', username: 'ada' } } };

    expect(redactValue(input, NO_EXTRA)).toEqual({
      user: { credentials: { password: REDACTED, username: 'ada' } },
    });
  });

  it('redacts every element of an array', () => {
    const input = {
      users: [
        { email: 'a@example.com', access_token: 'aaa', id: 1 },
        { email: 'b@example.com', access_token: 'bbb', id: 2 },
      ],
    };

    expect(redactValue(input, NO_EXTRA)).toEqual({
      users: [
        { email: REDACTED, access_token: REDACTED, id: 1 },
        { email: REDACTED, access_token: REDACTED, id: 2 },
      ],
    });
  });

  it('does not mutate its input', () => {
    const input = { password: 'still-here' };
    redactValue(input, NO_EXTRA);
    expect(input.password).toBe('still-here');
  });

  it('handles primitives and null', () => {
    expect(redactValue(null, NO_EXTRA)).toBeNull();
    expect(redactValue(42, NO_EXTRA)).toBe(42);
    expect(redactValue(true, NO_EXTRA)).toBe(true);
    expect(redactValue('plain', NO_EXTRA)).toBe('plain');
  });

  it('redacts a JWT found under a harmless key', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

    expect(redactValue({ data: jwt }, NO_EXTRA)).toEqual({ data: REDACTED });
  });

  it('redacts PEM private key material', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----';

    expect(redactValue({ blob: pem }, NO_EXTRA)).toEqual({ blob: REDACTED });
  });

  it('survives prototype-polluting keys without touching Object.prototype', () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"password":"secret"}}',
    ) as unknown;

    const output = redactValue(input, NO_EXTRA) as Record<string, unknown>;

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(Object.getPrototypeOf(output)).toBeNull();
  });

  it('stops at a depth limit instead of overflowing the stack', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 500; index += 1) {
      deep = { nested: deep };
    }

    const output = JSON.stringify(redactValue(deep, NO_EXTRA));

    expect(output).toContain(TOO_DEEP);
    expect(output).not.toContain('leaf');
  });
});

describe('header redaction', () => {
  it('redacts sensitive header values but keeps the names', () => {
    const output = redactor().headers({
      authorization: 'Bearer REAL_SECRET',
      cookie: 'session=REAL_COOKIE',
      'content-type': 'application/json',
      'x-api-key': 'REAL_KEY',
    });

    expect(output).toEqual({
      authorization: REDACTED,
      cookie: REDACTED,
      'content-type': 'application/json',
      'x-api-key': REDACTED,
    });
  });

  it('keeps the shape of repeated Set-Cookie headers', () => {
    const output = redactor().headers({
      'set-cookie': ['a=1; Path=/', 'b=2; Path=/', 'session=xyz'],
    });

    expect(output['set-cookie']).toEqual([REDACTED, REDACTED, REDACTED]);
  });

  it('drops undefined header values rather than recording them', () => {
    expect(redactor().headers({ absent: undefined })).toEqual({});
  });

  it('redacts a token-shaped value under an ordinary header name', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

    expect(redactor().headers({ 'x-trace': jwt })).toEqual({ 'x-trace': REDACTED });
  });
});

describe('query redaction', () => {
  it('redacts sensitive query parameters', () => {
    const output = redactor().query(
      new URLSearchParams('token=abc&access_token=def&api_key=ghi&email=a@example.com&page=2'),
    );

    expect(output).toEqual({
      token: REDACTED,
      access_token: REDACTED,
      api_key: REDACTED,
      email: REDACTED,
      page: '2',
    });
  });

  it('keeps repeated harmless values as an array', () => {
    expect(redactor().query(new URLSearchParams('tag=a&tag=b'))).toEqual({ tag: ['a', 'b'] });
  });

  it('redacts every value of a repeated sensitive parameter', () => {
    expect(redactor().query(new URLSearchParams('token=a&token=b'))).toEqual({
      token: [REDACTED, REDACTED],
    });
  });

  it('honours configured extra query names', () => {
    const output = redactor({ query: ['tracking-id'] }).query(
      new URLSearchParams('tracking_id=abc'),
    );

    expect(output).toEqual({ tracking_id: REDACTED });
  });
});

describe('value patterns', () => {
  it('recognises a real JWT', () => {
    expect(
      looksLikeJwt(
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      ),
    ).toBe(true);
  });

  it.each(['1.2.3', 'a.b.c', 'example.com.tr', 'not.a.jwt', 'com.acme.service.name'])(
    'does not mistake %j for a JWT',
    (value) => {
      expect(looksLikeJwt(value)).toBe(false);
    },
  );

  it.each([
    '-----BEGIN PRIVATE KEY-----',
    '-----BEGIN RSA PRIVATE KEY-----',
    '-----BEGIN EC PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
  ])('recognises %j', (marker) => {
    expect(looksLikePrivateKey(`${marker}\nbody\n`)).toBe(true);
  });

  it('leaves a public certificate alone', () => {
    expect(looksLikePrivateKey('-----BEGIN CERTIFICATE-----\nbody\n')).toBe(false);
    expect(looksLikePrivateKey('-----BEGIN PUBLIC KEY-----\nbody\n')).toBe(false);
  });

  it('recognises a long random credential', () => {
    expect(looksLikeCredential('sk1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R9s')).toBe(true);
  });

  it.each([
    'short',
    '550e8400-e29b-41d4-a716-446655440000',
    'the quick brown fox jumps over the lazy dog again',
    'https://example.com/some/quite/long/path/segment/here',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
    '00000000000000000000000000000000',
    'abcdefghijklmnopqrstuvwxyzabcdefghij',
  ])('does not treat %j as a credential', (value) => {
    expect(looksLikeCredential(value)).toBe(false);
  });
});

describe('shape-based detection without a field name', () => {
  const nameTest = (name: string) => isSensitiveFieldName(name, NO_EXTRA);

  it.each([
    'Bearer HEADER_SECRET_789',
    'bearer abcdefghijklmnop',
    'Basic dXNlcjpwYXNzd29yZA==',
    'Token 0123456789abcdef',
  ])('recognises %j as an authorization value', (value) => {
    expect(looksLikeAuthorizationValue(value)).toBe(true);
  });

  it.each(['Bearer token required', 'Bearer', 'Bearer short', 'a bearer of bad news'])(
    'does not treat %j as an authorization value',
    (value) => {
      expect(looksLikeAuthorizationValue(value)).toBe(false);
    },
  );

  it.each(['session=COOKIE_SECRET_ABC', 'access_token=abc123', 'password=hunter2'])(
    'recognises %j as a sensitive pair',
    (value) => {
      expect(looksLikeSensitivePair(value, nameTest)).toBe(true);
    },
  );

  it.each(['page=2', 'sort=name', 'a=1', 'theme=dark', 'monkey=banana'])(
    'does not treat %j as a sensitive pair',
    (value) => {
      expect(looksLikeSensitivePair(value, nameTest)).toBe(false);
    },
  );

  it('redacts a header value echoed into an unnamed array', () => {
    const input = {
      rawHeaders: ['authorization', 'Bearer HEADER_SECRET_789', 'cookie', 'session=SECRET_ABC'],
    };

    expect(redactValue(input, NO_EXTRA)).toEqual({
      rawHeaders: ['authorization', REDACTED, 'cookie', REDACTED],
    });
  });
});

describe('negative redaction', () => {
  it('leaves an ordinary payload completely untouched', () => {
    const input = {
      monkey: 'banana',
      tokenizer: 'bert',
      passwordPolicy: 'minimum 12 characters',
      public_key: 'not a private key',
      id: 42,
      userId: '550e8400-e29b-41d4-a716-446655440000',
      description: 'Contact support if your token expires',
      counts: { tokens_remaining: 5 },
    };

    expect(redactValue(input, NO_EXTRA)).toEqual(input);
  });
});
