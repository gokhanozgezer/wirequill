/**
 * Error type for problems the user can act on: bad flags, an unusable target,
 * a busy port. The CLI prints `message` plus `hint` and exits non-zero without
 * a stack trace, because a stack trace is noise for a configuration mistake.
 */
export class WireQuillError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'WireQuillError';
    this.code = code;
    this.hint = hint;
  }
}

export function isWireQuillError(value: unknown): value is WireQuillError {
  return value instanceof WireQuillError;
}

/** Node attaches `code` to syscall errors; narrow to it without casting to `any`. */
export function errorCode(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const { code } = value as { code: unknown };
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}

export function errorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return String(value);
}
