import { describe, expect, it } from 'vitest';
import { BoundedBodyCapture, MetadataOnlyBodyCapture } from '../../src/capture/body-capture.js';
import { InMemoryCaptureBudget, UNLIMITED_BUDGET } from '../../src/capture/capture-budget.js';
import {
  classifyMediaType,
  isSupportedCharset,
  parseContentEncoding,
  parseContentType,
  shouldRetainBody,
} from '../../src/capture/content-type.js';

function makeCapture(limitBytes: number, budgetBytes = Number.MAX_SAFE_INTEGER) {
  const budget = new InMemoryCaptureBudget(budgetBytes);
  return { capture: new BoundedBodyCapture({ limitBytes, budget }), budget };
}

describe('BoundedBodyCapture', () => {
  it('captures nothing for an empty body', () => {
    const { capture } = makeCapture(1024);
    const result = capture.finish();

    expect(result).toEqual({
      totalBytes: 0,
      capturedBytes: 0,
      truncated: false,
      budgetExceeded: false,
      buffer: null,
    });
  });

  it('captures a single chunk', () => {
    const { capture } = makeCapture(1024);
    capture.observe(Buffer.from('hello'));

    const result = capture.finish();

    expect(result.totalBytes).toBe(5);
    expect(result.capturedBytes).toBe(5);
    expect(result.truncated).toBe(false);
    expect(result.buffer?.toString('utf8')).toBe('hello');
  });

  it('joins multiple chunks in order', () => {
    const { capture } = makeCapture(1024);
    capture.observe(Buffer.from('one-'));
    capture.observe(Buffer.from('two-'));
    capture.observe(Buffer.from('three'));

    expect(capture.finish().buffer?.toString('utf8')).toBe('one-two-three');
  });

  it('ignores empty chunks', () => {
    const { capture } = makeCapture(1024);
    capture.observe(Buffer.alloc(0));

    expect(capture.finish().totalBytes).toBe(0);
  });

  it('captures a body that is exactly at the limit', () => {
    const { capture } = makeCapture(8);
    capture.observe(Buffer.alloc(8, 1));

    const result = capture.finish();

    expect(result.capturedBytes).toBe(8);
    expect(result.truncated).toBe(false);
  });

  it('truncates one byte past the limit', () => {
    const { capture } = makeCapture(8);
    capture.observe(Buffer.alloc(9, 1));

    const result = capture.finish();

    expect(result.totalBytes).toBe(9);
    expect(result.capturedBytes).toBe(8);
    expect(result.truncated).toBe(true);
  });

  it('keeps counting a huge body it stopped capturing', () => {
    const { capture } = makeCapture(1024);

    for (let index = 0; index < 100; index += 1) {
      capture.observe(Buffer.alloc(64 * 1024, 7));
    }

    const result = capture.finish();

    expect(result.totalBytes).toBe(100 * 64 * 1024);
    expect(result.capturedBytes).toBe(1024);
    expect(result.truncated).toBe(true);
    expect(result.buffer?.byteLength).toBe(1024);
  });

  it('copies chunks so the capture does not pin the caller buffer', () => {
    const { capture } = makeCapture(1024);
    const chunk = Buffer.from('original');

    capture.observe(chunk);
    chunk.write('MUTATED!');

    expect(capture.finish().buffer?.toString('utf8')).toBe('original');
  });

  it('stops capturing when the shared budget refuses a reservation', () => {
    const { capture } = makeCapture(1024, 10);
    capture.observe(Buffer.alloc(8, 1));
    capture.observe(Buffer.alloc(8, 1));

    const result = capture.finish();

    expect(result.totalBytes).toBe(16);
    expect(result.capturedBytes).toBe(8);
    expect(result.budgetExceeded).toBe(true);
  });

  it('returns the same result from repeated finish calls', () => {
    const { capture } = makeCapture(1024);
    capture.observe(Buffer.from('stable'));

    expect(capture.finish()).toBe(capture.finish());
  });

  it('returns its reservation on release', () => {
    const { capture, budget } = makeCapture(1024, 4096);
    capture.observe(Buffer.alloc(100, 1));

    expect(budget.reservedBytes).toBe(100);

    capture.release();

    expect(budget.reservedBytes).toBe(0);
  });

  it('is safe to release twice and does not double-credit the budget', () => {
    const { capture, budget } = makeCapture(1024, 4096);
    capture.observe(Buffer.alloc(100, 1));

    capture.release();
    capture.release();

    expect(budget.reservedBytes).toBe(0);
  });

  it('drops the buffer reference once released', () => {
    const { capture } = makeCapture(1024);
    capture.observe(Buffer.from('sensitive'));

    capture.finish();
    capture.release();

    expect(capture.finish().buffer).toBeNull();
  });

  it('stops retaining after release even if more chunks arrive', () => {
    const { capture, budget } = makeCapture(1024, 4096);
    capture.release();
    capture.observe(Buffer.from('late'));

    expect(budget.reservedBytes).toBe(0);
    expect(capture.finish().capturedBytes).toBe(0);
    expect(capture.finish().totalBytes).toBe(4);
  });
});

describe('MetadataOnlyBodyCapture', () => {
  it('counts without keeping anything', () => {
    const capture = new MetadataOnlyBodyCapture();
    capture.observe(Buffer.alloc(5000, 1));
    capture.observe(Buffer.alloc(1000, 1));

    const result = capture.finish();

    expect(result.totalBytes).toBe(6000);
    expect(result.capturedBytes).toBe(0);
    expect(result.buffer).toBeNull();
    expect(result.truncated).toBe(false);
  });

  it('releases without error', () => {
    const capture = new MetadataOnlyBodyCapture();
    expect(() => capture.release()).not.toThrow();
  });
});

describe('InMemoryCaptureBudget', () => {
  it('grants reservations up to the limit', () => {
    const budget = new InMemoryCaptureBudget(100);

    expect(budget.tryReserve(60)).toBe(true);
    expect(budget.tryReserve(40)).toBe(true);
    expect(budget.tryReserve(1)).toBe(false);
    expect(budget.reservedBytes).toBe(100);
  });

  it('frees capacity again on release', () => {
    const budget = new InMemoryCaptureBudget(100);

    budget.tryReserve(100);
    budget.release(50);

    expect(budget.tryReserve(50)).toBe(true);
  });

  it('never goes negative on an over-release', () => {
    const budget = new InMemoryCaptureBudget(100);

    budget.tryReserve(10);
    budget.release(999);

    expect(budget.reservedBytes).toBe(0);
    expect(budget.tryReserve(100)).toBe(true);
  });

  it('treats a zero-byte reservation as free', () => {
    const budget = new InMemoryCaptureBudget(0);
    expect(budget.tryReserve(0)).toBe(true);
    expect(budget.tryReserve(1)).toBe(false);
  });

  it('offers an unlimited budget for the capture-disabled path', () => {
    expect(UNLIMITED_BUDGET.tryReserve(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe('parseContentType', () => {
  it.each([
    ['application/json', 'application/json', undefined],
    ['Application/JSON; Charset=UTF-8', 'application/json', 'utf-8'],
    ['application/problem+json', 'application/problem+json', undefined],
    ['application/vnd.api+json', 'application/vnd.api+json', undefined],
    ['text/plain; charset="iso-8859-9"', 'text/plain', 'iso-8859-9'],
    ['multipart/form-data; boundary=----abc', 'multipart/form-data', undefined],
    ['  APPLICATION/OCTET-STREAM  ', 'application/octet-stream', undefined],
  ])('parses %j', (input, mediaType, charset) => {
    expect(parseContentType(input)).toEqual({ mediaType, charset });
  });

  it('returns null when absent or empty', () => {
    expect(parseContentType(undefined)).toBeNull();
    expect(parseContentType('')).toBeNull();
    expect(parseContentType('; charset=utf-8')).toBeNull();
  });
});

describe('classifyMediaType', () => {
  it.each([
    ['application/json', 'json'],
    ['application/problem+json', 'json'],
    ['application/vnd.api+json', 'json'],
    ['application/x-www-form-urlencoded', 'form'],
    ['multipart/form-data', 'multipart'],
    ['text/event-stream', 'event-stream'],
    ['text/plain', 'text'],
    ['text/html', 'text'],
    ['application/octet-stream', 'binary'],
    ['image/png', 'binary'],
    ['video/mp4', 'binary'],
    ['audio/mpeg', 'binary'],
    ['application/pdf', 'binary'],
    ['font/woff2', 'binary'],
    ['application/x-custom', 'unknown'],
  ])('classifies %j as %s', (mediaType, expected) => {
    expect(classifyMediaType(mediaType)).toBe(expected);
  });

  it('treats an absent media type as unknown', () => {
    expect(classifyMediaType(undefined)).toBe('unknown');
  });
});

describe('shouldRetainBody', () => {
  it('retains only structured payloads WireQuill can read', () => {
    expect(shouldRetainBody('json')).toBe(true);
    expect(shouldRetainBody('form')).toBe(true);

    for (const kind of ['multipart', 'binary', 'text', 'event-stream', 'unknown'] as const) {
      expect(shouldRetainBody(kind)).toBe(false);
    }
  });
});

describe('charset and encoding helpers', () => {
  it.each([undefined, 'utf-8', 'utf8', 'us-ascii'])('accepts charset %j', (charset) => {
    expect(isSupportedCharset(charset)).toBe(true);
  });

  it.each(['iso-8859-9', 'utf-16', 'shift_jis'])('rejects charset %j', (charset) => {
    expect(isSupportedCharset(charset)).toBe(false);
  });

  it.each([
    ['gzip', 'gzip'],
    ['GZIP', 'gzip'],
    ['br', 'br'],
    ['deflate', 'deflate'],
    ['gzip, br', 'br'],
  ])('normalises encoding %j to %j', (input, expected) => {
    expect(parseContentEncoding(input)).toBe(expected);
  });

  it('treats identity and absence as no encoding', () => {
    expect(parseContentEncoding('identity')).toBeNull();
    expect(parseContentEncoding(undefined)).toBeNull();
    expect(parseContentEncoding('')).toBeNull();
  });
});
