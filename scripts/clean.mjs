/**
 * Removes build output. Node-only so it works the same in PowerShell, cmd and
 * any POSIX shell.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  path.join(repoRoot, 'apps', 'docs-ui', 'dist'),
  path.join(repoRoot, 'packages', 'wirequill', 'dist'),
  path.join(repoRoot, 'packages', 'wirequill', 'assets'),
  path.join(repoRoot, 'coverage'),
];

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
  console.log(`clean: ${path.relative(repoRoot, target)}`);
}
