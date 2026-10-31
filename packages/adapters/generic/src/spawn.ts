/**
 * What every spawn adapter does on Friday's side, whatever its host (ADR-0032 §1): it registers,
 * keeps its lease, serves Friday's instructions and reports how each run attempt ended. The
 * connection is supervised (review M8-R02, R05): a failed poll is tried again; when Friday has not
 * been heard for a whole lease, the adapter ends its hosts, since a cancellation would no longer
 * reach them, and stops its heartbeat, so Friday's recovery takes over; once Friday answers again,
 * the adapter registers again and Friday resumes its runs. A report of how an attempt ended is
 * kept until Friday records it, on disk when the adapter has a state folder.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type ErrorName, isFridayError, newId, type ParamsOf } from '@friday/protocol';
import type { DaemonClient } from '@friday/sdk';
import {
  backoff,
  GenericHarnessClient,
  type HarnessDescriptor,
  pause,
  type Registration,
  type TaskHandler,
  transient,
} from './index.js';

/** Friday no longer knows this registration: register again. */
const LOST: string[] = ['lease_expired', 'authentication_failed', 'token_revoked'];
/** Friday will never record a report it refused for one of these: it ends as an error instead. */
const UNRECORDABLE: ErrorName[] = ['invalid_request', 'schema_mismatch', 'payload_too_large'];

type ResultParams = Omit<ParamsOf<'agent.result'>, 'idempotency_key'>;
type ErrorParams = Omit<ParamsOf<'agent.error'>, 'idempotency_key'>;

/**
 * Something the attempt reported about itself as it ended (what the host said the turn cost,
 * `host.usage`), kept with the report of how it ended and recorded before it: the usage row of the
 * token baseline would otherwise show a verified attempt as one whose host said nothing whenever
 * Friday was out of reach at that moment.
 */
export interface KeptEvent {
  event_type: string;
  data: Record<string, unknown>;
}

/** How a run attempt ended, as Friday is told it; the key is the same on every try. */
export type TerminalReport = {
  idempotency_key: string;
  created_at: string;
  events?: KeptEvent[];
  cleanup_pending?: boolean;
} & ({ kind: 'result'; params: ResultParams } | { kind: 'error'; params: ErrorParams });

/**
 * What became of a report: recorded by Friday; parked until Friday resumes its run (`task.resume`),
 * because the run is not active now; or dropped, because Friday will never take it (the run ended,
 * or is not this harness's).
 */
export type ReportOutcome = 'recorded' | 'parked' | 'dropped';

/** Concurrent cancellation and a terminal report await the same process-group cleanup. */
export class AttemptStops {
  readonly #pending = new Map<string, Promise<void>>();
  run(runId: string, stop: () => Promise<void>): Promise<void> {
    const running = this.#pending.get(runId);
    if (running) return running;
    const pending = Promise.resolve().then(stop);
    this.#pending.set(runId, pending);
    void pending.finally(() => this.#pending.delete(runId)).catch(() => undefined);
    return pending;
  }
}

interface ReportOptions {
  events?: KeptEvent[];
  /** Resolves only after the attempt's worker and descendants stopped; rejects if unconfirmed. */
  stop?: () => Promise<void>;
}

/** Reports kept longer than this are no longer delivered: their runs are long settled. */
const KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Reports of how run attempts ended that Friday has not recorded yet (review M8-R05). Each is tried
 * with one idempotency key, so a report Friday recorded but whose answer was lost is recorded once,
 * whichever try got through.
 */
export class TerminalReports {
  readonly #pending = new Map<string, TerminalReport>();
  readonly #inFlight = new Map<string, Promise<ReportOutcome>>();
  readonly #settling = new Map<string, Promise<void>>();
  #closed = false;

  constructor(private readonly opts: { dir?: string; client: () => GenericHarnessClient; log: (msg: string) => void }) {
    if (!opts.dir) return;
    mkdirSync(opts.dir, { recursive: true });
    for (const f of readdirSync(opts.dir).filter((x) => x.endsWith('.json'))) {
      try {
        const r = JSON.parse(readFileSync(path.join(opts.dir, f), 'utf8')) as TerminalReport;
        if (Date.now() - Date.parse(r.created_at) > KEEP_MS) rmSync(path.join(opts.dir, f), { force: true });
        else if (r.cleanup_pending) {
          this.#keep({
            ...r,
            kind: 'error',
            cleanup_pending: false,
            params: {
              task_id: r.params.task_id,
              run_id: r.params.run_id,
              message: 'adapter restarted before worker termination was confirmed',
              fatal: true,
              worker_stopped: false,
              failure: { kind: 'transport' },
            },
          });
        } else this.#pending.set(r.params.run_id, r);
      } catch {
        // not a report this adapter wrote
      }
    }
  }

  /** Whether the end of a run attempt is waiting to be reported. */
  has(runId: string): boolean {
    return this.#pending.has(runId);
  }

  /**
   * Records how an attempt ended (on disk first, when kept there), with what it reported about
   * itself (`events`, recorded before the report), and delivers it.
   */
  report(kind: 'result', params: ResultParams, opts?: ReportOptions): Promise<ReportOutcome>;
  report(kind: 'error', params: ErrorParams, opts?: ReportOptions): Promise<ReportOutcome>;
  report(
    kind: 'result' | 'error',
    params: ResultParams | ErrorParams,
    opts: ReportOptions = {},
  ): Promise<ReportOutcome> {
    this.#keep({
      kind,
      params,
      idempotency_key: newId('msg'),
      created_at: new Date().toISOString(),
      ...(opts.stop ? { cleanup_pending: true } : {}),
      ...(opts.events?.length ? { events: [...opts.events] } : {}),
    } as TerminalReport);
    if (opts.stop) {
      const kept = this.#pending.get(params.run_id) as TerminalReport;
      const settle = Promise.resolve()
        .then(opts.stop)
        .then(
          () => {
            if (this.#pending.get(params.run_id) !== kept) return;
            kept.cleanup_pending = false;
            if (kept.kind === 'error') kept.params.worker_stopped = true;
            this.#keep(kept);
          },
          (e: Error) => {
            this.opts.log(`worker termination for ${params.task_id} is unconfirmed: ${e.message}`);
            if (this.#pending.get(params.run_id) !== kept) return;
            kept.cleanup_pending = false;
            if (kept.kind === 'error') {
              kept.params.worker_stopped = false;
              this.#keep(kept);
            } else {
              // A worker that can still change the tree cannot submit it for verification.
              this.#keep({
                ...kept,
                kind: 'error',
                params: {
                  task_id: params.task_id,
                  run_id: params.run_id,
                  message: `worker termination is unconfirmed: ${e.message}`.slice(0, 2000),
                  fatal: true,
                  worker_stopped: false,
                  failure: { kind: 'transport' },
                },
              });
            }
          },
        );
      this.#settling.set(params.run_id, settle);
    }
    return this.deliver(params.run_id);
  }

  /** Delivers what is waiting for a run until Friday records it, parks it, or refuses it for good. */
  deliver(runId: string): Promise<ReportOutcome> {
    const running = this.#inFlight.get(runId);
    if (running) return running;
    const p = this.#deliver(runId).finally(() => this.#inFlight.delete(runId));
    this.#inFlight.set(runId, p);
    return p;
  }

  async #deliver(runId: string): Promise<ReportOutcome> {
    await this.#settling.get(runId);
    this.#settling.delete(runId);
    for (let attempt = 1; ; attempt += 1) {
      const r = this.#pending.get(runId);
      if (!r) return 'dropped';
      try {
        const client = this.opts.client();
        // What the attempt reported about itself goes first, each once Friday took it. An event has
        // no idempotency key: one whose answer was lost after Friday recorded it is sent again, and
        // the usage row reads a repeated `host.usage` as one (its last report counts).
        while (r.events?.length) {
          const [ev] = r.events as [KeptEvent, ...KeptEvent[]];
          try {
            await client.call('agent.event', {
              task_id: r.params.task_id,
              run_id: r.params.run_id,
              event_type: ev.event_type,
              data: ev.data,
            });
          } catch (e) {
            // Friday out of reach, or this registration being renewed: tried again with the report.
            if (transient(e) || (isFridayError(e) && LOST.includes(e.errorName))) throw e;
            // Anything else Friday will never take (the run is another session's now): the report
            // itself decides what becomes of the attempt.
            this.opts.log(`Friday did not take the ${ev.event_type} of ${r.params.task_id}: ${(e as Error).message}`);
          }
          r.events.shift();
          this.#keep(r);
        }
        if (r.kind === 'result') await client.call('agent.result', { ...r.params, idempotency_key: r.idempotency_key });
        else await client.call('agent.error', { ...r.params, idempotency_key: r.idempotency_key });
        this.drop(runId);
        return 'recorded';
      } catch (e) {
        if (this.#closed) return 'parked';
        const why = (e as Error).message;
        if (transient(e) || (isFridayError(e) && LOST.includes(e.errorName))) {
          // Friday is not reachable, or this registration is being renewed: the next try finds out.
          this.opts.log(`could not report how ${r.params.task_id} ended yet: ${why}`);
          await pause(backoff(attempt, 10_000));
          continue;
        }
        if (isFridayError(e, 'invalid_state_transition')) {
          // The run is not active (Friday judged this harness lost): delivered when it is resumed.
          this.opts.log(`keeping how ${r.params.task_id} ended until Friday resumes its run: ${why}`);
          return 'parked';
        }
        if (r.kind === 'result' && UNRECORDABLE.some((n) => isFridayError(e, n))) {
          // Friday will never record this result: the attempt ends as an error, and Friday's recovery decides.
          this.#keep({
            kind: 'error',
            params: {
              task_id: r.params.task_id,
              run_id: r.params.run_id,
              message: `Friday could not record the result: ${why}`.slice(0, 2000),
              fatal: true,
            },
            idempotency_key: newId('msg'),
            created_at: new Date().toISOString(),
          });
          continue;
        }
        this.opts.log(`Friday will not take how ${r.params.task_id} ended: ${why}`);
        this.drop(runId);
        return 'dropped';
      }
    }
  }

  /** Forgets a run's report (its task was cancelled, or Friday took another course). */
  drop(runId: string): void {
    this.#pending.delete(runId);
    if (this.opts.dir) rmSync(path.join(this.opts.dir, `${runId}.json`), { force: true });
  }

  /** Stops trying; what is kept on disk stays for the next start. */
  close(): void {
    this.#closed = true;
  }

  /** Tries again after `close` (the adapter came back). */
  reopen(): void {
    this.#closed = false;
  }

  #keep(r: TerminalReport): void {
    this.#pending.set(r.params.run_id, r);
    if (this.opts.dir) writeFileSync(path.join(this.opts.dir, `${r.params.run_id}.json`), JSON.stringify(r));
  }
}

export interface SpawnLinkOptions {
  /** The project's daemon, with the bootstrap token. */
  bootstrap: DaemonClient;
  descriptor: () => HarnessDescriptor;
  /** Serves one instruction from Friday. */
  handle: TaskHandler;
  /** Ends the host of every attempt: the adapter no longer hears Friday (review M8-R02). */
  fence: (why: string) => Promise<void>;
  /** Where reports that did not get through wait across restarts (review M8-R05). */
  stateDir?: string;
  log: (msg: string) => void;
  /** How long each poll waits for an instruction. */
  waitMs?: number;
}

/** A spawn adapter's connection to Friday. */
export class SpawnLink {
  client: GenericHarnessClient;
  readonly reports: TerminalReports;
  #loop: AbortController | undefined;
  #loopDone: Promise<void> | undefined;
  #reconnecting: Promise<void> | undefined;
  #fenced = false;
  #closed = false;
  readonly #preparing = new Map<string, Promise<Awaited<ReturnType<TaskHandler>>>>();

  constructor(private readonly opts: SpawnLinkOptions) {
    this.client = new GenericHarnessClient(opts.bootstrap, opts.descriptor());
    this.reports = new TerminalReports({
      ...(opts.stateDir ? { dir: path.join(opts.stateDir, 'reports') } : {}),
      client: () => this.client,
      log: opts.log,
    });
  }

  /** Registers, keeps the lease, and serves Friday's instructions until closed. */
  async start(): Promise<Registration> {
    const reg = await this.client.register();
    this.#fenced = false;
    const client = this.client;
    client.startHeartbeat((e) => {
      if (isFridayError(e) && LOST.includes(e.errorName)) {
        // The daemon restarted, or judged this harness lost: it comes back as the same harness,
        // and Friday resumes its runs (ADR-0032 §1).
        this.opts.log(`lost the lease (${e.code}); registering again`);
        client.stopHeartbeat();
        void this.#renew();
      } else {
        this.opts.log(`heartbeat failed: ${(e as Error).message}`);
      }
    });
    this.#startLoop(reg.lease.ttl_ms);
    return reg;
  }

  #startLoop(leaseMs: number): void {
    const ctrl = new AbortController();
    this.#loop = ctrl;
    this.#loopDone = this.client
      .run((message, signal) => this.#handle(message, signal), {
        signal: ctrl.signal,
        waitMs: this.opts.waitMs ?? 500,
        onTrouble: (e, failingForMs) => {
          if (isFridayError(e) && LOST.includes(e.errorName)) {
            this.opts.log(`Friday no longer knows this registration (${e.code}); registering again`);
            void this.#renew();
            return;
          }
          this.opts.log(`could not reach Friday for instructions: ${(e as Error).message}`);
          if (failingForMs < leaseMs || this.#fenced) return;
          // Cancellations no longer reach this adapter: its hosts stop, and Friday, no longer
          // hearing from it, recovers their runs; it resumes them once it hears from it again.
          this.#fenced = true;
          this.client.stopHeartbeat();
          this.opts.log(`Friday not heard for ${Math.round(failingForMs / 1000)} s: ending this adapter's work`);
          void this.opts.fence('Friday was not heard for a whole lease');
        },
        onRecovered: () => {
          if (this.#fenced) void this.#renew();
        },
        onHandlerError: async (error, message) => {
          this.#fenced = true;
          this.client.stopHeartbeat();
          this.opts.log(`could not start ${message.message_id}: ${(error as Error).message}; stopping workers`);
          await this.opts.fence('the start callback failed');
          if (!this.#closed) void this.#renew();
        },
      })
      .catch(async (e: Error) => {
        this.#fenced = true;
        this.client.stopHeartbeat();
        this.opts.log(`delivery loop stopped: ${e.message}; stopping workers`);
        await this.opts.fence('the instruction channel stopped');
      });
  }

  async #stopLoop(): Promise<void> {
    this.#loop?.abort();
    await this.#loopDone;
    this.#loop = undefined;
    this.#loopDone = undefined;
  }

  /** A renewal cannot prepare the same run before its abandoned startup has cleaned up. */
  #handle(message: Parameters<TaskHandler>[0], signal?: AbortSignal): ReturnType<TaskHandler> {
    if (message.method === 'task.cancel') return this.opts.handle(message, signal);
    const runId = String(message.params.run_id ?? message.message_id);
    const earlier = this.#preparing.get(runId);
    const prepared = (async () => {
      await earlier?.catch(() => undefined);
      if (signal?.aborted) return { accepted: false };
      const answer = await this.opts.handle(message, signal);
      if (signal?.aborted) {
        await answer.afterAck?.(false, 'aborted');
        return { accepted: false };
      }
      return answer;
    })();
    this.#preparing.set(runId, prepared);
    void prepared
      .finally(() => {
        if (this.#preparing.get(runId) === prepared) this.#preparing.delete(runId);
      })
      .catch(() => undefined);
    return prepared;
  }

  /**
   * Comes back as the same harness, trying until Friday answers; Friday resumes its runs. Called
   * from outside, it also brings back a link that was closed (an adapter started again).
   */
  reconnect(): Promise<void> {
    this.#closed = false;
    this.reports.reopen();
    return this.#renew();
  }

  /** Registers again, once at a time, until it works or the link is closed. */
  #renew(): Promise<void> {
    this.#reconnecting ??= (async () => {
      try {
        await this.#stopLoop();
        this.client.stopHeartbeat();
        for (let attempt = 1; !this.#closed; attempt += 1) {
          this.client = new GenericHarnessClient(this.opts.bootstrap, this.opts.descriptor());
          try {
            await this.start();
            return;
          } catch (e) {
            this.opts.log(`could not register again: ${(e as Error).message}`);
            await pause(backoff(attempt, 10_000));
          }
        }
      } finally {
        this.#reconnecting = undefined;
      }
    })();
    return this.#reconnecting;
  }

  /** Stops like a crashed process: nothing is told to Friday. */
  async crash(): Promise<void> {
    this.#closed = true;
    this.reports.close();
    this.client.stopHeartbeat();
    await this.#stopLoop();
  }

  /** Tells Friday this harness is leaving. */
  async close(reason: string): Promise<void> {
    this.#closed = true;
    this.reports.close();
    this.client.stopHeartbeat();
    await this.#stopLoop();
    await this.client.disconnect(reason).catch(() => undefined);
  }
}
