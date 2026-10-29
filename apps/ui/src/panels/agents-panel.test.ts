import type { AgentProcess, AgentProfile } from '@friday/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enforcementWords } from '../model/status.js';
import { ApiError } from '../platform/transport.js';
import { makeContext } from '../test/context.js';
import { makeAgent, makeHarness, makeSnapshot } from '../test/fixtures.js';
import { agentRows, agentsDrawer, claudeCodeStatus, isConnected, PROCESS_POLL_MS, rowStatus } from './agents-panel.js';
import { BIDI, buttonBy, HOSTILE, LONG } from './test-support.js';

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

const FOUND = {
  hosts: [
    { host: 'claude-code', found: true, version: '2.1.301', supported: true, path: 'C:/bin/claude.exe', reason: null },
    { host: 'codex', found: false, version: null, supported: false, path: null, reason: 'not on PATH' },
  ],
};

const quiet = { 'GET /agent-hosts': FOUND };

function rows(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll('.pn-agent-row'));
}

/** The buttons of a row that are shown (not hidden). */
function shownButtons(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll('button'))
    .filter((b) => !b.hidden)
    .map((b) => b.textContent ?? '');
}

/** The badges of a row that are shown (a hidden one still has its text). */
function shownBadges(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll('.row > .badge'))
    .filter((b) => !(b as HTMLElement).hidden)
    .map((b) => b.textContent ?? '');
}

describe('agents helpers', () => {
  it('joins processes and profiles by key', () => {
    const rows = agentRows({
      processes: [proc({ agent_key: 'b' }), proc({ agent_key: 'c' })],
      profiles: [profile({ agent_key: 'a' }), profile({ agent_key: 'b' })],
    });
    expect(rows.map((r) => [r.agent_key, !!r.process, !!r.profile, r.origin])).toEqual([
      ['a', false, true, 'friday'],
      ['b', true, true, 'friday'],
      ['c', true, false, 'friday'],
    ]);
    expect(agentRows(null)).toEqual([]);
  });

  it('joins the board’s sessions into the same rows: a spawned one by its key, an attached one as its own row', () => {
    const spawned = makeHarness({ harness_id: 'hh01', requested_agent_key: 'claude-1' });
    const attached = makeHarness({
      harness_id: 'hh02',
      attach_mode: 'attach',
      requested_agent_key: 'claude-2',
      enforcement_status: 'enforcing',
    });
    const nameless = makeHarness({ harness_id: 'hh03', attach_mode: 'attach', requested_agent_key: null });
    const board = {
      agents: [makeAgent({ agent_key: 'claude-2', harness_id: 'hh02', role: 'reviewer' })],
      harnesses: [spawned, attached, nameless],
    };
    const r = agentRows({ processes: [proc()], profiles: [profile()] }, board);
    expect(r.map((x) => [x.id, x.agent_key, x.origin, !!x.process, x.harness?.harness_id ?? null, x.role])).toEqual([
      ['claude-1', 'claude-1', 'friday', true, 'hh01', 'developer'],
      ['claude-2', 'claude-2', 'attached', false, 'hh02', 'reviewer'],
      ['harness:hh03', '', 'attached', false, 'hh03', ''],
    ]);
    // Two sessions with one key: the connected one speaks for the row.
    const gone = makeHarness({ harness_id: 'old', status: 'DISCONNECTED' });
    const live = makeHarness({ harness_id: 'new', status: 'BUSY' });
    expect(agentRows(null, { agents: [], harnesses: [gone, live] })[0]?.harness?.harness_id).toBe('new');
    expect(agentRows(null, { agents: [], harnesses: [live, gone] })[0]?.harness?.harness_id).toBe('new');
    expect(isConnected(gone)).toBe(false);
    expect(isConnected(live)).toBe(true);
    expect(isConnected(makeHarness({ status: 'TERMINATED' }))).toBe(false);
  });

  it('labels the process state', () => {
    const row = (p: AgentProcess | null) => ({ process: p });
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

  it('keeps a row (and its focus) across refreshes and board changes', async () => {
    const ctx = makeContext({
      answers: { ...quiet, 'GET /agent-processes': { processes: [proc()], profiles: [profile()] } },
    });
    const d = agentsDrawer(ctx, { kind: 'agents' });
    document.body.append(d.el);
    await vi.advanceTimersByTimeAsync(0);
    const stop = buttonBy(d.el, 'Stop');
    stop.focus();
    await vi.advanceTimersByTimeAsync(PROCESS_POLL_MS);
    ctx.board(makeSnapshot({ harnesses: [makeHarness()] }));
    expect(buttonBy(d.el, 'Stop')).toBe(stop);
    expect(document.activeElement).toBe(stop);
    expect(rows(d.el)).toHaveLength(1);
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

  it('shows one list: an agent Friday started and one attached in VS Code, each with the controls that apply', async () => {
    const spawned = makeHarness({ harness_id: 'hh01', requested_agent_key: 'claude-1', status: 'BUSY' });
    const attached = makeHarness({
      harness_id: 'hh02',
      attach_mode: 'attach',
      requested_agent_key: 'claude-2',
      enforcement_status: 'enforcing',
      observed_model: 'claude-sonnet-5',
      enforcement_basis: 'Friday hooks from this session',
    });
    const ctx = makeContext({
      snapshot: makeSnapshot({
        agents: [makeAgent({ agent_key: 'claude-2', harness_id: 'hh02', role: 'reviewer' })],
        harnesses: [spawned, attached],
      }),
      answers: {
        ...quiet,
        'GET /agent-processes': {
          processes: [proc({ log_tail: ['hello'] })],
          profiles: [profile(), profile({ agent_key: 'codex-1', host: 'codex', autostart: false })],
        },
      },
    });
    const d = agentsDrawer(ctx, { kind: 'agents' });
    await vi.advanceTimersByTimeAsync(0);
    // One list, in key order; the old "Agents Friday started" and "Connected now" are gone.
    expect(d.el.textContent).not.toContain('Agents Friday started');
    expect(d.el.textContent).not.toContain('Connected now');
    expect(d.el.textContent).not.toContain('Routing pins');
    const [first, second, third] = rows(d.el) as [HTMLElement, HTMLElement, HTMLElement];
    expect(rows(d.el)).toHaveLength(3);
    // Friday started claude-1; its session is connected and busy; it runs; Stop and Output apply.
    expect(first.querySelector('.pn-agent-key')?.textContent).toBe('claude-1');
    expect(first.textContent).toContain('started by Friday');
    // The pod's words, not the level codes: the same session reads the same one click apart.
    expect(shownBadges(first)).toEqual(['connected', 'running', 'Reported']);
    expect(first.textContent).not.toContain('L1 reported');
    expect(first.querySelector('.badge-info')?.getAttribute('title')).toBe(enforcementWords('L1', 'reported').title);
    expect(first.textContent).toContain('busy');
    expect(first.textContent).toContain('model claude-haiku-5-5');
    expect(first.textContent).toContain('pid 4242');
    expect(first.textContent).toContain('starts with Friday');
    expect(first.textContent).toContain('max budget usd 1');
    expect(shownButtons(first)).toEqual(['Stop', 'Forget']);
    expect((first.querySelector('.pn-output') as HTMLElement).hidden).toBe(false);
    // The person attached claude-2 in VS Code: connected, enforcement and model shown, no process
    // state and none of Friday's process controls.
    expect(second.querySelector('.pn-agent-key')?.textContent).toBe('claude-2');
    expect(second.textContent).toContain('attached in VS Code');
    expect(shownBadges(second)).toEqual(['connected', 'Enforced']);
    expect(second.textContent).not.toContain('L1 enforcing');
    expect(second.textContent).toContain('role reviewer');
    expect(second.textContent).toContain('model claude-sonnet-5');
    expect(second.textContent).toContain('Friday hooks from this session');
    expect(second.textContent).not.toContain('not remembered');
    expect(shownButtons(second)).toEqual([]);
    expect((second.querySelector('.pn-output') as HTMLElement).hidden).toBe(true);
    // A remembered agent that is not running and not connected: Start again and Forget.
    expect(third.querySelector('.pn-agent-key')?.textContent).toBe('codex-1');
    expect(third.textContent).toContain('started by Friday');
    expect(shownBadges(third)).toEqual(['not connected', 'not running']);
    expect(third.textContent).toContain('started by hand');
    expect(shownButtons(third)).toEqual(['Start again', 'Forget']);
    // Start agent above the list, the Claude Code card below it.
    const order = Array.from(d.el.querySelectorAll('.section-title, .pn-actions .btn-primary')).map(
      (x) => x.textContent,
    );
    expect(order.indexOf('Start agent')).toBeLessThan(order.indexOf('Agents'));
    expect(order.indexOf('Agents')).toBeLessThan(order.indexOf('Claude Code in VS Code'));
    // The attached session leaves the board: its row goes, the others stay.
    ctx.board(makeSnapshot({ harnesses: [spawned] }));
    expect(rows(d.el).map((r) => r.querySelector('.pn-agent-key')?.textContent)).toEqual(['claude-1', 'codex-1']);
    d.destroy();
  });

  it('shows the installed hosts only when none is found, or when the check failed', async () => {
    const some = agentsDrawer(makeContext({ answers: { ...quiet, 'GET /agent-processes': {} } }), { kind: 'agents' });
    expect((some.el.querySelector('#pn-hosts') as HTMLElement).hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect((some.el.querySelector('#pn-hosts') as HTMLElement).hidden).toBe(true);
    some.destroy();

    const ctx = makeContext({
      answers: {
        'GET /agent-hosts': {
          hosts: [
            { host: 'claude-code', found: false, version: null, supported: false, path: null, reason: 'not on PATH' },
            { host: 'codex', found: false, version: null, supported: false, path: `C:/${BIDI}`, reason: HOSTILE },
          ],
        },
        'GET /agent-processes': {},
      },
    });
    const none = agentsDrawer(ctx, { kind: 'agents' });
    await vi.advanceTimersByTimeAsync(0);
    const hosts = none.el.querySelector('#pn-hosts') as HTMLElement;
    expect(hosts.hidden).toBe(false);
    expect(hosts.textContent).toContain('Installed hosts');
    expect(hosts.textContent).toContain('not on PATH');
    expect(hosts.textContent).toContain(HOSTILE);
    expect(hosts.textContent).toContain('⟨U+202E⟩');
    expect(hosts.querySelector('img')).toBeNull();
    buttonBy(hosts, 'Check again').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.transport.calls.filter((c) => c.path.includes('/agent-hosts?refresh=true'))).toHaveLength(1);
    none.destroy();

    const failing = agentsDrawer(
      makeContext({
        answers: {
          'GET /agent-hosts': () => {
            throw new Error('offline');
          },
          'GET /agent-processes': {},
        },
      }),
      { kind: 'agents' },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect((failing.el.querySelector('#pn-hosts') as HTMLElement).hidden).toBe(false);
    expect(failing.el.textContent).toContain('Could not check the hosts: offline');
    failing.destroy();
  });

  it('shows sessions and output with hostile text as text', async () => {
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
      }),
      answers: {
        ...quiet,
        'GET /agent-processes': {
          processes: [proc({ log_tail: [`\u001b[31m${HOSTILE}\u001b[0m`, LONG] })],
          profiles: [],
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
    // The shadow session's row shows its badge; the process row, whose session is none, hides it.
    const [processRow, shadowRow] = rows(d.el) as [HTMLElement, HTMLElement];
    expect(shownBadges(shadowRow)).toContain('shadow');
    expect(shownBadges(processRow)).not.toContain('shadow');
    expect(shadowRow.textContent).toContain('another session holds this key');
    // Log lines are shortened (cleanText + truncate), never cut mid-character.
    const log = d.el.querySelector('.pn-log')?.textContent ?? '';
    expect(log).toContain(`${'L'.repeat(1999)}…`);
    expect(log).not.toContain(LONG);
    d.destroy();
  });

  it('still shows the connected sessions when the processes could not be read', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ harnesses: [makeHarness({ attach_mode: 'attach' })] }),
      answers: {
        ...quiet,
        'GET /agent-processes': () => {
          throw new Error('offline');
        },
      },
    });
    const d = agentsDrawer(ctx, { kind: 'agents' });
    await vi.advanceTimersByTimeAsync(0);
    expect(rows(d.el)).toHaveLength(1);
    expect(d.el.textContent).toContain('Could not read the agents Friday started: offline');
    d.destroy();
  });

  it('opens Start agent and the Claude Code setup', async () => {
    const ctx = makeContext({ answers: { ...quiet, 'GET /agent-processes': { processes: [], profiles: [] } } });
    const d = agentsDrawer(ctx, { kind: 'agents' });
    buttonBy(d.el, 'Start agent').click();
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'start-agent' });
    buttonBy(d.el, 'Set up').click();
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'claude-setup' });
    await vi.advanceTimersByTimeAsync(0);
    expect(d.el.textContent).toContain('No agent yet');
    ctx.board(makeSnapshot({ harnesses: [makeHarness({ attach_mode: 'attach', enforcement_status: 'enforcing' })] }));
    expect(d.el.querySelector('.pn-claude')?.textContent).toContain('Enforced');
    expect(d.el.querySelector('.pn-claude')?.textContent).not.toContain('L1 enforcing');
    expect(d.el.querySelector('.pn-claude .badge')?.getAttribute('title')).toMatch(
      /^Enforcement level L1 \(enforcing\)/,
    );
    expect(d.el.textContent).not.toContain('No agent yet');
    d.destroy();
  });

  it('sends an old request for the pins to Settings → Routing, where they live now', () => {
    for (const tab of ['pins', 'routing']) {
      const ctx = makeContext({ answers: { ...quiet, 'GET /agent-processes': {} } });
      const d = agentsDrawer(ctx, { kind: 'agents', tab });
      expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings', tab: 'routing' });
      expect(d.el.textContent).not.toContain('Routing pins');
      expect(() => buttonBy(d.el, /^Pin$/)).toThrow();
      d.destroy();
    }
    const ctx = makeContext({ answers: { ...quiet, 'GET /agent-processes': {} } });
    const d = agentsDrawer(ctx, { kind: 'agents', tab: 'claude' });
    expect(ctx.store.select('ui').drawer).toBeNull();
    d.destroy();
  });
});
