/**
 * The page's platform inside the desktop shell (plan §8.6): files open through the shell's own
 * opener, limited to the project and its worktrees, and the shell's shortcuts and restart are
 * offered. The page holds no daemon credential (FD-06).
 */
import type { DesktopShortcut, Platform } from '../shell/context.js';
import type { TauriCore } from './tauri-transport.js';

export function desktopPlatform(core: Pick<TauriCore, 'invoke'>, clipboard?: Pick<Clipboard, 'writeText'>): Platform {
  const board = clipboard ?? (typeof navigator !== 'undefined' ? navigator.clipboard : undefined);
  return {
    kind: 'tauri',
    openInEditor(path, line) {
      void core.invoke('open_in_editor', { path, ...(line ? { line } : {}) }).catch(() => undefined);
    },
    async copy(text) {
      if (!board) return false;
      try {
        await board.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    desktop: {
      shortcuts: () => core.invoke<DesktopShortcut[]>('get_shortcuts'),
      setShortcut: (id, accel) => core.invoke<DesktopShortcut[]>('set_shortcut', { id, accel }),
      restart: () => core.invoke<void>('restart_daemon'),
    },
  };
}
