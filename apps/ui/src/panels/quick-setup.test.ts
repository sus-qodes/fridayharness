/**
 * The two Settings switches. Planning through Claude Code is this person's choice, kept on their
 * machine: it asks the project's permission where the project has not given it, records the choice,
 * asks this machine to allow the spending and restarts only when it has to. Checking the work
 * automatically sets config.yaml and asks for this clone's trust in that setting, and in no other.
 */
import type { BrainStatusView } from '@friday/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopCommands } from '../shell/context.js';
import { makeContext } from '../test/context.js';
import { makeSnapshot } from '../test/fixtures.js';
import { Teardown } from './common.js';
import {
  autoApproval,
  autoApproveSwitch,
  autoVerification,
  autoVerifySwitch,
  CLAUDE_CODE_BUDGET,
  claudeCodePlanning,
  landingChoice,
  landingState,
  plannerQuickSetup,
} from './quick-setup.js';
import { buttonBy, flush, HOSTILE } from './test-support.js';

type ClaudeCode = NonNullable<BrainStatusView['claude_code']>;
const cc = (over: Partial<ClaudeCode> = {}): ClaudeCode => ({
  found: true,
  allowed: false,
  approved: false,
  project_budget_usd: 5,
  ...over,
});

const brain = (over: Partial<BrainStatusView> = {}): BrainStatusView => ({
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  remote: true,
  allow_remote: false,
  approved_here: false,
  endpoint: null,
  ignored_base_url: null,
  key: 'missing',
  planner_available: false,
  reason: 'no key',
  auto_approve: false,
  escalate_after_failures: 2,
  max_replans: 3,
  daily_budget_usd: 5,
  spent_today_usd: 0,
  cursor: 0,
  head: 0,
  choice: { here: null, project: 'anthropic', wanted: 'anthropic' },
  claude_code: cc(),
  ...over,
});
/** The planner as it reads once Claude Code is this person's choice. */
const choosing = (over: Partial<BrainStatusView> = {}) =>
  brain({ choice: { here: 'claude-code', project: 'anthropic', wanted: 'claude-code' }, ...over });
const viaClaudeCode = (over: Partial<BrainStatusView> = {}) =>
  choosing({ provider: 'claude-code', key: 'not needed', reason: 'not approved', ...over });

const restartNeeded = (keys: string[]) => ({
  loaded_hash: 'h1',
  current_hash: 'h2',
  changes: { applied: [], restart_needed: keys, error: null },
});

/** A context on the desktop platform, its shell commands faked and recorded in `steps`. */
function onDesktop(ctx: ReturnType<typeof makeContext>, over: Partial<DesktopCommands> = {}) {
  const steps: string[] = [];
  const shell = {
    shortcuts: async () => [],
    setShortcut: async () => [],
    restart: vi.fn(async () => {
      steps.push('restart');
      return true;
    }),
    storeKey: async () => true,
    allowSpending: vi.fn(async (budget: number, provider?: string) => {
      steps.push(`allow ${budget} ${provider}`);
      return true;
    }),
    autostart: async () => false,
    setAutostart: async (on: boolean) => on,
    testNotification: async () => true,
    ...over,
  };
  (ctx as { platform: unknown }).platform = { ...ctx.platform, kind: 'tauri', desktop: shell };
  return { shell, steps };
}

const POLICY = (trusted: boolean, settings = ['verification.auto_on_completion']) => ({
  policy: {
    loosening: settings.map((setting) => ({ source: '.friday/config.yaml', setting, from: 'false', to: 'true' })),
    loosening_hash: 'hash0123456789ab',
    trusted,
  },
});

const sent = (ctx: ReturnType<typeof makeContext>, path: string) => ctx.transport.to('POST', path).map((c) => c.body);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('where the switches stand', () => {
  it('reads planning through Claude Code from what this person, or the project, chose', () => {
    expect(claudeCodePlanning(null)).toBe('off');
    expect(claudeCodePlanning(makeSnapshot({ brain: brain() }))).toBe('off');
    // Chosen, and Friday still runs the planner it started with.
    expect(claudeCodePlanning(makeSnapshot({ brain: choosing() }))).toBe('restart');
    // It runs: ready, or waiting for an approval, or Claude Code was not found.
    expect(claudeCodePlanning(makeSnapshot({ brain: viaClaudeCode({ planner_available: true }) }))).toBe('ready');
    expect(claudeCodePlanning(makeSnapshot({ brain: viaClaudeCode() }))).toBe('approve');
    expect(claudeCodePlanning(makeSnapshot({ brain: viaClaudeCode({ claude_code: cc({ found: false }) }) }))).toBe(
      'missing',
    );
    // config.yaml allows it now, and the planner read its settings when Friday started.
    expect(
      claudeCodePlanning(
        makeSnapshot({ brain: viaClaudeCode(), config: restartNeeded(['providers.claude-code.allow_remote']) }),
      ),
    ).toBe('restart');
    // The project chose it for everyone, and this person chose nothing of their own.
    const ofProject = { here: null, project: 'claude-code', wanted: 'claude-code' };
    expect(claudeCodePlanning(makeSnapshot({ brain: brain({ choice: ofProject }) }))).toBe('restart');
    // An older daemon says nothing of a choice: the planner that runs is what counts.
    const old = (over: Partial<BrainStatusView>) => {
      const { choice: _choice, claude_code: _cc, ...rest } = brain(over);
      return rest as BrainStatusView;
    };
    expect(claudeCodePlanning(makeSnapshot({ brain: old({}) }))).toBe('off');
    expect(claudeCodePlanning(makeSnapshot({ brain: old({ provider: 'claude-code', planner_available: true }) }))).toBe(
      'ready',
    );
  });

  it('reads automatic verification from that setting alone, never from another setting’s trust', () => {
    expect(autoVerification(null)).toBe('off');
    expect(autoVerification(makeSnapshot())).toBe('off');
    const asked = { checks: [], auto_on_completion: false, auto_requested: true };
    expect(autoVerification(makeSnapshot({ verification: asked }))).toBe('untrusted');
    expect(autoVerification(makeSnapshot({ verification: { ...asked, auto_on_completion: true } }))).toBe('on');
    // Something else of the project waits for trust (a sandbox, an operation): this switch is off.
    expect(autoVerification(makeSnapshot({ policy_untrusted: true }))).toBe('off');
    expect(
      autoVerification(
        makeSnapshot({
          policy_untrusted: true,
          verification: { checks: [], auto_on_completion: false, auto_requested: false },
        }),
      ),
    ).toBe('off');
  });
});

describe('planning with Claude Code', () => {
  it('asks the project’s permission, keeps the choice on this computer, allows the spending, then restarts', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ brain: brain() }),
      answers: {
        'POST /config/settings': { changed: ['providers.claude-code.allow_remote'] },
        'POST /brain/planner-choice': choosing(),
      },
    });
    const { steps } = onDesktop(ctx);
    const td = new Teardown();
    const el = plannerQuickSetup(ctx, td);
    expect(el.textContent).toContain('no API key');
    expect(el.textContent).toContain('your own choice, kept on this computer');
    buttonBy(el, 'Use Claude Code to plan').click();
    await flush();
    // The one shared setting is asked about first, and said to be shared.
    expect(ctx.confirms[0]?.title).toBe('Allow planning through Claude Code in this project?');
    expect([ctx.confirms[0]?.body].flat().join(' ')).toContain('which your team shares');
    // Only that goes into config.yaml: neither the planner nor a budget.
    expect(sent(ctx, '/config/settings')).toEqual([{ set: { 'providers.claude-code.allow_remote': true } }]);
    expect(sent(ctx, '/brain/planner-choice')).toEqual([{ provider: 'claude-code' }]);
    expect(steps).toEqual([`allow ${CLAUDE_CODE_BUDGET} claude-code`, 'restart']);
    td.run();
  });

  it('changes nothing when the person does not allow it for the project', async () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ brain: brain() }) });
    const { steps } = onDesktop(ctx);
    ctx.confirmAnswer = false;
    const td = new Teardown();
    const el = plannerQuickSetup(ctx, td);
    buttonBy(el, 'Use Claude Code to plan').click();
    await flush();
    expect(ctx.transport.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(steps).toEqual([]);
    td.run();
  });

  it('asks nothing of the project that already allows it, and takes the budget typed', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ brain: brain({ claude_code: cc({ allowed: true }) }) }),
      answers: { 'POST /brain/planner-choice': choosing() },
    });
    const { steps } = onDesktop(ctx);
    const td = new Teardown();
    const el = plannerQuickSetup(ctx, td);
    const budget = el.querySelector('input[type="number"]') as HTMLInputElement;
    budget.value = '7';
    budget.dispatchEvent(new Event('input'));
    // The project's own limit holds whatever a person allows themselves.
    expect(el.textContent).toContain("The project's own limit is $5 a day");
    buttonBy(el, 'Use Claude Code to plan').click();
    await flush();
    expect(ctx.confirms).toHaveLength(0);
    expect(sent(ctx, '/config/settings')).toEqual([]);
    expect(steps).toEqual(['allow 7 claude-code', 'restart']);
    td.run();
  });

  it('does not restart when the spending is not allowed, nor when the planner already runs it', async () => {
    const declined = makeContext({
      snapshot: makeSnapshot({ brain: brain({ claude_code: cc({ allowed: true }) }) }),
      answers: { 'POST /brain/planner-choice': choosing() },
    });
    const no = onDesktop(declined, {
      allowSpending: async (budget: number, provider?: string) => {
        no.steps.push(`allow ${budget} ${provider}`);
        return false;
      },
    });
    const td = new Teardown();
    buttonBy(plannerQuickSetup(declined, td), 'Use Claude Code to plan').click();
    await flush();
    expect(no.steps).toEqual([`allow ${CLAUDE_CODE_BUDGET} claude-code`]);
    td.run();

    // The planner is Claude Code already; only this machine's approval was missing, which needs no restart.
    const running = makeContext({
      snapshot: makeSnapshot({ brain: viaClaudeCode({ claude_code: cc({ allowed: true }) }) }),
      answers: { 'POST /brain/planner-choice': viaClaudeCode({ claude_code: cc({ allowed: true }) }) },
    });
    const yes = onDesktop(running);
    const td2 = new Teardown();
    buttonBy(plannerQuickSetup(running, td2), 'Use Claude Code to plan').click();
    await flush();
    expect(yes.steps).toEqual([`allow ${CLAUDE_CODE_BUDGET} claude-code`]);
    td2.run();
  });

  it('says so, and changes nothing, when Friday did not find Claude Code', async () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ brain: brain({ claude_code: cc({ found: false }) }) }) });
    const { steps } = onDesktop(ctx);
    const td = new Teardown();
    const el = plannerQuickSetup(ctx, td);
    expect(el.textContent).toContain('Friday did not find Claude Code on this computer');
    const start = buttonBy(el, 'Use Claude Code to plan');
    expect(start.disabled).toBe(true);
    start.click();
    await flush();
    expect(ctx.transport.calls.filter((c) => c.method === 'POST')).toEqual([]);
    // Installed since: a restart makes Friday look again.
    buttonBy(el, 'Restart Friday').click();
    await flush();
    expect(steps).toEqual(['restart']);
    td.run();
  });

  it('stops when the choice cannot be recorded, and shows the refusal as text', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ brain: brain({ claude_code: cc({ allowed: true }) }) }),
      answers: {
        'POST /brain/planner-choice': () => {
          throw new Error(HOSTILE);
        },
      },
    });
    const { steps } = onDesktop(ctx);
    const td = new Teardown();
    const el = plannerQuickSetup(ctx, td);
    buttonBy(el, 'Use Claude Code to plan').click();
    await flush();
    expect(steps).toEqual([]);
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Plan with Claude Code' });
    expect(el.querySelector('img')).toBeNull();
    td.run();
  });

  it('in a browser records the choice and keeps the terminal step in view until it is taken', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ brain: brain({ claude_code: cc({ allowed: true }) }) }),
      answers: { 'POST /brain/planner-choice': choosing() },
    });
    const td = new Teardown();
    const el = plannerQuickSetup(ctx, td);
    const command = `friday brain allow-remote --provider claude-code --budget ${CLAUDE_CODE_BUDGET}`;
    expect(el.textContent).toContain(command);
    buttonBy(el, 'Use Claude Code to plan').click();
    await flush();
    expect(sent(ctx, '/brain/planner-choice')).toEqual([{ provider: 'claude-code' }]);
    // Chosen, not yet approved here, a restart due: the approval step is still shown.
    ctx.board(makeSnapshot({ brain: choosing({ claude_code: cc({ allowed: true }) }) }));
    expect(el.textContent).toContain('restart needed');
    expect(el.textContent).toContain(command);
    // Once approved, only the restart is left.
    ctx.board(makeSnapshot({ brain: choosing({ claude_code: cc({ allowed: true, approved: true }) }) }));
    expect(el.textContent).not.toContain(command);
    td.run();
  });

  it('offers a restart when one is needed, says when it is on, and lets the person write plans themselves', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ brain: choosing() }),
      answers: { 'POST /brain/planner-choice': viaClaudeCode({ planner_available: true }) },
    });
    const { steps } = onDesktop(ctx);
    const td = new Teardown();
    const el = plannerQuickSetup(ctx, td);
    expect(el.textContent).toContain('restart needed');
    buttonBy(el, 'Restart Friday').click();
    await flush();
    expect(steps).toEqual(['restart']);
    ctx.board(makeSnapshot({ brain: viaClaudeCode({ planner_available: true }) }));
    expect(el.textContent).toContain('Friday plans through Claude Code.');
    expect(() => buttonBy(el, 'Use Claude Code to plan')).toThrow();
    // Turning it off again is this person's choice too, with the restart that stops the planner.
    buttonBy(el, 'I’ll write plans myself instead').click();
    await flush();
    expect(sent(ctx, '/brain/planner-choice')).toEqual([{ provider: 'none' }]);
    expect(steps).toEqual(['restart', 'restart']);
    td.run();
  });

  it('does not restart into a config.yaml Friday cannot read, and says nothing of a restart that was cancelled', async () => {
    const broken = makeContext({
      snapshot: makeSnapshot({
        brain: choosing(),
        config: {
          loaded_hash: 'h1',
          current_hash: null,
          changes: { applied: [], restart_needed: [], error: 'config.yaml: bad' },
        },
      }),
    });
    const a = onDesktop(broken);
    const td = new Teardown();
    buttonBy(plannerQuickSetup(broken, td), 'Restart Friday').click();
    await flush();
    expect(a.steps).toEqual([]);
    expect(broken.toasts.at(-1)).toMatchObject({ kind: 'warn' });
    td.run();

    const cancelled = makeContext({ snapshot: makeSnapshot({ brain: choosing() }) });
    onDesktop(cancelled, { restart: async () => false });
    const td2 = new Teardown();
    buttonBy(plannerQuickSetup(cancelled, td2), 'Restart Friday').click();
    await flush();
    expect(cancelled.toasts).toEqual([]);
    td2.run();
  });
});

describe('checking the work automatically', () => {
  it('in a browser sets config.yaml, then asks before trusting it here', async () => {
    const ctx = makeContext({ answers: { 'GET /policy': POLICY(false), 'POST /policy/trust': POLICY(true) } });
    const td = new Teardown();
    const el = autoVerifySwitch(ctx, td);
    buttonBy(el, 'Turn on').click();
    await flush();
    expect(sent(ctx, '/config/settings')).toEqual([{ set: { 'verification.auto_on_completion': true } }]);
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.confirms[0]?.body).toContain(
      'Finished work is checked automatically (verification.auto_on_completion: false → true, .friday/config.yaml)',
    );
    expect(sent(ctx, '/policy/trust')).toEqual([{ loosening_hash: 'hash0123456789ab' }]);
    expect(ctx.refreshes).toBe(1);
    td.run();
  });

  it('trusts nothing when the person says no', async () => {
    const ctx = makeContext({ answers: { 'GET /policy': POLICY(false) } });
    ctx.confirmAnswer = false;
    const td = new Teardown();
    const el = autoVerifySwitch(ctx, td);
    buttonBy(el, 'Turn on').click();
    await flush();
    expect(sent(ctx, '/config/settings')).toHaveLength(1);
    expect(sent(ctx, '/policy/trust')).toHaveLength(0);
    td.run();
  });

  it('on the desktop leaves the asking to the shell', async () => {
    const ctx = makeContext({ answers: { 'GET /policy': POLICY(false) } });
    onDesktop(ctx);
    const td = new Teardown();
    const el = autoVerifySwitch(ctx, td);
    buttonBy(el, 'Turn on').click();
    await flush();
    expect(ctx.confirms).toHaveLength(0);
    expect(sent(ctx, '/policy/trust')).toHaveLength(1);
    td.run();
  });

  it('when config.yaml already asks for it, only trusts; when on, says so', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ verification: { checks: [], auto_on_completion: false, auto_requested: true } }),
      answers: { 'GET /policy': POLICY(false) },
    });
    const td = new Teardown();
    const el = autoVerifySwitch(ctx, td);
    expect(el.textContent).toContain('config.yaml already asks for it');
    buttonBy(el, 'Trust and turn on').click();
    await flush();
    expect(sent(ctx, '/config/settings')).toHaveLength(0);
    expect(sent(ctx, '/policy/trust')).toHaveLength(1);
    ctx.board(makeSnapshot({ verification: { checks: [], auto_on_completion: true, auto_requested: true } }));
    expect(el.textContent).toContain('Work is checked as soon as the agent says it is done.');
    td.run();
  });

  it('turns it on, and never trusts another setting in its place (review of 2026-11-16)', async () => {
    // Another loosening of the project waits for trust, and automatic checks are not asked for:
    // the switch reads "Turn on", sets the setting, and then the list holds it.
    const ctx = makeContext({
      snapshot: makeSnapshot({ policy_untrusted: true }),
      answers: { 'GET /policy': POLICY(false, ['sandbox', 'verification.auto_on_completion']) },
    });
    const td = new Teardown();
    const el = autoVerifySwitch(ctx, td);
    expect(() => buttonBy(el, 'Trust and turn on')).toThrow();
    buttonBy(el, 'Turn on').click();
    await flush();
    expect(sent(ctx, '/config/settings')).toEqual([{ set: { 'verification.auto_on_completion': true } }]);
    // Both are shown before the trust: the person sees what else they trust with it.
    expect(ctx.confirms[0]?.body).toContain(
      'This folder is treated as disposable: commands that would wait for your approval run on their own (sandbox: false → true, .friday/config.yaml)',
    );
    expect(sent(ctx, '/policy/trust')).toHaveLength(1);
    td.run();

    // The list does not hold the setting (config.yaml changed meanwhile): nothing is trusted.
    const other = makeContext({
      snapshot: makeSnapshot({ verification: { checks: [], auto_on_completion: false, auto_requested: true } }),
      answers: { 'GET /policy': POLICY(false, ['sandbox']) },
    });
    const td2 = new Teardown();
    buttonBy(autoVerifySwitch(other, td2), 'Trust and turn on').click();
    await flush();
    expect(sent(other, '/policy/trust')).toHaveLength(0);
    expect(other.confirms).toHaveLength(0);
    expect(other.toasts.at(-1)).toMatchObject({ kind: 'warn' });
    td2.run();
  });

  it('does not ask to trust what is already trusted, and says when the project has no checks of its own', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ verification: { checks: [], auto_on_completion: false } }),
      answers: { 'GET /policy': POLICY(true) },
    });
    const td = new Teardown();
    const el = autoVerifySwitch(ctx, td);
    expect(el.textContent).toContain('This project has no checks of its own set yet');
    buttonBy(el, 'Turn on').click();
    await flush();
    expect(ctx.confirms).toHaveLength(0);
    expect(sent(ctx, '/policy/trust')).toHaveLength(0);
    td.run();
    // With checks of its own, that note is not shown.
    const td2 = new Teardown();
    expect(autoVerifySwitch(makeContext(), td2).textContent).not.toContain('no checks of its own');
    td2.run();
  });
});

describe('turning a switch off again (2026-11-17)', () => {
  it('sets it back at once, with no trust to ask for when nothing else was on', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ verification: { checks: [], auto_on_completion: true, auto_requested: true } }),
      answers: { 'GET /policy': { policy: { loosening: [], loosening_hash: null, trusted: true } } },
    });
    const td = new Teardown();
    const el = autoVerifySwitch(ctx, td);
    expect(() => buttonBy(el, 'Turn on')).toThrow();
    buttonBy(el, 'Turn off').click();
    await flush();
    expect(sent(ctx, '/config/settings')).toEqual([{ set: { 'verification.auto_on_completion': false } }]);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Finished work waits for you to click Check' });
    expect(ctx.confirms).toHaveLength(0);
    expect(sent(ctx, '/policy/trust')).toHaveLength(0);
    expect(ctx.refreshes).toBe(1);
    td.run();
  });

  it('asks again for the settings that stay on: they were trusted with it as one list', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ verification: { checks: [], auto_on_completion: true, auto_requested: true } }),
      // What is left once automatic checks are out of config.yaml.
      answers: { 'GET /policy': POLICY(false, ['master_brain.auto_approve']) },
    });
    const td = new Teardown();
    buttonBy(autoVerifySwitch(ctx, td), 'Turn off').click();
    await flush();
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.confirms[0]?.title).toBe('Keep these settings on?');
    expect(ctx.confirms[0]?.body[0]).toBe(
      'Plans start without waiting for your approval (master_brain.auto_approve: false → true, .friday/config.yaml)',
    );
    expect(ctx.confirms[0]?.body[1]).toContain('trusted together with the one you just turned off');
    expect(sent(ctx, '/policy/trust')).toEqual([{ loosening_hash: 'hash0123456789ab' }]);
    td.run();
  });

  it('takes a setting nobody trusted here out of config.yaml', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ verification: { checks: [], auto_on_completion: false, auto_requested: true } }),
      answers: { 'GET /policy': { policy: { loosening: [], loosening_hash: null, trusted: true } } },
    });
    const td = new Teardown();
    buttonBy(autoVerifySwitch(ctx, td), 'Take it out of config.yaml').click();
    await flush();
    expect(sent(ctx, '/config/settings')).toEqual([{ set: { 'verification.auto_on_completion': false } }]);
    td.run();
  });
});

describe('starting plans without asking (2026-11-17)', () => {
  it('reads it from that setting alone', () => {
    expect(autoApproval(null)).toBe('off');
    expect(autoApproval(makeSnapshot({ brain: brain() }))).toBe('off');
    expect(autoApproval(makeSnapshot({ brain: brain({ auto_approve_requested: true }) }))).toBe('untrusted');
    expect(autoApproval(makeSnapshot({ brain: brain({ auto_approve: true, auto_approve_requested: true }) }))).toBe(
      'on',
    );
    // Another loosening waiting for trust says nothing about this one.
    expect(autoApproval(makeSnapshot({ brain: brain(), policy_untrusted: true }))).toBe('off');
  });

  it('sets config.yaml, then asks for this computer’s trust in the list that holds it', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ brain: brain() }),
      answers: { 'GET /policy': POLICY(false, ['master_brain.auto_approve']) },
    });
    const td = new Teardown();
    const el = autoApproveSwitch(ctx, td);
    expect(el.textContent).toContain('Start plans without asking me');
    expect(el.textContent).toContain('A plan the planner has a question about still waits for you.');
    buttonBy(el, 'Turn on').click();
    await flush();
    expect(sent(ctx, '/config/settings')).toEqual([{ set: { 'master_brain.auto_approve': true } }]);
    expect(ctx.confirms[0]?.body).toContain(
      'Plans start without waiting for your approval (master_brain.auto_approve: false → true, .friday/config.yaml)',
    );
    expect(sent(ctx, '/policy/trust')).toEqual([{ loosening_hash: 'hash0123456789ab' }]);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Plans now start without waiting for you' });
    td.run();
  });

  it('never trusts another setting in its place, and says when it is on, with the way back', async () => {
    const other = makeContext({
      snapshot: makeSnapshot({ brain: brain({ auto_approve_requested: true }) }),
      answers: { 'GET /policy': POLICY(false, ['sandbox']) },
    });
    const td = new Teardown();
    buttonBy(autoApproveSwitch(other, td), 'Trust and turn on').click();
    await flush();
    expect(sent(other, '/config/settings')).toHaveLength(0);
    expect(sent(other, '/policy/trust')).toHaveLength(0);
    expect(other.toasts.at(-1)).toMatchObject({
      kind: 'warn',
      text: 'Starting plans automatically is not among the settings that wait for trust',
    });
    td.run();

    const on = makeContext({
      snapshot: makeSnapshot({ brain: brain({ auto_approve: true, auto_approve_requested: true }) }),
      answers: { 'GET /policy': { policy: { loosening: [], loosening_hash: null, trusted: true } } },
    });
    const td2 = new Teardown();
    const el = autoApproveSwitch(on, td2);
    expect(el.textContent).toContain('Plans start as soon as the planner proposes them.');
    buttonBy(el, 'Turn off').click();
    await flush();
    expect(sent(on, '/config/settings')).toEqual([{ set: { 'master_brain.auto_approve': false } }]);
    expect(on.toasts.at(-1)).toEqual({ kind: 'success', text: 'Each plan waits for your approval' });
    td2.run();
  });
});

describe('putting finished work into the project (2026-11-17)', () => {
  const CHECKED = { checks: [{ name: 'tests', kind: 'test', required: true }], auto_on_completion: false };
  const LAND_POLICY = (to: string) => ({
    policy: {
      loosening: [{ source: '.friday/config.yaml', setting: 'landing.mode', from: 'ask', to }],
      loosening_hash: 'hash0123456789ab',
      trusted: false,
    },
  });
  const choice = (el: HTMLElement, mode: string) => {
    const b = el.querySelector<HTMLButtonElement>(`.pn-landing-choice[data-mode="${mode}"]`);
    if (!b) throw new Error(`no choice ${mode}`);
    return b;
  };

  it('reads "ask me" from an older daemon, and what is in force otherwise', () => {
    expect(landingState(null)).toEqual({ mode: 'ask', requested: 'ask' });
    expect(landingState(makeSnapshot({ landing: { mode: 'ask', requested: 'goal' } }))).toEqual({
      mode: 'ask',
      requested: 'goal',
    });
  });

  it('sets the choice, then asks before trusting it on this computer', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ verification: CHECKED }),
      answers: { 'GET /policy': LAND_POLICY('goal'), 'POST /policy/trust': LAND_POLICY('goal') },
    });
    const td = new Teardown();
    const el = landingChoice(ctx, td);
    // "Ask me" is what holds, so it is not a choice to make again.
    expect(choice(el, 'ask').getAttribute('aria-checked')).toBe('true');
    expect(choice(el, 'ask').disabled).toBe(true);
    choice(el, 'goal').click();
    await flush();
    expect(sent(ctx, '/config/settings')).toEqual([{ set: { 'landing.mode': 'goal' } }]);
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.confirms[0]?.body).toContain(
      'A goal that has passed its checks is put into your project without asking (landing.mode: ask → goal, .friday/config.yaml)',
    );
    expect(sent(ctx, '/policy/trust')).toEqual([{ loosening_hash: 'hash0123456789ab' }]);
    ctx.board(makeSnapshot({ verification: CHECKED, landing: { mode: 'goal', requested: 'goal' } }));
    expect(choice(el, 'goal').getAttribute('aria-checked')).toBe('true');
    td.run();
  });

  it('going back to "Ask me" is in force at once and needs no trust', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ verification: CHECKED, landing: { mode: 'task', requested: 'task' } }),
      answers: { 'GET /policy': { policy: { loosening: [], loosening_hash: null, trusted: true } } },
    });
    const td = new Teardown();
    const el = landingChoice(ctx, td);
    choice(el, 'ask').click();
    await flush();
    expect(sent(ctx, '/config/settings')).toEqual([{ set: { 'landing.mode': 'ask' } }]);
    expect(ctx.confirms).toHaveLength(0);
    td.run();
  });

  it('says that nothing lands by itself in a project without a required check', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ verification: { checks: [], auto_on_completion: false } }) });
    const td = new Teardown();
    expect(landingChoice(ctx, td).textContent).toContain('no required check');
    td.run();
  });
});

describe('a switch that says where it stands (2026-11-18)', () => {
  it('reads Off, then On with what that means, and no tick that could pass for "already on"', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ verification: { checks: [], auto_on_completion: false } }) });
    const td = new Teardown();
    const el = autoVerifySwitch(ctx, td);
    const off = el.querySelector<HTMLButtonElement>('.pn-switch');
    expect(off?.getAttribute('role')).toBe('switch');
    expect(off?.getAttribute('aria-checked')).toBe('false');
    expect(off?.textContent).toBe('Off');
    expect(off?.getAttribute('aria-label')).toBe('Turn on');
    expect(el.querySelector('.pn-switch svg')).toBeNull();
    ctx.board(makeSnapshot({ verification: { checks: [], auto_on_completion: true } }));
    const on = el.querySelector<HTMLButtonElement>('.pn-switch');
    expect(on?.getAttribute('aria-checked')).toBe('true');
    expect(on?.textContent).toBe('On');
    expect(on?.getAttribute('aria-label')).toBe('Turn off');
    expect(el.textContent).toContain('Work is checked as soon as the agent says it is done.');
    td.run();
  });
});
