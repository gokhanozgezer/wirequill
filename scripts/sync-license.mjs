/**
 * Copies LICENSE and NOTICE into the published package.
 *
 * npm only packs files that live inside the package directory, so the
 * repository root's copies cannot be referenced from there. Two files that must
 * stay identical are a drift risk, so they are generated rather than
 * hand-maintained, and a test asserts they match.
 *
 * Node APIs only, so it behaves the same in PowerShell, cmd and any POSIX
 * shell.
 */
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(repoRoot, 'packages', 'wirequill');

for (const file of ['LICENSE', 'NOTICE']) {
  await copyFile(path.join(repoRoot, file), path.join(packageRoot, file));
  console.log(`sync-license: ${path.join('packages', 'wirequill', file)}`);
}
