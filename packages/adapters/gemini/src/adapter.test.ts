import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import {
  finalFrom,
  geminiAttemptUsage,
  geminiHostUsage,
  geminiSpawnRules,
  systemSettingsFor,
  worktreeProblem,
} from './adapter.js';
import { GEMINI_HOOK_FILE, geminiHooks } from './templates.js';

const ws = useTestWorkspace();

describe("what a run cost, from the result's stats", () => {
  const stats = {
    total_tokens: 12_300,
    input_tokens: 12_000,
    output_tokens: 300,
    cached: 8000,
    input: 4000,
    duration_ms: 900,
    tool_calls: 3,
    models: {
      'gemini-flash': { total_tokens: 300, input_tokens: 250, output_tokens: 50, cached: 0, input: 250 },
      'gemini-pro': { total_tokens: 12_000, input_tokens: 11_750, output_tokens: 250, cached: 8000, input: 3750 },
    },
  };

  it("keeps the host's counts, names the model that took the most, and leaves what it does not name unknown", () => {
    expect(geminiHostUsage(stats, 'gemini-flash', 1)).toEqual({
      cost_usd: null,
      input_tokens: 12_000,
      output_tokens: 300,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: null,
      total_tokens: 12_300,
      turns: 1,
      model: 'gemini-pro',
    });
  });

  it('reads zeros summed over no model as unknown, never as nothing spent', () => {
    const none = geminiHostUsage(
      { ...stats, input_tokens: 0, output_tokens: 0, cached: 0, total_tokens: 0, models: {} },
      'gemini-pro',
      1,
    );
    expect(none).toMatchObject({
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      model: 'gemini-pro',
    });
    expect(geminiHostUsage(undefined, null, 1)).toMatchObject({ input_tokens: null, model: null });
  });

  it('adds up an attempt’s turns, and keeps a count no turn reported unknown', () => {
    const small = { ...stats, total_tokens: 100, input_tokens: 90, output_tokens: 10, cached: 0, tool_calls: 1 };
    expect(geminiAttemptUsage([stats, small], 'gemini-flash')).toEqual({
      cost_usd: null,
      input_tokens: 12_090,
      output_tokens: 310,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: null,
      total_tokens: 12_400,
      turns: 2,
      model: 'gemini-pro',
      tool_calls: 4,
    });
    expect(geminiAttemptUsage([undefined], 'gemini-pro')).toMatchObject({
      input_tokens: null,
      tool_calls: null,
      turns: 1,
      model: 'gemini-pro',
    });
  });
});

describe('the system settings of a spawned session', () => {
  const endpoint = { url: 'http://127.0.0.1:4100/mcp/run_x', secret: 'attempt-secret' };

  it("leave a machine's own system settings in force, and give a machine without them Friday's server alone", () => {
    // Gemini CLI loads a system settings file only when Administrators or SYSTEM own it, so a copy
    // the user owns could drop the administrator's settings: Friday makes none (LESSONS HX-15).
    const file = path.join(ws().root, 'system-settings.json');
    writeFileSync(
      file,
      '// the administrator\'s\n{"security":{"folderTrust":{"enabled":true}},"mcpServers":{"admin":{"command":"x"}}}',
    );
    expect(systemSettingsFor({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: file }, endpoint)).toBeNull();
    // A machine without system settings: Friday's server alone.
    expect(systemSettingsFor({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(ws().root, 'none.json') }, endpoint)).toEqual(
      {
        mcpServers: {
          friday: { httpUrl: endpoint.url, headers: { Authorization: 'Bearer attempt-secret' }, trust: true },
        },
      },
    );
  });

  it("names Friday's tools in the rules only for a session that has them", () => {
    expect(geminiSpawnRules(true)).toContain('friday_communicate');
    expect(geminiSpawnRules(false)).not.toMatch(/friday_[a-z]/);
    expect(geminiSpawnRules(false)).toContain('No human is in this session');
  });
});

describe('the final answer in the last message', () => {
  const answer = { status: 'completed', summary: 'did it', blocked_reason: '' };

  it('takes the JSON object alone, fenced, or after prose', () => {
    expect(finalFrom(JSON.stringify(answer))).toEqual({ ...answer, checks: [] });
    expect(finalFrom(`Done.\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``)).toEqual({ ...answer, checks: [] });
    expect(
      finalFrom(`All good. ${JSON.stringify({ ...answer, status: 'blocked', blocked_reason: 'need a key' })}`),
    ).toMatchObject({
      status: 'blocked',
      blocked_reason: 'need a key',
    });
  });

  it('reads prose as a claim with its text, which Friday still verifies', () => {
    expect(finalFrom('I changed a.ts.')).toEqual({
      status: 'completed',
      summary: 'I changed a.ts.',
      blocked_reason: '',
      checks: [],
    });
  });
});

describe('a worktree a spawned session may run in', () => {
  const settings = (dir: string, value: unknown) => {
    mkdirSync(path.join(dir, '.gemini'), { recursive: true });
    writeFileSync(path.join(dir, '.gemini', 'settings.json'), JSON.stringify(value));
  };
  const launcher = (dir: string) => {
    mkdirSync(path.dirname(path.join(dir, ...GEMINI_HOOK_FILE.split('/'))), { recursive: true });
    writeFileSync(path.join(dir, ...GEMINI_HOOK_FILE.split('/')), '// friday-hook-launcher-version: 0.2.0\n');
  };
  const home = () => path.join(ws().root, 'home');
  const env = () => ({ GEMINI_CLI_HOME: home(), GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(ws().root, 'none.json') });

  it("has Friday's hooks and launcher, committed by friday harness config gemini", () => {
    const dir = ws().projectDir;
    expect(worktreeProblem(dir, env())).toMatch(/\.gemini\/settings\.json is missing/);
    settings(dir, { hooks: { BeforeTool: geminiHooks().BeforeTool } });
    expect(worktreeProblem(dir, env())).toMatch(
      /lacks Friday's Gemini CLI hooks for SessionStart, AfterTool, AfterAgent, SessionEnd/,
    );
    settings(dir, { hooks: geminiHooks() });
    expect(worktreeProblem(dir, env())).toMatch(/no \.friday\/harness\/gemini\/hook\.mjs/);
    launcher(dir);
    expect(worktreeProblem(dir, env())).toBeNull();
  });

  it('refuses other BeforeTool hooks, which could rewrite a call after Friday judged it', () => {
    const dir = ws().projectDir;
    launcher(dir);
    const hooks = geminiHooks();
    settings(dir, {
      hooks: {
        ...hooks,
        BeforeTool: [
          ...(hooks.BeforeTool ?? []),
          { hooks: [{ type: 'command', name: 'rewriter', command: 'node rw.mjs' }] },
        ],
      },
    });
    expect(worktreeProblem(dir, env())).toMatch(/other BeforeTool hooks \(rewriter\)/);
  });

  it("refuses when a settings layer switches Friday's hooks off", () => {
    const dir = ws().projectDir;
    launcher(dir);
    settings(dir, { hooks: geminiHooks() });
    mkdirSync(path.join(home(), '.gemini'), { recursive: true });
    writeFileSync(
      path.join(home(), '.gemini', 'settings.json'),
      JSON.stringify({ hooksConfig: { disabled: ['friday'] } }),
    );
    expect(worktreeProblem(dir, env())).toMatch(
      /your user settings disable Friday's hooks \(hooksConfig\.disabled: friday\)/,
    );
    writeFileSync(path.join(home(), '.gemini', 'settings.json'), JSON.stringify({ hooksConfig: { enabled: false } }));
    expect(worktreeProblem(dir, env())).toMatch(/switch hooks off/);
  });
});
