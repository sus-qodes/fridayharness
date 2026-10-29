/**
 * How the interface talks to the daemon (plan FD-07): the browser uses HTTP with a UI session, the
 * desktop shell asks its Rust core. Everything above this interface is the same for both.
 */
import type { DomainEvent } from '@friday/protocol';

export interface RequestOptions {
  /** Default 15 s. Long operations (verify, integrate, replan) pass more. */
  timeoutMs?: number;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface StreamHandlers {
  /** Called once the daemon accepted the stream (before any event arrives). */
  onOpen?: () => void;
  onEvent: (event: DomainEvent) => void;
  /** Called on every chunk received, pings included: the stream is alive. */
  onActivity?: () => void;
}

/** Why a stream ended without an error: the daemon drained (`shutdown`) or the connection closed. */
export type StreamEnd = 'shutdown' | 'closed';

export interface Transport {
  readonly kind: 'http' | 'tauri';
  request<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  /** Streams events from `path` (an `events/stream?since=` URL) until it ends or `signal` aborts. */
  stream(path: string, handlers: StreamHandlers, signal: AbortSignal): Promise<StreamEnd>;
}

/** An error answer from the daemon, with Friday's code (`COS-xxxx`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly errorName: string,
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The session ended (401): the daemon restarted, the session was logged out or expired. */
export class AuthError extends ApiError {
  constructor(code: string, message: string) {
    super(401, code, 'authentication_failed', message);
    this.name = 'AuthError';
  }
}

/** The daemon could not be reached at all (refused, reset, timed out). */
export class OfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineError';
  }
}

interface ErrorBody {
  error?: { code?: string; name?: string; message?: string; retryable?: boolean; details?: unknown };
}

/** Builds the error for a non-OK answer from its JSON body. */
export function errorFrom(status: number, body: unknown): ApiError {
  const e = (body as ErrorBody | null)?.error;
  const code = typeof e?.code === 'string' ? e.code : `HTTP-${status}`;
  const message = typeof e?.message === 'string' ? e.message : `the daemon answered ${status}`;
  if (status === 401) return new AuthError(code, message);
  return new ApiError(
    status,
    code,
    typeof e?.name === 'string' ? e.name : 'error',
    message,
    !!e?.retryable,
    e?.details,
  );
}
