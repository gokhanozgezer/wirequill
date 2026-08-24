import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface ProjectInfo {
  root: string;
  /** `name` from the nearest package.json, when there is one. */
  packageName: string | null;
  /** True when the root was found via a `.git` marker rather than falling back to cwd. */
  fromGitRoot: boolean;
}

/**
 * Project root discovery (spec section 18).
 *
 * Walks up from `startDir` looking for a `.git` marker and falls back to
 * `startDir` itself. A git worktree stores `.git` as a file rather than a
 * directory, so existence is checked instead of directory-ness.
 */
export function findProjectRoot(startDir: string = process.cwd()): ProjectInfo {
  const start = path.resolve(startDir);
  let current = start;

  for (;;) {
    if (existsSync(path.join(current, '.git'))) {
      return {
        root: current,
        packageName: readPackageName(current),
        fromGitRoot: true,
      };
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return {
    root: start,
    packageName: readPackageName(start),
    fromGitRoot: false,
  };
}

function readPackageName(dir: string): string | null {
  const manifestPath = path.join(dir, 'package.json');

  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
      const { name } = parsed as { name: unknown };
      if (typeof name === 'string' && name.length > 0) {
        return name;
      }
    }
  } catch {
    // A malformed package.json is not WireQuill's problem; the docs title just
    // falls back to a generic value.
  }

  return null;
}
