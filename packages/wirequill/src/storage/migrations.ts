/**
 * Schema migrations (spec sections 58 and 60).
 *
 * Migrations are append-only: never edit a shipped `up` statement, add a new
 * version instead. Each one runs inside a transaction together with the
 * `schema_migrations` bookkeeping row, so a crash mid-migration leaves the
 * database at the previous version rather than half-upgraded.
 */
export interface Migration {
  version: number;
  name: string;
  up: string;
}

const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  target_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_identity
ON workspaces(project_root, target_url);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  proxy_host TEXT NOT NULL,
  proxy_port INTEGER NOT NULL,
  docs_port INTEGER NOT NULL,
  wirequill_version TEXT NOT NULL,
  FOREIGN KEY(workspace_id)
    REFERENCES workspaces(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace
ON sessions(workspace_id);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path_template TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  tag TEXT,
  summary TEXT,
  observed_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  path_parameters_json TEXT NOT NULL,
  query_parameters_json TEXT NOT NULL,
  header_parameters_json TEXT NOT NULL,
  security_evidence_json TEXT NOT NULL,
  request_bodies_evidence_json TEXT NOT NULL,
  responses_evidence_json TEXT NOT NULL,
  public_revision INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(workspace_id)
    REFERENCES workspaces(id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operations_identity
ON operations(workspace_id, method, path_template);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  operation_id TEXT,
  observed_at TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER,
  duration_ms REAL,
  request_content_type TEXT,
  response_content_type TEXT,
  request_bytes INTEGER NOT NULL DEFAULT 0,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  request_truncated INTEGER NOT NULL DEFAULT 0,
  response_truncated INTEGER NOT NULL DEFAULT 0,
  request_parse_status TEXT,
  response_parse_status TEXT,
  upstream_error_code TEXT,
  FOREIGN KEY(session_id)
    REFERENCES sessions(id)
    ON DELETE CASCADE,
  FOREIGN KEY(operation_id)
    REFERENCES operations(id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_observations_session
ON observations(session_id);

CREATE INDEX IF NOT EXISTS idx_observations_operation
ON observations(operation_id);

CREATE TABLE IF NOT EXISTS examples (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  status_code INTEGER,
  media_type TEXT NOT NULL,
  body_json TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  FOREIGN KEY(operation_id)
    REFERENCES operations(id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_examples_dedupe
ON examples(
  operation_id,
  direction,
  status_code,
  media_type,
  body_hash
);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: INITIAL_SCHEMA,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);
