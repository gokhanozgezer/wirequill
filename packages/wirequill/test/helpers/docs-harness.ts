import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Output } from '../../src/cli/output.js';
import { loadConfig } from '../../src/config/load-config.js';
import type { WireQuillConfig } from '../../src/config/types.js';
import { WireQuillRuntime } from '../../src/runtime/wirequill-runtime.js';
import { startFixtureBackend, type FixtureBackend } from '../fixtures/backend.js';
import { getFreePort } from './ports.js';

/**
 * A complete WireQuill — proxy, capture, storage, docs server — in front of the
 * fixture backend.
 *
 * Deliberately the real runtime rather than a `DocsServer` in isolation. What
 * these tests are about is the path from a proxied request to a browser
 * noticing, and every interesting bug in that path lives in the seams.
 */

export interface DocsHarness {
  runtime: WireQuillRuntime;
  backend: FixtureBackend;
  config: WireQuillConfig;
  proxyOrigin: string;
  docsOrigin: string;
  docsPort: number;
  projectDir: string;
  stdout: string[];
  stderr: string[];
  /** URLs handed to the browser opener. Empty unless a test asked for one. */
  opened: string[];
  /** Sends a request through the proxy, to the fixture backend. */
  call(pathname: string, options?: CallOptions): Promise<number>;
  /**
   * Waits until the docs server reports at least `count` operations.
   *
   * Capture is asynchronous by design — the response reached the client long
   * before the observation was processed — so every assertion about
   * documentation has to wait for the pipeline rather than for a timer.
   */
  waitForOperations(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface DocsHarnessOptions {
  /** Simulates a developer at a terminal, so the browser decision can be tested. */
  isTty?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Passing false is the `--no-open` case. */
  openBrowser?: boolean;
  /** Reuses an earlier harness's project directory, to test restart behaviour. */
  projectDir?: string;
  docsPort?: number;
  assetRoot?: string;
  /**
   * Reuses a backend across two runs.
   *
   * Workspace identity is the project root plus the target URL, so a restart
   * test that let the fixture pick a new port would be looking at a brand new,
   * empty workspace. When supplied, closing it stays the caller's job.
   */
  backend?: FixtureBackend;
}

export async function startDocsHarness(options: DocsHarnessOptions = {}): Promise<DocsHarness> {
  const ownsBackend = options.backend === undefined;
  const backend = options.backend ?? (await startFixtureBackend({ tls: false }));
  const projectDir = options.projectDir ?? mkdtempSync(path.join(os.tmpdir(), 'wirequill-docs-'));

  if (options.projectDir === undefined) {
    mkdirSync(path.join(projectDir, '.git'));
  }

  const proxyPort = await getFreePort();
  const docsPort = options.docsPort ?? (await getFreePort());

  const config = loadConfig(
    {
      target: backend.origin,
      port: String(proxyPort),
      docsPort: String(docsPort),
      open: options.openBrowser ?? false,
    },
    { cwd: projectDir, env: {} },
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  const opened: string[] = [];

  const output = new Output({
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  const runtime = new WireQuillRuntime({
    config,
    output,
    isTty: options.isTty ?? false,
    env: options.env ?? {},
    openBrowser: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    ...(options.assetRoot === undefined ? {} : { docsAssetRoot: options.assetRoot }),
  });

  await runtime.start();

  const proxyOrigin = `http://127.0.0.1:${String(proxyPort)}`;

  return {
    runtime,
    backend,
    config,
    proxyOrigin,
    docsOrigin: `http://127.0.0.1:${String(docsPort)}`,
    docsPort,
    projectDir,
    stdout,
    stderr,
    opened,
    call: (pathname, callOptions) => proxyCall(proxyOrigin, pathname, callOptions),
    waitForOperations: (count, timeoutMs = 5_000) =>
      waitForValue(
        async () => {
          const summary = await getJson<{ operations: number }>(
            `http://127.0.0.1:${String(docsPort)}`,
            '/__wirequill/api/summary',
          );
          return summary.operations >= count;
        },
        timeoutMs,
        `${String(count)} documented operations`,
      ),
    close: async () => {
      await runtime.stop();

      if (ownsBackend) {
        await backend.close();
      }

      if (options.projectDir === undefined) {
        rmSync(projectDir, { recursive: true, force: true });
      }
    },
  };
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

export interface DocsResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A plain GET against the docs server, with no client-side caching in the way. */
export function getDocs(
  origin: string,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<DocsResponse> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${origin}${pathname}`, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    request.on('error', reject);
  });
}

export function getJson<T>(origin: string, pathname: string): Promise<T> {
  return getDocs(origin, pathname).then((response) => JSON.parse(response.body) as T);
}

export interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

export interface SseClient {
  frames: SseFrame[];
  comments: string[];
  waitFor(predicate: (frames: SseFrame[]) => boolean, timeoutMs?: number): Promise<void>;
  close(): void;
}

/**
 * A hand-rolled SSE reader.
 *
 * Node's `EventSource` would do, but it retries on its own, which is precisely
 * what several of these tests need to control. This one connects once and
 * reports exactly what came down the wire.
 */
export function openSse(origin: string, pathname = '/__wirequill/events'): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const frames: SseFrame[] = [];
    const comments: string[] = [];
    let buffer = '';

    const request = http.get(
      `${origin}${pathname}`,
      { headers: { Accept: 'text/event-stream' } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`event stream responded ${String(response.statusCode)}`));
          return;
        }

        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;

          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            parseBlock(buffer.slice(0, boundary), frames, comments);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
          }
        });

        resolve({
          frames,
          comments,
          waitFor: (predicate, timeoutMs = 5_000) =>
            waitFor(() => predicate(frames), timeoutMs, 'an event stream frame'),
          close: () => {
            request.destroy();
            response.destroy();
          },
        });
      },
    );

    request.on('error', reject);
  });
}

function parseBlock(block: string, frames: SseFrame[], comments: string[]): void {
  let event = 'message';
  const data: string[] = [];

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      comments.push(line.slice(1).trim());
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      data.push(line.slice(5).trim());
    }
  }

  if (data.length === 0) {
    return;
  }

  try {
    frames.push({ event, data: JSON.parse(data.join('\n')) as Record<string, unknown> });
  } catch {
    // A frame that is not JSON is not something this server produces.
  }
}

/** Same as `waitFor`, for a predicate that has to ask the server. */
export async function waitForValue(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
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

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A request the interface never makes, so a test can prove it is refused. */
export function sendDocsRequest(origin: string, pathname: string, method: string): Promise<number> {
  const url = new URL(origin);

  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: url.hostname, port: url.port, path: pathname, method },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );

    request.on('error', reject);
    request.end();
  });
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
