import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from '../shell/context.js';
import { makeContext, type TestContext } from '../test/context.js';
import { makeAgent, makeScenario, makeSnapshot, makeTask } from '../test/fixtures.js';
import { registerCommands } from './commands.js';
import { mountPalette } from './omnibar.js';
import { recentIds } from './palette-model.js';

const HOSTILE = '<img src=x onerror=alert(1)>';

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function key(k: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods });
}

let ctx: TestContext;
let palette: Component | null = null;

function setup(snapshot = makeScenario()) {
  ctx = makeContext({ snapshot });
  registerCommands(ctx);
  const host = document.createElement('div');
  document.body.appendChild(host);
  palette = mountPalette(ctx, host);
  const input = palette.el.querySelector('input') as HTMLInputElement;
  const items = () => [...(palette?.el.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
  const active = () => palette?.el.querySelector<HTMLElement>('.dk-pal-active') ?? null;
  function type(text: string): void {
    input.value = text;
    input.dispatchEvent(new Event('input'));
  }
  return { input, items, active, type };
}

afterEach(() => {
  palette?.destroy();
  palette = null;
  document.body.replaceChildren();
});

describe('palette', () => {
  it('Ctrl+K toggles it, even from a text field; Escape closes it', () => {
    const { input } = setup();
    expect(palette?.el.hidden).toBe(true);
    const field = document.createElement('input');
    document.body.appendChild(field);
    const ev = key('k', { ctrlKey: true });
    Object.defineProperty(ev, 'target', { value: field });
    expect(ctx.keys.handle(ev)).toBe(true);
    expect(ctx.store.select('ui').paletteOpen).toBe(true);
    expect(palette?.el.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    ctx.keys.handle(key('Escape'));
    expect(ctx.store.select('ui').paletteOpen).toBe(false);
    expect(palette?.el.hidden).toBe(true);
    ctx.keys.handle(key('k', { metaKey: true }));
    expect(ctx.store.select('ui').paletteOpen).toBe(true);
    ctx.keys.handle(key('k', { ctrlKey: true }));
    expect(ctx.store.select('ui').paletteOpen).toBe(false);
  });

  it('opens when the store says so and returns focus when it closes', () => {
    setup();
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    ctx.store.patch('ui', { paletteOpen: true });
    expect(palette?.el.hidden).toBe(false);
    ctx.store.patch('ui', { paletteOpen: false });
    expect(document.activeElement).toBe(before);
  });

  it('shows groups without a query and filters by a fuzzy query', () => {
    const { items, type } = setup();
    ctx.store.patch('ui', { paletteOpen: true });
    const headings = [...(palette?.el.querySelectorAll('.dk-pal-heading') ?? [])].map((x) => x.textContent);
    expect(headings).toEqual(['Commands', 'Agents', 'Tasks', 'Goals']);
    type('subpage');
    expect(items()[0]?.textContent).toContain('Add the subscription page');
    expect(palette?.el.querySelector('.dk-pal-hit')).not.toBeNull();
    type('qqqqzzzz');
    expect(items()).toHaveLength(0);
    expect(palette?.el.textContent).toContain('Nothing matches.');
  });

  it('moves with the arrows (wrapping) and keeps the active option announced', () => {
    const { input, items, active } = setup();
    ctx.store.patch('ui', { paletteOpen: true });
    const all = items();
    expect(active()).toBe(all[0]);
    expect(input.getAttribute('aria-activedescendant')).toBe(all[0]?.id);
    ctx.keys.handle(key('ArrowDown'));
    ctx.keys.handle(key('ArrowDown'));
    expect(active()).toBe(all[2]);
    expect(all[2]?.getAttribute('aria-selected')).toBe('true');
    expect(all[0]?.getAttribute('aria-selected')).toBe('false');
    ctx.keys.handle(key('ArrowUp'));
    expect(active()).toBe(all[1]);
    ctx.keys.handle(key('ArrowUp'));
    ctx.keys.handle(key('ArrowUp'));
    expect(active()).toBe(all[all.length - 1]);
    ctx.keys.handle(key('ArrowDown'));
    expect(active()).toBe(all[0]);
    ctx.keys.handle(key('PageDown'));
    expect(active()).toBe(all[5]);
    ctx.keys.handle(key('PageUp'));
    expect(active()).toBe(all[0]);
  });

  it('Enter runs the highlighted entry, closes, and remembers it as recent', async () => {
    const { type } = setup();
    ctx.store.patch('ui', { paletteOpen: true });
    type('task_00000000000000000000ui0001');
    ctx.keys.handle(key('Enter'));
    await flush();
    expect(ctx.store.select('ui').paletteOpen).toBe(false);
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inspector', id: 'task_00000000000000000000ui0001' });
    expect(recentIds(ctx)[0]).toBe('task:task_00000000000000000000ui0001');
    // Opened again, the recent entry comes first.
    ctx.store.patch('ui', { paletteOpen: true });
    const first = palette?.el.querySelector('[role="option"]');
    expect(first?.textContent).toContain('Add the subscription page');
    expect(palette?.el.querySelector('.dk-pal-heading')?.textContent).toBe('Recent');
  });

  it('runs commands from the registry, hiding unavailable ones', async () => {
    const { type, items } = setup();
    ctx.store.patch('ui', { paletteOpen: true });
    type('resume');
    expect(items().map((i) => i.dataset.entry)).not.toContain('cmd:resume');
    type('pause friday');
    expect(items()[0]?.dataset.entry).toBe('cmd:pause');
    ctx.keys.handle(key('Enter'));
    await flush();
    expect(ctx.transport.to('POST', '/control/pause')).toHaveLength(1);
  });

  it('lists the daily commands in the empty list and the housekeeping ones only when typed (review §4)', () => {
    const { items, type } = setup();
    // The canvas's commands as stage.ts registers them: each declares where the palette offers it.
    ctx.registry.command({ id: 'reset-layout', label: 'Reset moved cards', show: 'typed', run: vi.fn() });
    ctx.registry.command({ id: 'zoom-in', label: 'Zoom in', show: 'never', run: vi.fn() });
    ctx.registry.command({ id: 'zoom-out', label: 'Zoom out', show: 'never', run: vi.fn() });
    ctx.store.patch('ui', { paletteOpen: true });
    const listed = () => items().map((i) => i.dataset.entry);
    for (const id of ['cmd:prune-worktrees', 'cmd:reindex-graph', 'cmd:stop-friday', 'cmd:reset-layout'])
      expect(listed()).not.toContain(id);
    for (const id of [
      'cmd:pause',
      'cmd:new-goal',
      'cmd:agents',
      'cmd:memory',
      'cmd:graph',
      'cmd:settings',
      'cmd:inbox',
    ])
      expect(listed()).toContain(id);
    type('prune');
    expect(listed()).toContain('cmd:prune-worktrees');
    type('reindex');
    expect(listed()).toContain('cmd:reindex-graph');
    type('stop friday');
    expect(listed()).toContain('cmd:stop-friday');
    type('reset moved');
    expect(listed()).toContain('cmd:reset-layout');
    // Zooming is the toolbar's, the wheel's and the keys' job: the palette never offers it.
    type('zoom');
    expect(listed()).not.toContain('cmd:zoom-in');
    expect(listed()).not.toContain('cmd:zoom-out');
  });

  it('names the drawers as the drawers do, and mutes from the keyboard now that the dock has no Mute', async () => {
    const { items, type } = setup();
    ctx.store.patch('ui', { paletteOpen: true });
    const label = (id: string) =>
      items()
        .find((i) => i.dataset.entry === id)
        ?.querySelector('.dk-pal-label')?.textContent;
    expect(label('cmd:memory')).toBe('Project memory');
    expect(label('cmd:inbox')).toBe('Messages');
    type('mute');
    expect(items()[0]?.dataset.entry).toBe('cmd:mute');
    ctx.keys.handle(key('Enter'));
    await flush();
    expect(ctx.store.select('prefs').muted).toBe(true);
    ctx.store.patch('ui', { paletteOpen: true });
    type('unmute');
    expect(items()[0]?.dataset.entry).toBe('cmd:unmute');
    ctx.keys.handle(key('Enter'));
    await flush();
    expect(ctx.store.select('prefs').muted).toBe(false);
  });

  it('runs an entry on click and highlights on pointer move', async () => {
    const { items, active } = setup();
    ctx.store.patch('ui', { paletteOpen: true });
    const agent = items().find((i) => i.dataset.entry === 'agent:codex-1') as HTMLElement;
    agent.dispatchEvent(new Event('pointermove'));
    expect(active()).toBe(agent);
    agent.click();
    await flush();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'terminal', id: 'codex-1' });
  });

  it('closes on a click on the backdrop, not on the panel', () => {
    setup();
    ctx.store.patch('ui', { paletteOpen: true });
    palette?.el.querySelector('.dk-pal')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(ctx.store.select('ui').paletteOpen).toBe(true);
    palette?.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(ctx.store.select('ui').paletteOpen).toBe(false);
  });

  it('takes the keys while open (exclusive) and gives them back when closed', () => {
    setup();
    const below = vi.fn();
    ctx.keys.push({ name: 'canvas', bindings: [{ key: 'f', run: below }] });
    // The canvas scope is newer than the palette's shortcut scope, so it acts while closed.
    ctx.keys.handle(key('f'));
    expect(below).toHaveBeenCalledTimes(1);
    ctx.store.patch('ui', { paletteOpen: true });
    ctx.keys.handle(key('f'));
    expect(below).toHaveBeenCalledTimes(1);
    // Tab keeps focus in the search field while the overlay is open.
    const tab = key('Tab');
    expect(ctx.keys.handle(tab)).toBe(true);
    expect(tab.defaultPrevented).toBe(true);
    expect(ctx.keys.handle(key('Tab', { shiftKey: true }))).toBe(true);
    expect(document.activeElement).toBe(palette?.el.querySelector('input'));
    ctx.keys.handle(key('Escape'));
    ctx.keys.handle(key('f'));
    expect(below).toHaveBeenCalledTimes(2);
  });

  it('shows a toast when an entry fails', async () => {
    const { type } = setup();
    ctx.registry.command({
      id: 'boom',
      label: 'Boom now',
      run: () => {
        throw new Error('it broke');
      },
    });
    ctx.store.patch('ui', { paletteOpen: true });
    type('boom now');
    ctx.keys.handle(key('Enter'));
    await flush();
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'error', text: 'Boom now', detail: 'it broke' });
  });

  it('keeps the highlighted entry when the board is read again', () => {
    const { active } = setup();
    ctx.store.patch('ui', { paletteOpen: true });
    ctx.keys.handle(key('ArrowDown'));
    ctx.keys.handle(key('ArrowDown'));
    const id = active()?.dataset.entry;
    ctx.board(makeScenario());
    expect(active()?.dataset.entry).toBe(id);
  });

  it('renders hostile entries as text, with visible marks on names', () => {
    const long = 'L'.repeat(5000);
    const board = makeSnapshot({
      tasks: [makeTask({ summary: `${HOSTILE}‮​ ${long}` })],
      agents: [makeAgent({ agent_key: `k${HOSTILE}‮​` })],
    });
    const { type } = setup(board);
    ctx.store.patch('activity', { files: { t1: [{ path: `src/${HOSTILE}‮​${long}.ts`, at: 1 }] } });
    ctx.store.patch('ui', { paletteOpen: true });
    const el = palette?.el as HTMLElement;
    expect(el.querySelector('img')).toBeNull();
    const text = el.textContent ?? '';
    expect(text).toContain(HOSTILE);
    expect(text).toContain(`k${HOSTILE}⟨U+202E⟩⟨U+200B⟩`);
    expect(text).toContain('⟨U+202E⟩⟨U+200B⟩');
    expect(text).not.toContain('‮');
    // The summary label is shortened; the long line never reaches the label in full.
    const taskLabel = el.querySelector('[data-entry^="task:"] .dk-pal-label')?.textContent ?? '';
    expect(Array.from(taskLabel).length).toBeLessThanOrEqual(120);
    type('img src');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.dk-pal-hit')).not.toBeNull();
  });

  it('removes its scopes, listeners and element on destroy', () => {
    setup();
    ctx.store.patch('ui', { paletteOpen: true });
    palette?.destroy();
    const el = palette?.el;
    palette = null;
    expect(el?.isConnected).toBe(false);
    expect(ctx.keys.handle(key('k', { ctrlKey: true }))).toBe(false);
    expect(ctx.keys.handle(key('Escape'))).toBe(false);
  });
});
