import path from 'node:path';
import { Output } from '../cli/output.js';
import { normalizeTargetUrl } from '../config/target.js';
import type { WireQuillConfig } from '../config/types.js';
import { DocsServer, DOCS_HOST } from '../docs-server/docs-server.js';
import { docsUiMissingError } from '../docs-server/docs-errors.js';
import { isPackagedInstall } from '../docs-server/static-ui.js';
import { WireQuillEventBus } from '../events/event-bus.js';
import { OpenApiService } from '../openapi/openapi-service.js';
import { ensureDataDirectory } from '../project/data-directory.js';
import type { ProcessedObservation, PublicChange } from '../processing/observation-processor.js';
import type { SanitizedObservation } from '../processing/sanitized-observation.js';
import { ProxyEventBus } from '../proxy/proxy-events.js';
import { HttpProxyServer } from '../proxy/proxy-server.js';
import type { ProxyServer } from '../proxy/types.js';
import { createSqliteStorage } from '../storage/sqlite-storage.js';
import type { Storage } from '../storage/storage.js';
import type { Session, Workspace } from '../storage/types.js';
import { systemClock, toIsoString, type Clock } from '../utils/clock.js';
import { WireQuillError } from '../utils/errors.js';
import { uuidGenerator, type IdGenerator } from '../utils/ids.js';
import { WIREQUILL_VERSION } from '../version.js';
import { CapturePipeline, type CapturePipelineStats } from './capture-pipeline.js';
import { openInBrowser, shouldOpenBrowser, type BrowserOpener } from './open-browser.js';

/**
 * How long shutdown waits for queued observations to finish.
 *
 * Short on purpose: what is queued is documentation samples, and a developer
 * pressing Ctrl+C wants their terminal back, not a complete dataset.
 */
const QUEUE_DRAIN_TIMEOUT_MS = 2_000;

export interface RuntimeOptions {
  config: WireQuillConfig;
  output?: Output;
  clock?: Clock;
  ids?: IdGenerator;
  /** Injected by tests; production builds one from the resolved config. */
  storage?: Storage;
  /** Injected by tests so the runtime can run without binding a port. */
  proxy?: ProxyServer;
  events?: ProxyEventBus;
  /** Publishes public contract changes to the documentation interface. */
  eventBus?: WireQuillEventBus;
  version?: string;
  /** Receives every safe observation. Later phases subscribe here. */
  onSanitized?: ((observation: SanitizedObservation) => void) | undefined;
  /** Injected by tests so no browser is ever spawned during a test run. */
  openBrowser?: BrowserOpener | undefined;
  /** Injected by tests; production reads the real environment and terminal. */
  env?: NodeJS.ProcessEnv;
  isTty?: boolean;
  /** Points the docs server at a fixture bundle instead of the shipped one. */
  docsAssetRoot?: string | undefined;
}

export type RuntimeState = 'idle' | 'running' | 'stopping' | 'stopped';

/**
 * Composition root (spec sections 12 and 13).
 *
 * Owns startup order and shutdown order, and nothing else. Every collaborator
 * is injected, so there is no module-level mutable state to leak between tests
 * or between runs.
 */
export class WireQuillRuntime {
  readonly #config: WireQuillConfig;
  readonly #output: Output;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #storage: Storage;
  readonly #events: ProxyEventBus;
  readonly #version: string;
  readonly #injectedProxy: ProxyServer | undefined;
  readonly #onSanitized: ((observation: SanitizedObservation) => void) | undefined;
  readonly #eventBus: WireQuillEventBus;
  readonly #openBrowser: BrowserOpener;
  readonly #env: NodeJS.ProcessEnv;
  readonly #isTty: boolean;
  readonly #docsAssetRoot: string | undefined;

  #state: RuntimeState = 'idle';
  #workspace: Workspace | null = null;
  #session: Session | null = null;
  #proxy: ProxyServer | null = null;
  #pipeline: CapturePipeline | null = null;
  #openApi: OpenApiService | null = null;
  #docs: DocsServer | null = null;
  #unsubscribe: (() => void)[] = [];

  constructor(options: RuntimeOptions) {
    this.#config = options.config;
    this.#output = options.output ?? new Output();
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? uuidGenerator;
    this.#version = options.version ?? WIREQUILL_VERSION;
    this.#events = options.events ?? new ProxyEventBus();
    this.#injectedProxy = options.proxy;
    this.#onSanitized = options.onSanitized;
    this.#eventBus = options.eventBus ?? new WireQuillEventBus();
    this.#openBrowser = options.openBrowser ?? openInBrowser;
    this.#env = options.env ?? process.env;
    this.#isTty = options.isTty ?? process.stdout.isTTY === true;
    this.#docsAssetRoot = options.docsAssetRoot;

    this.#storage =
      options.storage ??
      createSqliteStorage({
        databasePath: options.config.storage.databasePath,
        clock: this.#clock,
      });
  }

  get state(): RuntimeState {
    return this.#state;
  }

  get events(): ProxyEventBus {
    return this.#events;
  }

  /** Public contract changes. The docs server subscribes; so may a test. */
  get eventBus(): WireQuillEventBus {
    return this.#eventBus;
  }

  /** Open event-stream connections. Used by tests to observe cleanup. */
  get docsSseClientCount(): number {
    return this.#docs?.sseClientCount ?? 0;
  }

  /** Open protocol-upgrade tunnels. Used by tests to observe cleanup. */
  get proxyTunnelCount(): number {
    return this.#proxy?.tunnelCount ?? 0;
  }

  get docsUrl(): string {
    return `http://${DOCS_HOST}:${String(this.#config.docs.port)}`;
  }

  get captureStats(): CapturePipelineStats | null {
    return this.#pipeline?.stats ?? null;
  }

  /**
   * Generates the OpenAPI document from persisted evidence.
   *
   * Available as soon as the runtime has started, with no traffic required: the
   * evidence a previous session accumulated is enough. The docs server in the
   * next phase serves what this returns.
   */
  get openApi(): OpenApiService {
    if (this.#openApi === null) {
      throw new WireQuillError('RUNTIME_NOT_STARTED', 'Runtime has not been started.');
    }
    return this.#openApi;
  }

  get workspace(): Workspace {
    if (this.#workspace === null) {
      throw new WireQuillError('RUNTIME_NOT_STARTED', 'Runtime has not been started.');
    }
    return this.#workspace;
  }

  get session(): Session {
    if (this.#session === null) {
      throw new WireQuillError('RUNTIME_NOT_STARTED', 'Runtime has not been started.');
    }
    return this.#session;
  }

  async start(): Promise<void> {
    if (this.#state !== 'idle') {
      throw new WireQuillError('RUNTIME_ALREADY_STARTED', 'Runtime has already been started.');
    }

    ensureDataDirectory(this.#config.sources.projectRoot);

    this.#storage.initialize();

    // Everything past this point owns something that has to be given back.
    // A constructor that throws — a collaborator rejecting its configuration,
    // an asset root that cannot be resolved — would otherwise leave the
    // database open and the session dangling (spec section 101).
    try {
      await this.#startServices();
    } catch (error) {
      await this.#unwindFailedStart();
      throw error;
    }

    this.#subscribeToTraffic();
    this.#state = 'running';
    this.#printStartup();

    // Last, and only now: both servers are listening, so the tab that opens
    // finds a working page rather than a connection error (spec section 20).
    await this.#maybeOpenBrowser();
  }

  /**
   * Builds and starts everything the runtime owns.
   *
   * Split out so `start()` has exactly one place that unwinds, whatever failed.
   */
  async #startServices(): Promise<void> {
    this.#workspace = this.#storage.getOrCreateWorkspace({
      projectRoot: this.#config.sources.projectRoot,
      targetUrl: normalizeTargetUrl(this.#config.target),
    });

    this.#session = this.#storage.createSession({
      workspaceId: this.#workspace.id,
      proxyHost: this.#config.proxy.host,
      proxyPort: this.#config.proxy.port,
      docsPort: this.#config.docs.port,
      wirequillVersion: this.#version,
    });

    this.#openApi = new OpenApiService({
      config: this.#config,
      storage: this.#storage,
      workspaceId: this.#workspace.id,
    });

    // The capture pipeline stamps observations with the session, so it can only
    // be built once the session exists.
    this.#pipeline = new CapturePipeline({
      config: this.#config,
      sessionId: this.#session.id,
      workspaceId: this.#workspace.id,
      storage: this.#storage,
      output: this.#output,
      clock: this.#clock,
      ids: this.#ids,
      onSanitized: this.#onSanitized,
      onProcessed: (processed) => {
        this.#printTraffic(processed);
      },
      onPublicChange: (change) => {
        this.#announcePublicChange(change);
      },
    });

    this.#docs = new DocsServer({
      port: this.#config.docs.port,
      target: normalizeTargetUrl(this.#config.target),
      assetRoot: this.#docsAssetRoot,
      context: {
        version: this.#version,
        targetUrl: normalizeTargetUrl(this.#config.target),
        proxyUrl: this.#proxyUrl(),
        docsUrl: this.docsUrl,
        storage: this.#storage,
        workspaceId: this.#workspace.id,
        openApi: this.#openApi,
        events: this.#eventBus,
        requiredAfterSamples: this.#config.inference.requiredAfterSamples,
      },
    });

    this.#proxy =
      this.#injectedProxy ??
      new HttpProxyServer({
        config: this.#config,
        events: this.#events,
        recorder: this.#pipeline.recorder,
      });

    // Docs first, proxy second (spec section 19). Both must bind or neither
    // runs: a WireQuill that proxies without documenting is a plain proxy the
    // user did not ask for, and one that documents without proxying sees no
    // traffic at all.
    await this.#docs.start();
    this.#reportMissingUi();
    await this.#proxy.start();
  }

  async stop(): Promise<void> {
    if (this.#state === 'stopped' || this.#state === 'stopping') {
      return;
    }

    this.#state = 'stopping';

    // Stop accepting first, so nothing new arrives while the queue drains.
    await this.#proxy?.stop();
    // Ends every open event stream before closing the listener. Without this an
    // open documentation tab holds shutdown until the grace period expires.
    await this.#docs?.stop();
    this.#docs = null;
    this.#eventBus.clear();
    this.#unsubscribeFromTraffic();

    await this.#pipeline?.drain(QUEUE_DRAIN_TIMEOUT_MS);

    if (this.#session !== null) {
      this.#storage.endSession(this.#session.id, toIsoString(this.#clock.now()));
    }

    this.#printShutdown();

    this.#storage.close();
    this.#state = 'stopped';
  }

  // ------------------------------------------------------------------ internals

  async #unwindFailedStart(): Promise<void> {
    try {
      await this.#docs?.stop();
      this.#docs = null;
      this.#eventBus.clear();
      await this.#pipeline?.drain(0);
      if (this.#session !== null) {
        this.#storage.endSession(this.#session.id, toIsoString(this.#clock.now()));
      }
    } finally {
      this.#storage.close();
      this.#state = 'stopped';
    }
  }

  /**
   * Traffic lines come from the processing pipeline, not from the proxy event.
   *
   * The proxy knows a request finished but not which operation it was, and it
   * only has the raw path — which may carry a credential. Waiting for the
   * pipeline means the line reads `GET /reset/{token}` instead of leaking the
   * token, and can mark a newly discovered operation (spec sections 10 and 53).
   *
   * An unreachable target is still reported immediately, because that is a
   * transport fact the developer needs before any processing happens.
   */
  #subscribeToTraffic(): void {
    this.#unsubscribe.push(
      this.#events.on('upstreamFailure', (event) => {
        this.#output.trafficFailure(event.method, event.path, event.code);
      }),
    );
  }

  #printTraffic(processed: ProcessedObservation): void {
    if (this.#state === 'stopped') {
      return;
    }

    // Already reported the moment the connection failed.
    if (processed.upstreamErrorCode !== undefined) {
      return;
    }

    this.#output.traffic(
      processed.method,
      processed.displayPath,
      processed.statusCode,
      processed.durationMs,
      processed.discovered,
    );
  }

  #unsubscribeFromTraffic(): void {
    for (const dispose of this.#unsubscribe.splice(0)) {
      dispose();
    }
  }

  /**
   * Publishes one public contract change (spec sections 56 to 61).
   *
   * Called after the transaction that produced the change committed, so a
   * subscriber that immediately refetches the document sees the version this
   * event describes.
   *
   * The revision comes from `OpenApiService`, which derives it from persisted
   * evidence. There is deliberately no second counter: an event and the
   * document it announces must never disagree (spec section 61).
   */
  #announcePublicChange(change: PublicChange): void {
    // Marks the document stale. Rebuilding here would put OpenAPI generation on
    // the path of every request that changes anything.
    this.#openApi?.invalidate();

    this.#eventBus.emit({
      type: change.kind === 'discovered' ? 'operation.discovered' : 'operation.updated',
      revision: this.#openApi?.getRevision() ?? 0,
      operationId: change.operationId,
      method: change.method,
      path: change.path,
    });
  }

  async #maybeOpenBrowser(): Promise<void> {
    const wanted = shouldOpenBrowser({
      configured: this.#config.docs.openBrowser,
      isTty: this.#isTty,
      env: this.#env,
    });

    if (!wanted) {
      return;
    }

    try {
      await this.#openBrowser(this.docsUrl);
    } catch {
      // A headless machine, a missing default handler, a locked-down desktop.
      // None of that is a reason to fail a run whose actual job is proxying
      // (spec section 24).
      this.#output.warn('Could not open the browser automatically.');
      this.#output.line(`Docs: ${this.docsUrl}`);
    }
  }

  /**
   * Reports a documentation interface that is not there (spec section 50).
   *
   * Fatal in a published install, where the assets are part of the package and
   * their absence means a broken installation. A warning in a source checkout,
   * where it almost always means `pnpm build` has not run and the proxy is
   * still worth having.
   */
  #reportMissingUi(): void {
    if (this.#docs === null || this.#docs.hasUi) {
      return;
    }

    if (isPackagedInstall() && this.#docsAssetRoot === undefined) {
      throw docsUiMissingError();
    }

    this.#output.warn(
      'The documentation interface has not been built. Run `pnpm build`. Proxying continues.',
    );
  }

  #proxyUrl(): string {
    const address = this.#proxy?.address() ?? {
      host: this.#config.proxy.host,
      port: this.#config.proxy.port,
    };

    return `http://${address.host}:${String(address.port)}`;
  }

  #printStartup(): void {
    const config = this.#config;
    const address = this.#proxy?.address() ?? {
      host: config.proxy.host,
      port: config.proxy.port,
    };

    this.#output.blank();
    this.#output.banner(this.#version);
    this.#output.blank();

    const proxyUrl = `http://${address.host}:${String(address.port)}`;

    // Three addresses, in the order a reader needs them: where to point the
    // app, where the traffic is going, where to read the result.
    this.#output.field('Proxy', proxyUrl);
    this.#output.field('Target', normalizeTargetUrl(config.target));
    this.#output.field('Docs', this.docsUrl);

    // Where the database lives is a diagnostic, not something a developer needs
    // on every start. It moved behind `--verbose` (spec section 11).
    if (config.verbose) {
      this.#output.field('Storage', this.#output.untrusted(this.#relativeDatabasePath()));
    }

    if (config.proxy.insecure) {
      this.#output.blank();
      this.#output.warn('TLS certificate verification is disabled for the target.');
    }

    this.#output.blank();
    this.#output.status('Watching API traffic...');
    this.#output.blank();
    this.#output.hint('Point your app to:');
    this.#output.line(proxyUrl);
    this.#output.blank();
  }

  #printShutdown(): void {
    const stats = this.#pipeline?.stats;

    this.#output.blank();
    this.#output.line('Stopped.');

    if (stats !== undefined && this.#config.verbose) {
      this.#output.diagnostic(
        `${String(stats.processed)} observations processed, ${String(stats.dropped)} dropped`,
      );
    }

    this.#output.blank();
  }

  #relativeDatabasePath(): string {
    const relative = path.relative(
      this.#config.sources.projectRoot,
      this.#config.storage.databasePath,
    );

    // A database outside the project root has no meaningful relative form.
    return relative === '' || relative.startsWith('..')
      ? this.#config.storage.databasePath
      : relative;
  }
}
