import type { RawObservation } from '../capture/capture-context.js';
import { parseContentType } from '../capture/content-type.js';
import { classifyPath } from '../inference/path/classify-segment.js';
import { safeDisplayPath } from '../inference/path/normalize-path.js';
import { inferSchemaEvidence } from '../inference/schema/infer-value.js';
import type { SchemaLimits } from '../inference/schema/limits.js';
import { extractSecurityHints } from '../inference/security/infer-security.js';
import type { Redactor } from '../redaction/redact.js';
import type { Storage } from '../storage/storage.js';
import type { IdGenerator } from '../utils/ids.js';
import type {
  DiscoveryResult,
  OperationDiscovery,
  PublicChangeKind,
} from './operation-discovery.js';
import type { SchemaEvidence } from '../inference/schema/types.js';
import { parseCapturedBody, parseStatusOf, type ParsedBody } from './parsed-body.js';
import type { SanitizedBodySummary, SanitizedObservation } from './sanitized-observation.js';

/** One line's worth of what happened, for the terminal. Metadata only. */
export interface ProcessedObservation {
  method: string;
  /** Operation template when one was resolved, otherwise the safe path. */
  displayPath: string;
  statusCode: number | undefined;
  durationMs: number;
  /** True when this request revealed an operation nobody had seen before. */
  discovered: boolean;
  /** False for static assets, preflights and WireQuill's own routes. */
  isOperation: boolean;
  upstreamErrorCode: string | undefined;
}

/**
 * A change a reader of the documentation would notice.
 *
 * Reported only after the transaction that produced it has committed, so a
 * listener that immediately reads the database or the OpenAPI document sees the
 * state the event describes (spec section 60).
 */
export interface PublicChange {
  kind: PublicChangeKind;
  /** Stable operation identity. A hash of workspace, method and template. */
  operationId: string;
  method: string;
  /** Normalized path template, never the request target. */
  path: string;
}

export type ProcessorDiagnostic =
  | { kind: 'parse-failed'; side: 'request' | 'response'; reason: string }
  | { kind: 'schema-failed' }
  | { kind: 'persist-failed' };

export interface ObservationProcessorOptions {
  storage: Storage;
  redactor: Redactor;
  ids: IdGenerator;
  maxDecompressedBytes: number;
  schemaLimits: SchemaLimits;
  /** Resolves which operation an observation belongs to. */
  discovery?: OperationDiscovery | undefined;
  /** Receives the safe result. Future inference phases subscribe here. */
  onSanitized?: ((observation: SanitizedObservation) => void) | undefined;
  /** Receives one summary per processed observation, for the terminal. */
  onProcessed?: ((processed: ProcessedObservation) => void) | undefined;
  /** Receives public contract changes, after the write that caused them. */
  onPublicChange?: ((change: PublicChange) => void) | undefined;
  diagnostics?: ((diagnostic: ProcessorDiagnostic) => void) | undefined;
}

/**
 * Turns a raw capture into safe state (spec sections 63, 50).
 *
 * This is the only place allowed to read a `RawObservation`. It parses in
 * memory, redacts, writes metadata, and releases the raw buffers — in a
 * `finally`, so a thrown parser or a full disk cannot strand reserved memory.
 */
export class ObservationProcessor {
  readonly #options: ObservationProcessorOptions;

  constructor(options: ObservationProcessorOptions) {
    this.#options = options;
  }

  process(raw: RawObservation): void {
    try {
      const sanitized = this.#sanitize(raw);
      const discovery = this.#record(sanitized);

      // After `#record`, which means after COMMIT: a subscriber that reacts by
      // reading the database must not race the write it is reacting to.
      if (discovery !== null && discovery.publicChange !== null) {
        this.#options.onPublicChange?.({
          kind: discovery.publicChange,
          operationId: discovery.operationRowId,
          method: discovery.method,
          path: discovery.pathTemplate,
        });
      }

      this.#options.onSanitized?.(sanitized);
      this.#options.onProcessed?.({
        method: sanitized.method,
        displayPath: discovery?.pathTemplate ?? sanitized.safePath,
        statusCode: sanitized.response.statusCode,
        durationMs: sanitized.durationMs,
        discovered: discovery?.discovered ?? false,
        isOperation: discovery !== null,
        upstreamErrorCode: sanitized.upstreamErrorCode,
      });
    } finally {
      raw.release();
    }
  }

  /**
   * Resolves the operation and stores both writes together.
   *
   * A failure here costs one documentation sample. It must never surface as a
   * request failure, because the response reached the client long ago
   * (spec section 89).
   */
  #record(sanitized: SanitizedObservation): DiscoveryResult | null {
    try {
      return this.#options.storage.runInTransaction(() => {
        const discovery = this.#options.discovery?.apply(sanitized) ?? null;
        this.#persist(sanitized, discovery?.operationRowId ?? null);
        return discovery;
      });
    } catch {
      // Includes a full disk and a classifier that threw on a hostile path.
      this.#options.diagnostics?.({ kind: 'persist-failed' });
      return null;
    }
  }

  #sanitize(raw: RawObservation): SanitizedObservation {
    const { pathname, query } = splitUrl(raw.url);

    // Classified here, inside the boundary, because this is the last place the
    // raw path exists. A credential or an email address in a path segment is
    // reduced to its kind and the value is dropped (spec sections 7 and 8).
    const pathSegments = classifyPath(pathname);

    const requestBody = parseCapturedBody({
      headers: raw.request.headers,
      capture: raw.request.body,
      maxDecompressedBytes: this.#options.maxDecompressedBytes,
      aborted: raw.requestAborted,
    });

    const responseBody = parseCapturedBody({
      headers: raw.response.headers,
      capture: raw.response.body,
      maxDecompressedBytes: this.#options.maxDecompressedBytes,
      aborted: raw.responseAborted,
    });

    this.#reportParse('request', requestBody);
    this.#reportParse('response', responseBody);

    return {
      captureId: raw.captureId,
      sessionId: raw.sessionId,
      observedAt: raw.observedAt,
      method: raw.method,
      pathSegments,
      safePath: safeDisplayPath(pathSegments),
      request: {
        headers: this.#options.redactor.headers(raw.request.headers),
        query: this.#options.redactor.query(query),
        body: this.#summarize(requestBody, raw.request.body),
      },
      response: {
        statusCode: raw.response.statusCode,
        headers:
          raw.response.headers === undefined
            ? {}
            : this.#options.redactor.headers(raw.response.headers),
        body: this.#summarize(responseBody, raw.response.body),
      },
      security: extractSecurityHints(raw.request.headers, query),
      durationMs: raw.durationMs,
      requestAborted: raw.requestAborted,
      responseAborted: raw.responseAborted,
      upstreamErrorCode: raw.upstreamError?.code,
    };
  }

  #summarize(
    parsed: ParsedBody,
    capture:
      | { totalBytes: number; capturedBytes: number; truncated: boolean; budgetExceeded: boolean }
      | undefined,
  ): SanitizedBodySummary {
    const readable = parsed.kind === 'json' || parsed.kind === 'form';

    // Both derived from the same raw value, in this order and nowhere else.
    // Structure is read first, while types and formats still exist; the values
    // are replaced immediately afterwards. Neither step can see the other's
    // output, and the raw value goes no further than this method.
    const schemaEvidence = readable ? this.#inferSchema(parsed.value) : null;
    const redacted = readable ? this.#options.redactor.value(parsed.value) : undefined;

    return {
      // The parsed value itself is dropped from the summary: only the redacted
      // form and the value-free evidence are allowed past this point.
      parsed: stripParsedValue(parsed),
      redacted,
      schemaEvidence,
      totalBytes: capture?.totalBytes ?? 0,
      capturedBytes: capture?.capturedBytes ?? 0,
      truncated: capture?.truncated ?? false,
      budgetExceeded: capture?.budgetExceeded ?? false,
      mediaType: mediaTypeOf(parsed),
      parseStatus: parseStatusOf(parsed),
    };
  }

  #persist(sanitized: SanitizedObservation, operationRowId: string | null): void {
    this.#options.storage.insertObservation({
      id: this.#options.ids.next(),
      sessionId: sanitized.sessionId,
      operationId: operationRowId,
      observedAt: sanitized.observedAt,
      method: sanitized.method,
      statusCode: sanitized.response.statusCode ?? null,
      durationMs: sanitized.durationMs,
      requestContentType: sanitized.request.body.mediaType ?? null,
      responseContentType: sanitized.response.body.mediaType ?? null,
      requestBytes: sanitized.request.body.totalBytes,
      responseBytes: sanitized.response.body.totalBytes,
      requestTruncated: sanitized.request.body.truncated,
      responseTruncated: sanitized.response.body.truncated,
      requestParseStatus: sanitized.request.body.parseStatus,
      responseParseStatus: sanitized.response.body.parseStatus,
      upstreamErrorCode: sanitized.upstreamErrorCode ?? null,
    });
  }

  /**
   * Structural inference must never become a request failure.
   *
   * The response reached the client long before this ran. A bug in the
   * traversal costs one documentation sample and nothing else, and the error is
   * never surfaced verbatim because it could quote the body (spec section 89).
   */
  #inferSchema(value: unknown): SchemaEvidence | null {
    try {
      return inferSchemaEvidence(value, this.#options.schemaLimits);
    } catch {
      this.#options.diagnostics?.({ kind: 'schema-failed' });
      return null;
    }
  }

  #reportParse(side: 'request' | 'response', parsed: ParsedBody): void {
    if (parsed.kind === 'invalid' || parsed.kind === 'truncated') {
      this.#options.diagnostics?.({
        kind: 'parse-failed',
        side,
        reason: parseStatusOf(parsed),
      });
    }
  }
}

/** Keeps the parse outcome but never its value; the redacted copy is the record. */
function stripParsedValue(parsed: ParsedBody): ParsedBody {
  if (parsed.kind === 'json') {
    return { kind: 'json', mediaType: parsed.mediaType, value: undefined };
  }
  if (parsed.kind === 'form') {
    return { kind: 'form', mediaType: parsed.mediaType, value: {} };
  }
  return parsed;
}

function mediaTypeOf(parsed: ParsedBody): string | undefined {
  if (parsed.kind === 'none') {
    return undefined;
  }
  if (parsed.kind === 'json' || parsed.kind === 'form') {
    return parsed.mediaType;
  }
  return parsed.mediaType;
}

function splitUrl(url: string): { pathname: string; query: URLSearchParams } {
  try {
    const parsed = new URL(url, 'http://wirequill.invalid');
    return { pathname: parsed.pathname, query: parsed.searchParams };
  } catch {
    const separator = url.indexOf('?');
    return separator < 0
      ? { pathname: url, query: new URLSearchParams() }
      : {
          pathname: url.slice(0, separator),
          query: new URLSearchParams(url.slice(separator + 1)),
        };
  }
}

/** Re-exported so callers can normalise a media type without reaching into capture. */
export { parseContentType };
