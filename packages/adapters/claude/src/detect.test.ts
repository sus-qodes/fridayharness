import { describe, expect, it } from 'vitest';
import {
  claudeCandidates,
  compareVersions,
  type DetectSystem,
  detectClaudeCode,
  hookLevel,
  programOfShim,
  SPAWN_MIN,
} from './detect.js';

/** Finding Claude Code (reviewed 2026-11-17), on a machine made of the files a test names: nothing is run. */

const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const NPM_EXE = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const SHIM =
  '@ECHO off\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
const EXT = 'C:\\Users\\me\\.vscode\\extensions';
const extExe = (v: string) => `${EXT}\\anthropic.claude-code-${v}-win32-x64\\resources\\native-binary\\claude.exe`;

function machine(
  o: {
    platform?: NodeJS.Platform;
    home?: string;
    /** Files that exist, with the version each prints (null: it exists and cannot be run). */
    programs?: Record<string, string | null>;
    files?: Record<string, string>;
    dirs?: Record<string, string[]>;
    onPath?: string[];
    currentPath?: string[];
  } = {},
): { sys: DetectSystem; ran: string[] } {
  const ran: string[] = [];
  const programs = o.programs ?? {};
  const files = o.files ?? {};
  const key = (f: string) => ((o.platform ?? 'win32') === 'win32' ? f.toLowerCase() : f);
  const has = (map: Record<string, unknown>, f: string) => Object.keys(map).some((k) => key(k) === key(f));
  const get = <T>(map: Record<string, T>, f: string): T | undefined =>
    Object.entries(map).find(([k]) => key(k) === key(f))?.[1];
  return {
    ran,
    sys: {
      platform: o.platform ?? 'win32',
      home: o.home ?? 'C:\\Users\\me',
      exists: (f) => has(programs, f) || has(files, f),
      list: (d) => get(o.dirs ?? {}, d) ?? [],
      read: (f) => get(files, f) ?? null,
      versionOf: (b) => {
        ran.push(b);
        return get(programs, b) ?? null;
      },
      onPath: () => o.onPath ?? [],
      currentPath: () => o.currentPath ?? [],
    },
  };
}

const ENV = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };

describe('finding Claude Code', () => {
  it('finds the program behind npm’s shims, which is all `where claude` lists for an npm install', () => {
    const { sys, ran } = machine({
      onPath: [`${NPM}\\claude`, `${NPM}\\claude.cmd`],
      files: { [`${NPM}\\claude`]: '#!/bin/sh', [`${NPM}\\claude.cmd`]: SHIM },
      programs: { [NPM_EXE]: '2.1.306' },
    });
    expect(detectClaudeCode(ENV, sys)).toEqual({ binary: NPM_EXE, version: '2.1.306', source: 'PATH' });
    // Neither shim is started: they cannot be run without a shell.
    expect(ran).toEqual([NPM_EXE]);
    expect(programOfShim(`${NPM}\\claude.cmd`, sys)).toBe(NPM_EXE);
  });

  it('reads the program a shim names, and falls back to where npm keeps it', () => {
    const other = 'C:\\tools\\shims';
    const named = machine({
      files: { [`${other}\\claude.cmd`]: '"%~dp0\\pkg\\claude.exe" %*' },
      programs: { [`${other}\\pkg\\claude.exe`]: '2.1.310' },
    });
    expect(programOfShim(`${other}\\claude.cmd`, named.sys)).toBe(`${other}\\pkg\\claude.exe`);
    // A shim Friday cannot read (another tool's), with npm's layout beside it.
    const layout = machine({ files: { [`${NPM}\\claude.cmd`]: 'node something' }, programs: { [NPM_EXE]: '2.1.306' } });
    expect(programOfShim(`${NPM}\\claude.cmd`, layout.sys)).toBe(NPM_EXE);
    // A shim that points outside its own folder is not followed, and one with no program is nothing.
    const outside = machine({
      files: { [`${other}\\claude.cmd`]: '"%dp0%\\..\\..\\Windows\\evil.exe" %*' },
      programs: { 'C:\\Windows\\evil.exe': '9.9.9' },
    });
    expect(programOfShim(`${other}\\claude.cmd`, outside.sys)).toBeNull();
    expect(programOfShim(`${other}\\missing.cmd`, machine().sys)).toBeNull();
  });

  it('looks where the installers put it when it is not on PATH', () => {
    // The native installer's folder, which is often not on PATH.
    const native = machine({ programs: { 'C:\\Users\\me\\.local\\bin\\claude.exe': '2.1.320' } });
    expect(detectClaudeCode(ENV, native.sys)).toEqual({
      binary: 'C:\\Users\\me\\.local\\bin\\claude.exe',
      version: '2.1.320',
      source: 'install-folder',
    });
    // npm's folder, by its own location, when PATH does not have it.
    const npm = machine({ files: { [`${NPM}\\claude.cmd`]: SHIM }, programs: { [NPM_EXE]: '2.1.306' } });
    expect(detectClaudeCode(ENV, npm.sys)).toMatchObject({ binary: NPM_EXE, source: 'install-folder' });
    // Installed while Friday runs: on the PATH a new program gets, not on Friday's own. A relative
    // folder of that PATH is never looked in.
    const later = machine({
      currentPath: ['relative\\bin', 'D:\\apps\\claude'],
      programs: { 'D:\\apps\\claude\\claude.exe': '2.1.330', 'relative\\bin\\claude.exe': '9.9.9' },
    });
    expect(detectClaudeCode(ENV, later.sys)).toMatchObject({ binary: 'D:\\apps\\claude\\claude.exe' });
    expect(later.ran).toEqual(['D:\\apps\\claude\\claude.exe']);
  });

  it('keeps the order: PATH, CLAUDE_CODE_BIN, install folders, the editor’s extension, claude-cli-nodejs', () => {
    const { sys } = machine({
      onPath: [`${NPM}\\claude.cmd`, 'C:\\bin\\claude.exe'],
      files: { [`${NPM}\\claude.cmd`]: SHIM },
      programs: { [NPM_EXE]: '2.1.306' },
      dirs: {
        [EXT]: ['anthropic.claude-code-2.1.99-win32-x64', 'anthropic.claude-code-2.1.325-win32-x64', 'other.ext-1.0.0'],
      },
    });
    const env = { ...ENV, CLAUDE_CODE_BIN: 'D:\\my\\claude.exe' };
    expect(claudeCandidates(env, sys).map((c) => [c.source, c.binary])).toEqual([
      // A program before a shim, whatever order `where` gave.
      ['PATH', 'C:\\bin\\claude.exe'],
      ['PATH', NPM_EXE],
      ['CLAUDE_CODE_BIN', 'D:\\my\\claude.exe'],
      ['install-folder', 'C:\\Users\\me\\.local\\bin\\claude.exe'],
      // Every place is one to look in; what is not there is skipped when they are tried.
      ['install-folder', `${NPM}\\claude.exe`],
      // The newest extension first.
      ['vscode-extension', extExe('2.1.325')],
      ['vscode-extension', extExe('2.1.99')],
      ['claude-cli-nodejs', 'C:\\Users\\me\\AppData\\Local\\claude-cli-nodejs\\claude.exe'],
      ['claude-cli-nodejs', 'C:\\Users\\me\\AppData\\Local\\claude-cli-nodejs\\bin\\claude.exe'],
    ]);
  });

  it('prefers one new enough to start agents over an older one found first, and says the old one when it is all there is', () => {
    const old = { 'C:\\bin\\claude.exe': '2.1.100' };
    const both = machine({
      onPath: ['C:\\bin\\claude.exe'],
      programs: { ...old, [extExe('2.1.325')]: '2.1.325' },
      dirs: { [EXT]: ['anthropic.claude-code-2.1.325-win32-x64'] },
    });
    expect(detectClaudeCode(ENV, both.sys)).toEqual({
      binary: extExe('2.1.325'),
      version: '2.1.325',
      source: 'vscode-extension',
    });
    const only = machine({ onPath: ['C:\\bin\\claude.exe'], programs: old });
    expect(detectClaudeCode(ENV, only.sys)).toEqual({
      binary: 'C:\\bin\\claude.exe',
      version: '2.1.100',
      source: 'PATH',
    });
    // Exactly the oldest that can: taken at once, nothing after it is started.
    const exact = machine({
      onPath: ['C:\\bin\\claude.exe'],
      programs: { 'C:\\bin\\claude.exe': SPAWN_MIN, [extExe('2.1.325')]: '2.1.325' },
      dirs: { [EXT]: ['anthropic.claude-code-2.1.325-win32-x64'] },
    });
    expect(detectClaudeCode(ENV, exact.sys)?.binary).toBe('C:\\bin\\claude.exe');
    expect(exact.ran).toEqual(['C:\\bin\\claude.exe']);
  });

  it('skips what is not there or cannot be run, and finds nothing on an empty machine', () => {
    const { sys, ran } = machine({
      onPath: ['C:\\gone\\claude.exe', 'C:\\broken\\claude.exe'],
      programs: { 'C:\\broken\\claude.exe': null, [extExe('2.1.325')]: '2.1.325' },
      dirs: { [EXT]: ['anthropic.claude-code-2.1.325-win32-x64'] },
    });
    expect(detectClaudeCode(ENV, sys)?.source).toBe('vscode-extension');
    // What is gone is not started at all.
    expect(ran).toEqual(['C:\\broken\\claude.exe', extExe('2.1.325')]);
    expect(detectClaudeCode(ENV, machine().sys)).toBeNull();
    expect(detectClaudeCode({}, machine().sys)).toBeNull();
  });

  it('on macOS and Linux takes what `which` gives, then the folders a program started from a launcher lacks', () => {
    const which = machine({
      platform: 'darwin',
      home: '/Users/me',
      onPath: ['/usr/local/bin/claude'],
      programs: { '/usr/local/bin/claude': '2.1.320' },
    });
    expect(detectClaudeCode({}, which.sys)).toEqual({
      binary: '/usr/local/bin/claude',
      version: '2.1.320',
      source: 'PATH',
    });
    const finder = machine({
      platform: 'darwin',
      home: '/Users/me',
      programs: { '/opt/homebrew/bin/claude': '2.1.320' },
    });
    expect(detectClaudeCode({}, finder.sys)).toMatchObject({
      binary: '/opt/homebrew/bin/claude',
      source: 'install-folder',
    });
    expect(claudeCandidates({}, machine({ platform: 'linux', home: '/home/me' }).sys).map((c) => c.binary)).toEqual([
      '/home/me/.local/bin/claude',
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/home/me/.npm-global/bin/claude',
      '/home/me/.claude/local/claude',
      '/home/me/.bun/bin/claude',
      '/home/me/.volta/bin/claude',
    ]);
  });

  it('compares versions by number and names the hook level', () => {
    expect(compareVersions('2.1.300', '2.1.99')).toBeGreaterThan(0);
    expect(compareVersions('2.1.325-win32-x64', '2.1.99-win32-x64')).toBeGreaterThan(0);
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
    expect([hookLevel(null), hookLevel('2.1.100'), hookLevel('2.1.232'), hookLevel('2.1.295')]).toEqual([
      'unknown',
      'unsupported',
      'degraded',
      'enforcing',
    ]);
  });
});
