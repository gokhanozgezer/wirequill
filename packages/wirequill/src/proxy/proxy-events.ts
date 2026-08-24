/**
 * Metadata emitted as traffic passes through the proxy.
 *
 * Deliberately metadata only: no header values, no body, no query values beyond
 * what is already in the path. Nothing here is persisted at this milestone; the
 * CLI subscribes in order to print one line per request.
 */

export interface ProxyRequestCompleted {
  method: string;
  /** Request target as received, including query string. Untrusted. */
  path: string;
  statusCode: number;
  durationMs: number;
}

export interface ProxyUpstreamFailure {
  method: string;
  /** Request target as received, including query string. Untrusted. */
  path: string;
  /** Node syscall code such as ECONNREFUSED, or a generic fallback. */
  code: string;
  durationMs: number;
}

export interface ProxyEventMap {
  requestCompleted: ProxyRequestCompleted;
  upstreamFailure: ProxyUpstreamFailure;
}

type Listener<K extends keyof ProxyEventMap> = (event: ProxyEventMap[K]) => void;

/**
 * A very small typed emitter.
 *
 * Node's `EventEmitter` would work, but it throws on an unhandled `error`
 * event and widens the payload types. This sits on the proxy hot path, so it
 * stays a map of sets and swallows listener failures: a broken terminal writer
 * must never take down a request.
 */
export class ProxyEventBus {
  readonly #listeners = new Map<keyof ProxyEventMap, Set<Listener<never>>>();

  on<K extends keyof ProxyEventMap>(event: K, listener: Listener<K>): () => void {
    const existing = this.#listeners.get(event) ?? new Set<Listener<never>>();
    existing.add(listener as Listener<never>);
    this.#listeners.set(event, existing);

    return () => {
      existing.delete(listener as Listener<never>);
    };
  }

  emit<K extends keyof ProxyEventMap>(event: K, payload: ProxyEventMap[K]): void {
    const listeners = this.#listeners.get(event);
    if (listeners === undefined) {
      return;
    }

    for (const listener of listeners) {
      try {
        (listener as Listener<K>)(payload);
      } catch {
        // A failing subscriber is not a reason to fail a proxied request.
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
