import http from 'node:http';
import type { Socket } from 'node:net';
import {
  createProxyMiddleware,
  proxyEventsPlugin,
  type RequestHandler,
} from 'http-proxy-middleware';
import type { CaptureContext } from '../capture/capture-context.js';
import type { TrafficRecorder } from '../capture/traffic-recorder.js';
import { normalizeTargetUrl } from '../config/target.js';
import type { WireQuillConfig } from '../config/types.js';
import { errorMessage } from '../utils/errors.js';
import { ProxyEventBus } from './proxy-events.js';
import {
  UPSTREAM_ERROR_BODY,
  UPSTREAM_ERROR_STATUS,
  describeUpstreamFailure,
  toBindError,
} from './proxy-errors.js';
import type { ProxyAddress, ProxyServer } from './types.js';

export interface HttpProxyServerOptions {
  config: WireQuillConfig;
  events?: ProxyEventBus;
  /**
   * Optional bounded observer. When absent the proxy behaves exactly as it did
   * before capture existed, which is what the transport regression tests rely
   * on.
   */
  recorder?: TrafficRecorder | undefined;
  /**
   * How long `stop()` waits for in-flight requests before cutting connections.
   * A stream that never ends — SSE, a download — would otherwise keep the
   * process alive forever after Ctrl+C.
   */
  shutdownGraceMs?: number;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

interface RequestState {
  startedAt: bigint;
  /** Set when the target could not be reached, so the request is not double-reported. */
  failureCode?: string;
  capture?: CaptureContext | undefined;
}

/**
 * Transparent reverse proxy (spec section 20, milestone M2).
 *
 * Built on `http-proxy-middleware` v4, which is itself built on `httpxy`. The
 * response is forwarded by the library's native piping rather than by
 * `selfHandleResponse`, so upstream bytes reach the client as a stream and are
 * never assembled in memory first. See `docs/DECISIONS.md`.
 *
 * The binding rule for this milestone: forwarding correctness beats everything
 * else. Nothing here parses, buffers, re-serialises, recompresses or persists a
 * payload, and capture — where present — is strictly passive.
 */
export class HttpProxyServer implements ProxyServer {
  readonly #config: WireQuillConfig;
  readonly #events: ProxyEventBus;
  readonly #recorder: TrafficRecorder | undefined;
  readonly #shutdownGraceMs: number;
  readonly #state = new WeakMap<http.IncomingMessage, RequestState>();

  /**
   * Sockets handed over to a protocol upgrade.
   *
   * Node stops accounting for a socket once an `upgrade` listener takes it, so
   * `server.close()` can wait forever on an open tunnel. Tracking them here is
   * what lets Ctrl+C stay responsive while a WebSocket is connected.
   */
  readonly #tunnels = new Set<Socket>();

  #server: http.Server | null = null;
  #stopping: Promise<void> | null = null;

  constructor(options: HttpProxyServerOptions) {
    this.#config = options.config;
    this.#events = options.events ?? new ProxyEventBus();
    this.#recorder = options.recorder;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  }

  get events(): ProxyEventBus {
    return this.#events;
  }

  /**
   * Open protocol-upgrade tunnels.
   *
   * Exposed so a test can assert that they are released: a socket Node has
   * handed to an upgrade handler is one `server.close()` no longer waits for,
   * and a leak here is invisible until shutdown appears to hang.
   */
  get tunnelCount(): number {
    return this.#tunnels.size;
  }

  address(): ProxyAddress {
    return {
      host: this.#config.proxy.host,
      port: this.#config.proxy.port,
    };
  }

  async start(): Promise<void> {
    if (this.#server !== null) {
      return;
    }

    const middleware = this.#createMiddleware();
    const server = http.createServer((req, res) => {
      this.#handleRequest(middleware, req, res);
    });

    // Best-effort WebSocket and other protocol upgrades. A failure here must
    // not affect ordinary HTTP traffic, so the socket is simply destroyed.
    // Upgraded traffic is never captured (spec section 105).
    server.on('upgrade', (req, socket: Socket, head: Buffer) => {
      this.#tunnels.add(socket);

      socket.on('close', () => {
        this.#tunnels.delete(socket);
      });

      // A tunnel is two piped sockets, and a piped socket does not close
      // itself. When the client goes away, httpxy ends the upstream half and
      // stops there: if the backend keeps its side open — which a WebSocket
      // server normally does — this socket stays half-open forever, and the set
      // above grows by one for every client that ever reconnects.
      //
      // A WebSocket has no use for a half-open connection, so a FIN or an error
      // from the client means the tunnel is over.
      const release = (): void => {
        if (!socket.destroyed) {
          socket.destroy();
        }
      };

      socket.on('end', release);
      socket.on('error', release);

      try {
        middleware.upgrade(req, socket, head);
      } catch {
        socket.destroy();
      }
    });

    await this.#listen(server);
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

    this.#stopping = this.#closeServer(server).finally(() => {
      this.#server = null;
      this.#stopping = null;
    });

    return this.#stopping;
  }

  // ------------------------------------------------------------------ internals

  #createMiddleware(): RequestHandler {
    const { proxy, target } = this.#config;

    return createProxyMiddleware({
      target: target.href,

      // Present the target's own host to the backend, so virtual-host routing
      // and TLS SNI behave as if the client had connected directly. This is the
      // one header WireQuill knowingly rewrites.
      changeOrigin: true,

      ws: true,
      secure: !proxy.insecure,

      // Everything below keeps the proxy transparent: no forwarding headers the
      // client did not send, no redirect following, no cookie rewriting, and
      // response header casing preserved as the backend wrote it.
      xfwd: false,
      followRedirects: false,
      autoRewrite: false,
      preserveHeaderKeyCase: true,

      // `http-proxy-middleware`'s default error responder answers with 504 and
      // writes the Host header and request URL into the body. Ejecting the
      // defaults and keeping only the event plugin leaves error handling here,
      // where the response is a fixed, content-free 502.
      ejectPlugins: true,
      plugins: [proxyEventsPlugin],

      on: {
        proxyReq: (proxyReq, req) => {
          this.#observeRequestBody(proxyReq, req);
        },
        proxyRes: (proxyRes, req) => {
          this.#observeResponseBody(proxyRes, req);
        },
        error: (error, req, res) => {
          this.#handleUpstreamFailure(error, req, res);
        },
      },
    });
  }

  /**
   * Tees the request body by observing what is written upstream.
   *
   * Attaching a `data` listener to `req` is the obvious approach and it is
   * wrong: it switches the stream into flowing mode, while httpxy defers
   * `req.pipe(proxyReq)` until the upstream socket has connected. Chunks
   * arriving in between would reach the observer and never the backend — a
   * silent byte-integrity failure that only shows up under load.
   *
   * Observing the writes into `proxyReq` cannot lose or reorder anything: it
   * sees precisely the bytes the backend receives, and leaves the readable's
   * flow control completely alone.
   */
  #observeRequestBody(proxyReq: http.ClientRequest, req: http.IncomingMessage): void {
    const recorder = this.#recorder;
    const capture = this.#state.get(req)?.capture;

    if (recorder === undefined || capture === undefined) {
      return;
    }

    const observe = (chunk: unknown, encoding: unknown): void => {
      const buffer = toBuffer(chunk, encoding);
      if (buffer !== null) {
        recorder.observeRequestChunk(capture, buffer);
      }
    };

    const originalWrite = proxyReq.write.bind(proxyReq) as (...args: unknown[]) => boolean;
    const originalEnd = proxyReq.end.bind(proxyReq) as (...args: unknown[]) => http.ClientRequest;

    proxyReq.write = ((...args: unknown[]): boolean => {
      observe(args[0], args[1]);
      return originalWrite(...args);
    }) as typeof proxyReq.write;

    proxyReq.end = ((...args: unknown[]): http.ClientRequest => {
      observe(args[0], args[1]);
      return originalEnd(...args);
    }) as typeof proxyReq.end;
  }

  /**
   * Tees the response body.
   *
   * Safe as a plain `data` listener: httpxy emits `proxyRes` and calls
   * `proxyRes.pipe(res)` in the same synchronous turn, so flowing mode begins
   * only after the pipe is attached and both consumers see every chunk.
   */
  #observeResponseBody(proxyRes: http.IncomingMessage, req: http.IncomingMessage): void {
    const recorder = this.#recorder;
    const capture = this.#state.get(req)?.capture;

    if (recorder === undefined || capture === undefined) {
      return;
    }

    recorder.beginResponse(capture, proxyRes);

    proxyRes.on('data', (chunk: Buffer) => {
      recorder.observeResponseChunk(capture, chunk);
    });

    proxyRes.on('aborted', () => {
      recorder.markResponseAborted(capture);
    });
  }

  #handleRequest(
    middleware: RequestHandler,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const state: RequestState = { startedAt: process.hrtime.bigint() };
    state.capture = this.#recorder?.begin(req);
    this.#state.set(req, state);

    const capture = state.capture;
    if (capture !== undefined) {
      req.on('aborted', () => {
        this.#recorder?.markRequestAborted(capture);
      });
    }

    res.on('close', () => {
      // The query string is deliberately absent: a reset link or a signed URL
      // carries a live secret in the request target, and this line goes to the
      // terminal (spec sections 40 and 108).
      const pathname = pathnameOf(req.url);

      if (state.failureCode === undefined) {
        this.#events.emit('requestCompleted', {
          method: req.method ?? 'GET',
          path: pathname,
          statusCode: res.statusCode,
          durationMs: elapsedMs(state.startedAt),
        });
      }

      if (capture !== undefined) {
        this.#recorder?.finish(capture, { statusCode: res.statusCode });
      }
    });

    void middleware(req, res).catch((error: unknown) => {
      this.#handleUpstreamFailure(error, req, res);
    });
  }

  #handleUpstreamFailure(
    error: unknown,
    req: http.IncomingMessage,
    res: http.ServerResponse | Socket,
  ): void {
    const { code } = describeUpstreamFailure(error);
    const state = this.#state.get(req);

    if (state !== undefined) {
      state.failureCode = code;

      if (state.capture !== undefined) {
        this.#recorder?.markUpstreamError(state.capture, code);
      }
    }

    this.#events.emit('upstreamFailure', {
      method: req.method ?? 'GET',
      path: pathnameOf(req.url),
      code,
      durationMs: state === undefined ? 0 : elapsedMs(state.startedAt),
    });

    if (!isServerResponse(res)) {
      // A failed upgrade: there is no HTTP response to write into.
      res.destroy();
      return;
    }

    if (res.writableEnded) {
      return;
    }

    if (!res.headersSent) {
      res.writeHead(UPSTREAM_ERROR_STATUS, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(UPSTREAM_ERROR_BODY),
      });
      res.end(UPSTREAM_ERROR_BODY);
      return;
    }

    // Headers already went out, so the status cannot be corrected. Ending the
    // response is the only honest option left.
    res.end();
  }

  #listen(server: http.Server): Promise<void> {
    const { host, port } = this.address();

    return new Promise<void>((resolve, reject) => {
      const onError = (error: unknown): void => {
        server.removeListener('listening', onListening);
        server.close();
        // The suggested command echoes the target the way the user typed it,
        // not URL.href, which would add a trailing slash they did not write.
        reject(toBindError(error, host, port, normalizeTargetUrl(this.#config.target)));
      };

      const onListening = (): void => {
        server.removeListener('error', onError);

        // From here on, a server error is a runtime condition rather than a
        // startup failure, and must not take the process down.
        server.on('error', (error) => {
          this.#events.emit('upstreamFailure', {
            method: 'SERVER',
            path: '-',
            code: errorMessage(error),
            durationMs: 0,
          });
        });

        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  async #closeServer(server: http.Server): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });

    // A tunnel has no in-flight request to finish, so there is nothing to wait
    // for; leaving them open would simply stall shutdown.
    for (const tunnel of this.#tunnels) {
      tunnel.destroy();
    }
    this.#tunnels.clear();

    // Idle keep-alive sockets would otherwise hold `close()` open indefinitely,
    // which is the common case for a proxy that has just served a request.
    server.closeIdleConnections();

    const forceTimer = setTimeout(() => {
      server.closeAllConnections();
    }, this.#shutdownGraceMs);
    forceTimer.unref();

    try {
      await closed;
    } finally {
      clearTimeout(forceTimer);
    }
  }
}

export function createProxyServer(options: HttpProxyServerOptions): ProxyServer {
  return new HttpProxyServer(options);
}

function isServerResponse(value: http.ServerResponse | Socket): value is http.ServerResponse {
  return typeof (value as http.ServerResponse).writeHead === 'function';
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

/** Strips the query string. A request target must never reach a log line whole. */
function pathnameOf(url: string | undefined): string {
  if (url === undefined) {
    return '/';
  }

  const separator = url.indexOf('?');
  return separator < 0 ? url : url.slice(0, separator);
}

/** Normalises whatever was handed to `write()` or `end()` into observable bytes. */
function toBuffer(chunk: unknown, encoding: unknown): Buffer | null {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (typeof chunk === 'string') {
    const bufferEncoding =
      typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8';
    return Buffer.from(chunk, bufferEncoding);
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }

  // A callback, or nothing at all: `end(cb)` and `end()` carry no data.
  return null;
}
