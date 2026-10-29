import {
  type ErrorBody,
  FridayError,
  fromRpcError,
  type MethodName,
  type ParamsOf,
  type ResultOf,
  type RpcResponse,
  type TokenClass,
} from '@friday/protocol';
import { type LocalTokenClass, type ProjectRef, readDiscovery, readToken } from './discovery.js';
import { SseParser } from './sse.js';

/** The daemon is not running or not reachable (CLI exit code 3). */
export class DaemonUnreachableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DaemonUnreachableError';
  }
}

export interface RequestOptions {
  idempotencyKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | string[] | undefined>;
}

export interface DaemonClientOptions {
  baseUrl: string;
  token: string;
  tokenClass: TokenClass;
  projectId: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Re-reads the token after a 401 (the daemon rotates tokens on restart). */
  refreshToken?: () => string | undefined;
  /**
   * Re-reads where the daemon listens after a connection fails: a daemon started again listens on
   * another port when none is configured (review M8-R02).
   */
  refreshBaseUrl?: () => string | undefined;
  clientName?: string;
}

let rpcCounter = 0;

/** HTTP and JSON-RPC client for one project's daemon. Never logs or echoes its token. */
export class DaemonClient {
  readonly tokenClass: TokenClass;
  readonly projectId: string;
  #baseUrl: string;
  #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #refresh: (() => string | undefined) | undefined;
  readonly #refreshBase: (() => string | undefined) | undefined;
  readonly #clientName: string;

  constructor(opts: DaemonClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.tokenClass = opts.tokenClass;
    this.projectId = opts.projectId;
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
    this.#refresh = opts.refreshToken;
    this.#refreshBase = opts.refreshBaseUrl;
    this.#clientName = opts.clientName ?? 'friday-sdk';
  }

  /** Where the daemon listens, as last discovered. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** Client for a local project using the operator (CLI) or bootstrap (MCP server, hooks) token. */
  static forProject(
    ref: ProjectRef,
    tokenClass: LocalTokenClass,
    opts: { clientName?: string; timeoutMs?: number } = {},
  ): DaemonClient {
    const discovery = readDiscovery(ref);
    const token = readToken(ref, tokenClass);
    if (!discovery || !token) {
      throw new DaemonUnreachableError(
        `the Friday daemon for "${ref.name}" is not running; start it with "friday run"`,
      );
    }
    return new DaemonClient({
      baseUrl: discovery.url,
      token,
      tokenClass,
      projectId: ref.project_id,
      refreshToken: () => readToken(ref, tokenClass),
      refreshBaseUrl: () => readDiscovery(ref)?.url,
      ...opts,
    });
  }

  /** Same daemon, different credential (e.g. the harness token issued at registration). */
  withToken(token: string, tokenClass: TokenClass): DaemonClient {
    return new DaemonClient({
      baseUrl: this.#baseUrl,
      token,
      tokenClass,
      projectId: this.projectId,
      fetch: this.#fetch,
      timeoutMs: this.#timeoutMs,
      clientName: this.#clientName,
      // The daemon's address may move; a credential it issued is still its own (harness tokens
      // outlive a daemon restart).
      ...(this.#refreshBase ? { refreshBaseUrl: this.#refreshBase } : {}),
    });
  }

  projectPath(sub = ''): string {
    return `/api/v1/projects/${this.projectId}${sub}`;
  }

  private url(path: string, query?: RequestOptions['query']): string {
    const u = new URL(this.#baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, item);
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.#token}`,
      'x-friday-client': this.#clientName,
      ...extra,
    };
  }

  async raw(
    method: string,
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
    rediscovered = false,
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? this.#timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, ctrl.signal]) : ctrl.signal;
    const headers = this.headers(body === undefined ? {} : { 'content-type': 'application/json' });
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    try {
      return await this.#fetch(this.url(path, opts.query), {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (ctrl.signal.aborted && !opts.signal?.aborted) {
        throw new DaemonUnreachableError(`request to the Friday daemon timed out (${method} ${path})`, { cause: e });
      }
      if (opts.signal?.aborted) throw e;
      // Nothing listens here any more: a daemon started again may listen elsewhere.
      const moved = rediscovered ? undefined : this.#refreshBase?.()?.replace(/\/+$/, '');
      if (moved && moved !== this.#baseUrl) {
        this.#baseUrl = moved;
        clearTimeout(timer);
        return this.raw(method, path, body, opts, true);
      }
      throw new DaemonUnreachableError(`cannot reach the Friday daemon at ${this.#baseUrl}; is "friday run" running?`, {
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** JSON request; non-2xx responses become FridayError. Retries once with a refreshed token after a 401. */
  async request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    let res = await this.raw(method, path, body, opts);
    if (res.status === 401 && this.#refresh) {
      const fresh = this.#refresh();
      if (fresh && fresh !== this.#token) {
        this.#token = fresh;
        res = await this.raw(method, path, body, opts);
      }
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      if (json && typeof json === 'object' && 'error' in json) throw FridayError.fromBody(json as ErrorBody);
      throw new FridayError('internal_error', `daemon answered ${res.status} for ${method} ${path}`);
    }
    return json as T;
  }

  get<T>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, opts);
  }

  post<T>(path: string, body: unknown = {}, opts?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, opts);
  }

  /** Calls a harness protocol method (POST /protocol/v1/rpc). */
  async rpc<M extends MethodName>(method: M, params: ParamsOf<M>, opts: RequestOptions = {}): Promise<ResultOf<M>> {
    rpcCounter += 1;
    const body = { jsonrpc: '2.0', id: `${process.pid}-${rpcCounter}`, method, params };
    const res = await this.request<RpcResponse<ResultOf<M>>>('POST', '/protocol/v1/rpc', body, opts);
    if ('error' in res) throw fromRpcError(res.error);
    return res.result;
  }

  /** Streams SSE messages from `path` until the signal aborts or the server closes. */
  async *sse(path: string, opts: { lastEventId?: string; signal?: AbortSignal; query?: RequestOptions['query'] } = {}) {
    const headers = this.headers({ accept: 'text/event-stream' });
    if (opts.lastEventId) headers['last-event-id'] = opts.lastEventId;
    let res: Response;
    try {
      res = await this.#fetch(this.url(path, opts.query), { headers, signal: opts.signal ?? null });
    } catch (e) {
      if (opts.signal?.aborted) return;
      throw new DaemonUnreachableError(`cannot reach the Friday daemon at ${this.baseUrl}`, { cause: e });
    }
    if (!res.ok || !res.body) {
      const text = await res.text();
      try {
        throw FridayError.fromBody(JSON.parse(text));
      } catch (e) {
        if (e instanceof FridayError) throw e;
        throw new FridayError('internal_error', `stream ${path} failed with ${res.status}`);
      }
    }
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        for (const msg of parser.push(decoder.decode(value, { stream: true }))) yield msg;
      }
    } catch (e) {
      if (opts.signal?.aborted) return;
      throw e;
    } finally {
      reader.releaseLock();
    }
  }
}
