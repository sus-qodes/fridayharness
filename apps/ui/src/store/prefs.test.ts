import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyMotion,
  type DaemonPrefs,
  loadPrefs,
  MAX_POSITIONS,
  MUTED_KEY,
  overlayPrefs,
  PREFS_KEY,
  type PrefsApi,
  parseMuted,
  parsePositions,
  parsePrefs,
  prefsForDaemon,
  SAVE_DEBOUNCE_MS,
  SYNC_MAX_BYTES,
  savePrefs,
  startPrefsSync,
  watchPrefs,
} from './prefs.js';
import { createStore, DEFAULT_PREFS, type Prefs } from './state.js';

class MemoryStorage implements Storage {
  map = new Map<string, string>();
  writes = 0;
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
    this.writes++;
    this.map.set(k, v);
  }
}

function throwingStorage(): Storage {
  const fail = () => {
    throw new DOMException('denied', 'SecurityError');
  };
  return { getItem: fail, setItem: fail, removeItem: fail, clear: fail, key: fail, length: 0 } as unknown as Storage;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parsePrefs: untrusted input (§6.8)', () => {
  it('gives the defaults for nothing, garbage and the wrong shapes', () => {
    for (const raw of [null, undefined, 5, 'x', [], [1, 2], true]) expect(parsePrefs(raw)).toEqual(DEFAULT_PREFS);
  });

  it('keeps valid values', () => {
    const p = parsePrefs({
      muted: true,
      volume: 0.5,
      motion: 'reduce',
      outfit: 'witch',
      showFinished: false,
      notchAutoCollapseS: 30,
      notchHideS: 120,
      notifications: true,
      positions: { task_1: { x: 10, y: -20.5 } },
      gettingStartedDismissed: true,
      terminalHeight: 450,
    });
    expect(p).toEqual({
      muted: true,
      volume: 0.5,
      motion: 'reduce',
      outfit: 'witch',
      showFinished: false,
      notchAutoCollapseS: 30,
      notchHideS: 120,
      notifications: true,
      positions: { task_1: { x: 10, y: -20.5 } },
      gettingStartedDismissed: true,
      terminalHeight: 450,
    });
  });

  it('replaces each wrong field by its default and keeps the others', () => {
    const p = parsePrefs({
      muted: 'yes',
      volume: 7,
      motion: '<img src=x onerror=alert(1)>',
      outfit: 'crown',
      showFinished: 1,
      notchAutoCollapseS: Number.POSITIVE_INFINITY,
      notchHideS: Number.NaN,
      notifications: 'true',
      positions: 'everywhere',
      gettingStartedDismissed: null,
      terminalHeight: 5000,
    });
    expect(p).toEqual(DEFAULT_PREFS);
    expect(parsePrefs({ volume: -0.1 }).volume).toBe(DEFAULT_PREFS.volume);
    expect(parsePrefs({ terminalHeight: 299 }).terminalHeight).toBe(DEFAULT_PREFS.terminalHeight);
    expect(parsePrefs({ terminalHeight: '400' }).terminalHeight).toBe(DEFAULT_PREFS.terminalHeight);
    expect(parsePrefs({ volume: 0, outfit: 'visor' })).toMatchObject({ volume: 0, outfit: 'visor', motion: 'system' });
  });

  it('keeps only sane node positions, at most 2000', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i++) many[`task_${i}`] = { x: i, y: -i };
    expect(Object.keys(parsePositions(many))).toHaveLength(MAX_POSITIONS);
    const hostile = JSON.parse(
      '{"__proto__":{"x":1,"y":2},"constructor":{"x":1,"y":2},"ok":{"x":1,"y":2},"inf":{"x":1e999,"y":0},' +
        '"str":{"x":"1","y":2},"far":{"x":1e9,"y":0},"arr":[1,2],"nul":null,"<img src=x>":{"x":1,"y":1},' +
        '"bidi‮":{"x":1,"y":1}}',
    ) as unknown;
    const out = parsePositions(hostile);
    expect(out).toEqual({ ok: { x: 1, y: 2 } });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(parsePositions(null)).toEqual({});
    expect(parsePositions([{ x: 1, y: 1 }])).toEqual({});
    expect(parsePositions({ [`${'a'.repeat(5000)}`]: { x: 1, y: 1 } })).toEqual({});
  });

  it('reads the mute switch from its own key', () => {
    expect(parseMuted('true')).toBe(true);
    expect(parseMuted('1')).toBe(true);
    expect(parseMuted('false')).toBe(false);
    expect(parseMuted('0')).toBe(false);
    expect(parseMuted('maybe')).toBeNull();
    expect(parseMuted(null)).toBeNull();
    expect(parsePrefs({ muted: false }, 'true').muted).toBe(true);
    expect(parsePrefs({ muted: true }, 'nonsense').muted).toBe(true);
  });
});

describe('loadPrefs and savePrefs', () => {
  it('round-trips through the storage under its keys', () => {
    const s = new MemoryStorage();
    const prefs = { ...DEFAULT_PREFS, muted: true, outfit: 'visor' as const, positions: { g1: { x: 1, y: 2 } } };
    expect(savePrefs(prefs, s)).toBe(true);
    expect(s.getItem(MUTED_KEY)).toBe('true');
    expect(JSON.parse(s.getItem(PREFS_KEY) ?? '{}')).toMatchObject({ outfit: 'visor' });
    expect(loadPrefs(s)).toEqual(prefs);
  });

  it('gives the defaults for unreadable and oversized values', () => {
    const s = new MemoryStorage();
    s.setItem(PREFS_KEY, '{not json');
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
    s.setItem(PREFS_KEY, JSON.stringify({ volume: 0.4, pad: 'x'.repeat(1_100_000) }));
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
    s.setItem(PREFS_KEY, JSON.stringify({ volume: 0.4, outfit: 'x'.repeat(5000) }));
    expect(loadPrefs(s)).toEqual({ ...DEFAULT_PREFS, volume: 0.4 });
  });

  it('survives a storage that throws and no storage at all', () => {
    expect(loadPrefs(throwingStorage())).toEqual(DEFAULT_PREFS);
    expect(savePrefs(DEFAULT_PREFS, throwingStorage())).toBe(false);
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(savePrefs(DEFAULT_PREFS, null)).toBe(false);
  });

  it('never writes a value it would not read back', () => {
    const s = new MemoryStorage();
    savePrefs({ ...DEFAULT_PREFS, volume: 99, positions: { __proto__: { x: 1, y: 1 } } as never }, s);
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
  });

  it('records when the copy was saved, and keeps that time when what it read is saved again', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const s = new MemoryStorage();
    savePrefs({ ...DEFAULT_PREFS, outfit: 'winter' }, s);
    const text = s.getItem(PREFS_KEY);
    expect(JSON.parse(text ?? '{}')).toMatchObject({ outfit: 'winter', saved_at: 1_000 });
    vi.setSystemTime(5_000);
    savePrefs(loadPrefs(s), s);
    expect(s.getItem(PREFS_KEY)).toBe(text);
  });
});

describe('watchPrefs', () => {
  it('saves once, 300 ms after the last change', () => {
    vi.useFakeTimers();
    const s = new MemoryStorage();
    const store = createStore();
    const stop = watchPrefs(store, { storage: s, root: document.createElement('div'), win: null });
    store.patch('prefs', { volume: 0.3 });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 50);
    store.patch('prefs', { volume: 0.4 });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
    expect(s.writes).toBe(0);
    vi.advanceTimersByTime(1);
    expect(s.writes).toBe(2); // the preferences and the mute key, once
    expect(loadPrefs(s).volume).toBe(0.4);
    stop();
  });

  it('applies the motion preference to the root element', () => {
    const root = document.createElement('html');
    const store = createStore({ ...DEFAULT_PREFS, motion: 'reduce' });
    const stop = watchPrefs(store, { storage: null, root, win: null });
    expect(root.classList.contains('reduce-motion')).toBe(true);
    store.patch('prefs', { motion: 'full' });
    expect(root.classList.contains('reduce-motion')).toBe(false);
    expect(root.classList.contains('motion-on')).toBe(true);
    store.patch('prefs', { motion: 'system' });
    expect(root.className).toBe('');
    stop();
  });

  it('saves a pending change when stopped or when the page hides, and then stops listening', () => {
    vi.useFakeTimers();
    const s = new MemoryStorage();
    const win = new EventTarget() as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;
    const store = createStore();
    const stop = watchPrefs(store, { storage: s, root: null, win });
    store.patch('prefs', { outfit: 'winter' });
    (win as unknown as EventTarget).dispatchEvent(new Event('pagehide'));
    expect(loadPrefs(s).outfit).toBe('winter');
    store.patch('prefs', { outfit: 'witch' });
    stop();
    expect(loadPrefs(s).outfit).toBe('witch');
    const writes = s.writes;
    store.patch('prefs', { outfit: 'visor' });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 2);
    expect(s.writes).toBe(writes);
  });

  it('takes what another window saved, as the desktop Studio and Notch share one storage (review M9i)', () => {
    vi.useFakeTimers();
    const s = new MemoryStorage();
    const win = new EventTarget() as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;
    const store = createStore();
    const stop = watchPrefs(store, { storage: s, root: null, win });
    // The other window turned notifications on and saved.
    savePrefs({ ...store.select('prefs'), notifications: true }, s);
    (win as unknown as EventTarget).dispatchEvent(Object.assign(new Event('storage'), { key: PREFS_KEY }));
    expect(store.select('prefs').notifications).toBe(true);
    // Another key changes nothing here.
    (win as unknown as EventTarget).dispatchEvent(Object.assign(new Event('storage'), { key: 'something-else' }));
    expect(store.select('prefs').notifications).toBe(true);
    stop();
  });

  it('saves what it took from another window with the time it was saved there, so the windows do not echo', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const s = new MemoryStorage();
    const win = new EventTarget() as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;
    const store = createStore();
    const stop = watchPrefs(store, { storage: s, root: null, win });
    savePrefs({ ...DEFAULT_PREFS, outfit: 'winter' }, s); // the other window
    const text = s.getItem(PREFS_KEY);
    vi.setSystemTime(5_000);
    (win as unknown as EventTarget).dispatchEvent(Object.assign(new Event('storage'), { key: PREFS_KEY }));
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(store.select('prefs').outfit).toBe('winter');
    expect(s.getItem(PREFS_KEY)).toBe(text);
    stop();
  });

  it('keeps working when the storage throws', () => {
    vi.useFakeTimers();
    const store = createStore();
    const stop = watchPrefs(store, { storage: throwingStorage(), root: null, win: null });
    store.patch('prefs', { volume: 0.2 });
    expect(() => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)).not.toThrow();
    stop();
  });

  it('applyMotion tolerates a missing root', () => {
    expect(() => applyMotion('reduce', null)).not.toThrow();
  });
});

/** Lets the promise chains of a fake daemon answer run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

type PrefsAnswer = { prefs: Record<string, unknown> | null };

/** The daemon's copy behind the two calls; `read` answers each read in turn (the last one repeats). */
function fakeApi(...read: (PrefsAnswer | Error | Promise<PrefsAnswer>)[]) {
  const saved: DaemonPrefs[] = [];
  let reads = 0;
  const api = {
    uiPrefs: vi.fn(() => {
      const a = read[Math.min(reads++, read.length - 1)] ?? { prefs: null };
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    }),
    saveUiPrefs: vi.fn(async (p: DaemonPrefs, _opts?: { keepalive?: boolean }) => {
      saved.push(p);
      return { ok: true };
    }),
  } satisfies PrefsApi;
  return { api, saved };
}

/** What the daemon is sent for `prefs` saved at `at`: everything but notifications, with the time. */
function daemonCopy(prefs: Prefs, at: number): DaemonPrefs {
  const { notifications: _local, ...values } = prefs;
  return { ...values, saved_at: at };
}

/** This origin's storage holding `prefs`, saved at `at`. */
function originWith(prefs: Prefs, at: number): MemoryStorage {
  const s = new MemoryStorage();
  s.setItem(PREFS_KEY, JSON.stringify({ ...prefs, saved_at: at }));
  return s;
}

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('the daemon copy: startPrefsSync (review R5)', () => {
  it('lays the daemon copy over the copy of this origin, field by field, and saves the result back', async () => {
    const store = createStore({ ...DEFAULT_PREFS, volume: 0.5, outfit: 'witch', positions: { a: { x: 1, y: 1 } } });
    const { api, saved } = fakeApi({
      prefs: { muted: true, volume: 0.9, outfit: 'crown', positions: { g1: { x: 5, y: 6 } }, extra: 'x' },
    });
    const stop = startPrefsSync(api, store, { win: null });
    await settle();
    const want: Prefs = {
      ...DEFAULT_PREFS,
      muted: true,
      volume: 0.9,
      outfit: 'witch',
      positions: { g1: { x: 5, y: 6 } },
    };
    expect(store.select('prefs')).toEqual(want);
    // The daemon's copy had a wrong field and lacked the others: it gets the whole, clean copy,
    // with its own time (none: older than any copy with one).
    expect(saved).toEqual([daemonCopy(want, 0)]);
    stop();
  });

  it('sends nothing before the daemon copy was read, and keeps a change made meanwhile', async () => {
    vi.useFakeTimers();
    const answer = deferred<PrefsAnswer>();
    const { api, saved } = fakeApi(answer.promise);
    const store = createStore();
    const stop = startPrefsSync(api, store, { win: null });
    store.patch('prefs', { muted: true });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 4);
    expect(api.saveUiPrefs).not.toHaveBeenCalled();
    answer.resolve({ prefs: daemonCopy({ ...DEFAULT_PREFS, muted: false, volume: 0.7 }, 1_000) });
    await settle();
    expect(store.select('prefs')).toMatchObject({ muted: true, volume: 0.7 });
    // A new copy, neither the daemon's nor this origin's: saved now.
    expect(saved).toEqual([daemonCopy({ ...DEFAULT_PREFS, muted: true, volume: 0.7 }, Date.now())]);
    stop();
  });

  it('gives the daemon the copy of this page when it has none', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(7_000);
    const store = createStore({ ...DEFAULT_PREFS, outfit: 'visor' });
    const { api, saved } = fakeApi({ prefs: null });
    const stop = startPrefsSync(api, store, { win: null });
    await settle();
    expect(store.select('prefs').outfit).toBe('visor');
    expect(saved).toEqual([daemonCopy({ ...DEFAULT_PREFS, outfit: 'visor' }, 7_000)]);
    stop();
  });

  it('sends each change once, 300 ms after the last, and never a copy the daemon already holds', async () => {
    vi.useFakeTimers();
    const { api, saved } = fakeApi({ prefs: daemonCopy(DEFAULT_PREFS, 1_000) });
    const store = createStore();
    const stop = startPrefsSync(api, store, { win: null });
    await settle();
    expect(saved).toHaveLength(0);
    store.patch('prefs', { volume: 0.2 });
    vi.advanceTimersByTime(100);
    store.patch('prefs', { volume: 0.3 });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
    expect(saved).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(saved).toEqual([daemonCopy({ ...DEFAULT_PREFS, volume: 0.3 }, Date.now())]);
    store.patch('prefs', { volume: 0.3 });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(saved).toHaveLength(1);
    stop();
  });

  it('never sends notifications: the permission to show them belongs to the origin', async () => {
    vi.useFakeTimers();
    const { api, saved } = fakeApi({ prefs: null });
    const store = createStore({ ...DEFAULT_PREFS, notifications: true });
    const stop = startPrefsSync(api, store, { win: null });
    await settle();
    expect(saved).toHaveLength(1);
    expect(saved[0]).not.toHaveProperty('notifications');
    // Turning them off changes nothing the daemon keeps.
    store.patch('prefs', { notifications: false });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(saved).toHaveLength(1);
    stop();
  });

  it('keeps the time of the copy when only notifications change, so a newer daemon copy still wins later', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    const s = originWith({ ...DEFAULT_PREFS, outfit: 'none' }, 1_000);
    const store = createStore(loadPrefs(s));
    const stopLocal = watchPrefs(store, { storage: s, root: null, win: null });
    const stop = startPrefsSync(
      fakeApi({ prefs: daemonCopy({ ...DEFAULT_PREFS, outfit: 'none' }, 1_000) }).api,
      store,
      {
        win: null,
      },
    );
    await settle();
    // Only this origin's switch changes: the copy keeps its time.
    store.patch('prefs', { notifications: true });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(JSON.parse(s.getItem(PREFS_KEY) ?? '{}')).toMatchObject({ notifications: true, saved_at: 1_000 });
    stop();
    stopLocal();
    // Another origin changed the outfit at 2_000: at the next start its copy wins, and nothing older is sent.
    const next = createStore(loadPrefs(s));
    const { api, saved } = fakeApi({ prefs: daemonCopy({ ...DEFAULT_PREFS, outfit: 'witch' }, 2_000) });
    const stopNext = startPrefsSync(api, next, { win: null });
    await settle();
    expect(next.select('prefs')).toMatchObject({ outfit: 'witch', notifications: true });
    expect(saved).toHaveLength(0);
    stopNext();
  });

  it('never takes notifications from the daemon copy, either way', async () => {
    for (const here of [true, false]) {
      const store = createStore({ ...DEFAULT_PREFS, notifications: here });
      const { api } = fakeApi({ prefs: { ...daemonCopy(DEFAULT_PREFS, 1_000), notifications: !here, volume: 0.7 } });
      const stop = startPrefsSync(api, store, { win: null });
      await settle();
      expect(store.select('prefs')).toMatchObject({ notifications: here, volume: 0.7 });
      stop();
    }
  });

  it('keeps the copy of this origin when it is newer, and sends it with its time', async () => {
    const local = { ...DEFAULT_PREFS, volume: 0.5, positions: { a: { x: 1, y: 2 } } };
    const store = createStore(loadPrefs(originWith(local, 2_000)));
    const { api, saved } = fakeApi({ prefs: daemonCopy({ ...DEFAULT_PREFS, volume: 0.9, outfit: 'witch' }, 1_000) });
    const stop = startPrefsSync(api, store, { win: null });
    await settle();
    expect(store.select('prefs')).toEqual(local);
    expect(saved).toEqual([daemonCopy(local, 2_000)]);
    stop();
  });

  it('takes the daemon copy when it is newer, and this origin saves it with the same time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_000);
    const s = originWith({ ...DEFAULT_PREFS, volume: 0.5 }, 1_000);
    const store = createStore(loadPrefs(s));
    const stopLocal = watchPrefs(store, { storage: s, root: null, win: null });
    const theirs = { ...DEFAULT_PREFS, volume: 0.9, outfit: 'witch' as const };
    const { api, saved } = fakeApi({ prefs: daemonCopy(theirs, 2_000) });
    const stop = startPrefsSync(api, store, { win: null });
    await settle();
    expect(store.select('prefs')).toEqual(theirs);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(JSON.parse(s.getItem(PREFS_KEY) ?? '{}')).toEqual({ ...theirs, saved_at: 2_000 });
    expect(saved).toHaveLength(0); // the daemon holds it already
    stop();
    stopLocal();
  });

  it('keeps the copy of this origin at equal times: the daemon copy may lack the first placed positions', async () => {
    const local = { ...DEFAULT_PREFS, positions: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } } };
    const store = createStore(loadPrefs(originWith(local, 1_500)));
    const { api } = fakeApi({ prefs: daemonCopy({ ...local, positions: { b: { x: 3, y: 4 } } }, 1_500) });
    const stop = startPrefsSync(api, store, { win: null });
    await settle();
    expect(store.select('prefs')).toEqual(local);
    stop();
  });

  it('takes the daemon copy for a store started without preferences, whatever another such store saved', async () => {
    // Both stores start from the one defaults object; the time one saved it with is not the other's.
    const other = createStore();
    const stopOther = startPrefsSync(fakeApi({ prefs: null }).api, other, { win: null });
    await settle(); // it sent the defaults it holds, with the time of that first save
    stopOther();
    const store = createStore();
    const { api } = fakeApi({ prefs: daemonCopy({ ...DEFAULT_PREFS, volume: 0.9 }, 1_000) });
    const stop = startPrefsSync(api, store, { win: null });
    await settle();
    expect(store.select('prefs').volume).toBe(0.9);
    stop();
  });

  it('takes the daemon copy on a new origin, whose storage holds no copy', async () => {
    const store = createStore(loadPrefs(new MemoryStorage()));
    const theirs = { ...DEFAULT_PREFS, volume: 0.9, outfit: 'witch' as const, positions: { g: { x: 5, y: 6 } } };
    const { api, saved } = fakeApi({ prefs: daemonCopy(theirs, 1_000) });
    const stop = startPrefsSync(api, store, { win: null });
    await settle();
    expect(store.select('prefs')).toEqual(theirs);
    expect(saved).toHaveLength(0);
    stop();
  });

  it('ignores every failure and never throws', async () => {
    vi.useFakeTimers();
    const store = createStore();
    const api: PrefsApi = {
      uiPrefs: vi.fn(async () => ({ prefs: null })),
      saveUiPrefs: vi.fn(() => Promise.reject(new Error('offline'))),
    };
    const stop = startPrefsSync(api, store, { win: null });
    await settle();
    expect(api.saveUiPrefs).toHaveBeenCalledOnce();
    // The failed copy is not taken as held: the same preferences are sent again with the next change.
    store.patch('prefs', {});
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(api.saveUiPrefs).toHaveBeenCalledTimes(2);
    stop();

    const throwing: PrefsApi = {
      uiPrefs: () => {
        throw new Error('no transport');
      },
      saveUiPrefs: () => {
        throw new Error('no transport');
      },
    };
    let stop2: () => void = () => undefined;
    expect(() => {
      stop2 = startPrefsSync(throwing, createStore(), { win: null });
    }).not.toThrow();
    await settle();
    expect(() => stop2()).not.toThrow();
  });

  it('tries a failed read again at the next change and when the connection comes back', async () => {
    vi.useFakeTimers();
    const { api, saved } = fakeApi(new Error('offline'), { prefs: { ...DEFAULT_PREFS, muted: true } });
    const store = createStore();
    const stop = startPrefsSync(api, store, { win: null });
    await settle();
    store.patch('prefs', { volume: 0.4 });
    expect(api.uiPrefs).toHaveBeenCalledTimes(2);
    await settle();
    expect(store.select('prefs')).toMatchObject({ muted: true, volume: 0.4 });
    expect(saved).toEqual([daemonCopy({ ...DEFAULT_PREFS, muted: true, volume: 0.4 }, Date.now())]);
    stop();

    const again = fakeApi(new Error('offline'), { prefs: { ...DEFAULT_PREFS, outfit: 'winter' } });
    const store2 = createStore();
    const stop2 = startPrefsSync(again.api, store2, { win: null });
    await settle();
    expect(again.saved).toHaveLength(0);
    store2.patch('system', { connection: 'live' });
    await settle();
    expect(again.api.uiPrefs).toHaveBeenCalledTimes(2);
    expect(store2.select('prefs').outfit).toBe('winter');
    stop2();
  });

  it('sends a failed save again once when the connection comes back', async () => {
    const { api } = fakeApi({ prefs: null });
    api.saveUiPrefs.mockRejectedValueOnce(new Error('offline'));
    const store = createStore();
    const stop = startPrefsSync(api, store, { win: null });
    await settle();
    expect(api.saveUiPrefs).toHaveBeenCalledOnce();
    store.patch('system', { connection: 'live' });
    await settle();
    expect(api.saveUiPrefs).toHaveBeenCalledTimes(2);
    // That one arrived: coming back again sends nothing more.
    store.patch('system', { connection: 'reconnecting' });
    store.patch('system', { connection: 'live' });
    await settle();
    expect(api.saveUiPrefs).toHaveBeenCalledTimes(2);
    stop();
  });

  it('sends a pending change when the page hides (with keepalive) or when stopped, then stops listening', async () => {
    vi.useFakeTimers();
    const { api, saved } = fakeApi({ prefs: daemonCopy(DEFAULT_PREFS, 1_000) });
    const win = new EventTarget() as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;
    const store = createStore();
    const stop = startPrefsSync(api, store, { win });
    await settle();
    store.patch('prefs', { outfit: 'winter' });
    (win as unknown as EventTarget).dispatchEvent(new Event('pagehide'));
    expect(saved.at(-1)?.outfit).toBe('winter');
    // The closing page would cancel a plain request; this one outlives it.
    expect(api.saveUiPrefs.mock.calls.at(-1)?.[1]).toEqual({ keepalive: true });
    store.patch('prefs', { outfit: 'witch' });
    stop();
    expect(saved.at(-1)?.outfit).toBe('witch');
    expect(api.saveUiPrefs.mock.calls.at(-1)?.[1]).toBeUndefined();
    const sent = saved.length;
    store.patch('prefs', { outfit: 'visor' });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 2);
    expect(saved).toHaveLength(sent);
  });

  it('leaves the store alone when the answer comes after it stopped', async () => {
    const answer = deferred<PrefsAnswer>();
    const { api } = fakeApi(answer.promise);
    const store = createStore();
    startPrefsSync(api, store, { win: null })();
    answer.resolve({ prefs: { ...DEFAULT_PREFS, muted: true } });
    await settle();
    expect(store.select('prefs').muted).toBe(false);
    expect(api.saveUiPrefs).not.toHaveBeenCalled();
  });
});

describe('overlayPrefs and prefsForDaemon', () => {
  it('takes only valid fields, keeps the ones named, and ignores anything not an object', () => {
    const base = { ...DEFAULT_PREFS, volume: 0.5, positions: { a: { x: 1, y: 2 } } };
    expect(overlayPrefs(base, null)).toBe(base);
    expect(overlayPrefs(base, [1, 2])).toBe(base);
    expect(overlayPrefs(base, { volume: 7, motion: 'reduce', positions: 'everywhere' })).toEqual({
      ...base,
      motion: 'reduce',
    });
    expect(overlayPrefs(base, { volume: 0.1, muted: true }, new Set(['volume']))).toEqual({ ...base, muted: true });
    const hostile = JSON.parse(
      '{"__proto__":{"muted":true},"positions":{"__proto__":{"x":1,"y":1},"b":{"x":3,"y":4}}}',
    );
    const out = overlayPrefs(base, hostile);
    expect(out).toEqual({ ...base, positions: { b: { x: 3, y: 4 } } });
    expect(Object.getPrototypeOf(out.positions)).toBe(Object.prototype);
  });

  it('sends the clean values but notifications, with their time, within the limit of the daemon', () => {
    expect(prefsForDaemon({ ...DEFAULT_PREFS, volume: 99, notifications: true }, 7)).toEqual(
      daemonCopy(DEFAULT_PREFS, 7),
    );
    const at = 1_792_000_000_123;
    const positions: Prefs['positions'] = {};
    for (let i = 0; i < MAX_POSITIONS; i++)
      positions[`task_${String(i).padStart(26, '0')}`] = { x: i + 0.123456789012, y: -i - 0.98765432101 };
    const prefs = { ...DEFAULT_PREFS, muted: true, positions };
    expect(JSON.stringify({ prefs }).length).toBeGreaterThan(SYNC_MAX_BYTES);
    // Leaving out the first placed positions.
    const out = prefsForDaemon(prefs, at);
    expect(JSON.stringify({ prefs: out }).length).toBeLessThanOrEqual(SYNC_MAX_BYTES);
    expect(out).toMatchObject({ muted: true, saved_at: at });
    const kept = Object.keys(out.positions);
    expect(kept.length).toBeGreaterThan(100);
    expect(kept).toEqual(Object.keys(positions).slice(-kept.length));
    const small = prefsForDaemon(prefs, at, 2000);
    expect(JSON.stringify({ prefs: small }).length).toBeLessThanOrEqual(2000);
    expect(small).toEqual({
      ...daemonCopy(prefs, at),
      positions: Object.fromEntries(Object.entries(positions).slice(-Object.keys(small.positions).length)),
    });
  });
});
