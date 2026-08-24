import { WireQuillError } from '../utils/errors.js';

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Parses and validates the `--target` value (spec sections 99 and 100).
 *
 * Only `http:` and `https:` are accepted. URLs carrying embedded credentials
 * are rejected outright rather than stripped, because accepting them would mean
 * the secret already lives in shell history and in any process listing.
 */
export function parseTargetUrl(raw: string): URL {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    throw invalidTarget(raw);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalidTarget(trimmed);
  }

  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw invalidTarget(trimmed);
  }

  if (url.hostname.length === 0) {
    throw invalidTarget(trimmed);
  }

  if (url.username !== '' || url.password !== '') {
    throw new WireQuillError(
      'TARGET_CREDENTIALS',
      [
        'Target URL must not contain credentials:',
        maskCredentials(url),
        '',
        'Credentials in a URL leak through shell history and process listings.',
      ].join('\n'),
      'Send the credentials as a request header from your client instead.',
    );
  }

  // Query strings and fragments on a target are meaningless: every proxied
  // request supplies its own. Dropping them keeps workspace identity stable.
  url.search = '';
  url.hash = '';

  return url;
}

/**
 * Stable string form used as one half of the workspace identity, so that the
 * same project pointed at the same backend keeps accumulating into the same
 * workspace across runs.
 */
export function normalizeTargetUrl(target: URL): string {
  const path = target.pathname === '/' ? '' : stripTrailingSlash(target.pathname);
  return `${target.protocol}//${target.host.toLowerCase()}${path}`;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function invalidTarget(value: string): WireQuillError {
  return new WireQuillError(
    'INVALID_TARGET',
    ['Invalid target URL:', value, '', 'Use:', 'http://localhost:8080'].join('\n'),
    'The target must be an absolute http:// or https:// URL.',
  );
}

/** Never echo a password back to the terminal, not even in an error. */
function maskCredentials(url: URL): string {
  const user = url.username === '' ? '' : url.username;
  const secret = url.password === '' ? '' : ':***';
  const credentials = user === '' && secret === '' ? '' : `${user}${secret}@`;
  return `${url.protocol}//${credentials}${url.host}${url.pathname}`;
}
