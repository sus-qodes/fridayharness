/**
 * `friday harness doctor claude-code` (plan M1.10, B21): each check and the enforcement level it
 * concludes. Claude Code detection is injected, so results do not depend on this machine.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyPlan,
  type ClaudeDoctorReport,
  type ClaudeInstall,
  claudeCodeHooks,
  claudeDoctor,
  planClaudeCode,
} from '@friday/adapter-claude';
import { loadProject } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/cli.js';
import { initTestProject, startTestDaemon } from '../helpers/daemon.js';

const ws = useTestWorkspace();
const ENTRY = path.join(REPO_ROOT, 'packages', 'mcp-server', 'bin', 'friday-mcp.mjs');
const claude = (version: string | null): ClaudeInstall => ({ binary: 'claude', version, source: 'PATH' });
let savedStateDir: string | undefined;
let claudeHome = '';

beforeEach(() => {
  savedStateDir = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
  claudeHome = mkdtempSync(path.join(os.tmpdir(), 'fri-cc-'));
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = savedStateDir;
  rmSync(claudeHome, { recursive: true, force: true });
});

const env = () => ({ FRIDAY_STATE_DIR: ws().stateDir, FRIDAY_MCP_ENTRY: ENTRY, CLAUDE_CONFIG_DIR: claudeHome });
const attach = () => applyPlan(planClaudeCode({ projectDir: ws().projectDir, agentKey: 'dev-1' }));
const statuses = (r: ClaudeDoctorReport) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
const doctor = (install: ClaudeInstall | null, extra: { skipMcp?: boolean } = { skipMcp: true }) =>
  claudeDoctor(loadProject(ws().projectDir), { install, env: env(), ...extra });

describe('friday harness doctor claude-code', () => {
  it('reports "not attached" before harness config and "L1 enforcing" after it', async () => {
    initTestProject(ws());
    const before = await doctor(claude('2.1.296'));
    expect(before.achieved).toBe('not attached');
    expect(statuses(before)).toMatchObject({ 'cc.hook': 'fail', 'cc.mcp-json': 'fail', 'cc.hooks': 'fail' });

    attach();
    const after = await doctor(claude('2.1.296'));
    expect(after.achieved).toBe('L1 enforcing');
    expect(statuses(after)).toEqual({
      'cc.binary': 'ok',
      // Whether this Claude Code can run spawn mode too (2.1.296 cannot: 2.1.300 is the minimum).
      'cc.spawn': 'info',
      'cc.hook': 'ok',
      'cc.launcher': 'ok',
      'cc.mcp-json': 'ok',
      'cc.hooks': 'ok',
      'cc.enabled': 'ok',
      'cc.skill': 'ok',
      'cc.install': 'ok',
      'cc.secrets': 'ok',
      'cc.daemon': 'warn',
      'cc.failsafe': 'ok',
      'cc.trust': 'info',
    });
  });

  it('maps the Claude Code version to the level Friday achieves', async () => {
    initTestProject(ws());
    attach();
    const levels: Array<[ClaudeInstall | null, string, string]> = [
      [claude('2.1.296'), 'L1 enforcing', 'ok'],
      [claude('2.1.250'), 'L1 degraded', 'warn'],
      [claude('2.1.100'), 'L0 observed', 'fail'],
      [null, 'L1 degraded', 'warn'],
    ];
    for (const [install, achieved, binary] of levels) {
      const r = await doctor(install);
      expect([r.achieved, statuses(r)['cc.binary']], install?.version ?? 'not found').toEqual([achieved, binary]);
    }
  });

  it('finds a running daemon, a planted token and hooks that no longer fail closed', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    attach();
    expect(statuses(await doctor(claude('2.1.296')))['cc.daemon']).toBe('ok');

    writeFileSync(path.join(ws().projectDir, 'CLAUDE.md'), `debug token ${td.daemon.tokens.bootstrap}\n`);
    const leaked = await doctor(claude('2.1.296'));
    const secrets = leaked.checks.find((c) => c.id === 'cc.secrets');
    expect(secrets).toMatchObject({ status: 'fail', message: expect.stringContaining('CLAUDE.md') });
    expect(JSON.stringify(leaked)).not.toContain(td.daemon.tokens.bootstrap);
    rmSync(path.join(ws().projectDir, 'CLAUDE.md'));

    const settingsPath = path.join(ws().projectDir, '.claude', 'settings.json');
    writeFileSync(settingsPath, readFileSync(settingsPath, 'utf8').replace('"onFailure": "block",', ''));
    const open = await doctor(claude('2.1.296'));
    expect(open.checks.find((c) => c.id === 'cc.hooks')).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('does not fail closed'),
    });
    expect(open.achieved).toBe('L0 observed');
  });

  it('flags a hook launcher that is not the current build', async () => {
    initTestProject(ws());
    attach();
    const hook = path.join(ws().projectDir, '.friday', 'harness', 'claude-code', 'hook.mjs');
    writeFileSync(hook, `${readFileSync(hook, 'utf8')}\n// local edit\n`);
    expect(statuses(await doctor(claude('2.1.296')))['cc.hook']).toBe('warn');
    writeFileSync(hook, 'console.log("not friday")\n');
    const r = await doctor(claude('2.1.296'));
    expect(statuses(r)['cc.hook']).toBe('fail');
    expect(r.achieved).toBe('L0 observed');
  });

  it('reads workspace trust from Claude Code user state', async () => {
    initTestProject(ws());
    attach();
    writeFileSync(
      path.join(claudeHome, '.claude.json'),
      JSON.stringify({ projects: { [ws().projectDir]: { hasTrustDialogAccepted: true } } }),
    );
    expect(statuses(await doctor(claude('2.1.296')))['cc.trust']).toBe('ok');
  });

  it('starts the MCP server through the committed launcher', async () => {
    initTestProject(ws());
    attach();
    const r = await doctor(claude('2.1.296'), {});
    expect(r.checks.find((c) => c.id === 'cc.mcp')).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('19 friday tools'),
    });
  });
});
