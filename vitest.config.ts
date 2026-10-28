import { defineConfig } from 'vitest/config';
import { rootSuites } from './tests/vitest.projects.ts';

export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'packages/adapters/*/vitest.config.ts',
      'apps/*/vitest.config.ts',
      'tests/support/vitest.config.ts',
      ...rootSuites,
    ],
    passWithNoTests: true,
    reporters: process.env.CI ? ['default', ['junit', { outputFile: 'tests/.reports/junit.xml' }]] : ['default'],
  },
});
