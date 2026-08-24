/**
 * Installs the real npm artifact and runs it (spec sections 11 to 13, 88 to 91).
 *
 *   node scripts/package-smoke.mjs
 *
 * A workspace symlink is not a distribution. It resolves imports the published
 * package cannot, it carries files `npm pack` would leave out, and it hides
 * every mistake in `files`, `bin` and asset resolution. This packs a tarball,
 * installs it into a throwaway project outside the repository, and drives the
 * installed binary.
 *
 * Node APIs only, so it behaves the same in PowerShell, cmd and any POSIX
 * shell. Requires `pnpm build` to have run first.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(repoRoot, 'packages', 'wirequill');
const isWindows = process.platform === 'win32';

const failures = [];

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`);
  if (!ok) {
    failures.push(label);
  }
}

/** npm and pnpm are shell shims on Windows; the executable name differs. */
function commandName(name) {
  return isWindows ? `${name}.cmd` : name;
}

/**
 * Spawns an executable, including a Windows `.cmd` shim.
 *
 * Node refuses to spawn a `.cmd` directly (EINVAL) unless a shell is involved,
 * because a batch file is interpreted rather than executed. `shell: true` would
 * work and would also hand a joined command line to cmd.exe, which is where
 * quoting bugs live — and every path here can contain a space. So cmd.exe is
 * invoked explicitly, with each argument quoted once, deliberately
 * (spec sections 59 and 60).
 */
function spawnAny(file, args, options = {}) {
  if (isWindows && /\.(cmd|bat)$/i.test(file)) {
    // The outer quotes matter: with `/s`, cmd.exe strips the first and last
    // quote of the whole command line and takes the rest literally. Without
    // them it would strip the ones around the executable path instead, and a
    // path with a space would be cut in half at the space.
    const line = `"${[file, ...args].map(quoteForCmd).join(' ')}"`;

    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }

  return spawn(file, args, { ...options, shell: false });
}

function quoteForCmd(value) {
  return /[\s"^&|<>()%!]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnAny(commandName(command), args, {
      cwd: options.cwd ?? repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_update_notifier: 'false' },
    });

    const out = [];
    child.stdout.on('data', (chunk) => out.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => out.push(chunk.toString('utf8')));

    child.on('error', reject);
    child.on('exit', (code) => {
      const output = out.join('');
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited ${String(code)}\n${output}`));
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    request.on('error', reject);
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Writes a consumer manifest.
 *
 * `npm init -y` derives the name from the directory, and npm rejects a package
 * name that is not ASCII — which one of these directories deliberately is. The
 * consumer's own name is irrelevant to what is being tested, so it is simply
 * written rather than derived.
 */
function writeConsumerManifest(directory) {
  writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ name: 'wirequill-consumer', version: '1.0.0', private: true }, null, 2)}\n`,
    'utf8',
  );
}

/** A backend to point the installed WireQuill at. */
function startBackend() {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const body = Buffer.from(JSON.stringify({ id: 1, name: 'Ada' }), 'utf8');
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': body.byteLength,
      });
      response.end(body);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${String(server.address().port)}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      });
    });
  });
}

/**
 * Stops a spawned process and everything it started.
 *
 * On Windows the `.cmd` shim runs under cmd.exe, so the Node process doing the
 * actual work is a grandchild: killing the child leaves it running, holding the
 * database open and the ports bound. `taskkill /pid <pid> /t` ends that one
 * tree and nothing else — never a name-based kill, which would take out every
 * other Node process on the machine (spec sections 57 and 58).
 */
function killTree(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    child.once('exit', resolve);
    setTimeout(resolve, 8_000).unref();

    if (isWindows && child.pid !== undefined) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        shell: false,
      });
      killer.on('error', () => child.kill());
      return;
    }

    child.kill();
  });
}

/** Runs a binary and returns whatever it printed, regardless of exit code. */
function capture(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawnAny(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];

    child.stdout.on('data', (chunk) => out.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => out.push(chunk.toString('utf8')));
    child.on('error', reject);
    child.on('exit', () => resolve(out.join('')));
  });
}

// ---------------------------------------------------------------------- main

const workDir = mkdtempSync(path.join(os.tmpdir(), 'wirequill-pkg-'));
// A space in the path, because that is where Windows quoting bugs live.
const projectDir = path.join(workDir, 'Consumer Project');
mkdirSync(projectDir);

// And a second consumer whose directory name is not ASCII. Created here rather
// than by a shell, because a shell literal is exactly where the encoding gets
// lost (spec sections 9 and 134).
const unicodeProjectDir = path.join(workDir, 'WireQuill Türkçe Proje');
mkdirSync(unicodeProjectDir);

let backend = null;
let cli = null;

try {
  console.log(`work directory: ${workDir}`);
  console.log('');

  // 1. Pack the real artifact.
  const packOutput = await run('npm', ['pack', '--pack-destination', workDir], {
    cwd: packageRoot,
  });
  const tarball = path.join(workDir, packOutput.trim().split(/\r?\n/).at(-1).trim());

  check('npm pack produced a tarball', existsSync(tarball), path.basename(tarball));

  // 2. Install it into a project that knows nothing about this repository.
  writeConsumerManifest(projectDir);
  const installOutput = await run('npm', ['install', tarball], { cwd: projectDir });

  check(
    'install needs no compiler',
    !/node-gyp|gyp ERR|prebuild-install|Visual Studio|python/i.test(installOutput),
  );

  const installed = path.join(projectDir, 'node_modules', 'wirequill');
  check('package installed', existsSync(installed));

  // 3. What the artifact contains.
  const manifest = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));

  check('license is Apache-2.0', manifest.license === 'Apache-2.0', manifest.license);
  check('LICENSE shipped', existsSync(path.join(installed, 'LICENSE')));
  check('NOTICE shipped', existsSync(path.join(installed, 'NOTICE')));
  check(
    'LICENSE is the Apache text',
    readFileSync(path.join(installed, 'LICENSE'), 'utf8').includes('Apache License'),
  );
  check(
    'documentation interface shipped',
    existsSync(path.join(installed, 'assets', 'docs-ui', 'index.html')),
  );
  check('no sources shipped', !existsSync(path.join(installed, 'src')));
  check('no tests shipped', !existsSync(path.join(installed, 'test')));
  check('no database shipped', !existsSync(path.join(installed, '.wirequill')));

  // 4. The binary npm created for this platform.
  const binary = path.join(
    projectDir,
    'node_modules',
    '.bin',
    isWindows ? 'wirequill.cmd' : 'wirequill',
  );
  check('binary shim created', existsSync(binary));

  const version = await capture(binary, ['--version'], projectDir);
  const help = await capture(binary, ['--help'], projectDir);

  check('--version answers', version.trim().length > 0, version.trim());
  check('--help answers', help.includes('Usage: wirequill'));

  // 5. Run it.
  backend = await startBackend();
  const proxyPort = await freePort();
  const docsPort = await freePort();
  const docsOrigin = `http://127.0.0.1:${String(docsPort)}`;

  cli = spawnAny(
    binary,
    [
      '--target',
      backend.origin,
      '--port',
      String(proxyPort),
      '--docs-port',
      String(docsPort),
      '--no-open',
    ],
    { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const cliOutput = [];
  cli.stdout.on('data', (chunk) => cliOutput.push(chunk.toString('utf8')));
  cli.stderr.on('data', (chunk) => cliOutput.push(chunk.toString('utf8')));

  await waitFor(
    async () => {
      try {
        const health = await get(`${docsOrigin}/__wirequill/api/health`);
        return JSON.parse(health.body).ok === true;
      } catch {
        return false;
      }
    },
    30_000,
    'the installed WireQuill to start',
  );

  check('docs server alive', true);

  const shell = await get(`${docsOrigin}/`);
  check('interface served', shell.status === 200 && shell.body.includes('<div id="root">'));

  const asset = /\/assets\/[A-Za-z0-9._-]+\.js/.exec(shell.body)?.[0];
  check('interface references a bundle', asset !== undefined, asset ?? '');

  if (asset !== undefined) {
    const bundle = await get(`${docsOrigin}${asset}`);
    check('bundle served from the installed package', bundle.status === 200, `${asset}`);
  }

  // Traffic through the installed proxy, then documentation out of it.
  await get(`http://127.0.0.1:${String(proxyPort)}/users/1`);

  await waitFor(
    async () => {
      const summary = await get(`${docsOrigin}/__wirequill/api/summary`);
      return JSON.parse(summary.body).operations >= 1;
    },
    15_000,
    'an endpoint to be discovered',
  );

  const document = await get(`${docsOrigin}/openapi.json`);
  const parsed = JSON.parse(document.body);

  check('openapi served', document.status === 200 && parsed.openapi === '3.1.0');
  check('endpoint documented', Object.keys(parsed.paths).includes('/users/{userId}'));

  // The event stream, opened and closed.
  const streamed = await new Promise((resolve) => {
    const request = http.get(
      `${docsOrigin}/__wirequill/events`,
      { headers: { Accept: 'text/event-stream' } },
      (response) => {
        response.setEncoding('utf8');
        response.once('data', (chunk) => {
          request.destroy();
          resolve(chunk.includes('retry:') || chunk.includes('event: ready'));
        });
      },
    );
    request.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 5_000).unref();
  });

  check('event stream alive', streamed);
  check(
    'database written into the consumer project',
    existsSync(path.join(projectDir, '.wirequill')),
  );

  // Path containment still holds in the installed layout.
  const traversal = await get(`${docsOrigin}/../package.json`);
  check('path traversal refused', traversal.status === 404);

  // A second consumer, in a directory whose name is not ASCII. The interesting
  // part is not the proxy — that is covered elsewhere — but that npm's shim,
  // the package's own asset resolution and the data directory all agree about
  // a path Windows and Node spell differently at the byte level
  // (spec section 134).
  writeConsumerManifest(unicodeProjectDir);
  await run('npm', ['install', tarball], { cwd: unicodeProjectDir });

  const unicodeBinary = path.join(
    unicodeProjectDir,
    'node_modules',
    '.bin',
    isWindows ? 'wirequill.cmd' : 'wirequill',
  );
  const unicodeVersion = await capture(unicodeBinary, ['--version'], unicodeProjectDir);

  check(
    'runs from a non-ASCII path',
    unicodeVersion.trim().length > 0,
    path.basename(unicodeProjectDir),
  );

  const unicodeProxyPort = await freePort();
  const unicodeDocsPort = await freePort();
  const unicodeCli = spawnAny(
    unicodeBinary,
    [
      '--target',
      backend.origin,
      '--port',
      String(unicodeProxyPort),
      '--docs-port',
      String(unicodeDocsPort),
      '--no-open',
    ],
    { cwd: unicodeProjectDir, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  unicodeCli.stdout.on('data', () => undefined);
  unicodeCli.stderr.on('data', () => undefined);

  try {
    await waitFor(
      async () => {
        try {
          const health = await get(
            `http://127.0.0.1:${String(unicodeDocsPort)}/__wirequill/api/health`,
          );
          return JSON.parse(health.body).ok === true;
        } catch {
          return false;
        }
      },
      30_000,
      'WireQuill to start from a non-ASCII path',
    );

    await get(`http://127.0.0.1:${String(unicodeProxyPort)}/%C3%BCr%C3%BCnler/123`);

    await waitFor(
      async () => {
        const summary = await get(
          `http://127.0.0.1:${String(unicodeDocsPort)}/__wirequill/api/summary`,
        );
        return JSON.parse(summary.body).operations >= 1;
      },
      15_000,
      'a non-ASCII route to be documented',
    );

    const unicodeOperations = JSON.parse(
      (await get(`http://127.0.0.1:${String(unicodeDocsPort)}/__wirequill/api/operations`)).body,
    );

    check(
      'documents a non-ASCII route',
      unicodeOperations.items.length >= 1,
      unicodeOperations.items[0]?.path ?? '',
    );
    check(
      'writes its database into the non-ASCII project',
      existsSync(path.join(unicodeProjectDir, '.wirequill')),
    );
  } finally {
    await killTree(unicodeCli);
  }

  const printed = cliOutput.join('');
  check(
    'no unexpected stderr',
    !/Error:|UnhandledPromiseRejection|unhandledRejection|ExperimentalWarning/.test(printed),
    '',
  );
} catch (error) {
  console.error('');
  console.error(error instanceof Error ? error.message : String(error));
  failures.push('package smoke threw');
} finally {
  if (cli !== null) {
    await killTree(cli);
  }

  if (backend !== null) {
    await backend.close();
  }

  // Give Windows a moment to release the database file the child had open.
  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    check('work directory removable after shutdown', true);
  } catch (error) {
    // A directory that cannot be removed means something is still holding a
    // file open, which is exactly the class of bug this script exists to catch.
    check(
      'work directory removable after shutdown',
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}

console.log('');

if (failures.length > 0) {
  console.error(`package smoke failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('package smoke passed');
}
