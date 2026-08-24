import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentTypeFor, FALLBACK_MIME_TYPE } from '../../src/docs-server/mime-types.js';
import { openApiEtag } from '../../src/docs-server/routes/openapi.js';
import { resolveDocsUiRoot, StaticUi } from '../../src/docs-server/static-ui.js';
import { isContinuousIntegration, shouldOpenBrowser } from '../../src/runtime/open-browser.js';

let assetRoot: string;

beforeEach(() => {
  assetRoot = mkdtempSync(path.join(os.tmpdir(), 'wirequill-assets-'));
  mkdirSync(path.join(assetRoot, 'assets'));
  writeFileSync(path.join(assetRoot, 'index.html'), '<!doctype html><title>WireQuill</title>');
  writeFileSync(path.join(assetRoot, 'assets', 'index-ABC123.js'), 'export default 1;');
  writeFileSync(path.join(assetRoot, 'assets', 'index-ABC123.css'), 'body{}');
});

afterEach(() => {
  rmSync(assetRoot, { recursive: true, force: true });
});

describe('static asset resolution', () => {
  it('serves the shell at the root', () => {
    const ui = new StaticUi({ root: assetRoot });
    expect(ui.resolve('/')).toBe(path.join(assetRoot, 'index.html'));
  });

  it('serves hashed assets', () => {
    const ui = new StaticUi({ root: assetRoot });

    expect(ui.resolve('/assets/index-ABC123.js')).toBe(
      path.join(assetRoot, 'assets', 'index-ABC123.js'),
    );
    expect(ui.resolve('/assets/index-ABC123.css')).toBe(
      path.join(assetRoot, 'assets', 'index-ABC123.css'),
    );
  });

  it('reports whether the bundle shipped', () => {
    expect(new StaticUi({ root: assetRoot }).isAvailable).toBe(true);
    expect(new StaticUi({ root: path.join(assetRoot, 'missing') }).isAvailable).toBe(false);
  });

  it('refuses to escape the asset root', () => {
    const ui = new StaticUi({ root: assetRoot });

    // The parent directory genuinely contains something worth not serving.
    writeFileSync(path.join(assetRoot, '..', 'wirequill-secret.txt'), 'TRAVERSAL_MARKER');

    try {
      expect(ui.resolve('/../wirequill-secret.txt')).toBeNull();
      expect(ui.resolve('/%2e%2e/wirequill-secret.txt')).toBeNull();
      expect(ui.resolve('/assets/../../wirequill-secret.txt')).toBeNull();
      // Percent-encoded backslash: a path separator on Windows, and the reason
      // a string prefix check is not enough (spec section 47).
      expect(ui.resolve('/..%5cwirequill-secret.txt')).toBeNull();
    } finally {
      rmSync(path.join(assetRoot, '..', 'wirequill-secret.txt'), { force: true });
    }
  });

  it('rejects malformed encoding and null bytes instead of repairing them', () => {
    const ui = new StaticUi({ root: assetRoot });

    expect(ui.resolve('/%E0%A4%A')).toBeNull();
    expect(ui.resolve('/index.html%00.png')).toBeNull();
  });

  it('does not serve a directory as a file', () => {
    const ui = new StaticUi({ root: assetRoot });
    expect(ui.resolve('/assets')).toBeNull();
  });

  it('returns null for a path that does not exist', () => {
    const ui = new StaticUi({ root: assetRoot });
    expect(ui.resolve('/does-not-exist.js')).toBeNull();
  });
});

describe('shipped asset location', () => {
  it('resolves inside the installed package, not the working directory', () => {
    const root = resolveDocsUiRoot();

    // WireQuill runs from inside somebody else's project, and under `npx` it
    // lives in a cache directory. `process.cwd()` is never the right answer
    // (spec sections 45 and 46).
    expect(root.endsWith(path.join('assets', 'docs-ui'))).toBe(true);

    const packageRoot = path.resolve(root, '..', '..');
    const manifest = path.join(packageRoot, 'package.json');

    expect(existsSync(manifest)).toBe(true);
    expect((JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name).toBe('wirequill');
    // The same answer whichever directory the process happens to be in.
    expect(resolveDocsUiRoot()).toBe(root);
  });
});

describe('content types', () => {
  it('covers what Vite emits', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor(path.join('assets', 'index-ABC.js'))).toBe(
      'text/javascript; charset=utf-8',
    );
    expect(contentTypeFor('style.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('doc.json')).toBe('application/json; charset=utf-8');
    expect(contentTypeFor('logo.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('logo.png')).toBe('image/png');
    expect(contentTypeFor('favicon.ico')).toBe('image/x-icon');
  });

  it('falls back to a byte stream for anything unknown', () => {
    // Downloaded rather than executed, which is the safe way to be wrong.
    expect(contentTypeFor('archive.tar.zst')).toBe(FALLBACK_MIME_TYPE);
  });

  it('ignores extension casing', () => {
    expect(contentTypeFor('INDEX.HTML')).toBe('text/html; charset=utf-8');
  });
});

describe('openapi validator', () => {
  it('is weak and derived from the revision', () => {
    expect(openApiEtag(0)).toBe('W/"wirequill-0"');
    expect(openApiEtag(12)).toBe('W/"wirequill-12"');
    expect(openApiEtag(12)).toBe(openApiEtag(12));
    expect(openApiEtag(12)).not.toBe(openApiEtag(13));
  });
});

describe('browser auto-open decision', () => {
  it('opens for a developer at a terminal', () => {
    expect(shouldOpenBrowser({ configured: true, isTty: true, env: {} })).toBe(true);
  });

  it('never opens when --no-open was given', () => {
    expect(shouldOpenBrowser({ configured: false, isTty: true, env: {} })).toBe(false);
  });

  it('never opens without a terminal', () => {
    // A pipe, a service manager, a test runner: nobody is watching.
    expect(shouldOpenBrowser({ configured: true, isTty: false, env: {} })).toBe(false);
  });

  it('never opens in continuous integration', () => {
    expect(shouldOpenBrowser({ configured: true, isTty: true, env: { CI: 'true' } })).toBe(false);
    expect(
      shouldOpenBrowser({ configured: true, isTty: true, env: { GITHUB_ACTIONS: 'true' } }),
    ).toBe(false);
  });

  it('treats an explicitly falsy CI value as not CI', () => {
    expect(isContinuousIntegration({ CI: 'false' })).toBe(false);
    expect(isContinuousIntegration({ CI: '0' })).toBe(false);
    expect(isContinuousIntegration({ CI: '' })).toBe(false);
    expect(isContinuousIntegration({})).toBe(false);
    expect(isContinuousIntegration({ CI: '1' })).toBe(true);
  });
});
