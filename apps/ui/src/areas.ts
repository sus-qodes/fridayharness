/**
 * Every area of the interface, as the shell mounts them (plan §4.3): what registers drawers, modals
 * and commands, what is mounted where, and what runs alongside. Shared by the browser page and the
 * desktop windows, which differ only in their transport and in where the Notch lives.
 */
import { startSound } from './audio/index.js';
import { mountStudio, registerCanvasCommands } from './canvas/stage.js';
import { mountDock, mountPalette, quickPrompt, registerCommands, registerDock } from './dock/index.js';
import { registerDrawers } from './drawers/index.js';
import { approvalCard, mountDecisionsTray, questionCard, registerGovernance, waitingCard } from './governance/index.js';
import { createFridayMascot } from './mascot/index.js';
import { mountNotch, type NotchOptions, type NotchSlots } from './notch/index.js';
import { startNotifier } from './notify/notifier.js';
import { gettingStarted, registerPanels } from './panels/index.js';
import type { AreaSet } from './shell/app.js';

/** What the Notch shows, built by the areas that own each card (the Notch imports none of them). */
export const notchSlots: NotchSlots = {
  approval: (ctx, a, o) => approvalCard(ctx, a, { compact: o.compact }),
  question: (ctx, e, o) => questionCard(ctx, e, { compact: o.compact, onLater: o.onLater }),
  waiting: (ctx, t, o) => waitingCard(ctx, t, { compact: o.compact }),
  quickPrompt: (ctx, o) => quickPrompt(ctx, { onDone: o.onDone }),
  mascot: (ctx, o) => createFridayMascot(ctx, { size: o.size, interactive: true }),
};

/** Drawers, modals and palette commands, in the order they are registered. */
export const registrations: AreaSet['register'] = [
  registerCommands,
  registerDock,
  registerCanvasCommands,
  registerDrawers,
  registerGovernance,
  registerPanels,
];

/**
 * The Studio's areas. `notch` is the in-page island of a browser tab, given the shell's hook that
 * shows the rail, so its chip and the header's count open the same place; the desktop Studio window
 * leaves it out (its Notch is its own window, which alone plays sounds and raises notifications).
 */
export function studioAreas(opts: { notch?: Omit<NotchOptions, 'mode'> | false; sounds?: boolean } = {}): AreaSet {
  return {
    register: registrations,
    studio: mountStudio,
    dock: mountDock,
    palette: mountPalette,
    tray: mountDecisionsTray,
    ...(opts.notch === false
      ? {}
      : {
          notch: (ctx, el, hooks) =>
            mountNotch(ctx, el, notchSlots, {
              mode: 'in-page',
              onShowWaiting: hooks.onShowWaiting,
              ...(opts.notch ?? {}),
            }),
        }),
    gettingStarted,
    start: opts.sounds === false ? [] : [startSound, startNotifier],
  };
}
