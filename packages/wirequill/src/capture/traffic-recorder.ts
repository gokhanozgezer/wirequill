import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { toIsoString, type Clock } from '../utils/clock.js';
import type { IdGenerator } from '../utils/ids.js';
import { BoundedBodyCapture, MetadataOnlyBodyCapture, type BodyCapture } from './body-capture.js';
import type { CaptureBudget } from './capture-budget.js';
import type { CaptureContext, RawObservation } from './capture-context.js';
import {
  classifyMediaType,
  parseContentType,
  shouldRetainBody,
  type MediaKind,
} from './content-type.js';

/** Safe diagnostic reasons surfaced under `--verbose`. Never carries a value. */
export type CaptureDiagnostic =
  | { kind: 'request-truncated'; limitBytes: number }
  | { kind: 'response-truncated'; limitBytes: number }
  | { kind: 'budget-exceeded'; side: 'request' | 'response' }
  | { kind: 'body-skipped'; side: 'request' | 'response'; mediaKind: MediaKind };

export interface TrafficRecorderOptions {
  sessionId: string;
  budget: CaptureBudget;
  maxBodyBytes: number;
  clock: Clock;
  ids: IdGenerator;
  /** Receives the completed observation and takes ownership of releasing it. */
  sink: (observation: RawObservation) => void;
  diagnostics?: ((diagnostic: CaptureDiagnostic) => void) | undefined;
}

/**
 * Builds a bounded copy of the traffic the proxy is forwarding.
 *
 * The recorder is told what happened; it never reaches into a stream itself.
 * That keeps the decision about *where* it is safe to observe in the proxy,
 * next to the transport it has to stay compatible with.
 */
export class TrafficRecorder {
  readonly #options: TrafficRecorderOptions;

  constructor(options: TrafficRecorderOptions) {
    this.#options = options;
  }

  begin(req: IncomingMessage): CaptureContext {
    const { kind, declared } = mediaKindOf(req.headers);

    return {
      id: this.#options.ids.next(),
      startedAt: process.hrtime.bigint(),
      observedAt: toIsoString(this.#options.clock.now()),
      method: req.method ?? 'GET',
      originalUrl: req.url ?? '/',
      requestHeaders: req.headers,
      requestBody: this.#createCapture(kind, declared, 'request'),
      requestAborted: false,
      responseAborted: false,
      settled: false,
    };
  }

  observeRequestChunk(context: CaptureContext, chunk: Buffer): void {
    context.requestBody.observe(chunk);
  }

  beginResponse(context: CaptureContext, proxyRes: IncomingMessage): void {
    const { kind, declared } = mediaKindOf(proxyRes.headers);

    context.responseStatus = proxyRes.statusCode;
    context.responseHeaders = proxyRes.headers;
    context.responseBody = this.#createCapture(kind, declared, 'response');
  }

  observeResponseChunk(context: CaptureContext, chunk: Buffer): void {
    context.responseBody?.observe(chunk);
  }

  markRequestAborted(context: CaptureContext): void {
    context.requestAborted = true;
  }

  markResponseAborted(context: CaptureContext): void {
    context.responseAborted = true;
  }

  markUpstreamError(context: CaptureContext, code: string): void {
    context.upstreamError = { code };
  }

  /** Finalises the capture and hands it to the sink. Safe to call twice. */
  finish(context: CaptureContext, outcome: { statusCode?: number | undefined }): void {
    if (context.settled) {
      return;
    }
    context.settled = true;

    const requestResult = context.requestBody.finish();
    const responseResult = context.responseBody?.finish();

    this.#reportLimits(requestResult, responseResult);

    const observation: RawObservation = {
      captureId: context.id,
      sessionId: this.#options.sessionId,
      observedAt: context.observedAt,
      method: context.method,
      url: context.originalUrl,
      request: {
        headers: context.requestHeaders,
        body: requestResult,
      },
      response: {
        statusCode: outcome.statusCode ?? context.responseStatus,
        headers: context.responseHeaders,
        body: responseResult,
      },
      durationMs: elapsedMs(context.startedAt),
      requestAborted: context.requestAborted,
      responseAborted: context.responseAborted,
      upstreamError: context.upstreamError,
      release: () => {
        context.requestBody.release();
        context.responseBody?.release();
      },
    };

    this.#options.sink(observation);
  }

  /** Abandons a capture without producing an observation, releasing memory. */
  discard(context: CaptureContext): void {
    if (context.settled) {
      return;
    }
    context.settled = true;
    context.requestBody.release();
    context.responseBody?.release();
  }

  #createCapture(kind: MediaKind, declared: boolean, side: 'request' | 'response'): BodyCapture {
    if (!shouldRetainBody(kind)) {
      // A message with no Content-Type at all usually has no body either, and
      // reporting a skip for every such GET would bury the diagnostics that
      // matter.
      if (declared) {
        this.#options.diagnostics?.({ kind: 'body-skipped', side, mediaKind: kind });
      }
      return new MetadataOnlyBodyCapture();
    }

    return new BoundedBodyCapture({
      limitBytes: this.#options.maxBodyBytes,
      budget: this.#options.budget,
    });
  }

  #reportLimits(
    request: { truncated: boolean; budgetExceeded: boolean },
    response: { truncated: boolean; budgetExceeded: boolean } | undefined,
  ): void {
    const report = this.#options.diagnostics;
    if (report === undefined) {
      return;
    }

    if (request.truncated) {
      report({ kind: 'request-truncated', limitBytes: this.#options.maxBodyBytes });
    }
    if (request.budgetExceeded) {
      report({ kind: 'budget-exceeded', side: 'request' });
    }
    if (response?.truncated === true) {
      report({ kind: 'response-truncated', limitBytes: this.#options.maxBodyBytes });
    }
    if (response?.budgetExceeded === true) {
      report({ kind: 'budget-exceeded', side: 'response' });
    }
  }
}

function mediaKindOf(headers: IncomingHttpHeaders): { kind: MediaKind; declared: boolean } {
  const contentType = parseContentType(headerValue(headers['content-type']));
  return {
    kind: classifyMediaType(contentType?.mediaType),
    declared: contentType !== null,
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}
