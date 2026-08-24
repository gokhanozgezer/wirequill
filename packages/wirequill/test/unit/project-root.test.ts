import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findProjectRoot } from '../../src/project/project-root.js';
import { ensureDataDirectory, defaultDatabasePath } from '../../src/project/data-directory.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'wirequill-project-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findProjectRoot', () => {
  it('walks up to the nearest .git directory', () => {
    mkdirSync(path.join(root, '.git'));
    const nested = path.join(root, 'apps', 'web', 'src');
    mkdirSync(nested, { recursive: true });

    const info = findProjectRoot(nested);

    expect(info.root).toBe(root);
    expect(info.fromGitRoot).toBe(true);
  });

  it('treats a .git file as a marker, as git worktrees create one', () => {
    writeFileSync(path.join(root, '.git'), 'gitdir: ../elsewhere', 'utf8');
    const nested = path.join(root, 'pkg');
    mkdirSync(nested);

    expect(findProjectRoot(nested).root).toBe(root);
  });

  it('falls back to the starting directory when there is no marker', () => {
    const nested = path.join(root, 'standalone');
    mkdirSync(nested);

    const info = findProjectRoot(nested);

    expect(info.root).toBe(nested);
    expect(info.fromGitRoot).toBe(false);
  });

  it('reads the package name when there is one', () => {
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'acme-api' }), 'utf8');

    expect(findProjectRoot(root).packageName).toBe('acme-api');
  });

  it('survives a malformed package.json', () => {
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, 'package.json'), '{ broken', 'utf8');

    expect(findProjectRoot(root).packageName).toBeNull();
  });
});

describe('ensureDataDirectory', () => {
  it('creates the data directory and is idempotent', () => {
    const first = ensureDataDirectory(root);
    const second = ensureDataDirectory(root);

    expect(first).toBe(path.join(root, '.wirequill'));
    expect(second).toBe(first);
  });

  it('derives the default database path from the project root', () => {
    expect(defaultDatabasePath(root)).toBe(path.join(root, '.wirequill', 'wirequill.sqlite'));
  });
});
