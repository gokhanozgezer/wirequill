import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Output } from '../../src/cli/output.js';
import { loadConfig } from '../../src/config/load-config.js';
import {
  docsPortInUseError,
  docsUiMissingError,
  toDocsBindError,
} from '../../src/docs-server/docs-errors.js';
import { portInUseError, toBindError } from '../../src/proxy/proxy-errors.js';
import { SqliteStorage } from '../../src/storage/sqlite-storage.js';
import { isWireQuillError, type WireQuillError } from '../../src/utils/errors.js';

/**
 * Every way WireQuill can refuse to start (spec section 48).
 *
 * The contract for all of them is the same three things: what failed, why, and
 * what to do about it — and never a stack trace, because a stack frame can
 * carry a value the logging policy keeps out of the terminal.
 */

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'wirequill-errors-'));
  mkdirSync(path.join(projectDir, '.git'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function render(error: unknown): string {
  const lines: string[] = [];
  const output = new Output({ stdout: () => undefined, stderr: (line) => lines.push(line) });

  output.failure(error);
  return lines.join('\n');
}

function capture(work: () => void): WireQuillError {
  try {
    work();
  } catch (error) {
    expect(isWireQuillError(error), 'must be an actionable WireQuill error').toBe(true);
    return error as WireQuillError;
  }

  throw new Error('expected a failure');
}

describe('startup failures', () => {
  const withHint: [string, () => WireQuillError][] = [
    ['no target', () => capture(() => loadConfig({}, { cwd: projectDir, env: {} }))],
    [
      'invalid target',
      () => capture(() => loadConfig({ target: 'localhost:8080' }, { cwd: projectDir, env: {} })),
    ],
    [
      'target with credentials',
      () =>
        capture(() =>
          loadConfig(
            { target: 'http://user:SECRET_IN_TARGET@localhost:8080' },
            { cwd: projectDir, env: {} },
          ),
        ),
    ],
    [
      'invalid port',
      () =>
        capture(() =>
          loadConfig(
            { target: 'http://localhost:8080', port: 'abc' },
            { cwd: projectDir, env: {} },
          ),
        ),
    ],
    [
      'proxy and docs on one port',
      () =>
        capture(() =>
          loadConfig(
            { target: 'http://localhost:8080', port: '3000', docsPort: '3000' },
            { cwd: projectDir, env: {} },
          ),
        ),
    ],
    [
      'unreadable config file',
      () => {
        const configPath = path.join(projectDir, 'wirequill.config.json');
        writeFileSync(configPath, '{ not json');

        return capture(() =>
          loadConfig({ target: 'http://localhost:8080' }, { cwd: projectDir, env: {} }),
        );
      },
    ],
    ['proxy port busy', () => portInUseError('127.0.0.1', 3000, 'http://localhost:8080')],
    [
      'proxy port not permitted',
      () =>
        toBindError({ code: 'EACCES' }, '127.0.0.1', 80, 'http://localhost:8080') as WireQuillError,
    ],
    ['docs port busy', () => docsPortInUseError(3001, 'http://localhost:8080')],
    [
      'docs port not permitted',
      () => toDocsBindError({ code: 'EACCES' }, 80, 'http://localhost:8080'),
    ],
    ['documentation interface missing', () => docsUiMissingError()],
    [
      'database from a newer WireQuill',
      () => {
        const databasePath = path.join(projectDir, 'not-a-database.sqlite');
        writeFileSync(databasePath, 'definitely not SQLite');

        const storage = new SqliteStorage({ databasePath });
        const error = capture(() => storage.initialize());
        storage.close();
        return error;
      },
    ],
  ];

  it.each(withHint)('%s says what failed and what to do', (_label, produce) => {
    const error = produce();

    expect(error.code).toMatch(/^[A-Z0-9_]+$/);
    expect(error.message.length).toBeGreaterThan(0);
    // Every one of these is something the user can act on, so every one of them
    // says how.
    expect(error.hint, `${error.code} needs a hint`).toBeDefined();
    expect(String(error.hint).length).toBeGreaterThan(0);
  });

  it.each(withHint)('%s prints without a stack trace', (_label, produce) => {
    const rendered = render(produce());

    expect(rendered).toContain('WireQuill could not start.');
    expect(rendered).not.toContain('    at ');
    expect(rendered).not.toContain('.ts:');
    expect(rendered).not.toContain('node_modules');
  });

  it('never echoes a credential from the target', () => {
    const rendered = render(
      capture(() =>
        loadConfig(
          { target: 'http://user:SECRET_IN_TARGET@localhost:8080' },
          { cwd: projectDir, env: {} },
        ),
      ),
    );

    expect(rendered).not.toContain('SECRET_IN_TARGET');
  });

  it('reports an unexpected failure without a stack either', () => {
    const rendered = render(new Error('something went wrong at line 12'));

    expect(rendered).toContain('something went wrong');
    expect(rendered).not.toContain('    at ');
  });
});
