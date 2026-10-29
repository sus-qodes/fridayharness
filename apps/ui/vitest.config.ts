import { defineProject } from 'vitest/config';
import { sharedTestConfig } from '../../vitest.shared.ts';

// The interface's modules run in a DOM: happy-dom, no browser (plan FD-18).
export default defineProject({
  ...sharedTestConfig,
  test: { ...sharedTestConfig.test, name: '@friday/ui', environment: 'happy-dom' },
});
