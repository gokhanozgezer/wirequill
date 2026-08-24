import type { OpenApiDocument, WireQuillSummary } from './types.js';

/**
 * Talking to the docs server.
 *
 * Every URL here is relative, and that is not a style choice. The docs port is
 * configurable — `--docs-port 3456` has to work — and the page is always served
 * by the same server it queries, so a relative path is both correct and the
 * only thing that stays correct (spec sections 112 to 114).
 */

export const SUMMARY_URL = '/__wirequill/api/summary';
export const EVENTS_URL = '/__wirequill/events';
export const OPENAPI_URL = '/openapi.json';

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    // The document changes as traffic arrives; a cached copy is always the
    // wrong answer here.
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  });

  if (!response.ok) {
    throw new Error(`${url} responded ${String(response.status)}`);
  }

  return (await response.json()) as T;
}

export function fetchSummary(signal?: AbortSignal): Promise<WireQuillSummary> {
  return getJson<WireQuillSummary>(SUMMARY_URL, signal);
}

export function fetchOpenApiDocument(signal?: AbortSignal): Promise<OpenApiDocument> {
  return getJson<OpenApiDocument>(OPENAPI_URL, signal);
}
