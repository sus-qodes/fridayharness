/**
 * A test `AppContext` (unit tests only): a real store and registry, an API whose every call is
 * recorded and answered by `answers` (or an empty object), a keyboard on a detached target, a
 * platform stub, and captured toasts, confirms and reactions.
 */
import type { UiSnapshot } from '@friday/protocol';
import { FridayApi } from '../api/client.js';
import { browserPlatform } from '../platform/browser-platform.js';
import type { RequestOptions, StreamEnd, StreamHandlers, Transport } from '../platform/transport.js';
import { type AppContext, type ConfirmOptions, Registry, type Toast } from '../shell/context.js';
import { createStore, type FridayStore, type ReactionKind } from '../store/state.js';
import { Keyboard } from '../ui/keys.js';
import { makeSnapshot, PID } from './fixtures.js';

export interface RecordedCall {
  method: 'GET' | 'POST';
  path: string;
  body: unknown;
  opts: RequestOptions | undefined;
}

/** Answers keyed by `"POST /tasks/x/verify"`, matched on the path after the project prefix; a function may throw. */
export type Answers = Record<string, unknown | ((call: RecordedCall) => unknown)>;

export class FakeTransport implements Transport {
  readonly kind = 'http' as const;
  readonly calls: RecordedCall[] = [];
  constructor(public answers: Answers = {}) {}

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    const call = { method, path, body, opts };
    this.calls.push(call);
    const short = path.replace(`/api/v1/projects/${PID}`, '').split('?')[0];
    const key = `${method} ${short}`;
    const answer = key in this.answers ? this.answers[key] : this.answers[`${method} ${path}`];
    if (typeof answer === 'function') return (await (answer as (c: RecordedCall) => unknown)(call)) as T;
    return (answer ?? {}) as T;
  }

  async stream(_path: string, _h: StreamHandlers, signal: AbortSignal): Promise<StreamEnd> {
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve('closed')));
  }

  /** The calls to a path (project prefix and query removed), in order. */
  to(method: 'GET' | 'POST', short: string): RecordedCall[] {
    return this.calls.filter(
      (c) => c.method === method && c.path.replace(`/api/v1/projects/${PID}`, '').split('?')[0] === short,
    );
  }
}

export interface TestContext extends AppContext {
  readonly transport: FakeTransport;
  readonly toasts: Toast[];
  readonly confirms: ConfirmOptions[];
  readonly reactions: { kind: ReactionKind; label?: string }[];
  /** What `confirm` resolves to (default true). */
  confirmAnswer: boolean;
  refreshes: number;
  /** Sets the board snapshot. */
  board(s?: UiSnapshot): void;
  clock: { now: number };
}

export function makeContext(opts: { answers?: Answers; snapshot?: UiSnapshot; store?: FridayStore } = {}): TestContext {
  const transport = new FakeTransport(opts.answers);
  const store = opts.store ?? createStore();
  store.setState({ board: opts.snapshot ?? makeSnapshot() });
  const toasts: Toast[] = [];
  const confirms: ConfirmOptions[] = [];
  const reactions: { kind: ReactionKind; label?: string }[] = [];
  const clock = { now: Date.parse('2026-10-17T10:00:00.000Z') };
  const keyTarget = new EventTarget() as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;
  const ctx: TestContext = {
    store,
    api: new FridayApi(transport, PID),
    keys: new Keyboard(keyTarget),
    platform: {
      kind: 'browser',
      openInEditor: () => undefined,
      copy: async () => true,
      // As a browser asks: the page's Notification API, which a test stubs.
      requestNotifications: () => browserPlatform().requestNotifications(),
    },
    registry: new Registry(),
    transport,
    toasts,
    confirms,
    reactions,
    confirmAnswer: true,
    refreshes: 0,
    clock,
    toast: (t) => {
      toasts.push(t);
    },
    confirm: async (o) => {
      confirms.push(o);
      return ctx.confirmAnswer;
    },
    act: async (label, call, success) => {
      try {
        const r = await call();
        if (success) toasts.push({ kind: 'success', text: typeof success === 'function' ? success(r) : success });
        return r;
      } catch (e) {
        toasts.push({ kind: 'error', text: label, detail: (e as Error).message });
        return undefined;
      }
    },
    react: (kind, label) => {
      reactions.push({ kind, ...(label ? { label } : {}) });
    },
    refresh: () => {
      ctx.refreshes += 1;
    },
    now: () => clock.now,
    board: (s) => store.setState({ board: s ?? makeSnapshot() }),
  };
  return ctx;
}
