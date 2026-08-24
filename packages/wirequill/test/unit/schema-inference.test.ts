import { describe, expect, it } from 'vitest';
import { detectFormat } from '../../src/inference/schema/detect-format.js';
import { inferSchemaEvidence } from '../../src/inference/schema/infer-value.js';
import { DEFAULT_SCHEMA_LIMITS } from '../../src/inference/schema/limits.js';
import { mergeAll, mergeEvidence } from '../../src/inference/schema/merge-evidence.js';
import {
  materializeSchema,
  type JsonSchema,
} from '../../src/inference/schema/materialize-schema.js';
import type { SchemaEvidence } from '../../src/inference/schema/types.js';

/** Infers and materialises in one step, which is how most assertions read. */
function schemaOf(...samples: unknown[]): JsonSchema {
  return materializeSchema(mergeAll(samples.map((sample) => inferSchemaEvidence(sample))));
}

function evidenceOf(...samples: unknown[]): SchemaEvidence {
  return mergeAll(samples.map((sample) => inferSchemaEvidence(sample)));
}

describe('primitive inference', () => {
  it.each([
    [null, { type: 'null' }],
    [true, { type: 'boolean' }],
    [false, { type: 'boolean' }],
    [0, { type: 'integer' }],
    [1, { type: 'integer' }],
    [-1, { type: 'integer' }],
    [1.5, { type: 'number' }],
    [-1.5, { type: 'number' }],
  ])('types %j', (value, expected) => {
    expect(schemaOf(value)).toEqual(expected);
  });

  it('types a plain string', () => {
    expect(schemaOf('hello')).toEqual({ type: 'string' });
  });

  it('types an empty object', () => {
    expect(schemaOf({})).toEqual({ type: 'object', properties: {} });
  });

  it('types an empty array with unknown items', () => {
    expect(schemaOf([])).toEqual({ type: 'array', items: {} });
  });

  it('says nothing when nothing was observed', () => {
    expect(materializeSchema(null)).toEqual({});
    expect(materializeSchema(undefined)).toEqual({});
    expect(materializeSchema({ observed: 0, typeCounts: {} })).toEqual({});
  });
});

describe('object inference', () => {
  it('describes a flat object', () => {
    expect(schemaOf({ id: 42, name: 'Ada', active: true })).toEqual({
      type: 'object',
      properties: {
        active: { type: 'boolean' },
        id: { type: 'integer' },
        name: { type: 'string' },
      },
    });
  });

  it('describes a nested object', () => {
    expect(
      schemaOf({ user: { id: 42, profile: { avatar: 'https://example.com/a.png' } } }),
    ).toEqual({
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            profile: {
              type: 'object',
              properties: { avatar: { type: 'string', format: 'uri' } },
            },
          },
        },
      },
    });
  });

  it('sorts properties regardless of how the body was written', () => {
    const first = schemaOf({ zebra: 1, alpha: 2, middle: 3 });
    const second = schemaOf({ middle: 3, zebra: 1, alpha: 2 });

    expect(Object.keys(first.properties ?? {})).toEqual(['alpha', 'middle', 'zebra']);
    expect(second).toEqual(first);
  });

  it('counts presence per property across samples', () => {
    const evidence = evidenceOf({ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3 });

    expect(evidence.object?.objectSamples).toBe(3);
    expect(evidence.object?.properties.id?.present).toBe(3);
    expect(evidence.object?.properties.name?.present).toBe(2);
  });

  it('keeps sensitive property names, which are schema, not secrets', () => {
    const schema = schemaOf({ password: 'hunter2', access_token: 'abc' });

    expect(Object.keys(schema.properties ?? {})).toEqual(['access_token', 'password']);
  });

  it('does not touch Object.prototype when a body carries prototype keys', () => {
    const body = JSON.parse(
      '{"__proto__":{"x":true},"constructor":{"value":1},"prototype":"hello"}',
    ) as unknown;

    const schema = schemaOf(body);

    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('x');
    expect(Object.keys(schema.properties ?? {})).toEqual(['__proto__', 'constructor', 'prototype']);
  });
});

describe('requiredness', () => {
  it('needs three samples before calling anything required', () => {
    expect(schemaOf({ id: 1 }, { id: 2 }).required).toBeUndefined();
    expect(schemaOf({ id: 1 }, { id: 2 }, { id: 3 }).required).toEqual(['id']);
  });

  it('demotes a property as soon as one sample omits it', () => {
    const three = schemaOf({ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' });
    expect(three.required).toEqual(['id', 'name']);

    const four = schemaOf(
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
      { id: 3, name: 'C' },
      { id: 4 },
    );
    expect(four.required).toEqual(['id']);
  });

  it('works for sensitive fields too', () => {
    const schema = schemaOf({ password: 'a' }, { password: 'b' }, { password: 'c' });

    expect(schema.required).toEqual(['password']);
    expect(schema.properties?.password).toEqual({ type: 'string' });
  });

  it('refuses to call anything required when a sample was truncated', () => {
    const limits = { ...DEFAULT_SCHEMA_LIMITS, maxProperties: 2 };
    const wide = { a: 1, b: 2, c: 3 };

    const evidence = mergeAll([
      inferSchemaEvidence(wide, limits),
      inferSchemaEvidence(wide, limits),
      inferSchemaEvidence(wide, limits),
    ]);

    // Some properties were never looked at, so no property can be called
    // present in every sample.
    expect(evidence.object?.incompleteSamples).toBe(3);
    expect(materializeSchema(evidence).required).toBeUndefined();
  });

  it('sorts the required list', () => {
    const sample = { zebra: 1, alpha: 2 };
    expect(schemaOf(sample, sample, sample).required).toEqual(['alpha', 'zebra']);
  });
});

describe('array inference', () => {
  it('describes an array of primitives', () => {
    expect(schemaOf([1, 2, 3])).toEqual({
      type: 'array',
      items: { type: 'integer' },
    });
  });

  it('describes an array of objects by merging the items', () => {
    expect(schemaOf([{ id: 1 }, { id: 2, extra: true }])).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: { extra: { type: 'boolean' }, id: { type: 'integer' } },
      },
    });
  });

  it('counts items across array samples', () => {
    const evidence = evidenceOf([1, 2, 3], [4]);

    expect(evidence.array?.arraySamples).toBe(2);
    expect(evidence.array?.nonEmptyArrays).toBe(2);
    expect(evidence.array?.itemsObserved).toBe(4);
  });

  it('promotes integer items to number when a decimal appears', () => {
    expect(schemaOf([1, 2, 3], [4.5])).toEqual({
      type: 'array',
      items: { type: 'number' },
    });
  });

  it('describes nullable items', () => {
    expect(schemaOf(['a', null, 'b'])).toEqual({
      type: 'array',
      items: { type: ['string', 'null'] },
    });
  });

  it('describes mixed items as a stable union', () => {
    expect(schemaOf([1, 'hello', null])).toEqual({
      type: 'array',
      items: {
        oneOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }],
      },
    });
  });

  it('learns items once a non-empty sample arrives', () => {
    expect(schemaOf([], [1])).toEqual({ type: 'array', items: { type: 'integer' } });
  });

  it('counts an empty array without claiming anything about its items', () => {
    const evidence = evidenceOf([]);

    expect(evidence.array?.nonEmptyArrays).toBe(0);
    expect(evidence.array?.items).toBeUndefined();
  });
});

describe('type merging', () => {
  it('folds integer into number when both are seen', () => {
    expect(schemaOf({ price: 12 }, { price: 12.5 }).properties?.price).toEqual({
      type: 'number',
    });
  });

  it('keeps integer when only integers are seen', () => {
    expect(schemaOf({ n: 1 }, { n: 2 }).properties?.n).toEqual({ type: 'integer' });
  });

  it.each([
    [['a', null], { type: ['string', 'null'] }],
    [[1, null], { type: ['integer', 'null'] }],
    [[1.5, null], { type: ['number', 'null'] }],
    [[true, null], { type: ['boolean', 'null'] }],
  ])('makes %j nullable', (samples, expected) => {
    expect(schemaOf(...(samples as unknown[]))).toEqual(expected);
  });

  it('promotes across null and both numeric types', () => {
    expect(schemaOf(1, 2.5, null)).toEqual({ type: ['number', 'null'] });
  });

  it('makes an object nullable without losing its properties', () => {
    expect(schemaOf({ id: 1 }, null)).toEqual({
      type: ['object', 'null'],
      properties: { id: { type: 'integer' } },
    });
  });

  it('unions genuinely incompatible types', () => {
    expect(schemaOf('hello', { nested: true })).toEqual({
      oneOf: [{ type: 'string' }, { type: 'object', properties: { nested: { type: 'boolean' } } }],
    });
  });

  it('unions an array and an object in canonical order', () => {
    expect(schemaOf([1], { a: 1 })).toEqual({
      oneOf: [
        { type: 'array', items: { type: 'integer' } },
        { type: 'object', properties: { a: { type: 'integer' } } },
      ],
    });
  });

  it('puts null last in a multi-type union', () => {
    const schema = schemaOf('a', 1, null);

    expect(schema.oneOf?.at(-1)).toEqual({ type: 'null' });
  });

  it('produces the same union whatever order the samples arrive in', () => {
    expect(schemaOf('a', 1, null)).toEqual(schemaOf(null, 1, 'a'));
    expect(schemaOf(1, null, 'a')).toEqual(schemaOf('a', null, 1));
  });
});

describe('merge order independence', () => {
  const a = { id: 1, name: 'A', tags: ['x'] };
  const b = { id: 2, extra: 1.5 };
  const c = { id: 3, name: 'C', tags: [] };

  it('produces the same evidence in any order', () => {
    const forwards = mergeAll([a, b, c].map((sample) => inferSchemaEvidence(sample)));
    const backwards = mergeAll([c, a, b].map((sample) => inferSchemaEvidence(sample)));

    expect(JSON.stringify(sortedEvidence(backwards))).toBe(
      JSON.stringify(sortedEvidence(forwards)),
    );
    expect(materializeSchema(backwards)).toEqual(materializeSchema(forwards));
  });

  it('does not mutate either input', () => {
    const left = inferSchemaEvidence({ id: 1 });
    const right = inferSchemaEvidence({ name: 'A' });
    const leftBefore = JSON.stringify(left);

    mergeEvidence(left, right);

    expect(JSON.stringify(left)).toBe(leftBefore);
  });
});

/** Property insertion order is not part of the evidence; sort before comparing. */
function sortedEvidence(evidence: SchemaEvidence): unknown {
  const object = evidence.object;

  if (object === undefined) {
    return evidence;
  }

  const properties: Record<string, unknown> = {};
  for (const key of Object.keys(object.properties).sort()) {
    const entry = object.properties[key];
    properties[key] = {
      present: entry?.present,
      evidence: entry === undefined ? undefined : sortedEvidence(entry.evidence),
    };
  }

  return { ...evidence, object: { ...object, properties } };
}

describe('string formats', () => {
  it.each([
    ['550e8400-e29b-41d4-a716-446655440000', 'uuid'],
    ['2026-08-23', 'date'],
    ['2026-08-23T14:30:00Z', 'date-time'],
    ['2026-08-23T17:30:00+03:00', 'date-time'],
    ['dev@example.com', 'email'],
    ['https://example.com/a.png', 'uri'],
    ['192.168.1.1', 'ipv4'],
    ['2001:db8::1', 'ipv6'],
  ])('detects %j as %s', (value, expected) => {
    expect(detectFormat(value, DEFAULT_SCHEMA_LIMITS.maxFormatDetectionLength)).toBe(expected);
  });

  it.each([
    'hello',
    '',
    '2026-02-31',
    '2026-13-01',
    '/users/1',
    'not an email',
    '999.999.999.999',
    '2026-08-23T99:00:00Z',
  ])('finds no format in %j', (value) => {
    expect(detectFormat(value, DEFAULT_SCHEMA_LIMITS.maxFormatDetectionLength)).toBeNull();
  });

  it('materialises a format when every sample matched it', () => {
    expect(
      schemaOf({ email: 'a@example.com' }, { email: 'b@example.com' }).properties?.email,
    ).toEqual({ type: 'string', format: 'email' });
  });

  it('refuses to claim a format when one sample did not match', () => {
    expect(schemaOf({ email: 'a@example.com' }, { email: 'unknown' }).properties?.email).toEqual({
      type: 'string',
    });
  });

  it('refuses to claim a format when samples disagree about which', () => {
    expect(schemaOf({ v: 'a@example.com' }, { v: '2026-08-23' }).properties?.v).toEqual({
      type: 'string',
    });
  });

  it('keeps the format when the field is also nullable', () => {
    expect(
      schemaOf({ avatar: 'https://example.com/a.png' }, { avatar: null }).properties?.avatar,
    ).toEqual({ type: ['string', 'null'], format: 'uri' });
  });

  it('skips format detection on a very long string', () => {
    const long = `${'a'.repeat(3000)}@example.com`;

    expect(detectFormat(long, DEFAULT_SCHEMA_LIMITS.maxFormatDetectionLength)).toBeNull();
    expect(schemaOf(long)).toEqual({ type: 'string' });
  });
});

describe('complexity bounds', () => {
  it('records the type but stops descending past the depth limit', () => {
    let deep: unknown = { leaf: 1 };
    for (let index = 0; index < 30; index += 1) {
      deep = { nested: deep };
    }

    const schema = schemaOf(deep);
    const serialized = JSON.stringify(schema);

    // Reached the limit, said so by naming only the type, and did not overflow.
    expect(serialized).toContain('"type":"object"');
    expect(() => JSON.stringify(schema)).not.toThrow();
  });

  it('inspects a bounded number of properties, chosen deterministically', () => {
    const limits = { ...DEFAULT_SCHEMA_LIMITS, maxProperties: 3 };
    const wide: Record<string, number> = {};
    for (let index = 0; index < 50; index += 1) {
      wide[`key${String(index).padStart(2, '0')}`] = index;
    }

    const first = materializeSchema(inferSchemaEvidence(wide, limits));
    const shuffled = Object.fromEntries(Object.entries(wide).reverse());
    const second = materializeSchema(inferSchemaEvidence(shuffled, limits));

    expect(Object.keys(first.properties ?? {})).toEqual(['key00', 'key01', 'key02']);
    // The same three, whatever order the body serialised them in.
    expect(second).toEqual(first);
  });

  it('inspects a bounded number of array items', () => {
    const limits = { ...DEFAULT_SCHEMA_LIMITS, maxArrayItems: 10 };
    const long = Array.from({ length: 500 }, (_, index) => index);

    const evidence = inferSchemaEvidence(long, limits);

    expect(evidence.array?.itemsObserved).toBe(10);
    expect(evidence.array?.incompleteSamples).toBe(1);
    expect(materializeSchema(evidence)).toEqual({
      type: 'array',
      items: { type: 'integer' },
    });
  });

  it('stops at the total node budget without crashing', () => {
    const limits = { ...DEFAULT_SCHEMA_LIMITS, maxNodes: 20 };
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) {
      wide[`k${String(index)}`] = { nested: index };
    }

    const evidence = inferSchemaEvidence(wide, limits);

    expect(evidence.incomplete === true || evidence.object?.incompleteSamples === 0).toBe(true);
    expect(() => materializeSchema(evidence)).not.toThrow();
  });

  it('skips an absurdly long property name and marks the object incomplete', () => {
    const body = { ok: 1, ['x'.repeat(5000)]: 2 };

    const evidence = inferSchemaEvidence(body);

    expect(Object.keys(evidence.object?.properties ?? {})).toEqual(['ok']);
    expect(evidence.object?.incompleteSamples).toBe(1);
  });

  it('skips a property name carrying control characters', () => {
    const body = JSON.parse('{"ok":1,"bad\\u0000name":2}') as unknown;

    const evidence = inferSchemaEvidence(body);

    expect(Object.keys(evidence.object?.properties ?? {})).toEqual(['ok']);
    expect(evidence.object?.incompleteSamples).toBe(1);
  });

  it('survives a deeply nested array without overflowing the stack', () => {
    let deep: unknown = [1];
    for (let index = 0; index < 1000; index += 1) {
      deep = [deep];
    }

    expect(() => schemaOf(deep)).not.toThrow();
  });
});

describe('no overfitting', () => {
  const FORBIDDEN = [
    'enum',
    'const',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'pattern',
    'additionalProperties',
    'example',
    'examples',
    'default',
  ];

  it('never emits a constraint the traffic did not prove', () => {
    const schema = schemaOf(
      { role: 'admin', version: 'v1', count: 1, tags: ['a'] },
      { role: 'admin', version: 'v1', count: 5, tags: ['b'] },
      { role: 'admin', version: 'v1', count: 10, tags: ['c'] },
    );

    const serialized = JSON.stringify(schema);

    for (const keyword of FORBIDDEN) {
      expect(serialized).not.toContain(`"${keyword}"`);
    }
  });

  it('does not turn a repeated value into an enum', () => {
    expect(schemaOf({ role: 'admin' }, { role: 'admin' }, { role: 'admin' })).toEqual({
      type: 'object',
      properties: { role: { type: 'string' } },
      required: ['role'],
    });
  });

  it('does not turn a single sample into a const', () => {
    expect(schemaOf({ version: 'v1' })).toEqual({
      type: 'object',
      properties: { version: { type: 'string' } },
    });
  });
});

describe('value-free guarantee', () => {
  it('keeps no observed value anywhere in the evidence', () => {
    const evidence = evidenceOf({
      password: 'SCHEMA_SECRET_PASSWORD',
      email: 'schema-secret@example.com',
      access_token: 'SCHEMA_SECRET_TOKEN',
      note: 'an ordinary sentence that is not secret',
      nested: { inner: 'SCHEMA_SECRET_NESTED' },
      list: ['SCHEMA_SECRET_ITEM'],
    });

    const serialized = JSON.stringify(evidence);

    for (const secret of [
      'SCHEMA_SECRET_PASSWORD',
      'schema-secret@example.com',
      'SCHEMA_SECRET_TOKEN',
      'SCHEMA_SECRET_NESTED',
      'SCHEMA_SECRET_ITEM',
      'an ordinary sentence',
    ]) {
      expect(serialized).not.toContain(secret);
    }

    // Property names survive, because they are the schema.
    expect(serialized).toContain('password');
    expect(serialized).toContain('access_token');
  });

  it('preserves the type of a sensitive value that redaction would have hidden', () => {
    const schema = schemaOf({
      password: 'SCHEMA_SECRET_PASSWORD',
      email: 'schema-secret@example.com',
      cvv: 987,
      access_token: 'SCHEMA_SECRET_TOKEN',
    });

    // This is the whole reason inference runs before redaction: after it, `cvv`
    // would read as the string "[REDACTED]" and `email` would lose its format.
    expect(schema).toEqual({
      type: 'object',
      properties: {
        access_token: { type: 'string' },
        cvv: { type: 'integer' },
        email: { type: 'string', format: 'email' },
        password: { type: 'string' },
      },
    });
  });
});
