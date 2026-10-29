import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type AgentHostName, type AgentOptions, type AgentProfile, FridayError } from '@friday/protocol';
import { writePrivateFile } from '@friday/sdk';

/**
 * Agents started from the interface, remembered per project (plan M9 FD-24): host, key, role,
 * options and whether each starts with Friday. Kept in the project's private folder (user-only),
 * since an agent works on the user's own accounts and money.
 */

const FILE = 'agents.json';
const MAX_PROFILES = 32;

export const AGENT_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ROLE = /^[a-z][a-z0-9_-]{0,31}$/;
const WORD = /^[a-z][a-z0-9-]{1,15}$/;
/** The hosts a remembered agent may name. */
const PROFILE_HOSTS: readonly AgentHostName[] = ['claude-code', 'codex', 'cursor', 'gemini'];

/**
 * Options per host, validated against enums or strict patterns with no leading `-`, so nothing a
 * request sends can become another command-line option of the host (review SEC-12).
 */
export function validateOptions(host: AgentHostName, raw: unknown): AgentOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: AgentOptions = {};
  const bad = (name: string): never => {
    throw new FridayError('invalid_request', `option ${name} is not valid for ${host}`);
  };
  // The Cursor CLI and Gemini CLI take none of these: their models come from routing too.
  if (host === 'cursor' || host === 'gemini') {
    for (const k of ['effort', 'max_budget_usd', 'sandbox', 'windows_sandbox', 'service_tier'])
      if (o[k] !== undefined) bad(k);
    return out;
  }
  if (o.effort !== undefined) {
    if (typeof o.effort !== 'string' || !WORD.test(o.effort)) bad('effort');
    out.effort = o.effort as string;
  }
  if (host === 'claude-code') {
    const budget = o.max_budget_usd ?? 1;
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0.01 || budget > 100) bad('max_budget_usd');
    out.max_budget_usd = budget as number;
    for (const k of ['sandbox', 'windows_sandbox', 'service_tier']) if (o[k] !== undefined) bad(k);
  } else {
    if (o.max_budget_usd !== undefined) bad('max_budget_usd');
    const sandbox = o.sandbox ?? 'workspace-write';
    if (sandbox !== 'read-only' && sandbox !== 'workspace-write' && sandbox !== 'danger-full-access') bad('sandbox');
    out.sandbox = sandbox as AgentOptions['sandbox'];
    if (o.windows_sandbox !== undefined) {
      if (o.windows_sandbox !== 'elevated' && o.windows_sandbox !== 'unelevated') bad('windows_sandbox');
      out.windows_sandbox = o.windows_sandbox as string;
    }
    if (o.service_tier !== undefined) {
      if (typeof o.service_tier !== 'string' || !WORD.test(o.service_tier)) bad('service_tier');
      out.service_tier = o.service_tier as string;
    }
  }
  return out;
}

/** The command-line flags of `friday harness run` for these options (`--name=value`, one argument each). */
export function optionFlags(host: AgentHostName, o: AgentOptions): string[] {
  const flags: string[] = [];
  if (o.effort) flags.push(`--effort=${o.effort}`);
  if (host === 'claude-code' && o.max_budget_usd !== undefined) flags.push(`--max-budget-usd=${o.max_budget_usd}`);
  if (host === 'codex') {
    if (o.sandbox) flags.push(`--sandbox=${o.sandbox}`);
    if (o.windows_sandbox) flags.push(`--windows-sandbox=${o.windows_sandbox}`);
    if (o.service_tier) flags.push(`--service-tier=${o.service_tier}`);
  }
  return flags;
}

export class AgentProfiles {
  constructor(private readonly privateDir: string) {}

  list(): AgentProfile[] {
    const file = path.join(this.privateDir, FILE);
    if (!existsSync(file)) return [];
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { agents?: unknown };
      if (!Array.isArray(data.agents)) return [];
      const out: AgentProfile[] = [];
      for (const a of data.agents.slice(0, MAX_PROFILES)) {
        const p = a as Partial<AgentProfile>;
        const host = PROFILE_HOSTS.find((h) => h === p?.host);
        if (!p || !host) continue;
        if (typeof p.agent_key !== 'string' || !AGENT_KEY.test(p.agent_key)) continue;
        if (typeof p.role !== 'string' || !ROLE.test(p.role)) continue;
        try {
          out.push({
            agent_key: p.agent_key,
            host,
            role: p.role,
            options: validateOptions(host, p.options),
            autostart: p.autostart === true,
            updated_at: typeof p.updated_at === 'string' ? p.updated_at : new Date(0).toISOString(),
          });
        } catch {
          // A profile whose options no longer validate is skipped, never run.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  get(agentKey: string): AgentProfile | undefined {
    return this.list().find((p) => p.agent_key === agentKey);
  }

  save(profile: AgentProfile): void {
    const rest = this.list().filter((p) => p.agent_key !== profile.agent_key);
    if (rest.length >= MAX_PROFILES)
      throw new FridayError('invalid_request', `at most ${MAX_PROFILES} agents are remembered`);
    this.#write([...rest, profile]);
  }

  forget(agentKey: string): void {
    this.#write(this.list().filter((p) => p.agent_key !== agentKey));
  }

  #write(agents: AgentProfile[]): void {
    writePrivateFile(this.privateDir, FILE, `${JSON.stringify({ agents }, null, 2)}\n`);
  }
}
