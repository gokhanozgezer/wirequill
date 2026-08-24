import { singularize } from './singularize.js';
import type { NormalizedPath, PathParameterSlot, SanitizedPathSegment } from './types.js';

/**
 * Turns classified segments into an operation's path template
 * (spec sections 31, 34, 35).
 *
 * Works from `SanitizedPathSegment[]` rather than a raw path, so a sensitive
 * segment is already reduced to its kind before naming ever happens.
 */

/** What a dynamic segment is called when its kind names it better than its resource. */
const KIND_NAMES: Partial<Record<SanitizedPathSegment['kind'], string>> = {
  date: 'date',
  email: 'email',
  token: 'token',
};

export function normalizePath(segments: readonly SanitizedPathSegment[]): NormalizedPath {
  const parameters: PathParameterSlot[] = [];
  const used = new Map<string, number>();
  const rendered: string[] = [];

  segments.forEach((segment, index) => {
    if (segment.kind === 'literal') {
      rendered.push(segment.value ?? '');
      return;
    }

    const name = uniqueName(nameFor(segments, index), used);

    parameters.push({ name, position: index, kind: segment.kind });
    rendered.push(`{${name}}`);
  });

  return {
    template: rendered.length === 0 ? '/' : `/${rendered.join('/')}`,
    parameters,
  };
}

/**
 * Names a parameter after the resource that precedes it.
 *
 * `/users/123` is the identifier of a user, so `userId`. A date, an email or a
 * token is named after what it is instead, because `/reports/2026-08-23` is not
 * a report identifier.
 */
function nameFor(segments: readonly SanitizedPathSegment[], index: number): string {
  const segment = segments[index];
  const kindName = segment === undefined ? undefined : KIND_NAMES[segment.kind];

  if (kindName !== undefined) {
    return kindName;
  }

  const resource = previousLiteral(segments, index);

  if (resource === null) {
    // Nothing to name it after: `/123` on its own.
    return 'id';
  }

  return `${toCamelCase(singularize(resource))}Id`;
}

/**
 * Walks back to the nearest literal segment.
 *
 * `/carts/1/items/2` names the second parameter after `items`, not after the
 * cart identifier that happens to sit between them.
 */
function previousLiteral(segments: readonly SanitizedPathSegment[], index: number): string | null {
  for (let position = index - 1; position >= 0; position -= 1) {
    const candidate = segments[position];

    if (candidate?.kind === 'literal') {
      const value = candidate.value ?? '';
      if (value !== '') {
        return value;
      }
    }
  }

  return null;
}

/**
 * Keeps names unique within one template.
 *
 * `/resources/1/resources/2` yields `resourceId` and `resourceId2`, which is
 * stable: the same path always produces the same pair.
 */
function uniqueName(base: string, used: Map<string, number>): string {
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);

  return seen === 0 ? base : `${base}${String(seen + 1)}`;
}

function toCamelCase(value: string): string {
  const parts = value.split(/[^A-Za-z0-9]+/).filter((part) => part !== '');

  if (parts.length === 0) {
    return 'resource';
  }

  const [first, ...rest] = parts;

  return [
    (first ?? '').toLowerCase(),
    ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()),
  ].join('');
}

/**
 * A path safe to print or store before an operation has been resolved.
 *
 * Sensitive segments become `[REDACTED]` rather than their value, so a log line
 * written early — an upstream failure, a dropped observation — still cannot
 * leak a credential from the request target (spec section 10).
 */
export function safeDisplayPath(segments: readonly SanitizedPathSegment[]): string {
  if (segments.length === 0) {
    return '/';
  }

  const rendered = segments.map((segment) =>
    segment.sensitive ? '[REDACTED]' : (segment.value ?? '[REDACTED]'),
  );

  return `/${rendered.join('/')}`;
}
