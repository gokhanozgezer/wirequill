/**
 * Refuses to run on a Node that cannot support WireQuill (spec section 17).
 *
 * `engines` in `package.json` is advisory: npm warns, and `npx` runs the
 * package anyway. Without this check the first thing an unsupported Node
 * produces is `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` — a stack trace about a
 * module the user has never heard of, in place of the one sentence that would
 * have explained it.
 *
 * Deliberately written in plain, long-supported syntax and imported before
 * anything else, so it can still run on the versions it is meant to reject.
 */

/** Node 24 is where `node:sqlite` became usable without a flag. */
export const MINIMUM_NODE_MAJOR = 24;

/**
 * Returns the message to print, or `null` when this Node will do.
 *
 * An unparseable version is accepted rather than rejected: a custom build with
 * an unusual version string is not a reason to refuse to start, and the real
 * failure — a missing built-in — will say so clearly enough on its own.
 */
export function nodeVersionError(version: string): string | null {
  const major = majorOf(version);

  if (major === null || major >= MINIMUM_NODE_MAJOR) {
    return null;
  }

  return [
    `WireQuill requires Node.js ${String(MINIMUM_NODE_MAJOR)} or newer.`,
    '',
    `Current version: ${version}`,
    '',
    "WireQuill stores what it observes with Node's built-in SQLite, which",
    `arrived in Node ${String(MINIMUM_NODE_MAJOR)}. There is nothing to compile and nothing to`,
    'install — only a newer Node.',
  ].join('\n');
}

export function majorOf(version: string): number | null {
  const match = /^v?(\d+)\./.exec(version.trim());

  if (match === null) {
    return null;
  }

  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

export function requireSupportedNode(
  version: string = process.version,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): boolean {
  const message = nodeVersionError(version);

  if (message === null) {
    return true;
  }

  write('');
  write(message);
  write('');
  return false;
}
