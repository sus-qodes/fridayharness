/**
 * The browser's UI session (plan FD-05, §6.8): exchanged once from a one-time login code that
 * arrives in the URL fragment, and kept in this tab's `sessionStorage` only, so a reload or a
 * discarded tab stays signed in. Tabs never share tokens: no channel, no `localStorage`, no cookie.
 * Another tab signs in with its own link.
 */
import type { UiSession } from '@friday/protocol';
import { ApiError, errorFrom, OfflineError } from './transport.js';

const STORAGE_KEY = 'friday.ui.session';
/** A login code as the daemon mints it (32 random bytes, base64url). */
const CODE = /^[A-Za-z0-9_-]{16,128}$/;

export interface StoredSession {
  token: string;
  expires_at: string;
  project_id: string;
}

function isSession(v: unknown): v is StoredSession {
  const s = v as StoredSession | null;
  return (
    !!s &&
    typeof s.token === 'string' &&
    s.token.length > 0 &&
    s.token.length <= 4096 &&
    typeof s.expires_at === 'string' &&
    typeof s.project_id === 'string' &&
    s.project_id.length > 0 &&
    s.project_id.length <= 200
  );
}

function expired(s: StoredSession, now: number): boolean {
  const t = Date.parse(s.expires_at);
  return !Number.isNaN(t) && t <= now;
}

export function readSession(
  storage: Storage | undefined = safeSessionStorage(),
  now = Date.now(),
): StoredSession | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (!isSession(v) || expired(v, now)) {
      storage?.removeItem(STORAGE_KEY);
      return null;
    }
    return { token: v.token, expires_at: v.expires_at, project_id: v.project_id };
  } catch {
    return null;
  }
}

export function writeSession(s: StoredSession, storage: Storage | undefined = safeSessionStorage()): void {
  try {
    storage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ token: s.token, expires_at: s.expires_at, project_id: s.project_id }),
    );
  } catch {
    // Storage may be blocked (private mode); the session then lives in memory for this page only.
  }
}

export function clearSession(storage: Storage | undefined = safeSessionStorage()): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // nothing stored
  }
}

function safeSessionStorage(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Reads `#code=…` from the address and removes the fragment at once, before anything else happens
 * (the exchange included), so the code is never kept, shown, bookmarked or shared. Returns null
 * when there is no code or it does not look like one.
 */
export function takeLoginCode(
  loc: Pick<Location, 'hash' | 'pathname' | 'search'> = location,
  hist: Pick<History, 'replaceState'> = history,
): string | null {
  const hash = loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash;
  if (!hash) return null;
  let code: string | null;
  try {
    code = new URLSearchParams(hash).get('code');
  } catch {
    code = null;
  }
  if (code === null) return null;
  try {
    hist.replaceState(null, '', `${loc.pathname}${loc.search}`);
  } catch {
    // An address that cannot be rewritten still works; the code is single use.
  }
  return CODE.test(code) ? code : null;
}

/** Exchanges a login code for a UI session on the daemon this page came from (JSON, own origin). */
export async function exchangeCode(
  code: string,
  origin: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<StoredSession> {
  let res: Response;
  try {
    res = await fetchImpl(`${origin}/ui/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
  } catch (e) {
    throw new OfflineError((e as Error).message);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw errorFrom(res.status, data);
  const s = data as UiSession | null;
  const session = { token: s?.token, expires_at: s?.expires_at, project_id: s?.project_id };
  if (!isSession(session)) {
    throw new ApiError(
      res.status,
      `HTTP-${res.status}`,
      'invalid_response',
      'Friday answered the sign-in with something unexpected',
    );
  }
  return session;
}
