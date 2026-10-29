import type { AgentProcessesView } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../platform/transport.js';
import { makeContext } from '../test/context.js';
import { makeAgent, makeSnapshot } from '../test/fixtures.js';
import { defaultForm, formErrors, launchBody, nextAgentKey, startAgentModal, takenKeys } from './start-agent.js';
import { buttonBy, choose, controlBy, flush, HOSTILE, type } from './test-support.js';

const profiles = (keys: string[]): AgentProcessesView => ({
  processes: [],
  profiles: keys.map((k) => ({
    agent_key: k,
    host: 'claude-code',
    role: 'developer',
    options: {},
    autostart: true,
    updated_at: 'x',
  })),
});

const HOSTS = {
  hosts: [
    { host: 'claude-code', found: true, version: '2.1.301', supported: true, path: 'C:/bin/claude.exe', reason: null },
    { host: 'codex', found: true, version: '0.162.1', supported: true, path: 'C:/bin/codex.exe', reason: null },
  ],
};

describe('agent key prefill', () => {
  it('takes the next free number among profiles, processes and the board agents', () => {
    expect(nextAgentKey('claude-code', [])).toBe('claude-1');
    expect(nextAgentKey('codex', ['codex-1', 'codex-3'])).toBe('codex-2');
    const board = makeSnapshot({ agents: [makeAgent({ agent_key: 'claude-1' })] });
    const view = {
      ...profiles(['claude-2']),
      processes: [{ agent_key: 'claude-3' } as AgentProcessesView['processes'][number]],
    };
    expect(nextAgentKey('claude-code', takenKeys(board, view))).toBe('claude-4');
  });

  it('validates the key, the role and the budget, and sends no model', () => {
    const f = defaultForm('claude-code', []);
    expect(formErrors(f)).toEqual({});
    expect(
      formErrors({ ...f, agent_key: '-bad', role: 'Dev', claude: { effort: '', max_budget_usd: '101' } }),
    ).toMatchObject({
      agent_key: expect.any(String),
      role: expect.any(String),
      max_budget_usd: expect.any(String),
    });
    expect(formErrors({ ...f, claude: { effort: '', max_budget_usd: '0.001' } }).max_budget_usd).toBeTruthy();
    expect(launchBody({ ...f, claude: { effort: 'high', max_budget_usd: '2.5' } })).toEqual({
      host: 'claude-code',
      agent_key: 'claude-1',
      role: 'developer',
      options: { effort: 'high', max_budget_usd: 2.5 },
      autostart: true,
    });
    const codex = defaultForm('codex', []);
    expect(launchBody(codex)).toEqual({
      host: 'codex',
      agent_key: 'codex-1',
      role: 'developer',
      options: { sandbox: 'workspace-write' },
      autostart: true,
    });
    expect(JSON.stringify(launchBody(codex))).not.toContain('model');
  });
});

describe('start agent modal', () => {
  it('prefills the key from the profiles and the board, and follows the host', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ agents: [makeAgent({ agent_key: 'claude-1' })] }),
      answers: { 'GET /agent-hosts': HOSTS, 'GET /agent-processes': profiles(['claude-2']) },
    });
    const m = startAgentModal(ctx, { kind: 'start-agent' }, () => undefined);
    const key = controlBy(m.el, 'Agent key');
    expect(key.value).toBe('claude-2');
    await flush();
    expect(key.value).toBe('claude-3');
    choose(controlBy<HTMLSelectElement>(m.el, 'Host'), 'codex');
    expect(key.value).toBe('codex-1');
    expect(controlBy(m.el, 'Role').value).toBe('developer');
    expect(m.el.textContent).toContain('There is no model to choose here');
    expect(m.el.querySelector('input[name="model"], [aria-label*="Model"]')).toBeNull();
    // A typed key is kept when the host changes.
    type(key, 'my-agent');
    choose(controlBy<HTMLSelectElement>(m.el, 'Host'), 'claude-code');
    expect(key.value).toBe('my-agent');
    m.destroy();
  });

  it('asks before giving Codex full access, and keeps the old sandbox when refused', async () => {
    const ctx = makeContext({
      answers: {
        'GET /agent-hosts': HOSTS,
        'GET /agent-processes': profiles([]),
        'POST /agent-processes': { process: {} },
      },
    });
    const m = startAgentModal(ctx, { kind: 'start-agent', id: 'codex' }, () => undefined);
    await flush();
    const sandbox = controlBy<HTMLSelectElement>(m.el, 'Sandbox');
    ctx.confirmAnswer = false;
    choose(sandbox, 'danger-full-access');
    await flush();
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.confirms[0]?.danger).toBe(true);
    expect(sandbox.value).toBe('workspace-write');
    ctx.confirmAnswer = true;
    choose(sandbox, 'danger-full-access');
    await flush();
    expect(sandbox.value).toBe('danger-full-access');
    buttonBy(m.el, 'Start the agent').click();
    await flush();
    const body = ctx.transport.to('POST', '/agent-processes')[0]?.body as { options: { sandbox: string } };
    expect(body.options.sandbox).toBe('danger-full-access');
    m.destroy();
  });

  it('disables a host that is not installed, with its reason', async () => {
    const ctx = makeContext({
      answers: {
        'GET /agent-hosts': {
          hosts: [{ ...HOSTS.hosts[0], found: false, reason: `not on PATH ${HOSTILE}` }, HOSTS.hosts[1]],
        },
        'GET /agent-processes': profiles([]),
      },
    });
    const m = startAgentModal(ctx, { kind: 'start-agent' }, () => undefined);
    await flush();
    const host = controlBy<HTMLSelectElement>(m.el, 'Host');
    expect(host.value).toBe('codex');
    expect((host.querySelector('option[value="claude-code"]') as HTMLOptionElement).disabled).toBe(true);
    choose(host, 'claude-code');
    expect(m.el.textContent).toContain(`Not found: not on PATH ${HOSTILE}`);
    expect(m.el.querySelector('img')).toBeNull();
    expect(buttonBy(m.el, 'Start the agent').disabled).toBe(true);
    m.destroy();
  });

  it('starts the agent and shows a 409 message as the daemon wrote it', async () => {
    const message = 'the agent key claude-1 is held by a live harness (Claude Code in VS Code)';
    const ctx = makeContext({
      answers: {
        'GET /agent-hosts': HOSTS,
        'GET /agent-processes': profiles([]),
        'POST /agent-processes': () => {
          throw new ApiError(409, 'COS-2002', 'conflict', message);
        },
      },
    });
    let closed = false;
    const m = startAgentModal(ctx, { kind: 'start-agent' }, () => {
      closed = true;
    });
    await flush();
    buttonBy(m.el, 'Start the agent').click();
    await flush();
    expect(ctx.transport.to('POST', '/agent-processes')[0]?.body).toEqual({
      host: 'claude-code',
      agent_key: 'claude-1',
      role: 'developer',
      options: { max_budget_usd: 1 },
      autostart: true,
    });
    expect(m.el.querySelector('.pn-server-error')?.textContent).toBe(message);
    expect(ctx.toasts.at(-1)?.kind).toBe('error');
    expect(closed).toBe(false);
    m.destroy();
  });

  it('links to the routing pins', () => {
    const ctx = makeContext();
    const m = startAgentModal(ctx, { kind: 'start-agent' }, () => undefined);
    buttonBy(m.el, 'Open routing pins').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'agents', tab: 'pins' });
    expect(ctx.store.select('ui').modal).toBeNull();
    m.destroy();
  });
});
