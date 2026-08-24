import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { Output } from '../../src/cli/output.js';
import { WIREQUILL_VERSION } from '../../src/version.js';
import { getFreePort, occupyPort } from '../helpers/ports.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'wirequill-cli-'));
  mkdirSync(path.join(projectDir, '.git'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

interface CaptureResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the CLI end to end. Free ports are injected unless the test picked them,
 * because the CLI binds two real sockets and must not collide with a proxy or a
 * docs server the developer happens to be running.
 */
async function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CaptureResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const output = new Output({
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  const withProxyPort = args.includes('--port')
    ? args
    : [...args, '--port', String(await getFreePort())];
  const effectiveArgs = args.includes('--docs-port')
    ? withProxyPort
    : [...withProxyPort, '--docs-port', String(await getFreePort())];

  const code = await runCli(['node', 'wirequill', ...effectiveArgs], {
    output,
    cwd: projectDir,
    env,
    waitForSignal: false,
    // No test may spawn a browser, whatever terminal it happens to run in.
    isTty: false,
    openBrowser: () => Promise.resolve(),
  });

  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('runCli', () => {
  it('prints help and exits zero', async () => {
    const result = await run(['--help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: wirequill');
    expect(result.stdout).toContain('--target <url>');
    expect(result.stdout).toContain('--insecure');
    expect(result.stdout).toContain('--no-open');
  });

  it('prints the version and exits zero', async () => {
    const result = await run(['--version']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(WIREQUILL_VERSION);
  });

  it('rejects an unknown flag', async () => {
    const result = await run(['--nope']);
    expect(result.code).not.toBe(0);
  });

  it('reports a missing target without a stack trace', async () => {
    const result = await run([]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('WireQuill could not start.');
    expect(result.stderr).toContain('No target specified.');
    expect(result.stderr).toContain('wirequill --target http://localhost:8080');
    expect(result.stderr).not.toContain('at ');
  });

  it('reports an invalid target with the documented wording', async () => {
    const result = await run(['--target', 'localhost:8080']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid target URL:');
    expect(result.stderr).toContain('localhost:8080');
    expect(result.stderr).toContain('http://localhost:8080');
  });

  it('never prints target credentials', async () => {
    const result = await run(['--target', 'http://user:ULTRA_SECRET_123@localhost:8080']);

    expect(result.code).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain('ULTRA_SECRET_123');
  });

  it('starts the proxy and reports the resolved settings', async () => {
    const port = await getFreePort();
    const result = await run(['--target', 'http://localhost:8080', '--port', String(port)]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('WireQuill');
    expect(result.stdout).toContain('http://localhost:8080');
    expect(result.stdout).toContain(`127.0.0.1:${String(port)}`);
    expect(result.stdout).toContain('Watching API traffic...');
  });

  it('reports the docs address on startup', async () => {
    const docsPort = await getFreePort();
    const result = await run([
      '--target',
      'http://localhost:8080',
      '--docs-port',
      String(docsPort),
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Docs');
    expect(result.stdout).toContain(`http://127.0.0.1:${String(docsPort)}`);
  });

  it('reports a busy docs port with an actionable message and a non-zero exit', async () => {
    const docsPort = await getFreePort();
    const occupied = await occupyPort(docsPort);

    try {
      const result = await run([
        '--target',
        'http://localhost:8080',
        '--docs-port',
        String(docsPort),
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('WireQuill could not start.');
      expect(result.stderr).toContain(`Docs port ${String(docsPort)} is already in use.`);
      expect(result.stderr).toContain('wirequill --target http://localhost:8080 --docs-port');
      expect(result.stderr).not.toContain('at ');
    } finally {
      await occupied.close();
    }
  });

  it('reports a busy port with an actionable message and a non-zero exit', async () => {
    const port = await getFreePort();
    const occupied = await occupyPort(port);

    try {
      const result = await run(['--target', 'http://localhost:8080', '--port', String(port)]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('WireQuill could not start.');
      expect(result.stderr).toContain(`Port ${String(port)} is already in use.`);
      expect(result.stderr).toContain('wirequill --target http://localhost:8080 --port');
      expect(result.stderr).not.toContain('at ');
    } finally {
      await occupied.close();
    }
  });

  it('creates the data directory and the database', async () => {
    await run(['--target', 'http://localhost:8080']);

    expect(existsSync(path.join(projectDir, '.wirequill'))).toBe(true);
    expect(existsSync(path.join(projectDir, '.wirequill', 'wirequill.sqlite'))).toBe(true);
  });

  it('warns when TLS verification is disabled', async () => {
    const result = await run(['--target', 'https://localhost:8443', '--insecure']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('TLS certificate verification is disabled for the target.');
  });

  it('does not warn about TLS by default', async () => {
    const result = await run(['--target', 'https://localhost:8443']);
    expect(result.stderr).not.toContain('TLS certificate verification is disabled');
  });

  it('reads the target from the environment', async () => {
    const result = await run([], { WIREQUILL_TARGET: 'http://localhost:9090' });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('http://localhost:9090');
  });

  it('reports a busy-looking port conflict between proxy and docs', async () => {
    const result = await run([
      '--target',
      'http://localhost:8080',
      '--port',
      '3001',
      '--docs-port',
      '3001',
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('both 3001');
  });
});
