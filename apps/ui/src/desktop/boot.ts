/**
 * The desktop windows' entry (plan §8): the Studio window and the Notch window of the Tauri shell.
 * Both talk to Friday only through the shell's Rust core (`TauriTransport`): no daemon credential
 * lives in either page (FD-06). The Studio draws no Notch and plays no sound; the Notch window does
 * both, raises notifications, keeps the tray's line, and hands what needs a larger view (an
 * approval's full view, a drawer) to the Studio.
 *
 * `@tauri-apps/api` is imported only here and in the transport, dynamically, so a browser tab never
 * loads it (FD-02).
 */
import type { UiSnapshot } from '@friday/protocol';
import { FridayApi } from '../api/client.js';
import { notchSlots, studioAreas } from '../areas.js';
import { initAudio, startSound } from '../audio/index.js';
import { requestReach, takeRequestedReach } from '../governance/decisions.js';
import { setCursor } from '../mascot/index.js';
import { runningCount, statusSentence, waitingCount } from '../notch/derive.js';
import { mountNotch, type NotchHandle } from '../notch/index.js';
import { realTimers } from '../notch/island-fsm.js';
import type { NotchStudioTarget } from '../notch/island-host.js';
import { type NotificationCtor, type NotificationLike, startNotifierWith } from '../notify/notifier.js';
import { desktopPlatform } from '../platform/desktop-platform.js';
import { type TauriCore, TauriTransport } from '../platform/tauri-transport.js';
import { createAppContext, createShellServices, mountShell } from '../shell/app.js';
import { type AppContext, type DrawerKind, type ModalKind, openDrawer, openModal } from '../shell/context.js';
import { productMark } from '../shell/mark.js';
import { loadPrefs, startPrefsSync, watchPrefs } from '../store/prefs.js';
import { createStore, type FridayStore } from '../store/state.js';
import { Dispatcher } from '../sync/dispatcher.js';
import { SyncEngine } from '../sync/sync-engine.js';
import { button, h, replace } from '../ui/dom.js';
import { Keyboard } from '../ui/keys.js';

/** What the shell's Rust core answers about the project and the daemon (apps/desktop README). */
export interface ProjectInfo {
  project_id: string;
  name: string;
  root: string;
  port: number;
  url: string;
  ui_api: number;
}

export type DaemonState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed' | 'no_project';

export interface DaemonStatus {
  state: DaemonState;
  message?: string;
}

/** The shell, as the page sees it; injectable for tests. */
export interface DesktopEnv {
  core: TauriCore;
  /** Listens to an event the shell emits to this window; resolves to the function that stops it. */
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
  /** How often the page asks for the daemon's state while it waits (ms). */
  pollMs?: number;
}

/** Where a deep link from the Notch or the tray points (`show_studio`'s target, lib.rs `DeepLink`). */
export interface StudioTarget {
  focus_task?: string;
  approval_id?: string;
  panel?: string;
  /** The id the panel opens on (a task for Recover or a diff, a goal for a plan review or a revision, a message's delivery). */
  id?: string;
  /** The drawer's tab (Settings' `routing`, `about` or `policy`; Project memory's `review`). */
  tab?: string;
  /** The file a diff drawer selects. */
  path?: string;
  /** The reach the human chose on the Notch's card. */
  reach?: 'once' | 'run' | 'task';
}

/**
 * The shell's deep link for where the Notch window sends the human: a panel opens on its own id (a
 * goal, a delivery) or, failing that, on the task's.
 */
export function studioLink(t: NotchStudioTarget): StudioTarget {
  if (t.panel) {
    const id = t.id ?? t.task_id;
    return {
      panel: t.panel,
      ...(id ? { id } : {}),
      ...(t.tab ? { tab: t.tab } : {}),
      ...(t.path ? { path: t.path } : {}),
    };
  }
  // The shell's target names a task `focus_task` (lib.rs DeepLink).
  return {
    ...(t.task_id ? { focus_task: t.task_id } : {}),
    ...(t.approval_id ? { approval_id: t.approval_id } : {}),
  };
}

/** A drawer's tab as the drawers name them. */
const TAB = /^[a-z][a-z0-9-]{0,31}$/;
/** Characters a file path from another window never holds. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const PATH_MAX = 1024;

function linkPath(p: unknown): string | null {
  return typeof p === 'string' && p.length > 0 && p.length <= PATH_MAX && !CONTROL.test(p) ? p : null;
}

/**
 * The link as the shell takes it. The shell refuses a whole link for one field of an unexpected
 * form (lib.rs `DeepLink::valid`, the same rules as here), and the Studio would then not open at
 * all; a tab or a file path of another form (an agent's file name with a line break, say) is left
 * out instead, and the drawer opens without it.
 */
export function sendableLink(t: StudioTarget): StudioTarget {
  const { tab, path, ...rest } = t;
  const file = linkPath(path);
  return { ...rest, ...(typeof tab === 'string' && TAB.test(tab) ? { tab } : {}), ...(file ? { path: file } : {}) };
}

/** Shows the Studio at `target` (`show_studio`). */
function showStudio(env: DesktopEnv, target: StudioTarget): void {
  void env.core.invoke('show_studio', { target: sendableLink(target) }).catch(() => undefined);
}

async function loadEnv(): Promise<DesktopEnv> {
  const [core, events] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
  return {
    core: core as unknown as TauriCore,
    listen: async (event, handler) => events.listen(event, (e) => handler(e.payload as never)),
  };
}

// ---------------------------------------------------------------------------------------------
// Waiting for Friday

const STATE_TEXT: Record<DaemonState, { title: string; message: string }> = {
  starting: { title: 'Friday is starting', message: 'The Studio opens as soon as Friday is ready.' },
  ready: { title: 'Friday is ready', message: '' },
  stopping: { title: 'Friday is stopping', message: 'Work in worktrees is kept.' },
  stopped: { title: 'Friday is not running', message: 'Start it for this project; work in worktrees is kept.' },
  failed: { title: 'Friday could not start', message: 'What the shell saw is below.' },
  no_project: {
    title: 'No project is open',
    message: 'Start the desktop app from a project’s shortcut, or with --project and the project’s folder.',
  },
};

/** The screen shown while there is no board: the daemon's state, and a way on when there is one. */
export function statusScreen(status: DaemonStatus, onStart: (() => void) | null): HTMLElement {
  const text = STATE_TEXT[status.state] ?? STATE_TEXT.failed;
  const canStart = onStart !== null && (status.state === 'stopped' || status.state === 'failed');
  return h(
    'main',
    { class: 'sh-login' },
    h(
      'section',
      { class: ['sh-login-card', 'glass-panel'], role: 'status', dataset: { state: status.state } },
      h(
        'div',
        { class: 'sh-login-brand' },
        productMark(40, 'sh-login-mark'),
        h('span', { class: 'sh-login-name' }, 'Friday'),
      ),
      h('h1', { class: 'sh-login-title' }, text.title),
      text.message ? h('p', { class: 'sh-login-message' }, text.message) : null,
      status.message ? h('p', { class: 'sh-login-detail mono' }, status.message.slice(0, 400)) : null,
      canStart ? button('Start Friday', () => onStart?.(), { class: 'btn btn-primary sh-login-action' }) : null,
    ),
  );
}

/**
 * Resolves when the daemon is ready, showing its state in `root` meanwhile. A stopped Friday is
 * started only when the human asks (the button), never by itself.
 */
export async function untilReady(env: DesktopEnv, root: HTMLElement | null): Promise<ProjectInfo> {
  const pollMs = env.pollMs ?? 500;
  let shown: string | null = null;
  for (;;) {
    let status: DaemonStatus;
    try {
      status = await env.core.invoke<DaemonStatus>('daemon_status');
    } catch (e) {
      status = { state: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
    if (status.state === 'ready') {
      try {
        return await env.core.invoke<ProjectInfo>('project_info');
      } catch {
        // Ready, yet its discovery file is not readable yet: ask again.
      }
    }
    const key = `${status.state}:${status.message ?? ''}`;
    if (root && key !== shown) {
      shown = key;
      replace(
        root,
        statusScreen(status, () => {
          void env.core.invoke('restart_daemon').catch(() => undefined);
        }),
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ---------------------------------------------------------------------------------------------
// The context both windows share

interface Running {
  ctx: AppContext;
  store: FridayStore;
  engine: SyncEngine;
  dispatcher: Dispatcher;
  services: ReturnType<typeof createShellServices>;
  keys: Keyboard;
  stop(): void;
}

function makeContext(env: DesktopEnv, info: ProjectInfo, root: HTMLElement): Running {
  const api = new FridayApi(new TauriTransport(async () => env.core), info.project_id);
  const store = createStore(loadPrefs(safeStorage()));
  const stopPrefs = watchPrefs(store, { storage: safeStorage(), root: document.documentElement, win: window });
  // The project's copy too, as in a browser: one copy for the windows, the browser and every start.
  const stopPrefsSync = startPrefsSync(api, store, { win: window });
  const dispatcher = new Dispatcher(store);
  const engine = new SyncEngine(api, store, dispatcher);
  const keys = new Keyboard(window);
  keys.attach();
  const services = createShellServices(keys, document);
  const ctx = createAppContext({
    store,
    api,
    keys,
    platform: desktopPlatform(env.core),
    toast: (t) => services.toasts.show(t),
    confirm: (o) => services.confirms.confirm(o),
    react: (kind, label) => dispatcher.react(kind, Date.now(), label),
    refresh: () => {
      void engine.refresh();
    },
  });
  root.replaceChildren();
  return {
    ctx,
    store,
    engine,
    dispatcher,
    services,
    keys,
    stop() {
      engine.stop();
      services.confirms.destroy();
      services.toasts.destroy();
      keys.detach();
      stopPrefsSync();
      stopPrefs();
    },
  };
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Follows the shell's word about the daemon: a restart on another port is read again at once. */
async function followDaemon(env: DesktopEnv, run: Running): Promise<() => void> {
  return env.listen<DaemonStatus>('daemon-status', (s) => {
    if (s.state === 'ready') void run.engine.retry();
  });
}

// ---------------------------------------------------------------------------------------------
// The Studio window

/** Applies a deep link from the Notch or the tray (`studio-deeplink`). */
export function applyDeepLink(ctx: AppContext, t: StudioTarget | null | undefined): void {
  if (!t) return;
  if (t.focus_task) ctx.store.patch('ui', { selectedTaskId: t.focus_task });
  // Only kinds this window registered are opened, with a tab and a path of the expected form: the
  // link came over IPC.
  const panel = t.panel;
  const id = t.id ? { id: t.id } : {};
  const path = linkPath(t.path);
  const where = {
    ...id,
    ...(typeof t.tab === 'string' && TAB.test(t.tab) ? { tab: t.tab } : {}),
    ...(path ? { path } : {}),
  };
  if (t.approval_id) {
    if (t.reach) requestReach(t.approval_id, t.reach);
    openModal(ctx, { kind: 'approval', id: t.approval_id });
  } else if (panel && ctx.registry.drawers.has(panel as DrawerKind))
    openDrawer(ctx, { kind: panel as DrawerKind, ...where });
  else if (panel && ctx.registry.modals.has(panel as ModalKind)) openModal(ctx, { kind: panel as ModalKind, ...id });
  else if (t.focus_task) openDrawer(ctx, { kind: 'inspector', id: t.focus_task });
}

export async function bootDesktopStudio(root: HTMLElement, injected?: DesktopEnv): Promise<void> {
  const env = injected ?? (await loadEnv());
  const info = await untilReady(env, root);
  const run = makeContext(env, info, root);
  mountShell(run.ctx, run.services, root, studioAreas({ notch: false, sounds: false }), {
    onRetry: () => {
      void run.engine.retry();
    },
    reload: () => location.reload(),
  });
  await followDaemon(env, run);
  await env.listen<StudioTarget>('studio-deeplink', (t) => applyDeepLink(run.ctx, t));
  await env.listen('open-halt', () => openModal(run.ctx, { kind: 'halt' }));
  await env.listen<{ muted: boolean }>('toggle-mute', (p) => run.store.patch('prefs', { muted: !!p?.muted }));
  void run.engine.start();
}

// ---------------------------------------------------------------------------------------------
// The Notch window

/**
 * The tray's state and line from the board (`set_tray_state`). The line is the status sentence the
 * Studio's Running count carries in its tooltip (review §4, M9k.1): the shell shows it as the
 * tray's tooltip and its first menu item, so a hover says what waits, not only how much.
 */
export function trayState(
  board: UiSnapshot | null,
  connection: string,
  now: number,
): { state: 'idle' | 'working' | 'waiting' | 'error'; countsLine: string; paused: boolean } {
  if (!board || connection === 'stopped' || connection === 'signed-out') {
    return { state: 'error', countsLine: 'Friday is not reachable', paused: false };
  }
  const waiting = waitingCount(board, now);
  const running = runningCount(board);
  return {
    state: waiting > 0 ? 'waiting' : running > 0 ? 'working' : 'idle',
    countsLine: statusSentence(board, now),
    paused: !!board.control?.paused,
  };
}

/** Notifications through the shell, which shows them only while the Notch is parked or the screen locked. */
function shellNotifications(env: DesktopEnv): NotificationCtor {
  class ShellNotification implements NotificationLike {
    static readonly permission: NotificationPermission = 'granted';
    onclick: ((this: never, ev: Event) => unknown) | null = null;
    constructor(title: string, options?: NotificationOptions) {
      void env.core.invoke('notify', { title, body: options?.body ?? '' }).catch(() => undefined);
    }
    close(): void {
      // The shell's notifications close themselves.
    }
  }
  return ShellNotification;
}

export async function bootDesktopNotch(root: HTMLElement, injected?: DesktopEnv): Promise<void> {
  const env = injected ?? (await loadEnv());
  const info = await untilReady(env, null);
  const run = makeContext(env, info, root);
  const { ctx, store } = run;

  // The Notch window plays the sounds; its webview may start audio at load (plan §7.10).
  initAudio({ atLoad: true });
  const stopSound = startSound(ctx);
  const stopNotifier = startNotifierWith(
    ctx,
    { title: info.name },
    {
      Notification: shellNotifications(env),
      // The shell decides whether a notification shows (parked or locked); the page asks always.
      document: {
        get title() {
          return document.title;
        },
        set title(v: string) {
          document.title = v;
        },
        visibilityState: 'hidden',
        addEventListener: document.addEventListener.bind(document),
        removeEventListener: document.removeEventListener.bind(document),
      },
      focusWindow: () => {
        void env.core.invoke('show_studio', {}).catch(() => undefined);
      },
      timers: realTimers,
    },
  );

  const handle: NotchHandle = mountNotch(ctx, root, notchSlots, {
    mode: 'window',
    onRect: (r) => {
      void env.core.invoke('notch_rect', { x: r.x, y: r.y, w: r.width, h: r.height }).catch(() => undefined);
    },
    onOpenStudio: (target) => showStudio(env, studioLink(target)),
  });
  root.append(run.services.toasts.el, run.services.confirms.el);

  // The keyboard belongs to the editor until the human works in the card (plan §8.2).
  let hasKeyboard = false;
  const keyboard = (take: boolean) => {
    if (take === hasKeyboard) return;
    hasKeyboard = take;
    void env.core.invoke('notch_keyboard', { take }).catch(() => undefined);
  };
  handle.el.addEventListener('focusin', () => keyboard(true));
  handle.el.addEventListener('focusout', (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (!next || !handle.el.contains(next)) keyboard(false);
  });

  // What needs a larger view than the island opens in the Studio.
  store.subscribe('ui', (next) => {
    const modal = next.modal;
    const drawer = next.drawer;
    if (!modal && !drawer) return;
    let target: StudioTarget = {};
    if (modal?.kind === 'approval' && modal.id) {
      // The reach chosen on the card ("Allow for this task") goes with it to the full view.
      const reach = takeRequestedReach(modal.id);
      target = { approval_id: modal.id, ...(reach ? { reach } : {}) };
    } else if (drawer?.kind === 'inspector' && drawer.id) target = { focus_task: drawer.id };
    else if (modal) target = { panel: modal.kind, ...(modal.id ? { id: modal.id } : {}) };
    else if (drawer)
      target = {
        panel: drawer.kind,
        ...(drawer.id ? { id: drawer.id } : {}),
        ...(drawer.tab ? { tab: drawer.tab } : {}),
        ...(drawer.path ? { path: drawer.path } : {}),
      };
    store.patch('ui', { modal: null, drawer: null });
    showStudio(env, target);
  });

  // The tray's icon and line follow the board.
  let lastTray = '';
  const tray = () => {
    const t = trayState(store.select('board'), store.select('system').connection, Date.now());
    const muted = store.select('prefs').muted;
    const key = JSON.stringify([t, muted]);
    if (key === lastTray) return;
    lastTray = key;
    void env.core.invoke('set_tray_state', { ...t, muted }).catch(() => undefined);
  };
  store.subscribe('board', tray);
  store.subscribe('system', tray);
  store.subscribe('prefs', tray);
  // An approval that expires changes no board: the line is read again every 15 s too.
  const trayTimer = setInterval(tray, 15_000);

  await followDaemon(env, run);
  await env.listen<{ x: number; y: number }>('cursor', (p) => setCursor(p?.x ?? null, p?.y));
  await env.listen<{ focus?: boolean }>('notch-open', (p) => handle.open(p?.focus !== false));
  await env.listen<{ muted: boolean }>('toggle-mute', (p) => store.patch('prefs', { muted: !!p?.muted }));
  window.addEventListener('pagehide', () => {
    clearInterval(trayTimer);
    stopNotifier();
    stopSound();
    handle.destroy();
    run.stop();
  });
  void run.engine.start();
}
