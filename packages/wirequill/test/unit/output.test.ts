import { describe, expect, it } from 'vitest';
import { Output } from '../../src/cli/output.js';
import { truncatePathForDisplay } from '../../src/utils/terminal.js';

/**
 * What the terminal actually looks like (spec sections 10 to 16).
 *
 * The traffic log is the part of WireQuill a developer stares at while using
 * their application, so its alignment is a product decision rather than a
 * formatting detail — and its content is a privacy decision.
 */

function capture(): { output: Output; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];

  return {
    output: new Output({ stdout: (line) => lines.push(line), stderr: (line) => errors.push(line) }),
    lines,
    errors,
  };
}

/** Colour is decoration; every assertion here is about the text underneath. */
function plain(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\[[0-9;]*m/g, '');
}

describe('traffic log', () => {
  it('lines up methods, paths, statuses and durations', () => {
    const { output, lines } = capture();

    output.traffic('POST', '/auth/login', 200, 32, true);
    output.traffic('GET', '/products', 200, 18, true);
    output.traffic('GET', '/products/{productId}', 200, 12.4, false);

    const rendered = lines.map(plain);

    expect(rendered[0]).toBe('+ POST    /auth/login                            200    32ms');
    expect(rendered[1]).toBe('+ GET     /products                              200    18ms');
    // Not discovered: the marker column is blank rather than absent, so the
    // columns still line up.
    expect(rendered[2]).toBe('  GET     /products/{productId}                  200    12ms');

    // Every line is the same length, which is what makes a column readable.
    expect(new Set(rendered.map((line) => line.length)).size).toBe(1);
  });

  it('fits a default 80-column terminal', () => {
    const { output, lines } = capture();

    output.traffic('DELETE', '/organizations/{organizationId}/members', 204, 9, false);

    expect(plain(lines[0] ?? '').length).toBeLessThanOrEqual(80);
  });

  it('marks a discovery and a server error differently, and not only by colour', () => {
    const { output, lines } = capture();

    output.traffic('POST', '/checkout', 201, 24, true);
    output.traffic('POST', '/checkout', 500, 87, false);

    expect(plain(lines[0] ?? '').startsWith('+ ')).toBe(true);
    expect(plain(lines[1] ?? '').startsWith('! ')).toBe(true);
  });

  it('shortens a long path in the middle, keeping both ends', () => {
    const { output, lines } = capture();
    const long = '/api/v2/organizations/{organizationId}/members/{memberId}/permissions';

    output.traffic('GET', long, 200, 5, false);

    const rendered = plain(lines[0] ?? '');

    expect(rendered).toContain('/api/v2/org');
    // The end says what the endpoint does; a tail-only cut would lose it.
    expect(rendered).toContain('permissions');
    expect(rendered).toContain('…');
    expect(rendered.length).toBeLessThanOrEqual(80);
  });

  it('never lets an escape sequence from a client reach the terminal', () => {
    const { output, lines } = capture();

    output.traffic('GET', '/evil[2J[H/path', 200, 1, false);

    expect(lines[0]).not.toContain('[2J');
  });

  it('reports an unreachable target with a syscall code and nothing else', () => {
    const { output, lines } = capture();

    output.trafficFailure('GET', '/products', 'ECONNREFUSED');

    expect(plain(lines[0] ?? '')).toContain('! GET');
    expect(plain(lines[1] ?? '')).toContain('Target connection failed: ECONNREFUSED');
  });
});

describe('display truncation', () => {
  it('leaves a short path alone', () => {
    expect(truncatePathForDisplay('/users/{userId}', 38)).toBe('/users/{userId}');
  });

  it('keeps the head and the tail', () => {
    const long = '/a/very/long/path/that/keeps/going/and/going/to/the/end';
    const short = truncatePathForDisplay(long, 20);

    expect(short).toBe('/a/very/lo…o/the/end');
    expect(short).toHaveLength(20);
  });

  it('is display only', () => {
    // The value handed to it is a copy; nothing stored is ever shortened.
    const original = '/very/long/path/that/will/be/shortened/for/one/terminal/column';
    truncatePathForDisplay(original, 10);

    expect(original).toBe('/very/long/path/that/will/be/shortened/for/one/terminal/column');
  });
});
