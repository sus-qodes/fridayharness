import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ProjectRef, privateDirFor, writePrivateFile } from '@friday/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createFridayTools, type FridaySession, resolveAgentKey, SERVER_INSTRUCTIONS } from './index.js';

describe('friday MCP server definition', () => {
  it('keeps its instructions within what Claude Code always loads, critical lines first', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
    for (const tool of [
      'friday_whoami',
      'friday_task_claim',
      'friday_claim_done',
      'friday_request_permission',
      'friday_communicate',
    ]) {
      expect(SERVER_INSTRUCTIONS).toContain(tool);
    }
    expect(SERVER_INSTRUCTIONS.indexOf('friday_whoami')).toBeLessThan(SERVER_INSTRUCTIONS.indexOf('friday_claim_done'));
  });

  it('defines the 14 tools of plan Appendix 3, five of them always loaded', () => {
    const tools = createFridayTools({} as FridaySession);
    const names = tools.map((t) => t.name);
    expect(names).toHaveLength(14);
    expect(new Set(names).size).toBe(14);
    expect(names.every((n) => /^friday_[a-z_]+$/.test(n))).toBe(true);
    expect(
      tools
        .filter((t) => t.alwaysLoad)
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      'friday_check_inbox',
      'friday_claim_done',
      'friday_report_progress',
      'friday_task_claim',
      'friday_whoami',
    ]);
    for (const t of tools) expect(t.description.length, t.name).toBeGreaterThan(20);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.friday_whoami?.readOnly).toBe(true);
    expect(byName.friday_claim_done?.readOnly).toBe(false);
  });
});

describe('resolveAgentKey', () => {
  const saved = process.env.FRIDAY_STATE_DIR;
  const dirs: string[] = [];
  afterEach(() => {
    if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
    else process.env.FRIDAY_STATE_DIR = saved;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('prefers FRIDAY_AGENT, then the private agent.json, then dev-1', () => {
    const state = mkdtempSync(path.join(os.tmpdir(), 'fri-agent-'));
    dirs.push(state);
    process.env.FRIDAY_STATE_DIR = state;
    const ref = { project_key: 'proj_test-00000000' } as ProjectRef;
    expect(resolveAgentKey(ref)).toBe('dev-1');
    writePrivateFile(privateDirFor(ref), 'agent.json', JSON.stringify({ agent_key: 'dev-7' }));
    expect(resolveAgentKey(ref)).toBe('dev-7');
    expect(resolveAgentKey(ref, 'reviewer-2')).toBe('reviewer-2');
    expect(resolveAgentKey(undefined)).toBe('dev-1');
  });
});
