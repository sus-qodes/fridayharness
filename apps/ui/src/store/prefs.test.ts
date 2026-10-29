import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyMotion,
  loadPrefs,
  MAX_POSITIONS,
  MUTED_KEY,
  PREFS_KEY,
  parseMuted,
  parsePositions,
  parsePrefs,
  SAVE_DEBOUNCE_MS,
  savePrefs,
  watchPrefs,
} from './prefs.js';
import { createStore, DEFAULT_PREFS } from './state.js';

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
