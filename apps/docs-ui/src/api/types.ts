/**
 * The contract between the docs server and this interface.
 *
 * Deliberately a small hand-written duplicate of the server's types rather than
 * an import from the CLI package. The two build with different module
 * resolutions, for different runtimes, and coupling them would drag Node types
 * into a browser bundle to save four interfaces (spec section 189).
 */

export interface WireQuillSummary {
  status: 'watching';
  target: string;
  proxyUrl: string;
  docsUrl: string;
  operations: number;
  observations: number;
  revision: number;
  lastObservedAt?: string;
}

export type WireQuillEventType = 'operation.discovered' | 'operation.updated';

export interface WireQuillOperationEvent {
  type: WireQuillEventType;
  revision: number;
  operationId: string;
  method: string;
  /** Normalized template, for example `/users/{userId}`. Never a raw URL. */
  path: string;
}

export type LiveConnectionState = 'connecting' | 'live' | 'reconnecting';

/**
 * The OpenAPI document, treated as opaque.
 *
 * This interface renders it and hands it to Scalar; it never inspects the
 * contents. The one exception is the revision below, which decides when the
 * reference has to be rebuilt.
 */
export type OpenApiDocument = Record<string, unknown>;

export function documentRevision(document: OpenApiDocument | null): number {
  if (document === null) {
    return 0;
  }

  const extension = document['x-wirequill'];

  if (typeof extension !== 'object' || extension === null) {
    return 0;
  }

  const { revision } = extension as { revision?: unknown };
  return typeof revision === 'number' ? revision : 0;
}
