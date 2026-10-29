import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUARD_TIMEOUT_MS, guardServiceWorkers } from './sw-guard.js';

type Nav = Pick<Navigator, 'serviceWorker'>;

function fakeNav(opts: {
  controller?: unknown;
  registrations?: { unregister: () => Promise<boolean> }[];
  getRegistrations?: () => Promise<{ unregister: () => Promise<boolean> }[]>;
}): Nav {
  const container = {
    controller: opts.controller ?? null,
    getRegistrations: opts.getRegistrations ?? (async () => opts.registrations ?? []),
  };
  return { serviceWorker: container } as unknown as Nav;
}

function registration(result: Promise<boolean> | (() => never) = Promise.resolve(true)) {
  return {
    unregister: vi.fn(() => (typeof result === 'function' ? result() : result)),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('guardServiceWorkers (plan §7.1)', () => {
  it('is clean without a navigator or without service workers', async () => {
    expect(await guardServiceWorkers(undefined)).toBe('clean');
    expect(await guardServiceWorkers({} as Nav)).toBe('clean');
  });

  it('is clean when nothing controls the page and nothing is registered', async () => {
    expect(await guardServiceWorkers(fakeNav({}))).toBe('clean');
  });

  it('removes every registration it finds', async () => {
    const a = registration();
    const b = registration();
    expect(await guardServiceWorkers(fakeNav({ registrations: [a, b] }))).toBe('removed');
    expect(a.unregister).toHaveBeenCalledOnce();
    expect(b.unregister).toHaveBeenCalledOnce();
  });

  it('answers removed when a worker controls the page even with no registration listed', async () => {
    expect(await guardServiceWorkers(fakeNav({ controller: { state: 'activated' } }))).toBe('removed');
  });

  it('never throws: failing unregisters, a failing listing and a throwing getter', async () => {
    const rejects = registration(Promise.reject(new Error('no')));
    const throws = registration(() => {
      throw new Error('boom');
    });
    expect(await guardServiceWorkers(fakeNav({ registrations: [rejects, throws] }))).toBe('removed');
    expect(
      await guardServiceWorkers(
        fakeNav({
          getRegistrations: () => Promise.reject(new Error('denied')),
        }),
      ),
    ).toBe('clean');
    expect(
      await guardServiceWorkers(
        fakeNav({ controller: {}, getRegistrations: () => Promise.reject(new Error('denied')) }),
      ),
    ).toBe('removed');
    const hostile = {
      get serviceWorker(): never {
        throw new Error('blocked');
      },
    } as unknown as Nav;
    expect(await guardServiceWorkers(hostile)).toBe('clean');
  });

  it('does not hang when the browser never answers', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const p = guardServiceWorkers(fakeNav({ getRegistrations: () => never }));
    await vi.advanceTimersByTimeAsync(GUARD_TIMEOUT_MS + 1);
    expect(await p).toBe('clean');
    const stuck = { unregister: vi.fn(() => never) };
    const q = guardServiceWorkers(fakeNav({ registrations: [stuck] }));
    await vi.advanceTimersByTimeAsync(GUARD_TIMEOUT_MS + 1);
    expect(await q).toBe('removed');
  });
});
