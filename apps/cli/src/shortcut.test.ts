import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectRef } from '@friday/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { harnessKeyOf } from './agent-launcher.js';
import { optionFlags, validateOptions } from './agent-profiles.js';
import { createShortcut } from './shortcut.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the project shortcut (plan M9 §5.12)', () => {
  it('runs the CLI with ui --start for this project, under a safe file name', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fr-sc-'));
    dirs.push(dir);
    const ref = {
      root: path.join(dir, 'shop'),
      name: 'shop: "main"',
      project_id: 'proj_x',
      project_key: 'k',
    } as unknown as ProjectRef;
    const [file] = createShortcut(ref, { dir });
    expect(file).toBeTruthy();
    expect(path.basename(file as string)).not.toMatch(/[:"]/);
    const text = readFileSync(file as string, 'utf8');
    expect(text).toContain('friday.mjs');
    expect(text).toContain('ui');
    expect(text).toContain('--start');
    expect(text).toContain(ref.root);
  });
});

describe('agent options (plan M9 §5.9)', () => {
  it('accept only known values, never a leading dash, and become one --name=value argument each', () => {
    expect(validateOptions('claude-code', {})).toEqual({ max_budget_usd: 1 });
    expect(validateOptions('codex', { effort: 'high', service_tier: 'priority' })).toEqual({
      effort: 'high',
      sandbox: 'workspace-write',
      service_tier: 'priority',
    });
    for (const [host, bad] of [
      ['codex', { sandbox: '--dangerously' }],
      ['codex', { effort: '-x' }],
      ['codex', { max_budget_usd: 5 }],
      ['claude-code', { sandbox: 'read-only' }],
      ['claude-code', { max_budget_usd: 500 }],
      ['claude-code', { effort: 'very high' }],
    ] as const) {
      expect(() => validateOptions(host, bad), JSON.stringify(bad)).toThrow();
    }
    expect(optionFlags('codex', { sandbox: 'read-only', effort: 'low' })).toEqual([
      '--effort=low',
      '--sandbox=read-only',
    ]);
    expect(optionFlags('claude-code', { max_budget_usd: 2 })).toEqual(['--max-budget-usd=2']);
  });

  it('give the Cursor CLI and Gemini CLI none, and refuse any (plan M8b)', () => {
    for (const host of ['cursor', 'gemini'] as const) {
      expect(validateOptions(host, {}), host).toEqual({});
      expect(optionFlags(host, {}), host).toEqual([]);
      for (const bad of [{ effort: 'high' }, { max_budget_usd: 1 }, { sandbox: 'read-only' }, { service_tier: 'x' }]) {
        expect(() => validateOptions(host, bad), `${host} ${JSON.stringify(bad)}`).toThrow();
      }
    }
  });

  it('spot a key another session holds by the harness key each host’s adapter registers with', () => {
    expect(harnessKeyOf('codex', 'proj_x', 'codex-1')).toBe('codex:proj_x:codex-1');
    for (const host of ['claude-code', 'cursor', 'gemini'] as const) {
      expect(harnessKeyOf(host, 'proj_x', 'a-1')).toBe(`${host}:proj_x:spawn:a-1`);
    }
  });
});
