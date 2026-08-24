import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          root: './packages/wirequill',
          include: ['test/unit/**/*.test.ts'],
          setupFiles: ['./test/setup.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          root: './packages/wirequill',
          include: ['test/integration/**/*.test.ts'],
          setupFiles: ['./test/setup.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
          passWithNoTests: true,
        },
      },
    ],
  },
});
