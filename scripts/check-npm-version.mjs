/**
 * Refuses to continue on an npm too old for trusted publishing.
 *
 *   node scripts/check-npm-version.mjs
 *
 * npm gained OIDC trusted publishing in 11.5.1. On an older one, `npm publish`
 * fails with an authentication error that says nothing about the actual cause,
 * so the release workflow checks first and says what is wrong.
 */
import { execFileSync } from 'node:child_process';

const MINIMUM = [11, 5, 1];

/**
 * Node refuses to spawn a `.cmd` directly, so on Windows npm is reached through
 * cmd.exe rather than through `shell: true` — the same rule the packaging smoke
 * follows, and for the same reason.
 */
const raw = (
  process.platform === 'win32'
    ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', '"npm --version"'], {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
      })
    : execFileSync('npm', ['--version'], { encoding: 'utf8', shell: false })
).trim();

const actual = raw.split('.').map(Number);

function isOldEnough(found, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    const part = found[index] ?? 0;
    const need = minimum[index];

    if (part > need) return false;
    if (part < need) return true;
  }
  return false;
}

console.log(`npm ${raw}`);

if (actual.some((part) => !Number.isFinite(part)) || isOldEnough(actual, MINIMUM)) {
  console.error('');
  console.error(`Trusted publishing needs npm ${MINIMUM.join('.')} or newer.`);
  console.error('Upgrade npm, or publish from a Node release that ships a newer one.');
  process.exitCode = 1;
}
