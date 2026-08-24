import type { LiveConnectionState } from '../api/types.js';

/**
 * Connection status (spec sections 26 and 42).
 *
 * The dot is decoration. The word next to it is the status, because a green
 * circle means nothing to a screen reader and not much to a reader who cannot
 * distinguish it from the amber one.
 */

const LABELS: Record<LiveConnectionState, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
};

export function LiveBadge({ state }: { state: LiveConnectionState }) {
  const label = LABELS[state];
  const isLive = state === 'live';

  return (
    <span
      className="inline-flex items-center gap-2 text-sm"
      role="status"
      aria-label={`Live connection: ${label}`}
      data-testid="live-badge"
      data-state={state}
    >
      <span
        aria-hidden="true"
        className={
          isLive
            ? 'quill-pulse h-2 w-2 rounded-full bg-[var(--color-quill-accent)]'
            : 'h-2 w-2 rounded-full border border-[var(--color-quill-muted)]'
        }
      />
      <span
        className={
          isLive ? 'font-medium text-[var(--color-quill-text)]' : 'text-[var(--color-quill-muted)]'
        }
      >
        {label}
      </span>
    </span>
  );
}
