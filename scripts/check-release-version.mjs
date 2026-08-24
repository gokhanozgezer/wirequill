/**
 * Refuses to publish a version nobody asked for.
 *
 *   node scripts/check-release-version.mjs
 *
 * The release workflow can be triggered two ways, and both of them name a
 * version: a published GitHub Release names it in the tag, and a manual run
 * names it in an input. Either way it has to match the manifest, because the
 * thing that actually gets published is the manifest — a tag that disagrees with
 * it publishes the wrong version under the right name.
 *
 * Reads `RELEASE_REF` (a tag such as `v0.1.0`) and `RELEASE_INPUT` (a bare
 * version such as `0.1.0`). Outside CI, with neither set, it simply reports the
 * manifest version.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'packages', 'wirequill', 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const declared = manifest.version;
const tag = (process.env.RELEASE_REF ?? '').trim();
const input = (process.env.RELEASE_INPUT ?? '').trim();

console.log(`package.json  ${declared}`);

const asked = tag === '' ? input : tag.replace(/^v/, '');

if (asked === '') {
  console.log('no release ref or input given, nothing to compare');
  process.exit(0);
}

console.log(`requested     ${asked}${tag === '' ? '' : `  (from tag ${tag})`}`);

if (asked !== declared) {
  console.error('');
  console.error('The version being released does not match the manifest.');
  console.error('');
  console.error(`  packages/wirequill/package.json  ${declared}`);
  console.error(`  release                          ${asked}`);
  console.error('');
  console.error('Update one of them so they agree, then run this again.');
  process.exitCode = 1;
} else {
  console.log('versions agree');
}
