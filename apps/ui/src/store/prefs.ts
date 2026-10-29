/**
 * Preferences in `localStorage` (plan §6.8): read as untrusted input, since anything on this
 * origin may have written there (every field is checked; a wrong type or an out-of-range value
 * gives the default), written back after changes (debounced), and never holding anything secret.
 * The mute switch lives under its own key, `friday.audio.muted` (plan §7.10). Every storage call
 * is wrapped: a blocked or full storage leaves the defaults and the page working.
 *
 * `localStorage` belongs to an origin, and the browser's origin changes with Friday's port at every
 * start, so the daemon keeps the project's copy too (`startPrefsSync`), read as untrusted the same way.
 * Each copy records when it was saved (`saved_at`, ms), and the newer wins. Notifications stay with
 * the origin: a browser's permission to show them belongs to it.
 */
import { DEFAULT_PREFS, type FridayStore, type Prefs } from './state.js';

export const PREFS_KEY = 'friday.prefs';
export const MUTED_KEY = 'friday.audio.muted';
export const SAVE_DEBOUNCE_MS = 300;
export const MAX_POSITIONS = 2000;
/** What is sent to the daemon stays under this; it refuses more than 64 KB. */
export const SYNC_MAX_BYTES = 60_000;
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A copy's `saved_at` (ms since the epoch): a finite number, not negative; null otherwise. */
function parseSavedAt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** When each copy `loadPrefs` read was saved. */
const READ_AT = new WeakMap<Prefs, number>();
/**
 * Per store, the preferences it holds and when they were saved: read with their copy, or at their
 * first save. The local copy and the daemon's thus carry the same time for the same preferences.
 * Kept per store, not per object: stores started without preferences share the defaults' object.
 */
const SAVED = new WeakMap<FridayStore, { prefs: Prefs; values: string; at: number }>();

/**
 * The values whose change makes a new copy: all but `notifications`, which only this origin keeps.
 * A change of it alone keeps the copy's time, or this copy would beat a newer one of the daemon's
 * with values older than it.
 */
function syncedValues(prefs: Prefs): string {
  const { notifications: _origin, ...values } = prefs;
  return JSON.stringify(values);
}

function remember(store: FridayStore, at: number): void {
  const prefs = store.select('prefs');
  SAVED.set(store, { prefs, values: syncedValues(prefs), at });
}

/** When the preferences the store holds were saved; undefined when they never were. */
function savedAtOf(store: FridayStore): number | undefined {
  const prefs = store.select('prefs');
  const saved = SAVED.get(store);
  if (saved && (saved.prefs === prefs || saved.values === syncedValues(prefs))) return saved.at;
  return READ_AT.get(prefs);
}

/** The time to save the store's preferences with: when they were saved, else now (a new copy). */
function stampOf(store: FridayStore): number {
  const at = savedAtOf(store) ?? Date.now();
  remember(store, at);
  return at;
}

/** Records the time of the copy the store started from, before anything changes it. */
function rememberRead(store: FridayStore): void {
  const at = READ_AT.get(store.select('prefs'));
  if (at !== undefined && !SAVED.has(store)) remember(store, at);
}

/** Puts `prefs` in the store with the time it was saved, so saving it again writes an equal copy. */
function adopt(store: FridayStore, prefs: Prefs, at = READ_AT.get(prefs)): void {
  store.patch('prefs', prefs);
  if (at !== undefined) remember(store, at);
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
  const prefs = parsePrefs(raw, muted);
  const at = isRecord(raw) ? parseSavedAt(raw.saved_at) : null;
  if (at !== null) READ_AT.set(prefs, at);
  return prefs;
}

/**
 * Writes the preferences with the time they were saved (by default: when the copy `loadPrefs` read
 * them from was, else now); false when the storage refused (blocked, full).
 */
export function savePrefs(
  prefs: Prefs,
  storage: Storage | null | undefined = safeLocalStorage(),
  savedAt = READ_AT.get(prefs) ?? Date.now(),
): boolean {
  if (!storage) return false;
  try {
    const clean = parsePrefs(prefs, String(prefs.muted));
    storage.setItem(PREFS_KEY, JSON.stringify({ ...clean, saved_at: savedAt }));
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
  rememberRead(store);

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    savePrefs(store.select('prefs'), storage, stampOf(store));
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
  // The desktop's two windows (and a browser's tabs) share one storage: take what another saved.
  // Writing an equal value fires no event, so the windows do not echo each other (review M9i); the
  // copy taken keeps its time for that.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== PREFS_KEY && e.key !== MUTED_KEY) return;
    if (timer) return; // a change of this window waits to be saved; it wins
    adopt(store, loadPrefs(storage));
  };
  win?.addEventListener('storage', onStorage as EventListener);

  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    win?.removeEventListener('pagehide', onHide);
    win?.removeEventListener('storage', onStorage as EventListener);
    if (timer) flush();
  };
}

// ---------------------------------------------------------------------------------------------
// The daemon's copy

const PREF_FIELDS = Object.keys(DEFAULT_PREFS) as (keyof Prefs)[];
/**
 * Kept by the origin only, never sent nor taken: a browser's permission to notify belongs to the
 * origin, which is new at every start (the desktop app keeps its own the same way).
 */
const LOCAL_ONLY: ReadonlySet<keyof Prefs> = new Set(['notifications']);
const SYNCED_FIELDS = PREF_FIELDS.filter((key) => !LOCAL_ONLY.has(key));

/** The daemon's copy: the preferences but those kept by the origin, with the time they were saved. */
export type DaemonPrefs = Omit<Prefs, 'notifications'> & { saved_at: number };

/** A copy's values as text, without its time: copies of the same values compare equal. */
function valuesText(copy: object): string {
  return JSON.stringify({ ...copy, saved_at: undefined });
}

/**
 * `base` with every field `raw` holds a valid value for taken from `raw` (positions as a whole),
 * except the fields in `keep`. A field missing or wrong in `raw` stays as it was.
 */
export function overlayPrefs(base: Prefs, raw: unknown, keep: ReadonlySet<keyof Prefs> = new Set()): Prefs {
  if (!isRecord(raw)) return base;
  const parsed = parsePrefs(raw);
  const out: Prefs = { ...base };
  for (const key of PREF_FIELDS) {
    if (keep.has(key) || raw[key] === undefined) continue;
    const valid = key === 'positions' ? isRecord(raw.positions) : parsed[key] === raw[key];
    if (valid) Object.assign(out, { [key]: parsed[key] });
  }
  return out;
}

/**
 * The preferences as sent to the daemon: the clean values but those kept by the origin, with the
 * time they were saved, within `maxBytes`. When there are too many hand-placed positions to fit,
 * the first placed are left out of the daemon's copy.
 */
export function prefsForDaemon(prefs: Prefs, savedAt: number, maxBytes = SYNC_MAX_BYTES): DaemonPrefs {
  const { notifications: _local, ...values } = parsePrefs(prefs, String(prefs.muted));
  const clean: DaemonPrefs = { ...values, saved_at: savedAt };
  // Every value is ASCII (ids are checked; numbers, switches and options are), so length is bytes.
  const size = (v: unknown) => JSON.stringify(v).length;
  if (size({ prefs: clean }) <= maxBytes) return clean;
  const entries = Object.entries(clean.positions);
  let budget = maxBytes - size({ prefs: { ...clean, positions: {} } });
  let first = entries.length;
  for (; first > 0; first--) {
    const entry = entries[first - 1];
    if (!entry) break;
    const cost = size(entry[0]) + size(entry[1]) + 2; // with its colon and comma
    if (cost > budget) break;
    budget -= cost;
  }
  return { ...clean, positions: Object.fromEntries(entries.slice(first)) };
}

/** What `startPrefsSync` needs of the API client. */
export interface PrefsApi {
  uiPrefs(): Promise<{ prefs: Record<string, unknown> | null }>;
  /** `keepalive` only for the copy sent as the page hides, which must outlive the page. */
  saveUiPrefs(prefs: DaemonPrefs, opts?: { keepalive?: boolean }): Promise<unknown>;
}

export interface SyncOptions {
  debounceMs?: number;
  /** Where `pagehide` is listened for, to send a change made just before the page closes. */
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
}

/**
 * Keeps the daemon's copy of the preferences, which every start of Friday finds whatever its port
 * (plan §6 rule 8). At start it reads that copy, and when it was saved after this origin's (the one
 * `loadPrefs` read, which the store must start from; none counts as the oldest) lays its valid
 * fields over the page's, except a field changed here meanwhile. Otherwise this origin's copy is
 * sent to the daemon, at equal times too: only this one holds every position. `notifications` is
 * never sent nor taken. After that every change is sent too (debounced, beside the local save and
 * with its time); the one sent as the page hides goes with `keepalive`, so the closing page does
 * not cancel it. Nothing is sent before the daemon's copy was read, so a page on a new origin never
 * overwrites it with defaults; a read or a save that failed is tried again at the next change and
 * when the connection comes back. Failures are otherwise ignored, and nothing here throws. Returns
 * the function that stops it, sending anything still pending.
 */
export function startPrefsSync(api: PrefsApi, store: FridayStore, opts: SyncOptions = {}): () => void {
  const debounceMs = opts.debounceMs ?? SAVE_DEBOUNCE_MS;
  const win = opts.win === undefined ? (typeof window === 'undefined' ? null : window) : opts.win;
  rememberRead(store);
  /** When this origin's copy was saved; without one it is older than any the daemon holds. */
  const localAt = savedAtOf(store) ?? Number.NEGATIVE_INFINITY;
  let phase: 'reading' | 'failed' | 'read' = 'reading';
  let stopped = false;
  let applying = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The values the daemon holds as far as this page knows; an equal copy is not sent again. */
  let held: string | null = null;
  /** Fields changed here before the daemon's copy arrived: this page's value wins for them. */
  const changed = new Set<keyof Prefs>();

  const send = (keepalive = false): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    const prefs = prefsForDaemon(store.select('prefs'), stampOf(store));
    const text = valuesText(prefs);
    if (text === held) return;
    held = text;
    // Unknown now what the daemon holds: the next change is sent whatever it is.
    const forget = () => {
      if (held === text) held = null;
    };
    try {
      // `keepalive` lets the request outlive the page; it allows 64 KB in flight, the copy is less.
      api.saveUiPrefs(prefs, keepalive ? { keepalive } : undefined).catch(forget);
    } catch {
      forget();
    }
  };

  const apply = (raw: unknown): void => {
    if (!isRecord(raw)) return; // none yet: this page's copy becomes the first
    held = valuesText(raw);
    // At equal times this origin's copy wins too: the daemon's may lack the first placed positions.
    // A copy there without a time is older than any with one, and newer than none here.
    const at = parseSavedAt(raw.saved_at) ?? 0;
    if (at <= localAt) return; // this origin's copy is the newer: it is sent instead
    const current = store.select('prefs');
    const next = overlayPrefs(current, raw, new Set([...LOCAL_ONLY, ...changed]));
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    applying = true;
    try {
      // Saved here with the daemon copy's time, unless a change made meanwhile makes a new copy.
      adopt(store, next, changed.size === 0 ? at : undefined);
    } finally {
      applying = false;
    }
  };

  const read = (): void => {
    phase = 'reading';
    let answer: Promise<{ prefs: Record<string, unknown> | null }>;
    try {
      answer = api.uiPrefs();
    } catch (e) {
      answer = Promise.reject(e);
    }
    answer
      .then(
        (r) => {
          if (stopped) return;
          try {
            apply(r?.prefs);
          } finally {
            phase = 'read';
            changed.clear();
          }
          send(); // the first copy, this origin's newer one, or the fields changed here while reading
        },
        () => {
          if (!stopped) phase = 'failed';
        },
      )
      .catch(() => undefined);
  };

  const unsubscribe = store.subscribe('prefs', (next, prev) => {
    if (applying) return;
    if (phase !== 'read') {
      for (const key of SYNCED_FIELDS) if (next[key] !== prev[key]) changed.add(key);
      if (phase === 'failed') read();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => send(), debounceMs);
  });
  const unwatch = store.subscribe('system', (next, prev) => {
    if (next.connection !== 'live' || prev.connection === 'live') return;
    if (phase === 'failed') read();
    else if (phase === 'read' && held === null) send(); // only a failed save leaves nothing held: once more
  });
  const onHide = () => {
    if (timer) send(true);
  };
  win?.addEventListener('pagehide', onHide);
  read();

  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    unwatch();
    win?.removeEventListener('pagehide', onHide);
    if (timer) send();
  };
}
