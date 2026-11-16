/**
 * The two Settings switches: planning through Claude Code sets config.yaml, then asks this machine
 * to allow the spending and restarts Friday; checking the work automatically sets config.yaml, then
 * asks for this clone's trust. Neither skips the step Friday's rules require.
 */
import type { BrainStatusView } from '@friday/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopCommands } from '../shell/context.js';
import { makeContext } from '../test/context.js';
import { makeSnapshot } from '../test/fixtures.js';
import { Teardown } from './common.js';
import {
  autoVerification,
  autoVerifySwitch,
  CLAUDE_CODE_BUDGET,
  claudeCodePlanning,
  plannerQuickSetup,
} from './quick-setup.js';
import { buttonBy, flush, HOSTILE } from './test-support.js';

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
  ...over,
});

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

const POLICY = (trusted: boolean) => ({
  policy: {
    loosening: [
      { source: '.friday/config.yaml', setting: 'verification.auto_on_completion', from: 'false', to: 'true' },
    ],
    loosening_hash: 'hash0123456789ab',
    trusted,
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('where the switches stand', () => {
  it('reads planning through Claude Code from the board', () => {
    expect(claudeCodePlanning(null)).toBe('off');
    expect(claudeCodePlanning(makeSnapshot({ brain: brain() }))).toBe('off');
    expect(claudeCodePlanning(makeSnapshot({ brain: brain({ provider: 'claude-code' }) }))).toBe('approve');
    expect(
      claudeCodePlanning(makeSnapshot({ brain: brain({ provider: 'claude-code', planner_available: true }) })),
    ).toBe('ready');
    // config.yaml names it, but the running daemon still plans with what it started with.
    expect(claudeCodePlanning(makeSnapshot({ brain: brain(), config: restartNeeded(['master_brain.provider']) }))).toBe(
      'restart',
    );
    expect(
      claudeCodePlanning(
        makeSnapshot({ brain: brain(), config: restartNeeded(['providers.claude-code.allow_remote']) }),
      ),
    ).toBe('restart');
    expect(claudeCodePlanning(makeSnapshot({ brain: brain(), config: restartNeeded(['daemon.port']) }))).toBe('off');
  });

  it('reads automatic verification from the board', () => {
    expect(autoVerification(null)).toBe('off');
    expect(autoVerification(makeSnapshot())).toBe('off');
    expect(autoVerification(makeSnapshot({ policy_untrusted: true }))).toBe('untrusted');
    expect(
      autoVerification(
        makeSnapshot({ verification: { checks: [], auto_on_completion: true }, policy_untrusted: true }),
      ),
    ).toBe('on');
  });
});

describe('planning with Claude Code', () => {
  it('on the desktop sets config.yaml, asks this machine to allow the spending, then restarts', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ brain: brain() }),
      answers: { 'POST /config/settings': { changed: ['master_brain.provider'] } },
    });
    const { steps } = onDesktop(ctx);
    const td = new Teardown();
    const el = plannerQuickSetup(ctx, td);
    expect(el.textContent).toContain('no API key');
    buttonBy(el, 'Use Claude Code to plan').click();
    await flush();
    expect(ctx.transport.to('POST', '/config/settings')[0]?.body).toEqual({
      set: {
        'master_brain.provider': 'claude-code',
        'providers.claude-code.allow_remote': true,
        'providers.claude-code.daily_budget_usd': CLAUDE_CODE_BUDGET,
      },
    });
    expect(steps).toEqual([`allow ${CLAUDE_CODE_BUDGET} claude-code`, 'restart']);
    td.run();
  });

  it('takes the budget typed, and does not restart when the spending is not allowed', async () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ brain: brain() }) });
    const { steps } = onDesktop(ctx, {
      allowSpending: async (budget: number, provider?: string) => {
        steps.push(`allow ${budget} ${provider}`);
        return false;
      },
    });
    const td = new Teardown();
    const el = plannerQuickSetup(ctx, td);
    const budget = el.querySelector('input[type="number"]') as HTMLInputElement;
    budget.value = '7';
    budget.dispatchEvent(new Event('input'));
    buttonBy(el, 'Use Claude Code to plan').click();
    await flush();
    const sent = ctx.transport.to('POST', '/config/settings')[0]?.body as { set: Record<string, unknown> };
    expect(sent.set['providers.claude-code.daily_budget_usd']).toBe(7);
    expect(steps).toEqual(['allow 7 claude-code']);
    td.run();
  });

  it('stops when config.yaml cannot be set', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ brain: brain() }),
      answers: {
        'POST /config/settings': () => {
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

  it('in a browser sets config.yaml and shows the terminal step for this machine', async () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ brain: brain() }) });
    const td = new Teardown();
    const el = plannerQuickSetup(ctx, td);
    expect(el.textContent).toContain(`friday brain allow-remote --provider claude-code --budget ${CLAUDE_CODE_BUDGET}`);
    buttonBy(el, 'Use Claude Code to plan').click();
    await flush();
    expect(ctx.transport.to('POST', '/config/settings')).toHaveLength(1);
    td.run();
  });

  it('offers a restart when one is needed, and says when it is on', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ brain: brain(), config: restartNeeded(['master_brain.provider']) }),
    });
    const { steps } = onDesktop(ctx);
    const td = new Teardown();
    const el = plannerQuickSetup(ctx, td);
    expect(el.textContent).toContain('restart needed');
    buttonBy(el, 'Restart Friday').click();
    await flush();
    expect(steps).toEqual(['restart']);
    ctx.board(makeSnapshot({ brain: brain({ provider: 'claude-code', planner_available: true }) }));
    expect(el.textContent).toContain('The Master Brain plans through Claude Code.');
    expect(() => buttonBy(el, 'Use Claude Code to plan')).toThrow();
    td.run();
  });
});

describe('checking the work automatically', () => {
  it('in a browser sets config.yaml, then asks before trusting it here', async () => {
    const ctx = makeContext({ answers: { 'GET /policy': POLICY(false), 'POST /policy/trust': POLICY(true) } });
    const td = new Teardown();
    const el = autoVerifySwitch(ctx, td);
    buttonBy(el, 'Turn on').click();
    await flush();
    expect(ctx.transport.to('POST', '/config/settings')[0]?.body).toEqual({
      set: { 'verification.auto_on_completion': true },
    });
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.confirms[0]?.body).toContain('verification.auto_on_completion: false → true (.friday/config.yaml)');
    expect(ctx.transport.to('POST', '/policy/trust')[0]?.body).toEqual({ loosening_hash: 'hash0123456789ab' });
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
    expect(ctx.transport.to('POST', '/config/settings')).toHaveLength(1);
    expect(ctx.transport.to('POST', '/policy/trust')).toHaveLength(0);
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
    expect(ctx.transport.to('POST', '/policy/trust')).toHaveLength(1);
    td.run();
  });

  it('when set but not trusted, only trusts; when on, says so', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ policy_untrusted: true }),
      answers: { 'GET /policy': POLICY(false) },
    });
    const td = new Teardown();
    const el = autoVerifySwitch(ctx, td);
    buttonBy(el, 'Trust and turn on').click();
    await flush();
    expect(ctx.transport.to('POST', '/config/settings')).toHaveLength(0);
    expect(ctx.transport.to('POST', '/policy/trust')).toHaveLength(1);
    ctx.board(makeSnapshot({ verification: { checks: [], auto_on_completion: true } }));
    expect(el.textContent).toContain('Finished work is checked as soon as it is claimed.');
    td.run();
  });

  it('does not ask to trust what is already trusted', async () => {
    const ctx = makeContext({ answers: { 'GET /policy': POLICY(true) } });
    const td = new Teardown();
    const el = autoVerifySwitch(ctx, td);
    buttonBy(el, 'Turn on').click();
    await flush();
    expect(ctx.confirms).toHaveLength(0);
    expect(ctx.transport.to('POST', '/policy/trust')).toHaveLength(0);
    td.run();
  });
});
