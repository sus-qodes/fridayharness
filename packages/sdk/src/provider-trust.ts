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
  opts: { daily_budget_usd?: number | null; now?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): ProviderApproval {
  checkName(provider);
  const budget = opts.daily_budget_usd ?? null;
  if (budget !== null && !(budget >= 0)) throw new FridayError('invalid_request', 'the budget must be zero or more');
  const all = readApprovals(ref, env);
  const approval: ProviderApproval = { approved_at: opts.now ?? new Date().toISOString(), daily_budget_usd: budget };
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
