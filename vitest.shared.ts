import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export const repoRoot = path.dirname(fileURLToPath(import.meta.url));

const PACKAGE_PARENTS = ['apps', 'packages', 'packages/adapters'];
const EXTRA_PACKAGES = ['tests/support'];

function childDirs(parent: string): string[] {
  const abs = path.join(repoRoot, parent);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `${parent}/${d.name}`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Maps every workspace package name to its source entry, so tests always run
 * against `src/` without a build step and without depending on export conditions.
 */
export function workspaceAliases(): { find: RegExp; replacement: string }[] {
  const dirs = [...PACKAGE_PARENTS.flatMap(childDirs), ...EXTRA_PACKAGES];
  const aliases: { find: RegExp; replacement: string }[] = [];
  for (const dir of dirs) {
    const manifest = path.join(repoRoot, dir, 'package.json');
    const entry = path.join(repoRoot, dir, 'src', 'index.ts');
    if (!existsSync(manifest) || !existsSync(entry)) continue;
    const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
    if (name) aliases.push({ find: new RegExp(`^${escapeRegExp(name)}$`), replacement: entry });
  }
  return aliases;
}

/** Defaults every Friday test project inherits (spec Part 11 isolation rules). */
export const sharedTestConfig = {
  resolve: { alias: workspaceAliases() },
  test: {
    // better-sqlite3 is a native addon and some tests change process state: one forked process per file.
    pool: 'forks' as const,
    isolate: true,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    setupFiles: [path.join(repoRoot, 'tests/support/src/setup.ts')],
    env: { TZ: 'UTC', NO_COLOR: '1' },
    include: ['src/**/*.test.ts'],
  },
};

/** Vitest project for a single workspace package. */
export function unitProject(name: string) {
  return defineProject({
    ...sharedTestConfig,
    test: { ...sharedTestConfig.test, name },
  });
}
