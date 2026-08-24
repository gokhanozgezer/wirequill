import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import { contentTypeFor } from './mime-types.js';
import { SECURITY_HEADERS } from './response.js';

/**
 * Serves the pre-built docs UI (spec sections 42 to 51).
 *
 * The bundle is static. Nothing here starts Vite, compiles anything or reads
 * the user's project: WireQuill runs inside someone else's repository, and the
 * only directory it may read from is its own package.
 */

export const INDEX_FILE = 'index.html';

/** A year, the conventional value for content-addressed assets. */
const IMMUTABLE_MAX_AGE_SECONDS = 31_536_000;

export interface StaticUiOptions {
  /** Overridden in tests; production resolves it from the installed package. */
  root?: string;
}

export class StaticUi {
  readonly #root: string;

  constructor(options: StaticUiOptions = {}) {
    this.#root = options.root ?? resolveDocsUiRoot();
  }

  get root(): string {
    return this.#root;
  }

  /** False when the package was installed without its assets, or before a build. */
  get isAvailable(): boolean {
    return existsSync(path.join(this.#root, INDEX_FILE));
  }

  /**
   * Streams the asset for `urlPath`, or returns false when there is none.
   *
   * Returning false rather than falling back to `index.html` is deliberate: the
   * UI is a single page with no client-side routing, so a request for an
   * unknown path is a mistake, and answering it with the shell only hides the
   * mistake behind a blank screen (spec section 51).
   */
  serve(urlPath: string, response: ServerResponse): boolean {
    const file = this.resolve(urlPath);

    if (file === null) {
      return false;
    }

    const stats = statSync(file);

    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': contentTypeFor(file),
      'Content-Length': stats.size,
      'Cache-Control': cacheControlFor(file, this.#root),
    });

    createReadStream(file).pipe(response);
    return true;
  }

  /**
   * Maps a URL path to a file inside the asset root, or `null`.
   *
   * The containment check is `path.relative`, not a string prefix. On Windows a
   * prefix check is not enough: `%5c` decodes to a path separator, short names
   * and drive-relative paths exist, and `assets-evil` starts with `assets`.
   * `path.relative` answers the actual question — is the resolved file under the
   * root — after all of that has been normalised away (spec section 47).
   */
  resolve(urlPath: string): string | null {
    const decoded = decodePath(urlPath);

    if (decoded === null) {
      return null;
    }

    const relative = decoded === '/' ? INDEX_FILE : decoded.replace(/^\/+/, '');
    const candidate = path.resolve(this.#root, relative);
    const inside = path.relative(this.#root, candidate);

    if (inside !== '' && (inside.startsWith('..') || path.isAbsolute(inside))) {
      return null;
    }

    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      return null;
    }

    return candidate;
  }
}

/**
 * Where the built UI lives inside the installed package.
 *
 * Resolved from this module's own URL, never from `process.cwd()`: WireQuill is
 * run from the user's project directory, and under `npx` it lives somewhere
 * else entirely (spec sections 45 and 46). Walking up to the nearest
 * `package.json` keeps one answer correct for both layouts — `dist/` in a
 * published install, `src/docs-server/` when the tests run from source.
 */
export function resolveDocsUiRoot(): string {
  const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  return path.join(packageRoot, 'assets', 'docs-ui');
}

/**
 * Whether this build is running from a published package rather than a source
 * checkout.
 *
 * The bundled CLI lives in `dist/`; the sources live in `src/docs-server/`. The
 * distinction decides how loudly a missing interface is reported: in a
 * published install the assets are part of the package, so their absence is a
 * broken installation. In a checkout it usually means `pnpm build` has not run
 * yet (spec section 50).
 */
export function isPackagedInstall(): boolean {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(directory) === 'dist';
}

function findPackageRoot(start: string): string {
  let current = start;

  for (;;) {
    if (existsSync(path.join(current, 'package.json'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      // Filesystem root. Nothing sensible left to guess at, so fall back to the
      // starting directory and let `isAvailable` report the truth.
      return start;
    }

    current = parent;
  }
}

/**
 * Vite fingerprints its assets, so they may be cached forever; the entry point
 * may not, or a new WireQuill version would keep loading the old application
 * shell (spec sections 49 and 50).
 */
function cacheControlFor(file: string, root: string): string {
  const relative = path.relative(root, file);
  const isHashedAsset = relative.split(path.sep)[0] === 'assets';

  return isHashedAsset
    ? `public, max-age=${String(IMMUTABLE_MAX_AGE_SECONDS)}, immutable`
    : 'no-cache';
}

/** Rejects anything that cannot be a path rather than trying to repair it. */
function decodePath(urlPath: string): string | null {
  let decoded: string;

  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // Malformed percent-encoding. A browser does not produce it; something
    // probing does.
    return null;
  }

  if (decoded.includes('\0')) {
    return null;
  }

  return decoded;
}
