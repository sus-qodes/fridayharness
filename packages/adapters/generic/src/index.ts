/**
 * @friday/adapter-generic
 * A harness-side client for the Friday harness protocol (spec Part 06). Any runtime that can
 * make HTTP requests can attach through it; FakeHarness in the test suite is built on it.
 */
import type {
  AttachMode,
  EnforcementLevel,
  MethodName,
  OutboundMessage,
  ParamsOf,
  ResultOf,
  Vendor,
} from '@friday/protocol';
import { CURRENT_PROTOCOL_VERSION, newId } from '@friday/protocol';
import type { DaemonClient } from '@friday/sdk';

export const PACKAGE_NAME = '@friday/adapter-generic';

/** Transport seam: HTTP today, possibly MCP or another carrier later (plan M1.7). */
export interface HarnessTransport {
  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
}

export class HttpTransport implements HarnessTransport {
  constructor(public client: DaemonClient) {}
  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    return this.client.rpc(method, params, method === 'harness.poll' ? { timeoutMs: 40_000 } : {});
  }
}

export interface HarnessDescriptor {
  harness_key: string;
  vendor: Vendor;
  name: string;
  version?: string;
  attach_mode: AttachMode;
  project_id: string;
  capabilities?: Record<string, unknown>;
  agent_key?: string;
  role?: string;
  host?: { pid?: number; session_id?: string; cwd?: string };
  enforcement_level?: EnforcementLevel;
  protocol_version?: string;
  heartbeat_interval_ms?: number;
}

export type Registration = ResultOf<'harness.register'>;
export type TaskHandler = (
  msg: OutboundMessage,
) => Promise<{ accepted: boolean; reason?: string; session_ref?: string }>;

/**
 * Registers with the bootstrap credential, then switches to the harness token it receives.
 * Every call after registration is attributed to this harness by the daemon, never by request fields.
 */
export class GenericHarnessClient {
  #transport: HarnessTransport;
  #registration: Registration | undefined;
  #heartbeat: NodeJS.Timeout | undefined;

  constructor(
    private readonly bootstrap: DaemonClient,
    readonly descriptor: HarnessDescriptor,
  ) {
    this.#transport = new HttpTransport(bootstrap);
  }

  get registration(): Registration {
    if (!this.#registration) throw new Error('not registered');
    return this.#registration;
  }

  get harnessId(): string {
    return this.registration.harness_id;
  }

  get agentId(): string {
    return this.registration.agent_id;
  }

  async register(): Promise<Registration> {
    const d = this.descriptor;
    const reg = await new HttpTransport(this.bootstrap).call('harness.register', {
      protocol_version: d.protocol_version ?? CURRENT_PROTOCOL_VERSION,
      harness_key: d.harness_key,
      vendor: d.vendor,
      name: d.name,
      ...(d.version ? { version: d.version } : {}),
      attach_mode: d.attach_mode,
      project_id: d.project_id,
      capabilities: d.capabilities ?? {},
      agent: { ...(d.agent_key ? { agent_key: d.agent_key } : {}), role: d.role ?? 'developer' },
      ...(d.host ? { host: d.host } : {}),
      ...(d.enforcement_level ? { enforcement_level: d.enforcement_level } : {}),
      ...(d.heartbeat_interval_ms ? { heartbeat_interval_ms: d.heartbeat_interval_ms } : {}),
    });
    this.#registration = reg;
    this.#transport = new HttpTransport(this.bootstrap.withToken(reg.harness_token, 'harness'));
    return reg;
  }

  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    return this.#transport.call(method, params);
  }

  heartbeat() {
    return this.call('harness.heartbeat', {});
  }

  /** Heartbeats on the lease interval until stopped. Errors are reported, not thrown. */
  startHeartbeat(onError: (e: unknown) => void = () => {}): () => void {
    this.stopHeartbeat();
    const every = this.registration.lease.heartbeat_interval_ms;
    this.#heartbeat = setInterval(() => {
      this.heartbeat().catch(onError);
    }, every);
    this.#heartbeat.unref();
    return () => this.stopHeartbeat();
  }

  stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  async poll(waitMs = 0, max = 10): Promise<OutboundMessage[]> {
    return (await this.call('harness.poll', { wait_ms: waitMs, max })).messages;
  }

  ack(acks: ParamsOf<'harness.ack'>['acks']) {
    return this.call('harness.ack', { acks });
  }

  /**
   * Delivery loop for spawn-mode harnesses: long-polls the outbox, hands each message to the
   * handler and acknowledges the outcome. Stops when the signal aborts.
   */
  async run(handler: TaskHandler, opts: { signal?: AbortSignal; waitMs?: number } = {}): Promise<void> {
    while (!opts.signal?.aborted) {
      let messages: OutboundMessage[];
      try {
        messages = await this.poll(opts.waitMs ?? 1000);
      } catch (e) {
        if (opts.signal?.aborted) return;
        throw e;
      }
      for (const m of messages) {
        const res = await handler(m);
        await this.ack([
          {
            message_id: m.message_id,
            accepted: res.accepted,
            ...(res.reason ? { reason: res.reason } : {}),
            ...(res.session_ref ? { session_ref: res.session_ref } : {}),
          },
        ]);
      }
    }
  }

  claim(p: ParamsOf<'task.claim'>) {
    return this.call('task.claim', { idempotency_key: newId('msg'), ...p });
  }
  update(p: ParamsOf<'task.update'>) {
    return this.call('task.update', p);
  }
  requestContext(p: ParamsOf<'context.request'>) {
    return this.call('context.request', p);
  }
  requestPermission(p: ParamsOf<'permission.request'>) {
    return this.call('permission.request', p);
  }
  emitEvent(p: ParamsOf<'agent.event'>) {
    return this.call('agent.event', p);
  }
  reportResult(p: Omit<ParamsOf<'agent.result'>, 'idempotency_key'> & { idempotency_key?: string }) {
    return this.call('agent.result', { idempotency_key: newId('msg'), ...p });
  }
  reportError(p: ParamsOf<'agent.error'>) {
    return this.call('agent.error', p);
  }
  communicate(p: ParamsOf<'communication.request'>) {
    return this.call('communication.request', p);
  }
  escalate(p: ParamsOf<'human.escalation'>) {
    return this.call('human.escalation', p);
  }

  async disconnect(reason = 'client_disconnect', final = false): Promise<void> {
    this.stopHeartbeat();
    if (this.#registration) await this.call('harness.disconnect', { reason, final });
  }
}
