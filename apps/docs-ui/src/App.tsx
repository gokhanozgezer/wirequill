import { useCallback, useEffect, useRef, useState } from 'react';
import { documentRevision, type WireQuillOperationEvent } from './api/types.js';
import { ApiReference } from './components/ApiReference.js';
import {
  DiscoveryToasts,
  TOAST_LIFETIME_MS,
  type DiscoveryToast,
} from './components/DiscoveryToasts.js';
import { EmptyState } from './components/EmptyState.js';
import { TopBar } from './components/TopBar.js';
import { useWireQuillDocs } from './hooks/useWireQuillDocs.js';
import { useWireQuillEvents } from './hooks/useWireQuillEvents.js';

/**
 * The whole interface.
 *
 * One page, no router, no store, no data-fetching library. What this screen
 * does is: hold a snapshot, listen for "something changed", and refetch. React
 * state is the right size for that, and every dependency not added here is one
 * a security-sensitive local tool does not have to keep auditing
 * (spec sections 190 to 193).
 */
export default function App() {
  const { status, summary, document, refresh, scheduleRefresh } = useWireQuillDocs();
  const [toasts, setToasts] = useState<DiscoveryToast[]>([]);

  // Endpoints already announced, for the lifetime of this page. A discovery is
  // only new once, however many times the server restates it after a reconnect
  // (spec section 92).
  const announced = useRef(new Set<string>());
  const nextToastId = useRef(1);
  const toastTimers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const handleOperationEvent = useCallback(
    (event: WireQuillOperationEvent) => {
      // Both kinds move the documentation, so both trigger a refetch. Only a
      // discovery is worth interrupting the reader for (spec section 91).
      scheduleRefresh();

      if (event.type !== 'operation.discovered') {
        return;
      }

      const key = `${event.method} ${event.path}`;
      if (announced.current.has(key)) {
        return;
      }
      announced.current.add(key);

      const toast: DiscoveryToast = {
        id: nextToastId.current,
        method: event.method,
        path: event.path,
      };
      nextToastId.current += 1;

      setToasts((current) => [...current, toast]);

      const timer = setTimeout(() => {
        toastTimers.current.delete(timer);
        setToasts((current) => current.filter((entry) => entry.id !== toast.id));
      }, TOAST_LIFETIME_MS);

      toastTimers.current.add(timer);
    },
    [scheduleRefresh],
  );

  // Every (re)connection resyncs from the current snapshot, which is why the
  // server needs no event backlog: whatever was missed is already in the state
  // this fetch returns (spec sections 66 and 89).
  const { connection } = useWireQuillEvents({
    onOperationEvent: handleOperationEvent,
    onResync: refresh,
  });

  useEffect(() => {
    // The first load does not wait for the stream to open: historical
    // documentation from an earlier run is on disk and should be on screen
    // immediately (spec sections 121 and 122).
    refresh();
  }, [refresh]);

  useEffect(() => {
    const timers = toastTimers.current;

    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  return (
    <div className="flex min-h-full flex-col">
      <TopBar summary={summary} connection={connection} />
      <main className="flex flex-1 flex-col">{renderBody()}</main>
      <DiscoveryToasts toasts={toasts} />
    </div>
  );

  function renderBody() {
    // Never a bare zero on first paint: a restart with five endpoints on disk
    // must not flash "0 endpoints discovered" on its way to showing them
    // (spec section 123).
    if (status === 'loading') {
      return <Notice message="Starting WireQuill docs…" />;
    }

    if (status === 'error') {
      return (
        <Notice message="Could not load WireQuill documentation. Reconnecting…" tone="muted" />
      );
    }

    if (summary === null || summary.operations === 0 || document === null) {
      return <EmptyState summary={summary} />;
    }

    return <ApiReference document={document} revision={documentRevision(document)} />;
  }
}

function Notice({ message, tone = 'muted' }: { message: string; tone?: 'muted' }) {
  return (
    <section className="flex flex-1 items-center justify-center px-6 py-16" data-testid="notice">
      <p
        className={
          tone === 'muted'
            ? 'text-sm text-[var(--color-quill-muted)]'
            : 'text-sm text-[var(--color-quill-text)]'
        }
      >
        {message}
      </p>
    </section>
  );
}
