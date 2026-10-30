import { GenericHarnessClient, type HarnessDescriptor, type TaskHandler } from '@friday/adapter-generic';
import { CURRENT_PROTOCOL_VERSION, type OutboundMessage } from '@friday/protocol';
import type { ConformanceHarness } from '../conformance/harness-conformance.js';
import type { TestDaemon } from './daemon.js';

/**
 * The models a scripted generic host says it can run. The static role registry dispatches only to
 * a model the harness declares (ADR-0031): a generic host that names none never gets work.
 */
export const TEST_HOST_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-5.6-luna'];

export interface FakeHarnessOptions {
  key?: string;
  /** The host it registers as; `generic` unless a test is about one host's readiness. */
  vendor?: HarnessDescriptor['vendor'];
  agentKey?: string;
  /** Agent role the Master Brain's delegation matches against ("backend", "qa", …). */
  role?: string;
  mode?: 'spawn' | 'attach';
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  sessionId?: string;
  /** Decides how to answer task.start / task.resume (default: accept). */
  onMessage?: TaskHandler;
  /** Run the outbox delivery loop in the background (default: true for spawn mode). */
  loop?: boolean;
  /** Keep simulated work running after `task.cancel` (a host that ignores cancellation). */
  ignoreCancel?: boolean;
  /**
   * The level this simulated adapter reports (default L1, like Friday's own spawn adapters; null
   * reports nothing). The daemon records it as "reported", never as observed evidence.
   */
  enforcement?: 'L0' | 'L1' | 'L2' | null;
}

let counter = 0;

/**
 * A scriptable harness that speaks the real protocol over HTTP (plan M1.7). It never touches
 * files; tests use it to drive the daemon the way an actual harness adapter would.
 */
export class FakeHarness implements ConformanceHarness {
  readonly received: OutboundMessage[] = [];
  /** Simulated host work per task: a counter that grows every 20 ms while the task runs. */
  readonly #work = new Map<string, { count: number; timer: ReturnType<typeof setInterval> }>();
  client: GenericHarnessClient;
  #loop: AbortController | undefined;
  #loopDone: Promise<void> | undefined;

  private constructor(
    private readonly td: TestDaemon,
    private readonly descriptor: HarnessDescriptor,
    private readonly opts: FakeHarnessOptions,
  ) {
    this.client = new GenericHarnessClient(td.bootstrap, descriptor);
  }

  static async connect(td: TestDaemon, opts: FakeHarnessOptions = {}): Promise<FakeHarness> {
    counter += 1;
    const descriptor: HarnessDescriptor = {
      harness_key: opts.key ?? `fake:${process.pid}:${counter}`,
      vendor: opts.vendor ?? 'generic',
      name: 'FakeHarness',
      version: '0.0.0-test',
      attach_mode: opts.mode ?? 'spawn',
      project_id: td.project.project_id,
      capabilities: opts.capabilities ?? {
        task_start: true,
        task_cancel: true,
        context_request: true,
        reconnect: true,
        // A generic host states the models it can run; Friday never assumes them.
        models: TEST_HOST_MODELS,
      },
      ...(opts.agentKey ? { agent_key: opts.agentKey } : {}),
      ...(opts.role ? { role: opts.role } : {}),
      ...(opts.sessionId ? { host: { session_id: opts.sessionId, pid: process.pid } } : {}),
      ...(opts.enforcement === null ? {} : { enforcement_level: opts.enforcement ?? 'L1' }),
      protocol_version: opts.protocolVersion ?? CURRENT_PROTOCOL_VERSION,
    };
    const h = new FakeHarness(td, descriptor, opts);
    await h.client.register();
    if (opts.loop ?? (opts.mode ?? 'spawn') === 'spawn') h.startLoop();
    return h;
  }

  get harnessId(): string {
    return this.client.harnessId;
  }
  get agentId(): string {
    return this.client.agentId;
  }
  get token(): string {
    return this.client.registration.harness_token;
  }

  startLoop(): void {
    if (this.#loop) return;
    const ctrl = new AbortController();
    this.#loop = ctrl;
    const handler: TaskHandler = async (m) => {
      this.received.push(m);
      const taskId = (m.params as { task_id?: string }).task_id;
      if (m.method === 'task.cancel' && taskId && !this.opts.ignoreCancel) this.#stopWork(taskId);
      const answer = this.opts.onMessage
        ? await this.opts.onMessage(m)
        : { accepted: true, session_ref: `fake-session-${this.harnessId}` };
      if ((m.method === 'task.start' || m.method === 'task.resume') && taskId && answer.accepted)
        this.#startWork(taskId);
      return answer;
    };
    this.#loopDone = this.client.run(handler, { signal: ctrl.signal, waitMs: 500 }).catch(() => undefined);
  }

  async stopLoop(): Promise<void> {
    this.#loop?.abort();
    await this.#loopDone;
    this.#loop = undefined;
    this.#loopDone = undefined;
  }

  /** Waits until a message with this method arrived (or times out). */
  /** The first message of a method received so far (or the first matching `where`), waiting up to `timeoutMs`. */
  async waitFor(
    method: OutboundMessage['method'],
    timeoutMs = 5000,
    where: (m: OutboundMessage) => boolean = () => true,
  ): Promise<OutboundMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.received.find((m) => m.method === method && where(m));
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`FakeHarness: no ${method} within ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  workDone(taskId: string): number {
    return this.#work.get(taskId)?.count ?? 0;
  }

  #startWork(taskId: string): void {
    if (this.#work.get(taskId)?.timer) return;
    const entry = { count: this.#work.get(taskId)?.count ?? 0, timer: setInterval(() => (entry.count += 1), 20) };
    entry.timer.unref?.();
    this.#work.set(taskId, entry);
  }

  #stopWork(taskId?: string): void {
    for (const [id, w] of this.#work) {
      if (taskId && id !== taskId) continue;
      clearInterval(w.timer);
      this.#work.set(id, { count: w.count, timer: undefined as unknown as ReturnType<typeof setInterval> });
    }
  }

  /** Simulates a crash: stops polling and heartbeats without telling the daemon; its work dies with it. */
  async crash(): Promise<void> {
    this.#stopWork();
    this.client.stopHeartbeat();
    await this.stopLoop();
  }

  /** Re-registers with the same harness key (same session coming back). */
  async reconnect(): Promise<void> {
    await this.stopLoop();
    this.client = new GenericHarnessClient(this.td.bootstrap, this.descriptor);
    await this.client.register();
    if (this.opts.loop ?? (this.opts.mode ?? 'spawn') === 'spawn') this.startLoop();
  }

  /** Sends an arbitrary JSON-RPC body with any token (protocol-abuse tests). */
  async rawRpc(
    method: string,
    params: unknown,
    token: string = this.token,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${this.td.url}/protocol/v1/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'raw-1', method, params }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async close(): Promise<void> {
    this.#stopWork();
    await this.stopLoop();
    await this.client.disconnect('test done').catch(() => undefined);
  }
}
