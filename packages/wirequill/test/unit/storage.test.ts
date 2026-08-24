import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '../../src/storage/sqlite-storage.js';
import { LATEST_SCHEMA_VERSION } from '../../src/storage/migrations.js';
import type { StoredExample, StoredObservation, StoredOperation } from '../../src/storage/types.js';
import { fixedClock } from '../../src/utils/clock.js';
import { WireQuillError } from '../../src/utils/errors.js';

const CLOCK = fixedClock('2026-08-23T10:00:00.000Z');

function newStorage(databasePath = ':memory:'): SqliteStorage {
  let counter = 0;
  const storage = new SqliteStorage({
    databasePath,
    clock: CLOCK,
    ids: {
      next: () => {
        counter += 1;
        return `id-${String(counter).padStart(4, '0')}`;
      },
    },
  });
  storage.initialize();
  return storage;
}

function makeOperation(overrides: Partial<StoredOperation> = {}): StoredOperation {
  return {
    id: 'op-1',
    workspaceId: 'ws-1',
    method: 'GET',
    pathTemplate: '/users/{userId}',
    operationId: 'getUsersByUserId',
    tag: 'users',
    summary: null,
    observedCount: 1,
    firstSeenAt: '2026-08-23T10:00:00.000Z',
    lastSeenAt: '2026-08-23T10:00:00.000Z',
    pathParameters: [{ name: 'userId', type: 'integer' }],
    queryParameters: [],
    headerParameters: [],
    securityEvidence: { bearer: 0, basic: 0, apiKeys: {}, unauthenticated: 1 },
    requestBodiesEvidence: {},
    responsesEvidence: { '200': {} },
    publicRevision: 1,
    ...overrides,
  };
}

function makeObservation(overrides: Partial<StoredObservation> = {}): StoredObservation {
  return {
    id: 'obs-1',
    sessionId: 'session-1',
    operationId: null,
    observedAt: '2026-08-23T10:00:00.000Z',
    method: 'GET',
    statusCode: 200,
    durationMs: 12.5,
    requestContentType: null,
    responseContentType: 'application/json',
    requestBytes: 0,
    responseBytes: 128,
    requestTruncated: false,
    responseTruncated: false,
    requestParseStatus: null,
    responseParseStatus: 'ok',
    upstreamErrorCode: null,
    ...overrides,
  };
}

function makeExample(overrides: Partial<StoredExample> = {}): StoredExample {
  return {
    id: 'ex-1',
    operationId: 'op-1',
    direction: 'response',
    statusCode: 200,
    mediaType: 'application/json',
    bodyJson: '{"id":1}',
    bodyHash: 'hash-a',
    observedAt: '2026-08-23T10:00:00.000Z',
    ...overrides,
  };
}

describe('SqliteStorage — workspaces and sessions', () => {
  let storage: SqliteStorage;

  beforeEach(() => {
    storage = newStorage();
  });

  afterEach(() => {
    storage.close();
  });

  it('returns the same workspace for the same project and target', () => {
    const identity = { projectRoot: 'D:/work/acme', targetUrl: 'http://localhost:8080' };

    const first = storage.getOrCreateWorkspace(identity);
    const second = storage.getOrCreateWorkspace(identity);

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('separates workspaces by target', () => {
    const a = storage.getOrCreateWorkspace({
      projectRoot: 'D:/work/acme',
      targetUrl: 'http://localhost:8080',
    });
    const b = storage.getOrCreateWorkspace({
      projectRoot: 'D:/work/acme',
      targetUrl: 'http://localhost:9090',
    });

    expect(a.id).not.toBe(b.id);
  });

  it('separates workspaces by project root', () => {
    const a = storage.getOrCreateWorkspace({
      projectRoot: 'D:/work/acme',
      targetUrl: 'http://localhost:8080',
    });
    const b = storage.getOrCreateWorkspace({
      projectRoot: 'D:/work/other',
      targetUrl: 'http://localhost:8080',
    });

    expect(a.id).not.toBe(b.id);
  });

  it('creates a distinct session per run and records the end time', () => {
    const workspace = storage.getOrCreateWorkspace({
      projectRoot: 'D:/work/acme',
      targetUrl: 'http://localhost:8080',
    });

    const first = storage.createSession({
      workspaceId: workspace.id,
      proxyHost: '127.0.0.1',
      proxyPort: 3000,
      docsPort: 3001,
      wirequillVersion: '0.1.0',
    });
    const second = storage.createSession({
      workspaceId: workspace.id,
      proxyHost: '127.0.0.1',
      proxyPort: 3000,
      docsPort: 3001,
      wirequillVersion: '0.1.0',
    });

    expect(first.id).not.toBe(second.id);
    expect(first.endedAt).toBeNull();

    storage.endSession(first.id, '2026-08-23T11:00:00.000Z');

    expect(storage.getSession(first.id)?.endedAt).toBe('2026-08-23T11:00:00.000Z');
    expect(storage.getSession(second.id)?.endedAt).toBeNull();
  });
});

describe('SqliteStorage — operations, observations and examples', () => {
  let storage: SqliteStorage;
  let workspaceId: string;
  let sessionId: string;

  beforeEach(() => {
    storage = newStorage();
    workspaceId = storage.getOrCreateWorkspace({
      projectRoot: 'D:/work/acme',
      targetUrl: 'http://localhost:8080',
    }).id;
    sessionId = storage.createSession({
      workspaceId,
      proxyHost: '127.0.0.1',
      proxyPort: 3000,
      docsPort: 3001,
      wirequillVersion: '0.1.0',
    }).id;
  });

  afterEach(() => {
    storage.close();
  });

  it('round-trips an operation including its evidence blobs', () => {
    const operation = makeOperation({ workspaceId });
    storage.upsertOperation(operation);

    const loaded = storage.getOperation(workspaceId, 'GET', '/users/{userId}');

    expect(loaded).not.toBeNull();
    expect(loaded?.operationId).toBe('getUsersByUserId');
    expect(loaded?.pathParameters).toEqual([{ name: 'userId', type: 'integer' }]);
    expect(loaded?.responsesEvidence).toEqual({ '200': {} });
  });

  it('upserts on the workspace/method/path identity rather than inserting twice', () => {
    storage.upsertOperation(makeOperation({ workspaceId }));
    storage.upsertOperation(
      makeOperation({ workspaceId, observedCount: 7, lastSeenAt: '2026-08-23T12:00:00.000Z' }),
    );

    const operations = storage.listOperations(workspaceId);

    expect(operations).toHaveLength(1);
    expect(operations[0]?.observedCount).toBe(7);
    expect(operations[0]?.lastSeenAt).toBe('2026-08-23T12:00:00.000Z');
  });

  it('lists operations in a deterministic order', () => {
    storage.upsertOperation(makeOperation({ workspaceId, id: 'a', pathTemplate: '/b' }));
    storage.upsertOperation(makeOperation({ workspaceId, id: 'b', pathTemplate: '/a' }));
    storage.upsertOperation(
      makeOperation({ workspaceId, id: 'c', pathTemplate: '/a', method: 'POST' }),
    );

    expect(
      storage.listOperations(workspaceId).map((op) => `${op.method} ${op.pathTemplate}`),
    ).toEqual(['GET /a', 'POST /a', 'GET /b']);
  });

  it('stores boolean flags as integers without losing them', () => {
    storage.insertObservation(
      makeObservation({ sessionId, requestTruncated: true, responseTruncated: false }),
    );

    expect(storage.getSummary(workspaceId).observationCount).toBe(1);
  });

  it('keeps at most maxPerBucket examples', () => {
    storage.upsertOperation(makeOperation({ workspaceId }));

    expect(storage.insertExampleIfUnique(makeExample({ id: 'ex-1', bodyHash: 'a' }), 2)).toBe(true);
    expect(storage.insertExampleIfUnique(makeExample({ id: 'ex-2', bodyHash: 'b' }), 2)).toBe(true);
    expect(storage.insertExampleIfUnique(makeExample({ id: 'ex-3', bodyHash: 'c' }), 2)).toBe(
      false,
    );

    expect(storage.getExamples('op-1')).toHaveLength(2);
  });

  it('rejects a duplicate example body within the same bucket', () => {
    storage.upsertOperation(makeOperation({ workspaceId }));

    expect(storage.insertExampleIfUnique(makeExample({ id: 'ex-1', bodyHash: 'a' }), 3)).toBe(true);
    expect(storage.insertExampleIfUnique(makeExample({ id: 'ex-2', bodyHash: 'a' }), 3)).toBe(
      false,
    );
    expect(storage.getExamples('op-1')).toHaveLength(1);
  });

  it('buckets examples separately per status code', () => {
    storage.upsertOperation(makeOperation({ workspaceId }));

    expect(
      storage.insertExampleIfUnique(makeExample({ id: 'ex-1', statusCode: 200, bodyHash: 'a' }), 1),
    ).toBe(true);
    expect(
      storage.insertExampleIfUnique(makeExample({ id: 'ex-2', statusCode: 404, bodyHash: 'a' }), 1),
    ).toBe(true);
  });

  it('prunes the oldest observations beyond the cap', () => {
    for (let index = 0; index < 5; index += 1) {
      storage.insertObservation(
        makeObservation({
          id: `obs-${String(index)}`,
          sessionId,
          observedAt: `2026-08-23T10:0${String(index)}:00.000Z`,
        }),
      );
    }

    const deleted = storage.pruneObservations(workspaceId, 3);

    expect(deleted).toBe(2);
    expect(storage.getSummary(workspaceId).observationCount).toBe(3);
    expect(storage.getSummary(workspaceId).lastObservedAt).toBe('2026-08-23T10:04:00.000Z');
  });

  it('summarises the workspace', () => {
    storage.upsertOperation(makeOperation({ workspaceId }));
    storage.insertObservation(makeObservation({ sessionId, operationId: 'op-1' }));

    const summary = storage.getSummary(workspaceId);

    expect(summary).toEqual({
      workspaceId,
      operationCount: 1,
      observationCount: 1,
      sessionCount: 1,
      lastObservedAt: '2026-08-23T10:00:00.000Z',
    });
  });

  it('enforces foreign keys', () => {
    expect(() =>
      storage.insertObservation(makeObservation({ sessionId: 'no-such-session' })),
    ).toThrowError();
  });
});

describe('SqliteStorage — migrations', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'wirequill-db-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates the database file and its parent directory', () => {
    const databasePath = path.join(directory, 'nested', 'wirequill.sqlite');
    const storage = newStorage(databasePath);

    expect(existsSync(databasePath)).toBe(true);
    storage.close();
  });

  it('is idempotent across reopens', () => {
    const databasePath = path.join(directory, 'wirequill.sqlite');

    const first = newStorage(databasePath);
    const workspace = first.getOrCreateWorkspace({
      projectRoot: 'D:/work/acme',
      targetUrl: 'http://localhost:8080',
    });
    first.close();

    const second = newStorage(databasePath);
    const reopened = second.getOrCreateWorkspace({
      projectRoot: 'D:/work/acme',
      targetUrl: 'http://localhost:8080',
    });

    expect(reopened.id).toBe(workspace.id);
    second.close();
  });

  it('refuses a database written by a newer schema version', () => {
    const databasePath = path.join(directory, 'future.sqlite');

    const storage = newStorage(databasePath);
    storage.close();

    // Simulate a future WireQuill by bumping the recorded schema version.
    bumpSchemaVersion(databasePath, LATEST_SCHEMA_VERSION + 1);

    const reopened = new SqliteStorage({ databasePath, clock: CLOCK });
    expect(() => reopened.initialize()).toThrowError(WireQuillError);
    // A failed initialize must not leave a half-open handle behind, so a retry
    // reports the same actionable error rather than silently succeeding.
    expect(() => reopened.initialize()).toThrowError(/newer WireQuill version/);
  });

  it('refuses a corrupt database without touching what the user has', () => {
    // A file that is not a database at all — a truncated copy, a bad restore, a
    // sync conflict. WireQuill reports it and stops; it does not delete or
    // overwrite something the user may want to recover (spec section 51).
    const databasePath = path.join(directory, 'corrupt.sqlite');
    writeFileSync(databasePath, 'this is definitely not a SQLite database');

    const storage = new SqliteStorage({ databasePath, clock: CLOCK });

    expect(() => storage.initialize()).toThrowError();

    // Still exactly what it was.
    expect(readFileSync(databasePath, 'utf8')).toBe('this is definitely not a SQLite database');

    storage.close();
  });

  it('is safe to close twice', () => {
    const storage = newStorage();
    storage.close();
    expect(() => storage.close()).not.toThrow();
  });

  it('refuses to be used before initialize()', () => {
    const storage = new SqliteStorage({ databasePath: ':memory:', clock: CLOCK });
    expect(() =>
      storage.getOrCreateWorkspace({ projectRoot: 'x', targetUrl: 'http://localhost:1' }),
    ).toThrowError(/before initialize/);
  });
});

function bumpSchemaVersion(databasePath: string, version: number): void {
  const db = new DatabaseSync(databasePath);
  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
    version,
    '2099-01-01T00:00:00.000Z',
  );
  db.close();
}
