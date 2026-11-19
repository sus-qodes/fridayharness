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
    writeFileSync(file(), JSON.stringify({ provider: 'local', model: '--yolo' }));
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
    expect(() => choosePlanner(ref, 'local' as never, env)).toThrow(/is not a planner this machine can choose/);
  });
});
