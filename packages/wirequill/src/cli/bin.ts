#!/usr/bin/env node
// Import order matters here and must not be reordered by a formatter or a
// linter:
//
//   1. the Node version guard, so an unsupported runtime gets one sentence
//      rather than a stack trace about a built-in module it does not have;
//   2. the warning filter, which has to be installed before node:sqlite loads.
//
// The guard runs as early as a bundled entry point allows. It cannot protect
// against a Node so old that a dependency fails to parse — nothing in a single
// bundled file can — but `node:sqlite`, the actual reason for the requirement,
// is loaded lazily and therefore always after this check.
import { requireSupportedNode } from './require-node-version.js';
import './suppress-warnings.js';
import { runCli } from './index.js';

if (!requireSupportedNode()) {
  process.exit(1);
}

const exitCode = await runCli(process.argv);

// Setting exitCode rather than calling process.exit lets pending stdout writes
// flush, which matters on Windows where stdout to a pipe is asynchronous.
process.exitCode = exitCode;
