import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIRECTORY_NAME, DATABASE_FILE_NAME } from '../config/defaults.js';

/**
 * Resolves and creates `<project-root>/.wirequill` (spec section 18).
 *
 * On POSIX the directory is tightened to 0700 on a best-effort basis. Windows
 * ignores POSIX modes entirely, so the call is skipped there rather than
 * pretending it did something.
 */
export function ensureDataDirectory(projectRoot: string): string {
  const directory = path.join(projectRoot, DATA_DIRECTORY_NAME);

  mkdirSync(directory, { recursive: true });
  tightenPermissions(directory, 0o700);

  return directory;
}

export function defaultDatabasePath(projectRoot: string): string {
  return path.join(projectRoot, DATA_DIRECTORY_NAME, DATABASE_FILE_NAME);
}

/** Called after the database file exists; 0600 on POSIX, no-op on Windows. */
export function tightenDatabasePermissions(databasePath: string): void {
  tightenPermissions(databasePath, 0o600);
}

function tightenPermissions(target: string, mode: number): void {
  if (process.platform === 'win32') {
    return;
  }

  try {
    chmodSync(target, mode);
  } catch {
    // Best effort only: an exotic filesystem refusing chmod must not stop a
    // developer tool from starting.
  }
}
