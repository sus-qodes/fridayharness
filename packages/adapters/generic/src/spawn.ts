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

/** How a run attempt ended, as Friday is told it; the key is the same on every try. */
export type TerminalReport = { idempotency_key: string; created_at: string } & (
  | { kind: 'result'; params: ResultParams }
  | { kind: 'error'; params: ErrorParams }
);

/**
 * What became of a report: recorded by Friday; parked until Friday resumes its run (`task.resume`),
 * because the run is not active now; or dropped, because Friday will never take it (the run ended,
 * or is not this harness's).
 */
export type ReportOutcome = 'recorded' | 'parked' | 'dropped';

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
  #closed = false;

  constructor(private readonly opts: { dir?: string; client: () => GenericHarnessClient; log: (msg: string) => void }) {
    if (!opts.dir) return;
    mkdirSync(opts.dir, { recursive: true });
    for (const f of readdirSync(opts.dir).filter((x) => x.endsWith('.json'))) {
      try {
        const r = JSON.parse(readFileSync(path.join(opts.dir, f), 'utf8')) as TerminalReport;
        if (Date.now() - Date.parse(r.created_at) > KEEP_MS) rmSync(path.join(opts.dir, f), { force: true });
        else this.#pending.set(r.params.run_id, r);
      } catch {
        // not a report this adapter wrote
      }
    }
  }

  /** Whether the end of a run attempt is waiting to be reported. */
  has(runId: string): boolean {
    return this.#pending.has(runId);
  }

  /** Records how an attempt ended (on disk first, when kept there), and delivers it. */
  report(kind: 'result', params: ResultParams): Promise<ReportOutcome>;
  report(kind: 'error', params: ErrorParams): Promise<ReportOutcome>;
  report(kind: 'result' | 'error', params: ResultParams | ErrorParams): Promise<ReportOutcome> {
    this.#keep({ kind, params, idempotency_key: newId('msg'), created_at: new Date().toISOString() } as TerminalReport);
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
    for (let attempt = 1; ; attempt += 1) {
      const r = this.#pending.get(runId);
      if (!r) return 'dropped';
      try {
        const client = this.opts.client();
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
      .run(this.opts.handle, {
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
      })
      .catch((e: Error) => this.opts.log(`delivery loop stopped: ${e.message}`));
  }

  async #stopLoop(): Promise<void> {
    this.#loop?.abort();
    await this.#loopDone;
    this.#loop = undefined;
    this.#loopDone = undefined;
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
