/** The Notch (plan §7.8): what `main.ts` and `notch-main.ts` use. */
export type { IslandRect } from './island.js';
export type { GreetingKind, IslandSnapshot, IslandState } from './island-fsm.js';
export { mountNotch, type NotchHandle, type NotchOptions } from './island-host.js';
export type { NotchSlots } from './island-views.js';
