/**
 * Test setup: silences the `node:sqlite` experimental warning so a failing
 * assertion is not buried under one warning per worker.
 *
 * The module installs the filter as an import side effect, which is also how
 * the CLI entry point uses it.
 */
import '../src/cli/suppress-warnings.js';
