/**
 * The page's platform inside the desktop shell (plan §8.6): files open through the shell's own
 * opener, limited to the project and its worktrees; notifications are the shell's own (§8.7), with
 * a test; the shell's shortcuts, restart, start at sign-in and native planner dialogs (FD-26) are
 * offered. The page holds no daemon credential (FD-06).
 */
import type { DesktopShortcut, Platform } from '../shell/context.js';
import { errorOf, type TauriCore } from './tauri-transport.js';
import { ApiError } from './transport.js';

/** The shell's code for a native dialog the human cancelled (apps/desktop README, Errors). */
export const DIALOG_CANCELLED = 'DESKTOP-1003';

/** The test notification Settings → Desktop app sends. */
export const TEST_TITLE = 'Friday: a test notification';
export const TEST_BODY = 'This is how Friday tells you that an approval, a question or a failure waits for you.';

export function desktopPlatform(core: Pick<TauriCore, 'invoke'>, clipboard?: Pick<Clipboard, 'writeText'>): Platform {
  const board = clipboard ?? (typeof navigator !== 'undefined' ? navigator.clipboard : undefined);
  /** A shell command; its refusal (`{status, body}`) becomes the error a toast can read. */
  async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return await core.invoke<T>(cmd, args);
    } catch (e) {
      throw errorOf(e);
    }
  }
  /** A command that opens a native dialog: true once done, false when the human cancelled it. */
  async function dialog(cmd: string, args?: Record<string, unknown>): Promise<boolean> {
    try {
      await call<unknown>(cmd, args);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === DIALOG_CANCELLED) return false;
      throw e;
    }
  }
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
    // The shell shows its notifications itself (Rust), whatever the webview's own API would answer.
    requestNotifications: async () => 'granted',
    desktop: {
      shortcuts: () => call<DesktopShortcut[]>('get_shortcuts'),
      setShortcut: (id, accel) => call<DesktopShortcut[]>('set_shortcut', { id, accel }),
      // The shell asks natively before it stops a running Friday; a cancel answers false.
      restart: () => dialog('restart_daemon'),
      storeKey: (name) => dialog('store_key', { name }),
      allowSpending: (budget) => dialog('allow_spending', { budget }),
      autostart: async () => (await call<unknown>('get_autostart')) === true,
      setAutostart: async (enabled) => (await call<unknown>('set_autostart', { enabled })) === true,
      // `test`: from either window, now, whatever the Notch shows; the answer is whether the shell
      // handed it to Windows, never whether it appeared.
      testNotification: async () =>
        (await call<unknown>('notify', { title: TEST_TITLE, body: TEST_BODY, test: true })) === true,
    },
  };
}
