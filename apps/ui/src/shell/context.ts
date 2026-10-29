/**
 * How the areas of the interface plug together. Every area (canvas, drawers, governance, dock,
 * panels, notch, mascot) is built against this contract and nothing else of the others: it gets an
 * `AppContext`, returns `Component`s, and registers its drawers, modals and palette commands in the
 * `Registry`. `main.ts` creates the context and mounts everything.
 */
import type { FridayApi } from '../api/client.js';
import type { FridayStore, ReactionKind } from '../store/state.js';
import type { Keyboard } from '../ui/keys.js';

/** A mounted piece of the interface. `destroy` removes listeners, timers and the element. */
export interface Component {
  readonly el: HTMLElement;
  destroy(): void;
}

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  kind: ToastKind;
  text: string;
  /** A second line: the error code and message, or what happens next. */
  detail?: string;
  /** Default 5 s; 0 keeps it until dismissed. */
  timeoutMs?: number;
  /** A newer toast with the same key replaces the one still shown (pause, then resume). */
  key?: string;
}

export interface ConfirmOptions {
  title: string;
  body: string | string[];
  confirmLabel: string;
  cancelLabel?: string;
  /** A destructive action: the confirm button is red. */
  danger?: boolean;
  /** Seconds before the confirm button arms (the halt dialog uses 3). */
  armAfterS?: number;
}

/** What the page runs in (plan FD-07). */
export interface Platform {
  readonly kind: 'browser' | 'tauri';
  /** Opens a file of the project or a worktree in VS Code (`vscode://file/…` in a browser). */
  openInEditor(path: string, line?: number): void;
  /** Copies text to the clipboard; resolves false when the page may not. */
  copy(text: string): Promise<boolean>;
  /**
   * Asks, from a user gesture, whether Friday may notify (plan FD-25). A browser asks its
   * Notification API; the desktop shell sends its own notifications (plan §8.7), so the browser's
   * permission says nothing there. Never rejects.
   */
  requestNotifications(): Promise<NotificationAnswer>;
  /** What only the desktop shell can do (plan §8.6); absent in a browser tab. */
  readonly desktop?: DesktopCommands;
}

/** A notification permission, or `unsupported` when there is no way to notify. */
export type NotificationAnswer = 'granted' | 'denied' | 'default' | 'unsupported';

/** A global shortcut of the desktop shell, as it registered it. */
export interface DesktopShortcut {
  id: string;
  accel: string;
  /** `registered`, or why not (`taken`, `skipped`, …). */
  state: string;
  note?: string;
}

export interface DesktopCommands {
  shortcuts(): Promise<DesktopShortcut[]>;
  /** Registers `accel` for the shortcut; answers the new list. */
  setShortcut(id: string, accel: string): Promise<DesktopShortcut[]>;
  /** Stops Friday and starts it again (the shell asks natively first); false when the human cancelled. */
  restart(): Promise<boolean>;
  /**
   * Asks for the provider's key in Windows' own password prompt and stores it (FD-26): only the
   * provider's name passes through the page. True once stored, false when the human cancelled.
   */
  storeKey(name: string): Promise<boolean>;
  /** Lets this clone spend at most `budget` dollars a day, after a native confirmation; false when cancelled. */
  allowSpending(budget: number): Promise<boolean>;
  /** Whether the desktop app starts when the user signs in to Windows (plan §8.3). */
  autostart(): Promise<boolean>;
  /** Turns starting at sign-in on or off; answers whether it is on now. */
  setAutostart(enabled: boolean): Promise<boolean>;
  /**
   * Hands a test notification to Windows now, whatever the Notch shows (plan §8.7). True when it
   * was handed over, which is not that it appeared: Windows may hold it back without an error
   * (Do Not Disturb, Focus, the app's own setting, an unpackaged build). False when the shell could
   * not prepare it, so Windows was never asked.
   */
  testNotification(): Promise<boolean>;
}

/** The daemon routes a page needs to decide things, and the shell's helpers. */
export interface AppContext {
  readonly store: FridayStore;
  readonly api: FridayApi;
  readonly keys: Keyboard;
  readonly platform: Platform;
  readonly registry: Registry;
  /** Shows a short message; never blocks. */
  toast(t: Toast): void;
  /** Shows the shell's confirm dialog; resolves true when confirmed. */
  confirm(o: ConfirmOptions): Promise<boolean>;
  /**
   * Runs a daemon call for a user action: shows a toast on failure (the error code and message),
   * on success when `success` is given, and resolves to the result or `undefined` on failure.
   */
  act<T>(label: string, call: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | undefined>;
  /** A reaction the interface started itself (an approval decided here): mascot and sound play it. */
  react(kind: ReactionKind, label?: string): void;
  /** Asks the sync engine to read the snapshot again now (after a command whose events will follow). */
  refresh(): void;
  /** The clock (fake in tests). */
  now(): number;
}

export type DrawerKind = 'inspector' | 'diff' | 'graph' | 'memory' | 'terminal' | 'agents' | 'inbox' | 'settings';

/** What a drawer is opened for (the store's `ui.drawer`). */
export interface DrawerRequest {
  kind: DrawerKind;
  id?: string;
  tab?: string;
  path?: string;
  /**
   * Set when a dialog opened this drawer: the dialog closed first, because a drawer under a
   * dialog takes no input, and this is the way back to it.
   */
  back?: DrawerBack;
}

/** The dialog a drawer was opened from: the drawer's Back button opens it again. */
export interface DrawerBack {
  modal: ModalRequest;
  /** The button's words ("Back to verification"). */
  label: string;
}

export type ModalKind =
  | 'approval'
  | 'question'
  | 'new-goal'
  | 'halt'
  | 'plan-editor'
  | 'verify'
  | 'recover'
  | 'land'
  | 'claude-setup'
  | 'start-agent'
  | 'plan-review';

/** What a modal is opened for (the store's `ui.modal`). */
export interface ModalRequest {
  kind: ModalKind;
  /** An approval, escalation, task or goal id, by kind. */
  id?: string;
  /** Plan editor: a first plan or a revision. */
  mode?: 'first' | 'revision';
}

export type DrawerFactory = (ctx: AppContext, request: DrawerRequest) => Component & { title: string };
export type ModalFactory = (
  ctx: AppContext,
  request: ModalRequest,
  close: () => void,
) => Component & { title: string; size?: 'sm' | 'md' | 'lg' };

/** A palette command (plan §7.6). */
export interface Command {
  id: string;
  label: string;
  /** Words the fuzzy search also matches. */
  keywords?: string[];
  /** Hidden while it would do nothing (`resume` while not paused). */
  available?: (ctx: AppContext) => boolean;
  run: (ctx: AppContext) => void | Promise<void>;
}

/** Where areas declare what they contribute; the shell's hosts read it. */
export class Registry {
  readonly drawers = new Map<DrawerKind, DrawerFactory>();
  readonly modals = new Map<ModalKind, ModalFactory>();
  readonly commands = new Map<string, Command>();

  drawer(kind: DrawerKind, factory: DrawerFactory): void {
    this.drawers.set(kind, factory);
  }

  modal(kind: ModalKind, factory: ModalFactory): void {
    this.modals.set(kind, factory);
  }

  command(c: Command): void {
    this.commands.set(c.id, c);
  }
}

/** Opens a drawer (replacing the open one). */
export function openDrawer(ctx: Pick<AppContext, 'store'>, request: DrawerRequest): void {
  ctx.store.patch('ui', { drawer: request });
}

export function closeDrawer(ctx: Pick<AppContext, 'store'>): void {
  ctx.store.patch('ui', { drawer: null });
}

/** Opens a modal (replacing the open one). */
export function openModal(ctx: Pick<AppContext, 'store'>, request: ModalRequest): void {
  ctx.store.patch('ui', { modal: request });
}

export function closeModal(ctx: Pick<AppContext, 'store'>): void {
  ctx.store.patch('ui', { modal: null });
}
