import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  ApprovalSettings,
  ExecutionSettings,
  type FridayConfig,
  McpSettings,
  type OperationSpec,
  Operations,
} from './config.js';
import { writePrivateFile } from './discovery.js';

/**
 * The tracked sources of a project's policy (ADR-0028): `.friday/config.yaml` and every file in
 * `.friday/policies/`. They are repository content: `@friday/policy` applies what they tighten at
 * once, and what they loosen only after this clone trusted it (`friday policy trust`).
 */

const Globs = z.array(z.string().min(1).max(500)).max(200).default([]);

/** A project policy file, `.friday/policies/<name>.yaml`. Unknown keys are refused, not ignored. */
export const PolicyFile = z
  .object({
    /** Command classes to autonomy levels, as in config.yaml (spec Part 07 §8). */
    autonomy: z.record(z.string(), z.enum(['auto', 'review', 'manual', 'never'])).default({}),
    /** Capabilities to risk tiers (spec Part 07 §7). */
    risk: z.record(z.string(), z.enum(['low', 'medium', 'high'])).default({}),
    /** Paths no task writes (or reads) without a human approving that exact path. */
    deny: z.object({ write: Globs, read: Globs }).strict().prefault({}),
    /** Per agent role: a scope its agents never write outside, whatever a task allows. */
    teams: z.record(z.string(), z.object({ write: Globs, read: Globs }).strict()).default({}),
    /** Operations Friday runs for agents with stored secrets (ADR-0029), as in config.yaml. */
    operations: Operations.default({}),
    /** Additions to the execution profile (ADR-0029 §4). */
    execution: ExecutionSettings,
    /** Third-party MCP servers' tools (ADR-0030 §3). */
    mcp: McpSettings,
    approvals: ApprovalSettings,
  })
  .strict();
export type PolicyFile = z.infer<typeof PolicyFile>;

/** One source, in the shape `projectPolicy` of `@friday/policy` reads. */
export interface PolicySourceData {
  name: string;
  autonomy?: Record<string, string>;
  risk?: Record<string, string>;
  deny?: { write?: string[]; read?: string[] };
  teams?: Record<string, { write?: string[]; read?: string[] }>;
  enforcement_required?: 'L0' | 'L1' | 'L2';
  reservations_mode?: 'hybrid' | 'off';
  auto_approve?: boolean;
  operations?: Record<string, OperationSpec>;
  execution?: { binaries?: string[]; env_passthrough?: string[] };
  auto_verification?: boolean;
  auto_landing?: 'goal' | 'task';
  mcp?: Record<string, { default?: string; tools?: Record<string, string> }>;
  elicitation?: boolean;
  /** `daemon.port` when fixed (loosening, plan M9 §5.13). */
  daemon_port?: number;
  /** `worktrees.setup`: the project's own install command, and lifecycle scripts (loosenings, plan Phase 7). */
  worktree_setup?: { command?: string; args?: string[]; allow_scripts?: boolean };
  /** `worktrees.files`: files outside version control that every copy of the project gets (loosening). */
  worktree_files?: { from: string; to?: string | undefined }[];
  /** `sandbox`: this checkout is disposable; command classes a human would review run on their own (loosening). */
  sandbox?: boolean;
}

export const POLICY_DIR = path.join('.friday', 'policies');

/** Every source, config first. A file that does not parse is reported and applies nothing. */
export function readPolicySources(
  projectRoot: string,
  config: FridayConfig,
): { sources: PolicySourceData[]; errors: { file: string; error: string }[] } {
  const sources: PolicySourceData[] = [
    {
      name: 'config.yaml',
      autonomy: config.autonomy,
      risk: config.risk,
      enforcement_required: config.security.enforcement_required,
      reservations_mode: config.reservations.mode,
      auto_approve: config.master_brain.auto_approve,
      operations: config.operations,
      execution: config.execution,
      auto_verification: config.verification.auto_on_completion,
      ...(config.landing.mode !== 'ask' ? { auto_landing: config.landing.mode } : {}),
      mcp: config.mcp.servers,
      elicitation: config.approvals.elicitation,
      ...(config.sandbox ? { sandbox: true } : {}),
      ...(config.daemon.port ? { daemon_port: config.daemon.port } : {}),
      ...(config.worktrees.setup.command || config.worktrees.setup.allow_scripts
        ? {
            worktree_setup: {
              ...(config.worktrees.setup.command
                ? { command: config.worktrees.setup.command, args: [...config.worktrees.setup.args] }
                : {}),
              ...(config.worktrees.setup.allow_scripts ? { allow_scripts: true } : {}),
            },
          }
        : {}),
      ...(config.worktrees.files.length ? { worktree_files: config.worktrees.files.map((f) => ({ ...f })) } : {}),
    },
  ];
  const errors: { file: string; error: string }[] = [];
  const dir = path.join(projectRoot, POLICY_DIR);
  if (!existsSync(dir)) return { sources, errors };
  for (const f of readdirSync(dir)
    .filter((n) => /\.ya?ml$/i.test(n))
    .sort()) {
    const name = `policies/${f}`;
    try {
      const { mcp, approvals, ...data } = PolicyFile.parse(parseYaml(readFileSync(path.join(dir, f), 'utf8')) ?? {});
      sources.push({ name, ...data, mcp: mcp.servers, elicitation: approvals.elicitation });
    } catch (e) {
      const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
      errors.push({
        file: name,
        error: issues
          ? issues.map((i) => `${i.path.map(String).join('.') || '(file)'}: ${i.message}`).join('; ')
          : (e as Error).message,
      });
    }
  }
  return { sources, errors };
}

const TRUST_FILE = 'policy-trust.json';

/**
 * What this clone trusts of the settings that loosen Friday's defaults: the whole list as it once
 * stood (`hash`; all a trust file held before 2026-11-18), and single settings by their ids
 * (`items`). Nothing when no file is there, or it cannot be read.
 */
export function readPolicyTrust(privateDir: string): { hash: string | null; items: string[] } {
  try {
    const data = JSON.parse(readFileSync(path.join(privateDir, TRUST_FILE), 'utf8')) as {
      loosening_hash?: unknown;
      items?: unknown;
    };
    return {
      hash: typeof data.loosening_hash === 'string' ? data.loosening_hash : null,
      items: Array.isArray(data.items) ? data.items.filter((i): i is string => typeof i === 'string') : [],
    };
  } catch {
    return { hash: null, items: [] };
  }
}

/**
 * Records what this clone trusts (in its private folder): the ids of the settings, and the hash
 * of the whole list when all of it was trusted at once (null otherwise).
 */
export function writePolicyTrust(
  privateDir: string,
  trust: { hash: string | null; items: readonly string[] },
  trustedBy: string,
): void {
  writePrivateFile(
    privateDir,
    TRUST_FILE,
    `${JSON.stringify(
      {
        loosening_hash: trust.hash,
        items: [...new Set(trust.items)].sort(),
        trusted_at: new Date().toISOString(),
        trusted_by: trustedBy,
      },
      null,
      2,
    )}\n`,
  );
}
