import { afterEach, describe, expect, it, vi } from 'vitest';
import { statusSentence } from '../notch/derive.js';
import type { SystemState } from '../store/state.js';
import { STALE_PAGE_MESSAGE, STOPPING_MESSAGE, UNREACHABLE_MESSAGE } from '../sync/sync-engine.js';
import { makeContext } from '../test/context.js';
import {
  makeAgent,
  makeApproval,
  makeEscalation,
  makeInboxItem,
  makeRun,
  makeSnapshot,
  makeTask,
} from '../test/fixtures.js';
import { h } from '../ui/dom.js';
import {
  CONFIG_ERROR_MESSAGE,
  configBannerText,
  configChanged,
  mountBanners,
  pageIsStale,
  RESTART_HINT_BROWSER,
  RESTART_HINT_DESKTOP,
} from './banners.js';
import { connectionView, mountConnectionStrip, OFFLINE_AFTER_ATTEMPTS, SIGNED_OUT_MESSAGE } from './connection.js';
import type { AppContext, Component, DesktopCommands } from './context.js';
import { daemonAddress, headerCounts, mountHeader } from './header.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const BIDI = '\u202E';
const ZW = '\u200B';
const LONG = 'x'.repeat(5000);
const NOW = Date.parse('2026-10-17T10:00:00.000Z');

const mounted: Component[] = [];
afterEach(() => {
  for (const c of mounted.splice(0)) c.destroy();
  document.body.replaceChildren();
});

function sys(over: Partial<SystemState> = {}): SystemState {
  return { connection: 'live', sequence: 1, attempts: 0, lastError: null, refreshing: false, snapshotAt: 0, ...over };
}

describe('header', () => {
  it('shows a hostile project name as text, with the folder path in its tooltip, hidden characters made visible', () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({
        project: {
          ...makeSnapshot().project,
          name: `${HOSTILE}${BIDI}${ZW}${LONG}`,
          root: `C:/p/${HOSTILE}${BIDI}${ZW}${LONG}`,
        },
      }),
    });
    const header = mountHeader(ctx);
    mounted.push(header);
    expect(header.el.querySelector('img')).toBeNull();
    const name = header.el.querySelector('.sh-project-name') as HTMLElement;
    expect(name.textContent?.startsWith(HOSTILE)).toBe(true);
    expect(name.textContent).toContain('⟨U+202E⟩');
    expect(name.textContent).toContain('⟨U+200B⟩');
    expect(name.textContent).not.toContain(BIDI);
    expect((name.textContent ?? '').length).toBeLessThan(200);
    // The folder path left the header for the name's tooltip (review §6).
    expect(header.el.querySelector('.sh-project-root')).toBeNull();
    expect(name.title.startsWith('C:/p/')).toBe(true);
    expect(name.title).toContain('⟨U+200B⟩');
    expect(name.title).not.toContain(BIDI);
  });

  it('keeps the address in the state dot’s tooltip, not on the screen', () => {
    const ctx = makeContext();
    const header = mountHeader(ctx);
    mounted.push(header);
    expect(header.el.querySelector('.sh-daemon-address')).toBeNull();
    expect(header.el.textContent).not.toContain('127.0.0.1');
    const daemon = header.el.querySelector('.sh-daemon') as HTMLElement;
    ctx.store.patch('system', { connection: 'live' });
    expect(daemon.title).toBe('Friday is connected · 127.0.0.1:4310');
    ctx.store.patch('system', { connection: 'reconnecting', attempts: 2 });
    expect(daemon.title).toBe('Reconnecting to Friday (attempt 2)… · 127.0.0.1:4310');
    expect(daemonAddress(makeSnapshot())).toBe('127.0.0.1:4310');
    expect(daemonAddress(null)).toBe('');
  });

  it('shows Running and Waiting for you only: the worktrees count moved to Settings', () => {
    const ctx = makeContext();
    const header = mountHeader(ctx);
    mounted.push(header);
    const labels = [...header.el.querySelectorAll('.sh-metric-label')].map((x) => x.textContent);
    expect(labels).toEqual(['Running', 'Waiting for you']);
  });

  it('puts the status sentence in the Running count’s tooltip', () => {
    const board = makeSnapshot({
      tasks: [
        makeTask({ task_id: 't1', status: 'RUNNING' }),
        makeTask({ task_id: 't2', status: 'RUNNING' }),
        makeTask({ task_id: 't3', status: 'WAITING', waiting_reason: 'blocked' }),
      ],
      counts: { RUNNING: 2, READY: 1, READY_FOR_VERIFICATION: 1, VERIFYING: 1, FAILED: 1 },
      approvals: [makeApproval({ approval_id: 'a1', task_id: 't1' })],
      escalations: [makeEscalation({ escalation_id: 'e1', task_id: null })],
      agents: [makeAgent({ agent_key: 'claude-1' }), makeAgent({ agent_key: 'codex-1', status: 'DISCONNECTED' })],
    });
    expect(statusSentence(board, NOW)).toBe(
      '2 running, 3 waiting for you: 1 approval, 1 question, 1 blocked agent; 1 ready; 2 to verify; 1 failed or lost; 1 agent connected',
    );
    expect(statusSentence(makeSnapshot(), NOW)).toBe('0 running, 0 waiting for you: 0 agents connected');
    // A kind the old sentence did not name (a message awaiting a reply) is named, never an empty clause.
    const message = makeSnapshot({ inbox: [makeInboxItem({ mode: 'request' })] });
    expect(statusSentence(message, NOW)).toBe(
      '0 running, 1 waiting for you: 1 message to reply to; 0 agents connected',
    );
    expect(
      statusSentence(
        makeSnapshot({ control: { paused: true, reason: null, changed_at: null, changed_by: null, halted_at: null } }),
        NOW,
      ),
    ).toMatch(/^Paused\. 0 running/);
    expect(statusSentence(null, NOW)).toBe('Friday is not connected');
    const ctx = makeContext({ snapshot: board });
    const header = mountHeader(ctx);
    mounted.push(header);
    const running = header.el.querySelector('.sh-metric-running') as HTMLElement;
    expect(running.title).toBe(statusSentence(board, NOW));
    // The sentence's waiting number is the header's own: the same rule, never two counts.
    expect(header.el.querySelector('.sh-metric-waiting .sh-metric-value')?.textContent).toBe('3');
  });

  it('counts running tasks and what waits for you', () => {
    const board = makeSnapshot({
      tasks: [
        makeTask({ task_id: 't1', status: 'RUNNING' }),
        makeTask({ task_id: 't2', status: 'RUNNING' }),
        makeTask({ task_id: 't3', status: 'READY' }),
      ],
      runs: {
        t1: makeRun({ task_id: 't1', execution_root: 'C:/wt/a' }),
        t2: makeRun({ task_id: 't2', execution_root: 'C:\\wt\\a\\' }),
        t3: makeRun({ task_id: 't3', execution_root: 'C:/demo/shop' }),
      },
      approvals: [makeApproval({ approval_id: 'a1' }), makeApproval({ approval_id: 'a2', expired: true })],
    });
    // The worktrees in use are not the header's any more: Settings counts them (`worktreesInUse`).
    expect(headerCounts(board, NOW)).toEqual({ running: 2, waiting: 1, messages: 0 });
    expect(headerCounts(null, NOW)).toEqual({ running: 0, waiting: 0, messages: 0 });
    const ctx = makeContext({ snapshot: board });
    const onShowWaiting = vi.fn();
    const header = mountHeader(ctx, { onShowWaiting });
    mounted.push(header);
    const waiting = header.el.querySelector('.sh-metric-waiting') as HTMLButtonElement;
    expect(waiting.classList.contains('sh-metric-hot')).toBe(true);
    expect(waiting.getAttribute('aria-label')).toBe('1 item waiting for you');
    waiting.click();
    expect(onShowWaiting).toHaveBeenCalledOnce();
  });

  it('shows the daemon state from the connection', () => {
    const ctx = makeContext();
    const header = mountHeader(ctx);
    mounted.push(header);
    const dot = header.el.querySelector('.sh-daemon') as HTMLElement;
    const state = () => dot.dataset.state;
    ctx.store.patch('system', { connection: 'live' });
    expect(state()).toBe('connected');
    ctx.store.patch('system', { connection: 'reconnecting', attempts: 1 });
    expect(state()).toBe('reconnecting');
    ctx.store.patch('system', { attempts: OFFLINE_AFTER_ATTEMPTS });
    expect(state()).toBe('offline');
    ctx.store.patch('system', { connection: 'live', lastError: STOPPING_MESSAGE });
    expect(state()).toBe('stopping');
    ctx.store.patch('system', { connection: 'stopped', lastError: UNREACHABLE_MESSAGE });
    expect(state()).toBe('stopped');
    expect(dot.querySelector('.sh-daemon-label')?.textContent).toBe('Stopped');
  });

  it('offers Search, Messages, More and the gear; Memory, Code graph and Routing left the bar', () => {
    const ctx = makeContext();
    const header = mountHeader(ctx);
    mounted.push(header);
    const actions = [
      ...header.el.querySelectorAll<HTMLButtonElement>('.sh-actions > button, .sh-actions > * > button'),
    ];
    for (const b of actions) expect(b.type).toBe('button');
    const names = actions.map((b) => b.getAttribute('aria-label') ?? b.querySelector('.sh-btn-label')?.textContent);
    expect(names).toEqual(['Search', 'Messages', 'More', 'Settings']);
    expect(header.el.querySelector('.sh-routing')).toBeNull();
    expect(header.el.textContent).not.toContain('Routing');
    expect(header.el.textContent).not.toContain('Worktrees');
    const byText = (t: string) => actions.find((b) => b.textContent?.includes(t)) as HTMLButtonElement;
    byText('Search').click();
    expect(ctx.store.select('ui').paletteOpen).toBe(true);
    byText('Messages').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inbox' });
    const settings = header.el.querySelector('[aria-label="Settings"]') as HTMLButtonElement;
    settings.click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings' });
  });

  it('the More menu opens Project memory, the Code graph and About (Settings at its About section)', () => {
    const ctx = makeContext();
    const header = mountHeader(ctx);
    mounted.push(header);
    document.body.append(header.el);
    const more = header.el.querySelector('[aria-label="More"]') as HTMLButtonElement;
    const menu = header.el.querySelector('[role="menu"]') as HTMLElement;
    expect(menu.hidden).toBe(true);
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    const item = (id: string) => menu.querySelector(`[data-item="${id}"]`) as HTMLButtonElement;
    more.click();
    expect(menu.hidden).toBe(false);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toEqual([
      'Project memory',
      'Code graph',
      'About',
    ]);
    item('memory').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'memory' });
    expect(menu.hidden).toBe(true);
    more.click();
    item('graph').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'graph' });
    more.click();
    item('about').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings', tab: 'about' });
    expect(ctx.store.select('ui').activeView).toBe('settings');
  });

  it('shows the pause banner with its reason, and Resume resumes', async () => {
    const ctx = makeContext({
      answers: { 'POST /control/resume': { control: { paused: false }, tasks: [] } },
      snapshot: makeSnapshot({
        control: {
          paused: true,
          reason: `${HOSTILE}${BIDI}${LONG}`,
          changed_at: '2026-10-17T09:30:00.000Z',
          changed_by: 'local-operator',
          halted_at: null,
        },
      }),
    });
    const header = mountHeader(ctx);
    mounted.push(header);
    const pause = header.el.querySelector('.sh-pause') as HTMLElement;
    expect(pause.hidden).toBe(false);
    expect(header.el.querySelector('img')).toBeNull();
    const text = pause.textContent ?? '';
    expect(text).toContain('Friday is paused');
    expect(text).toContain(HOSTILE);
    expect(text).not.toContain(BIDI);
    expect(text.length).toBeLessThan(600);
    (pause.querySelector('.sh-pause-resume') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(ctx.transport.to('POST', '/control/resume')).toHaveLength(1));
    ctx.board(makeSnapshot());
    expect(pause.hidden).toBe(true);
  });

  it('says when Friday was halted', () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({
        control: { paused: true, reason: null, changed_at: null, changed_by: null, halted_at: '2026-10-17T09:00:00Z' },
      }),
    });
    const header = mountHeader(ctx);
    mounted.push(header);
    expect(header.el.querySelector('.sh-pause')?.textContent).toContain('Friday was halted and is paused');
  });

  it('re-renders when an approval expires, then stops its timer', () => {
    vi.useFakeTimers();
    const ctx = makeContext({
      snapshot: makeSnapshot({ approvals: [makeApproval({ expires_at: '2026-10-17T10:00:05.000Z' })] }),
    });
    const header = mountHeader(ctx);
    const value = () => header.el.querySelector('.sh-metric-waiting .sh-metric-value')?.textContent;
    expect(value()).toBe('1');
    ctx.clock.now += 6000;
    vi.advanceTimersByTime(6000);
    expect(value()).toBe('0');
    header.destroy();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

/** A snapshot whose config.yaml changed: the port waits for a restart, a scope applied. */
const portChanged = () =>
  makeSnapshot({
    config: {
      loaded_hash: 'a',
      current_hash: 'b',
      changes: { applied: ['scopes.frontend.write'], restart_needed: ['daemon.port'], error: null },
    },
  });

describe('banners', () => {
  it('names the changed key that needs a restart, and how to restart from a browser', () => {
    // A changed file whose every key applied says nothing; the hashes alone decide nothing.
    expect(configChanged(portChanged())).toBe(true);
    expect(
      configChanged(
        makeSnapshot({
          config: {
            loaded_hash: 'a',
            current_hash: 'b',
            changes: { applied: ['scopes'], restart_needed: [], error: null },
          },
        }),
      ),
    ).toBe(false);
    expect(configChanged(makeSnapshot({ config: { loaded_hash: 'a', current_hash: 'b' } }))).toBe(false);
    expect(configChanged(makeSnapshot())).toBe(false);
    expect(configChanged(null)).toBe(false);
    expect(configBannerText({ applied: [], restart_needed: ['daemon.port'], error: null })).toBe(
      'config.yaml changed: daemon.port needs a restart to apply.',
    );
    expect(
      configBannerText({
        applied: ['scopes.api'],
        restart_needed: ['daemon.port', 'leases.lease_ttl_ms'],
        error: null,
      }),
    ).toBe('config.yaml changed: scopes.api applied; daemon.port and leases.lease_ttl_ms need a restart to apply.');
    const ctx = makeContext({ snapshot: portChanged() });
    const open = vi.spyOn(ctx.platform, 'openInEditor');
    const banners = mountBanners(ctx);
    mounted.push(banners);
    const banner = banners.el.querySelector('.sh-banner-warn') as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain(
      'config.yaml changed: scopes.frontend.write applied; daemon.port needs a restart to apply.',
    );
    expect(banner.textContent).toContain(RESTART_HINT_BROWSER);
    expect(banner.querySelector('.sh-banner-restart')).toBeNull();
    (banner.querySelector('button') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith('C:/demo/shop/.friday/config.yaml');
    (banner.querySelector('.sh-banner-settings') as HTMLButtonElement).click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings', tab: 'friday' });
    // Friday restarted (or the key was changed back): nothing waits, so nothing is said.
    ctx.board(
      makeSnapshot({
        config: { loaded_hash: 'b', current_hash: 'b', changes: { applied: [], restart_needed: [], error: null } },
      }),
    );
    expect(banner.hidden).toBe(true);
  });

  it('says when config.yaml could not be read and that the settings in force are unchanged, without a restart', () => {
    const error = 'config.yaml is invalid: daemon.port: Invalid input: expected number, received string';
    const ctx = makeContext({
      snapshot: makeSnapshot({
        config: { loaded_hash: 'a', current_hash: 'b', changes: { applied: [], restart_needed: [], error } },
      }),
    });
    const banners = mountBanners(ctx);
    mounted.push(banners);
    const banner = banners.el.querySelector('.sh-banner-warn') as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain(`${CONFIG_ERROR_MESSAGE} ${error}`);
    expect(banner.textContent).not.toContain(RESTART_HINT_BROWSER);
    expect((banner.querySelector('.sh-banner-settings') as HTMLElement).hidden).toBe(true);
    expect(banner.querySelector('img')).toBeNull();
  });

  it('on the desktop, the config banner restarts Friday from where you are', async () => {
    const base = makeContext({ snapshot: portChanged() });
    const restart = vi.fn(async () => true);
    const desktop = { restart } as unknown as DesktopCommands;
    const ctx: AppContext = { ...base, platform: { ...base.platform, desktop } };
    const banners = mountBanners(ctx);
    mounted.push(banners);
    const banner = banners.el.querySelector('.sh-banner-warn') as HTMLElement;
    expect(banner.textContent).toContain(RESTART_HINT_DESKTOP);
    expect(banner.querySelector('.sh-banner-settings')).toBeNull();
    const button = banner.querySelector('.sh-banner-restart') as HTMLButtonElement;
    expect(button.textContent).toContain('Restart Friday');
    button.click();
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(restart).toHaveBeenCalledOnce();
  });

  it('asks for a reload when the page is older than Friday', () => {
    expect(pageIsStale(makeSnapshot({ ui_api: 2 }))).toBe(true);
    expect(pageIsStale(makeSnapshot())).toBe(false);
    const ctx = makeContext({ snapshot: makeSnapshot({ ui_api: 2 }) });
    const reload = vi.fn();
    const banners = mountBanners(ctx, { reload });
    mounted.push(banners);
    const stale = banners.el.querySelector('.sh-banner-danger') as HTMLElement;
    expect(stale.hidden).toBe(false);
    expect(stale.textContent).toContain(STALE_PAGE_MESSAGE);
    (stale.querySelector('button') as HTMLButtonElement).click();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('shows the getting-started checklist until it is dismissed, and again when brought back', () => {
    const ctx = makeContext();
    const destroy = vi.fn();
    const gettingStarted = vi.fn(() => ({ el: h('div', { class: 'checklist' }, HOSTILE), destroy }));
    const banners = mountBanners(ctx, { gettingStarted });
    mounted.push(banners);
    expect(banners.el.querySelector('.checklist')).not.toBeNull();
    expect(banners.el.querySelector('img')).toBeNull();
    ctx.store.patch('prefs', { gettingStartedDismissed: true });
    expect(destroy).toHaveBeenCalledOnce();
    expect((banners.el.querySelector('.sh-banner-slot') as HTMLElement).hidden).toBe(true);
    ctx.store.patch('prefs', { gettingStartedDismissed: false });
    expect(gettingStarted).toHaveBeenCalledTimes(2);
  });

  it('survives a checklist that fails to build', () => {
    const ctx = makeContext();
    const banners = mountBanners(ctx, {
      gettingStarted: () => {
        throw new Error('broken');
      },
    });
    mounted.push(banners);
    expect((banners.el.querySelector('.sh-banner-slot') as HTMLElement).hidden).toBe(true);
  });

  it('renders a hostile project root without markup', () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({
        config: portChanged().config,
        project: { ...makeSnapshot().project, root: `C:\\${HOSTILE}${BIDI}${LONG}` },
      }),
    });
    const open = vi.spyOn(ctx.platform, 'openInEditor');
    const banners = mountBanners(ctx);
    mounted.push(banners);
    expect(banners.el.querySelector('img')).toBeNull();
    (banners.el.querySelector('.sh-banner-warn button') as HTMLButtonElement).click();
    expect(open.mock.calls[0]?.[0]).toMatch(/\.friday\\config\.yaml$/);
  });
});

describe('connection', () => {
  it('describes every state', () => {
    expect(connectionView(sys())).toMatchObject({ state: 'connected', message: null });
    expect(connectionView(sys({ lastError: 'COS-5000: snapshot failed' }))).toMatchObject({
      state: 'connected',
      detail: 'COS-5000: snapshot failed',
    });
    expect(connectionView(sys({ lastError: STALE_PAGE_MESSAGE })).message).toBeNull();
    expect(connectionView(sys({ connection: 'starting' }))).toMatchObject({
      state: 'reconnecting',
      label: 'Connecting',
    });
    expect(connectionView(sys({ connection: 'connecting' })).message).toBe('Connecting to Friday…');
    expect(connectionView(sys({ connection: 'reconnecting', attempts: 2 }))).toMatchObject({
      state: 'reconnecting',
      message: 'Reconnecting to Friday (attempt 2)…',
    });
    expect(connectionView(sys({ connection: 'reconnecting', attempts: OFFLINE_AFTER_ATTEMPTS })).state).toBe('offline');
    expect(connectionView(sys({ connection: 'live', lastError: STOPPING_MESSAGE }))).toMatchObject({
      state: 'stopping',
      message: 'Friday is stopping.',
    });
    expect(connectionView(sys({ connection: 'stopped', lastError: UNREACHABLE_MESSAGE }))).toMatchObject({
      state: 'stopped',
      message: UNREACHABLE_MESSAGE,
      retry: true,
    });
    expect(connectionView(sys({ connection: 'stopped', lastError: null })).message).toBe(UNREACHABLE_MESSAGE);
    expect(connectionView(sys({ connection: 'signed-out' }))).toMatchObject({
      state: 'signed-out',
      message: SIGNED_OUT_MESSAGE,
    });
  });

  it('hides the strip while live and offers Try again once stopped', () => {
    const ctx = makeContext();
    const onRetry = vi.fn();
    const strip = mountConnectionStrip(ctx.store, { onRetry });
    mounted.push(strip);
    ctx.store.patch('system', { connection: 'live' });
    expect(strip.el.hidden).toBe(true);
    ctx.store.patch('system', { connection: 'reconnecting', attempts: 4, lastError: `${HOSTILE}${BIDI}${LONG}` });
    expect(strip.el.hidden).toBe(false);
    expect(strip.el.dataset.state).toBe('offline');
    expect(strip.el.querySelector('img')).toBeNull();
    const detail = strip.el.querySelector('.sh-strip-detail')?.textContent ?? '';
    expect(detail.startsWith(HOSTILE)).toBe(true);
    expect(detail).not.toContain(BIDI);
    const retry = strip.el.querySelector('.sh-strip-retry') as HTMLButtonElement;
    expect(retry.hidden).toBe(true);
    ctx.store.patch('system', { connection: 'stopped', lastError: UNREACHABLE_MESSAGE });
    expect(strip.el.querySelector('.sh-strip-text')?.textContent).toBe(UNREACHABLE_MESSAGE);
    expect(retry.hidden).toBe(false);
    retry.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
