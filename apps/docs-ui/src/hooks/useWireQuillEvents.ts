import { useEffect, useRef, useState } from 'react';
import { EVENTS_URL } from '../api/client.js';
import type { LiveConnectionState, WireQuillOperationEvent } from '../api/types.js';

/**
 * The live connection (spec sections 76, 89, 118, 119, 125 and 126).
 *
 * `EventSource` and nothing else. It reconnects on its own with the delay the
 * server suggests, which removes the need for a retry policy here — and every
 * reconnect resyncs from a snapshot, which removes the need for a replay
 * protocol on the server.
 *
 * There is no polling anywhere in this interface. A `setInterval` that refetches
 * the document would work, and would also mean WireQuill quietly using CPU on a
 * developer's laptop all day for the sake of a screen nobody is looking at.
 */

export interface WireQuillEventsResult {
  connection: LiveConnectionState;
  /**
   * Increments on every successful (re)connection.
   *
   * Consumers treat a change as "you may have missed something": after a
   * dropped connection, the current summary and document are the truth, and
   * whatever events went by while the socket was down do not matter.
   */
  epoch: number;
}

export interface WireQuillEventsOptions {
  /** Called for each contract change. Held in a ref, so it may change freely. */
  onOperationEvent?: (event: WireQuillOperationEvent) => void;
  /** Called when the stream opens, including after a reconnect. */
  onResync?: () => void;
}

export function useWireQuillEvents(options: WireQuillEventsOptions = {}): WireQuillEventsResult {
  const [connection, setConnection] = useState<LiveConnectionState>('connecting');
  const [epoch, setEpoch] = useState(0);

  // Kept in refs so the effect below depends on nothing and runs exactly once
  // per mount. A callback in the dependency array would tear the connection
  // down and rebuild it on every parent render.
  const onOperationEvent = useRef(options.onOperationEvent);
  const onResync = useRef(options.onResync);

  // After render rather than during it, and before the connection effect below,
  // so the very first event already reaches the current callbacks.
  useEffect(() => {
    onOperationEvent.current = options.onOperationEvent;
    onResync.current = options.onResync;
  });

  useEffect(() => {
    const source = new EventSource(EVENTS_URL);
    let disposed = false;

    const handleOperation = (type: WireQuillOperationEvent['type']) => (message: MessageEvent) => {
      if (disposed) {
        return;
      }

      const parsed = parseEvent(type, message.data);
      if (parsed !== null) {
        onOperationEvent.current?.(parsed);
      }
    };

    const discovered = handleOperation('operation.discovered');
    const updated = handleOperation('operation.updated');

    source.addEventListener('operation.discovered', discovered);
    source.addEventListener('operation.updated', updated);

    source.onopen = () => {
      if (disposed) {
        return;
      }
      setConnection('live');
      setEpoch((value) => value + 1);
      onResync.current?.();
    };

    source.onerror = () => {
      if (disposed) {
        return;
      }
      // EventSource does not distinguish "the server went away" from "the first
      // connection failed"; either way it will retry, and either way the badge
      // must stop claiming to be live (spec section 76).
      setConnection('reconnecting');
    };

    return () => {
      // StrictMode mounts, unmounts and mounts again. Without this the first
      // connection would survive as an invisible second subscriber
      // (spec sections 118 and 119).
      disposed = true;
      source.removeEventListener('operation.discovered', discovered);
      source.removeEventListener('operation.updated', updated);
      source.close();
    };
  }, []);

  return { connection, epoch };
}

/** Server frames are trusted to be JSON, but not trusted to be well-formed. */
function parseEvent(
  type: WireQuillOperationEvent['type'],
  data: unknown,
): WireQuillOperationEvent | null {
  if (typeof data !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as Partial<WireQuillOperationEvent>;

    if (typeof parsed.method !== 'string' || typeof parsed.path !== 'string') {
      return null;
    }

    return {
      type,
      revision: typeof parsed.revision === 'number' ? parsed.revision : 0,
      operationId: typeof parsed.operationId === 'string' ? parsed.operationId : '',
      method: parsed.method,
      path: parsed.path,
    };
  } catch {
    return null;
  }
}
