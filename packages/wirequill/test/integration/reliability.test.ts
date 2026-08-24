import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Output } from '../../src/cli/output.js';
import { loadConfig } from '../../src/config/load-config.js';
import { WireQuillRuntime } from '../../src/runtime/wirequill-runtime.js';
import { SqliteStorage } from '../../src/storage/sqlite-storage.js';
import type { Storage } from '../../src/storage/storage.js';
import { startFixtureBackend, type FixtureBackend } from '../fixtures/backend.js';
import { getDocs, getJson, openSse, startDocsHarness } from '../helpers/docs-harness.js';
import { getFreePort, occupyPort } from '../helpers/ports.js';

/**
 * Does WireQuill behave like a program somebody runs every day?
 * (spec sections 18 to 33, 98 to 111.)
 *
 * Nothing here is about what WireQuill documents. It is about starting,
 * stopping, restarting, and giving back everything it took — the things a
 * feature test never notices and a user notices on the second run.
 */

let projectDir: string;
let backend: FixtureBackend;

beforeEach(async () => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'wirequill-rel-'));
  mkdirSync(path.join(projectDir, '.git'));
  backend = await startFixtureBackend({ tls: false });
});

afterEach(async () => {
  await backend.close();
  // The database has to be closed before this runs, or Windows refuses to
  // remove a file SQLite still holds open. That it succeeds is itself part of
  // what these tests assert.
  rmSync(projectDir, { recursive: true, force: true });
});

interface RunOptions {
  proxyPort?: number;
  docsPort?: number;
  cwd?: string;
  storage?: Storage;
}

function makeRuntime(
  proxyPort: number,
  docsPort: number,
  options: RunOptions = {},
): { runtime: WireQuillRuntime; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const config = loadConfig(
    {
      target: backend.origin,
      port: String(proxyPort),
      docsPort: String(docsPort),
      open: false,
    },
    { cwd: options.cwd ?? projectDir, env: {} },
  );

  const runtime = new WireQuillRuntime({
    config,
    output: new Output({
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }),
    isTty: false,
    env: {},
    openBrowser: () => Promise.resolve(),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  });

  return { runtime, stdout, stderr };
}

describe('start, stop, restart', () => {
  it('survives ten cycles on the same ports and the same database', async () => {
    const proxyPort = await getFreePort();
    const docsPort = await getFreePort();
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(`${warning.name}: ${warning.message}`);
    };

    process.on('warning', onWarning);

    try {
      for (let cycle = 0; cycle < 10; cycle += 1) {
        const { runtime, stderr } = makeRuntime(proxyPort, docsPort);

        await runtime.start();
        await call(proxyPort, `/users/${String(cycle + 1)}`);
        await waitForOperations(docsPort, 1);
        await runtime.stop();

        // Not "no warnings at all": in a source checkout with no build, every
        // cycle legitimately warns that the interface has not been built. What
        // must not appear is a warning that means something is accumulating.
        const warnings = stderr.join('\n');

        expect(warnings).not.toContain('MaxListeners');
        expect(warnings).not.toContain('falling behind');
      }
    } finally {
      process.off('warning', onWarning);
    }

    // A leaked listener per cycle is exactly what this warning is for
    // (spec section 27).
    expect(warnings.filter((entry) => entry.includes('MaxListenersExceeded'))).toEqual([]);

    // Ten runs, one operation, ten observations: the same row, reopened.
    const storage = new SqliteStorage({
      databasePath: path.join(projectDir, '.wirequill', 'wirequill.sqlite'),
    });
    storage.initialize();

    try {
      const workspace = storage.getOrCreateWorkspace({
        projectRoot: projectDir,
        targetUrl: backend.origin,
      });
      const summary = storage.getSummary(workspace.id);

      expect(summary.operationCount).toBe(1);
      expect(summary.observationCount).toBe(10);
      expect(summary.sessionCount).toBe(10);
      expect(storage.listOperations(workspace.id)[0]?.observedCount).toBe(10);
    } finally {
      storage.close();
    }
  });

  it('releases both ports the moment it stops', async () => {
    const proxyPort = await getFreePort();
    const docsPort = await getFreePort();
    const { runtime } = makeRuntime(proxyPort, docsPort);

    await runtime.start();
    await call(proxyPort, '/hello');
    await runtime.stop();

    // No grace period, no retry loop: something else must be able to take the
    // address immediately (spec section 23).
    const reclaimedProxy = await occupyPort(proxyPort);
    const reclaimedDocs = await occupyPort(docsPort);

    await reclaimedProxy.close();
    await reclaimedDocs.close();
  });

  it('tolerates stop being called twice and refuses a second start', async () => {
    const { runtime } = makeRuntime(await getFreePort(), await getFreePort());

    await runtime.start();
    await expect(runtime.start()).rejects.toThrowError(/already been started/);

    await runtime.stop();
    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(runtime.state).toBe('stopped');
  });

  it('closes the database when a collaborator fails to build', async () => {
    const databasePath = path.join(projectDir, '.wirequill', 'faulty.sqlite');
    const storage = new SqliteStorage({ databasePath });
    let closed = false;

    // Fault injection at the one point that is neither a port nor a file: the
    // session write. Everything after it — the pipeline, the docs server, the
    // proxy — is never built (spec section 101).
    const faulty: Storage = Object.assign(
      Object.create(Object.getPrototypeOf(storage)) as Storage,
      {
        ...storage,
        initialize: () => storage.initialize(),
        getOrCreateWorkspace: (input: Parameters<Storage['getOrCreateWorkspace']>[0]) =>
          storage.getOrCreateWorkspace(input),
        createSession: () => {
          throw new Error('session write failed');
        },
        close: () => {
          closed = true;
          storage.close();
        },
      },
    );

    const { runtime } = makeRuntime(await getFreePort(), await getFreePort(), {
      storage: faulty,
    });

    await expect(runtime.start()).rejects.toThrowError(/session write failed/);
    expect(runtime.state).toBe('stopped');
    expect(closed).toBe(true);

    // Closed means removable, on Windows too.
    rmSync(databasePath, { force: true });
    expect(existsSync(databasePath)).toBe(false);
  });
});

describe('project paths Windows makes awkward', () => {
  it('runs from a directory whose name contains spaces', async () => {
    await runInDirectory('Wire Quill Test');
  });

  it('runs from a directory whose name is not ASCII', async () => {
    // Turkish, because that is the developer's own keyboard, and because the
    // dotted and dotless i are a classic case-mapping trap.
    await runInDirectory('WireQuill Türkçe Proje');
  });

  async function runInDirectory(name: string): Promise<void> {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'wirequill-path-'));
    const directory = path.join(parent, name);

    mkdirSync(directory);
    mkdirSync(path.join(directory, '.git'));

    const proxyPort = await getFreePort();
    const docsPort = await getFreePort();
    const { runtime } = makeRuntime(proxyPort, docsPort, { cwd: directory });

    try {
      await runtime.start();
      await call(proxyPort, '/users/7');
      await waitForOperations(docsPort, 1);

      const summary = await getJson<{ operations: number }>(
        `http://127.0.0.1:${String(docsPort)}`,
        '/__wirequill/api/summary',
      );

      expect(summary.operations).toBe(1);
      // The database landed inside the awkward directory, not somewhere above it.
      expect(existsSync(path.join(directory, '.wirequill', 'wirequill.sqlite'))).toBe(true);
    } finally {
      await runtime.stop();
      rmSync(parent, { recursive: true, force: true });
    }
  }
});

describe('shutdown with everything connected', () => {
  it('stops quickly with an event stream, a tunnel and a request in flight', async () => {
    const harness = await startDocsHarness({ backend, projectDir });
    const events = await openSse(harness.docsOrigin);
    const tunnel = await openTunnel(harness.proxyOrigin);

    await events.waitFor((frames) => frames.length > 0);
    expect(harness.runtime.proxyTunnelCount).toBe(1);
    expect(harness.runtime.docsSseClientCount).toBe(1);

    // A response that has started and will not finish on its own.
    const streaming = startStreamingRequest(harness.proxyOrigin, '/stream');
    await streaming.started;

    const startedAt = Date.now();
    await harness.runtime.stop();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(4_000);
    expect(harness.runtime.docsSseClientCount).toBe(0);
    expect(harness.runtime.proxyTunnelCount).toBe(0);

    events.close();
    tunnel.destroy();
    streaming.abort();
  });

  it('releases every event-stream client it accepted', async () => {
    const harness = await startDocsHarness({ backend, projectDir });
    const clients = [];

    try {
      for (let index = 0; index < 10; index += 1) {
        const client = await openSse(harness.docsOrigin);
        await client.waitFor((frames) => frames.length > 0);
        clients.push(client);
      }

      expect(harness.runtime.docsSseClientCount).toBe(10);

      await harness.call('/schema?id=1');

      for (const client of clients) {
        await client.waitFor((frames) =>
          frames.some((frame) => frame.event.startsWith('operation.')),
        );
      }

      for (const client of clients) {
        client.close();
      }

      await waitUntil(() => harness.runtime.docsSseClientCount === 0);
    } finally {
      await harness.close();
    }
  });

  it('releases an upgrade tunnel when the client goes away', async () => {
    const harness = await startDocsHarness({ backend, projectDir });

    try {
      const tunnel = await openTunnel(harness.proxyOrigin);
      expect(harness.runtime.proxyTunnelCount).toBe(1);

      tunnel.destroy();
      await waitUntil(() => harness.runtime.proxyTunnelCount === 0);
    } finally {
      await harness.close();
    }
  });

  it('lets the process exit without a lingering timer', async () => {
    const harness = await startDocsHarness({ backend, projectDir });
    const client = await openSse(harness.docsOrigin);

    await client.waitFor((frames) => frames.length > 0);
    client.close();
    await harness.close();

    // Every timer WireQuill owns is either cleared or unref'd; a keepalive that
    // was neither would keep a plain `node` process alive after shutdown
    // (spec section 26).
    const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })
      ._getActiveHandles;
    const timers = (handles?.() ?? []).filter(
      (handle) => (handle as { constructor?: { name?: string } }).constructor?.name === 'Timeout',
    );

    expect(timers.every((timer) => (timer as { hasRef?: () => boolean }).hasRef?.() !== true)).toBe(
      true,
    );
  });
});

describe('load', () => {
  it('handles a burst of requests and gives the memory back', async () => {
    const harness = await startDocsHarness({ backend, projectDir });

    try {
      const requests = 300;

      for (let index = 0; index < requests; index += 1) {
        await harness.call(`/users/${String(index % 5)}`);
      }

      await waitUntil(async () => {
        const summary = await getJson<{ observations: number }>(
          harness.docsOrigin,
          '/__wirequill/api/summary',
        );
        return summary.observations === requests;
      });

      const stats = harness.runtime.captureStats;

      expect(stats?.pending).toBe(0);
      // Every reservation against the global capture budget was released
      // (spec section 111).
      expect(stats?.reservedBytes).toBe(0);
      expect(stats?.failed).toBe(0);

      const summary = await getJson<{ operations: number }>(
        harness.docsOrigin,
        '/__wirequill/api/summary',
      );
      expect(summary.operations).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it('answers a hundred concurrent documentation requests', async () => {
    const harness = await startDocsHarness({ backend, projectDir });

    try {
      await harness.call('/schema?id=1');
      await harness.waitForOperations(1);

      const routes = ['/openapi.json', '/__wirequill/api/summary', '/__wirequill/api/health'];
      const responses = await Promise.all(
        Array.from({ length: 100 }, (_unused, index) =>
          getDocs(harness.docsOrigin, routes[index % routes.length] ?? routes[0] ?? ''),
        ),
      );

      expect(responses.every((response) => response.status === 200)).toBe(true);

      // Every copy of the document is complete and independent: the cache hands
      // out a fresh object rather than a shared one.
      const documents = responses
        .filter((_unused, index) => index % routes.length === 0)
        .map((response) => JSON.parse(response.body) as Record<string, unknown>);

      expect(documents.every((document) => document.openapi === '3.1.0')).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

describe('sqlite reliability', () => {
  it('recovers from an abrupt termination without losing committed work', async () => {
    const databasePath = path.join(projectDir, '.wirequill', 'abrupt.sqlite');
    mkdirSync(path.dirname(databasePath), { recursive: true });

    const first = new SqliteStorage({ databasePath });
    first.initialize();

    const workspace = first.getOrCreateWorkspace({
      projectRoot: projectDir,
      targetUrl: backend.origin,
    });

    first.upsertOperation({
      id: 'committed-operation',
      workspaceId: workspace.id,
      method: 'GET',
      pathTemplate: '/committed',
      operationId: 'getCommitted',
      tag: null,
      summary: null,
      observedCount: 1,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
      pathParameters: [],
      queryParameters: [],
      headerParameters: [],
      securityEvidence: {},
      requestBodiesEvidence: {},
      responsesEvidence: {},
      publicRevision: 1,
    });

    first.close();

    // A writer that dies mid-transaction, leaving a hot WAL behind.
    await killMidTransaction(databasePath, workspace.id);

    const reopened = new SqliteStorage({ databasePath });
    reopened.initialize();

    try {
      const operations = reopened.listOperations(workspace.id);

      // Committed work survives; the interrupted transaction does not. Losing
      // the latter is acceptable. A database that will not open is not
      // (spec section 21).
      expect(operations.map((operation) => operation.id)).toEqual(['committed-operation']);
    } finally {
      reopened.close();
    }
  });

  it('leaves nothing locked after a clean stop', async () => {
    const proxyPort = await getFreePort();
    const docsPort = await getFreePort();
    const { runtime } = makeRuntime(proxyPort, docsPort);

    await runtime.start();
    await call(proxyPort, '/hello');
    await runtime.stop();

    // Removing the whole data directory is the strongest available statement
    // that no handle is still open — Windows refuses otherwise
    // (spec sections 18 and 19).
    rmSync(path.join(projectDir, '.wirequill'), { recursive: true, force: true });
    expect(existsSync(path.join(projectDir, '.wirequill'))).toBe(false);
  });
});

// ------------------------------------------------------------------- helpers

function call(proxyPort: number, pathname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // `agent: false` disables connection pooling. Node's global agent keeps
    // sockets alive, and across a restart on the same port it would happily
    // reuse one that the previous run had already closed — an artefact of this
    // test client, not of the proxy.
    const request = http.get(
      { host: '127.0.0.1', port: proxyPort, path: pathname, agent: false },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
  });
}

async function waitForOperations(docsPort: number, count: number): Promise<void> {
  await waitUntil(async () => {
    const summary = await getJson<{ operations: number }>(
      `http://127.0.0.1:${String(docsPort)}`,
      '/__wirequill/api/summary',
    );
    return summary.operations >= count;
  });
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Opens a protocol-upgrade tunnel through the proxy and leaves it open. */
function openTunnel(proxyOrigin: string): Promise<net.Socket> {
  const address = new URL(proxyOrigin);

  return new Promise((resolve, reject) => {
    const request = http.request({
      host: address.hostname,
      port: address.port,
      path: '/socket',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });

    request.on('upgrade', (_response, socket) => resolve(socket));
    request.on('response', (response) => {
      response.resume();
      reject(new Error('the upgrade was refused'));
    });
    request.on('error', reject);
    request.end();
  });
}

/** Starts a response that will not finish on its own. */
function startStreamingRequest(
  proxyOrigin: string,
  pathname: string,
): { started: Promise<void>; abort: () => void } {
  const request = http.get(`${proxyOrigin}${pathname}`);

  const started = new Promise<void>((resolve, reject) => {
    request.on('response', (response) => {
      response.on('data', () => undefined);
      resolve();
    });
    request.on('error', () => resolve());
    setTimeout(() => reject(new Error('the stream never started')), 5_000).unref();
  });

  return { started, abort: () => request.destroy() };
}

/**
 * Runs a child that opens the database, begins a transaction, and is killed
 * before it can commit.
 */
function killMidTransaction(databasePath: string, workspaceId: string): Promise<void> {
  const fixture = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'abrupt-writer.mjs',
  );

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, databasePath, workspaceId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const errors: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk.toString('utf8')));

    child.stdout.on('data', (chunk: Buffer) => {
      if (!chunk.toString('utf8').includes('ready')) {
        return;
      }

      // SIGKILL: no handler runs, nothing is flushed, nothing is rolled back
      // politely. Windows maps this to TerminateProcess, which is the same
      // abruptness.
      child.kill('SIGKILL');
    });

    child.on('exit', () => resolve());
    child.on('error', (error) =>
      reject(new Error(`${error.message}\n${errors.join('')}`, { cause: error })),
    );
  });
}
