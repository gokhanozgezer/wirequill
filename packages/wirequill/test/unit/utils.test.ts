import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stableStringify } from '../../src/utils/stable-json.js';
import { sanitizeTerminalText } from '../../src/utils/terminal.js';
import { deriveWorkspaceId, sha256Hex } from '../../src/utils/ids.js';
import { fixedClock, toIsoString } from '../../src/utils/clock.js';
import { errorCode, errorMessage, WireQuillError } from '../../src/utils/errors.js';
import { WIREQUILL_VERSION } from '../../src/version.js';

describe('stableStringify', () => {
  it('sorts object keys', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('produces the same string for objects built in different orders', () => {
    expect(stableStringify({ x: { b: 1, a: 2 }, y: [3, 1] })).toBe(
      stableStringify({ y: [3, 1], x: { a: 2, b: 1 } }),
    );
  });

  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined properties like JSON.stringify does', () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('writes non-finite numbers as null', () => {
    expect(stableStringify({ a: Number.NaN, b: Number.POSITIVE_INFINITY })).toBe(
      '{"a":null,"b":null}',
    );
  });

  it('rejects cyclic values instead of hanging', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableStringify(cyclic)).toThrowError(/cyclic/);
  });

  it('handles the same object appearing twice without calling it cyclic', () => {
    const shared = { a: 1 };
    expect(stableStringify({ first: shared, second: shared })).toBe(
      '{"first":{"a":1},"second":{"a":1}}',
    );
  });
});

describe('sanitizeTerminalText', () => {
  it('replaces escape sequences that could rewrite the terminal', () => {
    const hostile = `${String.fromCharCode(27)}[2Kfake output`;
    const sanitized = sanitizeTerminalText(hostile);

    expect(sanitized).not.toContain(String.fromCharCode(27));
    expect(sanitized).toContain('fake output');
  });

  it('flattens newlines and carriage returns', () => {
    expect(sanitizeTerminalText('a\nb\r\nc')).toBe('a b  c');
  });

  it('caps the length', () => {
    expect(sanitizeTerminalText('x'.repeat(500), 20)).toHaveLength(20);
  });

  it('leaves ordinary text alone', () => {
    expect(sanitizeTerminalText('GET /users/{userId}')).toBe('GET /users/{userId}');
  });
});

describe('ids', () => {
  it('hashes deterministically', () => {
    expect(sha256Hex('wirequill')).toBe(sha256Hex('wirequill'));
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });

  it('derives a stable workspace id', () => {
    const a = deriveWorkspaceId('D:/work/acme', 'http://localhost:8080');
    const b = deriveWorkspaceId('D:/work/acme', 'http://localhost:8080');
    const c = deriveWorkspaceId('D:/work/acme', 'http://localhost:8081');

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(32);
  });
});

describe('clock', () => {
  it('freezes time for tests', () => {
    const clock = fixedClock('2026-08-23T10:00:00.000Z');
    expect(toIsoString(clock.now())).toBe('2026-08-23T10:00:00.000Z');
    expect(toIsoString(clock.now())).toBe('2026-08-23T10:00:00.000Z');
  });

  it('hands out independent Date instances', () => {
    const clock = fixedClock('2026-08-23T10:00:00.000Z');
    const first = clock.now();
    first.setFullYear(1999);
    expect(clock.now().getFullYear()).toBe(2026);
  });
});

describe('errors', () => {
  it('carries a code and an optional hint', () => {
    const error = new WireQuillError('X', 'message', 'hint');
    expect(error.code).toBe('X');
    expect(error.hint).toBe('hint');
    expect(error).toBeInstanceOf(Error);
  });

  it('reads a syscall error code without casting', () => {
    expect(errorCode(Object.assign(new Error('nope'), { code: 'ECONNREFUSED' }))).toBe(
      'ECONNREFUSED',
    );
    expect(errorCode(new Error('nope'))).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });

  it('stringifies non-Error throws', () => {
    expect(errorMessage('boom')).toBe('boom');
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });
});

describe('version', () => {
  it('matches the package manifest', () => {
    const packageJsonPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'package.json',
    );
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };

    expect(WIREQUILL_VERSION).toBe(manifest.version);
  });
});
