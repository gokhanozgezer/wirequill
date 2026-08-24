import type { WireQuillSummary } from '../api/types.js';

/**
 * The first screen (spec sections 28 to 30).
 *
 * This is the moment the product either explains itself or does not. It has one
 * job: say what is about to happen, and give the one address that has to change
 * for it to happen.
 *
 * Deliberately not a tutorial. No steps, no framework picker, no wizard — the
 * whole point of WireQuill is that there is nothing to set up, and a
 * four-step onboarding flow would argue the opposite.
 */

export function EmptyState({ summary }: { summary: WireQuillSummary | null }) {
  return (
    <section
      className="quill-enter flex flex-1 items-center justify-center px-6 py-20"
      data-testid="empty-state"
    >
      <div className="w-full max-w-lg">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--color-quill-text)]">
          Your API docs will appear here.
        </h1>

        <p className="mt-3 text-[15px] leading-relaxed text-[var(--color-quill-muted)]">
          Use your application normally. WireQuill is watching the traffic.
        </p>

        {summary === null ? null : (
          <div className="mt-10 space-y-6">
            <div>
              <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-quill-muted)]">
                Point your app to
              </p>
              {/* The one thing the reader actually has to do, given as a value
                  they can copy rather than a paragraph they have to parse. */}
              <p className="mt-2 select-all font-mono text-lg text-[var(--color-quill-accent)]">
                {summary.proxyUrl}
              </p>
            </div>

            <div>
              <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-quill-muted)]">
                Forwarding to
              </p>
              <p className="mt-2 font-mono text-sm text-[var(--color-quill-text)]">
                {summary.target}
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
