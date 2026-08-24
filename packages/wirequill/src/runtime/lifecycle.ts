/**
 * Signal handling (spec section 13).
 *
 * The first SIGINT starts a graceful shutdown; a second one exits immediately,
 * because a developer hammering Ctrl+C wants the process gone, not a longer
 * explanation. Windows also delivers SIGBREAK for Ctrl+Break, so it is wired to
 * the same path.
 */

export type ShutdownSignal = 'SIGINT' | 'SIGTERM' | 'SIGBREAK';

export interface SignalHandlerOptions {
  onShutdown: (signal: ShutdownSignal) => Promise<void> | void;
  /** Called when a second signal arrives while the first shutdown is still running. */
  onForceExit?: (signal: ShutdownSignal) => void;
  exit?: (code: number) => never;
}

export interface SignalHandlerHandle {
  /** Removes the listeners. Safe to call more than once. */
  dispose(): void;
}

/** Exit code convention for "terminated by SIGINT" (128 + 2). */
export const SIGINT_EXIT_CODE = 130;

export function installSignalHandlers(options: SignalHandlerOptions): SignalHandlerHandle {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const signals: ShutdownSignal[] = ['SIGINT', 'SIGTERM'];

  if (process.platform === 'win32') {
    signals.push('SIGBREAK');
  }

  let shuttingDown = false;
  let disposed = false;

  const listeners = new Map<ShutdownSignal, () => void>();

  const handle = (signal: ShutdownSignal): void => {
    if (shuttingDown) {
      options.onForceExit?.(signal);
      exit(SIGINT_EXIT_CODE);
      return;
    }

    shuttingDown = true;
    void Promise.resolve(options.onShutdown(signal));
  };

  for (const signal of signals) {
    const listener = (): void => {
      handle(signal);
    };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }

  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const [signal, listener] of listeners) {
        process.off(signal, listener);
      }
      listeners.clear();
    },
  };
}
