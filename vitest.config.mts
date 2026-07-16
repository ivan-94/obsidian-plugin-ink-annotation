import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL('./test-support/obsidian-runtime.ts', import.meta.url)),
    },
  },
  test: {
    coverage: {
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        branches: 65,
        functions: 67,
        lines: 73,
        statements: 72,
      },
    },
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mts'],
    restoreMocks: true,
  },
});
