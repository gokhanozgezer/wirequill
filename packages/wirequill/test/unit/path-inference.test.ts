import { describe, expect, it } from 'vitest';
import {
  canonicalizePath,
  classifyPath,
  classifySegment,
  safeDecodeSegment,
  segmentPath,
} from '../../src/inference/path/classify-segment.js';
import { normalizePath, safeDisplayPath } from '../../src/inference/path/normalize-path.js';
import { singularize } from '../../src/inference/path/singularize.js';
import { buildOperationId, operationRowId } from '../../src/inference/operation/operation-id.js';

/** A realistic token, used to prove a credential in a path is not retained. */
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CREDENTIAL = 'sk1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R9s';

function template(pathname: string): string {
  return normalizePath(classifyPath(pathname)).template;
}

describe('path canonicalisation', () => {
  it.each([
    ['/users', '/users'],
    ['/users/', '/users'],
    ['/', '/'],
    ['', '/'],
  ])('canonicalises %j to %j', (input, expected) => {
    expect(canonicalizePath(input)).toBe(expected);
  });

  it('treats a trailing slash as the same operation', () => {
    expect(template('/users')).toBe(template('/users/'));
  });

  it('does not collapse a doubled slash into a different path', () => {
    // `//users` and `/users` are different request targets, and a backend may
    // well route them differently.
    expect(segmentPath('//users')).toEqual(['', 'users']);
    expect(template('//users')).not.toBe(template('/users'));
  });
});

describe('strong dynamic segments', () => {
  it.each([
    ['/users/123', '/users/{userId}'],
    ['/users/000123', '/users/{userId}'],
    ['/users/550e8400-e29b-41d4-a716-446655440000', '/users/{userId}'],
    ['/orders/507f1f77bcf86cd799439011', '/orders/{orderId}'],
    ['/events/01ARZ3NDEKTSV4RRFFQ69G5FAV', '/events/{eventId}'],
    ['/reports/2026-08-23', '/reports/{date}'],
    ['/api/v1/users/123', '/api/v1/users/{userId}'],
    ['/carts/123/items/456', '/carts/{cartId}/items/{itemId}'],
    ['/categories/7', '/categories/{categoryId}'],
    ['/people/7', '/people/{personId}'],
  ])('normalises %j to %j', (input, expected) => {
    expect(template(input)).toBe(expected);
  });

  it.each([
    ['123', 'integer'],
    ['550e8400-e29b-41d4-a716-446655440000', 'uuid'],
    ['507F1F77BCF86CD799439011', 'objectId'],
    ['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'ulid'],
    ['2026-08-23', 'date'],
  ])('classifies %j as %s', (segment, kind) => {
    expect(classifySegment(segment).kind).toBe(kind);
  });

  it('rejects a date that does not exist', () => {
    expect(classifySegment('2026-02-31').kind).toBe('literal');
    expect(classifySegment('2026-13-01').kind).toBe('literal');
  });

  it('does not mistake a lower-case slug for a ULID', () => {
    expect(classifySegment('abcdefghijklmnopqrstuvwxyz').kind).toBe('literal');
  });
});

describe('static segments stay literal', () => {
  it.each([
    ['/users/me', '/users/me'],
    ['/users/current', '/users/current'],
    ['/auth/login', '/auth/login'],
    ['/auth/logout', '/auth/logout'],
    ['/health', '/health'],
    ['/products/search', '/products/search'],
    ['/orders/export', '/orders/export'],
    ['/api/v1/status', '/api/v1/status'],
  ])('keeps %j as %j', (input, expected) => {
    expect(template(input)).toBe(expected);
  });

  it('keeps a version segment out of the parameters', () => {
    expect(template('/api/v1/users/1')).toBe('/api/v1/users/{userId}');
    expect(template('/api/v2/users/1')).toBe('/api/v2/users/{userId}');
    expect(template('/api/v10/users/1')).toBe('/api/v10/users/{userId}');
  });

  it('never merges a singleton route with an identifier route', () => {
    expect(template('/users/me')).not.toBe(template('/users/123'));
  });
});

describe('sensitive segments', () => {
  it('reduces a token in the path to its kind', () => {
    const segment = classifySegment(JWT);

    expect(segment.kind).toBe('token');
    expect(segment.sensitive).toBe(true);
    expect(segment.value).toBeUndefined();
    expect(JSON.stringify(segment)).not.toContain('eyJhbGci');
  });

  it('reduces a credential-looking segment to a token', () => {
    const segment = classifySegment(CREDENTIAL);

    expect(segment.kind).toBe('token');
    expect(segment.value).toBeUndefined();
  });

  it('treats an email address in the path as personal data', () => {
    const segment = classifySegment('dev%40example.com');

    expect(segment.kind).toBe('email');
    expect(segment.sensitive).toBe(true);
    expect(segment.value).toBeUndefined();
    expect(JSON.stringify(segment)).not.toContain('dev');
  });

  it.each([
    [`/reset-password/${JWT}`, '/reset-password/{token}'],
    [`/invite/${CREDENTIAL}`, '/invite/{token}'],
    ['/users/dev%40example.com', '/users/{email}'],
  ])('normalises %j to %j', (input, expected) => {
    expect(template(input)).toBe(expected);
  });

  it('keeps no secret in the classified path at all', () => {
    const segments = classifyPath(`/reset-password/${JWT}`);
    expect(JSON.stringify(segments)).not.toContain('eyJhbGci');
  });

  it('masks a sensitive segment in the display path', () => {
    expect(safeDisplayPath(classifyPath(`/reset/${JWT}`))).toBe('/reset/[REDACTED]');
    expect(safeDisplayPath(classifyPath('/users/123'))).toBe('/users/123');
    expect(safeDisplayPath(classifyPath('/'))).toBe('/');
  });
});

describe('percent-encoding safety', () => {
  it('does not decode a segment into a path separator', () => {
    // `%2F` decodes to a slash, which would silently move a segment boundary.
    expect(safeDecodeSegment('a%2Fb')).toBe('a%2Fb');
    expect(safeDecodeSegment('a%5Cb')).toBe('a%5Cb');
  });

  it('decodes a harmless segment', () => {
    expect(safeDecodeSegment('dev%40example.com')).toBe('dev@example.com');
  });

  it('survives malformed encoding', () => {
    expect(safeDecodeSegment('%E0%A4%A')).toBe('%E0%A4%A');
    expect(() => classifySegment('%')).not.toThrow();
  });

  it('keeps an encoded separator out of the template', () => {
    expect(template('/files/a%2Fb')).toBe('/files/a%2Fb');
  });
});

describe('conservative slug handling', () => {
  it.each([
    '/posts/my-first-post',
    '/blog/hello-world',
    '/docs/getting-started',
    '/tags/typescript',
  ])('leaves %j literal on a single sample', (input) => {
    expect(template(input)).toBe(input);
  });

  it('does not invent a parameter from a word', () => {
    expect(classifySegment('my-first-post').kind).toBe('literal');
  });
});

describe('parameter naming', () => {
  it('names a parameter after the resource before it', () => {
    expect(template('/orders/550e8400-e29b-41d4-a716-446655440000')).toBe('/orders/{orderId}');
  });

  it('walks back past another parameter to find the resource', () => {
    expect(template('/carts/1/items/2')).toBe('/carts/{cartId}/items/{itemId}');
  });

  it('disambiguates a repeated resource deterministically', () => {
    const first = template('/resources/1/resources/2');

    expect(first).toBe('/resources/{resourceId}/resources/{resourceId2}');
    expect(template('/resources/9/resources/8')).toBe(first);
  });

  it('names a parameter after its kind when the resource would not', () => {
    expect(template('/reports/2026-08-23')).toBe('/reports/{date}');
    expect(template(`/reset/${JWT}`)).toBe('/reset/{token}');
    expect(template('/lookup/dev%40example.com')).toBe('/lookup/{email}');
  });

  it('falls back when there is nothing to name it after', () => {
    expect(template('/123')).toBe('/{id}');
  });

  it('reports the position and kind of each parameter', () => {
    const { parameters } = normalizePath(classifyPath('/carts/1/items/2'));

    expect(parameters).toEqual([
      { name: 'cartId', position: 1, kind: 'integer' },
      { name: 'itemId', position: 3, kind: 'integer' },
    ]);
  });
});

describe('singularize', () => {
  it.each([
    ['users', 'user'],
    ['orders', 'order'],
    ['categories', 'category'],
    ['items', 'item'],
    ['boxes', 'box'],
    ['batches', 'batch'],
    ['people', 'person'],
    ['children', 'child'],
    ['status', 'status'],
    ['address', 'address'],
    ['news', 'news'],
    ['data', 'data'],
    ['settings', 'settings'],
    ['user', 'user'],
  ])('turns %j into %j', (input, expected) => {
    expect(singularize(input)).toBe(expected);
  });
});

describe('operation identity', () => {
  it.each([
    ['GET', '/users/{userId}', 'getUsersByUserId'],
    ['POST', '/carts/{cartId}/items', 'postCartsByCartIdItems'],
    ['DELETE', '/users/{userId}', 'deleteUsersByUserId'],
    ['GET', '/api/v1/users/{userId}', 'getApiV1UsersByUserId'],
    ['GET', '/users/me', 'getUsersMe'],
    ['GET', '/', 'getRoot'],
    ['GET', '/reset-password/{token}', 'getResetPasswordByToken'],
  ])('%s %s becomes %s', (method, path, expected) => {
    expect(buildOperationId(method, path)).toBe(expected);
  });

  it('is stable across calls', () => {
    expect(buildOperationId('GET', '/users/{userId}')).toBe(
      buildOperationId('GET', '/users/{userId}'),
    );
  });

  it('distinguishes operations that differ only by method', () => {
    const ids = ['GET', 'POST', 'PATCH', 'DELETE'].map((method) =>
      buildOperationId(method, '/users/{userId}'),
    );

    expect(new Set(ids).size).toBe(4);
  });

  it('distinguishes nearby templates', () => {
    const ids = ['/users/{userId}', '/users/{userId}/items', '/users/me', '/orders/{orderId}'].map(
      (path) => buildOperationId('GET', path),
    );

    expect(new Set(ids).size).toBe(4);
  });
});

describe('operation row id', () => {
  it('is deterministic', () => {
    expect(operationRowId('ws', 'GET', '/users/{userId}')).toBe(
      operationRowId('ws', 'GET', '/users/{userId}'),
    );
  });

  it('separates workspaces, methods and templates', () => {
    const ids = new Set([
      operationRowId('ws-a', 'GET', '/users/{userId}'),
      operationRowId('ws-b', 'GET', '/users/{userId}'),
      operationRowId('ws-a', 'POST', '/users/{userId}'),
      operationRowId('ws-a', 'GET', '/users/me'),
    ]);

    expect(ids.size).toBe(4);
  });

  it('is case-insensitive about the method', () => {
    expect(operationRowId('ws', 'get', '/users')).toBe(operationRowId('ws', 'GET', '/users'));
  });

  it('is a short stable hex string', () => {
    expect(operationRowId('ws', 'GET', '/users')).toMatch(/^[0-9a-f]{32}$/);
  });
});
