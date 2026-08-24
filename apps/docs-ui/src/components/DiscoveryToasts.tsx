/**
 * Discovery notices (spec sections 32 to 34).
 *
 * Only for endpoints nobody had seen before. `operation.updated` fires whenever
 * a field turns optional or a new status shows up, which is often, and a toast
 * for each would turn ordinary use of an application into a stream of
 * notifications nobody reads.
 *
 * The path shown is the normalized template the server sent. There is no raw
 * URL anywhere in this component, so there is nothing here to leak.
 */

export interface DiscoveryToast {
  id: number;
  method: string;
  path: string;
}

/** Three at once; more is a wall, not a notification. */
export const MAX_VISIBLE_TOASTS = 3;

export const TOAST_LIFETIME_MS = 3_000;

/**
 * Restrained method colouring.
 *
 * Enough to tell a read from a write at a glance, not enough to turn the corner
 * of the screen into a traffic light.
 */
const METHOD_TONE: Record<string, string> = {
  GET: 'text-[var(--color-quill-accent)]',
  HEAD: 'text-[var(--color-quill-accent)]',
  POST: 'text-[var(--color-quill-blue)]',
  PUT: 'text-[var(--color-quill-blue)]',
  PATCH: 'text-[var(--color-quill-blue)]',
  DELETE: 'text-[var(--color-quill-warn)]',
};

export function DiscoveryToasts({ toasts }: { toasts: readonly DiscoveryToast[] }) {
  if (toasts.length === 0) {
    return null;
  }

  return (
    <div
      className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col gap-2"
      // Polite, not assertive: a new endpoint is news, not an alarm.
      aria-live="polite"
      data-testid="discovery-toasts"
    >
      {toasts.slice(-MAX_VISIBLE_TOASTS).map((toast) => (
        <div
          key={toast.id}
          className="quill-enter min-w-[240px] rounded-lg border border-[var(--color-quill-border)] bg-[var(--color-quill-surface)] px-4 py-3 shadow-xl shadow-black/40"
          data-testid="discovery-toast"
        >
          <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-quill-muted)]">
            Discovered
          </p>
          <p className="mt-1.5 flex items-baseline gap-2 font-mono text-sm">
            <span
              className={`text-[11px] font-semibold ${METHOD_TONE[toast.method.toUpperCase()] ?? 'text-[var(--color-quill-muted)]'}`}
            >
              {toast.method.toUpperCase()}
            </span>
            <span className="text-[var(--color-quill-text)]">{toast.path}</span>
          </p>
        </div>
      ))}
    </div>
  );
}
