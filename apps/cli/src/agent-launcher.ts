import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DaemonContext, DaemonOptions } from '@friday/daemon';
import {
  type Actor,
  type AgentHost,
  type AgentHostName,
  type AgentOptions,
  type AgentProcess,
  type AgentProfile,
  FridayError,
} from '@friday/protocol';
import { AGENT_KEY, AgentProfiles, optionFlags, ROLE, validateOptions } from './agent-profiles.js';

/**
 * Starting agents from the interface (plan M9 §5.9, FD-10, FD-24): a daemon extension, mounted by
 * the CLI because the adapters depend on the daemon and the daemon cannot import them. It starts
 * `friday harness run <host>` children, keeps their redacted output, remembers them as profiles,
 * and stops them gracefully before the daemon drains.
 *
 * Every child: an argument array and no shell, a hidden window, a working folder outside the
 * project (so nothing planted there is ever found and run), its options validated, its lifetime
 * tied to the daemon through its standard input (`--parent-stdin`).
 */

export type Host = AgentHostName;
/** The daemon's app as an extension receives it (its type comes from the daemon, not from hono). */
type App = Parameters<NonNullable<DaemonOptions['extensions']>[number]>[0];
/** What the routes use of a request context. */
interface Ctx {
  get(k: 'auth'): { token_class: string } | undefined;
  req: { json(): Promise<unknown>; query(k: string): string | undefined; param(k: string): string };
}
export interface ChildSpec {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}
export interface LaunchRequest {
  host: Host;
  agent_key: string;
  role: string;
  options: AgentOptions;
}

export interface LauncherOptions {
  /** The child to start (tests inject a scripted adapter; review FS-01). */
  child?: (req: LaunchRequest, ctx: DaemonContext, host: AgentHost | undefined) => ChildSpec;
  /** Installed hosts (default: `friday harness hosts --json` in a child process). */
  detectHosts?: () => Promise<AgentHost[]>;
  /** At most this many agent processes at once (default 8). */
  maxProcesses?: number;
  /** How long a stop waits for the child to exit after its input closed (default 10 s). */
  stopGraceMs?: number;
}

const RING = 200;
const SYSTEM: Actor = { kind: 'system', id: 'agent-launcher' };
export const HOSTS: readonly Host[] = ['claude-code', 'codex', 'cursor', 'gemini'];
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences are removed on purpose
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_][^\u001b]*/g;

/** The CLI's own launcher script (`apps/cli/bin/friday.mjs`), next to the built module. */
export function cliEntry(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'friday.mjs');
}

/** The harness key a host's adapter registers with (for spotting a key another session holds). */
export function harnessKeyOf(host: Host, projectId: string, agentKey: string): string {
  // Codex's adapter came first and names no mode; every later spawn adapter names it.
  return host === 'codex' ? `codex:${projectId}:${agentKey}` : `${host}:${projectId}:spawn:${agentKey}`;
}

/** Detection in a child process: never on the daemon's event loop, never from the project folder. */
export function detectHostsInChild(entry = cliEntry()): Promise<AgentHost[]> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [entry, '--json', 'harness', 'hosts'],
      { cwd: tmpdir(), windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        try {
          const parsed = JSON.parse(stdout) as { hosts?: AgentHost[] };
          resolve(Array.isArray(parsed.hosts) ? parsed.hosts : []);
        } catch {
          resolve(
            HOSTS.map((host) => ({
              host,
              found: false,
              version: null,
              supported: false,
              path: null,
              reason: `detection failed: ${err?.message ?? 'no answer'}`,
            })),
          );
        }
      },
    );
  });
}

interface Entry {
  proc: AgentProcess;
  child: ChildProcess | null;
  exited: Promise<void>;
  kill?: NodeJS.Timeout;
}

export function createAgentLauncher(opts: LauncherOptions = {}) {
  return (app: App, ctx: DaemonContext) => {
    const { state, project, logger } = ctx;
    const pid = project.project_id;
    const P = `/api/v1/projects/${pid}`;
    const profiles = new AgentProfiles(ctx.privateDir);
    const entries = new Map<string, Entry>();
    /** Keys whose start is past its checks but not yet recorded (hosts are being detected). */
    const starting = new Set<string>();
    const max = opts.maxProcesses ?? 8;
    const grace = opts.stopGraceMs ?? 10_000;
    const logDir = path.join(project.root, '.friday', 'logs', 'agents');
    let hosts: { at: string; list: AgentHost[] } | null = null;
    let detecting: Promise<AgentHost[]> | null = null;
    let closing = false;

    const detect = (refresh: boolean): Promise<AgentHost[]> => {
      if (hosts && !refresh) return Promise.resolve(hosts.list);
      if (!detecting) {
        detecting = (opts.detectHosts ?? (() => detectHostsInChild()))()
          .then((list) => {
            const checked = list.map((h) => outsideProject(h, project.root));
            hosts = { at: new Date().toISOString(), list: checked };
            return checked;
          })
          .finally(() => {
            detecting = null;
          });
      }
      return detecting;
    };

    /** A host binary inside the project or a worktree is never run (review SEC-12). */
    const outsideProject = (h: AgentHost, root: string): AgentHost => {
      if (!h.path) return h;
      const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
      if (
        norm(h.path).startsWith(norm(root) + path.sep) ||
        norm(h.path).includes(`${path.sep}friday-worktrees${path.sep}`)
      ) {
        return {
          ...h,
          supported: false,
          reason: `${h.path} is inside the project; Friday never runs a host from there`,
        };
      }
      return h;
    };

    const requireOperator = (c: Ctx) => {
      const auth = c.get('auth');
      // Extensions sit outside the daemon's own allow(): the token class is checked here (review SEC-11).
      if (auth?.token_class !== 'operator') {
        throw new FridayError('token_scope_insufficient', 'starting agents needs the operator token');
      }
    };

    const shadowOf = (host: Host, agentKey: string): boolean => {
      const h = state.q.harnessByKey(pid, harnessKeyOf(host, pid, agentKey));
      return h ? Boolean(state.q.harness(h.harness_id).shadow) : false;
    };

    const view = (): { processes: AgentProcess[]; profiles: AgentProfile[] } => ({
      processes: [...entries.values()].map((e) => ({ ...e.proc, shadow: shadowOf(e.proc.host, e.proc.agent_key) })),
      profiles: profiles.list(),
    });

    /** Refuses a key another live session holds: two hosts on one key revoke each other (review BA-06). */
    const assertFree = (req: LaunchRequest) => {
      const mine = entries.get(req.agent_key);
      if (mine && mine.proc.status !== 'exited') {
        throw new FridayError(
          'invalid_state_transition',
          `${req.agent_key} is already running from here (pid ${mine.proc.pid})`,
        );
      }
      const live = (status: string) => !['DISCONNECTED', 'TERMINATED'].includes(status);
      const held = state.q.harnessByKey(pid, harnessKeyOf(req.host, pid, req.agent_key));
      if (held && live(held.status)) {
        throw new FridayError(
          'invalid_state_transition',
          `a ${held.vendor} session already works as ${req.agent_key} (${held.harness_id}); stop it first`,
        );
      }
      const agent = state.q.agentByKey(pid, req.agent_key);
      const bound = agent?.harness_id ? state.q.findHarness(agent.harness_id) : undefined;
      if (bound && live(bound.status) && bound.harness_key !== harnessKeyOf(req.host, pid, req.agent_key)) {
        throw new FridayError(
          'invalid_state_transition',
          `${req.agent_key} is bound to another live session (${bound.vendor}, ${bound.harness_id}); pick another key`,
        );
      }
      const running = [...entries.values()].filter((e) => e.proc.status !== 'exited').length;
      if (running >= max) throw new FridayError('agent_unavailable', `at most ${max} agents run at once`);
    };

    const defaultChild = (req: LaunchRequest, host: AgentHost | undefined): ChildSpec => ({
      command: process.execPath,
      args: [
        cliEntry(),
        '--project',
        project.root,
        'harness',
        'run',
        req.host,
        `--agent=${req.agent_key}`,
        `--role=${req.role}`,
        ...optionFlags(req.host, req.options),
        ...(host?.path ? [`--host-bin=${host.path}`] : []),
        '--parent-stdin',
      ],
      cwd: tmpdir(),
    });

    const line = (entry: Entry, text: string) => {
      const clean = state.redactor.redactString(text.replace(ANSI, '')).value;
      entry.proc.log_tail.push(clean);
      if (entry.proc.log_tail.length > RING) entry.proc.log_tail.splice(0, entry.proc.log_tail.length - RING);
      try {
        mkdirSync(logDir, { recursive: true });
        appendFileSync(path.join(logDir, `${entry.proc.agent_key}.log`), `${clean}\n`);
      } catch {
        // The log file is a convenience; the ring buffer still holds the lines.
      }
    };

    const start = async (req: LaunchRequest): Promise<AgentProcess> => {
      assertFree(req);
      // The key is held from here until its entry is recorded: a second start of it while hosts
      // are detected would start a second child the first could no longer be told apart from.
      if (starting.has(req.agent_key)) {
        throw new FridayError('invalid_state_transition', `${req.agent_key} is starting already`);
      }
      starting.add(req.agent_key);
      let list: AgentHost[];
      try {
        list = await detect(false);
      } finally {
        starting.delete(req.agent_key);
      }
      assertFree(req);
      const host = list.find((h) => h.host === req.host);
      if (!opts.child && (!host?.found || !host.supported)) {
        throw new FridayError('invalid_request', `${req.host} cannot be started here: ${host?.reason ?? 'not found'}`);
      }
      const spec = opts.child ? opts.child(req, ctx, host) : defaultChild(req, host);
      const proc: AgentProcess = {
        agent_key: req.agent_key,
        host: req.host,
        role: req.role,
        pid: null,
        status: 'starting',
        started_at: new Date().toISOString(),
        ended_at: null,
        exit_code: null,
        options: req.options,
        log_tail: [],
        shadow: false,
      };
      let resolveExit = () => {};
      const exited = new Promise<void>((r) => {
        resolveExit = r;
      });
      const entry: Entry = { proc, child: null, exited };
      entries.set(req.agent_key, entry);
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd ?? tmpdir(),
        env: spec.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
      entry.child = child;
      proc.pid = child.pid ?? null;
      let buf = '';
      const onData = (d: Buffer) => {
        if (proc.status === 'starting') proc.status = 'running';
        buf += d.toString('utf8');
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? '';
        for (const p of parts) if (p) line(entry, p);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('spawn', () => {
        proc.status = 'running';
      });
      child.on('error', (e) => line(entry, `could not start: ${e.message}`));
      child.on('exit', (code, signal) => {
        if (buf) line(entry, buf);
        if (entry.kill) clearTimeout(entry.kill);
        proc.status = 'exited';
        proc.ended_at = new Date().toISOString();
        proc.exit_code = code ?? (signal ? -1 : null);
        try {
          state.recordObservation(
            pid,
            SYSTEM,
            'agent.process_exited',
            { agent_key: proc.agent_key, host: proc.host, exit_code: proc.exit_code, signal: signal ?? null },
            [],
          );
        } catch (e) {
          logger.warn('recording an agent exit failed', { message: (e as Error).message });
        }
        resolveExit();
      });
      state.recordObservation(
        pid,
        SYSTEM,
        'agent.process_started',
        { agent_key: proc.agent_key, host: proc.host, role: proc.role, pid: proc.pid },
        [],
      );
      logger.info('agent started', { agent_key: proc.agent_key, host: proc.host, pid: proc.pid });
      return proc;
    };

    /** Closes the child's input (its adapter stops its hosts and disconnects), then kills it after the grace. */
    const stop = async (agentKey: string): Promise<AgentProcess> => {
      const entry = entries.get(agentKey);
      if (!entry) throw new FridayError('agent_not_found', `no agent ${agentKey} was started from here`);
      if (entry.proc.status === 'exited') return entry.proc;
      entry.proc.status = 'stopping';
      entry.child?.stdin?.end();
      entry.kill = setTimeout(() => entry.child?.kill(), grace);
      entry.kill.unref();
      await entry.exited;
      return entry.proc;
    };

    const parseLaunch = async (c: Ctx): Promise<LaunchRequest & { autostart: boolean }> => {
      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) as Record<string, unknown>;
      } catch {
        throw new FridayError('invalid_request', 'the request body must be JSON');
      }
      const host = body.host as Host;
      if (!HOSTS.includes(host)) throw new FridayError('invalid_request', `host is one of ${HOSTS.join(', ')}`);
      if (typeof body.agent_key !== 'string' || !AGENT_KEY.test(body.agent_key)) {
        throw new FridayError('invalid_request', 'agent_key: lower-case letters, digits and dashes, at most 64');
      }
      const role = body.role ?? 'developer';
      if (typeof role !== 'string' || !ROLE.test(role)) throw new FridayError('invalid_request', 'role is not valid');
      if ('model' in body) {
        throw new FridayError('invalid_request', 'models come from routing; pin one for a role or task instead');
      }
      return {
        host,
        agent_key: body.agent_key,
        role,
        options: validateOptions(host, body.options),
        autostart: body.autostart !== false,
      };
    };

    app.get(`${P}/agent-hosts`, async (c) => {
      requireOperator(c as unknown as Ctx);
      const list = await detect(c.req.query('refresh') === 'true');
      return c.json({ hosts: list, checked_at: hosts?.at ?? null });
    });
    app.get(`${P}/agent-processes`, (c) => {
      requireOperator(c as unknown as Ctx);
      return c.json(view());
    });
    app.post(`${P}/agent-processes`, async (c) => {
      requireOperator(c as unknown as Ctx);
      if (closing) throw new FridayError('daemon_shutting_down', 'the daemon is stopping');
      const req = await parseLaunch(c as unknown as Ctx);
      const proc = await start(req);
      profiles.save({
        agent_key: req.agent_key,
        host: req.host,
        role: req.role,
        options: req.options,
        autostart: req.autostart,
        updated_at: new Date().toISOString(),
      });
      return c.json({ process: proc }, 201);
    });
    app.post(`${P}/agent-processes/:key/stop`, async (c) => {
      requireOperator(c as unknown as Ctx);
      return c.json({ process: await stop(c.req.param('key')) });
    });
    app.post(`${P}/agent-processes/:key/start`, async (c) => {
      requireOperator(c as unknown as Ctx);
      const profile = profiles.get(c.req.param('key'));
      if (!profile) throw new FridayError('agent_not_found', `no remembered agent ${c.req.param('key')}`);
      const proc = await start(profile);
      return c.json({ process: proc }, 201);
    });
    app.post(`${P}/agent-processes/:key/forget`, async (c) => {
      requireOperator(c as unknown as Ctx);
      const key = c.req.param('key');
      if (entries.has(key)) await stop(key);
      entries.delete(key);
      profiles.forget(key);
      return c.json({ ok: true });
    });

    // Remembered agents marked to start with Friday, once the daemon listens (their runs resume
    // within the reconnect window).
    const autostart = setInterval(() => {
      if (!ctx.port()) return;
      clearInterval(autostart);
      for (const p of profiles.list().filter((x) => x.autostart)) {
        start(p).catch((e) =>
          logger.warn('starting a remembered agent failed', { agent_key: p.agent_key, message: (e as Error).message }),
        );
      }
    }, 200);
    autostart.unref();

    return {
      /** Every child stops the graceful way, while the daemon still answers their disconnect. */
      close: async () => {
        closing = true;
        clearInterval(autostart);
        await Promise.allSettled([...entries.keys()].map((k) => stop(k)));
      },
    };
  };
}
