import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { GenericHarnessClient } from '@friday/adapter-generic';
import { type InteractiveProcess, type ProcessGroup, ProcessGroups, runProcess, startProcess } from '@friday/execution';
import type { DaemonClient } from '@friday/sdk';
import { PolicyBridge } from './bridge.js';
import {
  type ControlledProfile,
  createControlledProfile,
  LEVEL_NOTE,
  OPENCODE_VERSION,
  verifyEffectiveConfig,
} from './profile.js';

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
}

/** Checkpoints A/B only: starts a controlled server/session, never submits a model prompt. */
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
  sessionId: string | undefined;
  constructor(private readonly opts: OpenCodeSpawnOptions) {
    this.#bridge = new PolicyBridge(async (params) => {
      if (!this.#client || this.#closed) throw new Error('Friday is not connected');
      return this.#client.call('tool.check', params);
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
      const session = (await this.#request('/session', 'POST', { title: 'Friday no-model preflight' })) as {
        id?: unknown;
        directory?: unknown;
      };
      if (typeof session.id !== 'string' || !session.id || session.directory !== cwd)
        throw new Error('OpenCode returned no bound session');
      this.sessionId = session.id;
      this.#client = new GenericHarnessClient(this.opts.bootstrap, {
        harness_key: `opencode:${this.opts.projectId}:${this.opts.agentKey}`,
        vendor: 'opencode',
        name: 'OpenCode (A/B preflight)',
        version: OPENCODE_VERSION,
        attach_mode: 'spawn',
        project_id: this.opts.projectId,
        agent_key: this.opts.agentKey,
        enforcement_level: 'L1',
        capabilities: { experimental: true, model_calls: false, accepts_tasks: false },
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

  /** There is intentionally no prompt transport at A/B, including on task/resume delivery. */
  submitPrompt(): never {
    throw new Error('OpenCode model execution is disabled until checkpoint C is authorized');
  }

  async #request(route: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await fetch(this.#url + route, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(this.opts.startupTimeoutMs ?? 15000),
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${this.#password}`).toString('base64')}`,
        'x-opencode-directory': encodeURIComponent(this.#profile?.cwd ?? ''),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error('OpenCode preflight API failed');
    return response.json();
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#bridge.close();
    if (this.#url && this.#profile) {
      if (this.sessionId)
        await this.#request(`/session/${encodeURIComponent(this.sessionId)}/abort`, 'POST').catch(() => undefined);
      await this.#request('/global/dispose', 'POST').catch(() => undefined);
    }
    await this.#groups.close();
    await this.#client?.disconnect('opencode_preflight_finished', true).catch(() => undefined);
    if (this.#profile) rmSync(this.#profile.dir, { recursive: true, force: true, maxRetries: 3 });
  }
}
