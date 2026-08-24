import type {
  CreateSessionInput,
  Session,
  StoredExample,
  StoredObservation,
  StoredOperation,
  Workspace,
  WorkspaceIdentity,
  WorkspaceSummary,
} from './types.js';

/**
 * Persistence boundary (spec section 57).
 *
 * Kept as an interface so the SQLite implementation can be swapped — for a
 * degraded in-memory mode when the disk is full, or for `better-sqlite3` if
 * `node:sqlite` ever proves unsuitable — without the runtime noticing.
 */
export interface Storage {
  initialize(): void;

  getOrCreateWorkspace(input: WorkspaceIdentity): Workspace;

  createSession(input: CreateSessionInput): Session;
  endSession(sessionId: string, endedAt: string): void;
  getSession(sessionId: string): Session | null;

  getOperation(workspaceId: string, method: string, pathTemplate: string): StoredOperation | null;
  getOperationById(operationId: string): StoredOperation | null;
  upsertOperation(operation: StoredOperation): void;
  listOperations(workspaceId: string): StoredOperation[];

  insertObservation(observation: StoredObservation): void;
  pruneObservations(workspaceId: string, maxRows: number): number;

  insertExampleIfUnique(example: StoredExample, maxPerBucket: number): boolean;
  getExamples(operationId: string): StoredExample[];
  /**
   * Every example in a workspace, in one query.
   *
   * Document generation needs examples for every operation at once; fetching
   * them one operation at a time would be a query per endpoint.
   */
  listExamples(workspaceId: string): StoredExample[];

  getSummary(workspaceId: string): WorkspaceSummary;

  /**
   * Runs `work` atomically.
   *
   * An operation upsert and the observation that produced it belong together:
   * an observation pointing at an operation row that was never written would be
   * a dangling reference, and a crash between the two writes is exactly when
   * that happens.
   */
  runInTransaction<T>(work: () => T): T;

  close(): void;
}
