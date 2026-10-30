import { CostClass, type TaskView } from '@friday/protocol';
import {
  decideRoute,
  loadModelCatalog,
  type ModelRecord,
  type ModelRecordInput,
  mergeModels,
  modelCostClass,
  ROLE_REGISTRY_SOURCE,
  type RoleRegistry,
  type RouteInput,
  type RoutingDecision,
  type RoutingPin,
  type RoutingSettings,
  validateRoleRegistry,
  withProjectRoleCandidates,
} from '@friday/routing';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState, HarnessRecord, RunRouter } from '@friday/state';
import { checksVersion } from '@friday/verification';
import type { Logger } from './log.js';

/**
 * Model routing in the daemon (ADR-0031's 2026-10-21 amendment): the model catalog, the typed static
 * role registry, human pins and hard constraints feed one pure decision, made for every new run
 * inside its transaction, and on request as a dry run.
 */
export class RoutingService {
  readonly models: ModelRecord[];
  readonly settings: RoutingSettings;
  /** Friday's candidates plus the project's `routing.role_candidates` extensions. */
  roleRegistry: RoleRegistry;

  constructor(private readonly deps: { state: FridayState; project: ProjectRef; logger: Logger }) {
    const catalog = loadModelCatalog();
    const r = deps.project.config.routing;
    // The Master Brain's local model is in the catalog too (plan M12.1), so the locality rule knows it.
    this.models = mergeModels(catalog.models, r.models as ModelRecordInput[], deps.project.config.master_brain);
    this.settings = {
      must_use_local: r.must_use_local,
      sensitive: r.sensitive,
    };
    this.roleRegistry = withProjectRoleCandidates(ROLE_REGISTRY_SOURCE, r.role_candidates);
    validateRoleRegistry(this.roleRegistry, this.models);
  }

  private get pid() {
    return this.deps.project.project_id;
  }

  /** The pins in force now. */
  pins(): RoutingPin[] {
    return this.deps.state.q.routingPins(this.pid, this.deps.state.clock.now());
  }

  /** The checks that judge each kind of task now, as versions: outcomes under others are another cohort. */
  checksVersion = (kind: string): string => checksVersion(this.deps.project.config.verification.checks, kind);

  private input(task: TaskView, harness: HarnessRecord | null): RouteInput {
    const caps = (harness?.capabilities ?? {}) as { models?: unknown; model_control?: unknown };
    const declared = Array.isArray(caps.models) ? caps.models.filter((m): m is string => typeof m === 'string') : null;
    return {
      task,
      vendor: harness?.vendor ?? null,
      harness_models: declared,
      model_control: caps.model_control === 'set' ? 'set' : 'none',
      observed_model: harness?.observed_model ?? null,
      models: this.models,
      settings: this.settings,
      pins: this.pins(),
      role_registry: this.roleRegistry,
    };
  }

  /** The router the state calls for every new run (ADR-0031 §6). */
  readonly router: RunRouter = ({ task, harness }) => {
    const decision = decideRoute(this.input(task, harness));
    if (decision.blocked) {
      this.deps.logger.info('routing blocked the run', { task_id: task.task_id, reason: decision.reason });
    }
    return { decision: { ...decision } };
  };

  /**
   * How well the model routing would run on an agent's harness fits a task, and its cost relative to
   * the dearest model Friday knows (ADR-0031 §9): what delegation weighs. With registry dispatch,
   * fit is the candidate's rank preference; a human pin is fully preferred.
   */
  fitFor(
    task: TaskView,
    agentId: string,
  ): { fit: number; cost: number; cost_class: CostClass | null; blocked?: string } | null {
    const agent = this.deps.state.q.findAgent(agentId);
    const harness = agent?.harness_id ? this.deps.state.q.findHarness(agent.harness_id) : undefined;
    if (!agent || !harness) return null;
    const d = decideRoute(this.input(task, harness));
    // The agent's cost class (plan M13.3): as its harness declared it, else its model's.
    const declared = CostClass.safeParse((harness.capabilities as { cost_class?: unknown } | null)?.cost_class);
    // An agent whose route blocks the task has no class for it: it cannot take it (review of M13).
    if (d.blocked) return { fit: 0, cost: 0, cost_class: null, blocked: d.reason };
    const chosen = d.candidates.find((c) => c.model === d.model);
    const model = this.models.find((m) => m.id === d.model);
    const dearest = Math.max(0, ...this.models.map((m) => (m.price ? (m.price.input + m.price.output) / 2 : 0)));
    const cost = model?.price && dearest > 0 ? (model.price.input + model.price.output) / 2 / dearest : 0;
    return {
      fit: chosen?.fit ?? (d.model ? 1 : 0),
      cost: Math.round(cost * 1000) / 1000,
      cost_class: declared.success ? declared.data : d.model ? modelCostClass(model) : 'standard',
    };
  }

  /** What routing would choose for a task now, on any harness (a dry run; nothing is recorded). */
  explain(taskId: string): RoutingDecision {
    const task = this.deps.state.q.task(this.pid, taskId);
    return decideRoute(this.input(task, null));
  }
}
