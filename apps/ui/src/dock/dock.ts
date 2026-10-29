/**
 * The dock at the bottom centre of the Studio (handoff Part 06 §6, plan §7.6): search, New goal,
 * Agents, Pause/Resume, Mute, Settings and Halt. Semi-transparent until hovered or focused. Fit
 * and Zoom are the canvas's own toolbar, beside the minimap (handoff Part 03 §3).
 * `registerDock` registers the halt dialog.
 */
import { type AppContext, type Component, openDrawer, openModal } from '../shell/context.js';
import { button, h, replace, setText } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { isConnected, isPaused, openHalt, pauseFriday, resumeFriday, toggleMute } from './actions.js';
import { haltDialog } from './halt-dialog.js';

export function mountDock(ctx: AppContext, container: HTMLElement): Component {
  let busy = false;

  const search = button(
    [icon('search', 15), h('span', { class: 'dk-label' }, 'Search'), h('span', { class: 'kbd dk-kbd' }, 'Ctrl K')],
    () => ctx.store.patch('ui', { paletteOpen: true }),
    { class: 'btn btn-ghost dk-btn dk-search', title: 'Search tasks, goals, agents, files and commands (Ctrl+K)' },
  );
  const newGoal = button(
    [icon('plus', 15), h('span', { class: 'dk-label' }, 'New goal')],
    () => openModal(ctx, { kind: 'new-goal' }),
    { class: 'btn btn-ghost dk-btn dk-new-goal' },
  );
  const agents = button(
    [icon('robot', 15), h('span', { class: 'dk-label' }, 'Agents')],
    () => openDrawer(ctx, { kind: 'agents' }),
    { class: 'btn btn-ghost dk-btn dk-agents' },
  );
  const pauseLabel = h('span', { class: 'dk-label' }, 'Pause');
  const pauseIcon = h('span', { class: 'dk-icon' }, icon('pause', 15));
  const pause = button([pauseIcon, pauseLabel], () => void togglePause(), { class: 'btn btn-ghost dk-btn dk-pause' });
  const mute = button(icon('sound', 15), () => toggleMute(ctx), {
    class: 'btn btn-ghost btn-icon dk-btn dk-mute',
    ariaLabel: 'Mute sounds',
  });
  const settings = button(icon('gear', 15), () => openDrawer(ctx, { kind: 'settings' }), {
    class: 'btn btn-ghost btn-icon dk-btn dk-settings',
    ariaLabel: 'Settings',
    title: 'Settings',
  });
  const halt = button([icon('halt', 15), h('span', { class: 'dk-label' }, 'Halt')], () => openHalt(ctx), {
    class: 'btn btn-danger dk-btn dk-halt-btn',
    title: 'Halt: stop the work in progress and pause Friday',
  });

  const el = h(
    'div',
    { class: 'dk-dock glass-panel', role: 'toolbar', aria: { label: 'Dock', orientation: 'horizontal' } },
    search,
    h('span', { class: 'dk-sep', aria: { hidden: 'true' } }),
    newGoal,
    agents,
    pause,
    mute,
    settings,
    h('span', { class: 'dk-sep', aria: { hidden: 'true' } }),
    halt,
  );

  async function togglePause(): Promise<void> {
    if (busy || !isConnected(ctx)) return;
    busy = true;
    render();
    try {
      if (isPaused(ctx)) await resumeFriday(ctx);
      else await pauseFriday(ctx);
    } finally {
      busy = false;
      render();
    }
  }

  function render(): void {
    const connected = isConnected(ctx);
    const paused = isPaused(ctx);
    setText(pauseLabel, paused ? 'Resume' : 'Pause');
    replace(pauseIcon, icon(paused ? 'play' : 'pause', 15));
    pause.disabled = busy || !connected;
    pause.title = paused ? 'Resume Friday: agents continue' : 'Pause Friday: nothing new starts, changes are refused';
    pause.classList.toggle('dk-paused', paused);
    pause.setAttribute('aria-busy', String(busy));
    newGoal.disabled = !connected;
    halt.disabled = !connected;
    el.classList.toggle('dk-dock-paused', paused);

    const muted = ctx.store.select('prefs').muted;
    replace(mute, icon(muted ? 'mute' : 'sound', 15));
    mute.setAttribute('aria-pressed', String(muted));
    mute.setAttribute('aria-label', muted ? 'Unmute sounds' : 'Mute sounds');
    mute.title = muted ? 'Sounds are off: turn them on' : 'Turn sounds off';
  }

  /** Arrow keys move between the dock's buttons (toolbar pattern); Tab still reaches each one. */
  function onKey(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const items = [...el.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.hidden && !b.disabled);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = at;
    if (event.key === 'ArrowRight') next = at < 0 ? 0 : (at + 1) % items.length;
    else if (event.key === 'ArrowLeft') next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else next = items.length - 1;
    event.preventDefault();
    items[next]?.focus();
  }

  el.addEventListener('keydown', onKey);

  const unsubscribe = [ctx.store.subscribe('board', () => render()), ctx.store.subscribe('prefs', () => render())];

  render();
  container.appendChild(el);

  return {
    el,
    destroy() {
      for (const u of unsubscribe) u();
      el.removeEventListener('keydown', onKey);
      el.remove();
    },
  };
}

/** Registers the dock's modal: the halt dialog (plan §7.6). */
export function registerDock(ctx: AppContext): void {
  ctx.registry.modal('halt', (c, _request, close) => haltDialog(c, close));
}
