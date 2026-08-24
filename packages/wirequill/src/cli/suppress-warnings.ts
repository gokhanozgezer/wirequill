/**
 * Hides the `node:sqlite` experimental warning.
 *
 * `node:sqlite` is stable enough for WireQuill's use but still prints an
 * ExperimentalWarning on every start. Node offers no per-module opt-out, so the
 * default warning listener is replaced with one that drops exactly this
 * warning and forwards everything else untouched.
 *
 * Imported first from the CLI entry point so it is installed before
 * `node:sqlite` is loaded.
 */

type WarningListener = (warning: Error) => void;

function isSqliteExperimentalWarning(warning: Error): boolean {
  return warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite');
}

export function suppressSqliteExperimentalWarning(): void {
  const existing = process.listeners('warning') as WarningListener[];
  process.removeAllListeners('warning');

  process.on('warning', (warning: Error) => {
    if (isSqliteExperimentalWarning(warning)) {
      return;
    }
    for (const listener of existing) {
      listener(warning);
    }
  });
}

suppressSqliteExperimentalWarning();
