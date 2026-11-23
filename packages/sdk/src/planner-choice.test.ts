import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privateDirFor } from './discovery.js';
import { choosePlanner, choosePlannerModel, plannerChoice, plannerModelChoice } from './provider-trust.js';

/** How a person plans and with which model, kept on their machine (`planner.json`), in a temporary state folder. */

const ref = { project_key: 'proj_test-00000000' };
let state: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  state = mkdtempSync(path.join(tmpdir(), 'friday-planner-'));
  env = { FRIDAY_STATE_DIR: state };
});
afterEach(() => {
  rmSync(state, { recursive: true, force: true });
});
const file = () => path.join(privateDirFor(ref, env), 'planner.json');
const stored = () => JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>;

describe('the planner a machine chose, and its model', () => {
  it('keeps each when the other is set or handed back, and removes the file when nothing is left', () => {
    expect(plannerChoice(ref, env)).toBeNull();
    expect(plannerModelChoice(ref, env)).toBeNull();
    choosePlanner(ref, 'claude-code', env);
    choosePlannerModel(ref, 'claude-sonnet-5-5', env);
    expect(stored()).toEqual({ provider: 'claude-code', model: 'claude-sonnet-5-5' });
    // Another planner: the model stays.
    choosePlanner(ref, 'anthropic', env);
    expect(stored()).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    // The planner handed back to the project: the model stays, and the file with it.
    choosePlanner(ref, null, env);
    expect(plannerChoice(ref, env)).toBeNull();
    expect(plannerModelChoice(ref, env)).toBe('claude-sonnet-5-5');
    expect(stored()).toEqual({ model: 'claude-sonnet-5-5' });
    // The model handed back too: nothing of this machine's own is left.
    choosePlannerModel(ref, null, env);
    expect(existsSync(file())).toBe(false);
    choosePlannerModel(ref, null, env);
    choosePlanner(ref, null, env);
    expect(existsSync(file())).toBe(false);
  });

  it('takes a model name only, and reads a damaged file as no choice', () => {
    for (const bad of ['--help', '', 'two words', 'x'.repeat(101), 'a;b']) {
      expect(() => choosePlannerModel(ref, bad, env), bad).toThrow(/is not a model name/);
    }
    expect(existsSync(file())).toBe(false);
    choosePlannerModel(ref, 'openai/gpt-6.1-sol', env);
    expect(plannerModelChoice(ref, env)).toBe('openai/gpt-6.1-sol');
    writeFileSync(file(), JSON.stringify({ provider: 'gpt', model: '--yolo' }));
    expect(plannerChoice(ref, env)).toBeNull();
    expect(plannerModelChoice(ref, env)).toBeNull();
    writeFileSync(file(), '{ not json');
    expect(plannerChoice(ref, env)).toBeNull();
    expect(plannerModelChoice(ref, env)).toBeNull();
    writeFileSync(file(), '[1, 2]');
    expect(plannerModelChoice(ref, env)).toBeNull();
    // A choice made over a damaged file replaces it with a sound one.
    choosePlannerModel(ref, 'claude-opus-5-5', env);
    expect(stored()).toEqual({ model: 'claude-opus-5-5' });
    expect(() => choosePlanner(ref, 'fake' as never, env)).toThrow(/is not a planner this machine can choose/);
  });

  /**
   * A person without Claude plans too (2026-11-23): through Codex, with a key of another service,
   * or with a model on this machine. Each planner keeps its own model: a Claude model's name means
   * nothing to the others.
   */
  it('takes every way to plan, and keeps each planner’s own model apart', () => {
    for (const p of ['codex', 'openai', 'gemini', 'deepseek', 'openrouter', 'local'] as const) {
      choosePlanner(ref, p, env);
      expect(plannerChoice(ref, env)).toBe(p);
    }
    choosePlannerModel(ref, 'claude-fable-5-2', env);
    choosePlannerModel(ref, 'gpt-6.1-sol', env, 'codex');
    choosePlannerModel(ref, 'qwen2.5:7b', env, 'local');
    // The Claude planners share one choice; the others have their own.
    expect(plannerModelChoice(ref, env)).toBe('claude-fable-5-2');
    expect(plannerModelChoice(ref, env, 'anthropic')).toBe('claude-fable-5-2');
    expect(plannerModelChoice(ref, env, 'claude-code')).toBe('claude-fable-5-2');
    expect(plannerModelChoice(ref, env, 'codex')).toBe('gpt-6.1-sol');
    expect(plannerModelChoice(ref, env, 'local')).toBe('qwen2.5:7b');
    expect(plannerModelChoice(ref, env, 'openai')).toBeNull();
    expect(stored()).toEqual({
      provider: 'local',
      model: 'claude-fable-5-2',
      models: { codex: 'gpt-6.1-sol', local: 'qwen2.5:7b' },
    });
    // Taken back one at a time; nothing left of them leaves no empty list behind.
    choosePlannerModel(ref, null, env, 'codex');
    choosePlannerModel(ref, null, env, 'local');
    expect(stored()).toEqual({ provider: 'local', model: 'claude-fable-5-2' });
    expect(() => choosePlannerModel(ref, '--yolo', env, 'codex')).toThrow(/is not a model name/);
    // A damaged list reads as no choice.
    writeFileSync(file(), JSON.stringify({ models: { codex: '--yolo', local: 5 } }));
    expect(plannerModelChoice(ref, env, 'codex')).toBeNull();
    expect(plannerModelChoice(ref, env, 'local')).toBeNull();
  });
});
