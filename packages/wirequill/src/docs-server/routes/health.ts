import type { DocsContext } from '../context.js';

export interface HealthPayload {
  ok: true;
  version: string;
  target: string;
  proxy: string;
  docs: string;
  revision: number;
}

/**
 * Liveness plus the three addresses in play (spec section 34).
 *
 * What is absent is the point: no project root, no database path, no workspace
 * id, no session id. This is the endpoint most likely to be pasted into an
 * issue report, so it holds nothing that identifies the machine it ran on
 * (spec section 35).
 */
export function buildHealth(context: DocsContext): HealthPayload {
  return {
    ok: true,
    version: context.version,
    target: context.targetUrl,
    proxy: context.proxyUrl,
    docs: context.docsUrl,
    revision: context.openApi.getRevision(),
  };
}
