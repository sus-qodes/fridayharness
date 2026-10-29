/**
 * The dock at the bottom centre of the Studio (handoff Part 06 §6, plan §7.6, the product review
 * of 2026-10-17 §4): New goal, Agents, Pause/Resume, and Halt behind a separator. Semi-transparent
 * until hovered or focused. Search and the gear are the header's (the dock showed them a second
 * time on the same screen); Mute lives in the palette, Settings → Sound, the desktop Notch's footer
 * and the tray. Fit and Zoom are the canvas's own toolbar, beside the minimap (handoff Part 03 §3).
 * `registerDock` registers the halt dialog.
 */
import { type AppContext, type Component, openDrawer, openModal } from '../shell/context.js';
import { button, h, replace, setText } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { isConnected, isPaused, openHalt, pauseFriday, resumeFriday } from './actions.js';
import { haltDialog } from './halt-dialog.js';

/** What the Pause button says it does; Halt is the other switch, named so the two are not confused. */
export const PAUSE_TITLE =
  'Pause Friday: nothing new starts and running agents stop at their next step; Halt stops them now';
export const RESUME_TITLE = 'Resume Friday: agents continue';

export function mountDock(ctx: AppContext, container: HTMLElement): Component {
  let busy = false;

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
  const halt = button([icon('halt', 15), h('span', { class: 'dk-label' }, 'Halt')], () => openHalt(ctx), {
    class: 'btn btn-danger dk-btn dk-halt-btn',
    title: 'Halt: stop the work in progress now and pause Friday',
  });

  const el = h(
    'div',
    { class: 'dk-dock glass-panel', role: 'toolbar', aria: { label: 'Dock', orientation: 'horizontal' } },
    newGoal,
    agents,
    pause,
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
    pause.title = paused ? RESUME_TITLE : PAUSE_TITLE;
    pause.classList.toggle('dk-paused', paused);
    pause.setAttribute('aria-busy', String(busy));
    newGoal.disabled = !connected;
    halt.disabled = !connected;
    el.classList.toggle('dk-dock-paused', paused);
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

  // The board decides Pause or Resume and whether the daemon actions are live.
  const unsubscribe = ctx.store.subscribe('board', () => render());

  render();
  container.appendChild(el);

  return {
    el,
    destroy() {
      unsubscribe();
      el.removeEventListener('keydown', onKey);
      el.remove();
    },
  };
}

/** Registers the dock's modal: the halt dialog (plan §7.6). */
export function registerDock(ctx: AppContext): void {
  ctx.registry.modal('halt', (c, _request, close) => haltDialog(c, close));
}
