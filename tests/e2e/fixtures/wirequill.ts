import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend, type FixtureBackend } from './backend.js';

/**
 * A real WireQuill, as a user would run it (spec sections 43 and 156).
 *
 * The built CLI in a child process, serving the built interface from the
 * package's own assets. Nothing here imports the source, and no dev server is
 * involved: what the end-to-end run exercises is what `npm install wirequill`
 * would give somebody.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cliEntry = path.join(repoRoot, 'packages', 'wirequill', 'dist', 'cli.js');
const uiEntry = path.join(repoRoot, 'packages', 'wirequill', 'assets', 'docs-ui', 'index.html');

export interface WireQuillProcess {
  docsUrl: string;
  proxyUrl: string;
  projectDir: string;
  backend: FixtureBackend;
  /** Sends one request through the proxy, so the pipeline observes it. */
  call(pathname: string, options?: CallOptions): Promise<number>;
  /** Waits until the docs server reports at least this many operations. */
  waitForOperations(count: number, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface StartOptions {
  /** Reuses an earlier run's backend and project directory, to test a restart. */
  backend?: FixtureBackend;
  projectDir?: string;
  docsPort?: number;
}

/** A throwaway project root, so WireQuill writes its database somewhere safe. */
export function createProjectDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'wirequill-e2e-'));
  // `.git` is what `findProjectRoot` looks for, so the data directory lands
  // here rather than somewhere above the temporary folder.
  mkdirSync(path.join(directory, '.git'));
  return directory;
}

export function removeProjectDir(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

export function assertBuilt(): void {
  if (!existsSync(cliEntry) || !existsSync(uiEntry)) {
    throw new Error(
      'The end-to-end run needs the built CLI and interface. Run `pnpm build` first.',
    );
  }
}

export async function startWireQuill(options: StartOptions = {}): Promise<WireQuillProcess> {
  assertBuilt();

  const ownsBackend = options.backend === undefined;
  const backend = options.backend ?? (await startBackend());
  const ownsProjectDir = options.projectDir === undefined;
  const projectDir = options.projectDir ?? createProjectDir();

  const proxyPort = await freePort();
  const docsPort = options.docsPort ?? (await freePort());

  const child = spawn(
    process.execPath,
    [
      cliEntry,
      '--target',
      backend.origin,
      '--port',
      String(proxyPort),
      '--docs-port',
      String(docsPort),
      // Opening a real browser during an automated run would be a surprise at
      // best and a hang at worst.
      '--no-open',
    ],
    { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));

  const docsUrl = `http://127.0.0.1:${String(docsPort)}`;
  const proxyUrl = `http://127.0.0.1:${String(proxyPort)}`;

  try {
    await waitForHealth(docsUrl);
  } catch (error) {
    child.kill();
    throw new Error(`WireQuill did not start.\n${output.join('')}`, { cause: error });
  }

  return {
    docsUrl,
    proxyUrl,
    projectDir,
    backend,
    call: (pathname, callOptions) => proxyCall(proxyUrl, pathname, callOptions),
    waitForOperations: (count, timeoutMs = 10_000) =>
      waitFor(
        async () => {
          const summary = await getJson<{ operations: number }>(
            `${docsUrl}/__wirequill/api/summary`,
          );
          return summary.operations >= count;
        },
        timeoutMs,
        `${String(count)} documented operations`,
      ),
    stop: async () => {
      await stopChild(child);

      if (ownsBackend) {
        await backend.close();
      }

      if (ownsProjectDir) {
        removeProjectDir(projectDir);
      }
    },
  };
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill();

    // Windows has no signals to escalate through, so this is simply a deadline
    // on the child releasing its ports.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);

    child.once('exit', () => clearTimeout(timer));
  });
}

async function waitForHealth(docsUrl: string): Promise<void> {
  await waitFor(
    async () => {
      try {
        const health = await getJson<{ ok?: boolean }>(`${docsUrl}/__wirequill/api/health`);
        return health.ok === true;
      } catch {
        return false;
      }
    },
    20_000,
    'the documentation server',
  );
}

export function getJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });

    request.on('error', reject);
  });
}

function proxyCall(origin: string, pathname: string, options: CallOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    let payload: Buffer | undefined;

    if (options.body !== undefined) {
      payload = Buffer.from(JSON.stringify(options.body), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.byteLength);
    }

    const request = http.request(
      `${origin}${pathname}`,
      { method: options.method ?? 'GET', headers },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );

    request.on('error', reject);
    request.end(payload);
  });
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await predicate()) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not determine a free port'));
        return;
      }

      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
