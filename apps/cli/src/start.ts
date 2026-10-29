import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '@friday/protocol';
import { FRIDAY_DIR, renderInitialConfig } from '@friday/sdk';
import type { Command } from 'commander';
import { type GlobalOptions, operator, out, project, UsageError } from './context.js';
import { openTarget, runningDaemon, startDetached } from './open-link.js';
import { FRIDAY_DIR_GITIGNORE } from './templates.js';

/**
 * `friday start [--desktop]` (plan M12.5): the one command from a repository to a signed-in Studio.
 * It makes the folder a Friday project when it is not one yet (the two files `friday init` writes),
 * starts Friday hidden when it is not running (as `ui --start` does), and opens the Studio in the
 * browser, or the desktop app when asked and installed. It prints what it did, in three lines at
 * most. A folder that is not a git repository is refused with the one command that makes it one.
 */

export interface StartOutcome {
  root: string;
  name: string;
  project_id: string;
  /** `.friday/config.yaml` was missing and has been written, with `.friday/.gitignore`. */
  initialized: boolean;
  /** Friday was not running and has been started hidden. */
  started: boolean;
  url: string;
  pid: number;
  studio: string;
  opened: 'browser' | 'desktop' | null;
  /** The desktop shell that was opened. */
  desktop: string | null;
  /** Why nothing was opened although something was asked for. */
  note: string | null;
}

export const DESKTOP_MISSING =
  'The desktop app is not installed here: build it as apps/desktop/README.md describes, then set FRIDAY_DESKTOP to its friday-desktop.exe.';
export const DESKTOP_WINDOWS_ONLY = 'The desktop app runs on Windows only.';

export function notRepositoryMessage(dir: string): string {
  return `${dir} is not a git repository; make it one first, then start again: git init`;
}

function realpath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The main worktree of the repository `dir` belongs to, or undefined outside git. A linked
 * worktree's common dir is the main checkout's `.git`: the project lives there (ADR-0012).
 */
export function repositoryRoot(dir: string): string | undefined {
  try {
    const lines = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 },
    )
      .trim()
      .split(/\r?\n/);
    const [common, top] = lines;
    if (!common) return undefined;
    const main = path.basename(common) === '.git' ? path.dirname(common) : top;
    return main ? realpath(main) : undefined;
  } catch {
    return undefined;
  }
}

/** The two files `friday init` writes, with the folder's name as the project's name. */
export function initProject(root: string): { config: string; gitignore: string } {
  const dir = path.join(root, FRIDAY_DIR);
  mkdirSync(dir, { recursive: true });
  const config = path.join(dir, 'config.yaml');
  writeFileSync(config, renderInitialConfig(newId('proj'), path.basename(root)));
  const gitignore = path.join(dir, '.gitignore');
  writeFileSync(gitignore, FRIDAY_DIR_GITIGNORE);
  return { config, gitignore };
}

const DESKTOP_BUILD = ['apps', 'desktop', 'src-tauri', 'target', 'release', 'friday-desktop.exe'];

/**
 * Where the desktop shell may be, first match wins: the path in FRIDAY_DESKTOP, the build of a
 * checkout (FRIDAY_HOME, then the one this CLI runs from), then the per-user install folder.
 */
export function desktopCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cliDir = path.dirname(fileURLToPath(import.meta.url)),
): string[] {
  const list: string[] = [];
  if (env.FRIDAY_DESKTOP) list.push(env.FRIDAY_DESKTOP);
  if (platform !== 'win32') return list;
  if (env.FRIDAY_HOME) list.push(path.join(env.FRIDAY_HOME, ...DESKTOP_BUILD));
  // apps/cli/{src,dist} -> the repository root.
  list.push(path.resolve(cliDir, '..', '..', '..', ...DESKTOP_BUILD));
  const local = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  // Where the per-user installer puts it (apps/desktop/README.md); never %LOCALAPPDATA%\Friday, the
  // private state folder.
  list.push(path.join(local, 'Friday Desktop', 'friday-desktop.exe'));
  return list;
}

/** The first candidate that exists. */
export function findDesktopApp(candidates: string[]): string | undefined {
  return candidates.find((c) => existsSync(c));
}

/** Starts the shell detached for the project; under tests (VITEST) nothing is started. */
export function launchDesktop(exe: string, root: string): void {
  if (process.env.VITEST) return;
  try {
    // The shell's own folder, never the project's (LESSONS D-52); it attaches to the running daemon.
    const child = spawn(exe, ['--project', root], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(exe),
      windowsHide: true,
      shell: false,
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Opening is a convenience; the address is printed too.
  }
}

export interface StartOptions {
  desktop?: boolean;
  /** false prints the Studio's address instead of opening anything. */
  open?: boolean;
}

export async function start(g: GlobalOptions, o: StartOptions): Promise<StartOutcome> {
  const dir = path.resolve(g.project ?? process.cwd());
  const root = repositoryRoot(dir);
  if (!root) throw new UsageError(notRepositoryMessage(dir));
  const initialized = !existsSync(path.join(root, FRIDAY_DIR, 'config.yaml'));
  if (initialized) initProject(root);
  const ref = project({ project: root });
  let daemon = await runningDaemon(ref);
  const started = !daemon;
  daemon ??= await startDetached(ref);
  const outcome: StartOutcome = {
    root: ref.root,
    name: ref.name,
    project_id: ref.project_id,
    initialized,
    started,
    url: daemon.url,
    pid: daemon.pid,
    studio: `${daemon.url}/ui/`,
    opened: null,
    desktop: null,
    note: null,
  };
  if (o.desktop) {
    const exe = findDesktopApp(desktopCandidates());
    if (exe) {
      launchDesktop(exe, ref.root);
      outcome.opened = 'desktop';
      outcome.desktop = exe;
    } else {
      outcome.note = process.platform === 'win32' ? DESKTOP_MISSING : DESKTOP_WINDOWS_ONLY;
    }
  } else if (o.open !== false) {
    const { client } = operator({ project: root });
    const login = await client.post<{ url: string; redirect_file: string | null }>(
      client.projectPath('/ui/login-codes'),
      {},
    );
    // The redirect file, so the one-time code is on no command line (LESSONS UI-22).
    openTarget(login.redirect_file ?? login.url);
    outcome.opened = 'browser';
  }
  return outcome;
}

/** What `friday start` did: two lines, three when it also initialized the project. */
export function startLines(r: StartOutcome): string[] {
  const lines: string[] = [];
  if (r.initialized) {
    lines.push(
      `Initialized Friday for "${r.name}" (${r.project_id}); commit .friday/config.yaml and .friday/.gitignore.`,
    );
  }
  lines.push(
    r.started
      ? `Started Friday hidden at ${r.url} (its output: .friday/logs/daemon-console.log).`
      : `Friday is already running at ${r.url}.`,
  );
  if (r.opened === 'browser') lines.push(`Opened the Studio in your browser, signed in (${r.studio}).`);
  else if (r.opened === 'desktop') lines.push(`Opened the desktop app: ${r.desktop}`);
  else if (r.note) lines.push(`${r.note} The Studio is at ${r.studio}; "friday ui" signs your browser in.`);
  else lines.push(`The Studio is at ${r.studio}; "friday ui" opens it signed in.`);
  return lines;
}

export function registerStartCommand(program: Command, g: () => GlobalOptions): void {
  program
    .command('start')
    .description(
      'make this repository a Friday project if needed, start Friday if needed, and open the Studio signed in',
    )
    .option('--desktop', 'open the desktop app instead of the browser (Windows, when it is installed)')
    .option('--no-open', 'print the Studio address instead of opening anything')
    .action(async (o: { desktop?: boolean; open: boolean }) => {
      const r = await start(g(), o);
      out(g(), r, () => startLines(r).join('\n'));
    });
}
