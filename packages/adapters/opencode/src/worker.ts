import path from 'node:path';
import {
  type Final,
  type GenericHarnessClient,
  type HarnessDescriptor,
  type KeptEvent,
  parseFinal,
  type Registration,
  SpawnLink,
} from '@friday/adapter-generic';
import { GitRoot } from '@friday/git';
import type { OutboundMessage, TaskStartParams } from '@friday/protocol';
import { type DaemonClient, FRIDAY_VERSION, firstTaskMessage, holdsContract, renderContextMarkdown } from '@friday/sdk';
import { OpenCodeSpawnAdapter } from './adapter.js';
import { type InferenceSettings, OPENCODE_VERSION } from './profile.js';

export interface OpenCodeWorkerOptions {
  /** The project's daemon, with the bootstrap token. */
  bootstrap: DaemonClient;
  projectId: string;
  agentKey: string;
  role?: string;
  /** The pinned OpenCode executable, outside every checkout, started without a shell. */
  host: { command: string; args?: readonly string[] };
  /** The folder holding OpenCode's plugin dependencies, copied into each attempt's private profile. */
  dependenciesDir: string;
  /** The model on this machine every attempt runs (a loopback OpenAI-compatible server). */
  inference: InferenceSettings;
  hostEnv?: NodeJS.ProcessEnv;
  /** Where each attempt's private profile is made; the system's temporary folder otherwise. */
  workDir?: string;
  /** Harness key; by default stable per project and agent, so a restart resumes its runs. */
  harnessKey?: string;
  /** A folder of this worker's own: how an attempt ended waits there until Friday records it. */
  stateDir?: string;
  startupTimeoutMs?: number;
  checkTimeoutMs?: number;
  /** How long one prompt may run before its session is stopped (20 minutes). */
  turnTimeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * What Friday tells every OpenCode session it starts, before the task's own context. OpenCode has
 * none of Friday's tools, and a small local model has no structured output; asked for a final line
 * of JSON, one wrote its tool calls as JSON text too (LESSONS HX-40). So the final answer is plain
 * words: a blocked one starts with `BLOCKED:`, anything else is a claim that Friday verifies.
 */
export const OPENCODE_RULES = [
  "You are working on a task that Friday assigned. Friday runs this project: it decides what you may do and verifies your work with the project's own checks.",
  '',
  '- The task below is already yours: start on it right away.',
  '- Do the work by calling your tools: change files with write or edit, and run commands with bash. A change exists only when a tool call made it; writing a call out as text changes nothing.',
  "- Work only in this folder, which is your task's own git worktree, and only within the task's scope below.",
  "- Friday judges every tool call before it runs. A refused call is Friday's decision, not an error: do not get the same effect another way. Where the task can go on without it, go on.",
  '- When you are done, say in a sentence or two what you did. If you cannot finish, start your last message with BLOCKED: and say what you need. Friday reads the files you changed from the worktree and verifies the work.',
].join('\n');

/**
 * The prompt's last line, after the task: a small model reads the end of a prompt best, and without
 * it one answered without any tool call (LESSONS HX-40).
 */
export const OPENCODE_CLOSING =
  'Now do the task by calling your tools. When the files are changed, say briefly what you did.';

/** A last message that says the session could not finish, as the rules ask (`BLOCKED: …`). */
const BLOCKED = /^\s*BLOCKED:\s*/i;

interface Message {
  info?: {
    role?: string;
    time?: { completed?: number };
    modelID?: string;
    cost?: unknown;
    tokens?: { input?: unknown; output?: unknown; cache?: { read?: unknown; write?: unknown } };
  };
  parts?: { type?: string; text?: unknown; tool?: unknown; state?: { status?: unknown; input?: unknown } }[];
}

/**
 * The file changes a session's tools completed, as OpenCode recorded them: each `write` or `edit`
 * that ended `completed`, with its path relative to the session's folder (a path outside it is left
 * out). Friday records them as observed before the claim, as it records other hosts' changes.
 */
export function openCodeWrites(messages: unknown, cwd: string): { tool: string; path: string }[] {
  const out: { tool: string; path: string }[] = [];
  for (const m of (Array.isArray(messages) ? messages : []) as Message[]) {
    if (m.info?.role !== 'assistant') continue;
    for (const p of m.parts ?? []) {
      if (p.type !== 'tool' || (p.tool !== 'write' && p.tool !== 'edit') || p.state?.status !== 'completed') continue;
      const file = (p.state.input as { filePath?: unknown } | undefined)?.filePath;
      if (typeof file !== 'string' || !file) continue;
      const rel = path.relative(cwd, path.resolve(cwd, file));
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel))
        out.push({ tool: p.tool, path: rel.split(path.sep).join('/') });
    }
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);

/**
 * How an OpenCode session ended its work, from its messages: the final answer of its last finished
 * assistant message (`BLOCKED: …` is blocked; a line of JSON with a status, which a model may still
 * give, is read as such; any other text is a completion claim with the text as its summary), and
 * what the session's model calls cost, as the host counted them (`host.usage`; a count the host did
 * not give is null, never 0).
 */
export function openCodeOutcome(messages: unknown): { final: Final; text: string; usage: Record<string, unknown> } {
  const list = (Array.isArray(messages) ? messages : []) as Message[];
  const answers = list.filter((m) => m.info?.role === 'assistant');
  const last = [...answers].reverse().find((m) => m.info?.time?.completed);
  const text = (last?.parts ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
    .trim();
  const json = [...text.matchAll(/\{[^{}]*"status"\s*:\s*"(?:completed|blocked)"[^{}]*\}/g)].at(-1)?.[0];
  const prose = json ? text.replace(json, '').trim() : text;
  let final = parseFinal(text, prose);
  if (BLOCKED.test(text)) {
    const why = text.replace(BLOCKED, '').trim();
    final = { status: 'blocked', summary: why, blocked_reason: why, checks: [] };
  } else if (json) {
    try {
      final = parseFinal(JSON.parse(json), prose);
    } catch {
      // not JSON after all: the text is the summary
    }
  }
  let input: number | null = null;
  let output: number | null = null;
  let read: number | null = null;
  let write: number | null = null;
  let cost: number | null = null;
  for (const m of answers) {
    input = add(input, num(m.info?.tokens?.input));
    output = add(output, num(m.info?.tokens?.output));
    read = add(read, num(m.info?.tokens?.cache?.read));
    write = add(write, num(m.info?.tokens?.cache?.write));
    cost = add(cost, num(m.info?.cost));
  }
  return {
    final,
    text,
    usage: {
      cost_usd: cost,
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
      turns: answers.length,
      model: answers.at(-1)?.info?.modelID ?? null,
    },
  };
}

interface Attempt {
  taskId: string;
  runId: string;
  cwd: string;
  host: OpenCodeSpawnAdapter;
  sessionId: string;
  stopping: boolean;
  done: boolean;
}

/**
 * OpenCode working for Friday on a model on this machine (plan M14.4, experimental): registers as a
 * spawn-mode harness and, for each run attempt, starts a controlled OpenCode server in the
 * attempt's worktree with a private profile, Friday's policy plugin bound to one new session, and
 * every tool call judged by `tool.check` for that task and run. The task goes to the session as one
 * prompt with its packet; the session's final answer is the claim. A cancellation stops the session
 * and ends its server and everything it started, so no call happens after it; a restarted worker
 * resumes its runs in a new session under the authority of that moment; whatever an ended attempt
 * still sends is dropped.
 */
export class OpenCodeWorker {
  /** Every instruction received from Friday, newest last (tests and logs). */
  readonly received: OutboundMessage[] = [];
  readonly #attempts = new Map<string, Attempt>();
  /** Attempts being ended: closing waits for them, so nothing of theirs outlives the worker. */
  readonly #ending = new Set<Promise<void>>();
  readonly #link: SpawnLink;

  constructor(private readonly opts: OpenCodeWorkerOptions) {
    this.#link = new SpawnLink({
      bootstrap: opts.bootstrap,
      descriptor: () => this.descriptor(),
      handle: (m) => this.#handle(m),
      fence: (why) => this.#fence(why),
      ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
      log: (m) => this.#log(m),
    });
  }

  get client(): GenericHarnessClient {
    return this.#link.client;
  }

  get harnessId(): string {
    return this.client.harnessId;
  }

  descriptor(): HarnessDescriptor {
    const o = this.opts;
    return {
      harness_key: o.harnessKey ?? `opencode:${o.projectId}:${o.agentKey}`,
      vendor: 'opencode',
      name: 'OpenCode (local model, experimental)',
      version: OPENCODE_VERSION,
      adapter_version: FRIDAY_VERSION,
      attach_mode: 'spawn',
      project_id: o.projectId,
      agent_key: o.agentKey,
      role: o.role ?? 'developer',
      // Friday's plugin judges every tool call before it runs; the level stays unverified.
      enforcement_level: 'L1',
      capabilities: {
        experimental: true,
        task_start: true,
        task_cancel: true,
        reconnect: true,
        model_calls: true,
        // The worker runs its own local model whatever routing suggests.
        model_control: 'none',
        models: [o.inference.model],
        // A model on this machine costs nothing per call (plan M13.3).
        cost_class: 'free',
        resume_session: false,
      },
      host: { pid: process.pid },
    };
  }

  #log(msg: string): void {
    this.opts.log?.(msg);
  }

  /** Registers, keeps the lease, and serves Friday's instructions until stopped. */
  start(): Promise<Registration> {
    return this.#link.start();
  }

  async #handle(
    m: OutboundMessage,
  ): Promise<{ accepted: boolean; reason?: string; session_ref?: string; afterAck?: (current: boolean) => void }> {
    this.received.push(m);
    const p = m.params as TaskStartParams;
    if (m.method === 'task.resume' && this.#link.reports.has(p.run_id)) {
      // The attempt had ended before this worker could tell Friday how: the report goes now, and
      // no session works again.
      return {
        accepted: true,
        ...(p.session_ref ? { session_ref: p.session_ref } : {}),
        afterAck: (current) => {
          if (current) void this.#link.reports.deliver(p.run_id);
          else this.#link.reports.drop(p.run_id);
        },
      };
    }
    if (m.method === 'task.start' || m.method === 'task.resume') {
      const live = this.#attempts.get(p.run_id);
      if (live && !live.done && !live.stopping) return { accepted: true, session_ref: live.sessionId };
      try {
        const a = await this.#begin(p);
        // The prompt goes once Friday knows the run is this harness's; a start Friday no longer
        // wants ends the server instead.
        return {
          accepted: true,
          session_ref: a.sessionId,
          afterAck: (current) => {
            if (current) void this.#work(a, p, m.method === 'task.resume' ? 'resume' : 'start');
            else void this.#end(p.run_id);
          },
        };
      } catch (e) {
        this.#log(`could not start ${p.task_id}: ${(e as Error).message}`);
        await this.#end(p.run_id);
        return { accepted: false, reason: `OpenCode could not start: ${(e as Error).message}`.slice(0, 1000) };
      }
    }
    if (m.method === 'task.cancel') {
      this.#link.reports.drop(p.run_id);
      await this.#end(p.run_id);
      return { accepted: true };
    }
    // The packet is part of the prompt; a pushed packet changes nothing mid-prompt.
    return { accepted: true };
  }

  /** Starts the attempt's controlled server and its one bound session. */
  async #begin(p: TaskStartParams): Promise<Attempt> {
    await this.#end(p.run_id);
    const host = new OpenCodeSpawnAdapter({
      bootstrap: this.opts.bootstrap,
      projectId: this.opts.projectId,
      agentKey: this.opts.agentKey,
      cwd: p.working_directory,
      host: this.opts.host,
      dependenciesDir: this.opts.dependenciesDir,
      inference: this.opts.inference,
      ...(this.opts.workDir ? { workDir: this.opts.workDir } : {}),
      ...(this.opts.hostEnv ? { hostEnv: this.opts.hostEnv } : {}),
      ...(this.opts.startupTimeoutMs ? { startupTimeoutMs: this.opts.startupTimeoutMs } : {}),
      ...(this.opts.checkTimeoutMs ? { checkTimeoutMs: this.opts.checkTimeoutMs } : {}),
      // This worker is the harness: the attempt's server registers nothing of its own, and every
      // call is judged for this task and run, under the policy of the moment it is made.
      register: false,
      title: `Friday task ${p.task_id}`,
      check: (params) => this.client.call('tool.check', { ...params, task_id: p.task_id, run_id: p.run_id }),
    });
    const a: Attempt = {
      taskId: p.task_id,
      runId: p.run_id,
      cwd: p.working_directory,
      host,
      sessionId: '',
      stopping: false,
      done: false,
    };
    this.#attempts.set(p.run_id, a);
    a.sessionId = (await host.start()).session_id;
    await this.#event(a, 'model.observed', { model: this.opts.inference.model, basis: 'configured' });
    return a;
  }

  /** The task as one prompt with its packet; the session's final answer is how the attempt ends. */
  async #work(a: Attempt, p: TaskStartParams, why: 'start' | 'resume'): Promise<void> {
    if (a.done || a.stopping) return;
    let packet = '';
    try {
      // Compiled now, under the authority of this moment: a resumed run gets today's policy and scope.
      const ctx = await this.client.requestContext({ task_id: p.task_id, run_id: p.run_id, kind: 'task' });
      packet = renderContextMarkdown(ctx, 12_000, { fridayTools: false });
    } catch (e) {
      packet = `Friday could not compile this task's context (${(e as Error).message}).`;
    }
    const opening =
      why === 'resume'
        ? (p.note ??
          'The previous session of this task ended unexpectedly. The worktree keeps what it changed: continue the task where it left off.')
        : firstTaskMessage(p, holdsContract(packet));
    const prompt = [OPENCODE_RULES, packet, opening, OPENCODE_CLOSING].join('\n\n');
    let messages: unknown;
    try {
      messages = await a.host.submitPrompt(prompt, { timeoutMs: this.opts.turnTimeoutMs ?? 20 * 60_000 });
    } catch (e) {
      // Stopped by Friday: nothing to report. Otherwise the session failed or ran out of time.
      if (a.done || a.stopping) return;
      await this.#lost(a, (e as Error).message);
      return;
    }
    // Late: the attempt ended (cancelled, fenced) while the model finished; what it says is dropped.
    if (a.done || a.stopping) return;
    a.done = true;
    const { final, usage } = openCodeOutcome(messages);
    // What the session's tools changed, observed before the claim names it (no discrepancy to explain).
    for (const w of openCodeWrites(messages, a.cwd))
      await this.#event(a, 'tool.completed', { tool: w.tool, changed_paths: [w.path] });
    const spent = { events: [{ event_type: 'host.usage', data: usage }] satisfies KeptEvent[] };
    const ids = { task_id: a.taskId, run_id: a.runId };
    if (final.status === 'blocked') {
      void this.#link.reports.report(
        'result',
        {
          ...ids,
          status: 'blocked',
          summary: final.summary.slice(0, 2000) || 'blocked',
          blocked_reason: (final.blocked_reason || final.summary || 'blocked').slice(0, 1000),
        },
        spent,
      );
    } else {
      // The changed paths are the worktree's, never the model's list (plan M13.4).
      let changed: string[] = [];
      try {
        changed = [...(await (await GitRoot.open(a.cwd)).identity()).paths];
      } catch {
        // optional evidence: verification reads the worktree itself
      }
      void this.#link.reports.report(
        'result',
        {
          ...ids,
          status: 'completed_claim',
          summary: final.summary.slice(0, 2000) || 'done',
          changed_paths: changed.slice(0, 200),
          // What the session says it ran: verification's evidence, bounded by what the hooks saw.
          checks: final.checks,
        },
        spent,
      );
    }
    await this.#end(a.runId);
  }

  /** The session failed or the model ran out of time: an agent error Friday's recovery handles. */
  async #lost(a: Attempt, why: string): Promise<void> {
    if (a.done || a.stopping) return;
    a.done = true;
    let spent: { events?: KeptEvent[] } = {};
    try {
      spent = { events: [{ event_type: 'host.usage', data: openCodeOutcome(await a.host.messages()).usage }] };
    } catch {
      // the host is gone: what it spent is unknown
    }
    void this.#link.reports.report(
      'error',
      { task_id: a.taskId, run_id: a.runId, message: `OpenCode stopped: ${why}`.slice(0, 2000), fatal: true },
      spent,
    );
    await this.#end(a.runId);
  }

  /** Ends every attempt: Friday is not heard, so a cancellation would not reach them. */
  async #fence(why: string): Promise<void> {
    for (const a of this.#attempts.values()) a.done = true;
    this.#log(`stopping every session: ${why}`);
    await Promise.allSettled([...this.#attempts.keys()].map((id) => this.#end(id)));
  }

  /**
   * Ends an attempt: its session is stopped and its server, with everything it started, ends; the
   * policy bridge closes first, so a call the session still makes is refused.
   */
  async #end(runId: string): Promise<void> {
    const a = this.#attempts.get(runId);
    if (!a) return;
    this.#attempts.delete(runId);
    a.stopping = true;
    const ending = a.host.close().catch((e: Error) => this.#log(`stopping ${a.taskId}'s session: ${e.message}`));
    this.#ending.add(ending);
    try {
      await ending;
    } finally {
      this.#ending.delete(ending);
      a.done = true;
    }
  }

  /** Stops like a crashed process: nothing is told to Friday; the sessions end with it. */
  async crash(): Promise<void> {
    await this.#link.crash();
    for (const a of this.#attempts.values()) a.done = true;
    await Promise.allSettled([...this.#attempts.keys()].map((id) => this.#end(id)));
    await Promise.allSettled([...this.#ending]);
  }

  /** Comes back as the same harness and serves its runs again (`task.resume`). */
  reconnect(): Promise<void> {
    return this.#link.reconnect();
  }

  /** Ends every attempt and tells Friday this harness is leaving. */
  async close(reason = 'the OpenCode worker stopped'): Promise<void> {
    await Promise.allSettled([...this.#attempts.keys()].map((id) => this.#end(id)));
    // An attempt that finished a moment ago may still be closing its server and removing its profile.
    await Promise.allSettled([...this.#ending]);
    await this.#link.close(reason);
  }

  /** Whether a run's session is still at work (tests). */
  running(runId: string): boolean {
    const a = this.#attempts.get(runId);
    return Boolean(a && !a.done);
  }

  /** The session of a run's attempt, while it lasts (tests). */
  session(runId: string): string | undefined {
    return this.#attempts.get(runId)?.sessionId;
  }

  async #event(a: Attempt, type: string, data: Record<string, unknown>): Promise<void> {
    await this.client
      .emitEvent({ task_id: a.taskId, run_id: a.runId, event_type: type, data })
      .catch((e: Error) => this.#log(`could not record ${type}: ${e.message}`));
  }
}
