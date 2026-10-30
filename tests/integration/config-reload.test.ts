/**
 * config.yaml read again while Friday runs (plan M11.2): a key read where it is used applies to
 * the next use, a key captured at start is named as needing a restart, and a file caught half
 * written or left invalid changes nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { GenericHarnessClient } from '@friday/adapter-generic';
import { buildBrainContext } from '@friday/daemon';
import type { TaskView, UiSnapshot } from '@friday/protocol';
import { changedConfigKeys, configKeyEffect, liveConfig, parseConfig, renderInitialConfig } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ConfigApplied, reloadingConfig } from '../../apps/daemon/src/config-reload.js';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, TEST_PROJECT_ID, type TestDaemon } from '../helpers/daemon.js';
import { decisionOf, postHook, toolHook } from '../helpers/hooks.js';

const ws = useTestWorkspace();
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
});

const configPath = () => path.join(ws().fridayDir, 'config.yaml');
/** Rewrites config.yaml as an editor does: the whole file at once. */
const editConfig = (edit: (yaml: string) => string) =>
  writeFileSync(configPath(), edit(readFileSync(configPath(), 'utf8')));
const snapshot = (td: TestDaemon) => td.operator.get<UiSnapshot>(td.operator.projectPath('/ui/snapshot'));
const SCOPE_BLOCK = 'scopes:\n  frontend:\n    write: ["frontend/**"]\n    read: []\n';

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A Claude Code session holding a task that may write anywhere, judged through the hooks. */
async function session(td: TestDaemon) {
  const pid = 8201;
  const sessionId = 'sess-config';
  const client = new GenericHarnessClient(td.bootstrap, {
    harness_key: `claude-code:${td.project.project_id}:pid:${pid}`,
    vendor: 'claude-code',
    name: 'Claude Code',
    version: '2.1.296',
    adapter_version: '0.1.0',
    attach_mode: 'attach',
    project_id: td.project.project_id,
    capabilities: { hooks: true },
    agent_key: 'be-1',
    role: 'backend',
    host: { pid, session_id: sessionId, cwd: ws().projectDir },
  });
  await client.register();
  const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
  const vars = { projectDir: ws().projectDir, sessionId };
  await postHook(
    daemon,
    'SessionStart',
    { session_id: sessionId, cwd: vars.projectDir, hook_event_name: 'SessionStart', source: 'startup' },
    { claudePid: pid },
  );
  const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary: 'backend work',
    scope: { write: ['**'], read: [] },
    assign_agent_key: 'be-1',
  });
  await client.claim({ task_id: task.task_id });
  const pre = async (tool: string, input: Record<string, unknown>) => {
    const res = await postHook(daemon, 'PreToolUse', toolHook('PreToolUse', tool, input, vars), { claudePid: pid });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return decisionOf(res.body.hook_output) ?? { decision: 'allow', reason: '' };
  };
  return { task, pre };
}

describe('config.yaml read again while Friday runs', () => {
  it('applies a tightened autonomy and a new scope to the next tool call, and names a changed port as needing a restart', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { pre } = await session(td);
    expect((await pre('Bash', { command: 'npm test' })).decision).toBe('allow');
    const pid = td.project.project_id;

    // The Master Brain's replan limit as Friday started with it.
    expect(td.daemon.brain?.status().max_replans).toBe(3);

    // The human tightens a command class, names a scope, raises the Master Brain's replan limit and
    // fixes the port, in one save.
    editConfig(
      (y) =>
        `${y
          .replace('  port: 0', '  port: 4567')
          .replace('scopes: {}\n', SCOPE_BLOCK)
          .replace(/( {2}model: auto[^\n]*\n)/, '$1  max_replans: 7\n')}autonomy:\n  test.local: manual\n`,
    );
    expect((await pre('Bash', { command: 'npm test' })).decision).toBe('deny');
    // The scope is in force for everything that reads the project's configuration.
    expect(td.project.config.scopes.frontend?.write).toEqual(['frontend/**']);
    expect(
      buildBrainContext(td.daemon.state, td.project, { redactor: td.daemon.state.redactor, stateDir: ws().stateDir }),
    ).toContain('frontend: write frontend/**');
    // The Master Brain reads its thresholds at each use: the next planning pass has the new limit.
    expect(td.daemon.brain?.status().max_replans).toBe(7);
    // The port was captured at start: it keeps its value, and is named.
    expect(td.project.config.daemon.port).toBe(0);
    const snap = await snapshot(td);
    expect(snap.config.changes).toEqual({
      applied: expect.arrayContaining(['scopes.frontend', 'master_brain.max_replans', 'autonomy.test.local']),
      restart_needed: ['daemon.port'],
      error: null,
    });
    expect(snap.config.changes?.applied).toHaveLength(3);
    expect(snap.config.loaded_hash).not.toBe(snap.config.current_hash);

    // `friday status` says the same, in words and as data, from the status route itself.
    const status = await cli(['--project', ws().projectDir, 'status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('daemon.port needs a restart to apply');
    expect(status.stdout).toMatch(/applied while running: .*scopes\.frontend/);
    expect(status.stdout).toContain('master_brain.max_replans');
    expect(status.stdout).toContain('autonomy.test.local');
    const asJson = await cli(['--project', ws().projectDir, '--json', 'status']);
    expect((JSON.parse(asJson.stdout) as UiSnapshot).config.changes?.restart_needed).toEqual(['daemon.port']);

    // Each read that changed something is recorded as a `config.reloaded` observation.
    const recorded = td.daemon.state.store.readSince(pid, 0, { types: ['config.reloaded'] });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toEqual({
      applied: expect.arrayContaining(['scopes.frontend', 'master_brain.max_replans', 'autonomy.test.local']),
      restart_needed: ['daemon.port'],
      hash: snap.config.current_hash,
    });
    const policyLog = readFileSync(path.join(ws().fridayDir, 'logs', 'daemon.jsonl'), 'utf8');
    expect(policyLog).toContain('"why":"config.yaml changed"');
    expect(policyLog).not.toContain('config.reloaded was not recorded');

    // Changed back: nothing waits for a restart any more, and the banner has nothing to say.
    editConfig((y) => y.replace('  port: 4567', '  port: 0'));
    expect((await snapshot(td)).config.changes).toEqual({
      applied: expect.arrayContaining(['scopes.frontend', 'master_brain.max_replans', 'autonomy.test.local']),
      restart_needed: [],
      error: null,
    });
    expect((await cli(['--project', ws().projectDir, 'status'])).stdout).not.toContain('restart');
    expect(td.daemon.state.store.readSince(pid, 0, { types: ['config.reloaded'] })).toHaveLength(2);
  });

  it('applies a loosening written to config.yaml only once this clone trusts it (ADR-0028)', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { pre } = await session(td);
    expect((await pre('Bash', { command: 'git push' })).decision).toBe('deny');
    expect((await snapshot(td)).policy_untrusted).toBe(false);

    // The tracked file asks for pushes without review: read again at once, applied only after trust.
    editConfig((y) => `${y}autonomy:\n  git.push: auto\n`);
    expect((await pre('Bash', { command: 'git push' })).decision).toBe('deny');
    const snap = await snapshot(td);
    expect(snap.config.changes).toEqual({ applied: ['autonomy.git.push'], restart_needed: [], error: null });
    expect(snap.policy_untrusted).toBe(true);
    const shown = await cli(['--project', ws().projectDir, 'policy', 'show']);
    expect(shown.stdout).toContain('autonomy.git.push');

    // Trusted on this clone: the next judgment allows it.
    expect((await cli(['--project', ws().projectDir, 'policy', 'trust', '--yes'])).code).toBe(0);
    expect((await pre('Bash', { command: 'git push' })).decision).toBe('allow');
    expect((await snapshot(td)).policy_untrusted).toBe(false);
  });

  it('applies new checks, conflict-prone files and routing settings while sessions run', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const P = (p: string) => td.operator.projectPath(p);
    const task = await td.operator.post<TaskView>(P('/tasks'), {
      summary: 'write the guide',
      kind: 'docs',
      scope: { write: ['docs/**'], read: [] },
    });
    const explain = () =>
      td.operator.get<{ dry_run: { mode: string; reason: string } }>(P(`/routing/explain/${task.task_id}`));
    expect((await explain()).dry_run.mode).toBe('hybrid');
    expect((await snapshot(td)).verification.checks).toEqual([]);

    editConfig(
      (y) =>
        `${y.replace('  checks: []\n', '  checks:\n    - name: tests\n      command: node\n      args: ["--test"]\n')}` +
        'reservations:\n  required: ["package.json"]\n' +
        'routing:\n  mode: manual\n  default_model: claude-haiku-5-5\n' +
        'recovery:\n  max_retries: 0\n',
    );
    const snap = await snapshot(td);
    expect(snap.verification.checks).toEqual([{ name: 'tests', kind: 'test', required: true }]);
    expect(snap.config.changes).toEqual({
      applied: expect.arrayContaining([
        'verification.checks',
        'reservations.required',
        'routing.mode',
        'routing.default_model',
        'recovery.max_retries',
      ]),
      restart_needed: [],
      error: null,
    });
    const reservations = await td.operator.get<{ required: string[] }>(P('/file-reservations'));
    expect(reservations.required).toEqual(['package.json']);
    const routed = (await explain()).dry_run;
    expect(routed.mode).toBe('manual');
    expect(routed.reason).toContain('claude-haiku-5-5');
    expect(td.project.config.recovery.max_retries).toBe(0);
  });

  it('turns static registry dispatch on and merges project role candidates on a live reload', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const P = (p: string) => td.operator.projectPath(p);
    const task = await td.operator.post<TaskView>(P('/tasks'), {
      summary: 'write the guide',
      kind: 'docs',
      scope: { write: ['docs/**'], read: [] },
    });
    const explain = () =>
      td.operator.get<{
        dry_run: {
          source: string;
          model: string | null;
          blocked: boolean;
          reason: string;
          role: string | null;
          role_source: string;
          registry_version: string | null;
          selected_rank: number | null;
          selected_harness: string | null;
          candidates: Array<{ model: string; reasons: string[] }>;
        };
      }>(P(`/routing/explain/${task.task_id}`));
    expect((await explain()).dry_run).toMatchObject({ registry_version: null });
    expect((await explain()).dry_run.source).not.toBe('registry');

    editConfig(
      (y) =>
        `${y}routing:\n` +
        '  static_registry:\n    enabled: true\n' +
        '  must_use_local: true\n' +
        '  role_candidates:\n    docs:\n      - { model: local-coder, harness: generic }\n' +
        '  models:\n    - { id: local-coder, provider: local, vendors: [generic], local: true }\n',
    );
    const snap = await until(
      () => snapshot(td),
      (s) => s.config.changes?.applied.some((key) => key.startsWith('routing.static_registry')) ?? false,
      'the registry flag to apply',
    );
    expect(snap.config.changes?.restart_needed).toEqual([]);
    const enabled = (await explain()).dry_run;
    // A dry run has no harness to confirm a local-only constraint, so it blocks rather than claiming
    // the model was applied; the merged registry still names the project's candidate as the route.
    expect(enabled).toMatchObject({
      source: 'none',
      model: null,
      blocked: true,
      role: 'docs',
      role_source: 'kind_fallback',
      registry_version: '2026-10-21.2',
      selected_rank: 3,
      selected_harness: 'generic',
    });
    expect(enabled.reason).toContain('must hold');
    expect(enabled.candidates).toContainEqual(
      expect.objectContaining({
        model: 'local-coder',
        reasons: ['registry.rank(3)', 'registry.harness(generic)'],
      }),
    );
  });

  it('keeps the settings in force while the file is invalid, says so once it stood still, and applies the fix', async () => {
    const td = await startTestDaemon(ws());
    const valid = readFileSync(configPath(), 'utf8');
    writeFileSync(configPath(), `${valid}autonomy:\n  test.local: [\n`);
    // The daemon waits a second for a file that may still be written, then reports it.
    const reported = await until(
      () => snapshot(td),
      (s) => (s.config.changes?.error ?? null) !== null,
      'the parse error to be reported',
    );
    expect(reported.config.changes?.error).toContain('config.yaml is not valid YAML');
    expect(td.project.config.autonomy).toEqual({});
    // Every `friday` command reads the file to find the project, so the CLI says the same itself.
    const status = await cli(['--project', ws().projectDir, 'status']);
    expect(status.code).not.toBe(0);
    expect(status.stderr).toContain('config.yaml is not valid YAML');

    // Fixed: the file applies at once, and the error is gone.
    writeFileSync(configPath(), `${valid}autonomy:\n  test.local: manual\n`);
    expect((await snapshot(td)).config.changes).toEqual({
      applied: ['autonomy.test.local'],
      restart_needed: [],
      error: null,
    });
    expect(td.project.config.autonomy).toEqual({ 'test.local': 'manual' });
  });
});

describe('which keys apply live', () => {
  it('classifies each changed key by the most specific declared prefix', () => {
    expect(configKeyEffect('scopes.frontend.write')).toBe('live');
    expect(configKeyEffect('autonomy.git.push')).toBe('live');
    expect(configKeyEffect('verification.checks')).toBe('live');
    expect(configKeyEffect('routing.laya.url')).toBe('live');
    expect(configKeyEffect('recovery.max_retries')).toBe('live');
    expect(configKeyEffect('master_brain.auto_approve')).toBe('live');
    expect(configKeyEffect('master_brain.reservation_ttl_ms')).toBe('live');
    expect(configKeyEffect('master_brain.model')).toBe('live');
    expect(configKeyEffect('master_brain.effort')).toBe('live');
    expect(configKeyEffect('master_brain.max_tokens')).toBe('live');
    expect(configKeyEffect('master_brain.escalate_after_failures')).toBe('live');
    expect(configKeyEffect('master_brain.max_replans')).toBe('live');
    expect(configKeyEffect('master_brain.provider')).toBe('restart');
    expect(configKeyEffect('master_brain.fake_responses')).toBe('restart');
    expect(configKeyEffect('daemon.port')).toBe('restart');
    expect(configKeyEffect('leases.lease_ttl_ms')).toBe('restart');
    expect(configKeyEffect('worktrees.mode')).toBe('restart');
    expect(configKeyEffect('providers.anthropic.allow_remote')).toBe('restart');
    expect(configKeyEffect('project.name')).toBe('restart');
    // A key Friday does not know was captured by nothing.
    expect(configKeyEffect('somebody_elses_section.flag')).toBe('live');
  });

  it('names changed keys as dotted paths and keeps the restart-only ones at their start values', () => {
    const base = renderInitialConfig(TEST_PROJECT_ID, 'p');
    const started = parseConfig(base);
    const next = parseConfig(
      base
        .replace('  port: 0', '  port: 4567')
        .replace('scopes: {}\n', SCOPE_BLOCK)
        .replace(/ {2}provider: anthropic[^\n]*\n/, '  provider: none\n')
        .replace(/ {2}auto_approve: false[^\n]*\n/, '  auto_approve: true\n'),
    );
    const changed = changedConfigKeys(started, next);
    expect(changed).toEqual(
      expect.arrayContaining(['daemon.port', 'scopes.frontend', 'master_brain.provider', 'master_brain.auto_approve']),
    );
    expect(changed).toHaveLength(4);
    const live = liveConfig(started, next);
    expect(live.daemon.port).toBe(0);
    expect(live.master_brain.provider).toBe('anthropic');
    expect(live.master_brain.auto_approve).toBe(true);
    expect(live.scopes.frontend?.write).toEqual(['frontend/**']);
    expect(changedConfigKeys(started, live)).toEqual(
      expect.arrayContaining(['scopes.frontend', 'master_brain.auto_approve']),
    );
    expect(changedConfigKeys(started, live)).toHaveLength(2);
    expect(changedConfigKeys(started, started)).toEqual([]);
  });
});

describe('the reloader', () => {
  it('says nothing about a file that may be half written until it stood still, then reports it, and applies a valid file at once', () => {
    const dir = path.join(ws().root, 'reload');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'config.yaml');
    const base = renderInitialConfig(TEST_PROJECT_ID, 'p');
    writeFileSync(file, base);
    let now = 0;
    const applied: ConfigApplied[] = [];
    const errors: string[] = [];
    const r = reloadingConfig({
      file,
      initial: parseConfig(base),
      onApply: (c) => applied.push(c),
      onError: (e) => errors.push(e),
      now: () => now,
      settleMs: 1000,
    });
    expect(r.changes()).toEqual({ applied: [], restart_needed: [], error: null });

    // Caught half written (a comment and nothing else): the configuration in force stays, quietly.
    writeFileSync(file, base.slice(0, 40));
    expect(r.current().project.id).toBe(TEST_PROJECT_ID);
    now += 600;
    r.current();
    expect(errors).toEqual([]);
    expect(r.changes().error).toBeNull();
    // Stood still for a second and still unreadable: reported once, nothing dropped.
    now += 500;
    r.current();
    r.current();
    expect(errors).toHaveLength(1);
    expect(r.changes().error).toContain('config.yaml is invalid');
    expect(applied).toEqual([]);

    // The finished write applies at once: the live key in force, the port named, the error gone.
    const edited = base.replace('  port: 0', '  port: 4567').replace('scopes: {}\n', SCOPE_BLOCK);
    writeFileSync(file, edited);
    const cfg = r.current();
    expect(cfg.daemon.port).toBe(0);
    expect(cfg.scopes.frontend?.write).toEqual(['frontend/**']);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ applied: ['scopes.frontend'], restart_needed: ['daemon.port'] });
    expect(applied[0]?.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.changes()).toEqual({ applied: ['scopes.frontend'], restart_needed: ['daemon.port'], error: null });

    // A comment changes nothing worth recording; the port set back leaves nothing waiting.
    writeFileSync(file, `${edited}# a note\n`);
    r.current();
    expect(applied).toHaveLength(1);
    writeFileSync(file, base.replace('scopes: {}\n', SCOPE_BLOCK));
    r.current();
    expect(applied).toHaveLength(2);
    expect(applied[1]).toMatchObject({ applied: [], restart_needed: [] });
    expect(r.changes()).toEqual({ applied: ['scopes.frontend'], restart_needed: [], error: null });
  });
});
