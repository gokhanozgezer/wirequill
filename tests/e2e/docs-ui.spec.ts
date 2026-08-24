import { readFileSync } from 'node:fs';
import { Validator } from '@seriousme/openapi-schema-validator';
import type { Page } from '@playwright/test';
import { startBackend } from './fixtures/backend.js';
import { expect, test } from './fixtures/test.js';
import {
  createProjectDir,
  getJson,
  removeProjectDir,
  startWireQuill,
  waitFor,
} from './fixtures/wirequill.js';

/**
 * The promise this milestone makes, checked in a real browser
 * (spec sections 156 to 171 and 211).
 *
 *     Run WireQuill → open docs → 0 endpoints → use the app → docs appear live
 *
 * Every test here starts a real WireQuill process serving the built interface,
 * so nothing is stubbed and nothing is mocked. The page under test is the page
 * a user gets.
 */

const COUNT = '[data-testid="endpoint-count"]';
const BADGE = '[data-testid="live-badge"]';
const EMPTY = '[data-testid="empty-state"]';
const REFERENCE = '[data-testid="api-reference"]';
const TOAST = '[data-testid="discovery-toast"]';
const MARK = '[data-testid="wirequill-mark"]';

test('starts empty and says where to point the application', async ({
  page,
  wirequill,
  guards,
}) => {
  await page.goto(wirequill.docsUrl);

  // The whole product, on one screen, before a single request has been made.
  await expect(page).toHaveTitle(/WireQuill/);
  await expect(page.locator(MARK)).toBeVisible();
  await expect(page.getByText('WireQuill', { exact: true }).first()).toBeVisible();

  await expect(page.locator(COUNT)).toHaveText('0 endpoints discovered');
  await expect(page.locator(EMPTY)).toBeVisible();
  await expect(page.locator(EMPTY)).toContainText('Your API docs will appear here.');
  await expect(page.locator(EMPTY)).toContainText('Use your application normally.');
  // The one instruction that matters, and the address it refers to.
  await expect(page.locator(EMPTY)).toContainText('Point your app to');
  await expect(page.locator(EMPTY)).toContainText(wirequill.proxyUrl);
  await expect(page.locator(EMPTY)).toContainText(wirequill.backend.origin);

  // Not a tutorial (spec section 30).
  await expect(page.locator(EMPTY)).not.toContainText('Step 1');

  // The stream is open before any traffic exists.
  await expect(page.locator(BADGE)).toHaveAttribute('data-state', 'live');
  await expect(page.locator(BADGE)).toContainText('Live');

  // The download is a real link, reachable by keyboard.
  await expect(page.locator('[data-testid="download-openapi"]')).toHaveAttribute(
    'href',
    '/openapi.json',
  );

  expect(guards.external).toEqual([]);
});

test('serves its own mark and favicon, from itself', async ({ page, wirequill, guards }) => {
  await page.goto(wirequill.docsUrl);
  await expect(page.locator(MARK)).toBeVisible();

  // The brand costs no request: the mark is inline SVG, and the favicon comes
  // from the package (spec sections 21, 23 and 36).
  const favicon = await page.evaluate(
    () => document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? '',
  );

  expect(favicon).toContain('favicon.svg');
  expect(favicon.startsWith('http')).toBe(false);

  const response = await page.request.get(new URL(favicon, `${wirequill.docsUrl}/`).toString());

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/svg+xml');
  expect(guards.external).toEqual([]);
});

test('fills in as the application is used, without reloading the page', async ({
  page,
  wirequill,
  guards,
}) => {
  await page.goto(wirequill.docsUrl);
  await expect(page.locator(COUNT)).toHaveText('0 endpoints discovered');

  const navigationsBefore = await navigationCount(page);

  await wirequill.call('/products/1');
  await expect(page.locator(COUNT)).toHaveText('1 endpoint discovered');
  await expect(page.locator(REFERENCE)).toBeVisible();
  await expect(page.locator(REFERENCE)).toContainText('/products/{productId}');

  await wirequill.call('/auth/login', {
    method: 'POST',
    body: { email: 'e2e@example.com', password: 'E2E_PASSWORD_SECRET' },
  });
  await wirequill.call('/products');
  await wirequill.call('/checkout', { method: 'POST', body: { total: 12.5 } });

  await expect(page.locator(COUNT)).toHaveText('4 endpoints discovered');

  for (const path of ['/auth/login', '/products', '/products/{productId}', '/checkout']) {
    await expect(page.locator(REFERENCE)).toContainText(path);
  }

  // The whole point of the milestone: none of that was a page load
  // (spec section 158).
  expect(await navigationCount(page)).toBe(navigationsBefore);
  expect(guards.external).toEqual([]);
});

test('shows a status nobody had seen before, without a refresh', async ({ page, wirequill }) => {
  await page.goto(wirequill.docsUrl);
  await expect(page.locator(COUNT)).toHaveText('0 endpoints discovered');

  await wirequill.call('/items/1');
  await expect(page.locator(REFERENCE)).toContainText('/items/{itemId}');
  await expect(page.getByRole('button', { name: /^200/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^404/ })).toHaveCount(0);

  const navigationsBefore = await navigationCount(page);

  // The same endpoint answers 404 for the first time (spec section 161).
  await wirequill.call('/items/404');

  await expect(page.getByRole('button', { name: /^404/ })).toBeVisible({ timeout: 15_000 });
  expect(await navigationCount(page)).toBe(navigationsBefore);
});

test('shows a new body field without a refresh', async ({ page, wirequill }) => {
  await page.goto(wirequill.docsUrl);
  await expect(page.locator(COUNT)).toHaveText('0 endpoints discovered');

  await wirequill.call('/checkout', { method: 'POST', body: { total: 1 } });
  await expect(page.locator(REFERENCE)).toContainText('/checkout');
  await expect(page.locator(REFERENCE)).toContainText('total');
  await expect(page.locator(REFERENCE)).not.toContainText('currency');

  const navigationsBefore = await navigationCount(page);

  // The same endpoint starts being called with another field (spec section 160).
  await wirequill.call('/checkout', { method: 'POST', body: { total: 2, currency: 'EUR' } });

  await expect(page.locator(REFERENCE)).toContainText('currency', { timeout: 15_000 });
  expect(await navigationCount(page)).toBe(navigationsBefore);
});

test('learns a new response field and serves it', async ({ page, wirequill }) => {
  await page.goto(wirequill.docsUrl);

  await wirequill.call('/items/1');
  await expect(page.locator(REFERENCE)).toContainText('/items/{itemId}');

  const before = await getJson<Record<string, unknown>>(`${wirequill.docsUrl}/openapi.json`);
  expect(JSON.stringify(before)).not.toContain('archived');

  // The same endpoint starts returning another field. Scalar's modern layout
  // shows a response example rather than an inline response schema, so the
  // assertion is on the contract the page is rendering — which the status test
  // above proves is being refreshed live (spec section 160).
  wirequill.backend.setItemsVariant('extended');
  await wirequill.call('/items/2');

  await waitFor(async () => {
    const document = await getJson<Record<string, unknown>>(`${wirequill.docsUrl}/openapi.json`);
    return JSON.stringify(document).includes('archived');
  }, 15_000);
});

test('announces a new endpoint once, and only once', async ({ page, wirequill }) => {
  await page.goto(wirequill.docsUrl);
  await expect(page.locator(COUNT)).toHaveText('0 endpoints discovered');

  await wirequill.call('/checkout', { method: 'POST', body: { total: 1 } });

  const toast = page.locator(TOAST).first();
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Discovered');
  // A method chip and the template, not a sentence (spec section 32).
  await expect(toast).toContainText('POST');
  await expect(toast).toContainText('/checkout');
  await expect(page.locator('[data-testid="discovery-toasts"]')).toHaveAttribute(
    'aria-live',
    'polite',
  );

  await expect(page.locator(TOAST)).toHaveCount(0, { timeout: 15_000 });

  // The same endpoint again is not a discovery (spec section 162).
  await wirequill.call('/checkout', { method: 'POST', body: { total: 2 } });
  await page.waitForTimeout(1_500);

  await expect(page.locator(TOAST)).toHaveCount(0);
});

test('talks to nothing but WireQuill', async ({ page, wirequill, guards }) => {
  await wirequill.call('/auth/login', {
    method: 'POST',
    body: { email: 'e2e@example.com', password: 'E2E_PASSWORD_SECRET' },
  });
  await wirequill.call('/products');
  await wirequill.call('/products/1');
  await wirequill.waitForOperations(3);

  await page.goto(wirequill.docsUrl);
  await expect(page.locator(REFERENCE)).toBeVisible();

  // Let anything lazy — fonts, an assistant bundle, a telemetry beacon — have
  // its chance to fire.
  await page.waitForTimeout(2_000);

  expect(guards.external, 'the documentation page must not leave this machine').toEqual([]);
  expect(guards.requested.length).toBeGreaterThan(0);

  const hosts = new Set(guards.requested.filter((url) => url.startsWith('http')).map(hostOf));
  expect([...hosts]).toEqual(['127.0.0.1']);

  // Named explicitly, because these are the ones Scalar reaches for by default
  // (spec sections 165, 166 and 167).
  for (const forbidden of [
    'scalar.com',
    'fonts.scalar.com',
    'registry.scalar.com',
    'googleapis.com',
    'gstatic.com',
    'jsdelivr.net',
    'unpkg.com',
  ]) {
    expect(guards.requested.join(' ')).not.toContain(forbidden);
  }

  // Try It is off, so the browser never touches the target API either
  // (spec sections 14 and 185).
  expect(guards.requested.join(' ')).not.toContain(hostPortOf(wirequill.backend.origin));
});

test('offers no assistant, no client and no way to send a request', async ({ page, wirequill }) => {
  await wirequill.call('/products');
  await wirequill.waitForOperations(1);

  await page.goto(wirequill.docsUrl);
  await expect(page.locator(REFERENCE)).toBeVisible();
  await page.waitForTimeout(1_000);

  // Nothing an assistant would be reached through, anywhere in the document
  // (spec sections 9 and 104).
  for (const forbidden of ['Ask AI', 'Scalar Agent', 'Generate MCP']) {
    await expect(page.getByText(forbidden, { exact: false })).toHaveCount(0);
  }

  // The request client is a different matter: Scalar keeps its modal in the
  // document and hides it. What must not exist is a control that opens it, so
  // the assertion is about what a user can reach, not about what is in the DOM
  // (spec sections 13, 105, 106 and 185).
  const reachable = await page.evaluate(() =>
    [...document.querySelectorAll('button, a, [role="button"]')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none'
        );
      })
      .map((element) => (element.textContent ?? '').trim())
      .filter((text) => /test request|send request|send get|open client|try it/i.test(text)),
  );

  expect(reachable).toEqual([]);
});

test('renders a hostile example as text', async ({ page, wirequill, guards }) => {
  await wirequill.call('/comments');
  await wirequill.waitForOperations(1);

  await page.goto(wirequill.docsUrl);
  await expect(page.locator(REFERENCE)).toBeVisible();
  await page.waitForTimeout(1_500);

  // React and Scalar both escape it; what matters is that nothing executed
  // (spec sections 109 and 168).
  expect(guards.dialogs).toEqual([]);
  expect(await page.locator('img[onerror]').count()).toBe(0);
  expect(guards.pageErrors).toEqual([]);
});

test('downloads a valid, secret-free document', async ({ page, wirequill }) => {
  await wirequill.call('/auth/login', {
    method: 'POST',
    body: { email: 'e2e@example.com', password: 'E2E_PASSWORD_SECRET' },
  });
  await wirequill.call('/products');
  await wirequill.waitForOperations(2);

  await page.goto(wirequill.docsUrl);
  await expect(page.locator(REFERENCE)).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="download-openapi"]').click(),
  ]);

  expect(download.suggestedFilename()).toBe('openapi.json');

  const file = await download.path();
  expect(file).not.toBeNull();

  const contents = readFileSync(String(file), 'utf8');
  const document = JSON.parse(contents) as Record<string, unknown>;
  const { valid, errors } = await new Validator().validate(document);

  expect(errors ?? []).toEqual([]);
  expect(valid).toBe(true);
  expect(document.openapi).toBe('3.1.0');

  for (const marker of ['E2E_PASSWORD_SECRET', 'E2E_TOKEN_SECRET', 'e2e@example.com']) {
    expect(contents, `the downloaded document must not contain ${marker}`).not.toContain(marker);
  }
});

test('shows documentation from an earlier run before any new traffic', async ({ page }) => {
  // Owned by the test, so neither run tears them down: the second run has to
  // find what the first one wrote (spec sections 122 and 170).
  const backend = await startBackend();
  const projectDir = createProjectDir();

  try {
    const first = await startWireQuill({ backend, projectDir });

    await first.call('/products');
    await first.call('/products/1');
    await first.call('/checkout', { method: 'POST', body: { total: 3 } });
    await first.waitForOperations(3);

    const before = await getJson<Record<string, unknown>>(`${first.docsUrl}/openapi.json`);
    await first.stop();

    const second = await startWireQuill({ backend, projectDir });

    try {
      await page.goto(second.docsUrl);

      await expect(page.locator(COUNT)).toHaveText('3 endpoints discovered');
      await expect(page.locator(REFERENCE)).toContainText('/products/{productId}');
      // Never a flash of the empty state on the way there (spec section 123).
      await expect(page.locator(EMPTY)).toHaveCount(0);

      const after = await getJson<Record<string, unknown>>(`${second.docsUrl}/openapi.json`);
      expect(after).toEqual(before);
    } finally {
      await second.stop();
    }
  } finally {
    await backend.close();
    removeProjectDir(projectDir);
  }
});

test('works on a docs port the user chose', async ({ page, guards }) => {
  const port = 3456;
  const instance = await startWireQuill({ docsPort: port });

  try {
    expect(instance.docsUrl).toBe(`http://127.0.0.1:${String(port)}`);

    await page.goto(instance.docsUrl);
    await expect(page.locator(COUNT)).toHaveText('0 endpoints discovered');

    // Every fetch and the event stream are relative, so a non-default port
    // simply works (spec sections 112 to 114 and 171).
    await instance.call('/products');
    await expect(page.locator(COUNT)).toHaveText('1 endpoint discovered');
    await expect(page.locator(BADGE)).toHaveAttribute('data-state', 'live');

    expect(guards.external).toEqual([]);
  } finally {
    await instance.stop();
  }
});

test('reports the connection honestly when the server goes away', async ({ page }) => {
  const instance = await startWireQuill();

  await page.goto(instance.docsUrl);
  await expect(page.locator(BADGE)).toHaveAttribute('data-state', 'live');

  await instance.stop();

  // Not "Live" while there is nothing to be live with (spec section 76).
  await expect(page.locator(BADGE)).toHaveAttribute('data-state', 'reconnecting', {
    timeout: 15_000,
  });
  await expect(page.locator(BADGE)).toContainText('Reconnecting');
});

test('renders a large document', async ({ page, wirequill, guards }) => {
  test.setTimeout(120_000);

  await page.goto(wirequill.docsUrl);
  await expect(page.locator(COUNT)).toHaveText('0 endpoints discovered');

  // A synthetic API with more endpoints than most real ones. There is no
  // performance budget here — the question is only whether the interface stays
  // upright (spec section 179).
  const endpoints = 120;

  for (let index = 0; index < endpoints; index += 1) {
    await wirequill.call(`/resource-${String(index)}`);
  }

  await wirequill.waitForOperations(endpoints, 60_000);

  await expect(page.locator(COUNT)).toHaveText(`${String(endpoints)} endpoints discovered`, {
    timeout: 60_000,
  });
  await expect(page.locator(REFERENCE)).toBeVisible();
  await expect(page.locator(REFERENCE)).toContainText('/resource-0');

  expect(guards.pageErrors).toEqual([]);
  expect(guards.external).toEqual([]);
});

test('logs no unexpected browser errors', async ({ page, wirequill, guards }) => {
  await wirequill.call('/products');
  await wirequill.call('/products/1');
  await wirequill.waitForOperations(2);

  await page.goto(wirequill.docsUrl);
  await expect(page.locator(REFERENCE)).toBeVisible();
  await page.waitForTimeout(2_000);

  expect(guards.pageErrors).toEqual([]);
  expect(guards.consoleErrors).toEqual([]);
});

async function navigationCount(page: Page): Promise<number> {
  return page.evaluate(() => performance.getEntriesByType('navigation').length);
}

function hostOf(url: string): string {
  return new URL(url).hostname;
}

function hostPortOf(origin: string): string {
  return new URL(origin).host;
}
