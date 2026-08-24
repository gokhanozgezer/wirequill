import { singularize } from '../inference/path/singularize.js';

/**
 * Deterministic operation summaries (spec sections 78, 79).
 *
 * No AI, no guessing at intent. A summary is a readable restatement of the
 * method and the path, and where the path does not say what an endpoint does,
 * neither does the summary.
 */

/** Actions that stand on their own: `POST /auth/login` is "Login", not "Login Auth". */
const STANDALONE_ACTIONS = new Set([
  'login',
  'logout',
  'signin',
  'signout',
  'signup',
  'register',
  'refresh',
  'callback',
  'search',
  'health',
  'healthz',
  'status',
  'metrics',
  'ready',
  'readiness',
  'live',
  'liveness',
  'me',
  'current',
  'self',
  'summary',
  'stats',
]);

/** Actions performed on a resource: `POST /orders/{orderId}/cancel` is "Cancel Order". */
const RESOURCE_ACTIONS = new Set([
  'activate',
  'deactivate',
  'archive',
  'restore',
  'cancel',
  'publish',
  'unpublish',
  'verify',
  'approve',
  'reject',
  'export',
  'import',
  'validate',
  'preview',
  'sync',
  'duplicate',
  'clone',
  'reset',
  'forgot',
  'settings',
  'preferences',
]);

const PARAMETER = /^\{(.+)\}$/;

export function buildSummary(method: string, pathTemplate: string): string {
  const segments = pathTemplate.split('/').filter((segment) => segment !== '');
  const verb = method.toUpperCase();
  const last = segments.at(-1);

  if (last === undefined) {
    return fallback(verb, pathTemplate);
  }

  if (PARAMETER.test(last)) {
    return itemSummary(verb, segments) ?? fallback(verb, pathTemplate);
  }

  const action = last.toLowerCase();

  if (STANDALONE_ACTIONS.has(action)) {
    return titleCase(action);
  }

  if (RESOURCE_ACTIONS.has(action)) {
    const resource = nearestResource(segments, segments.length - 1);
    return resource === null
      ? titleCase(action)
      : `${titleCase(action)} ${titleCase(singularize(resource))}`;
  }

  return collectionSummary(verb, last) ?? fallback(verb, pathTemplate);
}

/** The path ends in an identifier, so the operation acts on one thing. */
function itemSummary(verb: string, segments: readonly string[]): string | null {
  const resource = nearestResource(segments, segments.length - 1);

  if (resource === null) {
    return null;
  }

  const noun = titleCase(singularize(resource));

  switch (verb) {
    case 'GET':
      return `Get ${noun}`;
    case 'PUT':
    case 'PATCH':
      return `Update ${noun}`;
    case 'DELETE':
      return `Delete ${noun}`;
    case 'POST':
      return `Create ${noun}`;
    case 'HEAD':
      return `Check ${noun}`;
    default:
      return null;
  }
}

/** The path ends in a resource name, so the operation acts on the collection. */
function collectionSummary(verb: string, resource: string): string | null {
  const plural = titleCase(resource);
  const singular = titleCase(singularize(resource));

  switch (verb) {
    case 'GET':
      return `List ${plural}`;
    case 'POST':
      return `Create ${singular}`;
    case 'PUT':
    case 'PATCH':
      return `Update ${plural}`;
    case 'DELETE':
      return `Delete ${plural}`;
    case 'HEAD':
      return `Check ${plural}`;
    default:
      return null;
  }
}

/**
 * Walks back for the resource a segment belongs to, stepping over parameters
 * and over namespace segments that name nothing.
 */
function nearestResource(segments: readonly string[], from: number): string | null {
  for (let index = from - 1; index >= 0; index -= 1) {
    const segment = segments[index];

    if (segment === undefined || PARAMETER.test(segment)) {
      continue;
    }

    if (isNamespace(segment)) {
      continue;
    }

    return segment;
  }

  return null;
}

const NAMESPACES = new Set(['api', 'rest', 'internal', 'public', 'private', 'auth', 'graphql']);

function isNamespace(segment: string): boolean {
  return NAMESPACES.has(segment.toLowerCase()) || /^v[0-9]+$/i.test(segment);
}

/**
 * When the path does not say what the endpoint does, the summary says only what
 * is certain: the method and the path (spec section 80).
 */
function fallback(verb: string, pathTemplate: string): string {
  return `${verb} ${pathTemplate}`;
}

export function titleCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}
