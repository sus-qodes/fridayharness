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
];
