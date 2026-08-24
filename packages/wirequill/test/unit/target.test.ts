import { describe, expect, it } from 'vitest';
import { normalizeTargetUrl, parseTargetUrl } from '../../src/config/target.js';
import { WireQuillError } from '../../src/utils/errors.js';

describe('parseTargetUrl', () => {
  it('accepts http and https targets', () => {
    expect(parseTargetUrl('http://localhost:8080').href).toBe('http://localhost:8080/');
    expect(parseTargetUrl('https://localhost:8443').href).toBe('https://localhost:8443/');
  });

  it('keeps a base path on the target', () => {
    expect(parseTargetUrl('http://127.0.0.1:5000/api').pathname).toBe('/api');
  });

  it('trims surrounding whitespace', () => {
    expect(parseTargetUrl('  http://localhost:8080  ').href).toBe('http://localhost:8080/');
  });

  it.each(['localhost:8080', 'ftp://localhost', 'file:///etc/passwd', '', '   '])(
    'rejects %j',
    (value) => {
      expect(() => parseTargetUrl(value)).toThrowError(WireQuillError);
    },
  );

  it('explains how to fix an invalid target', () => {
    try {
      parseTargetUrl('localhost:8080');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WireQuillError);
      const wireQuillError = error as WireQuillError;
      expect(wireQuillError.code).toBe('INVALID_TARGET');
      expect(wireQuillError.message).toContain('Invalid target URL:');
      expect(wireQuillError.message).toContain('localhost:8080');
      expect(wireQuillError.message).toContain('http://localhost:8080');
    }
  });

  it('rejects embedded credentials', () => {
    expect(() => parseTargetUrl('http://user:password@localhost:8080')).toThrowError(
      /must not contain credentials/,
    );
  });

  it('never echoes the password back', () => {
    try {
      parseTargetUrl('http://user:ULTRA_SECRET_123@localhost:8080');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as WireQuillError).message).not.toContain('ULTRA_SECRET_123');
      expect((error as WireQuillError).message).toContain('***');
    }
  });

  it('drops query strings and fragments', () => {
    const target = parseTargetUrl('http://localhost:8080/api?debug=1#frag');
    expect(target.search).toBe('');
    expect(target.hash).toBe('');
    expect(target.pathname).toBe('/api');
  });
});

describe('normalizeTargetUrl', () => {
  it('produces the same identity for equivalent targets', () => {
    const a = normalizeTargetUrl(parseTargetUrl('http://LOCALHOST:8080'));
    const b = normalizeTargetUrl(parseTargetUrl('http://localhost:8080/'));
    expect(a).toBe(b);
  });

  it('keeps distinct targets distinct', () => {
    const a = normalizeTargetUrl(parseTargetUrl('http://localhost:8080'));
    const b = normalizeTargetUrl(parseTargetUrl('http://localhost:8081'));
    const c = normalizeTargetUrl(parseTargetUrl('https://localhost:8080'));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('strips a trailing slash from the base path', () => {
    expect(normalizeTargetUrl(parseTargetUrl('http://localhost:8080/api/'))).toBe(
      'http://localhost:8080/api',
    );
  });
});
