import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config/load-config.js';
import type { WireQuillConfig } from '../../src/config/types.js';
import { Output } from '../../src/cli/output.js';
import { ProxyEventBus } from '../../src/proxy/proxy-events.js';
import { HttpProxyServer } from '../../src/proxy/proxy-server.js';
import type { ProxyRequestCompleted, ProxyUpstreamFailure } from '../../src/proxy/proxy-events.js';
import { OpenApiService } from '../../src/openapi/openapi-service.js';
import { CapturePipeline } from '../../src/runtime/capture-pipeline.js';
import type { ProcessedObservation } from '../../src/processing/observation-processor.js';
import type { SanitizedObservation } from '../../src/processing/sanitized-observation.js';
import { SqliteStorage } from '../../src/storage/sqlite-storage.js';
import { systemClock } from '../../src/utils/clock.js';
import { uuidGenerator } from '../../src/utils/ids.js';
import { startFixtureBackend, type FixtureBackend } from '../fixtures/backend.js';
import { getFreePort } from './ports.js';

export interface ProxyOnly {
  /** Base URL clients should call, for example `http://127.0.0.1:53112`. */
  proxyOrigin: string;
  proxyPort: number;
  config: WireQuillConfig;
  events: ProxyEventBus;
  completed: ProxyRequestCompleted[];
  failures: ProxyUpstreamFailure[];
  /** Every safe observation the pipeline produced. Empty when capture is off. */
  observations: SanitizedObservation[];
  /** One entry per processed observation, mirroring what the terminal shows. */
  processed: ProcessedObservation[];
  /** Terminal output the runtime would have written. */
  stdout: string[];
  stderr: string[];
  pipeline: CapturePipeline | null;
  storage: SqliteStorage | null;
  /** Generates the OpenAPI document from whatever evidence has accumulated. */
  openApi: OpenApiService;
  /** Where the capture pipeline actually persisted metadata. */
  databasePath: string;
  /** Workspace operations accumulate into. Empty when capture is off. */
  workspaceId: string;
  /** Resolves once `count` observations have been processed. */
  waitForObservations(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export interface ProxyHarness extends ProxyOnly {
  backend: FixtureBackend;
}

export interface ProxyOptions {
  insecure?: boolean;
  shutdownGraceMs?: number;
  /**
   * Capture is on by default so that every transport test doubles as a capture
   * regression test: the Faz 1 byte-integrity and streaming guarantees must
   * hold with an observer attached, not only without one.
   */
  capture?: boolean;
  verbose?: boolean;
  /** Overrides applied on top of the resolved config, for limit tests. */
  captureLimits?: Partial<WireQuillConfig['capture']>;
  redaction?: Partial<WireQuillConfig['redaction']>;
  /** Defers queue work, so a test can fill the queue on purpose. */
  schedule?: ((task: () => void) => void) | undefined;
}

/**
 * Starts a proxy in front of an arbitrary target.
 *
 * Everything is bound on a free port and stored under a temporary project root,
 * so tests never collide with each other or with a proxy the developer happens
 * to be running.
 */
export async function startProxyOnly(
  target: string,
  options: ProxyOptions = {},
): Promise<ProxyOnly> {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), 'wirequill-proxy-'));
  mkdirSync(path.join(projectDir, '.git'));

  const proxyPort = await getFreePort();
  const captureEnabled = options.capture ?? true;

  const baseConfig = loadConfig(
    {
      target,
      port: String(proxyPort),
      ...(options.insecure === true ? { insecure: true } : {}),
      ...(options.verbose === true ? { verbose: true } : {}),
    },
    { cwd: projectDir, env: {} },
  );

  const config: WireQuillConfig = {
    ...baseConfig,
    capture: { ...baseConfig.capture, ...options.captureLimits },
    redaction: { ...baseConfig.redaction, ...options.redaction },
  };

  const events = new ProxyEventBus();
  const completed: ProxyRequestCompleted[] = [];
  const failures: ProxyUpstreamFailure[] = [];
  const observations: SanitizedObservation[] = [];
  const processedObservations: ProcessedObservation[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];

  events.on('requestCompleted', (event) => completed.push(event));
  events.on('upstreamFailure', (event) => failures.push(event));

  const output = new Output({
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  const databasePath = path.join(projectDir, 'test.sqlite');
  let storage: SqliteStorage | null = null;
  let pipeline: CapturePipeline | null = null;
  let openApi: OpenApiService | null = null;
  let workspaceId = '';

  if (captureEnabled) {
    storage = new SqliteStorage({ databasePath });
    storage.initialize();

    const workspace = storage.getOrCreateWorkspace({ projectRoot: projectDir, targetUrl: target });
    workspaceId = workspace.id;
    const session = storage.createSession({
      workspaceId: workspace.id,
      proxyHost: '127.0.0.1',
      proxyPort,
      docsPort: proxyPort + 1,
      wirequillVersion: 'test',
    });

    openApi = new OpenApiService({ config, storage, workspaceId: workspace.id });

    pipeline = new CapturePipeline({
      config,
      sessionId: session.id,
      workspaceId: workspace.id,
      onPublicChange: () => openApi?.invalidate(),
      storage,
      output,
      clock: systemClock,
      ids: uuidGenerator,
      onSanitized: (observation) => observations.push(observation),
      onProcessed: (processed) => {
        processedObservations.push(processed);
        if (processed.upstreamErrorCode === undefined) {
          output.traffic(
            processed.method,
            processed.displayPath,
            processed.statusCode,
            processed.durationMs,
            processed.discovered,
          );
        }
      },
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    });
  }

  const proxy = new HttpProxyServer({
    config,
    events,
    recorder: pipeline?.recorder,
    shutdownGraceMs: options.shutdownGraceMs ?? 250,
  });

  await proxy.start();

  return {
    proxyOrigin: `http://127.0.0.1:${String(proxyPort)}`,
    proxyPort,
    config,
    events,
    completed,
    failures,
    observations,
    processed: processedObservations,
    stdout,
    stderr,
    pipeline,
    storage,
    // Capture-disabled harnesses never build one; tests that ask for it enable
    // capture, which is the default.
    openApi: openApi as OpenApiService,
    databasePath,
    workspaceId,
    waitForObservations: (count, timeoutMs = 5_000) =>
      waitFor(() => observations.length >= count, timeoutMs, `${String(count)} observations`),
    close: async () => {
      await proxy.stop();
      await pipeline?.drain(1_000);
      events.clear();
      // Storage must close before the directory goes, or Windows refuses to
      // remove a file SQLite still holds open.
      storage?.close();
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

/** Starts a fixture backend and a real proxy in front of it. */
export async function startProxyHarness(
  options: ProxyOptions & { tls?: boolean } = {},
): Promise<ProxyHarness> {
  const backend = await startFixtureBackend({ tls: options.tls ?? false });
  const proxy = await startProxyOnly(backend.origin, options);

  return {
    ...proxy,
    backend,
    close: async () => {
      await proxy.close();
      await backend.close();
    },
  };
}

/** Polls until `predicate` holds, so tests never sleep for a fixed duration. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
