/**
 * Puts the demo back to how a recording needs to find it.
 *
 *   node examples/demo-store/reset.mjs
 *
 * Two things:
 *
 *   1. the store's in-memory state — cart empty, signed out;
 *   2. the documentation WireQuill has accumulated *for this demo*, so the
 *      endpoint counter starts at zero rather than at whatever the last take
 *      left behind.
 *
 * The second one is the careful part. WireQuill's workspace lives at the
 * project root, which is the repository root whenever there is a `.git` above
 * this directory — so the demo shares a database file with anything else in the
 * repository. This script therefore never deletes that file. It removes exactly
 * one workspace row: the one whose project root and target match the demo, and
 * nothing else in it.
 *
 * Run it before starting WireQuill. If WireQuill is already running, this
 * script refuses rather than pulling the workspace out from under it — see
 * `isWireQuillRunning` below for why that matters.
 */
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// `node:sqlite` prints an experimental warning on every load. WireQuill itself
// filters it; a helper script that reads the same database should not be the
// one place it reappears.
const warningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) {
    return;
  }
  for (const listener of warningListeners) {
    listener(warning);
  }
});

const here = path.dirname(fileURLToPath(import.meta.url));
const appPort = Number(process.env.DEMO_APP_PORT ?? 5173);
const apiPort = Number(process.env.DEMO_API_PORT ?? 8080);
const docsPort = Number(process.env.WIREQUILL_DOCS_PORT ?? 3001);

/**
 * Is WireQuill up?
 *
 * This check exists because of a failure that is worse than an error: a running
 * WireQuill holds its workspace id in memory. Delete that row underneath it and
 * it keeps proxying perfectly, keeps answering on the docs port, and silently
 * records nothing — every later write fails a foreign key and is swallowed as a
 * lost documentation sample, which is exactly what that path is supposed to do.
 *
 * Halfway through a take is not when anybody should discover that.
 */
async function isWireQuillRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${String(docsPort)}/__wirequill/api/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The same rule WireQuill uses: the nearest `.git` above, or this directory. */
function findProjectRoot(start) {
  let current = start;

  for (;;) {
    if (existsSync(path.join(current, '.git'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return start;
    }
    current = parent;
  }
}

// 1. The store, if it happens to be running.
try {
  const response = await fetch(`http://127.0.0.1:${String(appPort)}/__demo/reset`, {
    method: 'POST',
  });

  console.log(
    response.ok
      ? 'reset: store state cleared'
      : `reset: the store answered ${String(response.status)}`,
  );
} catch {
  // Not running is the most common case, and it is not a problem: the state
  // lives in that process, so there is nothing left to clear.
  console.log('reset: store is not running, nothing to clear');
}

// 2. The documentation this demo produced.
if (await isWireQuillRunning()) {
  console.log('');
  console.log(`WireQuill is running on port ${String(docsPort)}.`);
  console.log('');
  console.log('Stop it first, then run this again. Clearing its workspace while it is');
  console.log('open would leave it proxying happily and documenting nothing at all.');
  console.log('');

  // Not `process.exit`: there is still a fetch timer in flight, and tearing the
  // loop down around it aborts the process on Windows instead of ending it.
  process.exitCode = 1;
} else {
  clearWorkspace();

  console.log('');
  console.log('The demo will start from zero endpoints.');
}

function clearWorkspace() {
  const projectRoot = findProjectRoot(here);
  const databasePath = path.join(projectRoot, '.wirequill', 'wirequill.sqlite');

  if (projectRoot === here) {
    // The demo owns the whole workspace, so removing it is safe and simple.
    rmSync(path.join(here, '.wirequill'), { recursive: true, force: true, maxRetries: 5 });
    console.log('reset: removed the demo workspace');
    return;
  }

  if (!existsSync(databasePath)) {
    console.log('reset: no WireQuill workspace yet, nothing to clear');
    return;
  }

  clearDemoWorkspace(databasePath, projectRoot);
}

function clearDemoWorkspace(file, root) {
  const { DatabaseSync } = require('node:sqlite');
  const targets = [`http://localhost:${String(apiPort)}`, `http://127.0.0.1:${String(apiPort)}`];

  let db;

  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = ON');
  } catch (error) {
    console.log(`reset: could not open the workspace (${error.message})`);
    return;
  }

  try {
    const statement = db.prepare(
      'DELETE FROM workspaces WHERE project_root = ? AND target_url = ?',
    );
    let removed = 0;

    for (const target of targets) {
      removed += Number(statement.run(root, target).changes ?? 0);
    }

    console.log(
      removed === 0
        ? 'reset: no demo workspace to clear'
        : `reset: cleared the demo workspace (${String(removed)} row)`,
    );
    console.log(`reset: left every other workspace in ${path.relative(root, file)} alone`);
  } catch (error) {
    console.log(`reset: could not clear the demo workspace (${error.message})`);
    console.log('reset: stop WireQuill first, then try again');
  } finally {
    db.close();
  }
}
