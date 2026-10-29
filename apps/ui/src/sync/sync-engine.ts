/**
 * Keeps the store in step with the daemon (plan §4.2, FD-08): one snapshot, then the event stream
 * from the snapshot's head; domain events schedule a debounced re-read of the snapshot (250 ms
 * trailing, at most one in flight, at least once a second while events keep coming). Reconnects
 * with jittered backoff (250 ms → 5 s) and resumes from the last sequence, so nothing is missed.
 *
 * Liveness is judged on raw bytes (pings included): a stream silent for 45 s is dropped and opened
 * again. Reconnects that fail for 10 s mean Friday is gone from this address (it stopped, or it
 * restarted on another port, which is a new origin for this tab); the same after `event: shutdown`.
 * 503 `COS-9001` means Friday is draining: re-reads stop until it answers again. 401 ends the
 * session. A snapshot whose `ui_api` is not this bundle's asks for a reload.
 */
import type { DomainEvent, UiSnapshot } from '@friday/protocol';
import type { FridayApi } from '../api/client.js';
import { ApiError, AuthError, OfflineError } from '../platform/transport.js';
import { UI_API } from '../shell/version.js';
import type { FridayStore } from '../store/state.js';
import { cleanText, truncate } from '../ui/format.js';
import type { Dispatcher } from './dispatcher.js';

/** No stream bytes for this long → the stream is dropped and opened again. */
export const STALL_MS = 45_000;
/** Reconnects failing for this long → Friday is not reachable here. */
export const UNREACHABLE_MS = 10_000;

export const STOPPING_MESSAGE = 'Friday is stopping';
export const UNREACHABLE_MESSAGE =
  'Friday is not reachable here: it stopped, or restarted on another address. Open it again from its shortcut or the desktop app';
export const STALE_PAGE_MESSAGE = 'This page is older than Friday; reload it';
/** The daemon's code while it drains (plan §2). */
export const DRAINING_CODE = 'COS-9001';

export interface SyncOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  /** A stream silent for this long (no event, no ping) is considered dead. */
  stallMs?: number;
  /** Failing reconnects for this long end in "not reachable". */
  unreachableMs?: number;
  backoff?: (attempt: number) => number;
  now?: () => number;
}

export function defaultBackoff(attempt: number): number {
  const base = Math.min(5000, 250 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** A 503 `COS-9001`: the daemon is draining. */
export function isDraining(e: unknown): boolean {
  return e instanceof ApiError && e.status === 503 && e.code === DRAINING_CODE;
}

function describe(e: unknown): string {
  if (e instanceof ApiError) return truncate(cleanText(`${e.code}: ${e.message}`), 300);
  if (e instanceof Error) return truncate(cleanText(e.message || e.name), 300);
  return 'unknown error';
}

type Failure = 'offline' | 'draining' | 'other';

export class SyncEngine {
  readonly #debounceMs: number;
  readonly #maxWaitMs: number;
  readonly #stallMs: number;
  readonly #unreachableMs: number;
  readonly #backoff: (attempt: number) => number;
  readonly #now: () => number;

  #running = false;
  #stream: AbortController | null = null;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #firstPendingAt = 0;
  #refreshing: Promise<void> | null = null;
  #refreshAgain = false;
  #stallTimer: ReturnType<typeof setTimeout> | null = null;
  #sleepTimer: ReturnType<typeof setTimeout> | null = null;
  #wake: (() => void) | null = null;
  #listeners = new Set<(e: DomainEvent) => void>();
  /** The daemon answered 503 `COS-9001`: no re-reads until it answers normally again. */
  #draining = false;
  /** When the current run of failed connection attempts began; null while connected. */
  #failingSince: number | null = null;
  /** The last snapshot's `ui_api` differs from this bundle's. */
  #stale = false;

  constructor(
    private readonly api: FridayApi,
    private readonly store: FridayStore,
    private readonly dispatcher: Dispatcher,
    opts: SyncOptions = {},
  ) {
    this.#debounceMs = opts.debounceMs ?? 250;
    this.#maxWaitMs = opts.maxWaitMs ?? 1000;
    this.#stallMs = opts.stallMs ?? STALL_MS;
    this.#unreachableMs = opts.unreachableMs ?? UNREACHABLE_MS;
    this.#backoff = opts.backoff ?? defaultBackoff;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Every event after the dispatcher handled it (drawers that follow one task, sounds, tests). */
  onEvent(listener: (e: DomainEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get running(): boolean {
    return this.#running;
  }

  /** True while the daemon drains (503 `COS-9001`). */
  get draining(): boolean {
    return this.#draining;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#failingSince = null;
    this.store.patch('system', { connection: 'connecting', attempts: 0 });
    try {
      await this.#loadSnapshot();
    } catch (e) {
      if (this.#handleFatal(e)) return;
      const failure = this.#classify(e);
      if (failure === 'offline' && this.#failingSince === null) this.#failingSince = this.#now();
      this.store.patch('system', { connection: 'reconnecting', refreshing: false });
    }
    if (this.#running) void this.#loop();
  }

  /** Starts again after "not reachable" or "stopped" (the strip's Try again), from the last sequence. */
  retry(): Promise<void> {
    if (this.#running) return Promise.resolve();
    this.#draining = false;
    return this.start();
  }

  stop(): void {
    this.#running = false;
    this.#stream?.abort();
    this.#stream = null;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    if (this.#stallTimer) clearTimeout(this.#stallTimer);
    if (this.#sleepTimer) clearTimeout(this.#sleepTimer);
    this.#refreshTimer = null;
    this.#stallTimer = null;
    this.#sleepTimer = null;
    this.#firstPendingAt = 0;
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  /** Reads the snapshot now (after a command the interface sent, for example). */
  refresh(): Promise<void> {
    if (!this.#running) return Promise.resolve();
    return this.#refreshNow();
  }

  /** Schedules a debounced re-read. */
  scheduleRefresh(): void {
    if (this.#draining || !this.#running) return;
    const now = this.#now();
    if (!this.#firstPendingAt) this.#firstPendingAt = now;
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    const wait = Math.max(0, Math.min(this.#debounceMs, this.#firstPendingAt + this.#maxWaitMs - now));
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      this.#firstPendingAt = 0;
      void this.#refreshNow();
    }, wait);
  }

  // ------------------------------------------------------------------------------------------

  async #loadSnapshot(): Promise<void> {
    const board = await this.api.snapshot();
    this.#applySnapshot(board);
  }

  #applySnapshot(raw: UiSnapshot): void {
    const board = this.dispatcher.reconcile(raw);
    this.#draining = false;
    this.#stale = board.ui_api !== UI_API;
    const system = this.store.select('system');
    // A snapshot never moves the cursor backwards: events after it are still applied.
    const sequence = Math.max(system.sequence, board.head);
    // While live, a good read clears what an earlier read reported; while reconnecting, the
    // stream's own error stays until the stream opens.
    const lastError = this.#stale
      ? STALE_PAGE_MESSAGE
      : system.connection === 'live' || system.lastError === STALE_PAGE_MESSAGE || system.lastError === STOPPING_MESSAGE
        ? null
        : system.lastError;
    this.store.setState({
      board,
      system: { ...system, sequence, snapshotAt: this.#now(), refreshing: false, lastError },
    });
  }

  async #refreshNow(): Promise<void> {
    if (this.#draining) return;
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return this.#refreshing;
    }
    this.store.patch('system', { refreshing: true });
    this.#refreshing = (async () => {
      try {
        await this.#loadSnapshot();
      } catch (e) {
        if (!this.#handleFatal(e)) {
          this.#classify(e);
          this.store.patch('system', { refreshing: false });
        }
      } finally {
        this.#refreshing = null;
        if (this.#refreshAgain) {
          this.#refreshAgain = false;
          if (this.#running && !this.#draining) void this.#refreshNow();
        }
      }
    })();
    return this.#refreshing;
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      const controller = new AbortController();
      this.#stream = controller;
      const since = this.store.select('system').sequence;
      let failure: Failure = 'offline';
      this.#armStall(controller);
      try {
        const end = await this.api.transport.stream(
          this.api.streamPath(since),
          {
            onOpen: () => this.#opened(controller),
            onEvent: (e) => this.#ingest(e),
            onActivity: () => this.#armStall(controller),
          },
          controller.signal,
        );
        if (!this.#running) return;
        if (end === 'shutdown') {
          // Friday drained and is going away; a tab cannot follow it to another address.
          this.#end(UNREACHABLE_MESSAGE);
          return;
        }
        // 'closed': the connection dropped, or the watchdog dropped a silent stream.
      } catch (e) {
        if (this.#handleFatal(e)) return;
        failure = this.#classify(e);
      } finally {
        if (this.#stallTimer) clearTimeout(this.#stallTimer);
        this.#stallTimer = null;
        if (this.#stream === controller) this.#stream = null;
      }
      if (!this.#running) return;
      if (failure === 'offline') {
        const now = this.#now();
        if (this.#failingSince === null) this.#failingSince = now;
        else if (now - this.#failingSince >= this.#unreachableMs) {
          this.#end(UNREACHABLE_MESSAGE);
          return;
        }
      }
      const attempts = this.store.select('system').attempts + 1;
      this.store.patch('system', { connection: 'reconnecting', attempts });
      await this.#sleep(this.#backoff(attempts));
      // After a gap the snapshot is read again, so anything the stream did not show is current.
      if (this.#running && !this.#draining) await this.#refreshNow();
    }
  }

  #opened(controller: AbortController): void {
    if (this.#stream !== controller) return;
    const wasDraining = this.#draining;
    this.#failingSince = null;
    this.#draining = false;
    this.#armStall(controller);
    // Re-reads were held while the daemon drained; one that answers a stream again is current again.
    if (wasDraining) this.scheduleRefresh();
    this.store.patch('system', {
      connection: 'live',
      attempts: 0,
      lastError: this.#stale ? STALE_PAGE_MESSAGE : null,
    });
  }

  /** Friday is gone from this address: the engine stops until `retry`. */
  #end(message: string): void {
    this.store.patch('system', { connection: 'stopped', lastError: message, refreshing: false });
    this.stop();
  }

  /** Records what went wrong and says which kind of failure it was. */
  #classify(e: unknown): Failure {
    if (isDraining(e)) {
      this.#draining = true;
      if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
      this.#firstPendingAt = 0;
      this.store.patch('system', { lastError: STOPPING_MESSAGE });
      return 'draining';
    }
    if (e instanceof OfflineError) {
      // A daemon that was draining and now does not answer has stopped: keep saying so until
      // the unreachable rule speaks.
      const was = this.store.select('system').lastError;
      if (this.#draining && was === STOPPING_MESSAGE) return 'offline';
      this.store.patch('system', { lastError: this.#stale ? STALE_PAGE_MESSAGE : describe(e) });
      return 'offline';
    }
    this.store.patch('system', { lastError: this.#stale ? STALE_PAGE_MESSAGE : describe(e) });
    return e instanceof ApiError ? 'other' : 'offline';
  }

  #armStall(controller: AbortController): void {
    if (this.#stream !== controller) return;
    if (this.#stallTimer) clearTimeout(this.#stallTimer);
    this.#stallTimer = setTimeout(() => {
      this.#stallTimer = null;
      controller.abort();
    }, this.#stallMs);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        if (this.#sleepTimer) clearTimeout(this.#sleepTimer);
        this.#sleepTimer = null;
        this.#wake = null;
        resolve();
      };
      this.#wake = done;
      this.#sleepTimer = setTimeout(done, ms);
    });
  }

  #ingest(event: DomainEvent): void {
    const system = this.store.select('system');
    if (typeof event?.sequence !== 'number' || event.sequence <= system.sequence) return;
    this.store.patch('system', { sequence: event.sequence });
    const domain = this.dispatcher.handle(event, this.#now());
    if (domain) this.scheduleRefresh();
    for (const listener of [...this.#listeners]) listener(event);
  }

  /** A 401 ends the session: no retry until the user signs in again. */
  #handleFatal(e: unknown): boolean {
    if (e instanceof AuthError) {
      this.store.patch('system', { connection: 'signed-out', lastError: describe(e), refreshing: false });
      this.stop();
      return true;
    }
    return false;
  }
}
