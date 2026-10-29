import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { GenericHarnessClient, type Registration } from '@friday/adapter-generic';
import { FridayError, type InboxItem, isFridayError, type TaskView } from '@friday/protocol';
import {
  checkoutRoot,
  DaemonClient,
  DaemonUnreachableError,
  FRIDAY_VERSION,
  loadProject,
  type ProjectRef,
  privateDirFor,
} from '@friday/sdk';

export interface SessionOptions {
  projectDir?: string | undefined;
  agentKey?: string | undefined;
  /** Claude Code process id (the MCP server's parent). */
  hostPid?: number | undefined;
  /** CLAUDE_CODE_SESSION_ID, linking this server to the session's hooks (spike S2). */
  hostSessionId?: string | undefined;
  vendor?: 'claude-code' | 'generic';
  log?: (msg: string) => void;
}

export interface MeView {
  project: { project_id: string; name: string };
  harness: {
    harness_id: string;
    status: string;
    shadow: boolean;
    enforcement_level: string | null;
    enforcement_status?: string | null;
    enforcement_basis?: string | null;
  };
  /** Why this session may not take work under the project's security settings, or null. */
  enforcement_gap?: string | null;
  agent: { agent_id: string; agent_key: string; status: string; current_task_id: string | null };
  current_task: TaskView | null;
  current_run: { run_id: string; attempt: number; status: string; harness_id: string } | null;
  run_is_mine: boolean;
  awaiting_verification: string[];
  claimable: TaskView[];
  /** A peek at the agent's inbox (ADR-0017): nothing reserved. */
  inbox: InboxItem[];
}

/** Agent key: FRIDAY_AGENT, then the private agent.json written by `friday harness config`, then dev-1. */
export function resolveAgentKey(ref: ProjectRef | undefined, explicit?: string): string {
  if (explicit) return explicit;
  if (ref) {
    const file = path.join(privateDirFor(ref), 'agent.json');
    if (existsSync(file)) {
      try {
        const key = (JSON.parse(readFileSync(file, 'utf8')) as { agent_key?: string }).agent_key;
        if (key) return key;
      } catch {
        // fall through to the default
      }
    }
  }
  return 'dev-1';
}

/**
 * The MCP server's attachment to Friday: registers as a harness (bootstrap token), keeps the
 * lease alive, and re-registers when the daemon restarts or the lease is lost. Tools work
 * before registration finishes and explain what is missing.
 */
export class FridaySession {
  project: ProjectRef | undefined;
  client: GenericHarnessClient | undefined;
  registration: Registration | undefined;
  agentKey = 'dev-1';
  problem: string | undefined = 'starting';
  /** The MCP client's own version from `initialize` (Claude Code 2.1.296), reported as the host version. */
  hostVersion: string | undefined;
  #retry: NodeJS.Timeout | undefined;
  #starting: Promise<boolean> | undefined;
  #stopped = false;

  constructor(readonly opts: SessionOptions) {}

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  /** Tries to register now; on failure keeps retrying every 5 s in the background. */
  start(): Promise<boolean> {
    if (this.#starting) return this.#starting;
    this.#starting = this.attempt().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  private async attempt(): Promise<boolean> {
    if (this.#stopped) return false;
    try {
      this.project = loadProject(this.opts.projectDir);
    } catch (e) {
      this.problem = `no Friday project here (${(e as Error).message})`;
      return false;
    }
    this.agentKey = resolveAgentKey(this.project, this.opts.agentKey);
    let bootstrap: DaemonClient;
    try {
      bootstrap = DaemonClient.forProject(this.project, 'bootstrap', { clientName: 'friday-mcp' });
    } catch (e) {
      this.problem =
        e instanceof DaemonUnreachableError
          ? 'the Friday daemon is not running; ask the human to run "friday run" in the project'
          : (e as Error).message;
      this.scheduleRetry();
      return false;
    }
    const pid = this.opts.hostPid ?? process.ppid;
    const client = new GenericHarnessClient(bootstrap, {
      harness_key: `${this.opts.vendor ?? 'claude-code'}:${this.project.project_id}:pid:${pid}`,
      vendor: this.opts.vendor ?? 'claude-code',
      name: this.opts.vendor === 'generic' ? 'MCP client' : 'Claude Code',
      ...(this.hostVersion ? { version: this.hostVersion } : {}),
      adapter_version: FRIDAY_VERSION,
      attach_mode: 'attach',
      project_id: this.project.project_id,
      agent_key: this.agentKey,
      // MCP alone intercepts nothing: a generic client is L0. For Claude Code the daemon decides
      // from evidence, once the session's Friday hooks reach it (review F09).
      ...(this.opts.vendor === 'generic' ? { enforcement_level: 'L0' as const } : {}),
      capabilities: { mcp_tools: true, hooks: this.opts.vendor !== 'generic', context_request: true },
      host: {
        pid,
        // The checkout this session works in: a task worktree, or the main checkout (ADR-0023 §3).
        cwd: checkoutRoot(this.opts.projectDir ?? process.cwd()) ?? this.project.root,
        ...(this.opts.hostSessionId ? { session_id: this.opts.hostSessionId } : {}),
      },
    });
    try {
      this.registration = await client.register();
    } catch (e) {
      this.problem =
        e instanceof DaemonUnreachableError
          ? 'the Friday daemon is not reachable; ask the human to run "friday run"'
          : (e as Error).message;
      this.scheduleRetry();
      return false;
    }
    this.client = client;
    this.problem = undefined;
    this.log(
      `registered as ${this.registration.agent_key} (${this.registration.harness_id})${this.registration.shadow ? ' [shadow]' : ''}`,
    );
    client.startHeartbeat((e) => {
      if (
        isFridayError(e) &&
        (e.errorName === 'lease_expired' || e.errorName === 'authentication_failed' || e.errorName === 'token_revoked')
      ) {
        this.log(`lost the lease (${e.code}); registering again`);
        this.client = undefined;
        client.stopHeartbeat();
        void this.start();
      } else if (e instanceof DaemonUnreachableError) {
        this.problem = 'the Friday daemon stopped answering';
      }
    });
    return true;
  }

  private scheduleRetry(): void {
    if (this.#retry || this.#stopped) return;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.start();
    }, 5000);
    this.#retry.unref();
  }

  /** The registered client, registering on demand; throws a readable error otherwise. */
  async ready(): Promise<GenericHarnessClient> {
    if (this.client) return this.client;
    await this.start();
    if (this.client) return this.client;
    throw new FridayError('harness_unavailable', `Friday is not available: ${this.problem ?? 'unknown reason'}`);
  }

  /** Calls the harness-scoped REST API with this session's harness token. */
  async rest<T>(method: 'GET' | 'POST', sub: string, body?: unknown): Promise<T> {
    const client = await this.ready();
    const reg = this.registration as Registration;
    const http = DaemonClient.forProject(this.project as ProjectRef, 'bootstrap').withToken(
      reg.harness_token,
      'harness',
    );
    void client;
    return http.request<T>(method, http.projectPath(sub), body);
  }

  /** Bootstrap-token REST call (session binding). */
  async bootstrapPost<T>(sub: string, body: unknown): Promise<T> {
    await this.ready();
    const http = DaemonClient.forProject(this.project as ProjectRef, 'bootstrap');
    return http.post<T>(http.projectPath(sub), body);
  }

  me(): Promise<MeView> {
    return this.rest<MeView>('GET', '/me');
  }

  async stop(reason: string): Promise<void> {
    this.#stopped = true;
    if (this.#retry) clearTimeout(this.#retry);
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    client.stopHeartbeat();
    await Promise.race([client.disconnect(reason).catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
  }
}
