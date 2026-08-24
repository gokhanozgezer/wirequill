import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load-config.js';
import { materializeSchema } from '../../src/inference/schema/materialize-schema.js';
import type { OpenApiDocument } from '../../src/openapi/types.js';
import { stableStringify } from '../../src/utils/stable-json.js';
import type { BodyEvidenceByMediaType } from '../../src/processing/body-evidence.js';
import { Output } from '../../src/cli/output.js';
import { WireQuillRuntime } from '../../src/runtime/wirequill-runtime.js';
import { rawRequest } from '../helpers/raw-http.js';
import { getFreePort } from '../helpers/ports.js';
import { startFixtureBackend, type FixtureBackend } from '../fixtures/backend.js';
import { waitFor } from '../helpers/proxy-harness.js';

/**
 * Operations belong to a workspace, not to a run.
 *
 * That is the whole point of the workspace model built in Faz 0: stopping
 * WireQuill and starting it again must continue the same documentation rather
 * than begin a new one.
 */

let projectDir: string;
let backend: FixtureBackend;

beforeEach(async () => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'wirequill-ops-'));
  mkdirSync(path.join(projectDir, '.git'));
  backend = await startFixtureBackend();
});

afterEach(async () => {
  await backend.close();
  rmSync(projectDir, { recursive: true, force: true });
});

interface RunResult {
  stdout: string[];
  databasePath: string;
  /** The document as it stood at the end of the run. */
  document: OpenApiDocument;
  /** The document as it stood at the *start*, before any traffic. */
  documentBeforeTraffic: OpenApiDocument;
}

export interface PostedRequest {
  path: string;
  body: unknown;
}

/** Starts a real runtime, drives some traffic through it, and stops it. */
async function run(
  target: string,
  paths: string[],
  options: { cwd?: string; posts?: PostedRequest[] } = {},
): Promise<RunResult> {
  const cwd = options.cwd ?? projectDir;
  const port = await getFreePort();
  // The runtime binds a documentation server too, so it needs a port of its own
  // — and `open: false` keeps a browser out of the test run.
  const docsPort = await getFreePort();
  const stdout: string[] = [];

  const config = loadConfig(
    { target, port: String(port), docsPort: String(docsPort), open: false },
    { cwd, env: {} },
  );
  const output = new Output({
    stdout: (line) => stdout.push(line),
    stderr: () => undefined,
  });

  let processed = 0;
  // Assigned in the `finally` below, while the runtime still owns the database.
  let document: OpenApiDocument;

  const runtime = new WireQuillRuntime({
    config,
    output,
    isTty: false,
    env: {},
    onSanitized: () => {
      processed += 1;
    },
  });

  await runtime.start();

  // Captured before a single request: proves a document can be produced from
  // persisted evidence alone (spec section 96).
  const documentBeforeTraffic = runtime.openApi.getDocument();

  const posts = options.posts ?? [];

  try {
    for (const pathname of paths) {
      await rawRequest(`http://127.0.0.1:${String(port)}${pathname}`);
    }

    for (const post of posts) {
      await rawRequest(`http://127.0.0.1:${String(port)}${post.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(post.body)),
      });
    }

    await waitFor(() => processed >= paths.length + posts.length, 5_000, 'every observation');
  } finally {
    // Captured before shutdown, while the runtime still owns the database.
    document = runtime.openApi.getDocument();
    await runtime.stop();
  }

  return {
    stdout,
    databasePath: config.storage.databasePath,
    document,
    documentBeforeTraffic,
  };
}

function readOperations(databasePath: string): Record<string, unknown>[] {
  const db = new DatabaseSync(databasePath);
  const rows = db.prepare('SELECT * FROM operations ORDER BY path_template').all() as Record<
    string,
    unknown
  >[];
  db.close();
  return rows;
}

describe('operations survive a restart', () => {
  it('continues counting into the same operation row', async () => {
    const first = await run(backend.origin, ['/users/1', '/users/2']);

    let operations = readOperations(first.databasePath);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.observed_count).toBe(2);
    const originalId = operations[0]?.id;
    const firstSeen = operations[0]?.first_seen_at;

    // Same project root, same target: the same workspace, and so the same
    // operation.
    const second = await run(backend.origin, ['/users/3']);

    operations = readOperations(second.databasePath);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.id).toBe(originalId);
    expect(operations[0]?.observed_count).toBe(3);
    expect(operations[0]?.first_seen_at).toBe(firstSeen);
  });

  it('reports a known operation as already discovered on the second run', async () => {
    await run(backend.origin, ['/users/1']);
    const second = await run(backend.origin, ['/users/2']);

    const trafficLines = second.stdout.filter((line) => line.includes('/users/{userId}'));

    expect(trafficLines).toHaveLength(1);
    expect(trafficLines[0]).not.toContain('+');
  });

  it('links observations from both runs to the same operation', async () => {
    const first = await run(backend.origin, ['/users/1']);
    await run(backend.origin, ['/users/2']);

    const db = new DatabaseSync(first.databasePath);
    const observations = db.prepare('SELECT operation_id FROM observations').all() as {
      operation_id: string | null;
    }[];
    const operations = readOperations(first.databasePath);
    db.close();

    expect(observations).toHaveLength(2);
    expect(new Set(observations.map((row) => row.operation_id)).size).toBe(1);
    expect(observations[0]?.operation_id).toBe(operations[0]?.id);
  });
});

describe('workspaces stay separate', () => {
  it('does not merge operations across targets', async () => {
    const other = await startFixtureBackend();

    try {
      const first = await run(backend.origin, ['/users/1']);
      await run(other.origin, ['/users/2']);

      // Same database file, same path, two different targets: two workspaces,
      // and so two operation rows that happen to share a template.
      const operations = readOperations(first.databasePath);

      expect(operations).toHaveLength(2);
      expect(new Set(operations.map((row) => row.path_template))).toEqual(
        new Set(['/users/{userId}']),
      );
      expect(new Set(operations.map((row) => row.workspace_id)).size).toBe(2);
      for (const operation of operations) {
        expect(operation.observed_count).toBe(1);
      }
    } finally {
      await other.close();
    }
  });

  it('does not merge operations across project roots', async () => {
    const otherProject = mkdtempSync(path.join(os.tmpdir(), 'wirequill-ops-b-'));
    mkdirSync(path.join(otherProject, '.git'));

    try {
      const first = await run(backend.origin, ['/users/1']);
      const second = await run(backend.origin, ['/users/2'], { cwd: otherProject });

      expect(readOperations(first.databasePath)).toHaveLength(1);
      expect(readOperations(second.databasePath)).toHaveLength(1);
      expect(first.databasePath).not.toBe(second.databasePath);
    } finally {
      rmSync(otherProject, { recursive: true, force: true });
    }
  });
});

describe('schema evidence survives a restart', () => {
  it('merges new samples into evidence loaded from the database', async () => {
    const first = await run(backend.origin, [], {
      posts: [
        { path: '/echo', body: { id: 1, name: 'A' } },
        { path: '/echo', body: { id: 2, name: 'B' } },
      ],
    });

    // Stopped and started again: the evidence has to come back off disk.
    const second = await run(backend.origin, [], {
      posts: [{ path: '/echo', body: { id: 3 } }],
    });

    const row = readOperations(second.databasePath)[0];
    const evidence = JSON.parse(
      String(row?.request_bodies_evidence_json),
    ) as BodyEvidenceByMediaType;
    const bucket = evidence['application/json'];

    expect(first.databasePath).toBe(second.databasePath);
    expect(row?.observed_count).toBe(3);
    expect(bucket?.observedCount).toBe(3);
    expect(bucket?.analyzableCount).toBe(3);

    // `name` was present in two of three samples, so it is not required.
    expect(materializeSchema(bucket?.schemaEvidence ?? null)).toEqual({
      type: 'object',
      properties: { id: { type: 'integer' }, name: { type: 'string' } },
      required: ['id'],
    });
  });

  it('does not double-count observations across runs', async () => {
    await run(backend.origin, [], { posts: [{ path: '/echo', body: { id: 1 } }] });
    const second = await run(backend.origin, [], {
      posts: [{ path: '/echo', body: { id: 2 } }],
    });

    const row = readOperations(second.databasePath)[0];
    const evidence = JSON.parse(
      String(row?.request_bodies_evidence_json),
    ) as BodyEvidenceByMediaType;

    expect(row?.observed_count).toBe(2);
    expect(evidence['application/json']?.observedCount).toBe(2);
  });
});

describe('the document survives a restart (RB13)', () => {
  it('is generated from persisted evidence with no traffic at all', async () => {
    const first = await run(backend.origin, ['/users/1'], {
      posts: [{ path: '/echo', body: { id: 1, name: 'A' } }],
    });

    expect(Object.keys(first.document.paths).sort()).toEqual(['/echo', '/users/{userId}']);

    // Second run: the runtime starts, and the document exists before a single
    // request has been made. Historical observations are not needed — and are
    // not even readable, since bodies were never stored.
    const second = await run(backend.origin, []);

    expect(Object.keys(second.documentBeforeTraffic.paths).sort()).toEqual([
      '/echo',
      '/users/{userId}',
    ]);
  });

  it('produces the same bytes as it did before the restart', async () => {
    const first = await run(backend.origin, [], {
      posts: [{ path: '/echo', body: { id: 1, name: 'A' } }],
    });

    const second = await run(backend.origin, []);

    // Nothing changed between the runs, so nothing about the document may
    // either — including the revision, which is derived from evidence rather
    // than from session state.
    expect(stableStringify(second.documentBeforeTraffic)).toBe(stableStringify(first.document));
  });

  it('merges a later run into the same document', async () => {
    await run(backend.origin, [], { posts: [{ path: '/echo', body: { id: 1 } }] });
    const second = await run(backend.origin, [], {
      posts: [{ path: '/echo', body: { id: 2, name: 'Ada' } }],
    });

    const schema =
      second.document.paths['/echo']?.post?.requestBody?.content['application/json']?.schema;

    expect(schema).toEqual({
      type: 'object',
      properties: { id: { type: 'integer' }, name: { type: 'string' } },
    });
  });
});

describe('evidence is stored deterministically', () => {
  it('produces byte-identical JSON for identical evidence', async () => {
    const first = await run(backend.origin, ['/products?page=1&tag=a']);
    const firstJson = readOperations(first.databasePath)[0];

    const otherProject = mkdtempSync(path.join(os.tmpdir(), 'wirequill-ops-c-'));
    mkdirSync(path.join(otherProject, '.git'));

    try {
      const second = await run(backend.origin, ['/products?tag=a&page=1'], {
        cwd: otherProject,
      });
      const secondJson = readOperations(second.databasePath)[0];

      // Different insertion order in the request, identical serialized evidence.
      expect(secondJson?.query_parameters_json).toBe(firstJson?.query_parameters_json);
      expect(secondJson?.security_evidence_json).toBe(firstJson?.security_evidence_json);
      expect(secondJson?.operation_id).toBe(firstJson?.operation_id);
    } finally {
      rmSync(otherProject, { recursive: true, force: true });
    }
  });
});
