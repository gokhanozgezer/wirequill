import { WireQuillError, errorCode } from '../utils/errors.js';

/**
 * Startup failures for the documentation server (spec section 18).
 *
 * Same rule as the proxy: WireQuill never quietly moves to another port. A docs
 * URL that changes between runs is a URL nobody can bookmark, and a port that
 * silently shifts hides the fact that something else is already listening.
 */

export function docsPortInUseError(port: number, target: string): WireQuillError {
  const suggestedPort = port + 10;

  return new WireQuillError(
    'DOCS_PORT_IN_USE',
    `Docs port ${String(port)} is already in use.`,
    [
      'Try:',
      `wirequill --target ${target} --docs-port ${String(suggestedPort)}`,
      '',
      `Or free the process listening on 127.0.0.1:${String(port)}.`,
    ].join('\n'),
  );
}

export function toDocsBindError(error: unknown, port: number, target: string): WireQuillError {
  const code = errorCode(error);

  if (code === 'EADDRINUSE') {
    return docsPortInUseError(port, target);
  }

  if (code === 'EACCES') {
    return new WireQuillError(
      'DOCS_PORT_NOT_PERMITTED',
      `Docs port ${String(port)} requires elevated permissions.`,
      'Pick a port above 1024, for example --docs-port 3011.',
    );
  }

  return new WireQuillError(
    'DOCS_BIND_FAILED',
    `Could not start the documentation server on port ${String(port)}.\n\n${
      error instanceof Error ? error.message : String(error)
    }`,
    'Check that you may bind that port on 127.0.0.1.',
  );
}

/**
 * The published package is missing its documentation interface
 * (spec section 50).
 *
 * A real possibility: a partial extraction, an over-eager `.npmignore` in a
 * fork, a file-copy deploy that skipped a directory. Reported as what it is —
 * an incomplete installation — rather than as a 404 the user has to interpret.
 * No filesystem listing is printed; the path it looked in is a local path.
 */
export function docsUiMissingError(): WireQuillError {
  return new WireQuillError(
    'DOCS_UI_MISSING',
    [
      'WireQuill installation is incomplete.',
      'The documentation interface could not be found in this package.',
    ].join('\n'),
    ['Reinstall WireQuill, for example:', 'npm install --force wirequill'].join('\n'),
  );
}
