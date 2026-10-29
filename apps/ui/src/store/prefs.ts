/**
 * Preferences in `localStorage` (plan §6.8): read as untrusted input, since anything on this
 * origin may have written there (every field is checked; a wrong type or an out-of-range value
 * gives the default), written back after changes (debounced), and never holding anything secret.
 * The mute switch lives under its own key, `friday.audio.muted` (plan §7.10). Every storage call
 * is wrapped: a blocked or full storage leaves the defaults and the page working.
 */
import { DEFAULT_PREFS, type FridayStore, type Prefs } from './state.js';

export const PREFS_KEY = 'friday.prefs';
export const MUTED_KEY = 'friday.audio.muted';
export const SAVE_DEBOUNCE_MS = 300;
export const MAX_POSITIONS = 2000;
/** Node positions further out than this are someone else's numbers, not a drag. */
const MAX_COORDINATE = 1_000_000;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export const PREF_LIMITS = {
  volume: { min: 0, max: 1 },
  notchAutoCollapseS: { min: 1, max: 120 },
  notchHideS: { min: 5, max: 600 },
  terminalHeight: { min: 300, max: 600 },
} as const;

const MOTIONS: readonly Prefs['motion'][] = ['system', 'reduce', 'full'];
const OUTFITS: readonly Prefs['outfit'][] = ['none', 'headphones', 'visor', 'winter', 'witch', 'sunglasses'];

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function num(v: unknown, limits: { min: number; max: number }, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= limits.min && v <= limits.max ? v : fallback;
}

function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;
}

function coordinate(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE;
}

/** Hand-placed node positions: ids that look like ids, finite numbers, at most 2000 entries. */
export function parsePositions(v: unknown): Prefs['positions'] {
  const out: Prefs['positions'] = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  let n = 0;
  for (const [id, pos] of Object.entries(v as Record<string, unknown>)) {
    if (n >= MAX_POSITIONS) break;
    if (FORBIDDEN_KEYS.has(id) || !ID.test(id)) continue;
    if (!pos || typeof pos !== 'object') continue;
    const { x, y } = pos as { x?: unknown; y?: unknown };
    if (!coordinate(x) || !coordinate(y)) continue;
    out[id] = { x, y };
    n++;
  }
  return out;
}

/** The muted switch from its own key: `true`/`false` (or `1`/`0`); null when absent or unreadable. */
export function parseMuted(raw: unknown): boolean | null {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return null;
}

/** Preferences from untrusted values; anything wrong takes the default. */
export function parsePrefs(raw: unknown, mutedRaw: unknown = null): Prefs {
  const d = DEFAULT_PREFS;
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    muted: parseMuted(mutedRaw) ?? bool(v.muted, d.muted),
    volume: num(v.volume, PREF_LIMITS.volume, d.volume),
    motion: oneOf(v.motion, MOTIONS, d.motion),
    outfit: oneOf(v.outfit, OUTFITS, d.outfit),
    showFinished: bool(v.showFinished, d.showFinished),
    notchAutoCollapseS: num(v.notchAutoCollapseS, PREF_LIMITS.notchAutoCollapseS, d.notchAutoCollapseS),
    notchHideS: num(v.notchHideS, PREF_LIMITS.notchHideS, d.notchHideS),
    notifications: bool(v.notifications, d.notifications),
    positions: parsePositions(v.positions),
    gettingStartedDismissed: bool(v.gettingStartedDismissed, d.gettingStartedDismissed),
    terminalHeight: num(v.terminalHeight, PREF_LIMITS.terminalHeight, d.terminalHeight),
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadPrefs(storage: Storage | null | undefined = safeLocalStorage()): Prefs {
  let raw: unknown = null;
  let muted: unknown = null;
  try {
    const text = storage?.getItem(PREFS_KEY);
    if (text && text.length <= 1_000_000) raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  try {
    muted = storage?.getItem(MUTED_KEY) ?? null;
  } catch {
    muted = null;
  }
  return parsePrefs(raw, muted);
}

/** Writes the preferences; false when the storage refused (blocked, full). */
export function savePrefs(prefs: Prefs, storage: Storage | null | undefined = safeLocalStorage()): boolean {
  if (!storage) return false;
  try {
    const clean = parsePrefs(prefs, String(prefs.muted));
    storage.setItem(PREFS_KEY, JSON.stringify(clean));
    storage.setItem(MUTED_KEY, clean.muted ? 'true' : 'false');
    return true;
  } catch {
    return false;
  }
}

/** The motion preference on the root element: `reduce-motion` for "reduce", `motion-on` for "full". */
export function applyMotion(motion: Prefs['motion'], root: HTMLElement | null | undefined): void {
  if (!root) return;
  root.classList.toggle('reduce-motion', motion === 'reduce');
  root.classList.toggle('motion-on', motion === 'full');
}

export interface WatchOptions {
  storage?: Storage | null;
  debounceMs?: number;
  root?: HTMLElement | null;
  /** Where `pagehide` is listened for, to save a change made just before the page closes. */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
}

/**
 * Saves the preferences after every change (debounced 300 ms, and at once when the page hides)
 * and keeps the motion preference applied to the document. Returns the function that stops it,
 * saving anything still pending.
 */
export function watchPrefs(store: FridayStore, opts: WatchOptions = {}): () => void {
  const storage = opts.storage === undefined ? safeLocalStorage() : opts.storage;
  const debounceMs = opts.debounceMs ?? SAVE_DEBOUNCE_MS;
  const root =
    opts.root === undefined ? (typeof document === 'undefined' ? null : document.documentElement) : opts.root;
  const win = opts.win === undefined ? (typeof window === 'undefined' ? null : window) : opts.win;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    savePrefs(store.select('prefs'), storage);
  };

  applyMotion(store.select('prefs').motion, root);
  const unsubscribe = store.subscribe('prefs', (next, prev) => {
    if (next.motion !== prev.motion) applyMotion(next.motion, root);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });
  const onHide = () => {
    if (timer) flush();
  };
  win?.addEventListener('pagehide', onHide);

  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    win?.removeEventListener('pagehide', onHide);
    if (timer) flush();
  };
}
