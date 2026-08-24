import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli/bin.ts',
  },
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  shims: false,
  // tsup strips the `node:` prefix by default. That is harmless for `node:fs`,
  // which also resolves as bare `fs`, but fatal for `node:sqlite`, which has no
  // bare alias and fails at runtime with ERR_MODULE_NOT_FOUND.
  removeNodeProtocol: false,
});
