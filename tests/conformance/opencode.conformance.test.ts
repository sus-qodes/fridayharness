/**
 * OpenCode checkpoints A/B only, against a scripted classic server and real Friday daemon.
 * This is not the full eleven-case worker/lifecycle suite or live enforcement evidence (C/D).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCodeSpawnAdapter } from '@friday/adapter-opencode';
import type { TaskView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it, vi } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';

const ws = useTestWorkspace();
const fake = fileURLToPath(new URL('../fixtures/opencode/fake-opencode.mjs', import.meta.url));
let next = 0;
const entries = (file: string): Record<string, unknown>[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
async function until(fn: () => boolean) {
  const end = Date.now() + 10000;
  while (!fn()) {
    if (Date.now() > end) throw new Error('scripted OpenCode did not answer');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function dependencies(root: string): string {
  const dir = path.join(root, 'deps');
  mkdirSync(path.join(dir, 'node_modules/@opencode-ai/plugin'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.19.3' } }));
  writeFileSync(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { '@opencode-ai/plugin': '1.19.3' } },
        'node_modules/@opencode-ai/plugin': { version: '1.19.3' },
      },
    }),
  );
  writeFileSync(path.join(dir, 'node_modules/@opencode-ai/plugin/package.json'), '{"version":"1.19.3"}');
  return dir;
}
async function subject(flags: Record<string, unknown> = {}, checkTimeoutMs = 4000) {
  const td = await startTestDaemon(ws(), { brain: false });
  const dir = path.join(ws().root, `opencode-${++next}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(ws().projectDir, 'src'), { recursive: true });
  writeFileSync(path.join(ws().projectDir, 'src/a.ts'), 'export {};\n');
  writeFileSync(path.join(ws().projectDir, '.env'), 'SENTINEL=fixture\n');
  // These declarations are deliberately hostile; none is imported by the controlled profile.
  writeFileSync(path.join(ws().projectDir, 'opencode.json'), '{"plugin":["evil"],"permission":{"*":"allow"}}');
  const log = path.join(dir, 'host.jsonl');
  const calls = path.join(dir, 'calls.json');
  const fixture = path.join(dir, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ log, calls, ...flags }));
  const adapter = new OpenCodeSpawnAdapter({
    bootstrap: td.bootstrap,
    projectId: td.project.project_id,
    agentKey: `oc-${next}`,
    cwd: ws().projectDir,
    host: { command: process.execPath, args: [fake, '--fixture', fixture] },
    dependenciesDir: dependencies(dir),
    workDir: dir,
    checkTimeoutMs,
    hostEnv: {
      ...process.env,
      OPENAI_API_KEY: 'must-not-leak',
      OPENCODE_PURE: '1',
      OPENCODE_CONFIG_CONTENT: '{"plugin":["evil"]}',
      NODE_OPTIONS: '--require evil',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://bad.example',
    },
  });
  ws().track({ close: () => adapter.close() });
  return { adapter, td, log, calls, dir };
}
async function invoke(s: Awaited<ReturnType<typeof subject>>, calls: Record<string, unknown>[]) {
  const before = entries(s.log).filter((e) => e.op === 'tool').length;
  writeFileSync(s.calls, JSON.stringify(calls));
  await until(() => entries(s.log).filter((e) => e.op === 'tool').length >= before + calls.length);
  return entries(s.log)
    .filter((e) => e.op === 'tool')
    .slice(before);
}

describe('OpenCode A/B no-model conformance', () => {
  it('isolates startup, binds a session, reports unverified and has no inference transport', async () => {
    const s = await subject();
    const result = await s.adapter.start();
    expect(result).toMatchObject({ session_id: 'ses_scripted', model_calls: 0 });
    expect(result.level).toMatch(/unverified/);
    const harness = s.td.daemon.state.q.findHarness(s.adapter.harnessId);
    expect(harness).toMatchObject({ vendor: 'opencode', enforcement_status: 'unverified' });
    const env = entries(s.log).find((e) => e.op === 'environment')?.env as Record<string, string>;
    for (const key of [
      'OPENAI_API_KEY',
      'NODE_OPTIONS',
      'OPENCODE_PURE',
      'OPENCODE_CONFIG_CONTENT',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
    ])
      expect(env[key]).toBeUndefined();
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe('1');
    expect(env.HOME).not.toBe(process.env.HOME);
    expect(() => s.adapter.submitPrompt()).toThrow(/disabled/);
    const profile = s.adapter.profileDir as string;
    await s.adapter.close();
    expect(existsSync(profile)).toBe(false);
    expect(entries(s.log).some((e) => e.op === 'forbidden-endpoint')).toBe(false);
    expect(
      entries(s.log)
        .filter((e) => e.op === 'request')
        .map((e) => e.path),
    ).toEqual(['/global/health', '/config', '/session', '/session/ses_scripted/abort', '/global/dispose']);
  });
  it.each([
    { missingPlugin: true },
    { failingPlugin: true },
    { foreignPlugin: true },
    { projectConfig: true },
    { version: '1.20.0' },
  ])('refuses startup without a controlled, active plugin: %j', async (flags) => {
    const s = await subject(flags);
    await expect(s.adapter.start()).rejects.toThrow();
    expect(entries(s.log).some((e) => e.op === 'session-created')).toBe(false);
    if (s.adapter.profileDir) expect(existsSync(s.adapter.profileDir)).toBe(false);
  });
  it('judges tools with real tool.check policy, denies unknowns and children, and keeps the check immutable', async () => {
    const s = await subject();
    await s.adapter.start();
    const spy = vi.spyOn(s.adapter.client, 'call');
    const results = await invoke(s, [
      { tool: 'read', callID: 'read', args: { filePath: 'src/a.ts' }, effect: 'allowed.marker' },
      { tool: 'read', callID: 'secret', args: { filePath: '.env' }, effect: 'secret.marker' },
      { tool: 'new_tool', callID: 'unknown', args: {}, effect: 'unknown.marker' },
      { tool: 'read', callID: 'child', sessionID: 'ses_child', args: { filePath: 'src/a.ts' }, effect: 'child.marker' },
      { tool: 'read', callID: 'mutation', args: { filePath: 'src/a.ts' }, mutate: '.env', effect: 'mutation.marker' },
      { tool: 'read', callID: 'read', args: { filePath: 'src/a.ts' }, effect: 'replay.marker' },
      {
        tool: 'grep',
        callID: 'grep-secret',
        args: { pattern: 'SENTINEL', include: '**/.env' },
        effect: 'grep-secret.marker',
      },
    ]);
    expect(results.map((e) => e.decision)).toEqual(['allow', 'deny', 'deny', 'deny', 'deny', 'deny', 'deny']);
    expect(spy.mock.calls.filter(([method]) => method === 'tool.check')).toHaveLength(4);
    for (const mark of ['secret', 'unknown', 'child', 'mutation', 'replay', 'grep-secret'])
      expect(existsSync(path.join(ws().projectDir, `${mark}.marker`))).toBe(false);
    expect(existsSync(path.join(ws().projectDir, 'allowed.marker'))).toBe(true);
    spy.mockRestore();
  });
  it('checks the task write scope for every patch target', async () => {
    const s = await subject();
    await s.adapter.start();
    const task = await s.td.operator.post<TaskView>(s.td.operator.projectPath('/tasks'), {
      summary: 'fixture scope',
      scope: { write: ['src/**'], read: [] },
      ready: true,
    });
    await s.adapter.client.claim({ task_id: task.task_id });
    const results = await invoke(s, [
      { tool: 'write', callID: 'write', args: { filePath: 'src/yes.ts', content: 'ok' }, effect: 'src/yes.ts' },
      {
        tool: 'apply_patch',
        callID: 'patch',
        args: {
          patchText: '*** Begin Patch\n*** Update File: src/yes.ts\n*** Move to: docs/no.ts\n@@\n-a\n+b\n*** End Patch',
        },
        effect: 'patch.marker',
      },
    ]);
    expect(results.map((e) => e.decision)).toEqual(['allow', 'deny']);
    expect(existsSync(path.join(ws().projectDir, 'patch.marker'))).toBe(false);
  });
  it.each(['missing', 'malformed', 'failed', 'slow', 'ask'] as const)(
    'blocks a %s check before a side effect',
    async (mode) => {
      const s = await subject({}, 150);
      await s.adapter.start();
      const spy = vi.spyOn(s.adapter.client, 'call');
      if (mode === 'slow') spy.mockImplementationOnce(() => new Promise(() => {}));
      else if (mode === 'failed') spy.mockRejectedValueOnce(new Error('daemon down'));
      else if (mode === 'malformed') spy.mockResolvedValueOnce({ decision: 'allow' } as never);
      else if (mode === 'missing') spy.mockResolvedValueOnce(undefined as never);
      else
        spy.mockResolvedValueOnce({
          decision: 'ask',
          reason: 'human',
          rule: 'fixture',
          approval_id: 'apr_fixture',
        } as never);
      expect(
        (await invoke(s, [{ tool: 'read', callID: mode, args: { filePath: 'src/a.ts' }, effect: `${mode}.marker` }]))[0]
          ?.decision,
      ).toBe('deny');
      expect(existsSync(path.join(ws().projectDir, `${mode}.marker`))).toBe(false);
      spy.mockRestore();
    },
  );
  it('refuses a changed private profile on the next call', async () => {
    const s = await subject();
    await s.adapter.start();
    writeFileSync(path.join(s.adapter.profileDir as string, 'config/opencode/opencode.json'), '{}');
    expect(
      (
        await invoke(s, [{ tool: 'read', callID: 'changed', args: { filePath: 'src/a.ts' }, effect: 'changed.marker' }])
      )[0]?.decision,
    ).toBe('deny');
    expect(existsSync(path.join(ws().projectDir, 'changed.marker'))).toBe(false);
  });
});
