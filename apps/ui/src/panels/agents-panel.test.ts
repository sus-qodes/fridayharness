import type { AgentProcess, AgentProfile } from '@friday/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../platform/transport.js';
import { makeContext } from '../test/context.js';
import { makeHarness, makeSnapshot, makeTask } from '../test/fixtures.js';
import { agentRows, agentsDrawer, claudeCodeStatus, PROCESS_POLL_MS, rowStatus } from './agents-panel.js';
import { BIDI, buttonBy, choose, controlBy, HOSTILE, LONG } from './test-support.js';

function proc(over: Partial<AgentProcess> = {}): AgentProcess {
  return {
    agent_key: 'claude-1',
    host: 'claude-code',
    role: 'developer',
    pid: 4242,
    status: 'running',
    started_at: '2026-10-17T09:59:00.000Z',
    ended_at: null,
    exit_code: null,
    options: { max_budget_usd: 1 },
    log_tail: [],
    shadow: false,
    ...over,
  };
}

function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    agent_key: 'claude-1',
    host: 'claude-code',
    role: 'developer',
    options: {},
    autostart: true,
    updated_at: 'x',
    ...over,
  };
}

const quiet = {
  'GET /agent-hosts': { hosts: [] },
  'GET /routing/pins': { pins: [] },
  'GET /models': { models: [{ id: 'claude-sonnet-5' }, { id: 'gpt-5.6' }], evidence: [], settings: {} },
};

describe('agents helpers', () => {
  it('joins processes and profiles by key', () => {
    const rows = agentRows({
      processes: [proc({ agent_key: 'b' }), proc({ agent_key: 'c' })],
      profiles: [profile({ agent_key: 'a' }), profile({ agent_key: 'b' })],
    });
    expect(rows.map((r) => [r.agent_key, !!r.process, !!r.profile])).toEqual([
      ['a', false, true],
      ['b', true, true],
      ['c', true, false],
    ]);
    expect(agentRows(null)).toEqual([]);
  });

  it('labels the status', () => {
    const row = (p: AgentProcess | null) => ({ agent_key: 'a', host: 'codex', role: 'r', process: p, profile: null });
    expect(rowStatus(row(null))).toEqual({ label: 'not running', tone: 'muted' });
    expect(rowStatus(row(proc()))).toEqual({ label: 'running', tone: 'good' });
    expect(rowStatus(row(proc({ status: 'exited', exit_code: 0 })))).toEqual({ label: 'exited', tone: 'muted' });
    expect(rowStatus(row(proc({ status: 'exited', exit_code: 3 })))).toEqual({
      label: 'exited (code 3)',
      tone: 'danger',
    });
  });

  it('reads the Claude Code in VS Code status from the harnesses', () => {
    expect(claudeCodeStatus([makeHarness()])).toMatchObject({ connected: false, harness: null });
    const attached = makeHarness({ attach_mode: 'attach', enforcement_status: 'enforcing' });
    expect(claudeCodeStatus([attached])).toMatchObject({ connected: true, hooksSeen: true });
    expect(
      claudeCodeStatus([
        makeHarness({ attach_mode: 'attach', enforcement_status: 'observed', enforcement_level: 'L0' }),
      ]),
    ).toMatchObject({
      connected: true,
      hooksSeen: false,
    });
  });
});

describe('agents drawer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the processes every 3 s while open and stops when closed', async () => {
    const ctx = makeContext({
      answers: { ...quiet, 'GET /agent-processes': { processes: [proc()], profiles: [profile()] } },
    });
    const d = agentsDrawer(ctx, { kind: 'agents' });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.transport.to('GET', '/agent-processes')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PROCESS_POLL_MS);
    expect(ctx.transport.to('GET', '/agent-processes')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(PROCESS_POLL_MS);
    expect(ctx.transport.to('GET', '/agent-processes')).toHaveLength(3);
    d.destroy();
    await vi.advanceTimersByTimeAsync(PROCESS_POLL_MS * 3);
    expect(ctx.transport.to('GET', '/agent-processes')).toHaveLength(3);
  });

  it('keeps a row (and its focus) across refreshes', async () => {
    const ctx = makeContext({
      answers: { ...quiet, 'GET /agent-processes': { processes: [proc()], profiles: [profile()] } },
    });
    const d = agentsDrawer(ctx, { kind: 'agents' });
    document.body.append(d.el);
    await vi.advanceTimersByTimeAsync(0);
    const stop = buttonBy(d.el, 'Stop');
    stop.focus();
    await vi.advanceTimersByTimeAsync(PROCESS_POLL_MS);
    expect(buttonBy(d.el, 'Stop')).toBe(stop);
    expect(document.activeElement).toBe(stop);
    d.destroy();
  });

  it('stops, starts again and forgets (after a confirmation)', async () => {
    let view = { processes: [proc()], profiles: [profile()] };
    const ctx = makeContext({
      answers: {
        ...quiet,
        'GET /agent-processes': () => view,
        'POST /agent-processes/claude-1/stop': () => {
          view = {
            processes: [proc({ status: 'exited', exit_code: 0, ended_at: '2026-10-17T10:00:00.000Z' })],
            profiles: [profile()],
          };
          return { process: view.processes[0] };
        },
        'POST /agent-processes/claude-1/start': { process: proc() },
        'POST /agent-processes/claude-1/forget': { ok: true },
      },
    });
    const d = agentsDrawer(ctx, { kind: 'agents' });
    await vi.advanceTimersByTimeAsync(0);
    expect(buttonBy(d.el, 'Start again').hidden).toBe(true);
    buttonBy(d.el, 'Stop').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.transport.to('POST', '/agent-processes/claude-1/stop')).toHaveLength(1);
    expect(d.el.textContent).toContain('exited');
    expect(buttonBy(d.el, 'Stop').hidden).toBe(true);
    buttonBy(d.el, 'Start again').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.transport.to('POST', '/agent-processes/claude-1/start')).toHaveLength(1);
    ctx.confirmAnswer = false;
    buttonBy(d.el, 'Forget').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.confirms[0]?.danger).toBe(true);
    expect(ctx.transport.to('POST', '/agent-processes/claude-1/forget')).toHaveLength(0);
    ctx.confirmAnswer = true;
    buttonBy(d.el, 'Forget').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.transport.to('POST', '/agent-processes/claude-1/forget')).toHaveLength(1);
    d.destroy();
  });

  it('shows a 409 as the daemon wrote it', async () => {
    const message = 'claude-1 is held by a live harness: Claude Code in VS Code (harness_hh01)';
    const ctx = makeContext({
      answers: {
        ...quiet,
        'GET /agent-processes': { processes: [], profiles: [profile()] },
        'POST /agent-processes/claude-1/start': () => {
          throw new ApiError(409, 'COS-2002', 'conflict', message);
        },
      },
    });
    const d = agentsDrawer(ctx, { kind: 'agents' });
    await vi.advanceTimersByTimeAsync(0);
    buttonBy(d.el, 'Start again').click();
    await vi.advanceTimersByTimeAsync(0);
    const err = d.el.querySelector('.pn-agent-row .field-error') as HTMLElement;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toBe(message);
    d.destroy();
  });

  it('shows hosts, harnesses, output and pins with hostile text as text', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({
        harnesses: [
          makeHarness({
            name: HOSTILE,
            observed_model: HOSTILE,
            requested_agent_key: BIDI,
            shadow: true,
            enforcement_basis: LONG,
          }),
        ],
        tasks: [makeTask({ summary: HOSTILE })],
      }),
      answers: {
        ...quiet,
        'GET /agent-hosts': {
          hosts: [
            { host: 'codex', found: false, version: null, supported: false, path: `C:/${BIDI}`, reason: HOSTILE },
          ],
        },
        'GET /agent-processes': {
          processes: [proc({ log_tail: [`\u001b[31m${HOSTILE}\u001b[0m`, LONG] })],
          profiles: [],
        },
        'GET /routing/pins': {
          pins: [
            {
              pin_id: 'pin1',
              scope: 'role',
              target: BIDI,
              model: HOSTILE,
              mode: null,
              sensitive: false,
              needs_vision: false,
              until: null,
              source: 'human',
              note: HOSTILE,
              created_at: 'x',
              revoked_at: null,
            },
          ],
        },
      },
    });
    const d = agentsDrawer(ctx, { kind: 'agents' });
    await vi.advanceTimersByTimeAsync(0);
    expect(d.el.querySelector('img')).toBeNull();
    const text = d.el.textContent ?? '';
    expect(text).toContain(HOSTILE);
    expect(text).toContain('⟨U+202E⟩');
    expect(text).not.toContain('\u202E');
    expect(text).not.toContain('\u001b');
    expect(text).toContain('shadow');
    // Log lines are shortened (cleanText + truncate), never cut mid-character.
    const log = d.el.querySelector('.pn-log')?.textContent ?? '';
    expect(log).toContain(`${'L'.repeat(1999)}…`);
    expect(log).not.toContain(LONG);
    d.destroy();
  });

  it('pins a model to a role and unpins', async () => {
    const ctx = makeContext({
      answers: {
        ...quiet,
        'GET /agent-processes': { processes: [], profiles: [] },
        'GET /routing/pins': {
          pins: [
            {
              pin_id: 'pin1',
              scope: 'kind',
              target: 'docs',
              model: 'gpt-5.6',
              mode: null,
              sensitive: false,
              needs_vision: false,
              until: null,
              source: 'human',
              note: null,
              created_at: 'x',
              revoked_at: null,
            },
          ],
        },
        'POST /routing/pins': { pin: {} },
        'POST /routing/pins/pin1/revoke': { pin: {} },
      },
    });
    const d = agentsDrawer(ctx, { kind: 'agents', tab: 'pins' });
    await vi.advanceTimersByTimeAsync(0);
    choose(controlBy<HTMLSelectElement>(d.el, 'Model'), 'gpt-5.6');
    buttonBy(d.el, /^Pin$/).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.transport.to('POST', '/routing/pins')[0]?.body).toEqual({
      scope: 'role',
      target: 'developer',
      model: 'gpt-5.6',
    });
    choose(controlBy<HTMLSelectElement>(d.el, 'Pin for'), 'kind');
    choose(controlBy<HTMLSelectElement>(d.el, 'Which'), 'review');
    buttonBy(d.el, /^Pin$/).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.transport.to('POST', '/routing/pins')[1]?.body).toMatchObject({ scope: 'kind', target: 'review' });
    buttonBy(d.el, 'Unpin the kind pin for docs').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.transport.to('POST', '/routing/pins/pin1/revoke')).toHaveLength(1);
    d.destroy();
  });

  it('opens Start agent and the Claude Code setup', async () => {
    const ctx = makeContext({ answers: { ...quiet, 'GET /agent-processes': { processes: [], profiles: [] } } });
    const d = agentsDrawer(ctx, { kind: 'agents' });
    buttonBy(d.el, 'Start agent').click();
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'start-agent' });
    buttonBy(d.el, 'Set up').click();
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'claude-setup' });
    expect(d.el.textContent).toContain('No agent is connected');
    ctx.board(makeSnapshot({ harnesses: [makeHarness({ attach_mode: 'attach', enforcement_status: 'enforcing' })] }));
    expect(d.el.querySelector('.pn-claude')?.textContent).toContain('L1 enforcing');
    d.destroy();
  });
});
