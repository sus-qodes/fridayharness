import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemState } from '../store/state.js';
import { STALE_PAGE_MESSAGE, STOPPING_MESSAGE, UNREACHABLE_MESSAGE } from '../sync/sync-engine.js';
import { makeContext } from '../test/context.js';
import { makeApproval, makeRun, makeSnapshot, makeTask } from '../test/fixtures.js';
import { h } from '../ui/dom.js';
import { CONFIG_CHANGED_MESSAGE, configChanged, mountBanners, pageIsStale } from './banners.js';
import { connectionView, mountConnectionStrip, OFFLINE_AFTER_ATTEMPTS, SIGNED_OUT_MESSAGE } from './connection.js';
import type { Component } from './context.js';
import { headerCounts, mountHeader } from './header.js';

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
  it('shows a hostile project name and root as text with hidden characters made visible', () => {
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
    const name = header.el.querySelector('.sh-project-name')?.textContent ?? '';
    expect(name.startsWith(HOSTILE)).toBe(true);
    expect(name).toContain('⟨U+202E⟩');
    expect(name).toContain('⟨U+200B⟩');
    expect(name).not.toContain(BIDI);
    expect(name.length).toBeLessThan(200);
    const root = header.el.querySelector('.sh-project-root') as HTMLElement;
    expect(root.textContent).toContain('⟨U+202E⟩');
    expect(root.title).toContain('⟨U+200B⟩');
    expect(header.el.querySelector('.sh-daemon-address')?.textContent).toBe('127.0.0.1:4310');
  });

  it('counts running tasks, worktrees in use and what waits for you', () => {
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
    expect(headerCounts(board, NOW)).toEqual({ running: 2, worktrees: 1, waiting: 1, messages: 0 });
    expect(headerCounts(null, NOW)).toEqual({ running: 0, worktrees: 0, waiting: 0, messages: 0 });
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

  it('opens the palette, the drawers and the routing pins', () => {
    const ctx = makeContext();
    const header = mountHeader(ctx);
    mounted.push(header);
    const buttons = [...header.el.querySelectorAll('button')];
    for (const b of buttons) expect(b.type).toBe('button');
    const byText = (t: string) => buttons.find((b) => b.textContent?.includes(t)) as HTMLButtonElement;
    byText('Search').click();
    expect(ctx.store.select('ui').paletteOpen).toBe(true);
    byText('Memory').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'memory' });
    byText('Code graph').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'graph' });
    byText('Routing').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'agents', tab: 'pins' });
    byText('Messages').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inbox' });
    const settings = header.el.querySelector('[aria-label="Settings"]') as HTMLButtonElement;
    settings.click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings' });
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

describe('banners', () => {
  it('says config.yaml changed while the hashes differ', () => {
    expect(configChanged(makeSnapshot({ config: { loaded_hash: 'a', current_hash: 'b' } }))).toBe(true);
    expect(configChanged(makeSnapshot({ config: { loaded_hash: 'a', current_hash: null } }))).toBe(false);
    expect(configChanged(makeSnapshot())).toBe(false);
    expect(configChanged(null)).toBe(false);
    const ctx = makeContext({ snapshot: makeSnapshot({ config: { loaded_hash: 'a', current_hash: 'b' } }) });
    const open = vi.spyOn(ctx.platform, 'openInEditor');
    const banners = mountBanners(ctx);
    mounted.push(banners);
    const banner = banners.el.querySelector('.sh-banner-warn') as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain(CONFIG_CHANGED_MESSAGE);
    (banner.querySelector('button') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith('C:/demo/shop/.friday/config.yaml');
    ctx.board(makeSnapshot());
    expect(banner.hidden).toBe(true);
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
        config: { loaded_hash: 'a', current_hash: 'b' },
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
