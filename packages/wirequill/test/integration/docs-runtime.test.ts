import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Output } from '../../src/cli/output.js';
import { loadConfig } from '../../src/config/load-config.js';
import { DOCS_HOST } from '../../src/docs-server/docs-server.js';
import { WireQuillRuntime } from '../../src/runtime/wirequill-runtime.js';
import { startFixtureBackend, type FixtureBackend } from '../fixtures/backend.js';
import { getDocs, getJson, startDocsHarness } from '../helpers/docs-harness.js';
import { getFreePort, occupyPort } from '../helpers/ports.js';

/**
 * Startup, shutdown and the promises that only hold across a whole run
 * (spec sections 16 to 25, 122, 146 to 149, 155).
 */

let projectDir: string;
let backend: FixtureBackend;

beforeEach(async () => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'wirequill-docsrt-'));
  mkdirSync(path.join(projectDir, '.git'));
  backend = await startFixtureBackend({ tls: false });
});

afterEach(async () => {
  await backend.close();
  rmSync(projectDir, { recursive: true, force: true });
});

interface RuntimeSetup {
  runtime: WireQuillRuntime;
  stdout: string[];
  stderr: string[];
  opened: string[];
  docsPort: number;
  proxyPort: number;
}

async function makeRuntime(
  overrides: {
    host?: string;
    docsPort?: number;
    proxyPort?: number;
    open?: boolean;
    isTty?: boolean;
    env?: NodeJS.ProcessEnv;
    failBrowser?: boolean;
  } = {},
): Promise<RuntimeSetup> {
  const proxyPort = overrides.proxyPort ?? (await getFreePort());
  const docsPort = overrides.docsPort ?? (await getFreePort());

  const config = loadConfig(
    {
      target: backend.origin,
      port: String(proxyPort),
      docsPort: String(docsPort),
      ...(overrides.host === undefined ? {} : { host: overrides.host }),
      open: overrides.open ?? false,
    },
    { cwd: projectDir, env: {} },
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  const opened: string[] = [];

  const runtime = new WireQuillRuntime({
    config,
    output: new Output({
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }),
    isTty: overrides.isTty ?? false,
    env: overrides.env ?? {},
    openBrowser: (url) => {
      opened.push(url);
      return overrides.failBrowser === true
        ? Promise.reject(new Error('no default browser'))
        : Promise.resolve();
    },
  });

  return { runtime, stdout, stderr, opened, docsPort, proxyPort };
}

describe('documentation server binding', () => {
  it('binds the loopback interface even when the proxy is exposed to the network', async () => {
    const { runtime, docsPort, proxyPort } = await makeRuntime({ host: '0.0.0.0' });

    await runtime.start();

    try {
      expect(runtime.docsUrl).toBe(`http://127.0.0.1:${String(docsPort)}`);
      expect(await canConnect(DOCS_HOST, docsPort)).toBe(true);

      const lan = firstNonLoopbackAddress();

      // Connecting to `0.0.0.0` would prove nothing: Windows routes it to the
      // loopback interface. The question is whether a machine on the network
      // could reach the documentation, so the test asks from the address such a
      // machine would use.
      if (lan !== null) {
        // `--host` opens the proxy, and only the proxy. The documentation is a
        // view of every request the proxy has seen, including the ones carrying
        // credentials, and it stays on this machine
        // (spec sections 16 and 147).
        expect(await canConnect(lan, proxyPort)).toBe(true);
        expect(await canConnect(lan, docsPort)).toBe(false);
      }
    } finally {
      await runtime.stop();
    }
  });

  it('prints the proxy, target and docs addresses on startup', async () => {
    const { runtime, stdout, docsPort, proxyPort } = await makeRuntime();

    await runtime.start();

    try {
      const banner = stdout.join('\n');

      expect(banner).toContain(`Proxy`);
      expect(banner).toContain(`http://127.0.0.1:${String(proxyPort)}`);
      expect(banner).toContain('Target');
      expect(banner).toContain(backend.origin);
      expect(banner).toContain('Docs');
      expect(banner).toContain(`http://127.0.0.1:${String(docsPort)}`);
      expect(banner).toContain('Watching API traffic...');
      expect(banner).not.toContain('not listening yet');
    } finally {
      await runtime.stop();
    }
  });

  it('refuses to start when the docs port is taken, and leaves nothing running', async () => {
    const docsPort = await getFreePort();
    const occupied = await occupyPort(docsPort);
    const { runtime, proxyPort } = await makeRuntime({ docsPort });

    try {
      await expect(runtime.start()).rejects.toThrowError(
        `Docs port ${String(docsPort)} is already in use.`,
      );

      // Partial startup would leave a proxy running that documents nothing
      // (spec sections 19 and 148).
      expect(await canConnect(DOCS_HOST, proxyPort)).toBe(false);
      expect(runtime.state).toBe('stopped');
    } finally {
      await occupied.close();
    }
  });

  it('closes the docs server again when the proxy cannot bind', async () => {
    const proxyPort = await getFreePort();
    const occupied = await occupyPort(proxyPort);
    const { runtime, docsPort } = await makeRuntime({ proxyPort });

    try {
      await expect(runtime.start()).rejects.toThrowError(/already in use/);
      expect(runtime.state).toBe('stopped');

      // The port has to be free again, or the next attempt fails for a reason
      // that has nothing to do with the actual problem (spec section 149).
      const reclaimed = await occupyPort(docsPort);
      await reclaimed.close();
    } finally {
      await occupied.close();
    }
  });
});

describe('browser auto-open', () => {
  it('opens the docs once, for a developer at a terminal', async () => {
    const { runtime, opened, docsPort } = await makeRuntime({ open: true, isTty: true });

    await runtime.start();

    try {
      expect(opened).toEqual([`http://127.0.0.1:${String(docsPort)}`]);
    } finally {
      await runtime.stop();
    }
  });

  it('opens nothing when --no-open was given', async () => {
    const { runtime, opened } = await makeRuntime({ open: false, isTty: true });

    await runtime.start();

    try {
      expect(opened).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });

  it('opens nothing without a terminal', async () => {
    const { runtime, opened } = await makeRuntime({ open: true, isTty: false });

    await runtime.start();

    try {
      expect(opened).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });

  it('opens nothing in continuous integration', async () => {
    const { runtime, opened } = await makeRuntime({
      open: true,
      isTty: true,
      env: { CI: 'true' },
    });

    await runtime.start();

    try {
      expect(opened).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });

  it('keeps running when the browser cannot be opened', async () => {
    const { runtime, stderr, stdout, docsPort } = await makeRuntime({
      open: true,
      isTty: true,
      failBrowser: true,
    });

    await runtime.start();

    try {
      expect(runtime.state).toBe('running');
      expect(stderr.join('\n')).toContain('Could not open the browser automatically.');
      expect(stdout.join('\n')).toContain(`Docs: http://127.0.0.1:${String(docsPort)}`);
    } finally {
      await runtime.stop();
    }
  });
});

describe('historical documentation', () => {
  it('serves a complete document after a restart, with no new traffic', async () => {
    const shared = await startFixtureBackend({ tls: false });
    // The project directory is supplied, so neither harness removes it: the
    // whole point is that the second run finds what the first one wrote.
    const first = await startDocsHarness({ backend: shared, projectDir });

    await first.call('/schema?id=1');
    await first.call('/users/1');
    await first.call('/json', { method: 'POST', body: { total: 12 } });
    await first.waitForOperations(3);

    const before = await getJson<Record<string, unknown>>(first.docsOrigin, '/openapi.json');
    await first.close();

    // Same project directory, same target, therefore the same workspace — a
    // second run of `wirequill` in the same repository (spec section 122).
    const second = await startDocsHarness({ backend: shared, projectDir });

    try {
      const summary = await getJson<{ operations: number }>(
        second.docsOrigin,
        '/__wirequill/api/summary',
      );
      const after = await getJson<Record<string, unknown>>(second.docsOrigin, '/openapi.json');

      expect(summary.operations).toBe(3);
      // Byte for byte: the document is derived from persisted evidence, and no
      // part of it depends on the session that observed it.
      expect(after).toEqual(before);
    } finally {
      await second.close();
      await shared.close();
    }
  });

  it('reports an empty workspace as empty', async () => {
    const harness = await startDocsHarness();

    try {
      const summary = await getJson<{ operations: number; observations: number }>(
        harness.docsOrigin,
        '/__wirequill/api/summary',
      );
      const document = await getDocs(harness.docsOrigin, '/openapi.json');

      expect(summary.operations).toBe(0);
      expect(summary.observations).toBe(0);
      expect(JSON.parse(document.body)).toMatchObject({ paths: {} });
    } finally {
      await harness.close();
    }
  });
});

/**
 * An address this machine owns that is not the loopback interface, or `null` on
 * a host that has none (a disconnected laptop, some CI containers).
 */
function firstNonLoopbackAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }

  return null;
}

/** Can something actually connect to this address? */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(1_000);
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  });
}
