/**
 * The dock area (plan §7.6): the dock bar, the command palette, the core commands, the Notch's
 * quick prompt and the halt dialog. `main.ts` mounts and registers these.
 */
export { registerCommands } from './commands.js';
export { mountDock, registerDock } from './dock.js';
export { mountPalette } from './omnibar.js';
export { quickPrompt } from './quick-prompt.js';
