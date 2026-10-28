import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FIXTURE_IDENTITY = { name: 'Fixture Bot', email: 'fixture@friday.local' } as const;
/** 2026-01-01T00:00:00Z; each commit adds one second. */
export const FIXTURE_BASE_EPOCH = 1_767_225_600;

/** Config forced on every invocation so results do not depend on the machine's git setup. */
const FORCED_CONFIG = [
  'core.autocrlf=false',
  'core.eol=lf',
  'core.filemode=false',
  'core.symlinks=false',
  'core.longpaths=true',
  'commit.gpgsign=false',
  'tag.gpgsign=false',
  'init.defaultBranch=main',
  'advice.detachedHead=false',
];

let emptyConfigPath: string | undefined;
function emptyGlobalConfig(): string {
  if (!emptyConfigPath) {
    emptyConfigPath = path.join(os.tmpdir(), 'friday-test-empty.gitconfig');
    if (!existsSync(emptyConfigPath)) writeFileSync(emptyConfigPath, '');
  }
  return emptyConfigPath;
}

export interface DeterministicGit {
  readonly cwd: string;
  /** Runs `git <args>` with isolated config; resolves stdout (trimmed). */
  run(args: string[], opts?: { allowFailure?: boolean }): Promise<string>;
  /** Runs git and returns the exit code instead of throwing. */
  exitCode(args: string[]): Promise<number>;
  init(): Promise<void>;
  /** `git add -A && git commit`; returns the new HEAD sha. */
  commitAll(message: string): Promise<string>;
  headSha(): Promise<string>;
}

/**
 * Git with no global or system config, a fixed author, LF line endings and fixed dates,
 * so the same files and messages produce the same commit SHAs on Windows and Linux.
 */
export function deterministicGit(cwd: string, opts: { startEpoch?: number } = {}): DeterministicGit {
  let epoch = opts.startEpoch ?? FIXTURE_BASE_EPOCH;

  const env = (): NodeJS.ProcessEnv => {
    const date = `${epoch} +0000`;
    return {
      ...process.env,
      GIT_CONFIG_GLOBAL: emptyGlobalConfig(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: FIXTURE_IDENTITY.name,
      GIT_AUTHOR_EMAIL: FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: FIXTURE_IDENTITY.name,
      GIT_COMMITTER_EMAIL: FIXTURE_IDENTITY.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      TZ: 'UTC',
      LANG: 'C',
      LC_ALL: 'C',
    };
  };

  const exec = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const full = FORCED_CONFIG.flatMap((c) => ['-c', c]).concat(args);
      execFile(
        'git',
        full,
        { cwd, env: env(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });

  const git: DeterministicGit = {
    cwd,
    async run(args, runOpts = {}) {
      const { code, stdout, stderr } = await exec(args);
      if (code !== 0 && !runOpts.allowFailure) {
        throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
      }
      return stdout.trim();
    },
    async exitCode(args) {
      return (await exec(args)).code;
    },
    async init() {
      await git.run(['init', '--quiet']);
    },
    async commitAll(message) {
      await git.run(['add', '-A']);
      await git.run(['commit', '--quiet', '--no-verify', '-m', message]);
      epoch += 1;
      return git.headSha();
    },
    async headSha() {
      return git.run(['rev-parse', 'HEAD']);
    },
  };
  return git;
}
