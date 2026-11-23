import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  AnthropicPlannerModel,
  type BrainSettings,
  CODEX_DEFAULT_MODEL,
  ClaudeCodePlannerModel,
  CodexPlannerModel,
  DEFAULT_PLANNER_MODEL,
  FakePlannerModel,
  keyRefused,
  localEndpoint,
  MasterBrain,
  ModelError,
  type ModelRequest,
  type ModelResponse,
  OpenAICompatiblePlannerModel,
  type PlannerModel,
  priceEntry,
} from '@friday/planner';
import { type CostClass, FridayError, type PlannerOptionView, type TaskView } from '@friday/protocol';
import {
  choosePlanner,
  choosePlannerModel,
  hasSecret,
  KEYED_PLANNERS,
  type KeyedPlanner,
  keyedPlanner,
  type MasterBrainConfig,
  type PlannerChoice,
  type ProjectRef,
  type ProviderConfig,
  plannerChoice,
  plannerModelChoice,
  providerApproval,
  providerEndpoint,
  resolveSecret,
  revokeProvider,
  setProviderEndpoint,
  stateDir,
} from '@friday/sdk';
import type { FridayState } from '@friday/state';
import { buildBrainContext, buildIntentSources, buildRepositoryStatus } from './brain-context.js';
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

/** What a person does when a key service or a local server has no model named yet. */
export const MODEL_UNSET = 'no model is chosen for it yet: choose one in Settings, under Planner';

/** The address of the model server on this machine: one set on this machine, else the project's. */
export function localBaseUrl(project: ProjectRef, env: NodeJS.ProcessEnv): string {
  return providerEndpoint('local', env) ?? project.config.providers.local.base_url;
}

/** Where a key service is reached: an endpoint the person set on this machine, else Friday's own for it. */
export function keyedEndpoint(k: KeyedPlanner, env: NodeJS.ProcessEnv): string {
  return providerEndpoint(k.id, env) ?? k.endpoint;
}

/** The stored key of a service (decrypted with DPAPI on Windows), else the environment's. */
async function keyedKey(k: KeyedPlanner, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return (await resolveSecret(k.id, env)) ?? (env[k.key_env]?.trim() || undefined);
}

/**
 * A service reached with the person's own key (2026-11-23: OpenAI, Gemini, DeepSeek, OpenRouter),
 * over the OpenAI-compatible chat API. As for Anthropic: the key is looked up at call time, never
 * logged or recorded and masked by the redactor; the address is Friday's own for the service, or
 * one set on this machine, never one from the tracked config (review F03). No price list is known
 * for these services, so the planner is held to requests a day (`unpriced`).
 */
class KeyedCompatibleModel implements PlannerModel {
  readonly provider: string;
  readonly remote = true;
  readonly unpriced = true;
  #client: OpenAICompatiblePlannerModel | undefined;
  #key: string | undefined;
  #endpoint: string | undefined;

  constructor(
    private readonly service: KeyedPlanner,
    private readonly env: NodeJS.ProcessEnv,
    private readonly onKey: (key: string) => void,
  ) {
    this.provider = service.id;
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const key = await keyedKey(this.service, this.env);
    if (!key) throw new ModelError('auth', `no ${this.service.label} key is stored on this computer`);
    if (request.model === 'auto') throw new ModelError('bad_request', MODEL_UNSET);
    const endpoint = keyedEndpoint(this.service, this.env);
    if (!this.#client || key !== this.#key || endpoint !== this.#endpoint) {
      this.#key = key;
      this.#endpoint = endpoint;
      this.onKey(key);
      this.#client = new OpenAICompatiblePlannerModel({
        baseUrl: endpoint,
        apiKey: key,
        remote: true,
        provider: this.service.id,
        label: this.service.label,
        tokenParam: this.service.token_param,
      });
    }
    return this.#client.complete(request, signal);
  }
}

/**
 * The models a key service or the local server offers (`GET <endpoint>/models`), for a person to
 * pick from instead of typing a name. Read only on the person's request, with their stored key.
 */
export async function listPlannerModels(
  project: ProjectRef,
  provider: string,
  env: NodeJS.ProcessEnv,
  doFetch: typeof fetch = fetch,
): Promise<string[]> {
  const service = keyedPlanner(provider);
  let base: URL;
  let key: string | undefined;
  if (service) {
    key = await keyedKey(service, env);
    if (!key) throw new FridayError('invalid_request', `no ${service.label} key is stored on this computer yet`);
    base = new URL(keyedEndpoint(service, env));
    if (base.protocol !== 'https:') throw new FridayError('invalid_request', 'a key is only sent over https');
  } else if (provider === 'local') {
    const cfg = project.config.providers.local;
    key = cfg.api_key_env ? env[cfg.api_key_env]?.trim() || undefined : undefined;
    try {
      base = localEndpoint(localBaseUrl(project, env));
    } catch (e) {
      throw new FridayError('invalid_request', (e as Error).message);
    }
  } else {
    throw new FridayError('invalid_request', `Friday cannot list the models of "${provider}"`);
  }
  const who = service?.label ?? 'the model server on this computer';
  let res: Response;
  try {
    res = await doFetch(`${base.origin}${base.pathname.replace(/\/$/, '')}/models`, {
      redirect: 'manual',
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new FridayError(
      'invalid_request',
      service
        ? `${who} could not be reached: ${(e as Error).message}`
        : `no model server answers at ${base.origin}: start it (Ollama, LM Studio), then look again`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    throw new FridayError('invalid_request', `${who} rejected the key (${res.status})`);
  }
  // Gemini answers 400 for a key it does not take.
  if (res.status === 400 && service) {
    const said = await res.text().catch(() => '');
    if (keyRefused(said)) throw new FridayError('invalid_request', `${who} rejected the key (400)`);
    throw new FridayError('invalid_request', `${who} did not list its models (400)`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new FridayError('invalid_request', `${who} did not list its models (${res.status})`);
  }
  const body = (await res.json().catch(() => null)) as { data?: unknown; models?: unknown } | null;
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const ids = rows
    .map((r) =>
      r && typeof r === 'object' ? ((r as { id?: unknown; name?: unknown }).id ?? (r as { name?: unknown }).name) : r,
    )
    .filter(
      (id): id is string =>
        typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(id.replace(/^models\//, '')),
    )
    // Gemini lists its models as "models/<id>": the id is what a request names.
    .map((id) => id.replace(/^models\//, ''));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 500);
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
  /** This machine's choice of planner, the project's, and the one that counts (see `BrainStatusView`). */
  choice: { here: string | null; project: string; wanted: string };
  /** This machine's choice of the planner's model, the project's, and whether a choice here applies. */
  model_choice: { here: string | null; project: string; applies: boolean };
  /** What planning through Claude Code needs, read now. */
  claude_code: { found: boolean; allowed: boolean; approved: boolean; project_budget_usd: number };
  /** config.yaml asks for plans to start without approval, in force (`auto_approve`) or not yet trusted. */
  auto_approve_requested: boolean;
  /**
   * What the running planner may spend a day: `provider`, whose spending it is; `approved`, this
   * machine allowed it; `yours_usd`, the limit this machine set with that (null: the project's);
   * `project_usd`, the project's own, read when Friday started. The lower of the two holds.
   */
  spending: { provider: string; approved: boolean; yours_usd: number | null; project_usd: number };
  /** Every way to plan this machine can choose, with where each stands now (2026-11-23). */
  planners: PlannerOptionView[];
  /** For a running planner held to requests a day: the limit, today's count, this machine's and the project's. */
  requests: { limit: number; today: number; yours: number | null; project: number } | null;
}

export interface BrainHandle {
  brain: MasterBrain;
  status(): BrainStatus;
  /** Sets this machine's own choice of planner, or with null hands it back to the project's. */
  choosePlanner(provider: PlannerChoice | null): void;
  /**
   * Sets the model this machine's planner uses, or with null hands it back to the project's
   * `master_brain.model`. Refused for a model Friday has no price for: a call it cannot count
   * against the spending limit is one it does not make. Applies from the next planning call.
   */
  choosePlannerModel(model: string | null, provider?: string): void;
  /**
   * Takes back this machine's approval to spend on a provider (the running planner's when none is
   * named); answers whether there was one. Read at each planning call: it holds from the next.
   */
  denySpending(provider?: string): boolean;
  /** The models a key service or the model server on this machine offers, read now with the stored key. */
  listModels(provider: string): Promise<string[]>;
  /**
   * Sets where the model server on this machine listens (an address of this machine only), or with
   * null hands it back to the project's setting; answers the address now in force. The planner
   * reads it when Friday starts.
   */
  setLocalEndpoint(baseUrl: string | null): string;
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
  /** The installed Claude Code and the environment it signs in with (`master_brain.provider: claude-code`); the CLI finds it. */
  claudeCode?: { command: string; args?: readonly string[]; env?: NodeJS.ProcessEnv };
  /** The installed Codex and the environment it signs in with (`master_brain.provider: codex`); the CLI finds it. */
  codex?: { command: string; args?: readonly string[]; env?: NodeJS.ProcessEnv };
  /** The effective policy: whether plans are approved without a human comes from it (ADR-0028). */
  policy?: () => { auto_approve: boolean };
  /** The model routing would run on an agent's harness for a task (ADR-0031 §9). */
  modelFit?: (
    task: TaskView,
    agentId: string,
  ) => { fit: number; cost: number; cost_class?: CostClass | null; blocked?: string } | null;
}): BrainHandle {
  const { state, project, env, logger } = input;
  /**
   * The provider Friday started with (restart-only): this machine's own choice when it made one
   * (`friday`'s private `planner.json`), else `master_brain.provider` of config.yaml.
   */
  const chosenAtStart = input.model === undefined ? plannerChoice(project, env) : null;
  const started = chosenAtStart
    ? { ...project.config.master_brain, provider: chosenAtStart }
    : project.config.master_brain;
  /** `master_brain` as config.yaml has it now: `project.config` is replaced when the file is read again. */
  const current = () => project.config.master_brain;
  const providerName = started.provider === 'none' ? 'none' : started.provider;
  const provider: ProviderConfig = project.config.providers[providerName] ?? {
    allow_remote: false,
    daily_budget_usd: 5,
    daily_calls: 50,
    cache_ttl: '5m',
  };
  const projectCalls = provider.daily_calls;
  const service = keyedPlanner(providerName);

  /** Consent as it is now: the project's request and this clone's local approval (review F03). */
  const remotePolicy = () => {
    const approval = providerApproval(project, providerName === 'none' ? 'anthropic' : providerName, env);
    const budget = Math.min(provider.daily_budget_usd, approval?.daily_budget_usd ?? Number.POSITIVE_INFINITY);
    // The requests a day of a planner without a known price: the lower of the project's and this machine's.
    const calls = Math.min(projectCalls, approval?.daily_calls ?? Number.POSITIVE_INFINITY);
    const refusal = !provider.allow_remote
      ? `remote calls to ${providerName} are off for this project; set providers.${providerName}.allow_remote: true in .friday/config.yaml, then run "friday brain allow-remote"`
      : !approval
        ? `this project asks for remote planning, but you have not allowed it on this machine; run "friday brain allow-remote" in the project`
        : undefined;
    return {
      allowRemote: provider.allow_remote && Boolean(approval),
      dailyBudgetUsd: budget,
      dailyCalls: calls,
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
      // The address this machine set (LM Studio's port, for example), else the project's.
      model = new LocalPlannerModel({ baseUrl: localBaseUrl(project, env), ...(apiKey ? { apiKey } : {}) });
    } catch (e) {
      // The config schema already refuses a host name; this catches an https or credentialed address.
      reason = (e as Error).message;
    }
  } else if (started.provider === 'claude-code') {
    // The installed Claude Code plans, signed in as it is on this machine: the CLI found it, or
    // CLAUDE_CODE_BIN names it. Its login (a key or a subscription token) is in its environment.
    const host = input.claudeCode ?? (env.CLAUDE_CODE_BIN?.trim() ? { command: env.CLAUDE_CODE_BIN.trim() } : null);
    if (!host) {
      reason =
        'master_brain.provider is "claude-code" but Claude Code was not found (PATH, CLAUDE_CODE_BIN, the VS Code extension)';
    } else {
      model = new ClaudeCodePlannerModel({
        command: host.command,
        ...(host.args ? { args: host.args } : {}),
        env: host.env ?? env,
        effort: () => current().effort,
      });
    }
  } else if (started.provider === 'codex') {
    // The installed Codex plans, signed in as it is on this machine: the CLI found it, or
    // CODEX_BIN names it.
    const host = input.codex ?? (env.CODEX_BIN?.trim() ? { command: env.CODEX_BIN.trim() } : null);
    if (!host) {
      reason = 'Codex was not found on this computer';
    } else {
      model = new CodexPlannerModel({
        command: host.command,
        ...(host.args ? { args: host.args } : {}),
        env: host.env ?? env,
        effort: () => current().effort,
      });
    }
  } else if (service) {
    model = new KeyedCompatibleModel(service, env, (key) => state.redactor.addSecret(key));
  } else {
    model = new KeyedAnthropicModel(env, {
      cacheTtl: provider.cache_ttl,
      effort: () => current().effort,
      onKey: (key) => state.redactor.addSecret(key),
    });
  }
  // The model this machine chose for its planner (2026-11-17), where the planner is one a person
  // pays for from their own account: through Claude Code or an Anthropic key. Read at each call.
  const claudeFamily = started.provider === 'anthropic' || started.provider === 'claude-code';
  // Codex, a key service and a local server each keep their own model on this machine too
  // (2026-11-23): a Claude model's name means nothing to them.
  const ownChoice = started.provider === 'codex' || Boolean(service) || local;
  const ownModelApplies = claudeFamily || ownChoice;
  let modelHere = input.model === undefined ? plannerModelChoice(project, env, started.provider) : null;
  const modelId = () => {
    if (modelHere && ownModelApplies) return modelHere;
    const m = current().model;
    if (ownChoice) {
      // The project's model belongs to the project's own planner: a planner this machine chose
      // instead does not take it. `auto` stays as written: Codex then uses its own default, and a
      // key service or a local server has none, which the status says.
      return chosenAtStart === null || local ? m : CODEX_DEFAULT_MODEL;
    }
    return m !== 'auto' ? m : started.provider === 'fake' ? 'fake-planner' : DEFAULT_PLANNER_MODEL;
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
  // Through Claude Code the login is Claude Code's own (a key or a subscription): no key of Friday's.
  const viaClaudeCode = started.provider === 'claude-code';
  /** The key a remote planner of Friday's own needs, and where it is. */
  const keyOf = (name: string, envName: string): BrainStatus['key'] =>
    hasSecret(name, env) ? 'stored' : env[envName]?.trim() ? 'environment' : 'missing';
  const keyState = (): BrainStatus['key'] => {
    const remote = model?.remote ?? false;
    // Claude Code and Codex sign in themselves: no key of Friday's.
    if (!remote || viaClaudeCode || started.provider === 'codex') return 'not needed';
    return service ? keyOf(service.id, service.key_env) : keyOf('anthropic', 'ANTHROPIC_API_KEY');
  };
  /**
   * Why the planner cannot plan now, or null: no model, no consent for remote calls, no key, a
   * local model not named. One answer for the status the interface shows and for the Master
   * Brain's own decisions, so "not ready" on the screen is "no planner" in what Friday does.
   */
  const whyUnavailable = (): string | null => {
    const remote = model?.remote ?? false;
    const consent = remotePolicy();
    return (
      reason ??
      (remote && !consent.allowRemote
        ? (consent.refusal ?? 'remote calls are off')
        : keyState() === 'missing'
          ? service
            ? `no ${service.label} key is stored on this computer`
            : 'no Anthropic API key: run "friday secrets set anthropic"'
          : local && model && modelId() === 'auto'
            ? LOCAL_MODEL_UNSET
            : service && model && modelId() === 'auto'
              ? MODEL_UNSET
              : null)
    );
  };
  const brain = new MasterBrain({
    state,
    projectId: project.project_id,
    model,
    ...(reason ? { plannerUnavailable: reason } : {}),
    plannerReady: whyUnavailable,
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
    intentSources: () => buildIntentSources(project, { redactor: state.redactor, stateDir: stateDir(env) }),
    log: (level, message, data) => logger[level](message, data ?? {}),
    // The daemon's recovery preserves and fences lost attempts before reassigning them (ADR-0026).
    lostWork: 'external',
    ...(input.modelFit ? { modelFit: input.modelFit } : {}),
  });

  return {
    brain,
    choosePlanner: (provider) => choosePlanner(project, provider, env),
    listModels: (name) => listPlannerModels(project, name, env),
    setLocalEndpoint: (baseUrl) => {
      if (baseUrl !== null) {
        try {
          localEndpoint(baseUrl);
        } catch (e) {
          throw new FridayError('invalid_request', (e as Error).message);
        }
      }
      setProviderEndpoint('local', baseUrl, env);
      return localBaseUrl(project, env);
    },
    denySpending: (name) =>
      revokeProvider(project, name ?? (providerName === 'none' ? 'anthropic' : providerName), env),
    choosePlannerModel: (chosen, forProvider) => {
      const target = forProvider ?? started.provider;
      const claude = target === 'anthropic' || target === 'claude-code';
      // A Claude planner is held to dollars: a model without a price could not be counted. The
      // others are held to requests a day, whatever the model.
      if (claude && chosen !== null && !priceEntry(chosen, provider.prices)) {
        throw new FridayError(
          'invalid_request',
          `Friday has no price for ${chosen}, so it could not count a plan against the spending limit; choose a model it knows, or add its price under providers.${target}.prices`,
        );
      }
      choosePlannerModel(project, chosen, env, target);
      // Read at each call when it is the running planner's (the Claude planners share one choice).
      if (target === started.provider || (claude && claudeFamily)) modelHere = chosen;
    },
    status: () => {
      const pid = project.project_id;
      const remote = model?.remote ?? false;
      const key = keyState();
      const dayStart = `${state.clock.now().slice(0, 10)}T00:00:00.000Z`;
      const consent = remotePolicy();
      const unavailable = whyUnavailable();
      return {
        provider: model?.provider ?? started.provider,
        model: modelId(),
        // The choice the Claude planners share, and whether it is the one used: Codex, a key
        // service and a local server keep their own (`planners[].model`).
        model_choice: {
          here: claudeFamily ? modelHere : plannerModelChoice(project, env),
          project: current().model,
          applies: claudeFamily,
        },
        remote,
        allow_remote: provider.allow_remote,
        approved_here: Boolean(providerApproval(project, providerName === 'none' ? 'anthropic' : providerName, env)),
        // Where requests go: a key service's address, the address of the model server on this
        // machine (one set here, else the project's); a program that signs in itself names none.
        endpoint: service
          ? keyedEndpoint(service, env)
          : local
            ? localBaseUrl(project, env)
            : remote && !viaClaudeCode && started.provider !== 'codex'
              ? anthropicEndpoint(env)
              : null,
        ignored_base_url: local ? null : (provider.base_url ?? null),
        key,
        planner_available: !unavailable,
        reason: unavailable,
        // What is in force: the setting, once this clone trusts it (it is a loosening).
        auto_approve: settings.autoApprove,
        escalate_after_failures: current().escalate_after_failures,
        max_replans: current().max_replans,
        // No budget holds a model that costs nothing: only remote calls have one (ADR-0015 §4).
        // Dollars are counted only where a price is known: not for a planner held to requests a day.
        daily_budget_usd: remote && !requestsLimited() ? consent.dailyBudgetUsd : null,
        spent_today_usd: model ? state.q.modelSpend(pid, model.provider, dayStart) : 0,
        cursor: state.q.brainCursor(pid),
        head: state.store.head(pid),
        choice: (() => {
          const here = plannerChoice(project, env);
          const ofProject = project.config.master_brain.provider;
          return { here, project: ofProject, wanted: here ?? ofProject };
        })(),
        claude_code: {
          found: Boolean(input.claudeCode ?? env.CLAUDE_CODE_BIN?.trim()),
          allowed: project.config.providers['claude-code']?.allow_remote === true,
          approved: Boolean(providerApproval(project, 'claude-code', env)),
          project_budget_usd: project.config.providers['claude-code']?.daily_budget_usd ?? 5,
        },
        auto_approve_requested: current().auto_approve === true,
        spending: (() => {
          const name =
            providerName === 'none' || providerName === 'local' || providerName === 'fake' ? 'anthropic' : providerName;
          const approval = providerApproval(project, name, env);
          return {
            provider: name,
            approved: Boolean(approval),
            yours_usd: approval?.daily_budget_usd ?? null,
            project_usd: provider.daily_budget_usd,
          };
        })(),
        planners: plannerOptions(),
        requests: requestsLimited()
          ? {
              limit: consent.dailyCalls,
              today: model ? state.q.modelCallsSince(pid, model.provider, dayStart) : 0,
              yours: providerApproval(project, providerName, env)?.daily_calls ?? null,
              project: projectCalls,
            }
          : null,
      };
    },
  };

  /** Whether the running planner is held to requests a day: a remote one whose model has no price. */
  function requestsLimited(): boolean {
    return Boolean(model?.remote && model.unpriced && !priceEntry(modelId(), provider.prices));
  }

  /** Every way to plan, with where each stands on this machine now. */
  function plannerOptions(): PlannerOptionView[] {
    const cfg = (name: string) =>
      (
        project.config.providers as Record<
          string,
          { allow_remote?: boolean; daily_budget_usd?: number; daily_calls?: number } | undefined
        >
      )[name];
    const remote = (
      id: string,
      kind: 'program' | 'key',
      label: string,
      found: boolean | null,
      key: BrainStatus['key'],
      unpriced: boolean,
      needsModel: boolean,
    ): PlannerOptionView => ({
      id,
      kind,
      label,
      found,
      remote: true,
      allowed: cfg(id)?.allow_remote === true,
      approved: Boolean(providerApproval(project, id, env)),
      key,
      model: plannerModelChoice(project, env, id),
      needs_model: needsModel,
      unpriced,
      project_budget_usd: unpriced ? null : (cfg(id)?.daily_budget_usd ?? 5),
      project_calls: unpriced ? (cfg(id)?.daily_calls ?? 50) : null,
      endpoint: keyedPlanner(id) ? keyedEndpoint(keyedPlanner(id) as KeyedPlanner, env) : null,
    });
    return [
      remote(
        'claude-code',
        'program',
        'Claude Code',
        Boolean(input.claudeCode ?? env.CLAUDE_CODE_BIN?.trim()),
        'not needed',
        false,
        false,
      ),
      remote('codex', 'program', 'Codex', Boolean(input.codex ?? env.CODEX_BIN?.trim()), 'not needed', true, false),
      remote('anthropic', 'key', 'Anthropic', null, keyOf('anthropic', 'ANTHROPIC_API_KEY'), false, false),
      ...KEYED_PLANNERS.map((k) => remote(k.id, 'key', k.label, null, keyOf(k.id, k.key_env), true, true)),
      {
        id: 'local',
        kind: 'local' as const,
        label: 'A model on this computer',
        found: null,
        remote: false,
        allowed: true,
        approved: true,
        key: 'not needed' as const,
        model: plannerModelChoice(project, env, 'local'),
        needs_model: true,
        unpriced: false,
        project_budget_usd: null,
        project_calls: null,
        endpoint: localBaseUrl(project, env),
      },
      {
        id: 'none',
        kind: 'none' as const,
        label: 'I write the plans myself',
        found: null,
        remote: false,
        allowed: true,
        approved: true,
        key: 'not needed' as const,
        model: null,
        needs_model: false,
        unpriced: false,
        project_budget_usd: null,
        project_calls: null,
        endpoint: null,
      },
    ];
  }
}
