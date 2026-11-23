import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { FridayError } from '@friday/protocol';
import { type ProjectRef, privateDirFor, writePrivateFile } from './discovery.js';
import { credentialsDir } from './secrets.js';

/**
 * Local trust decisions for remote model providers (review F03). `.friday/config.yaml` is
 * tracked, so anyone who can change the repository can change it: it may ask for remote
 * planning (`allow_remote: true`), but it cannot by itself spend the user's key or choose where
 * the key is sent. Both need a decision recorded on this machine, outside the repository:
 *
 * - per clone: `<private dir>/providers.json` says this project may use the user's key for a
 *   provider, optionally with a lower daily budget (`friday brain allow-remote`);
 * - per user: `<state dir>/credentials/<provider>.json` holds a custom endpoint for that key
 *   (`friday secrets set <provider> --base-url`). Without one, the provider's own endpoint is used.
 */

export interface ProviderApproval {
  approved_at: string;
  /** A daily budget lower than the project's (`providers.<name>.daily_budget_usd`); null: the project's. */
  daily_budget_usd: number | null;
  /**
   * For a planner without a known price (2026-11-23): requests a day, lower than the project's
   * (`providers.<name>.daily_calls`); null or absent: the project's.
   */
  daily_calls?: number | null;
}

type ApprovalFile = Record<string, ProviderApproval>;

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

function checkName(provider: string): void {
  if (!NAME.test(provider)) throw new FridayError('invalid_request', `unknown provider name "${provider}"`);
}

function approvalsFile(ref: Pick<ProjectRef, 'project_key'>, env: NodeJS.ProcessEnv): string {
  return path.join(privateDirFor(ref, env), 'providers.json');
}

function readApprovals(ref: Pick<ProjectRef, 'project_key'>, env: NodeJS.ProcessEnv): ApprovalFile {
  const file = approvalsFile(ref, env);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ApprovalFile;
  } catch {
    return {};
  }
}

/** This clone's approval to use the user's key for `provider`, or undefined. */
export function providerApproval(
  ref: Pick<ProjectRef, 'project_key'>,
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderApproval | undefined {
  checkName(provider);
  const a = readApprovals(ref, env)[provider];
  return a && typeof a.approved_at === 'string' ? a : undefined;
}

export function approveProvider(
  ref: Pick<ProjectRef, 'project_key'>,
  provider: string,
  opts: { daily_budget_usd?: number | null; daily_calls?: number | null; now?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): ProviderApproval {
  checkName(provider);
  const budget = opts.daily_budget_usd ?? null;
  if (budget !== null && !(budget >= 0)) throw new FridayError('invalid_request', 'the budget must be zero or more');
  const calls = opts.daily_calls ?? null;
  if (calls !== null && !(Number.isInteger(calls) && calls >= 0)) {
    throw new FridayError('invalid_request', 'the requests a day must be a whole number, zero or more');
  }
  const all = readApprovals(ref, env);
  const approval: ProviderApproval = {
    approved_at: opts.now ?? new Date().toISOString(),
    daily_budget_usd: budget,
    ...(calls !== null ? { daily_calls: calls } : {}),
  };
  all[provider] = approval;
  writePrivateFile(privateDirFor(ref, env), 'providers.json', `${JSON.stringify(all, null, 2)}\n`);
  return approval;
}

/** Returns whether an approval existed. */
export function revokeProvider(
  ref: Pick<ProjectRef, 'project_key'>,
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  checkName(provider);
  const all = readApprovals(ref, env);
  if (!all[provider]) return false;
  delete all[provider];
  writePrivateFile(privateDirFor(ref, env), 'providers.json', `${JSON.stringify(all, null, 2)}\n`);
  return true;
}

/**
 * How this person plans in this project, kept on this machine (2026-11-17): through Claude Code,
 * with an Anthropic key, or by writing plans themselves. It depends on the accounts a person has,
 * so it is theirs, not the team's: set in the tracked config.yaml, one person's choice switched
 * every teammate's planner, whose own then read "not ready". `<private dir>/planner.json`; null
 * when this machine chose nothing and `master_brain.provider` of config.yaml stands.
 *
 * Since 2026-11-23 a person without Claude plans too: through the installed Codex, with a key of
 * another service (`KEYED_PLANNERS`), or with a model on this machine.
 */
export const PLANNER_CHOICES = [
  'anthropic',
  'claude-code',
  'codex',
  'openai',
  'gemini',
  'deepseek',
  'openrouter',
  'local',
  'none',
] as const;
export type PlannerChoice = (typeof PLANNER_CHOICES)[number];

/**
 * A service that plans with the person's own key, over the OpenAI-compatible chat API (2026-11-23).
 * The address is Friday's own, here: a tracked file never chooses where a key is sent (review F03).
 * `key_env`: the environment variable read when no key is stored. `token_param`: how the service
 * names the answer's size limit (the planner switches by itself when the service says otherwise).
 */
export interface KeyedPlanner {
  id: 'openai' | 'gemini' | 'deepseek' | 'openrouter';
  label: string;
  endpoint: string;
  key_env: string;
  token_param: 'max_tokens' | 'max_completion_tokens';
}

export const KEYED_PLANNERS: readonly KeyedPlanner[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    key_env: 'OPENAI_API_KEY',
    token_param: 'max_completion_tokens',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    key_env: 'GEMINI_API_KEY',
    token_param: 'max_tokens',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1',
    key_env: 'DEEPSEEK_API_KEY',
    token_param: 'max_tokens',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1',
    key_env: 'OPENROUTER_API_KEY',
    token_param: 'max_tokens',
  },
];

export function keyedPlanner(id: string): KeyedPlanner | undefined {
  return KEYED_PLANNERS.find((k) => k.id === id);
}

/** The planners whose model is a Claude model: they share this machine's one choice of it. */
const CLAUDE_PLANNERS: ReadonlySet<string> = new Set(['anthropic', 'claude-code']);

/** `planner.json` as an object; empty when it is missing or cannot be read. */
function readPlannerFile(ref: Pick<ProjectRef, 'project_key'>, env: NodeJS.ProcessEnv): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(path.join(privateDirFor(ref, env), 'planner.json'), 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
  } catch {
    return {};
  }
}

/** Writes `planner.json`; with nothing left in it, the file goes and the project's settings stand. */
function writePlannerFile(
  ref: Pick<ProjectRef, 'project_key'>,
  env: NodeJS.ProcessEnv,
  data: Record<string, unknown>,
): void {
  if (Object.keys(data).length === 0) {
    rmSync(path.join(privateDirFor(ref, env), 'planner.json'), { force: true });
    return;
  }
  writePrivateFile(privateDirFor(ref, env), 'planner.json', `${JSON.stringify(data, null, 2)}\n`);
}

export function plannerChoice(
  ref: Pick<ProjectRef, 'project_key'>,
  env: NodeJS.ProcessEnv = process.env,
): PlannerChoice | null {
  const provider = readPlannerFile(ref, env).provider;
  return (PLANNER_CHOICES as readonly unknown[]).includes(provider) ? (provider as PlannerChoice) : null;
}

/**
 * Sets this machine's choice, or with null removes it (the project's setting stands again). The
 * model this machine chose for its planner is kept either way.
 */
export function choosePlanner(
  ref: Pick<ProjectRef, 'project_key'>,
  provider: PlannerChoice | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (provider !== null && !(PLANNER_CHOICES as readonly string[]).includes(provider)) {
    throw new FridayError('invalid_request', `"${provider}" is not a planner this machine can choose`);
  }
  const data = readPlannerFile(ref, env);
  if (provider === null) delete data.provider;
  else data.provider = provider;
  writePlannerFile(ref, env, data);
}

/** A model id as a provider names one: no leading dash, so it never reads as an option of a command. */
const PLANNER_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

/**
 * The model this person's planner uses on this machine (2026-11-17), kept beside how they plan and
 * for the same reason: what a plan costs is paid from their account, not the team's. Null when this
 * machine chose none and `master_brain.model` of config.yaml stands.
 */
export function plannerModelChoice(
  ref: Pick<ProjectRef, 'project_key'>,
  env: NodeJS.ProcessEnv = process.env,
  /**
   * The planner the model is for (2026-11-23). Each keeps its own: a Claude model's name means
   * nothing to Codex or to another service. Left out, or a Claude planner: the one choice the
   * Claude planners share, as before.
   */
  provider?: string,
): string | null {
  const data = readPlannerFile(ref, env);
  const model =
    provider && !CLAUDE_PLANNERS.has(provider)
      ? (data.models as Record<string, unknown> | undefined)?.[provider]
      : data.model;
  return typeof model === 'string' && PLANNER_MODEL.test(model) ? model : null;
}

/** Sets this machine's planner model, or with null removes it (the project's setting stands again). */
export function choosePlannerModel(
  ref: Pick<ProjectRef, 'project_key'>,
  model: string | null,
  env: NodeJS.ProcessEnv = process.env,
  provider?: string,
): void {
  if (model !== null && !PLANNER_MODEL.test(model)) {
    throw new FridayError('invalid_request', `"${model}" is not a model name`);
  }
  const data = readPlannerFile(ref, env);
  if (provider && !CLAUDE_PLANNERS.has(provider)) {
    checkName(provider);
    const raw = data.models;
    const models: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
    if (model === null) delete models[provider];
    else models[provider] = model;
    if (Object.keys(models).length) data.models = models;
    else delete data.models;
  } else if (model === null) delete data.model;
  else data.model = model;
  writePlannerFile(ref, env, data);
}

/** The endpoint the user chose for a provider's key on this machine, or undefined for the default. */
export function providerEndpoint(provider: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  checkName(provider);
  try {
    const v = JSON.parse(readFileSync(path.join(credentialsDir(env), `${provider}.json`), 'utf8')) as {
      base_url?: unknown;
    };
    return typeof v.base_url === 'string' && v.base_url ? v.base_url : undefined;
  } catch {
    return undefined;
  }
}

export function setProviderEndpoint(
  provider: string,
  baseUrl: string | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  checkName(provider);
  const file = path.join(credentialsDir(env), `${provider}.json`);
  if (baseUrl === null) {
    rmSync(file, { force: true });
    return;
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new FridayError('invalid_request', `"${baseUrl}" is not a URL`);
  }
  // Loopback addresses only, written as addresses (E.3: names can resolve elsewhere).
  const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new FridayError(
      'invalid_request',
      'a provider endpoint must use https (plain http only to 127.0.0.1 or [::1])',
    );
  }
  writePrivateFile(
    credentialsDir(env),
    `${provider}.json`,
    `${JSON.stringify({ base_url: url.toString() }, null, 2)}\n`,
  );
}
