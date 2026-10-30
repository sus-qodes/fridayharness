import { CostClass, type TaskView } from '@friday/protocol';
import {
  decideRoute,
  type Evidence,
  type LayaAnswer,
  loadGuide,
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
import { type FridayState, type HarnessRecord, hostCohort, type RunRouter } from '@friday/state';
import { checksVersion } from '@friday/verification';
import type { Logger } from './log.js';

/**
 * Model routing in the daemon (ADR-0031): the registry (Friday's priors and the project's models),
 * the guide, the human pins and the measured evidence feed one pure decision, made for every new
 * run inside its transaction, and on request as a dry run.
 */
export class RoutingService {
  readonly models: ModelRecord[];
  readonly settings: RoutingSettings;
  readonly guideVersion: string;
  /** Friday's candidates plus the project's `routing.role_candidates` extensions. */
  roleRegistry: RoleRegistry;
  /** Whether `routing.static_registry.enabled` makes the registry the dispatch authority. */
  staticRegistryEnabled: boolean;
  /** Laya's stored answer for a task (M7c), when its question still stands. */
  laya: (taskId: string) => LayaAnswer | null = () => null;
  /** Why there is no answer, for the decision's record (review F11). */
  layaStatus: (taskId: string) => RouteInput['laya_status'] = () => 'off';

  constructor(private readonly deps: { state: FridayState; project: ProjectRef; logger: Logger }) {
    const guide = loadGuide();
    const r = deps.project.config.routing;
    this.guideVersion = guide.version;
    // The Master Brain's local model is in the registry too (plan M12.1), so the locality rule knows it.
    this.models = mergeModels(guide.models, r.models as ModelRecordInput[], deps.project.config.master_brain);
    this.settings = {
      mode: r.mode,
      optimize: r.optimize,
      default_model: r.default_model,
      must_use_local: r.must_use_local,
      prefer_cheaper_if_score_delta_below: r.prefer_cheaper_if_score_delta_below,
      low_confidence: r.low_confidence,
      min_samples: r.min_samples,
      sensitive: r.sensitive,
      profile_preferences: r.profile_preferences,
    };
    this.roleRegistry = withProjectRoleCandidates(ROLE_REGISTRY_SOURCE, r.role_candidates);
    this.staticRegistryEnabled = r.static_registry.enabled;
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

  /**
   * Measured outcomes (review F15): runs whose model was observed, judged by the current checks,
   * and, for a harness, on its host version.
   */
  evidence(harness?: HarnessRecord | null): Evidence[] {
    return this.deps.state.q
      .modelEvidence(this.pid, {
        checksVersion: this.checksVersion,
        hostCohort: harness ? hostCohort(harness.vendor, harness.version) : null,
      })
      .map((e) => ({ model: e.model, task_class: e.task_class, samples: e.samples, passed: e.passed }));
  }

  private input(
    task: {
      task_id: string;
      kind: string;
      role: string | null;
      summary: string;
      risk_level: 'low' | 'medium' | 'high' | null;
      scope: { write: readonly string[]; read: readonly string[] } | null;
    },
    harness: HarnessRecord | null,
  ): RouteInput {
    const caps = (harness?.capabilities ?? {}) as { models?: unknown; model_control?: unknown };
    const declared = Array.isArray(caps.models) ? caps.models.filter((m): m is string => typeof m === 'string') : null;
    const guide = loadGuide();
    const base: RouteInput = {
      task,
      vendor: harness?.vendor ?? null,
      harness_models: declared,
      model_control: caps.model_control === 'set' ? 'set' : 'none',
      observed_model: harness?.observed_model ?? null,
      models: this.models,
      guide: guide.classes,
      profiles: guide.profiles,
      guide_version: this.guideVersion,
      settings: this.settings,
      pins: this.pins(),
      evidence: this.evidence(harness),
      laya: null,
      ...(this.staticRegistryEnabled ? { role_registry: this.roleRegistry } : {}),
    };
    return { ...base, laya: this.laya(task.task_id), laya_status: this.layaStatus(task.task_id) };
  }

  /** The router the state calls for every new run (ADR-0031 §6). */
  readonly router: RunRouter = ({ task, harness }) => {
    const decision = decideRoute(this.input(task, harness));
    if (decision.model === null && decision.source === 'none') {
      this.deps.logger.info('routing chose no model', { task_id: task.task_id, reason: decision.reason });
    }
    return { decision: { ...decision } };
  };

  /**
   * How well the model routing would run on an agent's harness fits a task, and its cost relative to
   * the dearest model Friday knows (ADR-0031 §9): what delegation weighs.
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
      fit: chosen?.fit ?? (d.model ? 0.5 : 0),
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
