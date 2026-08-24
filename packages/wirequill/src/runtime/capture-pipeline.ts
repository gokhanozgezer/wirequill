import type { Output } from '../cli/output.js';
import type { WireQuillConfig } from '../config/types.js';
import { InMemoryCaptureBudget, type CaptureBudget } from '../capture/capture-budget.js';
import type { RawObservation } from '../capture/capture-context.js';
import { TrafficRecorder, type CaptureDiagnostic } from '../capture/traffic-recorder.js';
import {
  ObservationProcessor,
  type ProcessedObservation,
  type ProcessorDiagnostic,
  type PublicChange,
} from '../processing/observation-processor.js';
import { OperationDiscovery } from '../processing/operation-discovery.js';
import { staticExtensionsFromConfig } from '../processing/static-assets.js';
import { ProcessingQueue } from '../processing/processing-queue.js';
import { ExampleService } from '../examples/example-service.js';
import { DEFAULT_SCHEMA_LIMITS } from '../inference/schema/limits.js';
import type { SanitizedObservation } from '../processing/sanitized-observation.js';
import { createRedactor } from '../redaction/redact.js';
import type { Storage } from '../storage/storage.js';
import type { Clock } from '../utils/clock.js';
import type { IdGenerator } from '../utils/ids.js';
import { RateLimiter } from '../utils/rate-limiter.js';

const PRESSURE_WARNING_WINDOW_MS = 30_000;

export interface CapturePipelineOptions {
  config: WireQuillConfig;
  sessionId: string;
  /** Operations accumulate per workspace, not per session. */
  workspaceId: string;
  /**
   * Called when an operation's public shape changed, after the transaction that
   * changed it committed. The runtime invalidates the document and publishes an
   * event from here.
   */
  onPublicChange?: ((change: PublicChange) => void) | undefined;
  storage: Storage;
  output: Output;
  clock: Clock;
  ids: IdGenerator;
  /** Receives every safe observation. Later phases subscribe here. */
  onSanitized?: ((observation: SanitizedObservation) => void) | undefined;
  /** Receives one summary per processed observation, for the terminal. */
  onProcessed?: ((processed: ProcessedObservation) => void) | undefined;
  /** Overridden in tests to make queue processing deterministic. */
  schedule?: ((task: () => void) => void) | undefined;
}

export interface CapturePipelineStats {
  processed: number;
  dropped: number;
  failed: number;
  pending: number;
  reservedBytes: number;
}

/**
 * Wires capture, queueing, parsing, redaction and persistence together.
 *
 * Assembled here rather than in the runtime so the whole observation path can
 * be built and exercised in a test without a socket, and so the runtime keeps
 * describing startup order rather than plumbing.
 */
export class CapturePipeline {
  readonly #budget: CaptureBudget;
  readonly #queue: ProcessingQueue<RawObservation>;
  readonly #recorder: TrafficRecorder;
  readonly #output: Output;
  readonly #verbose: boolean;
  readonly #pressureLimiter: RateLimiter;

  constructor(options: CapturePipelineOptions) {
    const { config } = options;

    this.#output = options.output;
    this.#verbose = config.verbose;
    this.#pressureLimiter = new RateLimiter(PRESSURE_WARNING_WINDOW_MS, options.clock);
    this.#budget = new InMemoryCaptureBudget(config.capture.globalCaptureBudgetBytes);

    const discovery = new OperationDiscovery({
      storage: options.storage,
      workspaceId: options.workspaceId,
      examples: new ExampleService({
        storage: options.storage,
        ids: options.ids,
        clock: options.clock,
        maxPerBucket: config.storage.maxExamplesPerBucket,
      }),
      buildOptions: {
        materialize: { requiredAfterSamples: config.inference.requiredAfterSamples },
        requiredAfterSamples: config.inference.requiredAfterSamples,
      },
      ignoreMethods: config.capture.ignoreMethods,
      staticExtensions: staticExtensionsFromConfig(config.capture.exclude),
    });

    const processor = new ObservationProcessor({
      storage: options.storage,
      redactor: createRedactor(config.redaction),
      ids: options.ids,
      maxDecompressedBytes: config.capture.maxDecompressedBodyBytes,
      schemaLimits: {
        maxDepth: config.inference.maxDepth,
        maxProperties: config.inference.maxProperties,
        maxNodes: config.inference.maxSchemaNodes,
        maxArrayItems: config.inference.maxArrayItems,
        maxFormatDetectionLength: DEFAULT_SCHEMA_LIMITS.maxFormatDetectionLength,
        maxPropertyNameLength: DEFAULT_SCHEMA_LIMITS.maxPropertyNameLength,
      },
      discovery,
      onSanitized: options.onSanitized,
      onProcessed: options.onProcessed,
      onPublicChange: options.onPublicChange,
      diagnostics: (diagnostic) => {
        this.#reportProcessor(diagnostic);
      },
    });

    this.#queue = new ProcessingQueue<RawObservation>({
      maxPending: config.capture.maxPendingObservations,
      process: (observation) => {
        processor.process(observation);
      },
      onDrop: (observation) => {
        // Releasing immediately is the whole point of the callback: a dropped
        // observation still holds a reservation against the global budget.
        observation.release();
      },
      onPressure: () => {
        this.#reportPressure();
      },
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    });

    this.#recorder = new TrafficRecorder({
      sessionId: options.sessionId,
      budget: this.#budget,
      maxBodyBytes: config.capture.maxBodyBytes,
      clock: options.clock,
      ids: options.ids,
      sink: (observation) => {
        this.#queue.enqueue(observation);
      },
      diagnostics: config.verbose
        ? (diagnostic) => {
            this.#reportCapture(diagnostic);
          }
        : undefined,
    });
  }

  get recorder(): TrafficRecorder {
    return this.#recorder;
  }

  get stats(): CapturePipelineStats {
    const queue = this.#queue.stats;
    return {
      processed: queue.processed,
      dropped: queue.dropped,
      failed: queue.failed,
      pending: queue.pending,
      reservedBytes: this.#budget.reservedBytes,
    };
  }

  /** Bounded: shutdown must not wait on a backlog of documentation samples. */
  async drain(timeoutMs: number): Promise<void> {
    await this.#queue.drain(timeoutMs);
  }

  #reportCapture(diagnostic: CaptureDiagnostic): void {
    switch (diagnostic.kind) {
      case 'request-truncated':
        this.#output.diagnostic(`request body truncated at ${String(diagnostic.limitBytes)} bytes`);
        return;
      case 'response-truncated':
        this.#output.diagnostic(
          `response body truncated at ${String(diagnostic.limitBytes)} bytes`,
        );
        return;
      case 'budget-exceeded':
        this.#output.diagnostic(`${diagnostic.side} body skipped, capture budget full`);
        return;
      case 'body-skipped':
        this.#output.diagnostic(
          `skipped ${diagnostic.mediaKind} ${diagnostic.side} body, metadata only`,
        );
    }
  }

  #reportProcessor(diagnostic: ProcessorDiagnostic): void {
    if (!this.#verbose) {
      return;
    }

    if (diagnostic.kind === 'parse-failed') {
      this.#output.diagnostic(`${diagnostic.side} body ${diagnostic.reason}`);
      return;
    }

    this.#output.diagnostic('could not persist observation metadata');
  }

  #reportPressure(): void {
    if (!this.#pressureLimiter.allow('queue-full')) {
      return;
    }

    this.#output.warn(
      'Capture processing is falling behind. Some observations are being skipped. ' +
        'Traffic is still being proxied normally.',
    );
  }
}
