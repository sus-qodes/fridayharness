import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { compareCliVersions, cursorEnvironment, findCursorAgent, findCursorIde, installedVersions } from './detect.js';

const ws = useTestWorkspace();
const win = process.platform === 'win32';

describe('the environment of a Cursor session Friday starts', () => {
  it("keeps the user's own and the CLI's login, never a parent session's folder, Friday's variables or secrets", () => {
    const out = cursorEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/u',
      CURSOR_API_KEY: 'key',
      CURSOR_PROJECT_DIR: '/elsewhere',
      CURSOR_VERSION: '3.24.0',
      CURSOR_TRACE_ID: 'x',
      CLAUDE_PROJECT_DIR: '/elsewhere',
      CLAUDE_CODE_SESSION_ID: 's',
      FRIDAY_STATE_DIR: '/state',
      FRIDAY_AGENT: 'dev-1',
      FRIDAY_SPAWN_RUN: 'run_x',
      GITHUB_TOKEN: 'ghp_x',
      OPENAI_API_KEY: 'sk',
      MCP_CONNECTION_NONBLOCKING: '1',
    });
    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/home/u', CURSOR_API_KEY: 'key', FRIDAY_STATE_DIR: '/state' });
  });
});

describe('finding Cursor without starting it', () => {
  it('orders installed CLI versions by their date', () => {
    expect(['2026.9.30-a', '2026.10.16-e3cb207', '2026.10.8-b'].sort(compareCliVersions)).toEqual([
      '2026.9.30-a',
      '2026.10.8-b',
      '2026.10.16-e3cb207',
    ]);
  });

  it("finds the CLI's executable and its versions in the installer's folder, and names a shim it cannot use", () => {
    const local = path.join(ws().root, 'local');
    const home = win ? path.join(local, 'cursor-agent') : path.join(local, 'share', 'cursor-agent');
    for (const v of ['2026.10.8-b', '2026.10.16-e3cb207', 'not-a-version'])
      mkdirSync(path.join(home, 'versions', v), { recursive: true });
    const env = win ? { LOCALAPPDATA: local, PATH: '' } : { XDG_DATA_HOME: path.join(local, 'share'), PATH: '' };
    expect(installedVersions(home)).toEqual(['2026.10.16-e3cb207', '2026.10.8-b']);
    if (win) {
      writeFileSync(path.join(home, 'agent.cmd'), '@echo off\n');
      const shimOnly = findCursorAgent(env);
      expect(shimOnly.binary).toBeNull();
      expect(shimOnly.version).toBe('2026.10.16-e3cb207');
      expect(shimOnly.problem).toMatch(/only the shim .*agent\.cmd was found.*CURSOR_AGENT_BIN/);
    }
    const exe = path.join(home, win ? 'agent.exe' : 'agent');
    writeFileSync(exe, '');
    expect(findCursorAgent(env)).toMatchObject({ binary: exe, version: '2026.10.16-e3cb207', problem: null });
    // CURSOR_AGENT_BIN comes first.
    const own = path.join(ws().root, win ? 'mine.exe' : 'mine');
    writeFileSync(own, '');
    expect(findCursorAgent({ ...env, CURSOR_AGENT_BIN: own }).binary).toBe(own);
  });

  it.runIf(win)('reads the per-user IDE version from its app folder', () => {
    const local = path.join(ws().root, 'local');
    const app = path.join(local, 'Programs', 'cursor', 'resources', 'app');
    mkdirSync(app, { recursive: true });
    expect(findCursorIde({ LOCALAPPDATA: path.join(ws().root, 'none') })).toBeNull();
    writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'cursor', version: '3.24.1' }));
    expect(findCursorIde({ LOCALAPPDATA: local })).toMatchObject({ version: '3.24.1' });
  });
});
