import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectRef } from '@friday/sdk';
import { cliEntry } from './agent-launcher.js';

/**
 * A per-project shortcut that opens Friday signed in, starting it when needed (plan M9 §5.12,
 * FD-23): the daily path needs no terminal and no desktop toolchain. It runs
 * `node <cli> --project <root> ui --start`.
 */

export interface ShortcutOptions {
  desktop?: boolean;
  startMenu?: boolean;
  /** Where to write instead of the user's folders (tests). */
  dir?: string;
}

/** A name a file system accepts on every platform. */
function fileName(project: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters cannot be in a file name
  return `Friday - ${project.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80)}`;
}

function folders(o: ShortcutOptions): string[] {
  if (o.dir) return [o.dir];
  const home = os.homedir();
  const out: string[] = [];
  if (process.platform === 'win32') {
    if (o.desktop !== false) out.push(path.join(home, 'Desktop'));
    if (o.startMenu) {
      out.push(
        path.join(
          process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
          'Microsoft',
          'Windows',
          'Start Menu',
          'Programs',
        ),
      );
    }
  } else {
    if (o.desktop !== false) out.push(path.join(home, 'Desktop'));
    if (o.startMenu)
      out.push(path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'applications'));
  }
  return out;
}

/** A PowerShell single-quoted string. */
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Writes the shortcut(s); answers their paths. */
export function createShortcut(ref: ProjectRef, o: ShortcutOptions = {}): string[] {
  const written: string[] = [];
  const args = [cliEntry(), '--project', ref.root, 'ui', '--start'];
  for (const dir of folders(o)) {
    mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32' && !o.dir) {
      const file = path.join(dir, `${fileName(ref.name)}.lnk`);
      // WScript.Shell writes .lnk files; window style 7 (minimized), so the console only flashes in the taskbar.
      const quoted = args.map((a) => `"${a}"`).join(' ');
      const script = [
        '$ws = New-Object -ComObject WScript.Shell',
        `$s = $ws.CreateShortcut(${psq(file)})`,
        `$s.TargetPath = ${psq(process.execPath)}`,
        `$s.Arguments = ${psq(quoted)}`,
        // The CLI's folder, never the project's (LESSONS D-52).
        `$s.WorkingDirectory = ${psq(path.dirname(cliEntry()))}`,
        '$s.WindowStyle = 7',
        `$s.Description = ${psq(`Open Friday for ${ref.name}`)}`,
        '$s.Save()',
      ].join('; ');
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore',
      });
      written.push(file);
    } else if (process.platform === 'win32') {
      // Tests on Windows: a .cmd that runs the same command (no COM in a test).
      const file = path.join(dir, `${fileName(ref.name)}.cmd`);
      writeFileSync(file, `@echo off\r\n"${process.execPath}" ${args.map((a) => `"${a}"`).join(' ')}\r\n`);
      written.push(file);
    } else {
      const file = path.join(dir, `${fileName(ref.name).replace(/ /g, '-')}.desktop`);
      const exec = [process.execPath, ...args].map((a) => `"${a.replace(/(["\\$`])/g, '\\$1')}"`).join(' ');
      writeFileSync(
        file,
        [
          '[Desktop Entry]',
          'Type=Application',
          `Name=${fileName(ref.name)}`,
          `Comment=Open Friday for ${ref.name}`,
          `Exec=${exec}`,
          'Terminal=false',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      written.push(file);
    }
  }
  return written;
}
