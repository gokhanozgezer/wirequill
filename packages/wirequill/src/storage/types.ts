/**
 * Storage row models (spec sections 57 and 58).
 *
 * The inference-shaped fields (`pathParameters`, `responsesEvidence`, ...) are
 * intentionally opaque at this milestone. They are persisted as deterministic
 * JSON blobs so the schema is stable before the inference engine exists, and
 * they gain real types when that engine lands.
 */

export interface WorkspaceIdentity {
  projectRoot: string;
  /** Normalised target, so `http://Localhost:8080/` and `http://localhost:8080` agree. */
  targetUrl: string;
}

export interface Workspace {
  id: string;
  projectRoot: string;
  targetUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionInput {
  workspaceId: string;
  proxyHost: string;
  proxyPort: number;
  docsPort: number;
  wirequillVersion: string;
}

export interface Session {
  id: string;
  workspaceId: string;
  startedAt: string;
  endedAt: string | null;
  proxyHost: string;
  proxyPort: number;
  docsPort: number;
  wirequillVersion: string;
}

/** Opaque evidence payload; typed once the inference engine exists. */
export type EvidenceBlob = unknown;

export interface StoredOperation {
  id: string;
  workspaceId: string;
  method: string;
  pathTemplate: string;
  operationId: string;
  tag: string | null;
  summary: string | null;
  observedCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  pathParameters: EvidenceBlob;
  queryParameters: EvidenceBlob;
  headerParameters: EvidenceBlob;
  securityEvidence: EvidenceBlob;
  requestBodiesEvidence: EvidenceBlob;
  responsesEvidence: EvidenceBlob;
  publicRevision: number;
}

export interface StoredObservation {
  id: string;
  sessionId: string;
  operationId: string | null;
  observedAt: string;
  method: string;
  statusCode: number | null;
  durationMs: number | null;
  requestContentType: string | null;
  responseContentType: string | null;
  requestBytes: number;
  responseBytes: number;
  requestTruncated: boolean;
  responseTruncated: boolean;
  requestParseStatus: string | null;
  responseParseStatus: string | null;
  upstreamErrorCode: string | null;
}

export type ExampleDirection = 'request' | 'response';

export interface StoredExample {
  id: string;
  operationId: string;
  direction: ExampleDirection;
  statusCode: number | null;
  mediaType: string;
  /** Already redacted before it reaches storage. Never a raw payload. */
  bodyJson: string;
  bodyHash: string;
  observedAt: string;
}

export interface WorkspaceSummary {
  workspaceId: string;
  operationCount: number;
  observationCount: number;
  sessionCount: number;
  lastObservedAt: string | null;
}
