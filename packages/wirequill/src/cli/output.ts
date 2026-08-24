import pc from 'picocolors';
import { isWireQuillError } from '../utils/errors.js';
import { sanitizeTerminalText, truncatePathForDisplay } from '../utils/terminal.js';

export interface OutputStreams {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * All terminal writing goes through here.
 *
 * Two reasons: tests can capture output without touching the real streams, and
 * there is exactly one place to enforce the logging policy (spec section 108) —
 * no raw bodies, no header values, no secrets, ever.
 */
export class Output {
  readonly #streams: OutputStreams;

  constructor(streams: OutputStreams = defaultStreams()) {
    this.#streams = streams;
  }

  blank(): void {
    this.#streams.stdout('');
  }

  line(text = ''): void {
    this.#streams.stdout(text);
  }

  /** For values that came from the filesystem or from observed traffic. */
  untrusted(text: string): string {
    return sanitizeTerminalText(text);
  }

  banner(version: string): void {
    this.line(`${pc.bold('WireQuill')} ${pc.dim(version)}`);
  }

  /** A short label the reader can act on, under the addresses. */
  hint(text: string): void {
    this.line(pc.dim(text));
  }

  field(label: string, value: string, note?: string): void {
    const padded = label.padEnd(8, ' ');
    const suffix = note === undefined ? '' : ` ${pc.dim(note)}`;
    this.line(`${pc.dim(padded)} ${value}${suffix}`);
  }

  status(text: string): void {
    this.line(`${pc.green('●')} ${text}`);
  }

  warn(text: string): void {
    this.#streams.stderr(`${pc.yellow('Warning:')} ${text}`);
  }

  /**
   * One line per proxied request. Metadata only (spec section 108): a method, a
   * path, a status and a duration. No header value and no payload ever reaches
   * the terminal, and the path is sanitised because it comes from the client.
   */
  traffic(
    method: string,
    path: string,
    statusCode: number | undefined,
    durationMs: number,
    discovered = false,
  ): void {
    // The marker carries the meaning; the colour only reinforces it. Under a
    // pipe, in a CI log or for a reader who cannot distinguish green from red,
    // `+` and `!` still say what happened (spec sections 14 and 15).
    const marker = discovered
      ? pc.green('+')
      : statusCode !== undefined && statusCode >= 500
        ? pc.red('!')
        : ' ';

    const status = statusCode === undefined ? pc.dim('---') : this.#colourStatus(statusCode);
    const duration = `${String(Math.round(durationMs))}ms`;

    this.line(
      [
        marker,
        method.toUpperCase().padEnd(METHOD_COLUMN),
        formatPathColumn(path),
        // Always three visible characters, colour aside, so the duration
        // column lines up without measuring escape sequences.
        status,
        pc.dim(duration.padStart(DURATION_COLUMN)),
      ].join(' '),
    );
  }

  /**
   * A `--verbose` diagnostic. Metadata only: a reason and a limit, never a
   * value, a header or a payload (spec section 108).
   */
  diagnostic(text: string): void {
    this.line(`  ${pc.dim(`capture: ${sanitizeTerminalText(text, 120)}`)}`);
  }

  /** The target could not be reached. The code is a syscall name, never a message. */
  trafficFailure(method: string, path: string, code: string): void {
    this.line(
      [
        pc.red('!'),
        method.toUpperCase().padEnd(METHOD_COLUMN),
        formatPathColumn(path),
        pc.red('---'),
      ].join(' '),
    );
    this.line(`  ${pc.dim(`Target connection failed: ${sanitizeTerminalText(code, 40)}`)}`);
  }

  #colourStatus(statusCode: number): string {
    const text = String(statusCode);

    if (statusCode >= 500) {
      return pc.red(text);
    }
    if (statusCode >= 400) {
      return pc.yellow(text);
    }
    if (statusCode >= 300) {
      return pc.cyan(text);
    }
    return pc.green(text);
  }

  /**
   * Renders a failure the user can act on. `WireQuillError` gets its message
   * and hint; anything else is reported without a stack trace, because a stack
   * trace can carry values that the logging policy keeps out of the terminal.
   */
  failure(error: unknown): void {
    this.#streams.stderr('');
    this.#streams.stderr(pc.red('WireQuill could not start.'));
    this.#streams.stderr('');

    if (isWireQuillError(error)) {
      for (const line of error.message.split('\n')) {
        this.#streams.stderr(line);
      }
      if (error.hint !== undefined) {
        this.#streams.stderr('');
        for (const line of error.hint.split('\n')) {
          this.#streams.stderr(pc.dim(line));
        }
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      this.#streams.stderr(sanitizeTerminalText(message, 500));
    }

    this.#streams.stderr('');
  }
}

/**
 * Column widths for the traffic log.
 *
 * Chosen so a default 80-column PowerShell window fits a whole line:
 * 1 marker + 7 method + 38 path + 3 status + 7 duration, plus four separators.
 */
const METHOD_COLUMN = 7;
const PATH_COLUMN = 38;
const DURATION_COLUMN = 7;

/**
 * One path, sanitised and fitted to its column.
 *
 * Sanitising first because the path came from a client; truncating second, in
 * the middle, so a long route keeps both the part that says where it is and the
 * part that says what it does (spec sections 16 and 47).
 */
function formatPathColumn(path: string): string {
  return truncatePathForDisplay(sanitizeTerminalText(path, 200), PATH_COLUMN).padEnd(PATH_COLUMN);
}

function defaultStreams(): OutputStreams {
  return {
    stdout: (line: string) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
  };
}
