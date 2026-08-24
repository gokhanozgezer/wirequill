import type { DocsContext } from '../context.js';

export interface SummaryPayload {
  status: 'watching';
  target: string;
  proxyUrl: string;
  docsUrl: string;
  operations: number;
  observations: number;
  revision: number;
  lastObservedAt?: string;
}

/**
 * What the top bar renders (spec section 36).
 *
 * Counts and timestamps only. `lastObservedAt` is safe metadata — it says that
 * traffic happened, not what the traffic was — and it is what lets the UI
 * distinguish "nothing has happened yet" from "nothing has happened lately".
 *
 * Answered from aggregate counts rather than by scanning observations, because
 * the UI asks for this on every reconnect (spec section 124).
 */
export function buildSummary(context: DocsContext): SummaryPayload {
  const summary = context.storage.getSummary(context.workspaceId);

  return {
    status: 'watching',
    target: context.targetUrl,
    proxyUrl: context.proxyUrl,
    docsUrl: context.docsUrl,
    operations: summary.operationCount,
    observations: summary.observationCount,
    revision: context.openApi.getRevision(),
    ...(summary.lastObservedAt === null ? {} : { lastObservedAt: summary.lastObservedAt }),
  };
}
