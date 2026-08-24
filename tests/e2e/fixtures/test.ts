import { test as base, type Page } from '@playwright/test';
import { startWireQuill, type WireQuillProcess } from './wirequill.js';

/**
 * The shared end-to-end fixtures.
 *
 * `guards` is the important one. WireQuill's documentation page is built from
 * somebody's real API traffic, so the rule is not "few external requests" but
 * "none", and the way to enforce a rule like that is to make breaking it fail
 * rather than to remember to check (spec sections 102, 103 and 108).
 */

export interface PageGuards {
  /** Every URL the page asked for, in order. */
  requested: string[];
  /** Requests that left the loopback interface. Must stay empty. */
  external: string[];
  /** Native dialogs the page opened. An XSS payload that ran shows up here. */
  dialogs: string[];
  consoleErrors: string[];
  pageErrors: string[];
}

export interface E2EFixtures {
  wirequill: WireQuillProcess;
  guards: PageGuards;
}

export const test = base.extend<E2EFixtures>({
  // Playwright reads the destructuring pattern to work out what a fixture
  // depends on, so the empty one is required rather than stylistic.
  // eslint-disable-next-line no-empty-pattern
  wirequill: async ({}, use) => {
    const instance = await startWireQuill();

    try {
      await use(instance);
    } finally {
      await instance.stop();
    }
  },

  guards: async ({ page }, use) => {
    const guards = await installGuards(page);
    await use(guards);
  },
});

export { expect } from '@playwright/test';

/**
 * Records what the page does and blocks anything that leaves this machine.
 *
 * Blocking rather than only reporting is deliberate: a request that is merely
 * counted has already been sent (spec section 108).
 */
export async function installGuards(page: Page): Promise<PageGuards> {
  const guards: PageGuards = {
    requested: [],
    external: [],
    dialogs: [],
    consoleErrors: [],
    pageErrors: [],
  };

  await page.route('**/*', async (route) => {
    const url = route.request().url();
    guards.requested.push(url);

    if (isLocal(url)) {
      await route.continue();
      return;
    }

    guards.external.push(url);
    await route.abort('blockedbyclient');
  });

  page.on('dialog', (dialog) => {
    // A dialog blocks every subsequent command in the session, so it is
    // dismissed immediately and asserted on afterwards.
    guards.dialogs.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });

  page.on('console', (message) => {
    if (message.type() === 'error') {
      guards.consoleErrors.push(message.text());
    }
  });

  page.on('pageerror', (error) => {
    guards.pageErrors.push(error.message);
  });

  return guards;
}

/**
 * Whether a URL stays on this machine.
 *
 * `data:` and `blob:` are inlined content the page already has; neither reaches
 * the network (spec section 103).
 */
export function isLocal(url: string): boolean {
  if (
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url.startsWith('about:') ||
    url.startsWith('chrome-extension:')
  ) {
    return true;
  }

  try {
    const { hostname } = new URL(url);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}
