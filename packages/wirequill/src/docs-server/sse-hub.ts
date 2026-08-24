import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WireQuillEvent } from '../events/types.js';
import { SECURITY_HEADERS } from './response.js';

/**
 * Server-sent events for the documentation interface
 * (spec sections 62 to 70).
 *
 * SSE rather than a WebSocket because the traffic is one-way, tiny and rare,
 * and because `EventSource` reconnects on its own — which is the entire
 * recovery strategy here (spec sections 66, 126 and 186).
 */

/** Sent to the browser as its reconnect delay. */
export const RETRY_MS = 1_000;

/**
 * Comment frames that keep intermediaries and idle sockets from closing the
 * stream. Far below the usual sixty-second idle timeouts.
 */
export const KEEPALIVE_INTERVAL_MS = 20_000;

/**
 * How much unflushed data a client may accumulate before events are dropped.
 *
 * A browser that has stopped reading is not worth queueing for: it will
 * reconnect and refetch the current snapshot, which is more correct than a
 * replay of everything it missed (spec section 70).
 */
const MAX_PENDING_BYTES = 256 * 1024;

export interface SseHubOptions {
  /** Overridden in tests, where a fake timer stands in for twenty seconds. */
  keepaliveIntervalMs?: number;
  setInterval?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
}

export class SseHub {
  readonly #clients = new Set<ServerResponse>();
  readonly #keepaliveIntervalMs: number;
  readonly #setInterval: (handler: () => void, ms: number) => NodeJS.Timeout;
  readonly #clearInterval: (timer: NodeJS.Timeout) => void;

  #keepalive: NodeJS.Timeout | null = null;
  #nextEventId = 1;
  #closed = false;

  constructor(options: SseHubOptions = {}) {
    this.#keepaliveIntervalMs = options.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
    this.#setInterval = options.setInterval ?? ((handler, ms) => setInterval(handler, ms));
    this.#clearInterval = options.clearInterval ?? ((timer) => clearInterval(timer));
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /**
   * Attaches a client.
   *
   * The response is deliberately never ended here. It stays open until the
   * browser goes away or the runtime stops, which is why the disconnect
   * bookkeeping below is the important part of this method.
   */
  attach(request: IncomingMessage, response: ServerResponse, readyRevision: number): void {
    if (this.#closed) {
      response.writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Shutting down.');
      return;
    }

    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    // Nagle would hold a 60-byte event back waiting for company.
    response.socket?.setNoDelay(true);

    this.#clients.add(response);

    const remove = (): void => {
      this.#clients.delete(response);
    };

    // Both, not one: `close` on the request fires when the browser navigates
    // away, `close` on the response when the socket dies underneath us. Missing
    // either leaks a response object per reconnect (spec section 67).
    request.on('close', remove);
    response.on('close', remove);
    response.on('error', remove);

    response.write(`retry: ${String(RETRY_MS)}\n\n`);

    // Not a contract change — a handshake. The UI uses it to notice that its
    // idea of the revision is stale after a reconnect (spec section 63).
    this.#writeTo(response, this.#frame('ready', { revision: readyRevision }));

    this.#ensureKeepalive();
  }

  /** Fans one event out to every connected browser. */
  publish(event: WireQuillEvent): void {
    if (this.#closed || this.#clients.size === 0) {
      return;
    }

    const frame = this.#frame(event.type, {
      revision: event.revision,
      operationId: event.operationId,
      method: event.method,
      path: event.path,
    });

    for (const client of [...this.#clients]) {
      this.#writeTo(client, frame);
    }
  }

  /**
   * Ends every stream, then stops.
   *
   * This exists because of a bug class already met once, in the Faz 1 WebSocket
   * tunnels: an open connection that Node still accounts for keeps
   * `server.close()` pending forever, and Ctrl+C appears to hang. An SSE
   * response is exactly that — a request that never finishes (spec section 68).
   */
  close(): void {
    this.#closed = true;

    if (this.#keepalive !== null) {
      this.#clearInterval(this.#keepalive);
      this.#keepalive = null;
    }

    for (const client of [...this.#clients]) {
      try {
        client.end();
      } catch {
        // Already gone. Nothing to do and nothing worth reporting.
      }
    }

    this.#clients.clear();
  }

  // ------------------------------------------------------------------ internals

  #frame(event: string, data: Record<string, unknown>): string {
    const id = this.#nextEventId;
    this.#nextEventId += 1;

    return `id: ${String(id)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  #writeTo(client: ServerResponse, frame: string): void {
    if (client.writableEnded || client.destroyed) {
      this.#clients.delete(client);
      return;
    }

    if (client.writableLength > MAX_PENDING_BYTES) {
      // Dropped on purpose. See MAX_PENDING_BYTES.
      return;
    }

    try {
      client.write(frame);
    } catch {
      this.#clients.delete(client);
    }
  }

  #ensureKeepalive(): void {
    if (this.#keepalive !== null) {
      return;
    }

    this.#keepalive = this.#setInterval(() => {
      for (const client of [...this.#clients]) {
        this.#writeTo(client, ': ping\n\n');
      }
    }, this.#keepaliveIntervalMs);

    // A heartbeat is not a reason for the process to stay alive.
    this.#keepalive.unref?.();
  }
}
