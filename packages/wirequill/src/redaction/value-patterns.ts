/**
 * Value-shaped secret detection (spec sections 54, 41, 42, 43).
 *
 * These catch secrets whose field name gives nothing away — a token under
 * `data`, a key under `value`. They are deliberately conservative: a false
 * positive silently corrupts documentation a developer is trying to read, and
 * field-name matching already covers the overwhelming majority of real cases.
 */

/** Three base64url segments, the first of which decodes to a JSON header. */
const JWT_SHAPE = /^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{0,}$/;

export function looksLikeJwt(value: string): boolean {
  if (value.length < 20 || value.length > 8192) {
    return false;
  }

  if (!JWT_SHAPE.test(value)) {
    return false;
  }

  // `1.2.3` and `a.b.c` match plenty of dot-separated shapes, so the header is
  // actually decoded: a real JWT header is base64url-encoded JSON.
  const header = value.slice(0, value.indexOf('.'));

  try {
    const decoded = Buffer.from(header, 'base64url').toString('utf8');
    if (!decoded.startsWith('{')) {
      return false;
    }
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

const PRIVATE_KEY_MARKER =
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/;

/**
 * Private key material only. A certificate or a public key is not a secret, and
 * redacting one would be noise.
 */
export function looksLikePrivateKey(value: string): boolean {
  return PRIVATE_KEY_MARKER.test(value);
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDENTIAL_CHARSET = /^[A-Za-z0-9_-]+$/;

const MIN_CREDENTIAL_LENGTH = 32;
const MAX_CREDENTIAL_LENGTH = 512;
const MIN_ENTROPY_BITS_PER_CHAR = 3.6;

/**
 * A long, dense, random-looking token.
 *
 * Requires an unbroken base64url/hex alphabet, which rules out URLs, file
 * paths, sentences and version strings in one step, and excludes UUIDs
 * explicitly because identifiers are not credentials — Faz 3 needs to see them.
 */
export function looksLikeCredential(value: string): boolean {
  if (value.length < MIN_CREDENTIAL_LENGTH || value.length > MAX_CREDENTIAL_LENGTH) {
    return false;
  }

  if (UUID_SHAPE.test(value)) {
    return false;
  }

  if (!CREDENTIAL_CHARSET.test(value)) {
    return false;
  }

  // A run of only letters or only digits is a word or a number, not a key.
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    return false;
  }

  return shannonEntropyBitsPerChar(value) >= MIN_ENTROPY_BITS_PER_CHAR;
}

export function shannonEntropyBitsPerChar(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
}

/**
 * An `Authorization`-style value: a scheme followed by a credential.
 *
 * Worth detecting on shape because such a value routinely appears where no
 * field name identifies it — echoed into a debug endpoint's response, or listed
 * in a flat array of header name/value pairs. The credential part must be a
 * single unbroken token, so prose like "Bearer token required" is not matched.
 */
const AUTH_SCHEME_VALUE =
  /^(?:bearer|basic|digest|token|apikey|negotiate)\s+[A-Za-z0-9._~+/=-]{8,}$/i;

export function looksLikeAuthorizationValue(value: string): boolean {
  return value.length <= 8192 && AUTH_SCHEME_VALUE.test(value.trim());
}

/**
 * A `name=value` pair whose name is sensitive, such as a raw cookie string.
 *
 * Cookies reach WireQuill as one joined string, and the same shape turns up in
 * query fragments embedded in bodies. Matching the name through the ordinary
 * field rules keeps this as conservative as everything else here.
 */
const NAME_VALUE_PAIR = /^([A-Za-z0-9_.-]{1,64})=([^;\s]+)/;

export function looksLikeSensitivePair(
  value: string,
  isSensitiveName: (name: string) => boolean,
): boolean {
  const match = NAME_VALUE_PAIR.exec(value.trim());
  const name = match?.[1];

  return name !== undefined && isSensitiveName(name);
}

/** True when a value should be redacted on its shape alone. */
export function isSensitiveValue(
  value: string,
  isSensitiveName: (name: string) => boolean = () => false,
): boolean {
  return (
    looksLikePrivateKey(value) ||
    looksLikeJwt(value) ||
    looksLikeAuthorizationValue(value) ||
    looksLikeSensitivePair(value, isSensitiveName) ||
    looksLikeCredential(value)
  );
}
