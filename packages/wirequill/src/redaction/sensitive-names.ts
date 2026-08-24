/**
 * Field-name matching for redaction (spec sections 51, 34, 35).
 *
 * The hard part is not catching `password`; it is not catching `monkey` because
 * it ends in "key", or `passwordPolicy` because it starts with "password".
 * Matching therefore works on a normalised name in two narrow ways:
 *
 *   1. the whole normalised name is a known sensitive name, or
 *   2. the last token is a word that only ever ends a secret-bearing name.
 *
 * Rule 2 is what makes `user_password` and `billing_email` work while leaving
 * `password_policy` and `public_key` alone, because their last tokens are
 * `policy` and `key`, neither of which is a terminal secret word.
 */

/**
 * Folds camelCase, kebab-case, snake_case and header casing into one form.
 *
 *   accessToken   -> access_token
 *   access-token  -> access_token
 *   AccessToken   -> access_token
 *   X-API-Key     -> x_api_key
 */
export function normalizeFieldName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s\-.]+/g, '_')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Whole normalised names that are sensitive regardless of context. */
const SENSITIVE_NAMES = new Set([
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'client_secret',
  'private_key',
  'privatekey',
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'auth_token',
  'api_key',
  'apikey',
  'authorization',
  'proxy_authorization',
  'cookie',
  'set_cookie',
  'session',
  'session_id',
  'sessionid',
  'session_token',
  'card_number',
  'cardnumber',
  'credit_card',
  'creditcard',
  'cvv',
  'cvc',
  'email',
  'email_address',
  'user_email',
  'otp',
  'one_time_password',
  'security_code',
]);

/**
 * Words that make any name ending in them sensitive.
 *
 * Deliberately short. `key` is absent because `public_key` must survive, and
 * `id` is absent because identifiers are the opposite of secrets.
 */
const SENSITIVE_TERMINALS = new Set([
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'cvv',
  'cvc',
  'email',
]);

export function isSensitiveFieldName(name: string, extra: ReadonlySet<string>): boolean {
  const normalized = normalizeFieldName(name);

  if (normalized === '') {
    return false;
  }

  if (SENSITIVE_NAMES.has(normalized) || extra.has(normalized)) {
    return true;
  }

  const tokens = normalized.split('_');
  const last = tokens.at(-1);

  return last !== undefined && tokens.length > 1 && SENSITIVE_TERMINALS.has(last);
}

/** Turns user-supplied extra field names into the normalised form. */
export function normalizeConfiguredNames(names: readonly string[]): ReadonlySet<string> {
  return new Set(names.map((name) => normalizeFieldName(name)).filter((name) => name !== ''));
}

/** Header names whose values must never survive into observed state. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy_authorization',
  'cookie',
  'set_cookie',
  'x_api_key',
  'api_key',
  'x_auth_token',
  'x_access_token',
  'x_csrf_token',
  'x_session_token',
  'x_amz_security_token',
]);

export function isSensitiveHeaderName(name: string, extra: ReadonlySet<string>): boolean {
  const normalized = normalizeFieldName(name);
  return (
    SENSITIVE_HEADERS.has(normalized) || extra.has(normalized) || isSensitiveFieldName(name, extra)
  );
}
