import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  AnthropicPlannerModel,
  DEFAULT_PLANNER_MODEL,
  FakePlannerModel,
  MasterBrain,
  ModelError,
  type ModelRequest,
  type ModelResponse,
  type PlannerModel,
} from '@friday/planner';
import { type ProjectRef, readSecret } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import { buildBrainContext } from './brain-context.js';
import type { Logger } from './log.js';

/**
 * Anthropic, with the key looked up at call time (`friday secrets set anthropic`, else
 * ANTHROPIC_API_KEY): storing a key needs no daemon restart, and a missing key becomes an
 * escalation exactly when planning is attempted. The key is never logged or recorded.
 */
class KeyedAnthropicModel implements PlannerModel {
  readonly provider = 'anthropic';
  readonly remote = true;
  #client: AnthropicPlannerModel | undefined;
  #key: string | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly opts: {
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      cacheTtl: '5m' | '1h';
      baseURL?: string;
    },
  ) {}

  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const key = anthropicKey(this.env);
    if (!key) throw new ModelError('auth', 'no Anthropic API key; run "friday secrets set anthropic"');
    if (!this.#client || key !== this.#key) {
      this.#key = key;
      this.#client = new AnthropicPlannerModel({
        apiKey: key,
        cacheTtl: this.opts.cacheTtl,
        ...(this.opts.effort ? { effort: this.opts.effort } : {}),
        ...(this.opts.baseURL ? { baseURL: this.opts.baseURL } : {}),
      });
    }
    return this.#client.complete(request, signal);
  }
}

function anthropicKey(env: NodeJS.ProcessEnv): string | undefined {
  return readSecret('anthropic', env) ?? (env.ANTHROPIC_API_KEY?.trim() || undefined);
}

export interface BrainStatus {
  provider: string;
  model: string;
  remote: boolean;
  allow_remote: boolean;
  /** Whether a key is stored; never the key. */
  key: 'stored' | 'environment' | 'missing' | 'not needed';
  planner_available: boolean;
  reason: string | null;
  auto_approve: boolean;
  escalate_after_failures: number;
  max_replans: number;
  daily_budget_usd: number;
  spent_today_usd: number;
  cursor: number;
  head: number;
}

export interface BrainHandle {
  brain: MasterBrain;
  status(): BrainStatus;
}

/** Builds the Master Brain from `.friday/config.yaml` (ADR-0013). `model` overrides the provider (tests). */
export function createMasterBrain(input: {
  state: FridayState;
  project: ProjectRef;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  model?: PlannerModel | null;
}): BrainHandle {
  const { state, project, env, logger } = input;
  const cfg = project.config.master_brain;
  const providerName = cfg.provider === 'none' ? 'none' : cfg.provider;
  const provider = project.config.providers[providerName] ?? {
    allow_remote: false,
    daily_budget_usd: 5,
    cache_ttl: '5m' as const,
  };

  let model: PlannerModel | null = null;
  let reason: string | undefined;
  if (input.model !== undefined) {
    model = input.model;
    if (!model) reason = 'no planner is configured';
  } else if (cfg.provider === 'none') {
    reason = 'master_brain.provider is "none"';
  } else if (cfg.provider === 'fake') {
    const dir = cfg.fake_responses ? path.resolve(project.root, cfg.fake_responses) : undefined;
    if (dir && existsSync(dir)) model = FakePlannerModel.fromDirectory(dir);
    else reason = 'master_brain.fake_responses does not name a directory of scripted answers';
  } else {
    model = new KeyedAnthropicModel(env, {
      cacheTtl: provider.cache_ttl,
      ...(cfg.effort ? { effort: cfg.effort } : {}),
      ...(provider.base_url ? { baseURL: provider.base_url } : {}),
    });
  }
  const modelId = cfg.model !== 'auto' ? cfg.model : cfg.provider === 'fake' ? 'fake-planner' : DEFAULT_PLANNER_MODEL;
  const settings = {
    model: modelId,
    maxTokens: cfg.max_tokens,
    autoApprove: cfg.auto_approve,
    escalateAfterFailures: cfg.escalate_after_failures,
    maxReplans: cfg.max_replans,
    allowRemote: provider.allow_remote,
    dailyBudgetUsd: provider.daily_budget_usd,
    ...(provider.prices ? { prices: provider.prices } : {}),
  };
  const brain = new MasterBrain({
    state,
    projectId: project.project_id,
    model,
    ...(reason ? { plannerUnavailable: reason } : {}),
    settings,
    projectContext: () => buildBrainContext(state, project),
    log: (level, message, data) => logger[level](message, data ?? {}),
  });

  return {
    brain,
    status: () => {
      const pid = project.project_id;
      const remote = model?.remote ?? false;
      const stored = readSecret('anthropic', env) !== undefined;
      const key: BrainStatus['key'] = !remote
        ? 'not needed'
        : stored
          ? 'stored'
          : env.ANTHROPIC_API_KEY?.trim()
            ? 'environment'
            : 'missing';
      const dayStart = `${state.clock.now().slice(0, 10)}T00:00:00.000Z`;
      const unavailable =
        reason ??
        (remote && !provider.allow_remote
          ? `remote calls are off: set providers.${providerName}.allow_remote: true`
          : key === 'missing'
            ? 'no Anthropic API key: run "friday secrets set anthropic"'
            : null);
      return {
        provider: model?.provider ?? cfg.provider,
        model: modelId,
        remote,
        allow_remote: provider.allow_remote,
        key,
        planner_available: !unavailable,
        reason: unavailable,
        auto_approve: cfg.auto_approve,
        escalate_after_failures: cfg.escalate_after_failures,
        max_replans: cfg.max_replans,
        daily_budget_usd: provider.daily_budget_usd,
        spent_today_usd: model ? state.q.modelSpend(pid, model.provider, dayStart) : 0,
        cursor: state.q.brainCursor(pid),
        head: state.store.head(pid),
      };
    },
  };
}
