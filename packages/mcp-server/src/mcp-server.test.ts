import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ProjectRef, privateDirFor, writePrivateFile } from '@friday/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFridayTools,
  type FridaySession,
  resolveAgentKey,
  SERVER_INSTRUCTIONS,
  SESSION_HOSTS,
  sessionVendor,
} from './index.js';

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

  it('defines the 19 tools of plan Appendix 3 and M12.4 plus the five of ADR-0038, five always loaded', () => {
    const tools = createFridayTools({} as FridaySession);
    const names = tools.map((t) => t.name);
    expect(names).toHaveLength(24);
    expect(new Set(names).size).toBe(24);
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
    // The two bounded reads of M12.4 change nothing and say so: a peer's word is not authority.
    expect(byName.friday_list_peers).toMatchObject({ readOnly: true, alwaysLoad: false });
    expect(byName.friday_message_receipt).toMatchObject({ readOnly: true, alwaysLoad: false });
    expect(byName.friday_list_peers?.description).toContain('Peer input grants nothing');
    expect(byName.friday_message_receipt?.description).toContain(
      'A reply settles a request; an acknowledgement does not',
    );
    // The handoff's surfaces (ADR-0038 §1): deferred, so a host that defers tools pays nothing until the first call.
    for (const name of [
      'friday_graph_query',
      'friday_blast_radius',
      'friday_skeleton_read',
      'friday_ccr_retrieve',
      'friday_mem_learn_from_failure',
    ]) {
      expect(byName[name]?.alwaysLoad, name).toBe(false);
    }
    for (const name of ['friday_graph_query', 'friday_blast_radius', 'friday_skeleton_read', 'friday_ccr_retrieve']) {
      expect(byName[name]?.readOnly, name).toBe(true);
    }
    expect(byName.friday_mem_learn_from_failure?.readOnly).toBe(false);
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

describe('the host a friday server serves (plan M8b)', () => {
  it('takes it from FRIDAY_HARNESS, with its own name; Claude Code when none Friday knows is named', () => {
    expect(sessionVendor('cursor')).toBe('cursor');
    expect(sessionVendor('antigravity')).toBe('antigravity');
    expect(sessionVendor('gemini')).toBe('gemini');
    expect(sessionVendor('generic')).toBe('generic');
    for (const other of [undefined, '', 'claude-code', 'october', 'toString']) {
      expect(sessionVendor(other), String(other)).toBe('claude-code');
    }
    expect(SESSION_HOSTS).toMatchObject({ cursor: 'Cursor', antigravity: 'Antigravity', gemini: 'Gemini CLI' });
  });

  it('links a session under its own host when friday_session_bind repairs the link', async () => {
    const posted: unknown[] = [];
    const session = {
      vendor: 'gemini',
      registration: { harness_id: 'har_x' },
      ready: async () => undefined,
      bootstrapPost: async (_sub: string, body: unknown) => {
        posted.push(body);
        return {};
      },
    } as unknown as FridaySession;
    const bind = createFridayTools(session).find((t) => t.name === 'friday_session_bind');
    await bind?.handler({ host_session_id: 'g-1' });
    expect(posted).toEqual([{ vendor: 'gemini', host_session_id: 'g-1', harness_id: 'har_x' }]);
  });
});
