import type { SecurityEvidence } from '../inference/operation/types.js';
import { canonicalHeaderName } from './build-parameters.js';
import type { OpenApiSecurityRequirement, OpenApiSecurityScheme } from './types.js';

/**
 * Security schemes and requirements (spec sections 84 to 86).
 *
 * Two separate questions, answered differently. *Which schemes exist* is
 * descriptive and safe to report from any observation. *Which scheme an
 * operation requires* is a claim about the API's contract, and WireQuill only
 * makes it when the traffic leaves no room for doubt.
 */

export interface SecurityResult {
  schemes: Record<string, OpenApiSecurityScheme>;
  /** Absent when observations disagreed or were too few to conclude anything. */
  requirement: OpenApiSecurityRequirement[] | undefined;
}

export const BEARER_SCHEME = 'bearerAuth';
export const BASIC_SCHEME = 'basicAuth';

/** Samples needed before a requirement may be claimed (spec section 86). */
export const SECURITY_MINIMUM_SAMPLES = 3;

export function buildSecurity(evidence: SecurityEvidence, observedCount: number): SecurityResult {
  const schemes: Record<string, OpenApiSecurityScheme> = {};

  if (evidence.bearer > 0) {
    schemes[BEARER_SCHEME] = { type: 'http', scheme: 'bearer' };
  }

  if (evidence.basic > 0) {
    schemes[BASIC_SCHEME] = { type: 'http', scheme: 'basic' };
  }

  for (const [name, usage] of Object.entries(evidence.apiKeys)) {
    if (usage.count > 0) {
      schemes[apiKeySchemeName(name, usage.location)] = {
        type: 'apiKey',
        in: usage.location,
        name: usage.location === 'header' ? canonicalHeaderName(name) : name,
      };
    }
  }

  return { schemes, requirement: deriveRequirement(evidence, observedCount) };
}

/**
 * A requirement is claimed only when one mechanism covered every observation.
 *
 * Anything else is left out. An endpoint seen five times with a bearer token
 * and once without is not documented as requiring one — that sixth request is
 * evidence the endpoint is reachable anonymously, and hiding it would send a
 * reader looking for an authentication bug that does not exist.
 *
 * Several mechanisms used together are also left out rather than combined:
 * whether they were required together or interchangeably is not visible from
 * traffic, and guessing either way would be a claim (spec section 87).
 */
function deriveRequirement(
  evidence: SecurityEvidence,
  observedCount: number,
): OpenApiSecurityRequirement[] | undefined {
  if (observedCount < SECURITY_MINIMUM_SAMPLES || evidence.unauthenticated > 0) {
    return undefined;
  }

  const used: string[] = [];

  if (evidence.bearer > 0) {
    used.push(BEARER_SCHEME);
  }
  if (evidence.basic > 0) {
    used.push(BASIC_SCHEME);
  }
  for (const [name, usage] of Object.entries(evidence.apiKeys)) {
    if (usage.count > 0) {
      used.push(apiKeySchemeName(name, usage.location));
    }
  }

  if (used.length !== 1) {
    return undefined;
  }

  const only = used[0];
  if (only === undefined) {
    return undefined;
  }

  // The single mechanism must also have covered every observation, not merely
  // been the only one seen.
  const coverage =
    evidence.bearer +
    evidence.basic +
    Object.values(evidence.apiKeys).reduce((total, usage) => total + usage.count, 0);

  return coverage === observedCount ? [{ [only]: [] }] : undefined;
}

/**
 * A stable, reference-safe scheme name.
 *
 * OpenAPI component keys are restricted to `[A-Za-z0-9._-]`, and a header name
 * can contain characters outside that set.
 */
export function apiKeySchemeName(name: string, location: 'header' | 'query'): string {
  const sanitized = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return `apiKey_${location}_${sanitized}`;
}
