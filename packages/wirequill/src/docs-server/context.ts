import type { WireQuillEventBus } from '../events/event-bus.js';
import type { OpenApiService } from '../openapi/openapi-service.js';
import type { Storage } from '../storage/storage.js';

/**
 * Everything the docs server is allowed to see.
 *
 * Narrow on purpose. There is no config object here and no project root: the
 * server answers questions about observed traffic, and an absolute path on the
 * developer's disk is not one of them (spec sections 35 and 175).
 */
export interface DocsContext {
  version: string;
  /** Normalised, credential-free target URL. */
  targetUrl: string;
  proxyUrl: string;
  docsUrl: string;
  storage: Storage;
  workspaceId: string;
  openApi: OpenApiService;
  events: WireQuillEventBus;
  /** Shared with the OpenAPI service, so summaries agree with the document. */
  requiredAfterSamples: number;
}
