import http from 'node:http';
import type { WireQuillEvent } from '../events/types.js';
import { INTERNAL_PATH_PREFIX } from '../inference/path/static-segments.js';
import type { DocsContext } from './context.js';
import { toDocsBindError } from './docs-errors.js';
import { sendJson, sendMethodNotAllowed, sendNotFound, sendServerError } from './response.js';
import { buildHealth } from './routes/health.js';
import { findOperation, listOperations } from './routes/operations.js';
import { handleOpenApi, OPENAPI_ROUTE } from './routes/openapi.js';
import { buildSummary } from './routes/summary.js';
import { SseHub, type SseHubOptions } from './sse-hub.js';
import { StaticUi } from './static-ui.js';

/**
 * The local documentation server (spec sections 16 to 53).
 *
 * Loopback only, always. `--host 0.0.0.0` opens the proxy to the network
 * because that is what a phone or a container on the same LAN needs in order to
 * reach it; it says nothing about the documentation, which is a view of
 * everything the proxy has seen and stays on this machine (spec section 16).
 *
 * There is no authentication and there will not be one at this size. The
 * security boundary is the loopback interface, and a password on a page only
 * the local user can open would be theatre (spec section 182).
 */

export const API_PREFIX = `${INTERNAL_PATH_PREFIX}/api`;
export const EVENTS_ROUTE = `${INTERNAL_PATH_PREFIX}/events`;

/** Hard-pinned. Not configurable, and deliberately not affected by `--host`. */
export const DOCS_HOST = '127.0.0.1';

export interface DocsServerOptions {
  context: DocsContext;
  port: number;
  /** Echoed in the port-in-use hint, exactly as the user typed it. */
  target: string;
  /** Overridden in tests to point at a fixture bundle. */
  assetRoot?: string | undefined;
  sse?: SseHubOptions;
  /** How long `stop()` waits for in-flight responses before cutting sockets. */
  shutdownGraceMs?: number;
}

export interface DocsAddress {
  host: typeof DOCS_HOST;
  port: number;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 1_000;

export class DocsServer {
  readonly #context: DocsContext;
  readonly #port: number;
  readonly #target: string;
  readonly #static: StaticUi;
  readonly #sse: SseHub;
  readonly #shutdownGraceMs: number;

  #server: http.Server | null = null;
  #unsubscribe: (() => void) | null = null;
  #stopping: Promise<void> | null = null;

  constructor(options: DocsServerOptions) {
    this.#context = options.context;
    this.#port = options.port;
    this.#target = options.target;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    this.#static = new StaticUi(options.assetRoot === undefined ? {} : { root: options.assetRoot });
    this.#sse = new SseHub(options.sse ?? {});
  }

  address(): DocsAddress {
    return { host: DOCS_HOST, port: this.#port };
  }

  get url(): string {
    return `http://${DOCS_HOST}:${String(this.#port)}`;
  }

  /** True when the package shipped its built UI. False in a source checkout. */
  get hasUi(): boolean {
    return this.#static.isAvailable;
  }

  get sseClientCount(): number {
    return this.#sse.clientCount;
  }

  async start(): Promise<void> {
    if (this.#server !== null) {
      return;
    }

    const server = http.createServer((request, response) => {
      this.#handle(request, response);
    });

    // Nothing upgrades on this port. Accepting a handshake there is no handler
    // for would leave a socket Node no longer accounts for, which is exactly the
    // shutdown hang SSE already has to be careful about.
    server.on('upgrade', (_request, socket) => {
      socket.destroy();
    });

    await this.#listen(server);

    this.#unsubscribe = this.#context.events.subscribe((event: WireQuillEvent) => {
      this.#sse.publish(event);
    });

    this.#server = server;
  }

  async stop(): Promise<void> {
    if (this.#stopping !== null) {
      return this.#stopping;
    }

    const server = this.#server;
    if (server === null) {
      return;
    }

    this.#stopping = this.#close(server).finally(() => {
      this.#server = null;
      this.#stopping = null;
    });

    return this.#stopping;
  }

  // ------------------------------------------------------------------ internals

  #handle(request: http.IncomingMessage, response: http.ServerResponse): void {
    try {
      this.#route(request, response);
    } catch {
      // One broken request must not take the docs server down, and the docs
      // server must never affect the proxy (spec sections 132 and 133).
      if (!response.headersSent) {
        sendServerError(response, 'The documentation server could not handle that request.');
        return;
      }
      response.end();
    }
  }

  #route(request: http.IncomingMessage, response: http.ServerResponse): void {
    // Unknown query parameters are ignored rather than rejected: no route here
    // takes one (spec section 135).
    const pathname = pathnameOf(request.url);
    const method = (request.method ?? 'GET').toUpperCase();

    if (method !== 'GET' && method !== 'HEAD') {
      sendMethodNotAllowed(response);
      return;
    }

    if (pathname === EVENTS_ROUTE) {
      this.#sse.attach(request, response, this.#context.openApi.getRevision());
      return;
    }

    if (pathname === OPENAPI_ROUTE) {
      handleOpenApi(this.#context, request, response);
      return;
    }

    if (pathname === `${API_PREFIX}/health`) {
      sendJson(response, 200, buildHealth(this.#context));
      return;
    }

    if (pathname === `${API_PREFIX}/summary`) {
      sendJson(response, 200, buildSummary(this.#context));
      return;
    }

    if (pathname === `${API_PREFIX}/operations`) {
      sendJson(response, 200, listOperations(this.#context));
      return;
    }

    if (pathname.startsWith(`${API_PREFIX}/operations/`)) {
      const id = pathname.slice(`${API_PREFIX}/operations/`.length);
      const operation = id === '' ? null : findOperation(this.#context, decodeSegment(id));

      if (operation === null) {
        sendNotFound(response);
        return;
      }

      sendJson(response, 200, operation);
      return;
    }

    // Everything else under the internal prefix is an API mistake and answers
    // as one. Falling through to the application shell would render a page
    // instead (spec section 41).
    if (pathname === INTERNAL_PATH_PREFIX || pathname.startsWith(`${INTERNAL_PATH_PREFIX}/`)) {
      sendNotFound(response);
      return;
    }

    if (this.#static.serve(pathname, response)) {
      return;
    }

    if (pathname === '/' && !this.#static.isAvailable) {
      // A source checkout without a build, or a package installed without its
      // assets. Say so, rather than showing a blank 404.
      sendServerError(
        response,
        'The documentation interface is not available in this installation.',
      );
      return;
    }

    sendNotFound(response);
  }

  #listen(server: http.Server): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (error: unknown): void => {
        server.removeListener('listening', onListening);
        server.close();
        reject(toDocsBindError(error, this.#port, this.#target));
      };

      const onListening = (): void => {
        server.removeListener('error', onError);
        // Past this point a server error is a runtime condition. Swallowing it
        // keeps a dead browser tab from taking the proxy down with it.
        server.on('error', () => {});
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.#port, DOCS_HOST);
    });
  }

  async #close(server: http.Server): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;

    // Before `server.close()`, not after: an SSE response is a request that
    // never ends, and `close()` waits for every request to end. This is the
    // whole reason Ctrl+C stays instant with a docs tab open
    // (spec sections 68 and 69).
    this.#sse.close();

    const closed = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });

    server.closeIdleConnections();

    const force = setTimeout(() => {
      server.closeAllConnections();
    }, this.#shutdownGraceMs);
    force.unref?.();

    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  }
}

function pathnameOf(url: string | undefined): string {
  const raw = url ?? '/';
  const index = raw.indexOf('?');
  const withoutQuery = index === -1 ? raw : raw.slice(0, index);
  const hash = withoutQuery.indexOf('#');

  return hash === -1 ? withoutQuery : withoutQuery.slice(0, hash);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
