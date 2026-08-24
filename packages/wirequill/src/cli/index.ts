import { Command, CommanderError } from 'commander';
import { loadConfig, type CliOptions } from '../config/load-config.js';
import { installSignalHandlers, type SignalHandlerHandle } from '../runtime/lifecycle.js';
import type { BrowserOpener } from '../runtime/open-browser.js';
import { WireQuillRuntime } from '../runtime/wirequill-runtime.js';
import { isWireQuillError } from '../utils/errors.js';
import { WIREQUILL_VERSION } from '../version.js';
import { Output } from './output.js';

export interface RunCliOptions {
  output?: Output;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests set this to false so `runCli` returns instead of waiting for a signal. */
  waitForSignal?: boolean;
  /** Injected by tests, so a test run never launches a real browser. */
  openBrowser?: BrowserOpener | undefined;
  /** Injected by tests. Production reads the real terminal. */
  isTty?: boolean | undefined;
}

const DESCRIPTION = 'Turn real API traffic into live API documentation.';

export function createProgram(output: Output): Command {
  const program = new Command();

  program
    .name('wirequill')
    .description(DESCRIPTION)
    .version(WIREQUILL_VERSION, '-v, --version', 'Print the WireQuill version')
    .option('--target <url>', 'Upstream backend URL, for example http://localhost:8080')
    .option('--port <number>', 'Proxy port (default: 3000)')
    .option('--docs-port <number>', 'Documentation server port (default: 3001)')
    .option('--host <host>', 'Proxy host (default: 127.0.0.1)')
    .option('--config <path>', 'Path to wirequill.config.json')
    .option('--db <path>', 'SQLite database path')
    .option('--max-body <bytes>', 'Per-body capture limit in bytes')
    .option('--insecure', 'Disable TLS certificate verification for the target')
    .option('--no-open', 'Do not open the documentation in a browser')
    .option('--verbose', 'Print diagnostic metadata (never bodies or secrets)')
    .addHelpText(
      'after',
      [
        '',
        'Example:',
        '  wirequill --target http://localhost:8080',
        '',
        'WireQuill keeps every observation on this machine. Nothing is uploaded.',
      ].join('\n'),
    );

  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => {
      output.line(trimTrailingNewline(text));
    },
    writeErr: (text) => {
      output.line(trimTrailingNewline(text));
    },
  });

  return program;
}

/**
 * CLI entry point.
 *
 * Returns an exit code rather than calling `process.exit`, so the whole command
 * can be driven from a test without tearing down the test runner.
 */
export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const output = options.output ?? new Output();
  const program = createProgram(output);

  try {
    program.parse(argv);
  } catch (error) {
    // `--help` and `--version` are reported as errors by exitOverride even
    // though they are successful outcomes.
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    throw error;
  }

  const parsed = program.opts();
  const cliOptions: CliOptions = {
    target: asOptionalString(parsed.target),
    port: asOptionalString(parsed.port),
    docsPort: asOptionalString(parsed.docsPort),
    host: asOptionalString(parsed.host),
    config: asOptionalString(parsed.config),
    db: asOptionalString(parsed.db),
    maxBody: asOptionalString(parsed.maxBody),
    insecure: asOptionalBoolean(parsed.insecure),
    // `--no-open` gives commander a default of `true`, which would silently
    // override the config file. Only an explicit flag counts.
    open:
      program.getOptionValueSource('open') === 'cli' ? asOptionalBoolean(parsed.open) : undefined,
    verbose: asOptionalBoolean(parsed.verbose),
  };

  try {
    const config = loadConfig(cliOptions, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });

    const runtime = new WireQuillRuntime({
      config,
      output,
      // The browser decision reads the real environment unless a caller says
      // otherwise; `options.env` exists so a test can describe a machine it is
      // not running on.
      env: options.env ?? process.env,
      ...(options.isTty === undefined ? {} : { isTty: options.isTty }),
      ...(options.openBrowser === undefined ? {} : { openBrowser: options.openBrowser }),
    });

    await runtime.start();

    if (options.waitForSignal === false) {
      await runtime.stop();
      return 0;
    }

    await waitForShutdown(runtime, output);
    return 0;
  } catch (error) {
    output.failure(error);
    return isWireQuillError(error) ? 1 : 70;
  }
}

function waitForShutdown(runtime: WireQuillRuntime, output: Output): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handle: SignalHandlerHandle = installSignalHandlers({
      onShutdown: () => {
        void (async () => {
          try {
            await runtime.stop();
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          } finally {
            handle.dispose();
          }
        })();
      },
      onForceExit: () => {
        output.warn('Second interrupt received. Exiting immediately.');
      },
    });
  });
}

function trimTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
