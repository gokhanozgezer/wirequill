import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installSignalHandlers,
  SIGINT_EXIT_CODE,
  type SignalHandlerHandle,
} from '../../src/runtime/lifecycle.js';

const handles: SignalHandlerHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.dispose();
  }
});

function install(options: Parameters<typeof installSignalHandlers>[0]): SignalHandlerHandle {
  const handle = installSignalHandlers(options);
  handles.push(handle);
  return handle;
}

/**
 * Invokes only the listener installed last, rather than `process.emit`, so the
 * test never triggers the test runner's own signal handling.
 */
function fire(signal: NodeJS.Signals): void {
  const listener = process.listeners(signal).at(-1);
  expect(listener).toBeDefined();
  listener?.(signal);
}

/** `process.exit` never returns; the tests need a stub that does. */
const noopExit = (() => undefined) as unknown as (code: number) => never;

describe('installSignalHandlers', () => {
  it('runs the shutdown callback on SIGINT', async () => {
    const onShutdown = vi.fn();
    install({ onShutdown, exit: noopExit });

    fire('SIGINT');
    await Promise.resolve();

    expect(onShutdown).toHaveBeenCalledOnce();
    expect(onShutdown).toHaveBeenCalledWith('SIGINT');
  });

  it('runs the shutdown callback on SIGTERM', async () => {
    const onShutdown = vi.fn();
    install({ onShutdown, exit: noopExit });

    fire('SIGTERM');
    await Promise.resolve();

    expect(onShutdown).toHaveBeenCalledWith('SIGTERM');
  });

  it('forces an exit on the second signal instead of shutting down twice', async () => {
    const onShutdown = vi.fn();
    const onForceExit = vi.fn();
    const exit = vi.fn() as unknown as (code: number) => never;

    install({ onShutdown, onForceExit, exit });

    fire('SIGINT');
    fire('SIGINT');
    await Promise.resolve();

    expect(onShutdown).toHaveBeenCalledOnce();
    expect(onForceExit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(SIGINT_EXIT_CODE);
  });

  it('stops listening after dispose', () => {
    const onShutdown = vi.fn();
    const before = process.listenerCount('SIGINT');

    const handle = install({ onShutdown, exit: noopExit });
    expect(process.listenerCount('SIGINT')).toBe(before + 1);

    handle.dispose();
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('tolerates dispose being called twice', () => {
    const handle = install({ onShutdown: () => undefined, exit: noopExit });

    handle.dispose();
    expect(() => handle.dispose()).not.toThrow();
  });

  it('registers SIGBREAK only on Windows', () => {
    const before = process.listenerCount('SIGBREAK');
    install({ onShutdown: () => undefined, exit: noopExit });

    const expected = process.platform === 'win32' ? before + 1 : before;
    expect(process.listenerCount('SIGBREAK')).toBe(expected);
  });
});
