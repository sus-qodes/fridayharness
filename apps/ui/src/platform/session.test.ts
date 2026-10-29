import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession, exchangeCode, readSession, takeLoginCode, writeSession } from './session.js';
import { ApiError, AuthError, OfflineError } from './transport.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-10-17T10:00:00Z');
const KEY = 'friday.ui.session';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(name) && !name.endsWith('.test.ts') ? [full] : [];
  });
}

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

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
} as unknown as Storage;

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('takeLoginCode (FD-05)', () => {
  it('clears the fragment and returns a well-formed code', () => {
    const replaceState = vi.fn();
    const code = takeLoginCode(
      { hash: '#code=abcDEF0123456789_-xyz', pathname: '/ui/n/', search: '?a=1' },
      { replaceState },
    );
    expect(code).toBe('abcDEF0123456789_-xyz');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/ui/n/?a=1');
  });

  it('clears a malformed code too, and returns null for it', () => {
    const replaceState = vi.fn();
    expect(
      takeLoginCode({ hash: '#code=<img src=x onerror=alert(1)>', pathname: '/ui/', search: '' }, { replaceState }),
    ).toBeNull();
    expect(replaceState).toHaveBeenCalledOnce();
    expect(takeLoginCode({ hash: '#code=short', pathname: '/ui/', search: '' }, { replaceState })).toBeNull();
    expect(
      takeLoginCode({ hash: `#code=${'a'.repeat(5000)}`, pathname: '/ui/', search: '' }, { replaceState }),
    ).toBeNull();
    expect(
      takeLoginCode({ hash: '#code=abc‮defghijklmnopq', pathname: '/ui/', search: '' }, { replaceState }),
    ).toBeNull();
  });

  it('leaves the address alone without a code', () => {
    const replaceState = vi.fn();
    expect(takeLoginCode({ hash: '', pathname: '/ui/', search: '' }, { replaceState })).toBeNull();
    expect(takeLoginCode({ hash: '#tab=x', pathname: '/ui/', search: '' }, { replaceState })).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('still returns the code when the address cannot be rewritten', () => {
    const replaceState = vi.fn(() => {
      throw new Error('SecurityError');
    });
    expect(takeLoginCode({ hash: '#code=abcdefghijklmnop', pathname: '/', search: '' }, { replaceState })).toBe(
      'abcdefghijklmnop',
    );
  });
});

describe('the stored session (§6.8)', () => {
  it('lives in session storage until it expires', () => {
    writeSession({ token: 't', expires_at: '2026-10-17T11:00:00Z', project_id: 'p' }, sessionStorage);
    expect(readSession(sessionStorage, NOW)?.token).toBe('t');
    expect(localStorage.length).toBe(0);
    expect(readSession(sessionStorage, Date.parse('2026-10-17T12:00:00Z'))).toBeNull();
    // An expired one is removed.
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('refuses stored values of the wrong shape and removes them', () => {
    const s = new MemoryStorage();
    for (const raw of [
      'not json',
      '[]',
      '{"token":5,"expires_at":"x","project_id":"p"}',
      '{"token":"","expires_at":"x","project_id":"p"}',
      `{"token":"${'t'.repeat(5000)}","expires_at":"x","project_id":"p"}`,
      '{"token":"t","expires_at":"x","project_id":""}',
    ]) {
      s.setItem(KEY, raw);
      expect(readSession(s, NOW)).toBeNull();
    }
  });

  it('keeps only the known fields', () => {
    const s = new MemoryStorage();
    s.setItem(KEY, JSON.stringify({ token: 't', expires_at: '2099-01-01T00:00:00Z', project_id: 'p', extra: '<b>' }));
    expect(readSession(s, NOW)).toEqual({ token: 't', expires_at: '2099-01-01T00:00:00Z', project_id: 'p' });
  });

  it('survives a storage that throws', () => {
    expect(() => writeSession({ token: 't', expires_at: 'x', project_id: 'p' }, throwing)).not.toThrow();
    expect(readSession(throwing, NOW)).toBeNull();
    expect(() => clearSession(throwing)).not.toThrow();
  });

  it('clears the session', () => {
    writeSession({ token: 't', expires_at: '2099-01-01T00:00:00Z', project_id: 'p' }, sessionStorage);
    clearSession(sessionStorage);
    expect(readSession(sessionStorage, NOW)).toBeNull();
  });

  it('is never shared between tabs: no source file uses a BroadcastChannel', () => {
    const offenders = sourceFiles(SRC).filter((f) => /BroadcastChannel/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});

describe('exchangeCode', () => {
  it('posts JSON to the page origin without credentials', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ token: 'ui', expires_at: 'x', project_id: 'p' }), { status: 200 }),
    );
    const s = await exchangeCode('abcdefghijklmnop', 'http://127.0.0.1:4310', fetchImpl as unknown as typeof fetch);
    expect(s).toEqual({ token: 'ui', expires_at: 'x', project_id: 'p' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4310/ui/session');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'abcdefghijklmnop' });
  });

  it('maps a used or expired code to an AuthError', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { code: 'COS-3004', message: 'invalid login code' } }), { status: 401 });
    const e = await exchangeCode('abcdefghijklmnop', 'http://127.0.0.1:1', fetchImpl as unknown as typeof fetch).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(AuthError);
    expect((e as AuthError).code).toBe('COS-3004');
  });

  it('maps a refused connection to an OfflineError and a strange answer to an ApiError', async () => {
    const offline = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(
      exchangeCode('abcdefghijklmnop', 'http://127.0.0.1:1', offline as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(OfflineError);
    const strange = async () => new Response('<html>', { status: 200 });
    await expect(
      exchangeCode('abcdefghijklmnop', 'http://127.0.0.1:1', strange as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
