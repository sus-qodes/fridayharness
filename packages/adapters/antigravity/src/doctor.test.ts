/**
 * `friday harness doctor antigravity` (plan M8b.3): each check and the level it concludes. The
 * level is `unverified` until a run records what a crashed or timed-out hook does to the call,
 * and there is no spawn mode. Antigravity is never started: detection is injected, or answered by
 * the scripted stand-in tests/fixtures/antigravity/fake-agy.mjs.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '@friday/protocol';
import { loadProject, privateDirFor, renderInitialConfig, writePrivateFile } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { applyAntigravityPlan, planAntigravity } from './config.js';
import { type AntigravityFound, findAntigravity, parseVersion } from './detect.js';
import { type AntigravityDoctorReport, antigravityDoctor } from './doctor.js';
import { FAILURE_EVIDENCE, type FailureEvidence, levelFromEvidence } from './evidence.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ENTRY = path.join(REPO, 'packages', 'mcp-server', 'bin', 'friday-mcp.mjs');
const FAKE_AGY = path.join(REPO, 'tests', 'fixtures', 'antigravity', 'fake-agy.mjs');

const ws = useTestWorkspace({ prefix: 'fri-agd-' });
const env = () => ({ FRIDAY_STATE_DIR: ws().stateDir, FRIDAY_MCP_ENTRY: ENTRY, PATH: '' });
const cli = (version: string | null): AntigravityFound => ({
  cli: { kind: 'cli', binary: 'agy', version, source: 'PATH' },
  app: null,
  checked: [],
  shim: null,
});

function initProject(): void {
  mkdirSync(path.join(ws().projectDir, '.friday'), { recursive: true });
  writeFileSync(path.join(ws().projectDir, '.friday', 'config.yaml'), renderInitialConfig(newId('proj'), 'ag-doctor'));
}
const attach = () =>
  applyAntigravityPlan(planAntigravity({ projectDir: ws().projectDir, env: env(), agentKey: 'ag-1' }));
const doctor = (
  found: AntigravityFound = cli('1.4.2'),
  extra: { skipMcp?: boolean; evidence?: FailureEvidence } = {},
) => antigravityDoctor(loadProject(ws().projectDir), { found, env: env(), skipMcp: true, ...extra });
const statuses = (r: AntigravityDoctorReport) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
const check = (r: AntigravityDoctorReport, id: string) => r.checks.find((c) => c.id === id);
const hooksFile = () => path.join(ws().projectDir, '.agents', 'hooks.json');
type HookGroup = { enabled?: boolean; PreToolUse: Array<{ matcher: string; hooks: Array<{ timeout: number }> }> };
const editHooks = (edit: (group: HookGroup) => void) => {
  const all = JSON.parse(readFileSync(hooksFile(), 'utf8'));
  edit(all.friday);
  writeFileSync(hooksFile(), `${JSON.stringify(all, null, 2)}\n`);
};

const recorded = (crash: 'blocks' | 'runs', timeout: 'blocks' | 'runs', version = '1.4.2'): FailureEvidence => ({
  host_version: version,
  checked_on: '2026-10-20',
  crash,
  timeout,
  notes: 'docs/integration/antigravity.md',
});

describe('friday harness doctor antigravity', () => {
  it('reports "not attached" before harness config and "L1 unverified" after it', async () => {
    initProject();
    const before = await doctor();
    expect(before.achieved).toBe('not attached');
    expect(statuses(before)).toMatchObject({ 'ag.hook': 'fail', 'ag.hooks': 'fail', 'ag.mcp-json': 'fail' });

    attach();
    const after = await doctor();
    expect(after.achieved).toBe('L1 unverified');
    expect(after.hook_level).toBe('unverified');
    expect(statuses(after)).toEqual({
      'ag.binary': 'ok',
      'ag.spawn': 'info',
      'ag.hook': 'ok',
      'ag.launcher': 'ok',
      'ag.hooks': 'ok',
      'ag.mcp-json': 'ok',
      'ag.agents-md': 'ok',
      'ag.install': 'ok',
      'ag.secrets': 'ok',
      'ag.daemon': 'warn',
      'ag.failsafe': 'ok',
      'ag.trust': 'info',
      'ag.tools': 'info',
      'ag.level': 'warn',
    });
  });

  it('says why the level is unverified, and that there is no spawn mode', async () => {
    initProject();
    attach();
    const r = await doctor();
    expect(check(r, 'ag.level')?.message).toBe(
      "L1 unverified once Friday's hooks reach the daemon: what Antigravity does with a call when its hook crashes or times out is not documented, and no run has recorded it yet",
    );
    expect(check(r, 'ag.level')?.fix).toContain('docs/integration/antigravity.md');
    expect(check(r, 'ag.spawn')?.message).toMatch(
      /^no spawn mode: .*terms do not support running "agy -p" inside third-party software under consumer plans/,
    );
    expect(check(r, 'ag.failsafe')?.message).toContain('force_ask');
    expect(check(r, 'ag.binary')?.message).toBe('Antigravity CLI 1.4.2 at agy (PATH)');
  });

  it('takes the level from recorded evidence only, for the version it was recorded on', async () => {
    initProject();
    attach();
    expect(FAILURE_EVIDENCE).toEqual({ host_version: null, checked_on: null, crash: null, timeout: null, notes: null });
    expect((await doctor(cli('1.4.2'), { evidence: recorded('blocks', 'blocks') })).achieved).toBe('L1 enforcing');
    expect(statuses(await doctor(cli('1.4.2'), { evidence: recorded('blocks', 'blocks') }))['ag.level']).toBe('ok');
    expect((await doctor(cli('1.4.2'), { evidence: recorded('blocks', 'runs') })).achieved).toBe('L1 degraded');
    const newer = await doctor(cli('1.5.0'), { evidence: recorded('blocks', 'blocks') });
    expect(newer.achieved).toBe('L1 unverified');
    expect(check(newer, 'ag.level')?.message).toContain('recorded for Antigravity 1.4.2, not for 1.5.0');

    expect(levelFromEvidence(FAILURE_EVIDENCE)).toBe('unverified');
    expect(levelFromEvidence({ ...recorded('blocks', 'blocks'), timeout: null })).toBe('unverified');
    expect(levelFromEvidence(recorded('runs', 'blocks'), null)).toBe('degraded');
    expect(levelFromEvidence(recorded('blocks', 'blocks'), '1.4.9')).toBe('enforcing');
  });

  it('finds hooks that no longer match every tool, time out too soon, or are switched off', async () => {
    initProject();
    attach();
    editHooks((g) => {
      for (const entry of g.PreToolUse) entry.matcher = 'run_command';
    });
    const narrowed = await doctor();
    expect(check(narrowed, 'ag.hooks')).toMatchObject({
      status: 'fail',
      message: 'PreToolUse does not match every tool (matcher "*")',
    });
    expect(narrowed.achieved).toBe('L0 observed');

    // "" is Antigravity's other spelling of every tool.
    editHooks((g) => {
      for (const entry of g.PreToolUse) entry.matcher = '';
    });
    expect(statuses(await doctor())['ag.hooks']).toBe('ok');

    attach();
    editHooks((g) => {
      for (const entry of g.PreToolUse) for (const h of entry.hooks) h.timeout = 3;
    });
    expect(check(await doctor(), 'ag.hooks')?.message).toMatch(
      /^PreToolUse times out after 3 s, before the launcher's own answer \(4 s\)/,
    );

    attach();
    editHooks((g) => {
      g.enabled = false;
    });
    expect(check(await doctor(), 'ag.hooks')?.message).toBe('the "friday" hook group is disabled (enabled: false)');

    attach();
    const mcp = path.join(ws().projectDir, '.agents', 'mcp_config.json');
    const config = JSON.parse(readFileSync(mcp, 'utf8'));
    config.mcpServers.friday.disabled = true;
    writeFileSync(mcp, JSON.stringify(config));
    const off = await doctor();
    expect(check(off, 'ag.mcp-json')).toMatchObject({
      status: 'fail',
      message: 'the friday server is disabled in .agents/mcp_config.json',
    });
    expect(off.achieved).toBe('not attached');
  });

  it('warns about a byte-order mark only where Antigravity cannot load one', async () => {
    initProject();
    attach();
    writeFileSync(hooksFile(), `﻿${readFileSync(hooksFile(), 'utf8')}`);
    expect(check(await doctor(cli('1.2.0')), 'ag.hooks')).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('byte-order mark'),
    });
    expect(statuses(await doctor(cli('1.4.2')))['ag.hooks']).toBe('ok');
  });

  it('finds a planted token without repeating it, and a launcher copy that is not this build', async () => {
    initProject();
    attach();
    const ref = loadProject(ws().projectDir);
    const token = 'fbt_planted_token_for_the_doctor_0001';
    writePrivateFile(privateDirFor(ref, env()), 'bootstrap.token', `${token}\n`);
    writeFileSync(path.join(ws().projectDir, 'AGENTS.md'), `debug ${token}\n`);
    const leaked = await doctor();
    expect(check(leaked, 'ag.secrets')).toMatchObject({ status: 'fail', message: 'Friday tokens found in AGENTS.md' });
    expect(JSON.stringify(leaked)).not.toContain(token);
    expect(statuses(leaked)['ag.agents-md']).toBe('warn');

    const hook = path.join(ws().projectDir, '.friday', 'harness', 'antigravity', 'hook.mjs');
    writeFileSync(hook, `${readFileSync(hook, 'utf8')}\n// local edit\n`);
    expect(statuses(await doctor())['ag.hook']).toBe('warn');
    writeFileSync(hook, 'console.log("not friday")\n');
    const r = await doctor();
    expect(statuses(r)['ag.hook']).toBe('fail');
    expect(r.achieved).toBe('L0 observed');
  });

  it('starts the friday MCP server through the committed launcher', async () => {
    initProject();
    attach();
    const r = await doctor(cli('1.4.2'), { skipMcp: false });
    expect(check(r, 'ag.mcp')).toMatchObject({
      status: 'ok',
      message: expect.stringMatching(/lists \d+ friday tools$/),
    });
  });
});

describe('finding Antigravity', () => {
  /** `agy --version` answered by the scripted stand-in, printing `version`. */
  const fakeAgy = (version: string) => () =>
    parseVersion(
      execFileSync(process.execPath, [FAKE_AGY, '--version'], {
        encoding: 'utf8',
        env: { ...process.env, FAKE_AGY_VERSION: version },
      }),
    );

  it('reads the version the CLI prints, and looks at AGY_BIN before anything else', () => {
    const exe = path.join(ws().root, 'tools', process.platform === 'win32' ? 'agy.exe' : 'agy');
    mkdirSync(path.dirname(exe), { recursive: true });
    writeFileSync(exe, '');
    const found = findAntigravity(
      { AGY_BIN: exe, PATH: '', LOCALAPPDATA: path.join(ws().root, 'none') },
      fakeAgy('1.0.20'),
    );
    expect(found.cli).toEqual({ kind: 'cli', binary: exe, version: '1.0.20', source: 'AGY_BIN' });
    expect(found.checked[0]).toBe(exe);
    expect(parseVersion('agy 1.4.2\n')).toBe('1.4.2');
    expect(parseVersion('no version here')).toBeNull();
  });

  it.runIf(process.platform === 'win32')(
    'finds the per-user install under %LOCALAPPDATA%\\agy\\bin, and the App',
    () => {
      const local = path.join(ws().root, 'local');
      const exe = path.join(local, 'agy', 'bin', 'agy.exe');
      mkdirSync(path.dirname(exe), { recursive: true });
      writeFileSync(exe, '');
      const app = path.join(local, 'Programs', 'Antigravity', 'Antigravity.exe');
      mkdirSync(path.join(path.dirname(app), 'resources', 'app'), { recursive: true });
      writeFileSync(app, '');
      writeFileSync(path.join(path.dirname(app), 'resources', 'app', 'package.json'), '{"version":"2.24.0"}');
      const found = findAntigravity({ PATH: '', LOCALAPPDATA: local }, fakeAgy('1.4.2'));
      expect(found.cli).toEqual({ kind: 'cli', binary: exe, version: '1.4.2', source: 'per-user' });
      expect(found.app).toEqual({ kind: 'app', binary: app, version: '2.24.0', source: 'per-user' });
    },
  );

  it('says when nothing is found, when the CLI is too old, and when only the App is there', async () => {
    initProject();
    const none = await doctor({ cli: null, app: null, checked: [], shim: null });
    expect(check(none, 'ag.binary')).toMatchObject({
      status: 'warn',
      message: expect.stringMatching(/^Antigravity not found/),
    });
    const old = await doctor(cli('1.0.20'));
    expect(check(old, 'ag.binary')).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('older than 1.1.1'),
    });
    const appOnly = await doctor({
      cli: null,
      app: { kind: 'app', binary: 'Antigravity.exe', version: null, source: 'per-user' },
      checked: [],
      shim: null,
    });
    expect(check(appOnly, 'ag.binary')?.message).toBe(
      'Antigravity App (version unknown) at Antigravity.exe; it reads the same .agents files as the CLI',
    );
  });
});
