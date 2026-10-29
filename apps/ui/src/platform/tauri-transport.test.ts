import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TauriCore } from './tauri-transport.js';
import { ApiError, AuthError, OfflineError } from './transport.js';

type Module = typeof import('./tauri-transport.js');

/**
 * `tauri-transport.ts` imports `@tauri-apps/api/core`, which Vite must resolve to transform the
 * file: until the package is a dependency of `@friday/ui` the module cannot load, and this file
 * says so and skips (the dependency line is in apps/desktop/README.md).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const installed = existsSync(path.resolve(HERE, '../../node_modules/@tauri-apps/api/package.json'));
if (!installed) console.warn('tauri-transport.test.ts skipped: @tauri-apps/api is not a dependency of @friday/ui yet');

let asksForDanger: Module['asksForDanger'];
let DESKTOP_CONFIRMED: Module['DESKTOP_CONFIRMED'];
let errorOf: Module['errorOf'];
let isTauri: Module['isTauri'];
let needsConfirmation: Module['needsConfirmation'];
let TauriTransport: Module['TauriTransport'];

/** A fake of `@tauri-apps/api/core`: `invoke` is a spy, channels are kept to be fed. */
const fake = vi.hoisted(() => {
  const channels: { id: number; onmessage: (m: unknown) => void }[] = [];
  class Channel {
    readonly id: number;
    onmessage: (m: unknown) => void;
    constructor(onmessage?: (m: unknown) => void) {
      this.id = channels.length + 1;
      this.onmessage = onmessage ?? (() => undefined);
      channels.push(this);
    }
  }
  return {
    channels,
    Channel,
    invoke: (() => Promise.resolve(null)) as (cmd: string, args?: unknown) => Promise<unknown>,
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => fake.invoke(cmd, args),
  Channel: fake.Channel,
}));

const P = '/api/v1/projects/proj_0123456789abcdefghjkmnpqrs';

/** Loaded only when the package resolves: a literal specifier would make Vite transform it now. */
const MODULE = './tauri-transport.js';

describe.skipIf(!installed)('the desktop transport', () => {
  beforeAll(async () => {
    if (!installed) return;
    ({ asksForDanger, DESKTOP_CONFIRMED, errorOf, isTauri, needsConfirmation, TauriTransport } = (await import(
      /* @vite-ignore */ MODULE
    )) as Module);
  });

  let calls: { cmd: string; args: Record<string, unknown> }[] = [];

  function answer(fn: (cmd: string, args: Record<string, unknown>) => unknown) {
    fake.invoke = async (cmd, args) => {
      calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      return fn(cmd, (args ?? {}) as Record<string, unknown>);
    };
  }

  beforeEach(() => {
    calls = [];
    fake.channels.length = 0;
    answer(() => ({ ok: true }));
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  describe('TauriTransport.request', () => {
    it('loads the Tauri API only when a method runs, through the dynamic import', async () => {
      const t = new TauriTransport();
      expect(calls).toEqual([]);
      await expect(t.request('GET', `${P}/ui/snapshot`)).resolves.toEqual({ ok: true });
      expect(calls).toEqual([{ cmd: 'friday_request', args: expect.objectContaining({ method: 'GET' }) }]);
    });

    it('sends ordinary requests through friday_request with the timeout and idempotency key', async () => {
      const t = new TauriTransport();
      await t.request('POST', `${P}/goals`, { request: 'x' }, { timeoutMs: 120_000, idempotencyKey: 'k-1' });
      await t.request('GET', `${P}/ui/snapshot`);
      expect(calls).toEqual([
        {
          cmd: 'friday_request',
          args: {
            method: 'POST',
            path: `${P}/goals`,
            body: { request: 'x' },
            timeoutMs: 120_000,
            idempotencyKey: 'k-1',
          },
        },
        {
          cmd: 'friday_request',
          args: { method: 'GET', path: `${P}/ui/snapshot`, body: null, timeoutMs: 15_000, idempotencyKey: null },
        },
      ]);
    });

    it('sends the actions the shell confirms through confirm_and_send', async () => {
      const t = new TauriTransport();
      const confirmed = [
        `${P}/approvals/appr_1/approve`,
        `${P}/policy/trust`,
        `${P}/control/halt`,
        `${P}/tasks/task_1/cancel`,
        `${P}/goals/goal_1/cancel`,
        `${P}/daemon/stop`,
        `${P}/agent-processes`,
        `${P}/agent-processes/claude-1/start`,
      ];
      for (const p of confirmed) await t.request('POST', p, { reuse: 'once' });
      expect(calls.map((c) => c.cmd)).toEqual(confirmed.map(() => 'confirm_and_send'));
      expect(calls[0]?.args).toEqual({ method: 'POST', path: confirmed[0], body: { reuse: 'once' } });
      calls = [];
      await t.request('POST', `${P}/approvals/appr_1/reject`, {});
      await t.request('POST', `${P}/agent-processes/claude-1/stop`, {});
      await t.request('POST', `${P}/control/pause`, {});
      expect(calls.map((c) => c.cmd)).toEqual(['friday_request', 'friday_request', 'friday_request']);
    });

    it('sends any body asking for danger-full-access through confirm_and_send', async () => {
      const t = new TauriTransport();
      await t.request('POST', `${P}/goals`, { options: { sandbox: 'danger-full-access' } });
      await t.request('POST', `${P}/goals`, { nested: [{ x: ' DANGER-FULL-ACCESS ' }] });
      expect(calls.map((c) => c.cmd)).toEqual(['confirm_and_send', 'confirm_and_send']);
      expect(asksForDanger({ sandbox: 'workspace-write' })).toBe(false);
      expect(needsConfirmation('GET', `${P}/goals`, { sandbox: 'danger-full-access' })).toBe(false);
    });

    it('maps the daemon error passed through to ApiError, AuthError and OfflineError', async () => {
      const t = new TauriTransport();
      const body = (code: string, message: string) => ({ error: { code, name: 'x', message, retryable: true } });
      answer(() => Promise.reject({ status: 401, body: body('COS-1101', 'the session ended') }));
      await expect(t.request('GET', `${P}/ui/snapshot`)).rejects.toBeInstanceOf(AuthError);
      answer(() => Promise.reject({ status: 503, body: body('COS-9001', 'Friday is stopping') }));
      const e = await t.request('GET', `${P}/ui/snapshot`).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe('COS-9001');
      expect((e as ApiError).status).toBe(503);
      expect((e as ApiError).retryable).toBe(true);
      answer(() => Promise.reject({ status: 403, body: body('DESKTOP-1000', 'not a route the desktop app forwards') }));
      await expect(t.request('GET', `${P}/ui/snapshot`)).rejects.toMatchObject({ code: 'DESKTOP-1000', status: 403 });
      answer(() => Promise.reject({ status: 0, body: body('DESKTOP-2000', 'Friday is not answering') }));
      await expect(t.request('GET', `${P}/ui/snapshot`)).rejects.toEqual(new OfflineError('Friday is not answering'));
      answer(() => Promise.reject('the IPC broke'));
      await expect(t.request('GET', `${P}/ui/snapshot`)).rejects.toBeInstanceOf(OfflineError);
      expect(errorOf({ status: 500, body: null })).toMatchObject({ code: 'HTTP-500' });
    });

    it('gives up as soon as the caller aborts', async () => {
      const t = new TauriTransport();
      answer(() => new Promise(() => undefined));
      const controller = new AbortController();
      const pending = t.request('GET', `${P}/graph`, undefined, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(OfflineError);
      await expect(t.request('GET', `${P}/graph`, undefined, { signal: controller.signal })).rejects.toBeInstanceOf(
        OfflineError,
      );
    });

    it('uses an injected core when given one', async () => {
      const invoke = vi.fn(async () => 7);
      const t = new TauriTransport(async () => ({ invoke, Channel: fake.Channel }) as unknown as TauriCore);
      await expect(t.request('GET', `${P}/goals`)).resolves.toBe(7);
      expect(invoke).toHaveBeenCalledOnce();
    });
  });

  describe('TauriTransport.stream', () => {
    function streaming(onOpen: (channel: (typeof fake.channels)[number]) => void) {
      answer((cmd, args) => {
        if (cmd === 'stream_open') {
          const channel = args.channel as (typeof fake.channels)[number];
          onOpen(channel);
          return 41;
        }
        return null;
      });
    }

    it('opens, forwards activity and events in order after onOpen, and ends on shutdown', async () => {
      const seen: string[] = [];
      let channel: (typeof fake.channels)[number] | undefined;
      // A message that arrives before stream_open answers is held until onOpen ran.
      streaming((c) => {
        channel = c;
        c.onmessage({ kind: 'activity' });
      });
      const t = new TauriTransport();
      const done = t.stream(
        `${P}/events/stream?since=12`,
        {
          onOpen: () => seen.push('open'),
          onActivity: () => seen.push('activity'),
          onEvent: (e) => seen.push(`event ${(e as { sequence: number }).sequence}`),
        },
        new AbortController().signal,
      );
      await vi.waitFor(() => expect(seen).toEqual(['open', 'activity']));
      channel?.onmessage({ kind: 'event', event: { sequence: 13 } });
      channel?.onmessage({ kind: 'end', reason: 'shutdown' });
      channel?.onmessage({ kind: 'event', event: { sequence: 14 } });
      await expect(done).resolves.toBe('shutdown');
      expect(seen).toEqual(['open', 'activity', 'event 13']);
      expect(calls[0]).toEqual({ cmd: 'stream_open', args: { since: 12, channel } });
      expect(calls.at(-1)).toEqual({ cmd: 'stream_close', args: { id: 41 } });
    });

    it('resolves closed when the caller aborts, and rejects on a stream error', async () => {
      let channel: (typeof fake.channels)[number] | undefined;
      streaming((c) => {
        channel = c;
      });
      const t = new TauriTransport();
      const controller = new AbortController();
      const opened = vi.fn();
      const done = t.stream(
        `${P}/events/stream?since=0`,
        { onOpen: opened, onEvent: () => undefined },
        controller.signal,
      );
      await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
      controller.abort();
      await expect(done).resolves.toBe('closed');
      expect(calls.at(-1)).toEqual({ cmd: 'stream_close', args: { id: 41 } });

      const failing = t.stream(
        `${P}/events/stream?since=0`,
        { onEvent: () => undefined },
        new AbortController().signal,
      );
      await vi.waitFor(() => expect(channel).toBeDefined());
      await vi.waitFor(() => expect(fake.channels.length).toBe(2));
      fake.channels[1]?.onmessage({ kind: 'error', message: 'the event stream failed' });
      await expect(failing).rejects.toEqual(new OfflineError('the event stream failed'));
    });

    it('maps a refused stream to the daemon error and refuses foreign paths', async () => {
      answer(() => Promise.reject({ status: 401, body: { error: { code: 'COS-1101', message: 'ended' } } }));
      const t = new TauriTransport();
      await expect(
        t.stream(`${P}/events/stream?since=0`, { onEvent: () => undefined }, new AbortController().signal),
      ).rejects.toBeInstanceOf(AuthError);
      await expect(
        t.stream(`${P}/ui/snapshot`, { onEvent: () => undefined }, new AbortController().signal),
      ).rejects.toBeInstanceOf(OfflineError);
      const aborted = new AbortController();
      aborted.abort();
      await expect(t.stream(`${P}/events/stream?since=0`, { onEvent: () => undefined }, aborted.signal)).resolves.toBe(
        'closed',
      );
    });
  });

  describe('the desktop contract', () => {
    it('detects the shell by its IPC object, never by host name', () => {
      expect(isTauri()).toBe(false);
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      expect(isTauri()).toBe(true);
    });

    it('mirrors the routes routes.rs gives to confirm_and_send', () => {
      const routes = readFileSync(path.resolve(HERE, '../../../desktop/src-tauri/src/routes.rs'), 'utf8');
      const sample = (template: string) =>
        `${P}/${template.replace(/\{[a-z]+\}/g, (p) => (p === '{v}' ? '3' : 'x-1'))}`;
      const owned = [...routes.matchAll(/confirm\("([^"]+)", Confirm::/g)].map((m) => m[1] ?? '');
      const plain = [...routes.matchAll(/\bpost\("([^"]+)"\)/g)].map((m) => m[1] ?? '');
      expect(owned.length).toBe(DESKTOP_CONFIRMED.length);
      expect(plain.length).toBeGreaterThan(20);
      for (const t of owned) expect(needsConfirmation('POST', sample(t), {}), t).toBe(true);
      for (const t of plain) expect(needsConfirmation('POST', sample(t), {}), t).toBe(false);
    });
  });
});
