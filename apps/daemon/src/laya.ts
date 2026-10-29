import type { TaskView } from '@friday/protocol';
import {
  applicablePins,
  askLaya,
  type LayaAnswer,
  LayaError,
  type LayaQuestion,
  layaQuestion,
  loadGuide,
} from '@friday/routing';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import type { Logger } from './log.js';
import type { RoutingService } from './routing.js';

/** What routing knows from Laya about a task's current question (review F11). */
export type LayaStatus = 'off' | 'answered' | 'unavailable' | 'pending';

/**
 * Laya in the daemon (ADR-0031 §10): asked when a task becomes READY, outside any transaction, and
 * stored with its question's identity; at routing time a stored answer counts only while the question
 * still stands, with the threshold fitted for its checkpoint and option count. Laya runs on this
 * machine; when it does not answer within its deadline, that is recorded, and routing goes on
 * without it.
 *
 * Automatic delegation waits for the answer, or for the record that there is none, for the task
 * that asked only (review F11): `ready` says whether it may be routed. The deadline is Laya's own
 * timeout, which covers the whole answer.
 */
export class LayaService {
  readonly #inflight = new Map<string, { question_id: string; ctrl: AbortController }>();
  #closed = false;

  constructor(
    private readonly deps: { state: FridayState; project: ProjectRef; logger: Logger; routing: RoutingService },
  ) {}

  private get pid() {
    return this.deps.project.project_id;
  }

  get enabled(): boolean {
    return this.deps.project.config.routing.laya.enabled;
  }

  /** The question routing would ask about this task now (same inputs, same identity). */
  question(task: TaskView): LayaQuestion | null {
    const guide = loadGuide();
    const cls = guide.classes[task.role ? `role:${task.role}` : ''] ?? guide.classes[task.kind];
    const summary = this.deps.state.redactor.redactString(task.summary).value;
    return layaQuestion(
      { task_id: task.task_id, kind: task.kind, role: task.role ?? null, summary },
      this.deps.routing.models,
      this.deps.routing.settings,
      cls?.avoid ?? [],
      this.deps.routing.guideVersion,
      this.deps.project.config.routing.laya.model ?? null,
    );
  }

  /** Whether routing would consult Laya for this task: auto or hybrid, and no pinned model. */
  private wanted(task: TaskView): boolean {
    if (!this.enabled) return false;
    const pins = applicablePins(this.deps.routing.pins(), {
      task_id: task.task_id,
      kind: task.kind,
      role: task.role ?? null,
    });
    if (pins.some((p) => p.model)) return false;
    const mode = pins.find((p) => p.mode)?.mode ?? this.deps.routing.settings.mode;
    return mode === 'auto' || mode === 'hybrid';
  }

  /** What routing knows from Laya about the task's current question. */
  status(task: TaskView): LayaStatus {
    if (!this.wanted(task)) return 'off';
    const q = this.question(task);
    if (!q) return 'off';
    if (this.deps.state.q.layaAnswer(this.pid, task.task_id)?.question_id === q.question_id) return 'answered';
    const failed = this.deps.state.store
      .readByRef(this.pid, 'task', task.task_id, { types: ['laya.unavailable'] })
      .some((e) => (e.payload as { question_id?: string }).question_id === q.question_id);
    return failed ? 'unavailable' : 'pending';
  }

  /**
   * Whether the task may be routed now (review F11): Laya is not consulted for it, answered its
   * question, or is recorded as not answering it. Otherwise the question is asked (again, after a
   * restart) and the task waits; Laya's deadline bounds the wait.
   */
  ready(task: TaskView): boolean {
    const s = this.status(task);
    if (s !== 'pending') return true;
    if (!this.#inflight.has(task.task_id)) void this.ask(task.task_id);
    return false;
  }

  /** Asks Laya about a task that just became READY (or still waits for its answer). Never throws. */
  async ask(taskId: string): Promise<void> {
    if (this.#closed || this.#inflight.has(taskId)) return;
    const { state, logger } = this.deps;
    const task = state.q.findTask(this.pid, taskId);
    if (!task || !this.wanted(task)) return;
    const q = this.question(task);
    if (!q) return;
    const ctrl = new AbortController();
    this.#inflight.set(taskId, { question_id: q.question_id, ctrl });
    const cfg = this.deps.project.config.routing.laya;
    try {
      const reply = await askLaya(
        { url: cfg.url, model: cfg.model, timeout_ms: cfg.timeout_ms, signal: ctrl.signal },
        q,
      );
      state.recordLayaAnswer(this.pid, {
        task_id: taskId,
        question_id: q.question_id,
        checkpoint: reply.checkpoint,
        choice: reply.choice,
        confidence: reply.confidence,
        basis: reply.basis,
        options: q.options.length,
        probabilities: reply.probabilities,
        latency_ms: reply.latency_ms,
      });
    } catch (e) {
      const kind = e instanceof LayaError ? e.kind : 'error';
      // Cancelled: the task or the daemon went away, and there is nothing to record.
      if (kind === 'cancelled') return;
      logger.warn('laya did not answer; routing goes on without it', {
        task_id: taskId,
        kind,
        message: (e as Error).message,
      });
      try {
        state.recordObservation(
          this.pid,
          { kind: 'system', id: 'laya' },
          'laya.unavailable',
          {
            task_id: taskId,
            question_id: q.question_id,
            kind,
            message: (e as Error).message.slice(0, 300),
          },
          [{ kind: 'task', id: taskId }],
        );
      } catch (inner) {
        logger.error('recording that Laya did not answer failed', {
          task_id: taskId,
          message: (inner as Error).message,
        });
      }
    } finally {
      this.#inflight.delete(taskId);
    }
  }

  /** The task was cancelled: its question no longer matters. */
  cancel(taskId: string): void {
    this.#inflight.get(taskId)?.ctrl.abort();
  }

  /** At start: READY tasks whose question has no answer, nor a record of none, are asked. */
  async sweep(): Promise<void> {
    if (!this.enabled) return;
    for (const t of this.deps.state.q.tasks(this.pid, { statuses: ['READY'] })) {
      if (this.#closed) return;
      if (this.status(t) === 'pending') await this.ask(t.task_id);
    }
  }

  /** The daemon is closing: every request in flight ends now. */
  close(): void {
    this.#closed = true;
    for (const f of this.#inflight.values()) f.ctrl.abort();
  }

  /** The stored answer for routing, when its question still stands, with its fitted threshold. */
  answerFor(taskId: string): LayaAnswer | null {
    if (!this.enabled) return null;
    const { state } = this.deps;
    const stored = state.q.layaAnswer(this.pid, taskId);
    const task = state.q.findTask(this.pid, taskId);
    if (!stored || !task) return null;
    if (this.question(task)?.question_id !== stored.question_id) return null;
    const shape = `choice:${stored.options}`;
    const fitted = state.q
      .layaCalibrations(this.pid)
      .find((c) => c.checkpoint === stored.checkpoint && c.shape === shape);
    return {
      question_id: stored.question_id,
      checkpoint: stored.checkpoint,
      choice: stored.choice,
      confidence: stored.confidence,
      threshold: fitted?.threshold ?? null,
    };
  }
}
