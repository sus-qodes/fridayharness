import type { AgentHost, AgentProcessesView, AgentProfile } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../platform/transport.js';
import { makeContext } from '../test/context.js';
import { makeAgent, makeSnapshot } from '../test/fixtures.js';
import {
  ANTIGRAVITY_OPTION_LABEL,
  BUDGET,
  COMING_SOON,
  defaultForm,
  formErrors,
  formOfProfile,
  launchBody,
  nextAgentKey,
  signInLine,
  startAgentModal,
  startsWithoutCap,
  takenKeys,
  updateBody,
} from './start-agent.js';
import { buttonBy, choose, controlBy, flush, HOSTILE, type } from './test-support.js';

const profile = (key: string, over: Partial<AgentProfile> = {}): AgentProfile => ({
  agent_key: key,
  host: 'claude-code',
  role: 'developer',
  options: {},
  autostart: true,
  updated_at: 'x',
  ...over,
});
const profiles = (keys: string[]): AgentProcessesView => ({ processes: [], profiles: keys.map((k) => profile(k)) });

const claude = (over: Partial<AgentHost> = {}): AgentHost => ({
  host: 'claude-code',
  found: true,
  version: '2.1.301',
  supported: true,
  path: 'C:/bin/claude.exe',
  reason: null,
  ...over,
});
const codex = (over: Partial<AgentHost> = {}): AgentHost => ({
  host: 'codex',
  found: true,
  version: '0.162.1',
  supported: true,
  path: 'C:/bin/codex.exe',
  reason: null,
  ...over,
});
const HOSTS = { hosts: [claude(), codex()] };

/** The amount of the spending limit, beside its choice. */
const amount = (el: HTMLElement) => el.querySelector('.pn-limit-amount input') as HTMLInputElement;

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

  it('validates the key, the role and the limit, and sends no model', () => {
    const f = defaultForm('claude-code', []);
    expect(formErrors(f)).toEqual({});
    expect(
      formErrors({
        ...f,
        agent_key: '-bad',
        role: 'Dev',
        claude: { effort: '', limit: 'set', max_budget_usd: '1001' },
      }),
    ).toMatchObject({
      agent_key: expect.any(String),
      role: expect.any(String),
      max_budget_usd: expect.any(String),
    });
    expect(
      formErrors({ ...f, claude: { effort: '', limit: 'set', max_budget_usd: '0.001' } }).max_budget_usd,
    ).toBeTruthy();
    // No limit: whatever stands in the amount is not judged, and null is what is sent.
    const none = { ...f, claude: { effort: '' as const, limit: 'none' as const, max_budget_usd: 'x' } };
    expect(formErrors(none)).toEqual({});
    expect(launchBody(none).options).toEqual({ max_budget_usd: null });
    expect(launchBody({ ...f, claude: { effort: 'high', limit: 'set', max_budget_usd: '2.5' } })).toEqual({
      host: 'claude-code',
      agent_key: 'claude-1',
      role: 'developer',
      options: { effort: 'high', max_budget_usd: 2.5 },
      autostart: true,
    });
    const cx = defaultForm('codex', []);
    expect(launchBody(cx)).toEqual({
      host: 'codex',
      agent_key: 'codex-1',
      role: 'developer',
      options: { sandbox: 'workspace-write' },
      autostart: true,
    });
    // Neither a model, nor the models and cost class the dialog no longer asks for.
    expect(JSON.stringify([launchBody(f), launchBody(cx)])).not.toMatch(/model|cost_class/);
  });

  it('starts the limit at none only for a sign-in that is not charged per attempt', () => {
    expect(startsWithoutCap('subscription')).toBe(true);
    for (const s of ['api_key', 'signed_in', 'none', 'unknown', undefined] as const) {
      expect(startsWithoutCap(s), String(s)).toBe(false);
    }
    expect(defaultForm('claude-code', []).claude).toMatchObject({
      limit: 'set',
      max_budget_usd: String(BUDGET.default),
    });
    expect(BUDGET.default).toBe(5);
  });

  it('says how a host is signed in, and nothing when Friday did not read it', () => {
    expect(signInLine(claude({ sign_in: 'subscription' }), 'Claude Code')).toContain('nothing is charged per attempt');
    expect(signInLine(claude({ sign_in: 'api_key' }), 'Claude Code')).toContain('each attempt is charged');
    expect(signInLine(claude({ sign_in: 'signed_in' }), 'Claude Code')).toBe('Signed in.');
    const none = signInLine(claude({ sign_in: 'none' }), 'Claude Code');
    expect(none).toContain('Friday found no sign-in for Claude Code');
    expect(none).toContain('start it anyway');
    expect(signInLine(claude({ sign_in: 'unknown' }), 'Claude Code')).toBeNull();
    expect(signInLine(claude(), 'Claude Code')).toBeNull();
    expect(signInLine(undefined, 'Claude Code')).toBeNull();
  });

  it('reads a remembered agent into the form, and keeps what the form no longer shows of it', () => {
    const old = profile('claude-1', {
      role: 'backend',
      autostart: false,
      options: { effort: 'high', max_budget_usd: 3, models: ['claude-sonnet-5-5'], cost_class: 'cheap' },
    });
    const f = formOfProfile(old);
    expect(f).toMatchObject({
      host: 'claude-code',
      agent_key: 'claude-1',
      role: 'backend',
      autostart: false,
      claude: { effort: 'high', limit: 'set', max_budget_usd: '3' },
    });
    expect(updateBody({ ...f, role: 'frontend' }, old)).toEqual({
      role: 'frontend',
      autostart: false,
      options: { effort: 'high', max_budget_usd: 3, models: ['claude-sonnet-5-5'], cost_class: 'cheap' },
    });
    // No limit by a person's choice is read as that; a limit nobody set shows the amount it would get.
    expect(formOfProfile(profile('a', { options: { max_budget_usd: null } })).claude.limit).toBe('none');
    expect(formOfProfile(profile('a')).claude).toMatchObject({ limit: 'set', max_budget_usd: String(BUDGET.default) });
    // Codex, with a value the form does not know left at its default.
    const cx = formOfProfile(
      profile('codex-1', {
        host: 'codex',
        options: { sandbox: 'read-only', effort: 'weird', service_tier: 'priority' },
      }),
    );
    expect(cx.codex).toEqual({ sandbox: 'read-only', windows_sandbox: '', effort: '', service_tier: 'priority' });
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
    // The boxes that could leave an agent without work are gone.
    const labels = Array.from(m.el.querySelectorAll('.field-label')).map((l) => l.textContent);
    expect(labels).not.toContain('Cost class');
    expect(labels).not.toContain('Models');
    // A typed key is kept when the host changes.
    type(key, 'my-agent');
    choose(controlBy<HTMLSelectElement>(m.el, 'Host'), 'claude-code');
    expect(key.value).toBe('my-agent');
    m.destroy();
  });

  it('offers the hosts that work, and lists the others as coming soon', async () => {
    const ctx = makeContext({ answers: { 'GET /agent-hosts': HOSTS, 'GET /agent-processes': profiles([]) } });
    const m = startAgentModal(ctx, { kind: 'start-agent' }, () => undefined);
    await flush();
    const host = controlBy<HTMLSelectElement>(m.el, 'Host');
    const options = Array.from(host.options).map((o) => [o.textContent, o.disabled]);
    expect(options).toEqual([
      ['Claude Code', false],
      ['Codex', false],
      ...COMING_SOON.map((name) => [`${name}: coming soon`, true]),
      [ANTIGRAVITY_OPTION_LABEL, true],
    ]);
    expect(COMING_SOON).toEqual(['OpenCode', 'Cursor CLI', 'Gemini CLI']);
    // A link that names one of them (an older deep link) opens on a host that works.
    const other = startAgentModal(ctx, { kind: 'start-agent', id: 'gemini' }, () => undefined);
    expect(controlBy<HTMLSelectElement>(other.el, 'Host').value).toBe('claude-code');
    other.destroy();
    m.destroy();
  });

  it('sets no limit for a subscription, a limit where attempts are charged, and keeps what the person chose', async () => {
    const start = async (hosts: AgentHost[]) => {
      const ctx = makeContext({
        answers: {
          'GET /agent-hosts': { hosts },
          'GET /agent-processes': profiles([]),
          'POST /agent-processes': { process: {} },
        },
      });
      const m = startAgentModal(ctx, { kind: 'start-agent' }, () => undefined);
      await flush();
      return { ctx, m };
    };
    const sent = (ctx: ReturnType<typeof makeContext>) =>
      (ctx.transport.to('POST', '/agent-processes')[0]?.body as { options: unknown } | undefined)?.options;

    const sub = await start([claude({ sign_in: 'subscription' }), codex()]);
    expect(sub.m.el.textContent).toContain('Signed in with a subscription: nothing is charged per attempt.');
    expect(controlBy<HTMLSelectElement>(sub.m.el, 'Spending limit per attempt').value).toBe('none');
    expect(amount(sub.m.el).disabled).toBe(true);
    buttonBy(sub.m.el, 'Start the agent').click();
    await flush();
    expect(sent(sub.ctx)).toEqual({ max_budget_usd: null });
    sub.m.destroy();

    for (const sign_in of ['api_key', 'unknown', undefined] as const) {
      const paid = await start([claude(sign_in ? { sign_in } : {}), codex()]);
      expect(controlBy<HTMLSelectElement>(paid.m.el, 'Spending limit per attempt').value, String(sign_in)).toBe('set');
      expect(amount(paid.m.el).value).toBe('5');
      buttonBy(paid.m.el, 'Start the agent').click();
      await flush();
      expect(sent(paid.ctx)).toEqual({ max_budget_usd: 5 });
      paid.m.destroy();
    }

    // The person's own choice is not replaced when the hosts are checked again.
    const own = await start([claude({ sign_in: 'subscription' }), codex()]);
    choose(controlBy<HTMLSelectElement>(own.m.el, 'Spending limit per attempt'), 'set');
    type(amount(own.m.el), '12');
    buttonBy(own.m.el, 'Check again').click();
    await flush();
    expect(controlBy<HTMLSelectElement>(own.m.el, 'Spending limit per attempt').value).toBe('set');
    expect(amount(own.m.el).value).toBe('12');
    own.m.destroy();
  });

  it('says when it found no sign-in, and still starts the agent if the person says so', async () => {
    const ctx = makeContext({
      answers: {
        'GET /agent-hosts': { hosts: [claude({ sign_in: 'none' }), codex({ sign_in: 'subscription' })] },
        'GET /agent-processes': profiles([]),
      },
    });
    const m = startAgentModal(ctx, { kind: 'start-agent' }, () => undefined);
    await flush();
    const note = m.el.querySelector('.pn-sign-in') as HTMLElement;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain('Friday found no sign-in for Claude Code on this computer');
    expect(note.classList.contains('field-error')).toBe(true);
    // A reading, not a proof: the start is not taken away.
    expect(buttonBy(m.el, 'Start the agent').disabled).toBe(false);
    choose(controlBy<HTMLSelectElement>(m.el, 'Host'), 'codex');
    expect(note.textContent).toContain('Signed in with a subscription');
    expect(note.classList.contains('field-error')).toBe(false);
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

  it('disables a host that is not installed, or that Friday cannot start as it is, with the reason', async () => {
    const ctx = makeContext({
      answers: {
        'GET /agent-hosts': {
          hosts: [claude({ found: false, reason: `not on PATH ${HOSTILE}` }), codex()],
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

    // Found, and too old for Friday: said before the click, with what to do.
    const old = makeContext({
      answers: {
        'GET /agent-hosts': {
          hosts: [
            claude({ version: '2.1.200', supported: false, reason: 'spawn mode needs Claude Code 2.1.300' }),
            codex(),
          ],
        },
        'GET /agent-processes': profiles([]),
      },
    });
    const m2 = startAgentModal(old, { kind: 'start-agent' }, () => undefined);
    await flush();
    expect(m2.el.textContent).toContain(
      'Found 2.1.200, which Friday cannot start: spawn mode needs Claude Code 2.1.300',
    );
    expect(m2.el.textContent).toContain('Update Claude Code, then Check again.');
    expect(buttonBy(m2.el, 'Start the agent').disabled).toBe(true);
    m2.destroy();
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
      options: { max_budget_usd: 5 },
      autostart: true,
    });
    expect(m.el.querySelector('.pn-server-error')?.textContent).toBe(message);
    expect(ctx.toasts.at(-1)?.kind).toBe('error');
    expect(closed).toBe(false);
    m.destroy();
  });

  it('lists Antigravity as a host it does not start, and links to connecting it', async () => {
    const ctx = makeContext({ answers: { 'GET /agent-hosts': HOSTS, 'GET /agent-processes': profiles([]) } });
    const m = startAgentModal(ctx, { kind: 'start-agent' }, () => undefined);
    await flush();
    const host = controlBy<HTMLSelectElement>(m.el, 'Host');
    const ag = host.querySelector('option[value="antigravity"]') as HTMLOptionElement;
    // Listed after the hosts Friday starts, never selectable, and its words survive the host check.
    expect(ag.disabled).toBe(true);
    expect(ag.textContent).toBe(ANTIGRAVITY_OPTION_LABEL);
    expect(host.value).toBe('claude-code');
    expect(m.el.textContent).toContain('Antigravity is not started here: you open it yourself.');
    buttonBy(m.el, 'Connect Antigravity').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'agents', tab: 'antigravity' });
    expect(ctx.store.select('ui').modal).toBeNull();
    m.destroy();
  });

  it('links to the model choices in Settings → Models, closing the dialog first', () => {
    const ctx = makeContext();
    const m = startAgentModal(ctx, { kind: 'start-agent' }, () => undefined);
    expect(m.el.textContent).toContain('Settings → Models');
    buttonBy(m.el, 'Open the model choices').click();
    expect(ctx.store.select('ui')).toMatchObject({ activeView: 'settings', settingsTab: 'routing', drawer: null });
    expect(ctx.store.select('ui').modal).toBeNull();
    m.destroy();
  });

  it('says what is installed under the Host field and checks again on request', async () => {
    const ctx = makeContext({ answers: { 'GET /agent-hosts': HOSTS, 'GET /agent-processes': profiles([]) } });
    const m = startAgentModal(ctx, { kind: 'start-agent' }, () => undefined);
    const check = buttonBy(m.el, 'Check again');
    expect(check.disabled).toBe(true);
    expect(m.el.textContent).toContain('Checking which hosts are installed');
    await flush();
    expect(check.disabled).toBe(false);
    expect(m.el.textContent).toContain('Found 2.1.301 at C:/bin/claude.exe');
    check.click();
    expect(check.disabled).toBe(true);
    expect(m.el.textContent).toContain('Checking which hosts are installed');
    await flush();
    const calls = ctx.transport.calls.filter((c) => c.path.includes('/agent-hosts'));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).not.toContain('refresh=true');
    expect(calls[1]?.path).toContain('refresh=true');
    expect(check.disabled).toBe(false);
    expect(m.el.textContent).toContain('Found 2.1.301 at C:/bin/claude.exe');
    m.destroy();
  });

  it('keeps the host options under an Options fold that opens when one of them is wrong', async () => {
    const ctx = makeContext({ answers: { 'GET /agent-hosts': HOSTS, 'GET /agent-processes': profiles([]) } });
    const m = startAgentModal(ctx, { kind: 'start-agent' }, () => undefined);
    await flush();
    const options = m.el.querySelector('details.pn-host-options-fold') as HTMLDetailsElement;
    expect(options.open).toBe(false);
    expect(options.querySelector('summary')?.textContent).toBe('Options');
    // The options are in the page, folded: a wrong amount opens the fold and disables the start.
    type(amount(options), '5000');
    expect(options.open).toBe(true);
    expect(options.textContent).toContain('between 0.01 and 1000 dollars');
    expect(buttonBy(m.el, 'Start the agent').disabled).toBe(true);
    type(amount(options), '2');
    expect(buttonBy(m.el, 'Start the agent').disabled).toBe(false);
    // "Start with Friday" is not a host option: it stays in view.
    const autostart = Array.from(m.el.querySelectorAll('label.check')).find((l) =>
      l.textContent?.includes('Start with Friday'),
    );
    expect(autostart).toBeTruthy();
    expect(options.contains(autostart as Node)).toBe(false);
    // Codex has its own options behind the same fold.
    choose(controlBy<HTMLSelectElement>(m.el, 'Host'), 'codex');
    expect(controlBy<HTMLSelectElement>(options, 'Sandbox').value).toBe('workspace-write');
    m.destroy();
  });
});

describe('changing a remembered agent', () => {
  const remembered: AgentProcessesView = {
    processes: [],
    profiles: [
      profile('claude-1', {
        role: 'backend',
        autostart: false,
        options: { max_budget_usd: 1.5, models: ['claude-sonnet-5-5'] },
      }),
    ],
  };

  it('opens on what the agent has, keeps its host and key, and saves the rest', async () => {
    const ctx = makeContext({
      answers: {
        'GET /agent-hosts': { hosts: [claude({ sign_in: 'subscription' }), codex()] },
        'GET /agent-processes': remembered,
        'POST /agent-processes/claude-1/update': { profile: remembered.profiles[0], running: true },
      },
    });
    let closed = 0;
    const m = startAgentModal(ctx, { kind: 'edit-agent', id: 'claude-1' }, () => {
      closed += 1;
    });
    expect(m.title).toBe('Edit claude-1');
    await flush();
    expect(controlBy<HTMLSelectElement>(m.el, 'Host').disabled).toBe(true);
    expect(controlBy(m.el, 'Agent key').disabled).toBe(true);
    expect(controlBy(m.el, 'Agent key').value).toBe('claude-1');
    expect(controlBy(m.el, 'Role').value).toBe('backend');
    // Its own limit stands: a subscription's sign-in does not replace what a person set.
    expect(controlBy<HTMLSelectElement>(m.el, 'Spending limit per attempt').value).toBe('set');
    expect(amount(m.el).value).toBe('1.5');
    expect(m.el.textContent).toContain('A new spending limit applies from the agent’s next attempt.');
    expect(m.el.textContent).toContain('Everything else applies the next time it starts');
    expect(m.el.textContent).not.toContain('Open the model choices');

    choose(controlBy<HTMLSelectElement>(m.el, 'Spending limit per attempt'), 'none');
    type(controlBy(m.el, 'Role'), 'frontend');
    buttonBy(m.el, 'Save').click();
    await flush();
    expect(ctx.transport.to('POST', '/agent-processes/claude-1/update')[0]?.body).toEqual({
      role: 'frontend',
      autostart: false,
      // The models it was made with are kept, though the dialog no longer asks for them.
      options: { max_budget_usd: null, models: ['claude-sonnet-5-5'] },
    });
    expect(ctx.transport.to('POST', '/agent-processes')).toHaveLength(0);
    expect(ctx.toasts.at(-1)).toEqual({
      kind: 'success',
      text: 'Saved. A new spending limit applies from the next attempt of claude-1; the rest from its next start (Stop, then Start again)',
    });
    expect(closed).toBe(1);
    m.destroy();
  });

  it('says when the agent is no longer remembered, and saves nothing', async () => {
    const ctx = makeContext({ answers: { 'GET /agent-hosts': HOSTS, 'GET /agent-processes': profiles([]) } });
    const m = startAgentModal(ctx, { kind: 'edit-agent', id: `gone${HOSTILE}` }, () => undefined);
    await flush();
    expect(m.el.querySelector('.pn-server-error')?.textContent).toContain('Friday does not remember an agent');
    expect(m.el.querySelector('img')).toBeNull();
    expect(buttonBy(m.el, 'Save').disabled).toBe(true);
    m.destroy();
  });
});
