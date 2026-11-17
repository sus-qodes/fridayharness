import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bundledHookSource } from '@friday/adapter-claude';
import { loadProject, renderInitialConfig } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { applyGeminiPlan, planGemini } from './config.js';
import type { GeminiInstall } from './detect.js';
import { ACCOUNT_NOTE, type GeminiCheck, geminiDoctor } from './doctor.js';
import { hookShell, runHookCommand } from './shell.js';
import { geminiHookCommand } from './templates.js';

const ws = useTestWorkspace();

const installed: GeminiInstall = {
  command: process.execPath,
  args: ['gemini.js'],
  packageDir: null,
  version: '0.64.0',
  source: 'npm',
  problem: null,
  checked: [],
};

/** A Friday project in a folder whose name a shell could misread, configured for Gemini CLI. */
function configured(name = "my proj's (1)"): string {
  const dir = path.join(ws().root, name);
  mkdirSync(path.join(dir, '.friday'), { recursive: true });
  writeFileSync(
    path.join(dir, '.friday', 'config.yaml'),
    renderInitialConfig(`proj_${'0'.repeat(24)}d1`, 'doctor-test'),
  );
  applyGeminiPlan(planGemini({ projectDir: dir, hookSource: bundledHookSource() }), dir);
  return dir;
}

/** This test's machine: its own state folder and Gemini home, nothing of the developer's. */
const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  FRIDAY_STATE_DIR: ws().stateDir,
  GEMINI_CLI_HOME: path.join(ws().root, 'home'),
  GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(ws().root, 'no-system-settings.json'),
});

const byId = (checks: GeminiCheck[], id: string) => checks.find((c) => c.id === id);

describe('friday harness doctor gemini', () => {
  it("runs Friday's command through the host's shell, as Gemini CLI would, and reports L1 degraded", async () => {
    const dir = configured();
    const report = await geminiDoctor(loadProject(dir), { env: env(), install: installed });
    for (const id of [
      'gemini.hook',
      'gemini.launcher',
      'gemini.settings',
      'gemini.mcp',
      'gemini.md',
      'gemini.failsafe',
      'gemini.shell',
    ]) {
      expect(byId(report.checks, id), id).toMatchObject({ status: 'ok' });
    }
    expect(report.achieved).toBe('L1 degraded');
    expect(byId(report.checks, 'gemini.level')?.message).toMatch(/^L1 degraded \(fail-open\)/);
    expect(byId(report.checks, 'gemini.account')?.message).toContain(ACCOUNT_NOTE);
    expect(byId(report.checks, 'gemini.experimental')?.message).toMatch(/^experimental/);
    expect(byId(report.checks, 'gemini.switched')).toBeUndefined();
  });

  it("says when a settings layer switches Friday's hooks off, and does not claim L1", async () => {
    const dir = configured('plain');
    const home = path.join(ws().root, 'home', '.gemini');
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ hooksConfig: { enabled: false } }));
    const report = await geminiDoctor(loadProject(dir), { env: env(), install: installed, quick: true });
    expect(byId(report.checks, 'gemini.switched')).toMatchObject({ status: 'fail' });
    expect(report.achieved).toBe('L0 observed');
    expect(byId(report.checks, 'gemini.shell')).toBeUndefined();
  });

  it('checks the host alone outside a project, and says what Gemini CLI needs to sign in', async () => {
    const report = await geminiDoctor(null, {
      env: { ...env(), GEMINI_API_KEY: 'not-printed' },
      install: { ...installed, version: '0.30.0' },
    });
    expect(report.achieved).toBe('not attached');
    expect(byId(report.checks, 'gemini.version')).toMatchObject({ status: 'fail' });
    const account = byId(report.checks, 'gemini.account')?.message ?? '';
    expect(account).toContain('GEMINI_API_KEY');
    expect(account).not.toContain('not-printed');
  });

  // Why the command names the launcher by a relative path: the host substitutes $GEMINI_PROJECT_DIR
  // quoted, and Windows PowerShell 5.1 passes a quoted string and the text after it as two arguments.
  it.skipIf(process.platform !== 'win32' || hookShell().executable !== 'powershell.exe')(
    'does not use $GEMINI_PROJECT_DIR, which Windows PowerShell 5.1 splits from the rest of the path',
    async () => {
      const dir = configured('ab');
      const input = {
        session_id: 's',
        cwd: dir,
        hook_event_name: 'BeforeTool',
        tool_name: 'read_file',
        tool_input: { file_path: path.join(dir, '.friday', 'project.db') },
      };
      const opts = { cwd: dir, env: { ...env(), FRIDAY_STATE_DIR: path.join(ws().root, 'empty') }, timeoutMs: 20_000 };
      const substituted = await runHookCommand(
        'node $GEMINI_PROJECT_DIR/.friday/harness/gemini/hook.mjs gemini BeforeTool',
        input,
        opts,
      );
      expect(substituted.json?.decision).toBeUndefined();
      const relative = await runHookCommand(geminiHookCommand('BeforeTool'), input, opts);
      expect(relative.json?.decision).toBe('deny');
    },
  );

  it('warns when the project carries other BeforeTool hooks', async () => {
    const dir = configured('others');
    const file = path.join(dir, '.gemini', 'settings.json');
    const settings = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    settings.hooks.BeforeTool = [
      ...(settings.hooks.BeforeTool ?? []),
      { hooks: [{ type: 'command', command: 'node mine.mjs' }] },
    ];
    writeFileSync(file, JSON.stringify(settings));
    const report = await geminiDoctor(loadProject(dir), { env: env(), install: installed, quick: true });
    expect(byId(report.checks, 'gemini.others')).toMatchObject({ status: 'warn' });
  });

  it('warns when the Gemini CLI you open yourself would start another copy of Friday', async () => {
    const dir = configured('copies');
    // install.json as another copy's "friday setup" left it; nothing names an entry by hand.
    const old = path.join(ws().root, 'old-friday');
    const oldEntry = path.join(old, 'packages', 'mcp-server', 'bin', 'friday-mcp.mjs');
    mkdirSync(path.dirname(oldEntry), { recursive: true });
    writeFileSync(oldEntry, '');
    writeFileSync(
      path.join(ws().stateDir, 'install.json'),
      JSON.stringify({ mcp_server_entry: oldEntry, written_at: '2026-10-31T12:00:00.000Z' }),
    );
    const { FRIDAY_MCP_ENTRY: _named, ...unnamed } = env();
    const recorded = (ownMcpEntry?: string) =>
      geminiDoctor(loadProject(dir), {
        env: unnamed,
        install: installed,
        quick: true,
        ...(ownMcpEntry ? { ownMcpEntry } : {}),
      });

    const other = await recorded();
    expect(byId(other.checks, 'gemini.install')).toEqual({
      id: 'gemini.install',
      status: 'warn',
      message: `Apps you open yourself start another copy of Friday (${old}, set up on 31 October 2026), not this one. Open the Friday desktop app once, or run friday setup, to switch them to this copy.`,
    });
    expect(other.achieved).toBe('L1 degraded');
    // Read by the copy the file names, the check says what it always said.
    expect(byId((await recorded(oldEntry)).checks, 'gemini.install')).toEqual({
      id: 'gemini.install',
      status: 'ok',
      message: `MCP server entry: ${oldEntry}`,
    });
  });
});
