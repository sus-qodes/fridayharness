import { repoRoot, sharedTestConfig } from '../vitest.shared.ts';

interface SuiteOverrides {
  testTimeout?: number;
  fileParallelism?: boolean;
}

function suite(name: string, dirs: string[], overrides: SuiteOverrides = {}) {
  return {
    ...sharedTestConfig,
    root: repoRoot,
    test: {
      ...sharedTestConfig.test,
      name,
      include: dirs.map((d) => `tests/${d}/**/*.test.ts`),
      ...overrides,
    },
  };
}

/** Cross-package suites under tests/ (spec Part 11 §4). */
export const rootSuites = [
  suite('protocol', ['protocol']),
  // Starts daemons and spawns the CLI, MCP servers and git: under a full parallel run on a busy
  // machine a 15 s test took 25 s, so these get the same ceiling as the failure suite.
  suite('integration', ['integration'], { testTimeout: 60_000 }),
  suite('failure', ['failure'], { testTimeout: 60_000 }),
  suite('security', ['security']),
  // Spawns real processes (daemon, friday-mcp, hooks): run files one at a time.
  suite('e2e', ['conformance', 'mcp', 'hooks', 'scenarios'], { fileParallelism: false, testTimeout: 90_000 }),
  // The interface in the installed Edge or Chrome against a real daemon, gated by FRIDAY_TEST_UI_E2E=1
  // (Turbo passes only FRIDAY_TEST_* variables; docs/frontend/PLAN.md §10.3). One file at a time.
  suite('ui-e2e', ['ui-e2e'], { fileParallelism: false, testTimeout: 120_000 }),
  // The context evals (plan M12.6): the eval set's checks run always; the measurement clones this
  // repository and builds its code graph, so it runs only with FRIDAY_TEST_BENCH=1 and gets a long
  // ceiling (docs/measurements/README.md).
  suite('evals', ['evals'], { testTimeout: 300_000 }),
];
