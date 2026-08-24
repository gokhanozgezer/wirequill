import { OPENAPI_URL } from '../api/client.js';
import type { LiveConnectionState, WireQuillSummary } from '../api/types.js';
import { LiveBadge } from './LiveBadge.js';
import { formatEndpointCount, friendlyTarget } from './top-bar-text.js';
import { WireQuillMark } from './WireQuillMark.js';

/**
 * The product shell (spec sections 24 to 27).
 *
 * Five things, in the order they matter: whose tool this is, whether it is
 * working, how much it has learned, where the traffic is going, and how to take
 * the result away. Nothing else belongs here — there is no account, no
 * workspace, nothing to configure.
 *
 * Sticky, because the reference below it is long and the endpoint count is the
 * thing people watch while clicking around their own application.
 */

export interface TopBarProps {
  summary: WireQuillSummary | null;
  connection: LiveConnectionState;
}

export function TopBar({ summary, connection }: TopBarProps) {
  const operations = summary?.operations ?? 0;

  return (
    <header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--color-quill-border)] bg-[var(--color-quill-bg)]/95 px-5 py-3 backdrop-blur-sm">
      <div className="flex items-center gap-2.5">
        <WireQuillMark className="h-[18px] w-[18px] text-[var(--color-quill-accent)]" />
        <span className="text-[15px] font-semibold tracking-tight text-[var(--color-quill-text)]">
          WireQuill
        </span>
      </div>

      <span aria-hidden="true" className="h-4 w-px bg-[var(--color-quill-border)]" />

      <LiveBadge state={connection} />

      <span
        className="text-sm tabular-nums text-[var(--color-quill-muted)]"
        data-testid="endpoint-count"
      >
        {formatEndpointCount(operations)}
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">
        {summary === null ? null : (
          <span className="flex items-baseline gap-2 text-sm">
            <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-quill-muted)]">
              Target
            </span>
            {/* The full URL only in the tooltip: the bar is one line and a long
                target would push everything else off it. */}
            <span
              className="font-mono text-[13px] text-[var(--color-quill-text)]"
              title={summary.target}
              data-testid="target-display"
            >
              {friendlyTarget(summary.target)}
            </span>
          </span>
        )}

        {/* A real link, not a scripted save. Same origin, same document the page
            is rendering, nothing regenerated. */}
        <a
          className="quill-focus rounded-md border border-[var(--color-quill-border)] px-3 py-1.5 text-[13px] font-medium text-[var(--color-quill-text)] transition-colors hover:border-[var(--color-quill-accent)] hover:text-[var(--color-quill-accent)]"
          href={OPENAPI_URL}
          download="openapi.json"
          data-testid="download-openapi"
        >
          Download OpenAPI
        </a>
      </div>
    </header>
  );
}
