/**
 * Terminal escape injection defence (spec section 109).
 *
 * Anything derived from observed traffic or from the filesystem may contain
 * control sequences. Writing those straight to stdout lets a remote value move
 * the cursor, rewrite earlier lines or fake WireQuill's own output, so every
 * untrusted string is sanitised before it is printed.
 */

const DEFAULT_MAX_LENGTH = 200;

/** C0 controls (tabs and newlines included), DEL, and the C1 range. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

export function sanitizeTerminalText(value: string, maxLength = DEFAULT_MAX_LENGTH): string {
  const flattened = value.replace(CONTROL_CHARS, ' ');

  if (flattened.length <= maxLength) {
    return flattened;
  }

  // Reserve room for the ellipsis so the result never exceeds maxLength.
  return `${flattened.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Shortens a path for display, keeping both ends (spec sections 46 and 47).
 *
 * A long route is usually distinctive at the front and at the back —
 * `/v2/organizations/{organizationId}/members/{memberId}` — and cutting only
 * the tail throws away the half that says what the endpoint does. The middle is
 * the part nobody needs to read.
 *
 * Display only. The stored operation, the path template and the generated
 * document all keep the full path; this affects one column of one terminal
 * line.
 */
export function truncatePathForDisplay(value: string, maxLength: number): string {
  if (maxLength <= 1 || value.length <= maxLength) {
    return value;
  }

  const keep = maxLength - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;

  return `${value.slice(0, head)}…${tail === 0 ? '' : value.slice(-tail)}`;
}
