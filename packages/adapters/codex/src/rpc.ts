/**
 * JSON-RPC 2.0 over JSON lines, as `codex app-server` speaks it on stdio (protocol v2, M3.5):
 * requests with ids and their responses, notifications, and requests from the server, which the
 * client answers (approvals, questions). Transport-neutral: it is fed lines and writes lines.
 */

/** An error answer from the server. */
export class AppServerError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly data: unknown,
  ) {
    super(message);
    this.name = 'AppServerError';
  }
}

export interface JsonRpcLinesOptions {
  /** A notification from the server. */
  onNotification: (method: string, params: unknown) => void;
  /** A request from the server; its result is sent back, and a thrown error becomes an error answer. */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  /** A line that is not JSON (the host's own log output, for example). */
  onUnparsable?: (line: string) => void;
}

/** Thrown by a request handler for a method the client does not serve. */
export class MethodNotFound extends Error {
  constructor(method: string) {
    super(`${method} is not served by Friday's adapter`);
  }
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class JsonRpcLines {
  #next = 1;
  readonly #pending = new Map<number, Pending>();
  #closed: string | null = null;

  constructor(
    private readonly write: (line: string) => void,
    private readonly opts: JsonRpcLinesOptions,
  ) {}

  /** One line the server wrote. */
  feed(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.opts.onUnparsable?.(line);
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const hasId = 'id' in msg && msg.id !== null && msg.id !== undefined;
    if (hasId && typeof msg.method !== 'string') {
      const p = this.#pending.get(msg.id as number);
      if (!p) return;
      this.#pending.delete(msg.id as number);
      clearTimeout(p.timer);
      const err = msg.error as { message?: string; code?: number; data?: unknown } | undefined;
      if (err) p.reject(new AppServerError(err.message ?? `${p.method} failed`, err.code ?? null, err.data));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method !== 'string') return;
    if (!hasId) {
      this.opts.onNotification(msg.method, msg.params);
      return;
    }
    const id = msg.id;
    this.opts.onRequest(msg.method, msg.params).then(
      (result) => this.#send({ jsonrpc: '2.0', id, result: result ?? null }),
      (e: Error) =>
        this.#send({
          jsonrpc: '2.0',
          id,
          error: { code: e instanceof MethodNotFound ? -32601 : -32603, message: e.message },
        }),
    );
  }

  /** Sends a request and resolves with its result. */
  request<T = unknown>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.#closed) return Promise.reject(new Error(`the app-server is gone: ${this.#closed}`));
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} got no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** The server is gone: every open request fails with the reason. */
  close(reason: string): void {
    this.#closed = reason;
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`the app-server is gone (${reason}) before ${p.method} was answered`));
      this.#pending.delete(id);
    }
  }

  #send(msg: Record<string, unknown>): void {
    this.write(`${JSON.stringify(msg)}\n`);
  }
}
