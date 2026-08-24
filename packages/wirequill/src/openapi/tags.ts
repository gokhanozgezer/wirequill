import { titleCase } from './summaries.js';

/**
 * Groups operations under the resource they belong to (spec section 82).
 *
 * Derived from the path template alone, never from evidence, so a tag cannot
 * change because traffic arrived in a different order or because the process
 * restarted.
 */

/** Segments that name a namespace rather than a resource. */
const SKIPPED = new Set([
  'api',
  'rest',
  'internal',
  'public',
  'private',
  'graphql',
  'webhook',
  'webhooks',
]);

const PARAMETER = /^\{.+\}$/;
const VERSION = /^v[0-9]+$/i;

export function buildTags(pathTemplate: string): string[] {
  const segments = pathTemplate.split('/').filter((segment) => segment !== '');

  for (const segment of segments) {
    if (PARAMETER.test(segment) || VERSION.test(segment) || SKIPPED.has(segment.toLowerCase())) {
      continue;
    }

    return [titleCase(segment)];
  }

  // Nothing but namespaces and parameters: better untagged than mislabelled.
  return [];
}
