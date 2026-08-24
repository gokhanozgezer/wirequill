/**
 * Opening the documentation in a browser (spec sections 20 to 24).
 *
 * A convenience, never a requirement. Everything below is arranged so that a
 * machine with no browser, no display or no permission to spawn anything at all
 * still runs WireQuill perfectly well and simply prints a URL.
 */

export type BrowserOpener = (url: string) => Promise<void>;

export interface BrowserDecisionInput {
  /** Resolved config: `--no-open` or `openBrowser: false` turns this off. */
  configured: boolean;
  /** Whether stdout is a terminal. False under a pipe, a service, a test. */
  isTty: boolean;
  env: NodeJS.ProcessEnv;
}

/**
 * Three conditions, all required (spec section 21).
 *
 * The TTY check is the one that matters most in practice: `wirequill ... | tee
 * log.txt` and a process supervisor both look identical to a real terminal
 * otherwise, and neither has anybody sitting in front of it.
 */
export function shouldOpenBrowser(input: BrowserDecisionInput): boolean {
  return input.configured && input.isTty && !isContinuousIntegration(input.env);
}

export function isContinuousIntegration(env: NodeJS.ProcessEnv): boolean {
  const explicit = env.CI;

  if (explicit !== undefined && explicit !== '' && explicit !== 'false' && explicit !== '0') {
    return true;
  }

  // Set even where `CI` is not, and cheap to check.
  return env.GITHUB_ACTIONS === 'true' || env.TF_BUILD === 'True';
}

/**
 * Hands the URL to the platform's default browser.
 *
 * `open` rather than a hand-written `start` / `xdg-open` / `open` switch: the
 * Windows path alone needs `cmd /c start ""` with a quoting rule that is easy
 * to get subtly wrong, and getting it wrong means passing a URL to a shell
 * (spec section 23).
 *
 * Imported lazily so that a run which never opens a browser — a test, a CI job,
 * `--no-open` — does not pay for loading it.
 */
export const openInBrowser: BrowserOpener = async (url: string): Promise<void> => {
  const { default: open } = await import('open');
  await open(url);
};
