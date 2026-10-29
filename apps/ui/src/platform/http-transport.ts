/**
 * The browser transport: same-origin `fetch` with the UI session as a bearer token, and the event
 * stream read with `fetch` plus the SDK's SSE parser, because `EventSource` cannot send the
 * header (LESSONS UI-07).
 */
import type { DomainEvent } from '@friday/protocol';
import { SseParser } from '@friday/sdk/sse';
import {
  errorFrom,
  OfflineError,
  type RequestOptions,
  type StreamEnd,
  type StreamHandlers,
  type Transport,
} from './transport.js';

type Fetch = typeof fetch;

export class HttpTransport implements Transport {
  readonly kind = 'http' as const;

  constructor(
    private readonly origin: string,
    private readonly token: () => string | null,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
  ) {}

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    const t = this.token();
    return { ...(t ? { authorization: `Bearer ${t}` } : {}), ...extra };
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}${path}`, {
        method,
        headers: this.#headers({
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
        }),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (e) {
      throw new OfflineError(controller.signal.aborted ? 'the request timed out' : (e as Error).message);
    } finally {
      clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', onAbort);
    }
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) throw errorFrom(res.status, data);
    return data as T;
  }

  async stream(path: string, handlers: StreamHandlers, signal: AbortSignal): Promise<StreamEnd> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}${path}`, {
        headers: this.#headers({ accept: 'text/event-stream' }),
        signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (e) {
      if (signal.aborted) return 'closed';
      throw new OfflineError((e as Error).message);
    }
    if (!res.ok) {
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      throw errorFrom(res.status, data);
    }
    if (!res.body) throw new OfflineError('the event stream has no body');
    handlers.onOpen?.();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return 'closed';
        handlers.onActivity?.();
        for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
          if (msg.event === 'shutdown') return 'shutdown';
          if (!msg.data) continue;
          let event: DomainEvent;
          try {
            event = JSON.parse(msg.data) as DomainEvent;
          } catch {
            continue;
          }
          handlers.onEvent(event);
        }
      }
    } catch (e) {
      if (signal.aborted) return 'closed';
      throw new OfflineError((e as Error).message);
    } finally {
      reader.releaseLock();
    }
  }
}
