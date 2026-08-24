import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration (spec sections 156 to 171).
 *
 * Every test starts its own WireQuill process on its own ports, so there is no
 * `webServer` here and no shared state between tests. That costs a second per
 * test and buys the ability to test a restart, a custom port and a server that
 * goes away — none of which work against a server the runner owns.
 */
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './tests/e2e/.output',

  // Each test binds real ports and writes a real database. Running them in
  // parallel would mostly work, which is the worst kind of test suite.
  fullyParallel: false,
  workers: 1,

  // The interface is event-driven; a retry would hide a race rather than
  // reveal it.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: process.env.CI === undefined ? [['list']] : [['github'], ['list']],

  use: {
    headless: true,
    // Nothing here talks to the network, so there is nothing to be slow.
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
