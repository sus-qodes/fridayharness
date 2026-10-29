import { afterEach, describe, expect, it, vi } from 'vitest';
import { studioAreas } from '../areas.js';
import { recordingContext } from '../mascot/testing.js';
import { ApiError } from '../platform/transport.js';
import { makeContext } from '../test/context.js';
import { makeScenario, makeSnapshot, PID } from '../test/fixtures.js';
import { h } from '../ui/dom.js';
import {
  type AreaSet,
  type BootEnv,
  bootBrowserWith,
  createAppContext,
  createShellServices,
  mountShell,
  type ShellHooks,
} from './app.js';
import type { AppContext, Toast } from './context.js';

const SESSION_KEY = 'friday.ui.session';
const ORIGIN = 'http://127.0.0.1:4310';
const CODE = 'abcdefghijklmnopqrstuvwxyz012345';

class MemoryStorage implements Storage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

function fakeAreas(
  log: string[],
  opts: { failing?: keyof AreaSet; notch?: boolean; onNotchHooks?: (hooks: ShellHooks) => void } = {},
): AreaSet {
  const part =
    (name: 'studio' | 'dock' | 'palette' | 'tray' | 'notch') =>
    (_ctx: AppContext, container: HTMLElement, hooks?: ShellHooks) => {
      if (opts.failing === name) throw new Error(`${name} broke`);
      if (name === 'notch' && hooks) opts.onNotchHooks?.(hooks);
      const el = h('div', { class: `fake-${name}` }, name);
      container.append(el);
      log.push(`mount:${name}`);
      return {
        el,
        destroy: () => {
          log.push(`destroy:${name}`);
          el.remove();
        },
      };
    };
  return {
    register: [
      () => {
        log.push('register');
      },
    ],
    studio: part('studio'),
    dock: part('dock'),
    palette: part('palette'),
    tray: part('tray'),
    ...(opts.notch === false ? {} : { notch: part('notch') }),
    gettingStarted: () => ({ el: h('div', { class: 'fake-gs' }), destroy: () => undefined }),
    start: [
      () => {
        log.push('start');
        return () => log.push('stop');
      },
    ],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface DaemonOpts {
  exchange?: 'ok' | 401 | 'offline';
  snapshot?: 'ok' | 401 | 'offline';
  /** The daemon's copy of the preferences; without it `ui/prefs` is an unknown route. */
  prefs?: { saved: Record<string, unknown> | null };
}

/** A daemon behind `fetch`: the code exchange, the snapshot, and a stream that stays open. */
function fakeDaemon(order: string[], opts: DaemonOpts = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${ORIGIN}/ui/session`) {
      order.push('exchange');
      if (opts.exchange === 401) return json({ error: { code: 'COS-3004', message: 'invalid login code' } }, 401);
      if (opts.exchange === 'offline') throw new TypeError('Failed to fetch');
      return json({ token: 'ui-token', expires_at: '2099-01-01T00:00:00Z', project_id: PID });
    }
    if (url.endsWith('/ui/snapshot')) {
      order.push('snapshot');
      if (opts.snapshot === 401) return json({ error: { code: 'COS-3005', message: 'session ended' } }, 401);
      if (opts.snapshot === 'offline') throw new TypeError('Failed to fetch');
      return json(makeSnapshot({ project: { ...makeSnapshot().project, name: 'shop' } }));
    }
    if (url.endsWith('/ui/prefs') && opts.prefs) {
      if (init.method !== 'POST') return json({ prefs: opts.prefs.saved });
      opts.prefs.saved = (JSON.parse(String(init.body)) as { prefs: Record<string, unknown> }).prefs;
      return json({ ok: true });
    }
    if (url.includes('/events/stream')) {
      if (opts.snapshot === 'offline') throw new TypeError('Failed to fetch');
      const signal = init.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
          },
        }),
        { status: 200 },
      );
    }
    return json({ error: { code: 'COS-1000', message: 'unknown route' } }, 400);
  });
  return { calls, fetchImpl };
}

function env(order: string[], fetchImpl: typeof fetch, over: Partial<BootEnv> & { hash?: string } = {}) {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  const replaceState = vi.fn(() => {
    order.push('clear');
  });
  const reload = vi.fn();
  const e: BootEnv = {
    navigator: { serviceWorker: { controller: null, getRegistrations: async () => [] } } as unknown as Navigator,
    location: { hash: over.hash ?? '', pathname: '/ui/nonce/', search: '', origin: ORIGIN },
    history: { replaceState },
    fetch: fetchImpl,
    sessionStorage: session,
    localStorage: local,
    window: new EventTarget() as unknown as Window,
    document,
    reload,
    ...over,
  };
  return { env: e, session, local, replaceState, reload };
}

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.className = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createAppContext', () => {
  it('builds act on the toast, swallows a failing toast and makes a registry', async () => {
    const base = makeContext();
    const toasts: Toast[] = [];
    const ctx = createAppContext({
      store: base.store,
      api: base.api,
      keys: base.keys,
      platform: base.platform,
      toast: (t) => toasts.push(t),
      confirm: async () => true,
      react: () => undefined,
      refresh: () => undefined,
      now: () => 42,
    });
    expect(ctx.registry.drawers.size).toBe(0);
    expect(ctx.now()).toBe(42);
    await ctx.act('Approve', async () => {
      throw new ApiError(409, 'COS-2002', 'invalid_state_transition', 'already decided');
    });
    expect(toasts).toEqual([{ kind: 'error', text: 'Approve', detail: 'COS-2002: already decided' }]);
    const quiet = createAppContext({
      store: base.store,
      api: base.api,
      keys: base.keys,
      platform: base.platform,
      toast: () => {
        throw new Error('no host');
      },
      confirm: async () => true,
      react: () => undefined,
      refresh: () => undefined,
    });
    expect(() => quiet.toast({ kind: 'info', text: 'x' })).not.toThrow();
    expect(await quiet.act('Fails', async () => Promise.reject(new Error('x')))).toBeUndefined();
  });
});

describe('mountShell', () => {
  function shellSetup(areas: AreaSet, opts: Parameters<typeof mountShell>[4] = {}) {
    const ctx = makeContext();
    const services = createShellServices(ctx.keys);
    const realToast = ctx.toast;
    const shellCtx: AppContext = {
      ...ctx,
      toast: (t) => {
        realToast(t);
        services.toasts.show(t);
      },
    };
    const root = h('div');
    document.body.append(root);
    const shell = mountShell(shellCtx, services, root, areas, opts);
    return { ctx, services, root, shell };
  }

  it('registers, mounts every region, then starts the services', () => {
    const log: string[] = [];
    const { root, shell } = shellSetup(fakeAreas(log));
    expect(log).toEqual([
      'register',
      'mount:studio',
      'mount:tray',
      'mount:dock',
      'mount:palette',
      'mount:notch',
      'start',
    ]);
    const r = shell.regions;
    expect(r.studio.querySelector('.fake-studio')).not.toBeNull();
    expect(r.rail.querySelector('.fake-tray')).not.toBeNull();
    expect(r.dock.querySelector('.fake-dock')).not.toBeNull();
    expect(r.palette.querySelector('.fake-palette')).not.toBeNull();
    expect(r.notch.querySelector('.fake-notch')).not.toBeNull();
    expect(r.top.querySelector('.sh-header')).not.toBeNull();
    // Getting started sits in the rail under the decisions, so the Studio keeps its height.
    expect(r.top.querySelector('.fake-gs')).toBeNull();
    expect(r.rail.querySelector('.sh-banner-slot .fake-gs')).not.toBeNull();
    expect(r.top.querySelector('.sh-strip')).not.toBeNull();
    expect(r.overlays.querySelector('.sh-drawer-host')).not.toBeNull();
    expect(r.overlays.querySelector('.sh-modal-host')).not.toBeNull();
    expect(r.overlays.querySelector('.sh-confirm-host')).not.toBeNull();
    expect(r.overlays.querySelector('.sh-toasts')).not.toBeNull();
    expect(r.rail.getAttribute('aria-label')).toBe('Waiting for you');
    expect(root.querySelectorAll('.sh-app')).toHaveLength(1);
    shell.destroy();
    expect(log.slice(7)).toEqual([
      'stop',
      'destroy:notch',
      'destroy:palette',
      'destroy:dock',
      'destroy:tray',
      'destroy:studio',
    ]);
    expect(root.childElementCount).toBe(0);
  });

  it('draws no Notch without the area or when asked not to', () => {
    const a: string[] = [];
    shellSetup(fakeAreas(a, { notch: false }));
    expect(a).not.toContain('mount:notch');
    const b: string[] = [];
    shellSetup(fakeAreas(b), { notch: false });
    expect(b).not.toContain('mount:notch');
  });

  it('keeps the page when one area fails, and says which', () => {
    const log: string[] = [];
    const { ctx, shell } = shellSetup(fakeAreas(log, { failing: 'dock' }));
    expect(log).toContain('mount:studio');
    expect(log).toContain('mount:palette');
    expect(log).toContain('start');
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'error', text: 'The dock could not start', detail: 'dock broke' });
    expect(shell.regions.overlays.querySelector('.sh-toast-error')?.textContent).toContain('dock broke');
  });

  it('"Waiting for you" moves focus to the decisions rail, and the in-page Notch gets the same hook', () => {
    const given: { hooks: ShellHooks | null } = { hooks: null };
    const { shell } = shellSetup(
      fakeAreas([], {
        onNotchHooks: (hooks) => {
          given.hooks = hooks;
        },
      }),
    );
    const rail = shell.regions.rail;
    rail.scrollTop = 40;
    (shell.regions.top.querySelector('.sh-metric-waiting') as HTMLButtonElement).click();
    expect(document.activeElement).toBe(rail);
    expect(rail.scrollTop).toBe(0);
    rail.blur();
    rail.scrollTop = 40;
    expect(given.hooks).not.toBeNull();
    given.hooks?.onShowWaiting();
    expect(document.activeElement).toBe(rail);
    expect(rail.scrollTop).toBe(0);
  });

  it('the browser pill’s chip shows the rail as the header’s count does (the real areas)', () => {
    // The canvas and the mascot measure themselves and draw: a real window gives them a box and a
    // 2D context (happy-dom has none).
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 1200,
      height: 800,
      right: 1200,
      bottom: 800,
      toJSON: () => ({}),
    } as DOMRect);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recordingContext().g as never);
    const ctx = makeContext({ snapshot: makeScenario() });
    ctx.store.patch('prefs', { motion: 'reduce' });
    const services = createShellServices(ctx.keys);
    const root = h('div');
    document.body.append(root);
    const shell = mountShell(
      { ...ctx, toast: (t) => services.toasts.show(t) },
      services,
      root,
      studioAreas({ sounds: false }),
    );
    try {
      const chip = shell.regions.notch.querySelector('.nt-chip') as HTMLButtonElement;
      expect(chip.hidden).toBe(false);
      expect(chip.textContent).toBe('3 waiting');
      // The rail's list is in the page, so a Notch on its own would focus its first row; through
      // the shell it lands where the header's count does: on the rail itself.
      expect(shell.regions.rail.querySelector('.gv-tray button')).not.toBeNull();
      chip.click();
      expect(document.activeElement).toBe(shell.regions.rail);
    } finally {
      shell.destroy();
    }
  });

  it('opens the drawers and modals the areas registered', () => {
    const areas = fakeAreas([]);
    areas.register.push((c) => {
      c.registry.drawer('memory', () => ({
        el: h('div', { class: 'fake-memory' }),
        title: 'Memory',
        destroy: () => undefined,
      }));
    });
    const { ctx, shell } = shellSetup(areas);
    // Project memory sits behind the header's More menu (review §4).
    (shell.regions.top.querySelector('[aria-label="More"]') as HTMLButtonElement).click();
    (shell.regions.top.querySelector('[data-item="memory"]') as HTMLButtonElement).click();
    expect(ctx.store.select('ui').drawer?.kind).toBe('memory');
    expect(shell.regions.overlays.querySelector('.fake-memory')).not.toBeNull();
  });
});

describe('bootBrowser (plan §4.2, §7.1)', () => {
  it('removes a leftover service worker and does nothing else', async () => {
    const order: string[] = [];
    const { fetchImpl } = fakeDaemon(order);
    const unregister = vi.fn(async () => true);
    const { env: e, replaceState } = env(order, fetchImpl as unknown as typeof fetch, {
      hash: `#code=${CODE}`,
      navigator: {
        serviceWorker: { controller: {}, getRegistrations: async () => [{ unregister }] },
      } as unknown as Navigator,
    });
    const root = h('div');
    const out = await bootBrowserWith(root, fakeAreas([]), e);
    expect(out).toEqual({ kind: 'login', reason: 'sw-removed' });
    expect(unregister).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledOnce();
    expect(root.textContent).toContain('Friday removed a leftover service worker');
  });

  it('starts over when a sign-in link is opened in this tab again (only the fragment changes)', async () => {
    const order: string[] = [];
    const { fetchImpl } = fakeDaemon(order);
    const unregister = vi.fn(async () => true);
    const { env: e, reload } = env(order, fetchImpl as unknown as typeof fetch, {
      navigator: {
        serviceWorker: { controller: {}, getRegistrations: async () => [{ unregister }] },
      } as unknown as Navigator,
    });
    await bootBrowserWith(h('div'), fakeAreas([]), e);
    const loc = e.location as { hash: string };
    const win = e.window as unknown as EventTarget;
    loc.hash = '#other';
    win.dispatchEvent(new Event('hashchange'));
    expect(reload).not.toHaveBeenCalled();
    loc.hash = `#code=${CODE}`;
    win.dispatchEvent(new Event('hashchange'));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('shows how to sign in when the tab has no session', async () => {
    const order: string[] = [];
    const { fetchImpl } = fakeDaemon(order);
    const { env: e } = env(order, fetchImpl as unknown as typeof fetch);
    const root = h('div');
    expect(await bootBrowserWith(root, fakeAreas([]), e)).toEqual({ kind: 'login', reason: 'no-session' });
    expect(root.querySelector('.sh-login-command')?.textContent).toBe('friday ui');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('clears the fragment before exchanging the code, keeps the session in this tab, and starts', async () => {
    const order: string[] = [];
    const { fetchImpl, calls } = fakeDaemon(order);
    const { env: e, session, local } = env(order, fetchImpl as unknown as typeof fetch, { hash: `#code=${CODE}` });
    const root = h('div');
    document.body.append(root);
    const log: string[] = [];
    const out = await bootBrowserWith(root, fakeAreas(log), e);
    expect(out.kind).toBe('running');
    if (out.kind !== 'running') return;
    expect(order.slice(0, 2)).toEqual(['clear', 'exchange']);
    const exchange = calls[0];
    expect(exchange?.init.method).toBe('POST');
    expect(JSON.parse(String(exchange?.init.body))).toEqual({ code: CODE });
    expect(JSON.parse(session.getItem(SESSION_KEY) ?? '{}')).toMatchObject({ token: 'ui-token', project_id: PID });
    expect(local.getItem(SESSION_KEY)).toBeNull();
    expect(log).toContain('start');
    await vi.waitFor(() => expect(out.ctx.store.select('board')?.project.name).toBe('shop'));
    const snap = calls.find((c) => c.url.endsWith('/ui/snapshot'));
    expect(snap?.url).toBe(`${ORIGIN}/api/v1/projects/${PID}/ui/snapshot`);
    expect(snap?.init.headers).toMatchObject({ authorization: 'Bearer ui-token' });
    expect(root.querySelector('.sh-project-name')?.textContent).toBe('shop');
    out.stop();
    expect(root.querySelector('.sh-app')).toBeNull();
    expect(log).toContain('stop');
  });

  it('says a used or expired link cannot be used', async () => {
    const order: string[] = [];
    const { fetchImpl } = fakeDaemon(order, { exchange: 401 });
    const { env: e } = env(order, fetchImpl as unknown as typeof fetch, { hash: `#code=${CODE}` });
    const root = h('div');
    expect(await bootBrowserWith(root, fakeAreas([]), e)).toEqual({ kind: 'login', reason: 'used-link' });
    expect(root.textContent).toContain('This link was already used or has expired; open Friday again.');
    expect(order).toEqual(['clear', 'exchange']);
  });

  it('never sends a malformed code', async () => {
    const order: string[] = [];
    const { fetchImpl } = fakeDaemon(order);
    const { env: e } = env(order, fetchImpl as unknown as typeof fetch, { hash: '#code=<img src=x onerror=alert(1)>' });
    const root = h('div');
    expect(await bootBrowserWith(root, fakeAreas([]), e)).toEqual({ kind: 'login', reason: 'used-link' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(root.querySelector('img')).toBeNull();
  });

  it('says Friday is not reachable when the exchange gets no answer, and offers to try again', async () => {
    const order: string[] = [];
    const { fetchImpl } = fakeDaemon(order, { exchange: 'offline' });
    const { env: e, reload } = env(order, fetchImpl as unknown as typeof fetch, { hash: `#code=${CODE}` });
    const root = h('div');
    expect(await bootBrowserWith(root, fakeAreas([]), e)).toEqual({ kind: 'login', reason: 'unreachable' });
    (root.querySelector('.sh-login-action') as HTMLButtonElement).click();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('keeps an existing session when a stale link is opened in the same tab', async () => {
    const order: string[] = [];
    const { fetchImpl, calls } = fakeDaemon(order, { exchange: 401 });
    const { env: e, session } = env(order, fetchImpl as unknown as typeof fetch, { hash: `#code=${CODE}` });
    session.setItem(
      SESSION_KEY,
      JSON.stringify({ token: 'kept', expires_at: '2099-01-01T00:00:00Z', project_id: PID }),
    );
    const root = h('div');
    const out = await bootBrowserWith(root, fakeAreas([]), e);
    expect(out.kind).toBe('running');
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/ui/snapshot'))).toBe(true));
    const snap = calls.find((c) => c.url.endsWith('/ui/snapshot'));
    expect(snap?.init.headers).toMatchObject({ authorization: 'Bearer kept' });
    if (out.kind === 'running') out.stop();
  });

  it('reads the session this tab already has, without an exchange', async () => {
    const order: string[] = [];
    const { fetchImpl } = fakeDaemon(order);
    const { env: e, session } = env(order, fetchImpl as unknown as typeof fetch);
    session.setItem(SESSION_KEY, JSON.stringify({ token: 'tab', expires_at: '2099-01-01T00:00:00Z', project_id: PID }));
    const out = await bootBrowserWith(h('div'), fakeAreas([]), e);
    expect(out.kind).toBe('running');
    await vi.waitFor(() => expect(order).toContain('snapshot'));
    expect(order).not.toContain('exchange');
    if (out.kind === 'running') out.stop();
  });

  it('forgets the session and shows the sign-in screen when the daemon ends it', async () => {
    const order: string[] = [];
    const { fetchImpl } = fakeDaemon(order, { snapshot: 401 });
    const { env: e, session } = env(order, fetchImpl as unknown as typeof fetch);
    session.setItem(SESSION_KEY, JSON.stringify({ token: 'old', expires_at: '2099-01-01T00:00:00Z', project_id: PID }));
    const root = h('div');
    document.body.append(root);
    const out = await bootBrowserWith(root, fakeAreas([]), e);
    expect(out.kind).toBe('running');
    await vi.waitFor(() => expect(root.querySelector('.sh-login')).not.toBeNull());
    expect(root.querySelector('.sh-login-card')?.getAttribute('data-reason')).toBe('signed-out');
    expect(root.querySelector('.sh-app')).toBeNull();
    expect(session.getItem(SESSION_KEY)).toBeNull();
  });

  it('shows the not-reachable screen when Friday never answered', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const { fetchImpl } = fakeDaemon(order, { snapshot: 'offline' });
    const { env: e, session } = env(order, fetchImpl as unknown as typeof fetch);
    session.setItem(SESSION_KEY, JSON.stringify({ token: 't', expires_at: '2099-01-01T00:00:00Z', project_id: PID }));
    const root = h('div');
    const out = await bootBrowserWith(root, fakeAreas([]), e);
    expect(out.kind).toBe('running');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(root.querySelector('.sh-login-card')?.getAttribute('data-reason')).toBe('unreachable');
    expect(root.textContent).toContain('Friday is not reachable here');
  });

  it('applies the saved motion preference to the document', async () => {
    const order: string[] = [];
    const { fetchImpl } = fakeDaemon(order);
    const { env: e, session, local } = env(order, fetchImpl as unknown as typeof fetch);
    session.setItem(SESSION_KEY, JSON.stringify({ token: 't', expires_at: '2099-01-01T00:00:00Z', project_id: PID }));
    local.setItem('friday.prefs', JSON.stringify({ motion: 'reduce' }));
    const out = await bootBrowserWith(h('div'), fakeAreas([]), e);
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(true);
    if (out.kind === 'running') out.stop();
  });

  it('lays the daemon copy of the preferences over the saved ones and sends every change to both', async () => {
    const order: string[] = [];
    const prefs = { saved: { muted: true, outfit: 'visor' } as Record<string, unknown> | null };
    const { fetchImpl, calls } = fakeDaemon(order, { prefs });
    const { env: e, session, local } = env(order, fetchImpl as unknown as typeof fetch);
    session.setItem(SESSION_KEY, JSON.stringify({ token: 't', expires_at: '2099-01-01T00:00:00Z', project_id: PID }));
    local.setItem('friday.prefs', JSON.stringify({ motion: 'reduce', outfit: 'witch' }));
    const out = await bootBrowserWith(h('div'), fakeAreas([]), e);
    if (out.kind !== 'running') throw new Error(`not running: ${out.reason}`);
    const read = calls.find((c) => c.url.endsWith('/ui/prefs'));
    expect(read?.url).toBe(`${ORIGIN}/api/v1/projects/${PID}/ui/prefs`);
    expect(read?.init.headers).toMatchObject({ authorization: 'Bearer t' });
    await vi.waitFor(() =>
      expect(out.ctx.store.select('prefs')).toMatchObject({ muted: true, outfit: 'visor', motion: 'reduce' }),
    );
    out.ctx.store.patch('prefs', { volume: 0.3 });
    await vi.waitFor(() => expect(prefs.saved).toMatchObject({ muted: true, outfit: 'visor', volume: 0.3 }));
    await vi.waitFor(() => expect(JSON.parse(local.getItem('friday.prefs') ?? '{}')).toMatchObject({ volume: 0.3 }));
    out.stop();
  });

  it('finds the preferences again after Friday restarts on another port, a new origin with empty storage (review R5)', async () => {
    const prefs = { saved: null as Record<string, unknown> | null };
    const boot = async (origin: string) => {
      const order: string[] = [];
      const { fetchImpl } = fakeDaemon(order, { prefs });
      const {
        env: e,
        session,
        local,
      } = env(order, fetchImpl as unknown as typeof fetch, {
        location: { hash: '', pathname: '/ui/nonce/', search: '', origin },
      });
      session.setItem(SESSION_KEY, JSON.stringify({ token: 't', expires_at: '2099-01-01T00:00:00Z', project_id: PID }));
      const out = await bootBrowserWith(h('div'), fakeAreas([]), e);
      if (out.kind !== 'running') throw new Error(`not running: ${out.reason}`);
      return { out, local };
    };
    const first = await boot(ORIGIN);
    await vi.waitFor(() => expect(prefs.saved).not.toBeNull());
    first.out.ctx.store.patch('prefs', { muted: true, outfit: 'visor' });
    await vi.waitFor(() => expect(prefs.saved).toMatchObject({ muted: true, outfit: 'visor' }));
    await vi.waitFor(() => expect(first.local.getItem('friday.audio.muted')).toBe('true'));
    first.out.stop();

    const second = await boot('http://127.0.0.1:4987');
    expect(second.local.getItem('friday.audio.muted')).toBeNull();
    await vi.waitFor(() =>
      expect(second.out.ctx.store.select('prefs')).toMatchObject({ muted: true, outfit: 'visor' }),
    );
    second.out.stop();
  });
});
