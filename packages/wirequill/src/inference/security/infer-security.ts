import type { IncomingHttpHeaders } from 'node:http';
import { isApiKeyHeader, isApiKeyQueryName } from '../parameters/infer-headers.js';
import { emptySecurityHints, type SecurityHints } from './types.js';
import type { SecurityEvidence } from '../operation/types.js';

/**
 * Reads authentication structure out of raw headers (spec sections 40, 39).
 *
 * Called from inside the sanitizer, which is the last place the real
 * `Authorization` header exists. Only the scheme survives — the credential is
 * read, matched against a prefix, and dropped.
 */
export function extractSecurityHints(
  headers: IncomingHttpHeaders,
  query: URLSearchParams,
): SecurityHints {
  const hints = emptySecurityHints();

  const authorization = firstValue(headers.authorization);
  if (authorization !== undefined && authorization.trim() !== '') {
    hints.authorization = { scheme: schemeOf(authorization) };
  }

  for (const name of Object.keys(headers)) {
    if (isApiKeyHeader(name)) {
      hints.apiKeyHeaders.push(name.toLowerCase());
    }
  }

  for (const name of new Set(query.keys())) {
    if (isApiKeyQueryName(name)) {
      hints.apiKeyQueryParameters.push(name);
    }
  }

  // Deterministic order, so identical traffic produces identical evidence.
  hints.apiKeyHeaders.sort();
  hints.apiKeyQueryParameters.sort();

  return hints;
}

function schemeOf(authorization: string): 'bearer' | 'basic' | 'other' {
  const scheme = authorization.trim().split(/\s+/, 1)[0]?.toLowerCase();

  if (scheme === 'bearer') {
    return 'bearer';
  }
  if (scheme === 'basic') {
    return 'basic';
  }

  return 'other';
}

/** Folds one request's hints into an operation's running evidence. */
export function mergeSecurityEvidence(
  evidence: SecurityEvidence,
  hints: SecurityHints,
): SecurityEvidence {
  const merged: SecurityEvidence = {
    bearer: evidence.bearer,
    basic: evidence.basic,
    other: evidence.other,
    apiKeys: { ...evidence.apiKeys },
    unauthenticated: evidence.unauthenticated,
  };

  const scheme = hints.authorization?.scheme;
  if (scheme === 'bearer') {
    merged.bearer += 1;
  } else if (scheme === 'basic') {
    merged.basic += 1;
  } else if (scheme === 'other') {
    merged.other += 1;
  }

  for (const name of hints.apiKeyHeaders) {
    countApiKey(merged, name, 'header');
  }
  for (const name of hints.apiKeyQueryParameters) {
    countApiKey(merged, name, 'query');
  }

  const authenticated =
    scheme !== undefined ||
    hints.apiKeyHeaders.length > 0 ||
    hints.apiKeyQueryParameters.length > 0;

  if (!authenticated) {
    merged.unauthenticated += 1;
  }

  return merged;
}

function countApiKey(evidence: SecurityEvidence, name: string, location: 'header' | 'query'): void {
  const existing = evidence.apiKeys[name];

  evidence.apiKeys[name] = {
    location,
    count: (existing?.count ?? 0) + 1,
  };
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
