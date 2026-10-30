import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  AnthropicPlannerModel,
  type BrainSettings,
  DEFAULT_PLANNER_MODEL,
  FakePlannerModel,
  MasterBrain,
  ModelError,
  type ModelRequest,
  type ModelResponse,
  OpenAICompatiblePlannerModel,
  type PlannerModel,
} from '@friday/planner';
import type { CostClass, TaskView } from '@friday/protocol';
import {
  hasSecret,
  type MasterBrainConfig,
  type ProjectRef,
  providerApproval,
  providerEndpoint,
  resolveSecret,
  stateDir,
} from '@friday/sdk';
import type { FridayState } from '@friday/state';
import { buildBrainContext, buildRepositoryStatus } from './brain-context.js';
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
  #effort: MasterBrainConfig['effort'];

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly opts: {
      /** `master_brain.effort` as config.yaml has it now: read before every call (plan M11.2). */
      effort: () => MasterBrainConfig['effort'];
      cacheTtl: '5m' | '1h';
      onKey: (key: string) => void;
    },
  ) {}

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const key = await anthropicKey(this.env);
    if (!key) throw new ModelError('auth', 'no Anthropic API key; run "friday secrets set anthropic"');
    const endpoint = anthropicEndpoint(this.env);
    const effort = this.opts.effort();
    if (!this.#client || key !== this.#key || endpoint !== this.#endpoint || effort !== this.#effort) {
      this.#key = key;
      this.#endpoint = endpoint;
      this.#effort = effort;
      this.opts.onKey(key);
      this.#client = new AnthropicPlannerModel({
        apiKey: key,
        baseURL: endpoint,
        cacheTtl: this.opts.cacheTtl,
        ...(effort ? { effort } : {}),
      });
    }
    return this.#client.complete(request, signal);
  }
}

/** The stored key (decrypted with DPAPI on Windows, ADR-0029 §2), else the environment's. */
async function anthropicKey(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return (await resolveSecret('anthropic', env)) ?? (env.ANTHROPIC_API_KEY?.trim() || undefined);
}

/** What a user does when `master_brain.model` is still `auto` with a local server: there is no default model there. */
export const LOCAL_MODEL_UNSET =
  'master_brain.model names no model; set it to a model your local server has (for example qwen2.5:7b); "friday doctor" lists them';

/**
 * A model on this machine (`master_brain.provider: local`, plan M12.1): an OpenAI-compatible server
 * at a loopback address from `providers.local.base_url`, restart-only like every provider setting.
 * The model id is `master_brain.model`, read before each call; it has no default, so a call with
 * `auto` is refused here with what to set, before anything is sent.
 */
class LocalPlannerModel implements PlannerModel {
  readonly provider = 'local';
  readonly remote = false;
  readonly #client: OpenAICompatiblePlannerModel;

  constructor(opts: { baseUrl: string; apiKey?: string }) {
    this.#client = new OpenAICompatiblePlannerModel({
      baseUrl: opts.baseUrl,
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    });
  }

  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    if (request.model === 'auto') return Promise.reject(new ModelError('bad_request', LOCAL_MODEL_UNSET));
    return this.#client.complete(request, signal);
  }
}

export interface BrainStatus {
  provider: string;
  model: string;
  remote: boolean;
  /** The project asks for remote planning (`providers.<name>.allow_remote`). */
  allow_remote: boolean;
  /** The user allowed this clone to use their key on this machine (`friday brain allow-remote`). */
  approved_here: boolean;
  /**
   * Where requests go: the provider's own endpoint or one set on this machine for a remote
   * provider; the local server's address (`providers.local.base_url`) for provider `local`.
   */
  endpoint: string | null;
  /** `providers.<name>.base_url` in config.yaml, which Friday ignores for a remote provider. */
  ignored_base_url: string | null;
  /** Whether a key is stored; never the key. */
  key: 'stored' | 'environment' | 'missing' | 'not needed';
  planner_available: boolean;
  reason: string | null;
  auto_approve: boolean;
  escalate_after_failures: number;
  max_replans: number;
  /** The budget remote calls are held to; null when the planner is not remote, since none applies. */
  daily_budget_usd: number | null;
  spent_today_usd: number;
  cursor: number;
  head: number;
}

export interface BrainHandle {
  brain: MasterBrain;
  status(): BrainStatus;
}

/**
 * Builds the Master Brain from `.friday/config.yaml` (ADR-0013). `model` overrides the provider
 * (tests). The provider and its scripted answers are taken here, since the planner is built on
 * them (`master_brain.provider` and `fake_responses` need a restart, plan M11.2); the model, its
 * effort and token limit, the escalation and replan limits and `auto_approve` are read from
 * `project.config` at each use, so a changed config.yaml applies to the next planning call.
 */
export function createMasterBrain(input: {
  state: FridayState;
  project: ProjectRef;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  model?: PlannerModel | null;
  /** The effective policy: whether plans are approved without a human comes from it (ADR-0028). */
  policy?: () => { auto_approve: boolean };
  /** The model routing would run on an agent's harness for a task (ADR-0031 §9). */
  modelFit?: (
    task: TaskView,
    agentId: string,
  ) => { fit: number; cost: number; cost_class?: CostClass | null; blocked?: string } | null;
}): BrainHandle {
  const { state, project, env, logger } = input;
  /** The provider Friday started with (restart-only). */
  const started = project.config.master_brain;
  /** `master_brain` as config.yaml has it now: `project.config` is replaced when the file is read again. */
  const current = () => project.config.master_brain;
  const providerName = started.provider === 'none' ? 'none' : started.provider;
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
  // A local server's address is the one base_url the tracked file may choose: it is loopback only,
  // and no key goes there unless the user's own environment names one.
  const local = providerName === 'local';
  if (provider.base_url && !local) {
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
  } else if (started.provider === 'none') {
    reason = 'master_brain.provider is "none"';
  } else if (started.provider === 'fake') {
    const dir = started.fake_responses ? path.resolve(project.root, started.fake_responses) : undefined;
    if (dir && existsSync(dir)) model = FakePlannerModel.fromDirectory(dir);
    else reason = 'master_brain.fake_responses does not name a directory of scripted answers';
  } else if (started.provider === 'local') {
    const cfg = project.config.providers.local;
    const apiKey = cfg.api_key_env ? env[cfg.api_key_env]?.trim() || undefined : undefined;
    if (apiKey) state.redactor.addSecret(apiKey);
    try {
      model = new LocalPlannerModel({ baseUrl: cfg.base_url, ...(apiKey ? { apiKey } : {}) });
    } catch (e) {
      // The config schema already refuses a host name; this catches an https or credentialed address.
      reason = (e as Error).message;
    }
  } else {
    model = new KeyedAnthropicModel(env, {
      cacheTtl: provider.cache_ttl,
      effort: () => current().effort,
      onKey: (key) => state.redactor.addSecret(key),
    });
  }
  const modelId = () => {
    const m = current().model;
    // A local server has no default model: `auto` stays as written, and the status says what to set.
    return m !== 'auto' || local ? m : started.provider === 'fake' ? 'fake-planner' : DEFAULT_PLANNER_MODEL;
  };
  // Read on every pass: a changed config.yaml, and a trusted (or no longer trusted) policy, apply
  // without a restart. The provider's consent and budget are restart-only, like `providers`.
  const settings: BrainSettings = {
    get model() {
      return modelId();
    },
    get maxTokens() {
      return current().max_tokens;
    },
    get autoApprove() {
      return input.policy ? input.policy().auto_approve : current().auto_approve;
    },
    get escalateAfterFailures() {
      return current().escalate_after_failures;
    },
    get maxReplans() {
      return current().max_replans;
    },
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
    repositoryStatus: () => buildRepositoryStatus(project.root, state.redactor),
    log: (level, message, data) => logger[level](message, data ?? {}),
    // The daemon's recovery preserves and fences lost attempts before reassigning them (ADR-0026).
    lostWork: 'external',
    ...(input.modelFit ? { modelFit: input.modelFit } : {}),
  });

  return {
    brain,
    status: () => {
      const pid = project.project_id;
      const remote = model?.remote ?? false;
      const stored = hasSecret('anthropic', env);
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
            : local && model && current().model === 'auto'
              ? LOCAL_MODEL_UNSET
              : null);
      return {
        provider: model?.provider ?? started.provider,
        model: modelId(),
        remote,
        allow_remote: provider.allow_remote,
        approved_here: Boolean(providerApproval(project, providerName === 'none' ? 'anthropic' : providerName, env)),
        endpoint: remote ? anthropicEndpoint(env) : local ? project.config.providers.local.base_url : null,
        ignored_base_url: local ? null : (provider.base_url ?? null),
        key,
        planner_available: !unavailable,
        reason: unavailable,
        auto_approve: current().auto_approve,
        escalate_after_failures: current().escalate_after_failures,
        max_replans: current().max_replans,
        // No budget holds a model that costs nothing: only remote calls have one (ADR-0015 §4).
        daily_budget_usd: remote ? consent.dailyBudgetUsd : null,
        spent_today_usd: model ? state.q.modelSpend(pid, model.provider, dayStart) : 0,
        cursor: state.q.brainCursor(pid),
        head: state.store.head(pid),
      };
    },
  };
}
