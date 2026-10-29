/**
 * The first screen as a product (the review of 2026-10-17, plan M9k.2): how many fixed controls a
 * person sees before a single card is counted, over the real areas mounted in the real shell, and
 * that every door that left the first screen still opens through the door review §6 names.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { studioAreas } from '../areas.js';
import { makeContext } from '../test/context.js';
import { makeScenario } from '../test/fixtures.js';
import { h } from '../ui/dom.js';
import { createShellServices, mountShell, type ShellHandle } from './app.js';
import type { AppContext } from './context.js';

/** Every element gets a 1200×800 box, as a real window would (the canvas measures itself). */
function withSize(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: 1200,
    height: 800,
    right: 1200,
    bottom: 800,
    toJSON: () => ({}),
  } as DOMRect);
}

/** A 2D context that accepts every call (the grid and the edges draw into it). */
function withCanvas(): void {
  const fake = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key in target) return target[key];
      return () => undefined;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake as never);
}

function keyEvent(k: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods });
}

let shell: ShellHandle | null = null;

function mount(): { ctx: ReturnType<typeof makeContext>; shell: ShellHandle; root: HTMLElement } {
  withSize();
  withCanvas();
  const ctx = makeContext({ snapshot: makeScenario() });
  ctx.store.patch('prefs', { motion: 'reduce' });
  const services = createShellServices(ctx.keys);
  const shellCtx: AppContext = { ...ctx, toast: (t) => services.toasts.show(t) };
  const root = h('div');
  document.body.append(root);
  // The browser Studio without its in-page Notch (the pill is one more control, counted apart) and
  // without the sound and notification services, which need a page.
  shell = mountShell(shellCtx, services, root, studioAreas({ notch: false, sounds: false }));
  return { ctx, shell, root };
}

afterEach(() => {
  shell?.destroy();
  shell = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const text = (el: Element | null) => el?.getAttribute('aria-label') ?? el?.textContent?.trim() ?? '';

describe('the first screen', () => {
  it('shows 20 fixed controls over header, dock, toolbar and rail headings (the review counted 27; its target is about 20)', () => {
    const { ctx, root } = mount();
    ctx.store.patch('system', { connection: 'live' });
    // Fixed means visible before anything was done: a control that appears only in a state (Tidy
    // after a drag, the minimap when a card lies outside the view) is not one.
    const visible = (b: Element) => !(b as HTMLElement).hidden && !b.closest('[hidden]');
    // The header, counted as the review counts it: the mark, the project, the state dot, each count
    // and each button (the menu is one button; its items are one click away).
    const header = root.querySelector('.sh-header') as HTMLElement;
    const headerFixed = [
      ...header.querySelectorAll('.sh-brand, .sh-project, .sh-daemon, .sh-metric'),
      ...[...header.querySelectorAll<HTMLButtonElement>('.sh-actions button')].filter(
        (b) => !b.closest('[role="menu"]'),
      ),
    ];
    const name = (e: Element) =>
      e.classList.contains('sh-brand') ? 'mark' : text(e.querySelector('.sh-btn-label, .sh-metric-label')) || text(e);
    expect(headerFixed.map(name)).toEqual([
      'shop',
      'Connected',
      'Running',
      'Waiting for you',
      'Search',
      'Messages',
      'More',
      'Settings',
    ]);
    const dock = [...root.querySelectorAll('.dk-dock button')].filter(visible);
    expect(dock.map((b) => text(b.querySelector('.dk-label')))).toEqual(['New goal', 'Agents', 'Pause', 'Halt']);
    const toolbar = [...root.querySelectorAll('.cv-toolbar button')].filter(visible);
    expect(toolbar.map(text)).toEqual([
      'Fit everything (F)',
      'Zoom out (−)',
      'Zoom level; press to reset to 100 percent',
      'Zoom in (+)',
      'Finished goals',
    ]);
    // The minimap is there for a board that outgrows the window, not for this one.
    expect((root.querySelector('.cv-minimap') as HTMLElement | null)?.hidden ?? true).toBe(true);
    const railHeadings = [...root.querySelectorAll('.sh-rail h2')].filter(visible);
    expect(railHeadings.map(text)).toEqual(['Waiting for you', 'Getting started']);
    // 8 (header: project, state dot, Running, Waiting for you, Search, Messages, More, gear)
    // + 4 (dock) + 5 (toolbar: Fit, −, 100 %, +, Finished goals) + 2 (rail headings) = 19. Not
    // counted: the browser's Notch pill (one more, not mounted here), Tidy (only after a drag) and
    // the minimap (only while a card lies outside the view). The review counted 27 before M9k.
    expect(headerFixed.length + dock.length + toolbar.length + railHeadings.length).toBe(19);
    // Nothing on the first screen repeats something visible beside it.
    expect(root.querySelectorAll('[aria-label="Settings"]')).toHaveLength(1);
    expect(root.querySelectorAll('.sh-search, .dk-search')).toHaveLength(1);
    expect(root.querySelector('[aria-label="Mute sounds"]')).toBeNull();
    expect(root.querySelector('.sh-routing')).toBeNull();
  });
});

describe('every door that left the first screen still opens (review §6)', () => {
  it('the dock’s Search: the header’s Search button and Ctrl+K', () => {
    const { ctx, root } = mount();
    (root.querySelector('.sh-search') as HTMLButtonElement).click();
    expect(ctx.store.select('ui').paletteOpen).toBe(true);
    expect((root.querySelector('.dk-pal-backdrop') as HTMLElement).hidden).toBe(false);
    ctx.keys.handle(keyEvent('Escape'));
    expect(ctx.store.select('ui').paletteOpen).toBe(false);
    ctx.keys.handle(keyEvent('k', { ctrlKey: true }));
    expect(ctx.store.select('ui').paletteOpen).toBe(true);
  });

  it('the dock’s gear: the header’s gear, and the palette’s Settings', () => {
    const { ctx, root } = mount();
    (root.querySelector('.sh-settings') as HTMLButtonElement).click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings' });
    expect(root.querySelector('.sh-drawer[data-kind="settings"]')).not.toBeNull();
  });

  it('the dock’s Mute: the palette’s Mute sounds and Unmute sounds, typed', async () => {
    const { ctx, root } = mount();
    const palette = root.querySelector('.dk-pal-backdrop') as HTMLElement;
    const type = (t: string) => {
      const input = palette.querySelector('input') as HTMLInputElement;
      input.value = t;
      input.dispatchEvent(new Event('input'));
    };
    ctx.store.patch('ui', { paletteOpen: true });
    type('mute sounds');
    expect(palette.querySelector('[role="option"]')?.getAttribute('data-entry')).toBe('cmd:mute');
    ctx.keys.handle(keyEvent('Enter'));
    await vi.waitFor(() => expect(ctx.store.select('prefs').muted).toBe(true));
    ctx.store.patch('ui', { paletteOpen: true });
    type('unmute');
    expect(palette.querySelector('[role="option"]')?.getAttribute('data-entry')).toBe('cmd:unmute');
  });

  it('the header’s Memory, Code graph and the address: the More menu and its About', () => {
    const { ctx, root } = mount();
    const more = root.querySelector('[aria-label="More"]') as HTMLButtonElement;
    const item = (id: string) => root.querySelector(`[role="menu"] [data-item="${id}"]`) as HTMLButtonElement;
    more.click();
    item('memory').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'memory' });
    expect(root.querySelector('.sh-drawer[data-kind="memory"] .sh-drawer-title')?.textContent).toBe('Project memory');
    more.click();
    item('graph').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'graph' });
    more.click();
    item('about').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings', tab: 'about' });
    expect(ctx.store.select('ui').activeView).toBe('settings');
    expect(root.querySelector('.sh-settings-hub')).not.toBeNull();
  });

  it('the header’s Messages opens the drawer under its one name', () => {
    const { ctx, root } = mount();
    (root.querySelector('.sh-messages') as HTMLButtonElement).click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inbox' });
    expect(root.querySelector('.sh-drawer[data-kind="inbox"] .sh-drawer-title')?.textContent).toBe('Messages');
  });

  it('the palette’s housekeeping (Prune, Reindex, Stop Friday…, Reset moved cards): typed, not in the empty list', () => {
    const { ctx, root } = mount();
    ctx.store.patch('prefs', { positions: { task_00000000000000000000api001: { x: 1, y: 2 } } });
    const palette = root.querySelector('.dk-pal-backdrop') as HTMLElement;
    const listed = () => [...palette.querySelectorAll('[role="option"]')].map((o) => o.getAttribute('data-entry'));
    const type = (t: string) => {
      const input = palette.querySelector('input') as HTMLInputElement;
      input.value = t;
      input.dispatchEvent(new Event('input'));
    };
    ctx.store.patch('ui', { paletteOpen: true });
    for (const id of ['cmd:prune-worktrees', 'cmd:reindex-graph', 'cmd:stop-friday', 'cmd:reset-layout'])
      expect(listed()).not.toContain(id);
    expect(listed()).toContain('cmd:fit');
    type('prune');
    expect(listed()).toContain('cmd:prune-worktrees');
    type('reindex');
    expect(listed()).toContain('cmd:reindex-graph');
    type('stop friday');
    expect(listed()).toContain('cmd:stop-friday');
    type('reset moved');
    expect(listed()).toContain('cmd:reset-layout');
    // Zoom in and Zoom out left the palette for good: the toolbar, the wheel and the keys zoom.
    type('zoom');
    expect(listed()).not.toContain('cmd:zoom-in');
    expect(listed()).not.toContain('cmd:zoom-out');
  });
});
