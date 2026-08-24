import type { IncomingHttpHeaders } from 'node:http';
import type { BodyCapture, BodyCaptureResult } from './body-capture.js';

/**
 * ============================ SENSITIVE ============================
 *
 * Everything in this file holds traffic exactly as it crossed the wire:
 * passwords, bearer tokens, cookies, session identifiers, personal data.
 *
 * A `CaptureContext` and the `RawObservation` it produces must NEVER be
 * logged, stringified, stored, attached to an error, or handed to anything
 * outside the processing pipeline. They exist only long enough to be parsed
 * and redacted, and the safe result of that is `SanitizedObservation`.
 *
 * Forbidden, without exception:
 *
 *   console.log(rawObservation)
 *   JSON.stringify(rawObservation)
 *   logger.debug(rawObservation)
 *   storage.insert(rawObservation)
 *
 * ==================================================================
 */

/** SENSITIVE. Live capture state for one in-flight request. */
export interface CaptureContext {
  id: string;
  /** Monotonic start, for duration. Not a wall-clock timestamp. */
  startedAt: bigint;
  observedAt: string;

  method: string;
  /** Full request target including the query string. SENSITIVE. */
  originalUrl: string;

  requestHeaders: IncomingHttpHeaders;
  requestBody: BodyCapture;

  responseStatus?: number | undefined;
  responseHeaders?: IncomingHttpHeaders | undefined;
  responseBody?: BodyCapture | undefined;

  requestAborted: boolean;
  responseAborted: boolean;

  upstreamError?: { code: string } | undefined;

  /** Set once the observation has been handed on or discarded. */
  settled: boolean;
}

/**
 * SENSITIVE. A completed capture, handed to the processing queue and released
 * as soon as it has been parsed and redacted.
 */
export interface RawObservation {
  captureId: string;
  sessionId: string;
  observedAt: string;

  method: string;
  /** Full request target including the query string. SENSITIVE. */
  url: string;

  request: {
    headers: IncomingHttpHeaders;
    body: BodyCaptureResult;
  };

  response: {
    statusCode: number | undefined;
    headers: IncomingHttpHeaders | undefined;
    body: BodyCaptureResult | undefined;
  };

  durationMs: number;

  requestAborted: boolean;
  responseAborted: boolean;

  upstreamError: { code: string } | undefined;

  /**
   * Returns the memory reserved by both bodies. The processor must call this in
   * a `finally`, whatever else happens.
   */
  release(): void;
}
