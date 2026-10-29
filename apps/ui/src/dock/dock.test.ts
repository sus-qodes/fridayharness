import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../shell/context.js';
import { makeContext, type TestContext } from '../test/context.js';
import { makeSnapshot } from '../test/fixtures.js';
import { mountDock, registerDock } from './dock.js';

const PAUSED = { paused: true, reason: null, changed_at: null, changed_by: null, halted_at: null };

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

let ctx: TestContext;
let dock: Component | null = null;

function setup(answers: Record<string, unknown> = {}) {
  ctx = makeContext({ answers });
  const host = document.createElement('div');
  document.body.appendChild(host);
  dock = mountDock(ctx, host);
  const q = (cls: string) => dock?.el.querySelector(`.${cls}`) as HTMLButtonElement;
  return { host, q };
}

afterEach(() => {
  dock?.destroy();
  dock = null;
  document.body.replaceChildren();
});

describe('dock', () => {
  it('is a labelled toolbar of buttons, each with an accessible name', () => {
    const { host } = setup();
    expect(host.contains(dock?.el ?? null)).toBe(true);
    expect(dock?.el.getAttribute('role')).toBe('toolbar');
    expect(dock?.el.getAttribute('aria-label')).toBe('Dock');
    for (const b of dock?.el.querySelectorAll('button') ?? []) {
      expect(b.getAttribute('type')).toBe('button');
      const name = b.getAttribute('aria-label') ?? b.textContent ?? '';
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  it('opens New goal, Agents, Settings, Halt and the palette', () => {
    const { q } = setup();
    q('dk-new-goal').click();
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'new-goal' });
    q('dk-agents').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'agents' });
    q('dk-settings').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings' });
    q('dk-halt-btn').click();
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'halt' });
    expect(ctx.transport.calls).toHaveLength(0);
    q('dk-search').click();
    expect(ctx.store.select('ui').paletteOpen).toBe(true);
  });

  it('labels Pause or Resume from the board and calls the matching route', async () => {
    const { q } = setup();
    const pause = q('dk-pause');
    expect(pause.textContent).toBe('Pause');
    pause.click();
    await flush();
    expect(ctx.transport.to('POST', '/control/pause')).toHaveLength(1);
    ctx.board(makeSnapshot({ control: PAUSED }));
    expect(pause.textContent).toBe('Resume');
    expect(pause.classList.contains('dk-paused')).toBe(true);
    expect(dock?.el.classList.contains('dk-dock-paused')).toBe(true);
    pause.click();
    await flush();
    expect(ctx.transport.to('POST', '/control/resume')).toHaveLength(1);
  });

  it('ignores a second click while the call is in flight', async () => {
    let release: () => void = () => undefined;
    const { q } = setup({
      'POST /control/pause': () =>
        new Promise((resolve) => {
          release = () => resolve({ control: PAUSED, tasks: [], operations_stopped: 0 });
        }),
    });
    const pause = q('dk-pause');
    pause.click();
    await flush();
    expect(pause.disabled).toBe(true);
    pause.click();
    release();
    await flush();
    expect(ctx.transport.to('POST', '/control/pause')).toHaveLength(1);
    expect(pause.disabled).toBe(false);
  });

  it('disables daemon actions while not connected', () => {
    const { q } = setup();
    ctx.store.setState({ board: null });
    expect(q('dk-pause').disabled).toBe(true);
    expect(q('dk-new-goal').disabled).toBe(true);
    expect(q('dk-halt-btn').disabled).toBe(true);
    expect(q('dk-agents').disabled).toBe(false);
  });

  it('toggles mute in the preferences and shows its state', () => {
    const { q } = setup();
    const mute = q('dk-mute');
    expect(mute.getAttribute('aria-pressed')).toBe('false');
    expect(mute.getAttribute('aria-label')).toBe('Mute sounds');
    mute.click();
    expect(ctx.store.select('prefs').muted).toBe(true);
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    expect(mute.getAttribute('aria-label')).toBe('Unmute sounds');
    mute.click();
    expect(ctx.store.select('prefs').muted).toBe(false);
  });

  it('leaves Fit and Zoom to the canvas toolbar', () => {
    setup();
    ctx.registry.command({ id: 'fit', label: 'Fit', run: vi.fn() });
    dock?.el.dispatchEvent(new Event('pointerenter'));
    expect(dock?.el.querySelector('.dk-fit, .dk-zoom-in, .dk-zoom-out, .dk-view')).toBeNull();
  });

  it('moves focus between its buttons with the arrow keys', () => {
    const { q } = setup();
    const buttons = [...(dock?.el.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter((b) => !b.hidden);
    buttons[0]?.focus();
    const arrow = (k: string) =>
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    arrow('ArrowRight');
    expect(document.activeElement).toBe(buttons[1]);
    arrow('ArrowLeft');
    arrow('ArrowLeft');
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    arrow('Home');
    expect(document.activeElement).toBe(q('dk-search'));
    arrow('End');
    expect(document.activeElement).toBe(q('dk-halt-btn'));
  });

  it('stops listening on destroy', () => {
    setup();
    const el = dock?.el as HTMLElement;
    dock?.destroy();
    dock = null;
    expect(el.isConnected).toBe(false);
    ctx.board(makeSnapshot({ control: PAUSED }));
    expect(el.querySelector('.dk-pause')?.textContent).toBe('Pause');
  });
});

describe('registerDock', () => {
  it('registers the halt modal', () => {
    const c = makeContext();
    registerDock(c);
    expect(c.registry.modals.has('halt')).toBe(true);
  });
});
