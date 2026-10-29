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

/**
 * Laya in the daemon (ADR-0031 §10): asked when a task becomes READY, outside any transaction, and
 * stored with its question's identity; at routing time a stored answer counts only while the question
 * still stands, with the threshold fitted for its checkpoint and option count. Laya runs on this
 * machine; when it does not answer, routing goes on without it.
 */
export class LayaService {
  readonly #asking = new Set<string>();

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

  /** Asks Laya about a task that just became READY. Never throws. */
  async ask(taskId: string): Promise<void> {
    if (this.#asking.has(taskId)) return;
    const { state, logger } = this.deps;
    const task = state.q.findTask(this.pid, taskId);
    if (!task || !this.wanted(task)) return;
    const q = this.question(task);
    if (!q) return;
    this.#asking.add(taskId);
    const cfg = this.deps.project.config.routing.laya;
    try {
      const reply = await askLaya({ url: cfg.url, model: cfg.model, timeout_ms: cfg.timeout_ms }, q);
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
      this.#asking.delete(taskId);
    }
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
