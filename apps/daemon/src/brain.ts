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
import { type ProjectRef, providerApproval, providerEndpoint, readSecret, stateDir } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import { buildBrainContext } from './brain-context.js';
import type { Logger } from './log.js';

/** Where the user's Anthropic key may be sent: an endpoint chosen on this machine, else the default (review F03). */
export function anthropicEndpoint(env: NodeJS.ProcessEnv): string {
  return providerEndpoint('anthropic', env) ?? env.ANTHROPIC_BASE_URL?.trim() ?? 'https://api.anthropic.com';
}

/**
 * Anthropic, with the key looked up at call time (`friday secrets set anthropic`, else
 * ANTHROPIC_API_KEY): storing a key needs no daemon restart, and a missing key becomes an
 * escalation exactly when planning is attempted. The key is never logged or recorded, and the
 * redactor masks it, so it cannot be echoed into a prompt or an event. The endpoint comes from
 * this machine only, never from the tracked config (review F03).
 */
class KeyedAnthropicModel implements PlannerModel {
  readonly provider = 'anthropic';
  readonly remote = true;
  #client: AnthropicPlannerModel | undefined;
  #key: string | undefined;
  #endpoint: string | undefined;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly opts: {
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      cacheTtl: '5m' | '1h';
      onKey: (key: string) => void;
    },
  ) {}

  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const key = anthropicKey(this.env);
    if (!key) throw new ModelError('auth', 'no Anthropic API key; run "friday secrets set anthropic"');
    const endpoint = anthropicEndpoint(this.env);
    if (!this.#client || key !== this.#key || endpoint !== this.#endpoint) {
      this.#key = key;
      this.#endpoint = endpoint;
      this.opts.onKey(key);
      this.#client = new AnthropicPlannerModel({
        apiKey: key,
        baseURL: endpoint,
        cacheTtl: this.opts.cacheTtl,
        ...(this.opts.effort ? { effort: this.opts.effort } : {}),
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
  /** The project asks for remote planning (`providers.<name>.allow_remote`). */
  allow_remote: boolean;
  /** The user allowed this clone to use their key on this machine (`friday brain allow-remote`). */
  approved_here: boolean;
  /** Where the key is sent: the provider's own endpoint, or one set on this machine. */
  endpoint: string | null;
  /** `providers.<name>.base_url` in config.yaml, which Friday ignores. */
  ignored_base_url: string | null;
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
  /** The effective policy: whether plans are approved without a human comes from it (ADR-0028). */
  policy?: () => { auto_approve: boolean };
}): BrainHandle {
  const { state, project, env, logger } = input;
  const cfg = project.config.master_brain;
  const providerName = cfg.provider === 'none' ? 'none' : cfg.provider;
  const provider = project.config.providers[providerName] ?? {
    allow_remote: false,
    daily_budget_usd: 5,
    cache_ttl: '5m' as const,
  };

  /** Consent as it is now: the project's request and this clone's local approval (review F03). */
  const remotePolicy = () => {
    const approval = providerApproval(project, providerName === 'none' ? 'anthropic' : providerName, env);
    const budget = Math.min(provider.daily_budget_usd, approval?.daily_budget_usd ?? Number.POSITIVE_INFINITY);
    const refusal = !provider.allow_remote
      ? `remote calls to ${providerName} are off for this project; set providers.${providerName}.allow_remote: true in .friday/config.yaml, then run "friday brain allow-remote"`
      : !approval
        ? `this project asks for remote planning, but you have not allowed it on this machine; run "friday brain allow-remote" in the project`
        : undefined;
    return {
      allowRemote: provider.allow_remote && Boolean(approval),
      dailyBudgetUsd: budget,
      ...(refusal ? { refusal } : {}),
    };
  };
  if (provider.base_url) {
    logger.warn(
      'providers.base_url in config.yaml is ignored; set an endpoint with "friday secrets set <provider> --base-url"',
      {
        provider: providerName,
      },
    );
  }

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
      onKey: (key) => state.redactor.addSecret(key),
    });
  }
  const modelId = cfg.model !== 'auto' ? cfg.model : cfg.provider === 'fake' ? 'fake-planner' : DEFAULT_PLANNER_MODEL;
  const settings = {
    model: modelId,
    maxTokens: cfg.max_tokens,
    autoApprove: input.policy ? input.policy().auto_approve : cfg.auto_approve,
    escalateAfterFailures: cfg.escalate_after_failures,
    maxReplans: cfg.max_replans,
    allowRemote: provider.allow_remote,
    dailyBudgetUsd: provider.daily_budget_usd,
    ...(provider.prices ? { prices: provider.prices } : {}),
  };
  // Read on every pass, so a trusted (or no longer trusted) policy applies without a restart.
  if (input.policy)
    Object.defineProperty(settings, 'autoApprove', { get: () => input.policy?.().auto_approve ?? false });
  const brain = new MasterBrain({
    state,
    projectId: project.project_id,
    model,
    ...(reason ? { plannerUnavailable: reason } : {}),
    settings,
    remotePolicy,
    projectContext: () =>
      buildBrainContext(state, project, {
        redactor: state.redactor,
        stateDir: stateDir(env),
        onSources: (sources) => {
          const skipped = sources.filter((x) => !x.included);
          if (skipped.length) logger.info('planning context skipped files', { skipped });
        },
      }),
    log: (level, message, data) => logger[level](message, data ?? {}),
    // The daemon's recovery preserves and fences lost attempts before reassigning them (ADR-0026).
    lostWork: 'external',
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
      const consent = remotePolicy();
      const unavailable =
        reason ??
        (remote && !consent.allowRemote
          ? (consent.refusal ?? 'remote calls are off')
          : key === 'missing'
            ? 'no Anthropic API key: run "friday secrets set anthropic"'
            : null);
      return {
        provider: model?.provider ?? cfg.provider,
        model: modelId,
        remote,
        allow_remote: provider.allow_remote,
        approved_here: Boolean(providerApproval(project, providerName === 'none' ? 'anthropic' : providerName, env)),
        endpoint: remote ? anthropicEndpoint(env) : null,
        ignored_base_url: provider.base_url ?? null,
        key,
        planner_available: !unavailable,
        reason: unavailable,
        auto_approve: cfg.auto_approve,
        escalate_after_failures: cfg.escalate_after_failures,
        max_replans: cfg.max_replans,
        daily_budget_usd: consent.dailyBudgetUsd,
        spent_today_usd: model ? state.q.modelSpend(pid, model.provider, dayStart) : 0,
        cursor: state.q.brainCursor(pid),
        head: state.store.head(pid),
      };
    },
  };
}
