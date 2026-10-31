import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { GenericHarnessClient } from '@friday/adapter-generic';
import { type InteractiveProcess, type ProcessGroup, ProcessGroups, runProcess, startProcess } from '@friday/execution';
import type { DaemonClient } from '@friday/sdk';
import { PolicyBridge, type ToolCheck } from './bridge.js';
import {
  type ControlledProfile,
  createControlledProfile,
  type InferenceSettings,
  LEVEL_NOTE,
  LOCAL_PROVIDER,
  OPENCODE_VERSION,
  verifyEffectiveConfig,
} from './profile.js';

/** Polls of a prompting session in a row that may go unanswered (about two minutes) before it counts as lost. */
const POLL_MISSES = 8;

export interface OpenCodeSpawnOptions {
  bootstrap: DaemonClient;
  projectId: string;
  agentKey: string;
  cwd: string;
  host: { command: string; args?: readonly string[] };
  dependenciesDir: string;
  workDir?: string;
  hostEnv?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  checkTimeoutMs?: number;
  /**
   * Checkpoint C only (plan M8b.6, approved by the owner): a model on this machine. Without it the
   * adapter is the A/B no-model preflight and sends no prompt.
   */
  inference?: InferenceSettings;
  /** Checkpoint C only: MCP servers the profile declares (a mock whose tool Friday must refuse). */
  mcp?: Record<string, Record<string, unknown>>;
  /**
   * For the live check only: makes the policy check fail (`error`) or never answer (`hang`), to show
   * that a failing check blocks the call. Production leaves it unset.
   */
  checkFault?: () => 'none' | 'error' | 'hang';
  /**
   * The worker's attempts (plan M14.4): the worker is the harness, so the attempt's server registers
   * nothing of its own (`register: false`) and its calls are judged by `check`, which names the task
   * and run. The A/B/C adapter registers and judges with its own registration.
   */
  register?: boolean;
  check?: ToolCheck;
  /** The title of the bound session. */
  title?: string;
}

/**
 * Checkpoints A/B: starts a controlled server/session and never submits a model prompt. With
 * `inference` (checkpoint C, plan M8b.6), the same controlled server talks to a model on this
 * machine, for the live enforcement check.
 */
export class OpenCodeSpawnAdapter {
  readonly #groups = new ProcessGroups();
  readonly #bridge: PolicyBridge;
  #profile: ControlledProfile | undefined;
  #group: ProcessGroup | undefined;
  #process: InteractiveProcess | undefined;
  #client: GenericHarnessClient | undefined;
  #url = '';
  #password = randomBytes(32).toString('hex');
  #closed = false;
  #closing: Promise<void> | undefined;
  sessionId: string | undefined;
  constructor(private readonly opts: OpenCodeSpawnOptions) {
    this.#bridge = new PolicyBridge(async (params) => {
      if (this.#closed || (!opts.check && !this.#client)) throw new Error('Friday is not connected');
      const fault = opts.checkFault?.() ?? 'none';
      if (fault === 'error') throw new Error('the policy check failed (injected)');
      if (fault === 'hang') await new Promise<never>(() => undefined);
      if (opts.check) return opts.check(params);
      return (this.#client as GenericHarnessClient).call('tool.check', params);
    }, opts.checkTimeoutMs ?? 4000);
  }
  get client(): GenericHarnessClient {
    if (!this.#client) throw new Error('OpenCode preflight has not registered');
    return this.#client;
  }
  get registration() {
    return this.client.registration;
  }
  get harnessId(): string {
    return this.client.harnessId;
  }
  get profileDir(): string | undefined {
    return this.#profile?.dir;
  }

  async start(): Promise<{ session_id: string; level: string; model_calls: 0 }> {
    if (this.#profile || this.#closed) throw new Error('adapter already started or closed');
    try {
      const cwd = realpathSync(this.opts.cwd);
      const command = realpathSync(this.opts.host.command);
      const relative = path.relative(cwd, command);
      if (
        !path.isAbsolute(this.opts.host.command) ||
        /\.(cmd|bat|ps1)$/i.test(command) ||
        relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative))
      )
        throw new Error('OpenCode executable must be outside the project and start without a shell');
      for (const arg of this.opts.host.args ?? []) {
        if (existsSync(arg)) {
          const rel = path.relative(cwd, realpathSync(arg));
          if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)))
            throw new Error('host startup files must be outside the project');
        }
      }
      await this.#bridge.open();
      const profile = createControlledProfile({
        cwd,
        command,
        dependenciesDir: this.opts.dependenciesDir,
        ...(this.opts.workDir ? { baseDir: this.opts.workDir } : {}),
        bridge: {
          url: this.#bridge.url,
          secret: this.#bridge.secret,
          nonce: this.#bridge.nonce,
          timeoutMs: this.opts.checkTimeoutMs ?? 4000,
        },
        ...(this.opts.hostEnv ? { env: this.opts.hostEnv } : {}),
        ...(this.opts.inference ? { inference: this.opts.inference } : {}),
        ...(this.opts.mcp ? { mcp: this.opts.mcp } : {}),
      });
      this.#profile = profile;
      this.#bridge.setProfile(profile);
      const versionGroup = this.#groups.create();
      const version = await runProcess({
        command,
        args: [...(this.opts.host.args ?? []), '--version'],
        cwd,
        env: profile.env,
        group: versionGroup,
        timeoutMs: this.opts.startupTimeoutMs ?? 15000,
        maxOutputChars: 2000,
      });
      await versionGroup.close();
      if (version.exit_code !== 0 || version.output.trim() !== OPENCODE_VERSION)
        throw new Error(`controlled OpenCode launch requires exactly ${OPENCODE_VERSION}`);
      const env = { ...profile.env, OPENCODE_SERVER_PASSWORD: this.#password };
      this.#group = this.#groups.create();
      this.#process = startProcess({
        command,
        args: [...(this.opts.host.args ?? []), 'serve', '--hostname', '127.0.0.1', '--port', '0'],
        cwd,
        env,
        group: this.#group,
        onLine: (line) => {
          const match = /^opencode server listening on (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
          if (match) this.#url = match[1] as string;
        },
      });
      const end = Date.now() + (this.opts.startupTimeoutMs ?? 15000);
      let exited = false;
      void this.#process.exited.then(() => {
        exited = true;
      });
      while (!this.#url) {
        if (exited || Date.now() >= end) throw new Error('OpenCode server did not become ready');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const health = (await this.#request('/global/health')) as { version?: unknown; healthy?: unknown };
      if (health.version !== OPENCODE_VERSION || health.healthy !== true)
        throw new Error('OpenCode health/version mismatch');
      verifyEffectiveConfig(await this.#request('/config'), profile);
      if (!this.#bridge.ready) throw new Error('Friday policy plugin is missing or failed to initialize');
      const session = (await this.#request('/session', 'POST', {
        title: this.opts.title ?? (this.opts.inference ? 'Friday checkpoint C' : 'Friday no-model preflight'),
      })) as {
        id?: unknown;
        directory?: unknown;
      };
      if (typeof session.id !== 'string' || !session.id || session.directory !== cwd)
        throw new Error('OpenCode returned no bound session');
      this.sessionId = session.id;
      if (this.opts.register === false) {
        // The worker's attempt: the worker is the harness; the session is bound before any call.
        this.#bridge.bind(session.id);
        profile.verify();
        return { session_id: session.id, level: LEVEL_NOTE, model_calls: 0 };
      }
      this.#client = new GenericHarnessClient(this.opts.bootstrap, {
        harness_key: `opencode:${this.opts.projectId}:${this.opts.agentKey}`,
        vendor: 'opencode',
        name: this.opts.inference ? 'OpenCode (checkpoint C, local model)' : 'OpenCode (A/B preflight)',
        version: OPENCODE_VERSION,
        attach_mode: 'spawn',
        project_id: this.opts.projectId,
        agent_key: this.opts.agentKey,
        enforcement_level: 'L1',
        capabilities: { experimental: true, model_calls: Boolean(this.opts.inference) },
        host: { session_id: session.id, cwd },
      });
      await this.#client.register();
      this.#client.startHeartbeat();
      // Registration and the explicit session ID precede every permitted policy check.
      this.#bridge.bind(session.id);
      profile.verify();
      return { session_id: session.id, level: LEVEL_NOTE, model_calls: 0 };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /**
   * Sends one prompt to a session and waits until the model has finished with it: only with
   * checkpoint C's local model (plan M8b.6). The prompt goes out asynchronously
   * (`POST /session/:id/prompt_async`) and the session is then watched until the host reports it idle
   * with its last answer complete, so a model that takes minutes never meets an HTTP time limit; past
   * `timeoutMs` the session is stopped. The bound session by default; another session is for showing
   * that its calls are refused. Without a model there is no prompt transport.
   */
  submitPrompt(text?: string, opts: { sessionId?: string; timeoutMs?: number } = {}): Promise<unknown> {
    const inference = this.opts.inference;
    if (!inference || typeof text !== 'string')
      throw new Error('OpenCode model execution is disabled until checkpoint C is authorized');
    const session = opts.sessionId ?? this.sessionId;
    if (!session || this.#closed) throw new Error('OpenCode has no session to prompt');
    return this.#prompt(session, text, inference.model, opts.timeoutMs ?? 600_000);
  }

  async #prompt(session: string, text: string, model: string, timeoutMs: number): Promise<unknown> {
    type Message = { info?: { role?: string; time?: { completed?: number } } };
    const before = ((await this.messages(session)) as Message[]).length;
    await this.#request(`/session/${encodeURIComponent(session)}/prompt_async`, 'POST', {
      parts: [{ type: 'text', text }],
      model: { providerID: LOCAL_PROVIDER, modelID: model },
    });
    const end = Date.now() + timeoutMs;
    let silent = 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      let busy: boolean;
      let messages: Message[];
      try {
        const status = ((await this.#request('/session/status')) ?? {}) as Record<string, { type?: string }>;
        busy = (status[session]?.type ?? 'idle') !== 'idle';
        messages = (await this.messages(session)) as Message[];
        silent = 0;
      } catch (e) {
        if (this.#closed) throw e;
        // While a model on this machine takes every processor, the host can miss one poll's time
        // limit; the session is lost only when it stays silent for minutes (LESSONS HX-41).
        silent += 1;
        if (Date.now() >= end) {
          await this.abort(session);
          throw new Error('the model did not finish in time; the session was stopped');
        }
        if (silent >= POLL_MISSES) throw new Error(`OpenCode stopped answering (${(e as Error).message})`);
        continue;
      }
      const answer = messages
        .slice(before)
        .filter((m) => m.info?.role === 'assistant')
        .at(-1);
      if (!busy && answer?.info?.time?.completed) return messages;
      if (Date.now() >= end) {
        await this.abort(session);
        throw new Error('the model did not finish in time; the session was stopped');
      }
    }
  }

  /**
   * A new session that takes over the binding (checkpoint C): the session it replaces is stopped and
   * loses its authority, so each scenario of the live check starts from a fresh conversation.
   */
  async newSession(): Promise<string> {
    if (!this.opts.inference || !this.#profile) throw new Error('only checkpoint C opens a new bound session');
    await this.abort();
    const session = (await this.#request('/session', 'POST', { title: 'Friday checkpoint C' })) as {
      id?: unknown;
      directory?: unknown;
    };
    if (typeof session.id !== 'string' || !session.id || session.directory !== this.#profile.cwd)
      throw new Error('OpenCode returned no bound session');
    this.#bridge.rebind(session.id);
    this.sessionId = session.id;
    return session.id;
  }

  /** A session's messages and their parts (tool calls with their state), as the host records them. */
  async messages(sessionId?: string): Promise<unknown> {
    const session = sessionId ?? this.sessionId;
    if (!session) throw new Error('OpenCode has no session');
    return this.#request(`/session/${encodeURIComponent(session)}/message`);
  }

  /** A second session Friday never binds: its tool calls must all be refused (checkpoint C). */
  async openUnboundSession(): Promise<string> {
    if (!this.opts.inference) throw new Error('only checkpoint C opens a second session');
    const session = (await this.#request('/session', 'POST', { title: 'Friday checkpoint C, unbound' })) as {
      id?: unknown;
    };
    if (typeof session.id !== 'string' || !session.id) throw new Error('OpenCode returned no session');
    return session.id;
  }

  /** Stops whatever a session is doing. */
  async abort(sessionId?: string): Promise<void> {
    const session = sessionId ?? this.sessionId;
    if (session) await this.#request(`/session/${encodeURIComponent(session)}/abort`, 'POST').catch(() => undefined);
  }

  async #request(route: string, method = 'GET', body?: unknown, timeoutMs?: number): Promise<unknown> {
    const response = await fetch(this.#url + route, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs ?? this.opts.startupTimeoutMs ?? 15000),
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${this.#password}`).toString('base64')}`,
        'x-opencode-directory': encodeURIComponent(this.#profile?.cwd ?? ''),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error('OpenCode preflight API failed');
    // `prompt_async` answers 204 with no body.
    const answer = await response.text();
    return answer ? JSON.parse(answer) : null;
  }
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    await this.#bridge.close();
    try {
      if (this.#url) {
        // Courtesy requests are bounded; process-group termination still confirms the stop.
        if (this.sessionId)
          await this.#request(`/session/${encodeURIComponent(this.sessionId)}/abort`, 'POST', undefined, 1000).catch(
            () => undefined,
          );
        await this.#request('/global/dispose', 'POST', undefined, 1000).catch(() => undefined);
      }
      await this.#process?.stop();
    } finally {
      await this.#groups.close();
      await this.#client?.disconnect('opencode_preflight_finished', true).catch(() => undefined);
      if (this.#profile) rmSync(this.#profile.dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}
