/**
 * The desktop transport (plan FD-06, FD-07): inside the desktop shell the page holds no daemon
 * credential and asks the shell's Rust core instead, which forwards only the routes of its
 * allowlist (`apps/desktop/src-tauri/src/routes.rs`). `@tauri-apps/api` is loaded only here, by a
 * dynamic import taken inside the methods (FD-02's one exception), so a browser tab never loads it.
 *
 * - `friday_request` sends ordinary requests.
 * - `confirm_and_send` sends what the shell must see first ({@link DESKTOP_CONFIRMED}, and any body
 *   asking for `danger-full-access`): Rust re-reads the item and shows a native dialog when needed.
 * - The event stream arrives on a channel: `event`, `activity` (any bytes, pings included), `end`
 *   (`shutdown` or `closed`) and `error`.
 *
 * A failed command rejects with `{status, body}`: the daemon's status and its JSON answer passed
 * through (`{error: {code, name, message, retryable, details}}`), or status 0 when the daemon was
 * not reached. They map to `ApiError`, `AuthError` and `OfflineError` exactly as over HTTP.
 */
import type { DomainEvent } from '@friday/protocol';
import {
  type ApiError,
  errorFrom,
  OfflineError,
  type RequestOptions,
  type StreamEnd,
  type StreamHandlers,
  type Transport,
} from './transport.js';

/** What this transport needs from `@tauri-apps/api/core`. */
export interface TauriCore {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  Channel: new <T>(onmessage?: (message: T) => void) => { readonly id: number };
}

/** True inside the desktop shell (never judged by host name; LESSONS UI-16). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * The routes the shell sends only through `confirm_and_send` (mirror of `Owner::Confirm` in
 * routes.rs): approving, trusting policy, halting, cancelling a task or a goal, stopping Friday,
 * starting an agent.
 */
export const DESKTOP_CONFIRMED: readonly { method: 'POST'; path: RegExp }[] = [
  { method: 'POST', path: /^\/api\/v1\/projects\/[^/?]+\/approvals\/[^/?]+\/approve$/ },
  { method: 'POST', path: /^\/api\/v1\/projects\/[^/?]+\/policy\/trust$/ },
  { method: 'POST', path: /^\/api\/v1\/projects\/[^/?]+\/control\/halt$/ },
  { method: 'POST', path: /^\/api\/v1\/projects\/[^/?]+\/tasks\/[^/?]+\/cancel$/ },
  { method: 'POST', path: /^\/api\/v1\/projects\/[^/?]+\/goals\/[^/?]+\/cancel$/ },
  { method: 'POST', path: /^\/api\/v1\/projects\/[^/?]+\/daemon\/stop$/ },
  { method: 'POST', path: /^\/api\/v1\/projects\/[^/?]+\/agent-processes$/ },
  { method: 'POST', path: /^\/api\/v1\/projects\/[^/?]+\/agent-processes\/[^/?]+\/start$/ },
];

const DANGER = 'danger-full-access';

const RECOVER = /^\/api\/v1\/projects\/[^/?]+\/tasks\/[^/?]+\/recover$/;

function recoverAction(body: unknown): string | null {
  const a = body && typeof body === 'object' ? (body as { action?: unknown }).action : null;
  return typeof a === 'string' ? a.trim().toLowerCase() : null;
}

/** True when any key or string in the body is `danger-full-access` (as routes.rs judges it). */
export function asksForDanger(body: unknown): boolean {
  if (typeof body === 'string') return body.trim().toLowerCase() === DANGER;
  if (Array.isArray(body)) return body.some(asksForDanger);
  if (body && typeof body === 'object') {
    return Object.entries(body).some(([k, v]) => k.trim().toLowerCase() === DANGER || asksForDanger(v));
  }
  return false;
}

/** Whether a request goes through `confirm_and_send`. */
export function needsConfirmation(method: 'GET' | 'POST', path: string, body?: unknown): boolean {
  const bare = path.split('?')[0] ?? path;
  if (DESKTOP_CONFIRMED.some((r) => r.method === method && r.path.test(bare))) return true;
  // Recovery's cancel ends the task as the cancel route does (`recover_cancels` in routes.rs).
  if (method === 'POST' && RECOVER.test(bare) && recoverAction(body) === 'cancel') return true;
  return method === 'POST' && asksForDanger(body);
}

interface CommandError {
  status: number;
  body: unknown;
}

function isCommandError(e: unknown): e is CommandError {
  return !!e && typeof e === 'object' && typeof (e as { status?: unknown }).status === 'number';
}

/** The error a failed command becomes. */
export function errorOf(e: unknown): ApiError | OfflineError {
  if (isCommandError(e)) {
    if (e.status === 0) {
      const message = (e.body as { error?: { message?: unknown } } | null)?.error?.message;
      return new OfflineError(typeof message === 'string' ? message : 'Friday is not reachable');
    }
    return errorFrom(e.status, e.body);
  }
  return new OfflineError(e instanceof Error ? e.message : String(e));
}

type StreamMessage =
  | { kind: 'event'; event: DomainEvent }
  | { kind: 'activity' }
  | { kind: 'end'; reason: StreamEnd }
  | { kind: 'error'; message: string };

const STREAM_PATH = /^\/api\/v1\/projects\/[^/?]+\/events\/stream\?since=(\d+)$/;

/** The call's answer, or `OfflineError` as soon as `signal` aborts (the shell's work carries on). */
function withSignal<T>(call: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return call;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new OfflineError('the request was cancelled'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    call.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export class TauriTransport implements Transport {
  readonly kind = 'tauri' as const;

  /** `load` replaces the import of `@tauri-apps/api/core` (tests only). */
  constructor(private readonly load?: () => Promise<TauriCore>) {}

  async #core(): Promise<TauriCore> {
    if (this.load) return this.load();
    return (await import('@tauri-apps/api/core')) as unknown as TauriCore;
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    if (opts.signal?.aborted) throw new OfflineError('the request was cancelled');
    const core = await this.#core();
    const call = needsConfirmation(method, path, body)
      ? core.invoke<T>('confirm_and_send', { method, path, body: body ?? null })
      : core.invoke<T>('friday_request', {
          method,
          path,
          body: body ?? null,
          timeoutMs: opts.timeoutMs ?? 15_000,
          idempotencyKey: opts.idempotencyKey ?? null,
        });
    try {
      return await withSignal(call, opts.signal);
    } catch (e) {
      if (e instanceof OfflineError) throw e;
      throw errorOf(e);
    }
  }

  async stream(path: string, handlers: StreamHandlers, signal: AbortSignal): Promise<StreamEnd> {
    const m = STREAM_PATH.exec(path);
    if (!m) throw new OfflineError('the desktop app streams only the events of its project');
    const since = Number(m[1]);
    if (signal.aborted) return 'closed';
    const core = await this.#core();
    if (signal.aborted) return 'closed';
    return new Promise<StreamEnd>((resolve, reject) => {
      let id: number | null = null;
      let open = false;
      let settled = false;
      const early: StreamMessage[] = [];
      const close = (streamId: number) => {
        core.invoke('stream_close', { id: streamId }).catch(() => undefined);
      };
      const finish = (done: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (id !== null) close(id);
        done();
      };
      const handle = (msg: StreamMessage) => {
        if (settled) return;
        switch (msg.kind) {
          case 'activity':
            handlers.onActivity?.();
            break;
          case 'event':
            handlers.onEvent(msg.event);
            break;
          case 'end':
            finish(() => resolve(msg.reason === 'shutdown' ? 'shutdown' : 'closed'));
            break;
          case 'error':
            finish(() => reject(new OfflineError(msg.message)));
            break;
        }
      };
      // Messages can arrive before `stream_open` answers: hold them until `onOpen` ran.
      const channel = new core.Channel<StreamMessage>((msg) => {
        if (open) handle(msg);
        else early.push(msg);
      });
      const onAbort = () => finish(() => resolve('closed'));
      signal.addEventListener('abort', onAbort, { once: true });
      core.invoke<number>('stream_open', { since, channel }).then(
        (streamId) => {
          id = streamId;
          if (settled) {
            close(streamId);
            return;
          }
          open = true;
          handlers.onOpen?.();
          for (const msg of early.splice(0)) handle(msg);
        },
        (e) => finish(() => reject(errorOf(e))),
      );
    });
  }
}
