import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DESKTOP_MISSING,
  desktopCandidates,
  findDesktopApp,
  initProject,
  notRepositoryMessage,
  repositoryRoot,
  type StartOutcome,
  startLines,
} from './start.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fr-start-'));
  dirs.push(dir);
  return dir;
}

const outcome = (over: Partial<StartOutcome> = {}): StartOutcome => ({
  root: 'C:\\work\\shop',
  name: 'shop',
  project_id: 'proj_x',
  initialized: false,
  started: false,
  url: 'http://127.0.0.1:4100',
  pid: 42,
  studio: 'http://127.0.0.1:4100/ui/',
  opened: 'browser',
  desktop: null,
  note: null,
  ...over,
});

describe('friday start (plan M12.5)', () => {
  it('knows a git repository from a plain folder, and names the one command that makes one', () => {
    const plain = scratch();
    expect(repositoryRoot(plain)).toBeUndefined();
    expect(notRepositoryMessage(plain)).toContain('git init');
    const repo = path.join(scratch(), 'repo');
    execFileSync('git', ['init', '-q', repo], { windowsHide: true });
    const root = repositoryRoot(path.join(repo));
    expect(root).toBeDefined();
    expect(path.basename(root as string)).toBe('repo');
  });

  it('writes the two files friday init writes, named after the folder', () => {
    const root = path.join(scratch(), 'shop');
    const { config, gitignore } = initProject(root);
    expect(existsSync(config)).toBe(true);
    expect(readFileSync(config, 'utf8')).toContain('name: "shop"');
    expect(readFileSync(gitignore, 'utf8')).toContain('/project.db');
  });

  it('prints three lines at most, and always the Studio address', () => {
    const full = startLines(outcome({ initialized: true, started: true }));
    expect(full).toHaveLength(3);
    expect(full[0]).toContain('commit .friday/config.yaml');
    expect(full[1]).toContain('Started Friday hidden at http://127.0.0.1:4100');
    expect(full[2]).toContain('http://127.0.0.1:4100/ui/');
    const again = startLines(outcome());
    expect(again).toHaveLength(2);
    expect(again[0]).toContain('already running');
    const noApp = startLines(outcome({ opened: null, note: DESKTOP_MISSING }));
    expect(noApp.at(-1)).toContain('apps/desktop/README.md');
    expect(noApp.at(-1)).toContain('http://127.0.0.1:4100/ui/');
    const printed = startLines(outcome({ opened: null }));
    expect(printed.at(-1)).toContain('friday ui');
    for (const lines of [full, again, noApp, printed]) expect(lines.length).toBeLessThanOrEqual(3);
  });

  it('looks for the desktop shell where it is set, built or installed, and takes the first that exists', () => {
    const dir = scratch();
    const exe = path.join(dir, 'friday-desktop.exe');
    const env = { FRIDAY_DESKTOP: exe, FRIDAY_HOME: path.join(dir, 'home'), LOCALAPPDATA: path.join(dir, 'local') };
    const candidates = desktopCandidates(env, 'win32', path.join(dir, 'cli', 'dist'));
    expect(candidates[0]).toBe(exe);
    expect(candidates).toContain(
      path.join(dir, 'home', 'apps', 'desktop', 'src-tauri', 'target', 'release', 'friday-desktop.exe'),
    );
    expect(candidates).toContain(path.join(dir, 'local', 'Programs', 'Friday', 'Friday.exe'));
    expect(findDesktopApp(candidates)).toBeUndefined();
    writeFileSync(exe, '');
    expect(findDesktopApp(candidates)).toBe(exe);
    // Elsewhere than Windows only an explicit path counts.
    expect(desktopCandidates(env, 'linux', dir)).toEqual([exe]);
    expect(desktopCandidates({}, 'linux', dir)).toEqual([]);
  });
});
