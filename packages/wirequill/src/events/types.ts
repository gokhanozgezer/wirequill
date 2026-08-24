/**
 * Events the documentation interface listens to (spec sections 54 and 55).
 *
 * Deliberately tiny. An event says that the public contract moved and which
 * operation moved it; the UI answers by refetching the current state. That is
 * the whole protocol, and it is why there is no backlog, no replay and no
 * sequence negotiation: a snapshot is always available and always authoritative
 * (spec section 66).
 *
 * Every field here has already crossed the privacy boundary. `path` is the
 * normalized template — `/users/{userId}`, never the request target — and there
 * is no query, no header, no body and no example anywhere in the payload.
 */

export type WireQuillEventType = 'operation.discovered' | 'operation.updated';

export interface WireQuillOperationEvent {
  type: WireQuillEventType;
  /** `OpenApiService.getRevision()` after the change. The only revision counter. */
  revision: number;
  /** Stable operation identity, safe to expose: a hash, not a path. */
  operationId: string;
  method: string;
  /** Normalized path template. */
  path: string;
}

export type WireQuillEvent = WireQuillOperationEvent;
