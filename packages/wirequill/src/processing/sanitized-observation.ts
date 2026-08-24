import type { SanitizedPathSegment } from '../inference/path/types.js';
import type { SchemaEvidence } from '../inference/schema/types.js';
import type { SecurityHints } from '../inference/security/types.js';
import type { ParsedBody } from './parsed-body.js';

/**
 * The safe boundary (spec section 56).
 *
 * Everything upstream of this type — `CaptureContext`, `RawObservation` — holds
 * traffic verbatim. Everything downstream of it — storage, endpoint discovery,
 * and every inference phase still to come — sees only this. Sensitive field
 * values, header values, query values and path segments have already been
 * replaced, and no raw `Buffer` survives.
 *
 * If a future phase needs something that is not on this type, the answer is to
 * add it here after redaction, not to reach back for the raw observation.
 */
export interface SanitizedBodySummary {
  parsed: ParsedBody;
  /** Redacted structure, present only for bodies that parsed. */
  redacted: unknown;
  /**
   * Value-free structural evidence, inferred from the body *before* redaction.
   *
   * This is the only way types survive: a redacted `cvv: 123` reads as the
   * string `"[REDACTED]"`, and an email loses its format. Inferring first and
   * redacting second keeps both facts without keeping either value.
   *
   * `null` when the body could not be read at all — truncated, malformed, or a
   * media type WireQuill does not parse.
   */
  schemaEvidence: SchemaEvidence | null;
  totalBytes: number;
  capturedBytes: number;
  truncated: boolean;
  budgetExceeded: boolean;
  mediaType: string | undefined;
  parseStatus: string;
}

export interface SanitizedObservation {
  captureId: string;
  sessionId: string;
  observedAt: string;

  method: string;

  /**
   * The request path, segment by segment, already classified.
   *
   * A segment holding a credential or an email address is reduced to its kind,
   * so the raw value stops here. There is deliberately no field carrying the
   * original path: `/reset/<jwt>` must not survive into anything downstream.
   */
  pathSegments: SanitizedPathSegment[];

  /**
   * A path safe to print or store before an operation has been resolved.
   * Sensitive segments read `[REDACTED]`.
   */
  safePath: string;

  request: {
    headers: Record<string, unknown>;
    query: Record<string, string | string[]>;
    body: SanitizedBodySummary;
  };

  response: {
    statusCode: number | undefined;
    headers: Record<string, unknown>;
    body: SanitizedBodySummary;
  };

  /** Authentication structure, carrying no credential. */
  security: SecurityHints;

  durationMs: number;
  requestAborted: boolean;
  responseAborted: boolean;
  upstreamErrorCode: string | undefined;
}
