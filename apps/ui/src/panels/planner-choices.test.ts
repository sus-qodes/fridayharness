/**
 * "Who writes your plans" (2026-11-23): every way to plan in one list, each with where it stands
 * and the next step it needs. Until then the page offered Claude only.
 */
import type { BrainStatusView, PlannerOptionView } from '@friday/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopCommands } from '../shell/context.js';
import { makeContext } from '../test/context.js';
import { makeSnapshot } from '../test/fixtures.js';
import { Teardown } from './common.js';
import { plannerChoices, plannerRequestsCard, rowState, stepsLeft } from './planner-choices.js';
import { buttonBy, flush, type } from './test-support.js';

const option = (id: string, over: Partial<PlannerOptionView> = {}): PlannerOptionView => {
  const kind =
    id === 'claude-code' || id === 'codex' ? 'program' : id === 'local' ? 'local' : id === 'none' ? 'none' : 'key';
  const remote = kind === 'program' || kind === 'key';
  const unpriced = remote && id !== 'claude-code' && id !== 'anthropic';
  const labels: Record<string, string> = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    gemini: 'Google Gemini',
    deepseek: 'DeepSeek',
    openrouter: 'OpenRouter',
    local: 'A model on this computer',
    none: 'I write the plans myself',
  };
  return {
    id,
    kind,
    label: labels[id] ?? id,
    found: kind === 'program' ? true : null,
    remote,
    allowed: !remote,
    approved: !remote,
    key: kind === 'key' ? 'missing' : 'not needed',
    model: null,
    needs_model: kind === 'local' || (kind === 'key' && id !== 'anthropic'),
    unpriced,
    project_budget_usd: remote && !unpriced ? 5 : null,
    project_calls: unpriced ? 50 : null,
    endpoint: id === 'local' ? 'http://127.0.0.1:11434/v1' : null,
    ...over,
  };
};

const ALL = ['claude-code', 'codex', 'anthropic', 'openai', 'gemini', 'deepseek', 'openrouter', 'local', 'none'];

const brain = (
  over: Partial<BrainStatusView> = {},
  options: Record<string, Partial<PlannerOptionView>> = {},
): BrainStatusView => ({
  provider: 'none',
  model: 'auto',
  remote: false,
  allow_remote: false,
  approved_here: false,
  endpoint: null,
  ignored_base_url: null,
  key: 'not needed',
  planner_available: false,
  reason: 'master_brain.provider is "none"',
  auto_approve: false,
  escalate_after_failures: 2,
  max_replans: 3,
  daily_budget_usd: null,
  spent_today_usd: 0,
  cursor: 0,
  head: 0,
  choice: { here: 'none', project: 'anthropic', wanted: 'none' },
  planners: ALL.map((id) => option(id, options[id])),
  requests: null,
  ...over,
});

function onDesktop(ctx: ReturnType<typeof makeContext>, over: Partial<DesktopCommands> = {}) {
  const shell = {
    shortcuts: async () => [],
    setShortcut: async () => [],
    restart: vi.fn(async () => true),
    storeKey: vi.fn(async () => true),
    allowSpending: vi.fn(async () => true),
    autostart: async () => false,
    setAutostart: async (on: boolean) => on,
    testNotification: async () => true,
    ...over,
  };
  (ctx as { platform: unknown }).platform = { ...ctx.platform, kind: 'tauri', desktop: shell };
  return shell;
}

function mount(b: BrainStatusView, opts: { desktop?: boolean; answers?: Record<string, unknown> } = {}) {
  const ctx = makeContext({ snapshot: makeSnapshot({ brain: b }), ...(opts.answers ? { answers: opts.answers } : {}) });
  const shell = opts.desktop === false ? null : onDesktop(ctx);
  const td = new Teardown();
  const own = { 'claude-code': document.createElement('div'), anthropic: document.createElement('div') };
  own['claude-code'].textContent = 'CLAUDE CODE STEPS';
  own.anthropic.textContent = 'ANTHROPIC KEY STEPS';
  const el = plannerChoices(ctx, td, own) as HTMLElement;
  return { ctx, shell, td, el };
}

const rowOf = (el: HTMLElement, id: string) => el.querySelector(`.pn-planner[data-planner="${id}"]`) as HTMLElement;
const openRow = (el: HTMLElement, id: string) =>
  (rowOf(el, id).querySelector('.pn-planner-head') as HTMLElement).click();
const sent = (ctx: ReturnType<typeof makeContext>, path: string) => ctx.transport.to('POST', path).map((c) => c.body);

describe('where a way to plan stands', () => {
  it('is in use, waits for a restart, is missing, is half set up, or is not chosen', () => {
    const b = brain({
      provider: 'codex',
      planner_available: true,
      choice: { here: 'codex', project: 'anthropic', wanted: 'codex' },
    });
    expect(rowState(b, option('codex'))).toBe('in_use');
    expect(rowState({ ...b, planner_available: false }, option('codex'))).toBe('set_up');
    // Chosen here, and Friday still runs another planner.
    expect(rowState({ ...b, provider: 'anthropic' }, option('codex'))).toBe('restart');
    expect(rowState(b, option('claude-code', { found: false }))).toBe('not_found');
    expect(rowState(b, option('openai'))).toBe('off');
    // Writing plans yourself is "in use" although no planner is "available".
    expect(rowState(brain(), option('none'))).toBe('in_use');
  });

  it('lists what is still needed, in the order a person takes it', () => {
    expect(stepsLeft(option('openai'))).toEqual(['project', 'key', 'approve', 'model']);
    expect(stepsLeft(option('openai', { allowed: true, key: 'stored' }))).toEqual(['approve', 'model']);
    // Codex signs in itself and has a default model: the project, then this computer.
    expect(stepsLeft(option('codex'))).toEqual(['project', 'approve']);
    expect(stepsLeft(option('codex', { allowed: true, approved: true }))).toEqual([]);
    // Nothing of a model on this computer leaves it: only a model to pick.
    expect(stepsLeft(option('local'))).toEqual(['model']);
    expect(stepsLeft(option('local', { model: 'qwen2.5:7b' }))).toEqual([]);
    expect(stepsLeft(option('none'))).toEqual([]);
  });
});

describe('the list of ways to plan', () => {
  it('is no card on a Friday that does not list its planners', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ brain: brain({ planners: undefined }) }) });
    expect(plannerChoices(ctx, new Teardown(), {})).toBeNull();
  });

  it('shows every way with what it is, opens the one in use, and Claude’s two keep their own steps', () => {
    const { el, td } = mount(brain());
    expect([...el.querySelectorAll('.pn-planner')].map((r) => (r as HTMLElement).dataset.planner)).toEqual(ALL);
    expect(rowOf(el, 'codex').textContent).toContain('signed in as it already is (your ChatGPT plan or key)');
    expect(rowOf(el, 'local').textContent).toContain('nothing leaves the computer');
    // The one in use is open, and says so.
    expect(rowOf(el, 'none').dataset.state).toBe('in_use');
    expect(rowOf(el, 'none').textContent).toContain('in use');
    expect(rowOf(el, 'none').querySelector('.pn-planner-body')).not.toBeNull();
    expect(rowOf(el, 'codex').querySelector('.pn-planner-body')).toBeNull();
    // Claude Code and the Anthropic key: the steps they already had, under their rows.
    openRow(el, 'claude-code');
    expect(rowOf(el, 'claude-code').textContent).toContain('CLAUDE CODE STEPS');
    openRow(el, 'anthropic');
    expect(rowOf(el, 'anthropic').textContent).toContain('ANTHROPIC KEY STEPS');
    // One row open at a time.
    expect(rowOf(el, 'claude-code').querySelector('.pn-planner-body')).toBeNull();
    td.run();
  });

  it('takes a person through Codex: the project, this computer with its requests a day, then "Plan with Codex"', async () => {
    const { el, ctx, shell, td } = mount(brain(), {
      answers: {
        'POST /config/settings': { changed: ['providers.codex.allow_remote'] },
        'POST /brain/planner-choice': brain({ choice: { here: 'codex', project: 'anthropic', wanted: 'codex' } }),
      },
    });
    openRow(el, 'codex');
    const row = () => rowOf(el, 'codex');
    // The last step waits for the ones before it.
    expect((row().querySelector('[data-action="use"]') as HTMLButtonElement).disabled).toBe(true);
    expect(row().querySelector('[data-step="project"]')?.textContent).toContain('This project does not allow it yet.');
    // No key is asked of Codex: it signs in itself.
    expect(row().querySelector('[data-step="key"]')).toBeNull();
    expect(row().querySelector('[data-step="approve"]')?.textContent).toContain(
      'Friday knows no price for it, so its limit is a number of requests a day',
    );

    // 1. The project: asked first, said to be shared.
    buttonBy(row(), 'Allow it for this project').click();
    await flush();
    expect(ctx.confirms.at(-1)?.title).toBe('Allow planning with Codex in this project?');
    expect(ctx.confirms.at(-1)?.body.join(' ')).toContain('which your team shares');
    expect(sent(ctx, '/config/settings')).toEqual([{ set: { 'providers.codex.allow_remote': true } }]);

    // 2. This computer: the app's own dialog, with the requests a day the person set, no dollars.
    type(row().querySelector('[data-step="approve"] input') as HTMLInputElement, '20');
    buttonBy(row(), 'Allow on this computer').click();
    await flush();
    expect(shell?.allowSpending).toHaveBeenCalledWith(0, 'codex', 20);
    expect(ctx.toasts.at(-1)?.text).toBe('Planning with Codex is allowed on this computer, up to 20 requests a day');
    td.run();
  });

  it('plans with it once nothing is left, and restarts Friday when it runs another planner', async () => {
    const ready = { codex: { allowed: true, approved: true } };
    const { el, ctx, shell, td } = mount(brain({}, ready), {
      answers: {
        'POST /brain/planner-choice': brain(
          { choice: { here: 'codex', project: 'anthropic', wanted: 'codex' } },
          ready,
        ),
      },
    });
    openRow(el, 'codex');
    const use = rowOf(el, 'codex').querySelector('[data-action="use"]') as HTMLButtonElement;
    expect(use.disabled).toBe(false);
    expect(use.textContent).toBe('Plan with Codex');
    use.click();
    await flush();
    expect(sent(ctx, '/brain/planner-choice')).toEqual([{ provider: 'codex' }]);
    // Friday still runs the old planner: it restarts.
    expect(shell?.restart).toHaveBeenCalledTimes(1);
    td.run();
  });

  it('names a model for Codex, or leaves it to Codex’s own default', async () => {
    const { el, ctx, td } = mount(brain({}, { codex: { allowed: true, approved: true, model: 'gpt-6.1-sol' } }), {
      answers: { 'POST /brain/planner-choice': brain() },
    });
    openRow(el, 'codex');
    const field = rowOf(el, 'codex').querySelector('[data-step="model"] input') as HTMLInputElement;
    expect(field.value).toBe('gpt-6.1-sol');
    expect(field.placeholder).toBe('Codex’s own default');
    type(field, '');
    buttonBy(rowOf(el, 'codex').querySelector('[data-step="model"]') as HTMLElement, 'Save').click();
    await flush();
    expect(sent(ctx, '/brain/planner-choice')).toEqual([{ model: null, model_for: 'codex' }]);
    td.run();
  });

  it('for a key service: the key in Windows’ own prompt, then a model picked from the service’s own list', async () => {
    const { el, ctx, shell, td } = mount(brain({}, { openai: { allowed: true, approved: true } }), {
      answers: {
        'GET /brain/models': { provider: 'openai', models: ['gpt-6-astra', 'gpt-6.1-sol'] },
        'POST /brain/planner-choice': brain(),
      },
    });
    openRow(el, 'openai');
    const row = () => rowOf(el, 'openai');
    expect(row().querySelector('[data-step="key"]')?.textContent).toContain(
      'Windows’ own password box, never into this page',
    );
    // The list is read with the key: not before it is stored.
    expect(buttonBy(row(), 'List OpenAI’s models').disabled).toBe(true);
    buttonBy(row(), 'Store the key').click();
    await flush();
    expect(shell?.storeKey).toHaveBeenCalledWith('openai');
    td.run();

    // With the key stored: the list, and a model picked from it.
    const stored = mount(brain({}, { openai: { allowed: true, approved: true, key: 'stored' } }), {
      answers: {
        'GET /brain/models': { provider: 'openai', models: ['gpt-6-astra', 'gpt-6.1-sol'] },
        'POST /brain/planner-choice': brain(),
      },
    });
    openRow(stored.el, 'openai');
    const r = () => rowOf(stored.el, 'openai');
    expect((r().querySelector('[data-action="use"]') as HTMLButtonElement).disabled).toBe(true);
    buttonBy(r(), 'List OpenAI’s models').click();
    await flush();
    const picker = r().querySelector('select') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(['', 'gpt-6-astra', 'gpt-6.1-sol']);
    picker.value = 'gpt-6.1-sol';
    picker.dispatchEvent(new Event('change'));
    await flush();
    expect(sent(stored.ctx, '/brain/planner-choice')).toEqual([{ model: 'gpt-6.1-sol', model_for: 'openai' }]);
    stored.td.run();
    void ctx;
  });

  it('for a model on this computer: its address, the server’s own models, and no key or approval', async () => {
    const { el, ctx, shell, td } = mount(brain(), {
      answers: {
        'POST /brain/local-endpoint': { base_url: 'http://127.0.0.1:1234/v1' },
        'GET /brain/models': { provider: 'local', models: [] },
      },
    });
    openRow(el, 'local');
    const row = () => rowOf(el, 'local');
    expect(row().querySelector('[data-step="project"]')).toBeNull();
    expect(row().querySelector('[data-step="key"]')).toBeNull();
    expect(row().querySelector('[data-step="approve"]')).toBeNull();
    const address = row().querySelector('[data-step="address"] input') as HTMLInputElement;
    expect(address.value).toBe('http://127.0.0.1:11434/v1');
    expect(row().querySelector('[data-step="address"]')?.textContent).toContain('LM Studio: http://127.0.0.1:1234/v1');
    type(address, 'http://127.0.0.1:1234/v1');
    buttonBy(row().querySelector('[data-step="address"]') as HTMLElement, 'Save').click();
    await flush();
    expect(sent(ctx, '/brain/local-endpoint')).toEqual([{ base_url: 'http://127.0.0.1:1234/v1' }]);
    // A server with no model yet says what to do.
    buttonBy(row(), 'List this computer’s models').click();
    await flush();
    expect(row().textContent).toContain('download one in Ollama or LM Studio, then read the list again');
    expect(shell?.allowSpending).not.toHaveBeenCalled();
    td.run();
  });

  it('says a program Friday did not find, and offers nothing that would change a setting for it', () => {
    const { el, ctx, td } = mount(brain({}, { codex: { found: false } }));
    expect(rowOf(el, 'codex').textContent).toContain('not found');
    openRow(el, 'codex');
    expect(rowOf(el, 'codex').querySelector('[data-step="found"]')?.textContent).toContain(
      'Friday did not find Codex on this computer when it started. Install Codex and sign in to it',
    );
    expect(rowOf(el, 'codex').querySelector('[data-action="use"]')).toBeNull();
    expect(rowOf(el, 'codex').querySelector('[data-step="project"]')).toBeNull();
    expect(ctx.transport.calls.filter((c) => c.method === 'POST')).toEqual([]);
    td.run();
  });

  it('in a browser, says the two steps that are the desktop app’s own, with no button for them', () => {
    const { el, td } = mount(brain({}, { openai: { allowed: true } }), { desktop: false });
    openRow(el, 'openai');
    const row = rowOf(el, 'openai');
    expect(row.querySelector('[data-step="key"]')?.textContent).toContain('Open Friday’s desktop app to store it');
    expect(row.querySelector('[data-step="approve"]')?.textContent).toContain('Open Friday’s desktop app to allow it');
    expect(row.querySelector('[data-step="key"] button')).toBeNull();
    expect(row.querySelector('[data-step="approve"] button')).toBeNull();
    td.run();
  });

  it('lets a person go back to writing plans themselves', async () => {
    const using = brain(
      { provider: 'codex', planner_available: true, choice: { here: 'codex', project: 'anthropic', wanted: 'codex' } },
      { codex: { allowed: true, approved: true } },
    );
    const { el, ctx, shell, td } = mount(using, { answers: { 'POST /brain/planner-choice': using } });
    expect(rowOf(el, 'codex').dataset.state).toBe('in_use');
    openRow(el, 'none');
    buttonBy(rowOf(el, 'none'), 'I’ll write plans myself').click();
    await flush();
    expect(sent(ctx, '/brain/planner-choice')).toEqual([{ provider: 'none' }]);
    expect(shell?.restart).toHaveBeenCalledTimes(1);
    td.run();
  });
});

describe('how much a planner without a price may do', () => {
  const limited = (over: Partial<BrainStatusView> = {}) =>
    brain({
      provider: 'codex',
      remote: true,
      allow_remote: true,
      approved_here: true,
      planner_available: true,
      requests: { limit: 20, today: 3, yours: 20, project: 50 },
      ...over,
    });
  const card = (b: BrainStatusView, desktop = true) => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ brain: b }),
      answers: { 'POST /brain/deny-remote': { removed: true, brain: b } },
    });
    const shell = desktop ? onDesktop(ctx) : null;
    const td = new Teardown();
    return { ctx, shell, td, el: plannerRequestsCard(ctx, td, b) as HTMLElement };
  };

  it('is no card for a planner held to dollars, or one not allowed here yet', () => {
    const ctx = makeContext();
    const td = new Teardown();
    expect(plannerRequestsCard(ctx, td, null)).toBeNull();
    expect(plannerRequestsCard(ctx, td, limited({ requests: null }))).toBeNull();
    expect(plannerRequestsCard(ctx, td, limited({ approved_here: false }))).toBeNull();
  });

  it('says the limit and today’s count in requests, never in dollars, and changes it in the app’s own dialog', async () => {
    const { el, shell, td } = card(limited());
    expect(el.querySelector('[data-role="limit"]')?.textContent).toBe(
      'Up to 20 requests a day with Codex, on this computer. Today: 3.',
    );
    expect(el.textContent).toContain('Friday knows no price for Codex, so it counts requests instead of dollars');
    expect(el.textContent).not.toContain('$');
    expect(buttonBy(el, 'Change the limit').disabled).toBe(true);
    type(el.querySelector('input') as HTMLInputElement, '80');
    // Above the project's own: said, with the way to raise that.
    expect(el.querySelector('[data-role="project-limit"]')?.textContent).toContain(
      'The project’s own limit is 50 requests a day',
    );
    buttonBy(el, 'Change the limit').click();
    await flush();
    expect(shell?.allowSpending).toHaveBeenCalledWith(0, 'codex', 80);
    td.run();
  });

  it('turns it off after asking, for the planner that runs', async () => {
    const { el, ctx, td } = card(limited());
    buttonBy(el, 'Turn it off').click();
    await flush();
    expect(ctx.confirms.at(-1)?.title).toBe('Stop planning with Codex on this computer?');
    expect(sent(ctx, '/brain/deny-remote')).toEqual([{ provider: 'codex' }]);
    td.run();
  });
});
