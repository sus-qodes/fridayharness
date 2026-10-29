/**
 * The application shell (plan §4.2 boot, §7.1, FD-05, FD-08): it signs the page in, builds the one
 * `AppContext` every area works against, mounts the layout and starts the sync engine.
 *
 * Boot in a browser, in this order:
 * 1. the service-worker guard: a leftover worker is removed and nothing else happens;
 * 2. the session: `#code=` is cleared from the address first, then exchanged; otherwise this tab's
 *    own session from `sessionStorage`; without one, the login screen;
 * 3. the API client over HTTP for the session's project, the store with the saved preferences
 *    (this origin's, then the daemon's copy laid over them), the dispatcher and the sync engine;
 * 4. the context (toasts, confirm, `act`, reactions, refresh, the browser platform, the keyboard,
 *    the registry), every area's `register`, then the layout: header, banners, connection strip,
 *    the Studio, the decisions rail, the dock, the palette, the in-page Notch, drawers, modals,
 *    toasts; then every area's `start` (sound, notifier), then the sync engine.
 *
 * A session that ends (401) clears it from the tab and shows the login screen. `createAppContext`
 * and `mountShell` are also what the desktop entry uses with its own transport.
 */
import { FridayApi } from '../api/client.js';
import { browserPlatform } from '../platform/browser-platform.js';
import { HttpTransport } from '../platform/http-transport.js';
import {
  clearSession,
  exchangeCode,
  readSession,
  type StoredSession,
  takeLoginCode,
  writeSession,
} from '../platform/session.js';
import { guardServiceWorkers } from '../platform/sw-guard.js';
import { AuthError, OfflineError } from '../platform/transport.js';
import { loadPrefs, startPrefsSync, watchPrefs } from '../store/prefs.js';
import { createStore, type FridayStore, type ReactionKind } from '../store/state.js';
import { Dispatcher } from '../sync/dispatcher.js';
import { SyncEngine, UNREACHABLE_MESSAGE } from '../sync/sync-engine.js';
import { h } from '../ui/dom.js';
import { Keyboard } from '../ui/keys.js';
import { errorDetail, makeAct } from './act.js';
import { mountBanners, mountChecklist } from './banners.js';
import { type ConfirmHost, createConfirmHost } from './confirm.js';
import { mountConnectionStrip } from './connection.js';
import {
  type AppContext,
  type Component,
  type ConfirmOptions,
  type Platform,
  Registry,
  type Toast,
} from './context.js';
import { mountDrawerHost } from './drawer-host.js';
import { mountHeader } from './header.js';
import { focusQuietly, LayerStack } from './layers.js';
import { type LoginReason, type LoginScreenOptions, loginScreen } from './login-screen.js';
import { mountModalHost } from './modal-host.js';
import { createToastHost, type ToastHost } from './toast.js';

/** What the areas contribute; `main.ts` (and the desktop entry) fill it in. */
export interface AreaSet {
  /** Each registers its drawers, modals and palette commands. */
  register: ((ctx: AppContext) => void)[];
  /** The Studio canvas: the main area. */
  studio: (ctx: AppContext, container: HTMLElement) => Component;
  /** The dock, at the bottom of the Studio. */
  dock: (ctx: AppContext, container: HTMLElement) => Component;
  /** The command palette (an overlay). */
  palette: (ctx: AppContext, container: HTMLElement) => Component;
  /** The decisions tray: the right rail. */
  tray: (ctx: AppContext, container: HTMLElement) => Component;
  /** The in-page Notch at the top centre (browser only; the desktop's Studio window draws none). */
  notch?: (ctx: AppContext, container: HTMLElement) => Component;
  /** The getting-started checklist, shown under the header until dismissed. */
  gettingStarted?: (ctx: AppContext) => Component;
  /** Background services (sound, notifier); each returns the function that stops it. */
  start?: ((ctx: AppContext) => () => void)[];
}

/** The shell's own hosts, made before the context so its `toast` and `confirm` can use them. */
export interface ShellServices {
  readonly layers: LayerStack;
  readonly toasts: ToastHost;
  readonly confirms: ConfirmHost;
}

export function createShellServices(keys: Keyboard, doc: Document = document): ShellServices {
  const layers = new LayerStack(keys, doc);
  return { layers, toasts: createToastHost(), confirms: createConfirmHost(layers) };
}

export interface AppContextOptions {
  store: FridayStore;
  api: FridayApi;
  keys: Keyboard;
  platform: Platform;
  toast: (t: Toast) => void;
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  /** A reaction the interface started itself (the dispatcher's `react`). */
  react: (kind: ReactionKind, label?: string) => void;
  /** Re-reads the snapshot now (the sync engine's `refresh`). */
  refresh: () => void;
  registry?: Registry;
  now?: () => number;
}

/** The context every area receives. Its `toast` never throws; `act` reports failures as toasts. */
export function createAppContext(o: AppContextOptions): AppContext {
  const toast = (t: Toast): void => {
    try {
      o.toast(t);
    } catch {
      // A message that cannot be shown must not break the action that wanted to show it.
    }
  };
  return {
    store: o.store,
    api: o.api,
    keys: o.keys,
    platform: o.platform,
    registry: o.registry ?? new Registry(),
    toast,
    confirm: o.confirm,
    act: makeAct(toast),
    react: o.react,
    refresh: o.refresh,
    now: o.now ?? (() => Date.now()),
  };
}

export type ShellRegion = 'top' | 'stage' | 'studio' | 'notch' | 'dock' | 'rail' | 'palette' | 'overlays';

export interface ShellOptions {
  /** The connection strip's "Try again" (the sync engine's `retry`). */
  onRetry?: () => void;
  /** Reloads the page (the stale-page banner). */
  reload?: () => void;
  /** Draws the in-page Notch when `areas.notch` is given (default true). */
  notch?: boolean;
}

export interface ShellHandle extends Component {
  /** The layout's containers (tests, and the desktop entry). */
  readonly regions: Readonly<Record<ShellRegion, HTMLElement>>;
}

/**
 * Registers every area and mounts the layout into `root`, then runs the areas' `start`. It does
 * not start the sync engine: the caller does, once the shell is up.
 */
export function mountShell(
  ctx: AppContext,
  services: ShellServices,
  root: HTMLElement,
  areas: AreaSet,
  opts: ShellOptions = {},
): ShellHandle {
  const components: Component[] = [];
  const stops: (() => void)[] = [];
  const failed = (what: string, e: unknown): void => {
    ctx.toast({ kind: 'error', text: `${what} could not start`, detail: errorDetail(e), timeoutMs: 0 });
  };

  for (const register of areas.register) {
    try {
      register(ctx);
    } catch (e) {
      failed('A part of the interface', e);
    }
  }

  const top = h('div', { class: 'sh-top' });
  const studio = h('div', { class: 'sh-studio' });
  const notch = h('div', { class: 'sh-notch-layer' });
  const dock = h('div', { class: 'sh-dock-layer' });
  const stage = h('div', { class: 'sh-stage' }, studio, notch, dock);
  const rail = h('aside', { class: ['sh-rail', 'scroll'], tabIndex: -1, aria: { label: 'Waiting for you' } });
  const main = h('div', { class: 'sh-main' }, stage, rail);
  const palette = h('div', { class: 'sh-palette-layer' });
  const overlays = h('div', { class: 'sh-overlays' }, palette, services.confirms.el, services.toasts.el);
  const app = h('div', { class: 'sh-app' }, top, main, overlays);
  root.append(app);

  function mount(what: string, container: HTMLElement, make: () => Component, before?: Node | null): void {
    try {
      const c = make();
      components.push(c);
      if (!container.contains(c.el)) container.insertBefore(c.el, before ?? null);
    } catch (e) {
      failed(what, e);
    }
  }

  mount('The header', top, () =>
    mountHeader(ctx, {
      onShowWaiting: () => {
        rail.scrollTop = 0;
        focusQuietly(rail);
      },
    }),
  );
  mount('The banners', top, () => mountBanners(ctx, { reload: opts.reload }));
  mount('The connection strip', top, () => mountConnectionStrip(ctx.store, { onRetry: opts.onRetry }));
  mount('The Studio', studio, () => areas.studio(ctx, studio));
  mount('The decisions', rail, () => areas.tray(ctx, rail));
  const checklistArea = areas.gettingStarted;
  if (checklistArea) mount('Getting started', rail, () => mountChecklist(ctx, checklistArea));
  mount('The dock', dock, () => areas.dock(ctx, dock));
  mount('The palette', palette, () => areas.palette(ctx, palette));
  const notchArea = areas.notch;
  if (notchArea && opts.notch !== false) mount('The Notch', notch, () => notchArea(ctx, notch));
  // Drawers and modals sit under the confirm dialogs and the toasts.
  mount('The drawers', overlays, () => mountDrawerHost(ctx, services.layers), services.confirms.el);
  mount('The dialogs', overlays, () => mountModalHost(ctx, services.layers), services.confirms.el);

  for (const start of areas.start ?? []) {
    try {
      stops.push(start(ctx));
    } catch (e) {
      failed('A background service', e);
    }
  }

  let destroyed = false;
  return {
    el: app,
    regions: { top, stage, studio, notch, dock, rail, palette, overlays },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const stop of stops.reverse()) {
        try {
          stop();
        } catch {
          // keep tearing down
        }
      }
      for (const c of components.reverse()) {
        try {
          c.destroy();
        } catch {
          // keep tearing down
        }
      }
      app.remove();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Browser boot

/** Where the browser boot reads the page's surroundings (tests pass fakes). */
export interface BootEnv {
  navigator?: Pick<Navigator, 'serviceWorker'>;
  location?: Pick<Location, 'hash' | 'pathname' | 'search' | 'origin'>;
  history?: Pick<History, 'replaceState'>;
  fetch?: typeof fetch;
  sessionStorage?: Storage;
  localStorage?: Storage | null;
  /** Receives the keyboard listener and `pagehide`. */
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  document?: Document;
  reload?: () => void;
}

export type BootOutcome =
  | { kind: 'login'; reason: LoginReason }
  | {
      kind: 'running';
      ctx: AppContext;
      engine: SyncEngine;
      shell: ShellHandle;
      /** Tears everything down (tests). */
      stop(): void;
    };

const CODE_IN_FRAGMENT = /(?:^#|&)code=/;

/** Boots the Studio in a browser tab (plan §4.2). Never throws: a failure shows a screen. */
export async function bootBrowser(root: HTMLElement, areas: AreaSet): Promise<void> {
  await bootBrowserWith(root, areas);
}

export async function bootBrowserWith(root: HTMLElement, areas: AreaSet, env: BootEnv = {}): Promise<BootOutcome> {
  const loc = env.location ?? location;
  const hist = env.history ?? history;
  const doc = env.document ?? document;
  const win = env.window ?? window;
  const reload =
    env.reload ??
    (() => {
      location.reload();
    });

  function showLogin(reason: LoginReason, o: LoginScreenOptions = {}): BootOutcome {
    root.replaceChildren(loginScreen(reason, o).el);
    return { kind: 'login', reason };
  }

  // A link opened in this tab again changes only the part after `#`, which does not load the page
  // anew: start over, so the new code is read (and the worker guard runs) as on a first load.
  win.addEventListener('hashchange', () => {
    if (CODE_IN_FRAGMENT.test(loc.hash)) reload();
  });

  try {
    // 1. A leftover service worker may run inside this page: remove it and stop here.
    if ((await guardServiceWorkers(env.navigator)) === 'removed') {
      // The code is never exchanged on such a page, and is not left in the address either.
      takeLoginCode(loc, hist);
      return showLogin('sw-removed');
    }

    // 2. The session: the fragment is cleared before the exchange starts.
    const hadCode = CODE_IN_FRAGMENT.test(loc.hash);
    const code = takeLoginCode(loc, hist);
    let session: StoredSession | null = null;
    if (code) {
      try {
        session = await exchangeCode(code, loc.origin, env.fetch);
        writeSession(session, env.sessionStorage);
      } catch (e) {
        // A tab that is already signed in keeps its session when a stale link is opened in it.
        session = readSession(env.sessionStorage);
        if (!session) {
          if (e instanceof AuthError) return showLogin('used-link');
          if (e instanceof OfflineError)
            return showLogin('unreachable', { action: { label: 'Try again', run: reload } });
          return showLogin('error', { detail: errorDetail(e), action: { label: 'Try again', run: reload } });
        }
      }
    } else {
      session = readSession(env.sessionStorage);
    }
    if (!session) return showLogin(hadCode ? 'used-link' : 'no-session');

    // 3. Client, store, sync.
    let token: string | null = session.token;
    const api = new FridayApi(new HttpTransport(loc.origin, () => token, env.fetch), session.project_id);
    const store = createStore(loadPrefs(env.localStorage));
    const stopPrefs = watchPrefs(store, {
      storage: env.localStorage,
      root: doc.documentElement,
      win,
    });
    // This origin's storage is new at every start on another port; the daemon's copy is not.
    const stopPrefsSync = startPrefsSync(api, store, { win });
    const dispatcher = new Dispatcher(store);
    const engine = new SyncEngine(api, store, dispatcher);

    // 4. Context and layout.
    const keys = new Keyboard(win);
    keys.attach();
    const services = createShellServices(keys, doc);
    const ctx = createAppContext({
      store,
      api,
      keys,
      platform: browserPlatform({ root: () => store.select('board')?.project.root ?? null }),
      toast: (t) => services.toasts.show(t),
      confirm: (o) => services.confirms.confirm(o),
      react: (kind, label) => dispatcher.react(kind, Date.now(), label),
      refresh: () => {
        void engine.refresh();
      },
    });
    root.replaceChildren();
    const shell = mountShell(ctx, services, root, areas, {
      onRetry: () => {
        void engine.retry();
      },
      reload,
    });

    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      engine.stop();
      shell.destroy();
      services.confirms.destroy();
      services.toasts.destroy();
      keys.detach();
      stopPrefsSync();
      stopPrefs();
    };

    // The session ended (401): forget it in this tab and say how to sign in again. Friday gone
    // before the board ever loaded: the same kind of screen, since there is nothing to show.
    const unsubscribe = store.subscribe('system', (next) => {
      if (stopped) return;
      const board = store.select('board');
      if (next.connection === 'signed-out') {
        token = null;
        clearSession(env.sessionStorage);
        const projectName = board?.project.name ?? null;
        queueMicrotask(() => {
          stop();
          showLogin('signed-out', { projectName });
        });
      } else if (next.connection === 'stopped' && !board) {
        const detail = next.lastError && next.lastError !== UNREACHABLE_MESSAGE ? next.lastError : null;
        queueMicrotask(() => {
          stop();
          showLogin('unreachable', { detail, action: { label: 'Try again', run: reload } });
        });
      }
    });

    void engine.start();
    return { kind: 'running', ctx, engine, shell, stop };
  } catch (e) {
    return showLogin('error', { detail: errorDetail(e), action: { label: 'Try again', run: reload } });
  }
}
