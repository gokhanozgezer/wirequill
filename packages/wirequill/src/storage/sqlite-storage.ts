import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { tightenDatabasePermissions } from '../project/data-directory.js';
import { systemClock, toIsoString, type Clock } from '../utils/clock.js';
import { deriveWorkspaceId, uuidGenerator, type IdGenerator } from '../utils/ids.js';
import { WireQuillError, errorMessage, isWireQuillError } from '../utils/errors.js';
import { stableStringify } from '../utils/stable-json.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations.js';
import type { Storage } from './storage.js';
import type {
  CreateSessionInput,
  ExampleDirection,
  Session,
  StoredExample,
  StoredObservation,
  StoredOperation,
  Workspace,
  WorkspaceIdentity,
  WorkspaceSummary,
} from './types.js';

const IN_MEMORY = ':memory:';

/**
 * `node:sqlite` is loaded on first use rather than through a static import.
 *
 * A static ESM import is hoisted above every statement in the bundle, so it
 * would run before the CLI installs its warning filter and Node's SQLite
 * experimental warning would reach the terminal on every start. Requiring the
 * module lazily keeps that filter effective while staying synchronous.
 */
interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseSync;
}

let sqliteModule: SqliteModule | null = null;

function loadSqlite(): SqliteModule {
  sqliteModule ??= createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  return sqliteModule;
}

export interface SqliteStorageOptions {
  /** Absolute path, or `:memory:` for tests. */
  databasePath: string;
  clock?: Clock;
  ids?: IdGenerator;
}

type Row = Record<string, unknown>;

/**
 * `node:sqlite` implementation of {@link Storage}.
 *
 * Every statement with a variable is prepared (spec section 59). Statements are
 * prepared lazily and cached, because preparing the full set up front would pay
 * for operations a short session never performs.
 */
export class SqliteStorage implements Storage {
  readonly #databasePath: string;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #statements = new Map<string, StatementSync>();

  #db: DatabaseSync | null = null;

  constructor(options: SqliteStorageOptions) {
    this.#databasePath = options.databasePath;
    this.#clock = options.clock ?? systemClock;
    this.#ids = options.ids ?? uuidGenerator;
  }

  initialize(): void {
    if (this.#db !== null) {
      return;
    }

    if (this.#databasePath !== IN_MEMORY) {
      mkdirSync(path.dirname(this.#databasePath), { recursive: true });
    }

    let db: DatabaseSync;
    try {
      db = new (loadSqlite().DatabaseSync)(this.#databasePath);
    } catch (error) {
      throw new WireQuillError(
        'DB_OPEN_FAILED',
        `Could not open the WireQuill database:\n${this.#databasePath}\n\n${errorMessage(error)}`,
        'Check that the path is writable, or pass --db to use another location.',
      );
    }

    try {
      this.#applyPragmas(db);
      this.#migrate(db);
    } catch (error) {
      // Leaving a half-open handle behind would make a retry report "already
      // initialized" instead of the real problem.
      db.close();

      // A file that is not a database — a truncated copy, a bad restore, a sync
      // conflict — fails here rather than at open, because SQLite reads nothing
      // until it is asked to. Reported as something the user can act on, and
      // deliberately not repaired: the file is theirs, and WireQuill deleting
      // or overwriting it would destroy whatever could still be recovered
      // (spec section 51).
      if (isWireQuillError(error)) {
        throw error;
      }

      throw new WireQuillError(
        'DB_UNREADABLE',
        [
          'The WireQuill database could not be read:',
          this.#databasePath,
          '',
          errorMessage(error),
        ].join('\n'),
        [
          'The file may be corrupt or may not be a SQLite database.',
          'WireQuill will not overwrite it. Move it aside, or pass --db to use',
          'another location.',
        ].join('\n'),
      );
    }

    this.#db = db;

    if (this.#databasePath !== IN_MEMORY) {
      tightenDatabasePermissions(this.#databasePath);
    }
  }

  // ---------------------------------------------------------------- workspaces

  getOrCreateWorkspace(input: WorkspaceIdentity): Workspace {
    const now = toIsoString(this.#clock.now());
    const id = deriveWorkspaceId(input.projectRoot, input.targetUrl);

    this.#statement(
      `INSERT INTO workspaces (id, project_root, target_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_root, target_url) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(id, input.projectRoot, input.targetUrl, now, now);

    const row = this.#statement(
      'SELECT * FROM workspaces WHERE project_root = ? AND target_url = ?',
    ).get(input.projectRoot, input.targetUrl) as Row | undefined;

    if (row === undefined) {
      throw new WireQuillError('DB_INCONSISTENT', 'Workspace row disappeared after insert.');
    }

    return toWorkspace(row);
  }

  // ------------------------------------------------------------------ sessions

  createSession(input: CreateSessionInput): Session {
    const session: Session = {
      id: this.#ids.next(),
      workspaceId: input.workspaceId,
      startedAt: toIsoString(this.#clock.now()),
      endedAt: null,
      proxyHost: input.proxyHost,
      proxyPort: input.proxyPort,
      docsPort: input.docsPort,
      wirequillVersion: input.wirequillVersion,
    };

    this.#statement(
      `INSERT INTO sessions
         (id, workspace_id, started_at, ended_at, proxy_host, proxy_port, docs_port, wirequill_version)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(
      session.id,
      session.workspaceId,
      session.startedAt,
      session.proxyHost,
      session.proxyPort,
      session.docsPort,
      session.wirequillVersion,
    );

    return session;
  }

  endSession(sessionId: string, endedAt: string): void {
    this.#statement('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endedAt, sessionId);
  }

  getSession(sessionId: string): Session | null {
    const row = this.#statement('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
      Row | undefined;
    return row === undefined ? null : toSession(row);
  }

  // ---------------------------------------------------------------- operations

  getOperation(workspaceId: string, method: string, pathTemplate: string): StoredOperation | null {
    const row = this.#statement(
      'SELECT * FROM operations WHERE workspace_id = ? AND method = ? AND path_template = ?',
    ).get(workspaceId, method, pathTemplate) as Row | undefined;

    return row === undefined ? null : toOperation(row);
  }

  getOperationById(operationId: string): StoredOperation | null {
    const row = this.#statement('SELECT * FROM operations WHERE id = ?').get(operationId) as
      Row | undefined;
    return row === undefined ? null : toOperation(row);
  }

  upsertOperation(operation: StoredOperation): void {
    this.#statement(
      `INSERT INTO operations (
         id, workspace_id, method, path_template, operation_id, tag, summary,
         observed_count, first_seen_at, last_seen_at,
         path_parameters_json, query_parameters_json, header_parameters_json,
         security_evidence_json, request_bodies_evidence_json, responses_evidence_json,
         public_revision
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, method, path_template) DO UPDATE SET
         operation_id = excluded.operation_id,
         tag = excluded.tag,
         summary = excluded.summary,
         observed_count = excluded.observed_count,
         last_seen_at = excluded.last_seen_at,
         path_parameters_json = excluded.path_parameters_json,
         query_parameters_json = excluded.query_parameters_json,
         header_parameters_json = excluded.header_parameters_json,
         security_evidence_json = excluded.security_evidence_json,
         request_bodies_evidence_json = excluded.request_bodies_evidence_json,
         responses_evidence_json = excluded.responses_evidence_json,
         public_revision = excluded.public_revision`,
    ).run(
      operation.id,
      operation.workspaceId,
      operation.method,
      operation.pathTemplate,
      operation.operationId,
      operation.tag,
      operation.summary,
      operation.observedCount,
      operation.firstSeenAt,
      operation.lastSeenAt,
      stableStringify(operation.pathParameters),
      stableStringify(operation.queryParameters),
      stableStringify(operation.headerParameters),
      stableStringify(operation.securityEvidence),
      stableStringify(operation.requestBodiesEvidence),
      stableStringify(operation.responsesEvidence),
      operation.publicRevision,
    );
  }

  listOperations(workspaceId: string): StoredOperation[] {
    const rows = this.#statement(
      `SELECT * FROM operations
       WHERE workspace_id = ?
       ORDER BY path_template ASC, method ASC`,
    ).all(workspaceId) as Row[];

    return rows.map(toOperation);
  }

  // -------------------------------------------------------------- observations

  insertObservation(observation: StoredObservation): void {
    this.#statement(
      `INSERT INTO observations (
         id, session_id, operation_id, observed_at, method, status_code, duration_ms,
         request_content_type, response_content_type, request_bytes, response_bytes,
         request_truncated, response_truncated, request_parse_status, response_parse_status,
         upstream_error_code
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      observation.id,
      observation.sessionId,
      observation.operationId,
      observation.observedAt,
      observation.method,
      observation.statusCode,
      observation.durationMs,
      observation.requestContentType,
      observation.responseContentType,
      observation.requestBytes,
      observation.responseBytes,
      toDbBoolean(observation.requestTruncated),
      toDbBoolean(observation.responseTruncated),
      observation.requestParseStatus,
      observation.responseParseStatus,
      observation.upstreamErrorCode,
    );
  }

  pruneObservations(workspaceId: string, maxRows: number): number {
    const result = this.#statement(
      `DELETE FROM observations
       WHERE id IN (
         SELECT o.id
         FROM observations o
         JOIN sessions s ON s.id = o.session_id
         WHERE s.workspace_id = ?
         ORDER BY o.observed_at DESC, o.id DESC
         LIMIT -1 OFFSET ?
       )`,
    ).run(workspaceId, maxRows);

    return Number(result.changes);
  }

  // ------------------------------------------------------------------ examples

  insertExampleIfUnique(example: StoredExample, maxPerBucket: number): boolean {
    const bucketCount = this.#statement(
      `SELECT COUNT(*) AS count FROM examples
       WHERE operation_id = ? AND direction = ? AND status_code IS ? AND media_type = ?`,
    ).get(example.operationId, example.direction, example.statusCode, example.mediaType) as
      Row | undefined;

    if (asNumber(bucketCount?.count ?? 0) >= maxPerBucket) {
      return false;
    }

    const result = this.#statement(
      `INSERT OR IGNORE INTO examples
         (id, operation_id, direction, status_code, media_type, body_json, body_hash, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      example.id,
      example.operationId,
      example.direction,
      example.statusCode,
      example.mediaType,
      example.bodyJson,
      example.bodyHash,
      example.observedAt,
    );

    return Number(result.changes) > 0;
  }

  listExamples(workspaceId: string): StoredExample[] {
    const rows = this.#statement(
      `SELECT e.* FROM examples e
       JOIN operations o ON o.id = e.operation_id
       WHERE o.workspace_id = ?
       ORDER BY e.observed_at ASC, e.id ASC`,
    ).all(workspaceId) as Row[];

    return rows.map(toExample);
  }

  getExamples(operationId: string): StoredExample[] {
    const rows = this.#statement(
      'SELECT * FROM examples WHERE operation_id = ? ORDER BY observed_at ASC, id ASC',
    ).all(operationId) as Row[];

    return rows.map(toExample);
  }

  // ------------------------------------------------------------------- summary

  getSummary(workspaceId: string): WorkspaceSummary {
    const operations = this.#statement(
      'SELECT COUNT(*) AS count FROM operations WHERE workspace_id = ?',
    ).get(workspaceId) as Row | undefined;

    const sessions = this.#statement(
      'SELECT COUNT(*) AS count FROM sessions WHERE workspace_id = ?',
    ).get(workspaceId) as Row | undefined;

    const observations = this.#statement(
      `SELECT COUNT(*) AS count, MAX(o.observed_at) AS last_observed_at
       FROM observations o
       JOIN sessions s ON s.id = o.session_id
       WHERE s.workspace_id = ?`,
    ).get(workspaceId) as Row | undefined;

    return {
      workspaceId,
      operationCount: asNumber(operations?.count ?? 0),
      sessionCount: asNumber(sessions?.count ?? 0),
      observationCount: asNumber(observations?.count ?? 0),
      lastObservedAt: asNullableString(observations?.last_observed_at ?? null),
    };
  }

  runInTransaction<T>(work: () => T): T {
    const db = this.#requireDb();

    // SQLite has no nested transactions; a savepoint would be needed for that,
    // and nothing in WireQuill nests today.
    db.exec('BEGIN');

    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.#db === null) {
      return;
    }

    this.#statements.clear();
    try {
      this.#db.close();
    } finally {
      this.#db = null;
    }
  }

  // -------------------------------------------------------------- internals

  #applyPragmas(db: DatabaseSync): void {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');

    if (this.#databasePath !== IN_MEMORY) {
      // WAL is meaningless for an in-memory database and SQLite silently keeps
      // journal_mode=memory there, so the call is simply skipped.
      db.exec('PRAGMA journal_mode = WAL');
    }
  }

  #migrate(db: DatabaseSync): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at TEXT NOT NULL
       )`,
    );

    const currentRow = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
      Row | undefined;
    const current = asNumber(currentRow?.version ?? 0);

    if (current > LATEST_SCHEMA_VERSION) {
      throw new WireQuillError(
        'DB_SCHEMA_TOO_NEW',
        [
          'This database was created by a newer WireQuill version.',
          `Database schema version: ${String(current)}`,
          `Supported schema version: ${String(LATEST_SCHEMA_VERSION)}`,
        ].join('\n'),
        'Upgrade WireQuill, or point --db at a different file.',
      );
    }

    const appliedAt = toIsoString(this.#clock.now());

    for (const migration of MIGRATIONS) {
      if (migration.version <= current) {
        continue;
      }

      db.exec('BEGIN');
      try {
        db.exec(migration.up);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
          migration.version,
          appliedAt,
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw new WireQuillError(
          'DB_MIGRATION_FAILED',
          `Migration ${String(migration.version)} (${migration.name}) failed:\n${errorMessage(error)}`,
        );
      }
    }
  }

  #statement(sql: string): StatementSync {
    const db = this.#requireDb();
    const cached = this.#statements.get(sql);
    if (cached !== undefined) {
      return cached;
    }

    const prepared = db.prepare(sql);
    this.#statements.set(sql, prepared);
    return prepared;
  }

  #requireDb(): DatabaseSync {
    if (this.#db === null) {
      throw new WireQuillError(
        'DB_NOT_INITIALIZED',
        'Storage was used before initialize() was called.',
      );
    }
    return this.#db;
  }
}

export function createSqliteStorage(options: SqliteStorageOptions): Storage {
  return new SqliteStorage(options);
}

// ---------------------------------------------------------------- row mapping

function toWorkspace(row: Row): Workspace {
  return {
    id: asString(row.id),
    projectRoot: asString(row.project_root),
    targetUrl: asString(row.target_url),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function toSession(row: Row): Session {
  return {
    id: asString(row.id),
    workspaceId: asString(row.workspace_id),
    startedAt: asString(row.started_at),
    endedAt: asNullableString(row.ended_at),
    proxyHost: asString(row.proxy_host),
    proxyPort: asNumber(row.proxy_port),
    docsPort: asNumber(row.docs_port),
    wirequillVersion: asString(row.wirequill_version),
  };
}

function toOperation(row: Row): StoredOperation {
  return {
    id: asString(row.id),
    workspaceId: asString(row.workspace_id),
    method: asString(row.method),
    pathTemplate: asString(row.path_template),
    operationId: asString(row.operation_id),
    tag: asNullableString(row.tag),
    summary: asNullableString(row.summary),
    observedCount: asNumber(row.observed_count),
    firstSeenAt: asString(row.first_seen_at),
    lastSeenAt: asString(row.last_seen_at),
    pathParameters: parseJson(row.path_parameters_json),
    queryParameters: parseJson(row.query_parameters_json),
    headerParameters: parseJson(row.header_parameters_json),
    securityEvidence: parseJson(row.security_evidence_json),
    requestBodiesEvidence: parseJson(row.request_bodies_evidence_json),
    responsesEvidence: parseJson(row.responses_evidence_json),
    publicRevision: asNumber(row.public_revision),
  };
}

function toExample(row: Row): StoredExample {
  return {
    id: asString(row.id),
    operationId: asString(row.operation_id),
    direction: asString(row.direction) as ExampleDirection,
    statusCode: asNullableNumber(row.status_code),
    mediaType: asString(row.media_type),
    bodyJson: asString(row.body_json),
    bodyHash: asString(row.body_hash),
    observedAt: asString(row.observed_at),
  };
}

// -------------------------------------------------------------- value helpers

/** `node:sqlite` accepts no booleans, so flags are stored as 0/1 integers. */
function toDbBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return Number(value ?? 0);
}

function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
