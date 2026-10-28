import { defineConfig } from 'vitest/config';
import { repoRoot } from '../vitest.shared.ts';
import { rootSuites } from './vitest.projects.ts';

export default defineConfig({
  root: repoRoot,
  test: {
    projects: rootSuites,
    passWithNoTests: true,
  },
});
