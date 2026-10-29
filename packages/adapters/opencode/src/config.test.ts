import { mkdirSync, readFileSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { applyOpenCodePlan, planOpenCode } from './config.js';
import { controlledEnvironment, managedConfigProblem, verifyDependencies } from './profile.js';

const ws = useTestWorkspace();
describe('OpenCode configuration', () => {
  it('writes a declaration idempotently and removes only its owned declaration', () => {
    const opts = { projectDir: ws().projectDir };
    const plan = planOpenCode(opts);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.after).toContain('"mode": "preflight"');
    applyOpenCodePlan(plan);
    expect(planOpenCode(opts)).toEqual([]);
    applyOpenCodePlan(planOpenCode({ ...opts, remove: true }));
    expect(planOpenCode({ ...opts, remove: true })).toEqual([]);
  });
  it('refuses an apply if the declaration changed after planning', () => {
    const opts = { projectDir: ws().projectDir };
    applyOpenCodePlan(planOpenCode(opts));
    const changes = planOpenCode({ ...opts, remove: true });
    writeFileSync(changes[0]?.path as string, '{"owner":"friday","changed":true}');
    expect(() => applyOpenCodePlan(changes)).toThrow(/changed/);
  });
  it.each([true, false])('refuses a linked .friday path (target exists: %s)', (targetExists) => {
    const outside = path.join(ws().root, 'outside');
    if (targetExists) mkdirSync(outside, { recursive: true });
    rmdirSync(ws().fridayDir);
    symlinkSync(outside, path.join(ws().projectDir, '.friday'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => planOpenCode({ projectDir: ws().projectDir })).toThrow(/link/);
  });
  it('does not overwrite an unowned declaration', () => {
    const dir = path.join(ws().projectDir, '.friday/harness/opencode');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'config.json'), '{}');
    expect(() => planOpenCode({ projectDir: ws().projectDir })).toThrow(/unowned/);
    expect(readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe('{}');
  });
  it('does not inherit secrets, model credentials, preload, telemetry, proxy, home or config', () => {
    const env = controlledEnvironment(ws().root, process.execPath, {
      OPENAI_API_KEY: 'secret',
      FRIDAY_TOKEN: 'secret',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://bad.example',
      NODE_OPTIONS: '--require evil',
      OPENCODE_CONFIG_CONTENT: '{"plugin":["evil"]}',
      OPENCODE_PURE: '1',
      HTTP_PROXY: 'http://bad.example',
      HOME: 'bad',
      PATH: '.',
    });
    for (const key of [
      'OPENAI_API_KEY',
      'FRIDAY_TOKEN',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'NODE_OPTIONS',
      'OPENCODE_CONFIG_CONTENT',
      'OPENCODE_PURE',
      'HTTP_PROXY',
    ])
      expect(env[key]).toBeUndefined();
    expect(env.HOME).toBe(path.join(ws().root, 'home'));
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(env.OPENCODE_PERMISSION).toBe('{"*":"deny"}');
    expect(env.PATH?.split(path.delimiter)).not.toContain('.');
  });
  it('requires a preinstalled pinned dependency bundle without attempting an install', () => {
    expect(() => verifyDependencies(ws().root)).toThrow();
  });
  it('refuses administrator config instead of replacing it on Windows', () => {
    if (process.platform !== 'win32') return;
    const programData = path.join(ws().root, 'machine');
    mkdirSync(path.join(programData, 'opencode'), { recursive: true });
    writeFileSync(path.join(programData, 'opencode', 'opencode.json'), '{}');
    expect(managedConfigProblem({ ProgramData: programData })).toMatch(/refused/);
  });
});
