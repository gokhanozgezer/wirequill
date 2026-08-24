import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { BodyCaptureResult } from '../../src/capture/body-capture.js';
import { decompressCapturedBody } from '../../src/processing/decompress.js';
import { parseCapturedBody, parseStatusOf } from '../../src/processing/parsed-body.js';

const MAX_DECOMPRESSED = 2 * 1024 * 1024;

function captured(buffer: Buffer, overrides: Partial<BodyCaptureResult> = {}): BodyCaptureResult {
  return {
    totalBytes: buffer.byteLength,
    capturedBytes: buffer.byteLength,
    truncated: false,
    budgetExceeded: false,
    buffer,
    ...overrides,
  };
}

function parse(
  body: Buffer,
  headers: Record<string, string>,
  overrides: Partial<BodyCaptureResult> = {},
) {
  return parseCapturedBody({
    headers,
    capture: captured(body, overrides),
    maxDecompressedBytes: MAX_DECOMPRESSED,
  });
}

const JSON_HEADERS = { 'content-type': 'application/json' };

describe('JSON parsing', () => {
  it('parses an object', () => {
    const parsed = parse(Buffer.from('{"id":42,"name":"Ada"}'), JSON_HEADERS);

    expect(parsed).toEqual({
      kind: 'json',
      mediaType: 'application/json',
      value: { id: 42, name: 'Ada' },
    });
  });

  it('parses an array', () => {
    const parsed = parse(Buffer.from('[1,2,3]'), JSON_HEADERS);
    expect(parsed.kind === 'json' && parsed.value).toEqual([1, 2, 3]);
  });

  it.each([
    ['a primitive string', '"hello"', 'hello'],
    ['a number', '42', 42],
    ['a boolean', 'true', true],
    ['null', 'null', null],
  ])('parses %s', (_label, text, expected) => {
    const parsed = parse(Buffer.from(text), JSON_HEADERS);
    expect(parsed.kind === 'json' && parsed.value).toEqual(expected);
  });

  it('strips a UTF-8 byte order mark', () => {
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ok":true}')]);
    const parsed = parse(body, JSON_HEADERS);

    expect(parsed.kind === 'json' && parsed.value).toEqual({ ok: true });
  });

  it('parses a +json media type', () => {
    const parsed = parse(Buffer.from('{"type":"about:blank"}'), {
      'content-type': 'application/problem+json',
    });

    expect(parsed.kind).toBe('json');
  });

  it('reports malformed JSON without quoting the body', () => {
    const parsed = parse(Buffer.from('{"password":"SUPER_SECRET_123", oops'), JSON_HEADERS);

    expect(parsed).toEqual({
      kind: 'invalid',
      mediaType: 'application/json',
      reason: 'invalid_json',
    });
    expect(JSON.stringify(parsed)).not.toContain('SUPER_SECRET_123');
  });

  it('treats an empty JSON body as none rather than an error', () => {
    expect(parse(Buffer.from(''), JSON_HEADERS)).toEqual({ kind: 'none' });
    expect(parse(Buffer.from('   '), JSON_HEADERS)).toEqual({ kind: 'none' });
  });

  it('refuses a charset it cannot decode', () => {
    const parsed = parse(Buffer.from('{"a":1}'), {
      'content-type': 'application/json; charset=iso-8859-9',
    });

    expect(parsed).toEqual({
      kind: 'unsupported',
      mediaType: 'application/json',
      reason: 'unsupported_charset',
    });
  });

  it('does not attempt to parse a truncated body', () => {
    const parsed = parse(Buffer.from('{"partial":'), JSON_HEADERS, { truncated: true });

    expect(parsed).toEqual({ kind: 'truncated', mediaType: 'application/json' });
  });

  it('does not attempt to parse when the budget cut the capture short', () => {
    const parsed = parse(Buffer.from('{"partial":'), JSON_HEADERS, { budgetExceeded: true });

    expect(parsed.kind).toBe('truncated');
  });
});

describe('form parsing', () => {
  const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };

  it('parses fields', () => {
    const parsed = parse(Buffer.from('a=1&b=two'), FORM_HEADERS);

    expect(parsed.kind === 'form' && { ...parsed.value }).toEqual({ a: '1', b: 'two' });
  });

  it('collects a repeated field into an array', () => {
    const parsed = parse(Buffer.from('tag=a&tag=b'), FORM_HEADERS);

    expect(parsed.kind === 'form' && { ...parsed.value }).toEqual({ tag: ['a', 'b'] });
  });

  it('decodes percent-encoded values', () => {
    const parsed = parse(Buffer.from('q=a%20b&plus=a+b'), FORM_HEADERS);

    expect(parsed.kind === 'form' && { ...parsed.value }).toEqual({ q: 'a b', plus: 'a b' });
  });
});

describe('bodies that are not parsed', () => {
  it.each([
    ['multipart/form-data; boundary=x', 'unsupported_multipart'],
    ['application/octet-stream', 'unsupported_binary'],
    ['image/png', 'unsupported_binary'],
    ['text/event-stream', 'unsupported_event_stream'],
    ['text/plain', 'text_not_analyzed'],
    ['application/x-custom', 'unsupported_media_type'],
  ])('reports %j as %s', (contentType, reason) => {
    const parsed = parse(Buffer.from('anything'), { 'content-type': contentType });

    expect(parsed.kind).toBe('unsupported');
    expect(parseStatusOf(parsed)).toBe(reason);
  });

  it('reports an aborted request without guessing at the payload', () => {
    const parsed = parseCapturedBody({
      headers: JSON_HEADERS,
      capture: captured(Buffer.from('{"partial"')),
      maxDecompressedBytes: MAX_DECOMPRESSED,
      aborted: true,
    });

    expect(parseStatusOf(parsed)).toBe('aborted');
  });

  it('reports none when there was no body at all', () => {
    expect(
      parseCapturedBody({
        headers: JSON_HEADERS,
        capture: undefined,
        maxDecompressedBytes: MAX_DECOMPRESSED,
      }),
    ).toEqual({ kind: 'none' });
  });

  it('reports when a body was seen but nothing was retained', () => {
    const parsed = parseCapturedBody({
      headers: JSON_HEADERS,
      capture: {
        totalBytes: 500,
        capturedBytes: 0,
        truncated: false,
        budgetExceeded: false,
        buffer: null,
      },
      maxDecompressedBytes: MAX_DECOMPRESSED,
    });

    expect(parseStatusOf(parsed)).toBe('not_captured');
  });
});

describe('compressed bodies', () => {
  const payload = Buffer.from('{"compressed":true,"value":"round trip"}');

  it.each([
    ['gzip', gzipSync(payload)],
    ['deflate', deflateSync(payload)],
    ['br', brotliCompressSync(payload)],
  ])('decodes a %s capture copy', (encoding, compressed) => {
    const parsed = parse(compressed, {
      'content-type': 'application/json',
      'content-encoding': encoding,
    });

    expect(parsed.kind === 'json' && parsed.value).toEqual({
      compressed: true,
      value: 'round trip',
    });
  });

  it('reports corrupt compressed data instead of throwing', () => {
    const parsed = parse(Buffer.from('not actually gzip at all'), {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    });

    expect(parsed).toEqual({
      kind: 'invalid',
      mediaType: 'application/json',
      reason: 'invalid_encoding',
    });
  });

  it('reports an unsupported encoding', () => {
    const parsed = parse(payload, {
      'content-type': 'application/json',
      'content-encoding': 'compress',
    });

    expect(parseStatusOf(parsed)).toBe('unsupported_encoding');
  });
});

describe('decompression bomb defence', () => {
  it('refuses a payload that expands past the limit', () => {
    // 4 MiB of zeroes compresses to a few kilobytes.
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024, 0));

    expect(bomb.byteLength).toBeLessThan(64 * 1024);

    const outcome = decompressCapturedBody(bomb, 'gzip', 1024 * 1024);

    expect(outcome).toEqual({ ok: false, reason: 'decompressed_too_large' });
  });

  it('surfaces the bomb as a parse status rather than a crash', () => {
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024, 0));

    const parsed = parseCapturedBody({
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      capture: captured(bomb),
      maxDecompressedBytes: 1024 * 1024,
    });

    expect(parseStatusOf(parsed)).toBe('decompressed_too_large');
  });

  it('allows a payload that stays within the limit', () => {
    const fine = gzipSync(Buffer.alloc(1024, 0));
    const outcome = decompressCapturedBody(fine, 'gzip', 1024 * 1024);

    expect(outcome.ok).toBe(true);
  });

  it('passes an unencoded buffer straight through', () => {
    const buffer = Buffer.from('plain');
    expect(decompressCapturedBody(buffer, null, 1024)).toEqual({ ok: true, buffer });
  });
});
