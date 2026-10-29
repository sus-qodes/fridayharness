import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type ExecutionProfile,
  executeRun,
  MIN_SECRET_LENGTH,
  type PreparedRun,
  type ProcessGroups,
  ProfileError,
  prepareRun,
} from '@friday/execution';
import { GitRoot } from '@friday/git';
import { type EffectiveOperation, evaluateCapability } from '@friday/policy';
import {
  FridayError,
  isFridayError,
  type OperationResult,
  type OperationRunView,
  type ParsedParamsOf,
  type ResultOf,
} from '@friday/protocol';
import { hasSecret, type ProjectRef, resolveSecret } from '@friday/sdk';
import type { Caller, FridayState } from '@friday/state';
import { summarizeOutcome } from '@friday/verification';
import type { Logger } from './log.js';
import type { EffectivePolicy } from './policy.js';

/** Output an agent receives; the whole sanitized output is an artifact. */
const OUTPUT_TAIL = 8 * 1024;

export interface OperationDeps {
  state: FridayState;
  project: ProjectRef;
  logger: Logger;
  policy: () => EffectivePolicy;
  profile: () => ExecutionProfile;
  env: NodeJS.ProcessEnv;
  /** Every operation's process tree is a group, ended with the operation (review F07). */
  groups: ProcessGroups;
}

interface Running {
  task_id: string;
  run_id: string | null;
  /** Resolves once the run's outcome is recorded. */
  done: Promise<void>;
  /** Ends the whole process tree; resolves once nothing of it is left. */
  stop: () => Promise<void>;
  /** Why Friday stopped it, once it did. */
  stopped: string | null;
}

const blank = (operation: string): OperationResult => ({
  status: 'denied',
  operation,
  operation_run_id: null,
  approval_id: null,
  reason: '',
  exit_code: null,
  timed_out: false,
  duration_ms: null,
  output: '',
  output_truncated: false,
  artifact_ref: null,
  redactions: 0,
  risk: null,
});

/**
 * The execution gateway (ADR-0029): runs an operation the project declared and this clone trusted,
 * for the agent holding a running task, in the execution profile with the stored secrets it names.
 * Judged and approved like any capability (ADR-0027); the agent gets the outcome and the end of the
 * output with every credential removed, never a secret.
 */
export class OperationManager {
  readonly #running = new Map<string, Running>();
  readonly #launched = new Set<string>();
  readonly #unsubscribe: () => void;

  constructor(private readonly deps: OperationDeps) {
    // An operation runs on its task's attempt's authority: when the attempt ends (cancelled,
    // released, reassigned, failed, claimed done), the operation is stopped (review F07).
    this.#unsubscribe = deps.state.transport.subscribe(
      { project_id: deps.project.project_id, types: ['run.ended', 'run.declined'] },
      (e) => {
        const p = e.payload as { run_id?: string; changes?: { outcome?: string } };
        if (!p.run_id) return;
        const why = `its task's attempt ended (${p.changes?.outcome ?? e.type.replace('run.', '')})`;
        this.stopRun(p.run_id, why).catch((err: unknown) =>
          deps.logger.error('stopping an operation failed', { run_id: p.run_id, message: (err as Error).message }),
        );
      },
    );
  }

  private get pid() {
    return this.deps.project.project_id;
  }

  /** What this agent may run, and what is declared but not available here. */
  list(caller: Caller): ResultOf<'operation.list'> {
    const policy = this.deps.policy();
    const role = this.deps.state.q.findAgent(caller.agent_id)?.role ?? '';
    return {
      operations: Object.values(policy.operations)
        .filter((o) => !o.roles.length || o.roles.includes(role))
        .map((o) => ({
          name: o.name,
          description: o.description ?? null,
          risk: o.risk,
          needs_approval: o.risk !== 'low',
          credentials: Object.values(o.credentials).sort(),
          roles: o.roles,
        })),
      held: policy.operations_held.map(({ name, reason }) => ({ name, reason })),
    };
  }

  /** Operations that use a secret, for the answer to an agent that asks for one. */
  withSecrets(): EffectiveOperation[] {
    return Object.values(this.deps.policy().operations).filter((o) => Object.keys(o.credentials).length > 0);
  }

  async run(caller: Caller, p: ParsedParamsOf<'operation.run'>, signal?: AbortSignal): Promise<OperationResult> {
    const { state, project } = this.deps;
    const policy = this.deps.policy();
    const base = blank(p.operation);
    const denied = (reason: string): OperationResult => ({ ...base, status: 'denied', reason });
    const op = policy.operations[p.operation];
    if (op) base.risk = op.risk;
    if (!op) {
      const held = policy.operations_held.find((h) => h.name === p.operation);
      return denied(
        held
          ? `${p.operation} is declared but not available on this clone: ${held.reason}`
          : `the project declares no operation "${p.operation}"; friday_run_operation without a name lists them`,
      );
    }

    // For the task this agent holds, while it runs, from the session holding its current attempt.
    const task = p.task_id
      ? state.q.findTask(this.pid, p.task_id)
      : state.q.tasks(this.pid, { statuses: ['RUNNING'] }).find((t) => t.assigned_agent_id === caller.agent_id);
    if (task && task.assigned_agent_id === caller.agent_id && task.status === 'WAITING') {
      // Held, but set waiting (LESSONS D-46): say so, not "claim it first".
      return denied(
        `your task ${task.task_id} is WAITING (${task.waiting_reason ?? 'waiting'}); report progress with status "working" to continue it, then run the operation again`,
      );
    }
    if (!task || task.assigned_agent_id !== caller.agent_id || task.status !== 'RUNNING') {
      return denied('operations run for the task you hold while it is RUNNING; claim it first');
    }
    const run = task.current_run_id ? state.q.findRun(task.current_run_id) : undefined;
    if (!run || run.harness_id !== caller.harness_id || (p.run_id && p.run_id !== run.run_id)) {
      return denied("this session does not hold the task's current attempt");
    }
    const role = state.q.findAgent(caller.agent_id)?.role ?? '';
    if (op.roles.length && !op.roles.includes(role)) {
      return denied(`${op.name} is for agents of the role${op.roles.length > 1 ? 's' : ''} ${op.roles.join(', ')}`);
    }
    // A secret that is not stored: say so before a human is asked to approve anything.
    const missing = Object.values(op.credentials).filter((n) => !hasSecret(n, this.deps.env));
    if (missing.length) {
      return {
        ...base,
        status: 'unavailable',
        reason: `${op.name} needs the secret${missing.length > 1 ? 's' : ''} ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not stored on this machine; ask a human to run "friday secrets set ${missing[0]}"`,
      };
    }
    // The profile checks the binary, the arguments and the folder before anyone is asked.
    const root = run.execution_root ?? project.root;
    const cwd = op.cwd ? path.resolve(root, op.cwd) : root;
    const profile = this.deps.profile();
    let prepared: PreparedRun;
    try {
      prepared = prepareRun({ command: op.command, args: op.args, root, cwd, env: op.env }, profile);
    } catch (e) {
      if (e instanceof ProfileError) return denied(`the execution profile refuses ${op.name}: ${e.message}`);
      throw e;
    }

    // Judged like any capability (ADR-0027): low risk runs at once, otherwise a bound approval.
    const verdict = evaluateCapability({
      capability: 'operation.run',
      target: op.name,
      task: null,
      ctx: { projectRoot: root },
      risk: { 'operation.run': op.risk },
    });
    if (verdict.decision === 'deny') return denied(verdict.reason);
    let approval_id: string | null = null;
    if (verdict.decision === 'review') {
      const use = {
        capability: 'operation.run',
        target: op.name,
        task_id: task.task_id,
        run_id: run.run_id,
        agent_id: caller.agent_id,
        policy_version: policy.version,
        now: state.clock.now(),
      };
      approval_id = state.q.usableApproval(this.pid, use) ?? null;
      if (!approval_id) {
        const pending = state.q.pendingApproval(this.pid, use, use.now);
        if (pending) {
          return {
            ...base,
            status: 'approval_required',
            approval_id: pending.approval_id,
            reason: `still waiting for a human to approve ${pending.approval_id} ("friday approve ${pending.approval_id}"); call friday_run_operation again once it is approved`,
          };
        }
        const changed = await this.changedFiles(root, run.base_commit);
        const asked = state.requestPermission(
          this.pid,
          caller,
          {
            task_id: task.task_id,
            run_id: run.run_id,
            action_class: 'operation.run',
            resource: op.name,
            justification: justification(p.reason, op, changed),
            ttl_s: 3600,
            reuse: p.reuse,
          },
          {
            capability: 'operation.run',
            decision: 'review',
            risk: op.risk,
            reason: verdict.reason,
            policy_version: policy.version,
          },
        );
        return {
          ...base,
          status: 'approval_required',
          approval_id: asked.approval_id,
          reason: `${asked.reason}; call friday_run_operation again once it is approved`,
        };
      }
    }

    // The secrets, decrypted only now and registered with the redactor before anything can print them.
    const credentials: { variable: string; name: string; value: string }[] = [];
    for (const [variable, name] of Object.entries(op.credentials).sort(([a], [b]) => a.localeCompare(b))) {
      const value = await resolveSecret(name, this.deps.env);
      if (!value) {
        return { ...base, status: 'unavailable', reason: `the secret ${name} could not be read on this machine` };
      }
      if (value.length < MIN_SECRET_LENGTH) {
        return {
          ...base,
          status: 'unavailable',
          reason: `the secret ${name} has fewer than ${MIN_SECRET_LENGTH} characters, too short to keep out of the output`,
        };
      }
      state.redactor.addSecret(value);
      credentials.push({ variable, name, value });
    }

    // Everything above was decided before the credentials loaded, which awaits. The start checks it
    // all again in the transaction that records it, and the process starts right after (review F06).
    const still = (): string | null => {
      const now = this.deps.policy();
      if (now.version !== policy.version) {
        return `the project's policy changed while ${op.name} was being prepared (${policy.version.slice(0, 12)} became ${now.version.slice(0, 12)}); ask again`;
      }
      const def = now.operations[op.name];
      if (!def) return `${op.name} is no longer declared and trusted on this clone`;
      const role = state.q.findAgent(caller.agent_id)?.role ?? '';
      if (def.roles.length && !def.roles.includes(role)) {
        return `${op.name} is for agents of the role${def.roles.length > 1 ? 's' : ''} ${def.roles.join(', ')}`;
      }
      return null;
    };
    let started: OperationRunView;
    try {
      started = state.startOperation(
        this.pid,
        caller,
        {
          operation: op.name,
          task_id: task.task_id,
          run_id: run.run_id,
          binary: prepared.binary.path,
          cwd,
          credentials: credentials.map((c) => c.name),
          approval_id,
          policy_version: policy.version,
          risk: op.risk,
          reason: p.reason,
        },
        { idempotency_key: p.idempotency_key, still },
      );
    } catch (e) {
      if (
        isFridayError(e, 'approval_required') ||
        isFridayError(e, 'invalid_state_transition') ||
        isFridayError(e, 'permission_denied')
      ) {
        return denied((e as Error).message);
      }
      throw e;
    }
    // A repeated request (same idempotency key) gets the run it started, never a second process:
    // its recorded answer may be older than the run, so the run's current state decides.
    const current = state.q.operationRun(started.operation_run_id);
    if (!this.#launched.has(started.operation_run_id) && current?.status === 'running') {
      this.#launch(started, prepared, op, credentials, profile);
    }
    return this.#wait(started.operation_run_id, p.wait_ms, signal);
  }

  /** The state of a run this agent started, after waiting up to `waitMs` for it to finish. */
  async status(caller: Caller, operationRunId: string, waitMs: number, signal?: AbortSignal): Promise<OperationResult> {
    const view = this.deps.state.q.operationRun(operationRunId);
    if (!view || view.agent_id !== caller.agent_id) {
      throw new FridayError('permission_denied', `no operation run ${operationRunId} of yours`);
    }
    return this.#wait(operationRunId, waitMs, signal);
  }

  /** At start: runs left RUNNING by a daemon that stopped are interrupted. */
  sweep(): string[] {
    return this.deps.state.interruptOrphanedOperations(
      this.pid,
      'the daemon stopped while it ran',
      new Set(this.#running.keys()),
    );
  }

  /**
   * Stops the operations of a run and resolves once their processes are confirmed gone and their
   * outcome is recorded (review F07).
   */
  async stopRun(runId: string, reason: string): Promise<void> {
    const ids = [...this.#running.entries()].filter(([, r]) => r.run_id === runId).map(([id]) => id);
    await Promise.all(ids.map((id) => this.#stop(id, reason)));
  }

  /** Stops every operation of a task: before its worktree is used or released again. */
  async stopTask(taskId: string, reason: string): Promise<void> {
    const ids = [...this.#running.entries()].filter(([, r]) => r.task_id === taskId).map(([id]) => id);
    await Promise.all(ids.map((id) => this.#stop(id, reason)));
  }

  async #stop(id: string, reason: string): Promise<void> {
    const r = this.#running.get(id);
    if (!r) return;
    if (!r.stopped) {
      r.stopped = reason;
      this.deps.logger.info('stopping operation', { operation_run_id: id, reason });
    }
    await r.stop();
    await r.done;
  }

  /** Ends every running operation's process tree, confirmed, and records it (daemon shutdown). */
  async close(): Promise<void> {
    this.#unsubscribe();
    await Promise.allSettled([...this.#running.keys()].map((id) => this.#stop(id, 'the daemon stopped')));
  }

  #launch(
    started: OperationRunView,
    prepared: PreparedRun,
    op: EffectiveOperation,
    credentials: { variable: string; name: string; value: string }[],
    profile: ExecutionProfile,
  ): void {
    const { state, logger } = this.deps;
    const id = started.operation_run_id;
    this.#launched.add(id);
    // The group exists before the process does, so a stop asked for at any moment is honoured.
    const group = this.deps.groups.create();
    const entry: Running = {
      task_id: started.task_id,
      run_id: started.run_id,
      done: Promise.resolve(),
      stop: () => group.terminate(),
      stopped: null,
    };
    this.#running.set(id, entry);
    entry.done = executeRun(prepared, profile, { timeoutMs: op.timeout_ms, credentials, group })
      .then((out) => {
        const header = [
          `$ ${prepared.binary.path} ${prepared.args.join(' ')}`,
          `(operation ${op.name} in ${prepared.cwd}; credentials: ${credentials.map((c) => c.name).join(', ') || 'none'}; exit ${out.exit_code ?? out.signal ?? 'none'})`,
          ...(entry.stopped ? [`(stopped by Friday: ${entry.stopped})`] : []),
          '',
        ].join('\n');
        // The artifact store redacts once more: the registered values and well-known formats.
        const artifact = state.artifacts?.storeText(this.pid, 'operation', `${header}${out.output}`);
        state.finishOperation(this.pid, id, {
          status: entry.stopped ? 'interrupted' : out.passed ? 'passed' : 'failed',
          exit_code: out.exit_code,
          timed_out: out.timed_out,
          duration_ms: out.duration_ms,
          redactions: out.redactions,
          artifact_ref: artifact ? `artifact:${artifact.artifact_id}` : null,
          summary: (entry.stopped
            ? `stopped: ${entry.stopped}; its processes ended`
            : summarizeOutcome({ name: op.name, ...out })
          ).slice(0, 300),
        });
        logger.info('operation finished', {
          operation: op.name,
          operation_run_id: id,
          passed: out.passed,
          stopped: entry.stopped,
        });
      })
      .catch((e: unknown) => {
        const message = (e as Error).message;
        logger.error('operation runner failed', { operation: op.name, operation_run_id: id, message });
        try {
          state.finishOperation(this.pid, id, {
            status: 'failed',
            exit_code: null,
            timed_out: false,
            duration_ms: 0,
            redactions: 0,
            artifact_ref: null,
            summary: `could not run: ${message}`.slice(0, 300),
          });
        } catch {
          // The daemon closed its database: the next start records the run as interrupted.
        }
      })
      .finally(() => {
        this.#running.delete(id);
        void group.close();
      });
  }

  async #wait(id: string, waitMs: number, signal?: AbortSignal): Promise<OperationResult> {
    const r = this.#running.get(id);
    if (r && waitMs > 0) {
      await Promise.race([r.done, sleep(waitMs, undefined, signal ? { signal } : {}).catch(() => {})]);
    }
    return this.result(id);
  }

  /** A run as the agent sees it. */
  result(id: string): OperationResult {
    const view = this.deps.state.q.operationRun(id);
    if (!view) throw new FridayError('invalid_request', `operation run ${id} not found`);
    const out: OperationResult = {
      ...blank(view.operation),
      risk: view.risk,
      status: view.status,
      operation_run_id: id,
      approval_id: view.approval_id,
      exit_code: view.exit_code,
      timed_out: view.timed_out,
      duration_ms: view.duration_ms,
      artifact_ref: view.artifact_ref,
      redactions: view.redactions,
      reason:
        view.status === 'running'
          ? `still running; call friday_run_operation with operation_run_id ${id} to wait for it`
          : (view.summary ?? view.status),
    };
    const artifactId = view.artifact_ref?.replace(/^artifact:/, '');
    if (artifactId) {
      try {
        const text = this.deps.state.artifacts?.readText(artifactId) ?? '';
        out.output = text.length > OUTPUT_TAIL ? text.slice(text.length - OUTPUT_TAIL) : text;
        out.output_truncated = text.length > OUTPUT_TAIL;
      } catch {
        // the artifact is gone; the summary stays
      }
    }
    return out;
  }

  /** What the task changed since its base, for the human who approves (ADR-0029 §3). */
  private async changedFiles(root: string, base: string | null): Promise<string[] | null> {
    try {
      const git = await GitRoot.open(root);
      const since = await git.changesSince(base);
      return since.changes.map((c) => c.path);
    } catch {
      return null;
    }
  }
}

/** The agent's reason, then what the task changed: code an operation runs may be among it. */
function justification(reason: string, op: EffectiveOperation, changed: string[] | null): string {
  const creds = Object.values(op.credentials);
  const head = `${reason} [runs ${op.command} ${op.args.join(' ')}${creds.length ? ` with ${creds.join(', ')}` : ''}]`;
  const tail =
    changed === null
      ? 'what the task changed is unknown (not a git checkout)'
      : changed.length === 0
        ? 'the task changed no files since its base'
        : `the task changed ${changed.length} file(s) since its base: ${changed.slice(0, 12).join(', ')}${changed.length > 12 ? ', ...' : ''}`;
  const text = `${head}; ${tail}`;
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}
