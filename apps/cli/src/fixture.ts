import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project id committed in tests/fixtures/fixture-shop/.friday/config.yaml. */
export const FIXTURE_SHOP_PROJECT_ID = 'proj_0000000000000000000000fx01';

/** 2026-01-01T00:00:00Z; each commit adds one second. */
const BASE_EPOCH = 1_767_225_600;
const IDENTITY = { name: 'Fixture Bot', email: 'fixture@friday.local' };
const FORCED_CONFIG = [
  'core.autocrlf=false',
  'core.eol=lf',
  'core.filemode=false',
  'core.symlinks=false',
  'core.longpaths=true',
  'commit.gpgsign=false',
  'init.defaultBranch=main',
];
const COMMITS = [
  {
    message: 'chore: scaffold the shop workspace',
    paths: [
      'package.json',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
      'tsconfig.json',
      '.gitignore',
      'README.md',
      'DECISIONS.md',
      'infra',
    ],
  },
  { message: 'feat: shared API contract and backend checkout', paths: ['shared', 'backend'] },
  { message: 'feat: frontend pricing helpers and Friday config', paths: ['frontend', '.friday'] },
];
/** Runtime files that must never be copied out of the fixture source. */
const SKIP =
  /(^|[\\/])(node_modules|\.git)([\\/]|$)|[\\/]\.friday[\\/](run|logs|cache|artifacts|sessions|graph|project\.db[^\\/]*)([\\/]|$)/;

/** The fixture in a Friday source checkout (apps/cli/{src,dist} -> tests/fixtures/fixture-shop). */
export function fixtureShopSource(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.resolve(here, '..', '..', '..', 'tests', 'fixtures', 'fixture-shop');
  if (!existsSync(path.join(src, '.friday', 'config.yaml'))) {
    throw new Error('fixture-shop is only available in a Friday source checkout (tests/fixtures/fixture-shop)');
  }
  return src;
}

let emptyConfig: string | undefined;

/**
 * Copies fixture-shop into `dest` and commits it in three commits with a fixed identity and
 * fixed dates, so the same project id gives the same HEAD SHA on Windows and Linux (plan M1.13).
 */
export function materializeFixtureShop(
  dest: string,
  opts: { projectId?: string; source?: string } = {},
): { root: string; head: string; project_id: string } {
  const root = path.resolve(dest);
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error(`${root} is not empty`);
  const source = opts.source ?? fixtureShopSource();
  cpSync(source, root, { recursive: true, filter: (p) => !SKIP.test(p.slice(source.length)) });

  const projectId = opts.projectId ?? FIXTURE_SHOP_PROJECT_ID;
  if (projectId !== FIXTURE_SHOP_PROJECT_ID) {
    const configPath = path.join(root, '.friday', 'config.yaml');
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(FIXTURE_SHOP_PROJECT_ID, projectId));
  }

  if (!emptyConfig) {
    emptyConfig = path.join(os.tmpdir(), 'friday-fixture-empty.gitconfig');
    if (!existsSync(emptyConfig)) writeFileSync(emptyConfig, '');
  }
  let epoch = BASE_EPOCH;
  const git = (args: string[]) =>
    execFileSync('git', [...FORCED_CONFIG.flatMap((c) => ['-c', c]), ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: IDENTITY.name,
        GIT_AUTHOR_EMAIL: IDENTITY.email,
        GIT_COMMITTER_NAME: IDENTITY.name,
        GIT_COMMITTER_EMAIL: IDENTITY.email,
        GIT_AUTHOR_DATE: `${epoch} +0000`,
        GIT_COMMITTER_DATE: `${epoch} +0000`,
        TZ: 'UTC',
      },
    }).trim();
  git(['init', '--quiet']);
  for (const c of COMMITS) {
    git(['add', '--', ...c.paths]);
    git(['commit', '--quiet', '--no-verify', '-m', c.message]);
    epoch += 1;
  }
  const leftover = git(['status', '--porcelain']);
  if (leftover) throw new Error(`fixture-shop left uncommitted files:\n${leftover}`);
  return { root, head: git(['rev-parse', 'HEAD']), project_id: projectId };
}
