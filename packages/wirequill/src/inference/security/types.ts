/**
 * Structural facts about authentication, carrying no credential
 * (spec sections 40, 38).
 *
 * These are produced inside the sanitization boundary, where the real header is
 * still in memory, and are the only thing that crosses out of it. Later phases
 * learn that an endpoint uses bearer authentication; they never learn the
 * token, and they have no path back to it.
 */
export interface SecurityHints {
  authorization?:
    | {
        scheme: 'bearer' | 'basic' | 'other';
      }
    | undefined;
  /** Lower-case names of headers that looked like an API key. */
  apiKeyHeaders: string[];
  /** Names of query parameters that looked like an API key. */
  apiKeyQueryParameters: string[];
}

export function emptySecurityHints(): SecurityHints {
  return { apiKeyHeaders: [], apiKeyQueryParameters: [] };
}
