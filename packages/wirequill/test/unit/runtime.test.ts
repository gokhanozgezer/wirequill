import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load-config.js';
import { Output } from '../../src/cli/output.js';
import { WireQuillRuntime } from '../../src/runtime/wirequill-runtime.js';
import { SqliteStorage } from '../../src/storage/sqlite-storage.js';
import { fixedClock } from '../../src/utils/clock.js';
import type { WireQuillConfig } from '../../src/config/types.js';
import { createStubProxy } from '../helpers/stub-proxy.js';
import { getFreePort } from '../helpers/ports.js';
import { ProxyEventBus } from '../../src/proxy/proxy-events.js';
import { WireQuillError } from '../../src/utils/errors.js';

let projectDir: string;
/**
 * The runtime binds a real documentation server, so every test needs a port of
 * its own. `open: false` keeps a browser out of the test run for the same
 * reason: these are unit tests, not a demo.
 */
let docsPort: number;

beforeEach(async () => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'wirequill-runtime-'));
  mkdirSync(path.join(projectDir, '.git'));
  docsPort = await getFreePort();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const CLOCK = fixedClock('2026-08-23T10:00:00.000Z');

function makeConfig(target = 'http://localhost:8080'): WireQuillConfig {
  return loadConfig(
    { target, docsPort: String(docsPort), open: false },
    { cwd: projectDir, env: {} },
  );
}

interface Harness {
  runtime: WireQuillRuntime;
  storage: SqliteStorage;
  stdout: string[];
  stderr: string[];
}

function makeRuntime(config: WireQuillConfig = makeConfig()): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const output = new Output({
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  const storage = new SqliteStorage({ databasePath: ':memory:', clock: CLOCK });

  const runtime = new WireQuillRuntime({
    config,
    output,
    storage,
    clock: CLOCK,
    proxy: createStubProxy(),
  });

  return { runtime, storage, stdout, stderr };
}

describe('WireQuillRuntime', () => {
  it('moves through idle, running and stopped', async () => {
    const { runtime } = makeRuntime();

    expect(runtime.state).toBe('idle');
    await runtime.start();
    expect(runtime.state).toBe('running');
    await runtime.stop();
    expect(runtime.state).toBe('stopped');
  });

  it('creates a workspace and an open session on start', async () => {
    const { runtime } = makeRuntime();
    await runtime.start();

    expect(runtime.workspace.targetUrl).toBe('http://localhost:8080');
    expect(runtime.session.endedAt).toBeNull();
    expect(runtime.session.proxyPort).toBe(3000);
    expect(runtime.session.docsPort).toBe(docsPort);

    await runtime.stop();
  });

  it('persists the session end time and closes the database cleanly', async () => {
    // A file-backed database, because the assertion is that the end time
    // survives shutdown — an in-memory database dies with the connection.
    const databasePath = path.join(projectDir, '.wirequill', 'runtime.sqlite');
    const config = loadConfig(
      {
        target: 'http://localhost:8080',
        db: databasePath,
        docsPort: String(docsPort),
        open: false,
      },
      {
        cwd: projectDir,
        env: {},
      },
    );

    const output = new Output({ stdout: () => undefined, stderr: () => undefined });
    const runtime = new WireQuillRuntime({
      config,
      output,
      clock: CLOCK,
      proxy: createStubProxy(),
    });

    await runtime.start();
    const sessionId = runtime.session.id;
    await runtime.stop();

    const reopened = new SqliteStorage({ databasePath, clock: CLOCK });
    reopened.initialize();

    expect(reopened.getSession(sessionId)?.endedAt).toBe('2026-08-23T10:00:00.000Z');

    reopened.close();
  });

  it('reuses the workspace across runs against the same target', async () => {
    // Two complete runs, one after the other, against the same file-backed
    // database — which is what "across runs" actually means. Overlapping them
    // around one shared connection would also mean two documentation servers
    // trying to bind the same port.
    const databasePath = path.join(projectDir, '.wirequill', 'reuse.sqlite');
    const config = loadConfig(
      {
        target: 'http://localhost:8080',
        db: databasePath,
        docsPort: String(docsPort),
        open: false,
      },
      { cwd: projectDir, env: {} },
    );
    const output = new Output({ stdout: () => undefined, stderr: () => undefined });

    const first = new WireQuillRuntime({ config, output, clock: CLOCK, proxy: createStubProxy() });
    await first.start();
    const workspaceId = first.workspace.id;
    const firstSessionId = first.session.id;
    await first.stop();

    const second = new WireQuillRuntime({ config, output, clock: CLOCK, proxy: createStubProxy() });
    await second.start();

    expect(second.workspace.id).toBe(workspaceId);
    expect(second.session.id).not.toBe(firstSessionId);

    await second.stop();
  });

  it('refuses to start twice', async () => {
    const { runtime } = makeRuntime();
    await runtime.start();

    await expect(runtime.start()).rejects.toThrowError(/already been started/);

    await runtime.stop();
  });

  it('tolerates stop being called twice', async () => {
    const { runtime } = makeRuntime();
    await runtime.start();

    await runtime.stop();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });

  it('refuses to expose a session before start', () => {
    const { runtime } = makeRuntime();
    expect(() => runtime.session).toThrowError(/has not been started/);
    expect(() => runtime.workspace).toThrowError(/has not been started/);
  });

  it('keeps the storage path out of the default startup output', async () => {
    // Three addresses and nothing else. Where the database lives is a
    // diagnostic, and a developer starting WireQuill for the tenth time does
    // not need it (spec sections 10 and 11).
    const { runtime, stdout } = makeRuntime();
    await runtime.start();

    const banner = stdout.join('\n');

    expect(banner).toContain('Proxy');
    expect(banner).toContain('Target');
    expect(banner).toContain('Docs');
    expect(banner).not.toContain('Storage');
    expect(banner).not.toContain(path.join('.wirequill', 'wirequill.sqlite'));

    await runtime.stop();
  });

  it('prints the storage path under --verbose', async () => {
    const config = loadConfig(
      {
        target: 'http://localhost:8080',
        docsPort: String(docsPort),
        open: false,
        verbose: true,
      },
      { cwd: projectDir, env: {} },
    );
    const { runtime, stdout } = makeRuntime(config);

    await runtime.start();

    expect(stdout.join('\n')).toContain(path.join('.wirequill', 'wirequill.sqlite'));

    await runtime.stop();
  });

  it('starts and stops the proxy exactly once', async () => {
    const proxy = createStubProxy();
    const storage = new SqliteStorage({ databasePath: ':memory:', clock: CLOCK });
    const output = new Output({ stdout: () => undefined, stderr: () => undefined });
    const runtime = new WireQuillRuntime({
      config: makeConfig(),
      output,
      storage,
      clock: CLOCK,
      proxy,
    });

    await runtime.start();
    expect(proxy.startCalls).toBe(1);
    expect(proxy.stopCalls).toBe(0);

    await runtime.stop();
    expect(proxy.stopCalls).toBe(1);

    // A second stop must not stop the proxy again.
    await runtime.stop();
    expect(proxy.stopCalls).toBe(1);
  });

  it('reports the address the proxy actually bound', async () => {
    const proxy = createStubProxy({ host: '127.0.0.1', port: 4321 });
    const storage = new SqliteStorage({ databasePath: ':memory:', clock: CLOCK });
    const stdout: string[] = [];
    const output = new Output({
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });
    const runtime = new WireQuillRuntime({
      config: makeConfig(),
      output,
      storage,
      clock: CLOCK,
      proxy,
    });

    await runtime.start();

    expect(stdout.join('\n')).toContain('http://127.0.0.1:4321');
    expect(stdout.join('\n')).toContain('Watching API traffic...');

    await runtime.stop();
  });

  it('closes storage and ends the session when the proxy cannot bind', async () => {
    const databasePath = path.join(projectDir, '.wirequill', 'failed-start.sqlite');
    const config = loadConfig(
      {
        target: 'http://localhost:8080',
        db: databasePath,
        docsPort: String(docsPort),
        open: false,
      },
      { cwd: projectDir, env: {} },
    );
    const output = new Output({ stdout: () => undefined, stderr: () => undefined });
    const proxy = createStubProxy(undefined, {
      failOnStart: new WireQuillError('PORT_IN_USE', 'Port 3000 is already in use.'),
    });

    const runtime = new WireQuillRuntime({ config, output, clock: CLOCK, proxy });

    await expect(runtime.start()).rejects.toThrowError(/already in use/);
    expect(runtime.state).toBe('stopped');

    // The database must be closed and the session closed out, not left dangling.
    const reopened = new SqliteStorage({ databasePath, clock: CLOCK });
    reopened.initialize();
    const workspace = reopened.getOrCreateWorkspace({
      projectRoot: projectDir,
      targetUrl: 'http://localhost:8080',
    });
    const summary = reopened.getSummary(workspace.id);

    expect(summary.sessionCount).toBe(1);
    reopened.close();
  });

  it('reports an unreachable target immediately', async () => {
    const stdout: string[] = [];
    const output = new Output({
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });
    const events = new ProxyEventBus();
    const runtime = new WireQuillRuntime({
      config: makeConfig(),
      output,
      storage: new SqliteStorage({ databasePath: ':memory:', clock: CLOCK }),
      clock: CLOCK,
      proxy: createStubProxy(),
      events,
    });

    await runtime.start();
    stdout.length = 0;

    events.emit('upstreamFailure', {
      method: 'POST',
      path: '/checkout',
      code: 'ECONNREFUSED',
      durationMs: 3,
    });

    const printed = stdout.join('\n');
    expect(printed).toContain('POST');
    expect(printed).toContain('/checkout');
    expect(printed).toContain('Target connection failed: ECONNREFUSED');

    await runtime.stop();
  });

  it('does not print a traffic line straight from the proxy event', async () => {
    // The proxy knows a request finished but not which operation it was, and
    // its path may still carry a credential. The line is written once the
    // pipeline has resolved the operation instead.
    const stdout: string[] = [];
    const output = new Output({
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });
    const events = new ProxyEventBus();
    const runtime = new WireQuillRuntime({
      config: makeConfig(),
      output,
      storage: new SqliteStorage({ databasePath: ':memory:', clock: CLOCK }),
      clock: CLOCK,
      proxy: createStubProxy(),
      events,
    });

    await runtime.start();
    stdout.length = 0;

    events.emit('requestCompleted', {
      method: 'GET',
      path: '/reset',
      statusCode: 200,
      durationMs: 12.4,
    });

    expect(stdout).toHaveLength(0);

    await runtime.stop();
  });

  it('stops printing traffic after shutdown', async () => {
    const stdout: string[] = [];
    const output = new Output({
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });
    const events = new ProxyEventBus();
    const runtime = new WireQuillRuntime({
      config: makeConfig(),
      output,
      storage: new SqliteStorage({ databasePath: ':memory:', clock: CLOCK }),
      clock: CLOCK,
      proxy: createStubProxy(),
      events,
    });

    await runtime.start();
    await runtime.stop();
    stdout.length = 0;

    events.emit('requestCompleted', {
      method: 'GET',
      path: '/late',
      statusCode: 200,
      durationMs: 1,
    });

    expect(stdout).toHaveLength(0);
  });

  it('warns once when TLS verification is disabled', async () => {
    const config = loadConfig(
      { target: 'https://localhost:8443', insecure: true, docsPort: String(docsPort), open: false },
      { cwd: projectDir, env: {} },
    );
    const { runtime, stderr } = makeRuntime(config);

    await runtime.start();

    expect(stderr.join('\n')).toContain('TLS certificate verification is disabled for the target.');

    await runtime.stop();
  });
});
