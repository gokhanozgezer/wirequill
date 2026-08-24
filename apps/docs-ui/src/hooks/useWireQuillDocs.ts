import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchOpenApiDocument, fetchSummary } from '../api/client.js';
import type { OpenApiDocument, WireQuillSummary } from '../api/types.js';

/**
 * The documentation snapshot: the summary and the document, together
 * (spec sections 72, 82, 83, 87, 88, 115, 116 and 117).
 *
 * One hook rather than the two the brief sketches, because the two values are
 * one fact. The top bar's endpoint count and the reference below it come from
 * the same instant or they disagree on screen — "0 endpoints discovered" above
 * a rendered API is worse than either half being briefly stale.
 */

export type SnapshotStatus = 'loading' | 'ready' | 'error';

export interface WireQuillDocs {
  status: SnapshotStatus;
  summary: WireQuillSummary | null;
  document: OpenApiDocument | null;
  /** Refetches now, cancelling anything in flight. Used on reconnect. */
  refresh: () => void;
  /** Refetches after a short quiet period. Used for event bursts. */
  scheduleRefresh: () => void;
}

/**
 * How long a burst is allowed to keep arriving before the interface reacts
 * (spec section 87).
 *
 * Twenty new endpoints discovered inside a second is one page load, not twenty.
 */
export const REFRESH_DEBOUNCE_MS = 300;

export function useWireQuillDocs(): WireQuillDocs {
  const [status, setStatus] = useState<SnapshotStatus>('loading');
  const [summary, setSummary] = useState<WireQuillSummary | null>(null);
  const [document, setDocument] = useState<OpenApiDocument | null>(null);

  /**
   * Monotonic request number.
   *
   * Two refreshes can be in flight when traffic is arriving, and the network
   * does not promise to answer them in order. Anything but the newest is
   * discarded on arrival, so a slow response for revision 10 cannot overwrite a
   * fast one for revision 11 (spec section 117).
   */
  const latestRequest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    latestRequest.current += 1;
    const request = latestRequest.current;

    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;

    void (async () => {
      try {
        const [nextSummary, nextDocument] = await Promise.all([
          fetchSummary(abort.signal),
          fetchOpenApiDocument(abort.signal),
        ]);

        if (!mounted.current || request !== latestRequest.current) {
          return;
        }

        setSummary(nextSummary);
        setDocument(nextDocument);
        setStatus('ready');
      } catch {
        if (!mounted.current || request !== latestRequest.current) {
          return;
        }

        // Usually the server restarting. The event stream will reconnect and
        // trigger another refresh; until then the UI says so rather than going
        // blank (spec section 116).
        setStatus('error');
      }
    })();
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }

    // Always the trailing edge: the last event in a burst carries the newest
    // state, and the fetch that follows it reads the current one anyway
    // (spec section 88).
    timer.current = setTimeout(() => {
      timer.current = null;
      refresh();
    }, REFRESH_DEBOUNCE_MS);
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;

      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }

      controller.current?.abort();
    };
  }, []);

  return { status, summary, document, refresh, scheduleRefresh };
}
