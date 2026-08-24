import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load-config.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { WireQuillError } from '../../src/utils/errors.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'wirequill-config-'));
  // A .git marker makes project-root discovery deterministic regardless of
  // where the temp directory happens to live.
  mkdirSync(path.join(projectDir, '.git'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function writeConfigFile(contents: unknown): void {
  writeFileSync(
    path.join(projectDir, 'wirequill.config.json'),
    JSON.stringify(contents, null, 2),
    'utf8',
  );
}

function load(options: Parameters<typeof loadConfig>[0], env: NodeJS.ProcessEnv = {}) {
  return loadConfig(options, { cwd: projectDir, env });
}

describe('loadConfig', () => {
  it('applies defaults when only a target is given', () => {
    const config = load({ target: 'http://localhost:8080' });

    expect(config.proxy.host).toBe(DEFAULTS.proxyHost);
    expect(config.proxy.port).toBe(DEFAULTS.proxyPort);
    expect(config.docs.host).toBe('127.0.0.1');
    expect(config.docs.port).toBe(DEFAULTS.docsPort);
    expect(config.capture.maxBodyBytes).toBe(DEFAULTS.maxBodyBytes);
    expect(config.proxy.insecure).toBe(false);
    expect(config.docs.openBrowser).toBe(true);
  });

  it('puts the database under the project root by default', () => {
    const config = load({ target: 'http://localhost:8080' });
    expect(config.storage.databasePath).toBe(
      path.join(projectDir, '.wirequill', 'wirequill.sqlite'),
    );
  });

  it('requires a target', () => {
    expect(() => load({})).toThrowError(/No target specified/);
  });

  it('reads a target from the config file', () => {
    writeConfigFile({ target: 'http://localhost:9999' });
    expect(load({}).target.href).toBe('http://localhost:9999/');
  });

  it('lets the environment override the config file', () => {
    writeConfigFile({ target: 'http://localhost:9999' });
    const config = load({}, { WIREQUILL_TARGET: 'http://localhost:7777' });
    expect(config.target.href).toBe('http://localhost:7777/');
  });

  it('lets the CLI override the environment', () => {
    writeConfigFile({ target: 'http://localhost:9999' });
    const config = load(
      { target: 'http://localhost:5555' },
      { WIREQUILL_TARGET: 'http://localhost:7777' },
    );
    expect(config.target.href).toBe('http://localhost:5555/');
  });

  it('applies the full precedence chain to ports', () => {
    writeConfigFile({ target: 'http://localhost:8080', proxy: { port: 4000 } });

    expect(load({}).proxy.port).toBe(4000);
    expect(load({}, { WIREQUILL_PORT: '5000' }).proxy.port).toBe(5000);
    expect(load({ port: '6000' }, { WIREQUILL_PORT: '5000' }).proxy.port).toBe(6000);
  });

  it('accepts numeric port strings from the CLI', () => {
    const config = load({ target: 'http://localhost:8080', port: '3010' });
    expect(config.proxy.port).toBe(3010);
  });

  it.each(['0', '65536', 'abc', '3000.5', '-1'])('rejects invalid port %j', (port) => {
    expect(() => load({ target: 'http://localhost:8080', port })).toThrowError(WireQuillError);
  });

  it('rejects the proxy port and docs port being equal', () => {
    expect(() =>
      load({ target: 'http://localhost:8080', port: '3000', docsPort: '3000' }),
    ).toThrowError(/both 3000/);
  });

  it('rejects an unreadable --config path', () => {
    expect(() =>
      load({ target: 'http://localhost:8080', config: 'does-not-exist.json' }),
    ).toThrowError(/Config file not found/);
  });

  it('rejects malformed config JSON', () => {
    writeFileSync(path.join(projectDir, 'wirequill.config.json'), '{ not json', 'utf8');
    expect(() => load({ target: 'http://localhost:8080' })).toThrowError(/not valid JSON/);
  });

  it('rejects unknown config keys instead of ignoring them', () => {
    writeConfigFile({ target: 'http://localhost:8080', proxyPort: 3000 });
    expect(() => load({})).toThrowError(/not valid/);
  });

  it('rejects an out-of-range port in the config file', () => {
    writeConfigFile({ target: 'http://localhost:8080', proxy: { port: 70_000 } });
    expect(() => load({})).toThrowError(/not valid/);
  });

  it('normalises ignored methods to upper case', () => {
    writeConfigFile({ target: 'http://localhost:8080', capture: { ignoreMethods: ['options'] } });
    expect(load({}).capture.ignoreMethods).toEqual(['OPTIONS']);
  });

  it('resolves --db relative to the working directory', () => {
    const config = load({ target: 'http://localhost:8080', db: 'custom/wq.sqlite' });
    expect(config.storage.databasePath).toBe(path.join(projectDir, 'custom', 'wq.sqlite'));
  });

  it('records where the configuration came from', () => {
    writeConfigFile({ target: 'http://localhost:8080' });
    const config = load({});

    expect(config.sources.projectRoot).toBe(projectDir);
    expect(config.sources.configFilePath).toBe(path.join(projectDir, 'wirequill.config.json'));
    expect(config.sources.dataDirectory).toBe(path.join(projectDir, '.wirequill'));
  });

  it('does not create anything on disk', () => {
    load({ target: 'http://localhost:8080' });
    expect(() => rmSync(path.join(projectDir, '.wirequill'))).toThrowError();
  });

  it('keeps --insecure off unless asked', () => {
    expect(load({ target: 'http://localhost:8080' }).proxy.insecure).toBe(false);
    expect(load({ target: 'http://localhost:8080', insecure: true }).proxy.insecure).toBe(true);
  });

  it('lets the config file disable the browser', () => {
    writeConfigFile({ target: 'http://localhost:8080', docs: { openBrowser: false } });
    expect(load({}).docs.openBrowser).toBe(false);
  });

  it('lets --no-open override the config file', () => {
    writeConfigFile({ target: 'http://localhost:8080', docs: { openBrowser: true } });
    expect(load({ open: false }).docs.openBrowser).toBe(false);
  });
});
