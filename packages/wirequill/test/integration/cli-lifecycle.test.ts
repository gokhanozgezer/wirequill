import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { Output } from '../../src/cli/output.js';
import { SqliteStorage } from '../../src/storage/sqlite-storage.js';
import { getFreePort } from '../helpers/ports.js';

/**
 * Exercises the whole CLI path — argument parsing, config resolution, storage
 * bootstrap, signal-driven shutdown — in one process.
 *
 * The SIGINT listener is invoked directly rather than through `process.kill`,
 * because Windows has no real signals: `process.kill(pid, 'SIGINT')` terminates
 * the target instead of delivering anything, so a spawned-process version of
 * this test could never pass there. A genuine Ctrl+C in a console does reach
 * the same listener this test calls.
 */

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'wirequill-e2e-'));
  mkdirSync(path.join(projectDir, '.git'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function fireSigint(): void {
  const listener = process.listeners('SIGINT').at(-1);
  expect(listener, 'the CLI should have installed a SIGINT listener').toBeDefined();
  listener?.('SIGINT');
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('wirequill CLI lifecycle', () => {
  it('starts, waits for a signal, then shuts down cleanly', async () => {
    const stdout: string[] = [];
    const output = new Output({
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });

    const before = process.listenerCount('SIGINT');

    const finished = runCli(
      [
        'node',
        'wirequill',
        '--target',
        'http://localhost:8080',
        '--port',
        String(await getFreePort()),
        '--docs-port',
        String(await getFreePort()),
      ],
      {
        output,
        cwd: projectDir,
        env: {},
        isTty: false,
        openBrowser: () => Promise.resolve(),
      },
    );

    let settled = false;
    void finished.then(() => {
      settled = true;
    });

    // The run must stay open until it is signalled.
    await waitFor(() => process.listenerCount('SIGINT') > before);
    expect(settled).toBe(false);
    expect(stdout.join('\n')).toContain('Watching API traffic...');

    fireSigint();

    const exitCode = await finished;

    expect(exitCode).toBe(0);
    expect(stdout.join('\n')).toContain('Stopped.');
    // The signal listener is removed, so a second run starts from a clean slate.
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('records a closed session on disk after the signal', async () => {
    const output = new Output({ stdout: () => undefined, stderr: () => undefined });
    const before = process.listenerCount('SIGINT');

    const finished = runCli(
      [
        'node',
        'wirequill',
        '--target',
        'http://localhost:8080',
        '--port',
        String(await getFreePort()),
        '--docs-port',
        String(await getFreePort()),
      ],
      {
        output,
        cwd: projectDir,
        env: {},
        isTty: false,
        openBrowser: () => Promise.resolve(),
      },
    );

    await waitFor(() => process.listenerCount('SIGINT') > before);
    fireSigint();
    await finished;

    const storage = new SqliteStorage({
      databasePath: path.join(projectDir, '.wirequill', 'wirequill.sqlite'),
    });
    storage.initialize();

    const workspace = storage.getOrCreateWorkspace({
      projectRoot: projectDir,
      targetUrl: 'http://localhost:8080',
    });
    const summary = storage.getSummary(workspace.id);

    expect(summary.sessionCount).toBe(1);
    expect(summary.operationCount).toBe(0);

    storage.close();
  });

  it('leaves no signal listeners behind when startup fails', async () => {
    const output = new Output({ stdout: () => undefined, stderr: () => undefined });
    const before = process.listenerCount('SIGINT');

    const exitCode = await runCli(
      ['node', 'wirequill', '--target', 'localhost:8080', '--port', String(await getFreePort())],
      { output, cwd: projectDir, env: {} },
    );

    expect(exitCode).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
