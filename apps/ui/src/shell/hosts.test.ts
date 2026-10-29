import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { button, h } from '../ui/dom.js';
import { type Component, closeDrawer, openDrawer, openModal } from './context.js';
import { mountDrawerHost, TERMINAL_MAX, TERMINAL_MIN, terminalHeight } from './drawer-host.js';
import { focusables, LayerStack, RANK } from './layers.js';
import { mountModalHost } from './modal-host.js';

const HOSTILE = '<img src=x onerror=alert(1)>';

function esc(ctx: TestContext): boolean {
  return ctx.keys.handle(new KeyboardEvent('keydown', { key: 'Escape' }));
}

function tab(from: Element, shift = false): void {
  from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true }));
}

function content(title: string, extra: Partial<{ size: 'sm' | 'md' | 'lg' }> = {}) {
  const destroy = vi.fn();
  const first = h('input', { class: 'first' });
  const last = button('Last', () => undefined, { class: 'btn last' });
  const el = h('div', { class: 'content' }, first, last);
  return { el, title, destroy, first, last, ...extra };
}

function setup() {
  const ctx = makeContext();
  const layers = new LayerStack(ctx.keys);
  const drawers = mountDrawerHost(ctx, layers);
  const modals = mountModalHost(ctx, layers);
  document.body.append(drawers.el, modals.el);
  const opener = button('Open', () => undefined, { class: 'btn opener' });
  document.body.append(opener);
  opener.focus();
  return { ctx, layers, drawers, modals, opener };
}

let teardown: Component[] = [];

afterEach(() => {
  for (const c of teardown) c.destroy();
  teardown = [];
  document.body.replaceChildren();
});

describe('modal host', () => {
  it('renders the registered factory in a labelled, sized dialog and closes it', () => {
    const { ctx, modals, opener } = setup();
    teardown.push(modals);
    const made = content(`${HOSTILE}‮ New goal`, { size: 'lg' });
    const factory = vi.fn((_c, _r, _close: () => void) => made);
    ctx.registry.modal('new-goal', factory);
    openModal(ctx, { kind: 'new-goal' });
    const dialog = modals.el.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.classList.contains('sh-modal-lg')).toBe(true);
    const title = modals.el.querySelector('.sh-modal-title') as HTMLElement;
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(title.textContent).toBe(`${HOSTILE} New goal`);
    expect(modals.el.querySelector('img')).toBeNull();
    expect(modals.el.contains(made.el)).toBe(true);
    expect(factory).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(opener);
    const close = modals.el.querySelector<HTMLButtonElement>('.sh-modal-close');
    expect(close?.getAttribute('aria-label')).toBe('Close');
    close?.click();
    expect(ctx.store.select('ui').modal).toBeNull();
    expect(made.destroy).toHaveBeenCalledOnce();
    expect(modals.el.childElementCount).toBe(0);
    expect(document.activeElement).toBe(opener);
  });

  it('lets the content close itself, and ignores a stale close', () => {
    const { ctx, modals } = setup();
    teardown.push(modals);
    let closeFirst: () => void = () => undefined;
    ctx.registry.modal('verify', (_c, _r, close) => {
      closeFirst = close;
      return content('Verify');
    });
    ctx.registry.modal('land', () => content('Land'));
    openModal(ctx, { kind: 'verify', id: 'task_1' });
    openModal(ctx, { kind: 'land', id: 'goal_1' });
    closeFirst();
    expect(ctx.store.select('ui').modal?.kind).toBe('land');
    expect(modals.current()?.kind).toBe('land');
  });

  it('closes an unknown kind at once, and a factory that throws with a toast', () => {
    const { ctx, modals } = setup();
    teardown.push(modals);
    openModal(ctx, { kind: 'recover', id: 'task_1' });
    expect(ctx.store.select('ui').modal).toBeNull();
    ctx.registry.modal('halt', () => {
      throw new Error('broken');
    });
    openModal(ctx, { kind: 'halt' });
    expect(ctx.store.select('ui').modal).toBeNull();
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'error', text: 'This panel could not open', detail: 'broken' });
    expect(modals.el.childElementCount).toBe(0);
  });

  it('keeps Tab inside and pulls stray focus back', () => {
    const { ctx, modals, opener } = setup();
    teardown.push(modals);
    const made = content('Plan');
    ctx.registry.modal('plan-editor', () => made);
    openModal(ctx, { kind: 'plan-editor' });
    const dialog = modals.el.querySelector('[role="dialog"]') as HTMLElement;
    const list = focusables(dialog);
    expect(list[0]?.classList.contains('sh-modal-close')).toBe(true);
    made.last.focus();
    tab(made.last);
    expect(document.activeElement).toBe(list[0]);
    tab(list[0] as HTMLElement, true);
    expect(document.activeElement).toBe(made.last);
    opener.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe('drawer host', () => {
  it('renders a right slide-over with its title and closes with its button', () => {
    const { ctx, drawers, opener } = setup();
    teardown.push(drawers);
    const made = content('Task inspector');
    ctx.registry.drawer('inspector', () => made);
    openDrawer(ctx, { kind: 'inspector', id: 'task_1' });
    const panel = drawers.el.querySelector('.sh-drawer') as HTMLElement;
    expect(panel.classList.contains('sh-drawer-right')).toBe(true);
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.hasAttribute('aria-modal')).toBe(false);
    expect(panel.querySelector('.sh-drawer-title')?.textContent).toBe('Task inspector');
    panel.querySelector<HTMLButtonElement>('.sh-drawer-close')?.click();
    expect(ctx.store.select('ui').drawer).toBeNull();
    expect(made.destroy).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);
  });

  it('opens the terminal at the bottom at the saved height, clamped to 300–600 px', () => {
    const { ctx, drawers } = setup();
    teardown.push(drawers);
    ctx.registry.drawer('terminal', () => content('Live stream'));
    ctx.store.patch('prefs', { terminalHeight: 450 });
    openDrawer(ctx, { kind: 'terminal', id: 'claude-1' });
    const panel = drawers.el.querySelector('.sh-drawer') as HTMLElement;
    expect(panel.classList.contains('sh-drawer-bottom')).toBe(true);
    expect(panel.style.getPropertyValue('--sh-term-h')).toBe('450px');
    ctx.store.patch('prefs', { terminalHeight: 9000 });
    expect(panel.style.getPropertyValue('--sh-term-h')).toBe(`${TERMINAL_MAX}px`);
    expect(terminalHeight(10)).toBe(TERMINAL_MIN);
    expect(terminalHeight('x')).toBe(320);
    expect(terminalHeight(Number.NaN)).toBe(320);
  });

  it('replaces the open drawer and closes an unknown kind', () => {
    const { ctx, drawers } = setup();
    teardown.push(drawers);
    const a = content('Memory');
    ctx.registry.drawer('memory', () => a);
    ctx.registry.drawer('graph', () => content('Code graph'));
    openDrawer(ctx, { kind: 'memory' });
    openDrawer(ctx, { kind: 'graph' });
    expect(a.destroy).toHaveBeenCalledOnce();
    expect(drawers.el.querySelectorAll('.sh-drawer')).toHaveLength(1);
    expect(drawers.current()?.kind).toBe('graph');
    openDrawer(ctx, { kind: 'inbox' });
    expect(ctx.store.select('ui').drawer).toBeNull();
    expect(drawers.el.childElementCount).toBe(0);
  });

  it('keeps Tab inside while focus is in it, without holding the page', () => {
    const { ctx, drawers, opener } = setup();
    teardown.push(drawers);
    const made = content('Settings');
    ctx.registry.drawer('settings', () => made);
    openDrawer(ctx, { kind: 'settings' });
    const panel = drawers.el.querySelector('.sh-drawer') as HTMLElement;
    made.last.focus();
    tab(made.last);
    expect(document.activeElement).toBe(focusables(panel)[0]);
    opener.focus();
    expect(document.activeElement).toBe(opener);
  });
});

describe('Esc closes the topmost layer only', () => {
  it('closes a modal over a drawer, then the drawer, restoring focus each time', () => {
    const { ctx, drawers, modals, layers, opener } = setup();
    teardown.push(drawers, modals);
    const drawer = content('Inspector');
    ctx.registry.drawer('inspector', () => drawer);
    ctx.registry.modal('approval', () => content('Approval'));
    openDrawer(ctx, { kind: 'inspector', id: 't' });
    drawer.first.focus();
    openModal(ctx, { kind: 'approval', id: 'apr_1' });
    expect(layers.size).toBe(2);
    expect(layers.top()?.rank).toBe(RANK.modal);
    expect(esc(ctx)).toBe(true);
    expect(ctx.store.select('ui').modal).toBeNull();
    expect(ctx.store.select('ui').drawer?.kind).toBe('inspector');
    expect(document.activeElement).toBe(drawer.first);
    expect(esc(ctx)).toBe(true);
    expect(ctx.store.select('ui').drawer).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(esc(ctx)).toBe(false);
  });

  it('a drawer opened under a modal never takes Esc from it', () => {
    const { ctx, drawers, modals } = setup();
    teardown.push(drawers, modals);
    ctx.registry.drawer('diff', () => content('Diff'));
    ctx.registry.modal('approval', () => content('Approval'));
    openModal(ctx, { kind: 'approval', id: 'apr_1' });
    openDrawer(ctx, { kind: 'diff', id: 't' });
    esc(ctx);
    expect(ctx.store.select('ui').modal).toBeNull();
    expect(ctx.store.select('ui').drawer?.kind).toBe('diff');
  });

  it('keys bound below a modal do not fire while it is open', () => {
    const { ctx, modals } = setup();
    teardown.push(modals);
    const below = vi.fn();
    ctx.keys.push({ name: 'studio', bindings: [{ key: 'f', run: below }] });
    ctx.registry.modal('halt', () => content('Halt'));
    openModal(ctx, { kind: 'halt' });
    ctx.keys.handle(new KeyboardEvent('keydown', { key: 'f' }));
    expect(below).not.toHaveBeenCalled();
    esc(ctx);
    ctx.keys.handle(new KeyboardEvent('keydown', { key: 'f' }));
    expect(below).toHaveBeenCalledOnce();
  });

  it('destroying the hosts removes their layers and scopes', () => {
    const { ctx, drawers, modals, layers } = setup();
    ctx.registry.drawer('memory', () => content('Memory'));
    ctx.registry.modal('halt', () => content('Halt'));
    openDrawer(ctx, { kind: 'memory' });
    openModal(ctx, { kind: 'halt' });
    drawers.destroy();
    modals.destroy();
    expect(layers.size).toBe(0);
    expect(esc(ctx)).toBe(false);
    closeDrawer(ctx);
  });
});
