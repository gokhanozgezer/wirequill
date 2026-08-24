/**
 * A writer that is meant to be killed (spec section 21).
 *
 *   node abrupt-writer.mjs <databasePath> <workspaceId>
 *
 * Opens the WireQuill database the way WireQuill opens it, starts a transaction,
 * inserts a row, and then waits forever without committing. The parent test
 * kills it with SIGKILL, which leaves a hot WAL and an uncommitted transaction
 * behind — the state a machine that lost power would leave.
 *
 * What must survive that: everything already committed, and the ability to open
 * the database at all. What may be lost: this row.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const [databasePath, workspaceId] = process.argv.slice(2);

if (databasePath === undefined || workspaceId === undefined) {
  console.error('usage: abrupt-writer.mjs <databasePath> <workspaceId>');
  process.exit(2);
}

const db = new DatabaseSync(databasePath);

db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA journal_mode = WAL');

db.exec('BEGIN');

db.prepare(
  `INSERT INTO operations (
     id, workspace_id, method, path_template, operation_id,
     tag, summary, observed_count, first_seen_at, last_seen_at,
     path_parameters_json, query_parameters_json, header_parameters_json,
     security_evidence_json, request_bodies_evidence_json, responses_evidence_json,
     public_revision
   ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  'never-committed',
  workspaceId,
  'GET',
  '/never-committed',
  'getNeverCommitted',
  1,
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00.000Z',
  '[]',
  '[]',
  '[]',
  '{}',
  '{}',
  '{}',
  1,
);

// Tell the parent the transaction is open and the WAL is hot, then stall.
process.stdout.write('ready\n');

setInterval(() => undefined, 1_000);
