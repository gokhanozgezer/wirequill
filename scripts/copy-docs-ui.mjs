/**
 * Copies the built docs UI into the published package (spec section 142).
 *
 * Runs after `vite build`. Uses only Node APIs so it behaves identically on
 * Windows, macOS and Linux — no `cp -r`, no shell globbing.
 */
import { cp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repoRoot, 'apps', 'docs-ui', 'dist');
const destination = path.join(repoRoot, 'packages', 'wirequill', 'assets', 'docs-ui');

async function main() {
  try {
    const info = await stat(source);
    if (!info.isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    console.error(`copy-docs-ui: nothing to copy, ${source} does not exist.`);
    console.error('copy-docs-ui: run the docs UI build first.');
    process.exitCode = 1;
    return;
  }

  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });

  console.log(`copy-docs-ui: ${path.relative(repoRoot, destination)}`);
}

await main();
