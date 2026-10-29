import { defineConfig } from 'vitest/config';
import { repoRoot, sharedTestConfig } from '../../vitest.shared.ts';

/**
 * The context evals (plan M12.6), run on their own:
 *   pnpm vitest run --config tests/evals/vitest.config.ts
 * The eval itself runs only with FRIDAY_TEST_BENCH=1; it clones this repository into the test
 * workspace and builds its code graph, so it gets a long ceiling.
 */
export default defineConfig({
  ...sharedTestConfig,
  root: repoRoot,
  test: {
    ...sharedTestConfig.test,
    name: 'evals',
    include: ['tests/evals/**/*.test.ts'],
    testTimeout: 300_000,
  },
});
