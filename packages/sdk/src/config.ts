import { existsSync, readFileSync } from 'node:fs';
import { FridayError, TaskScope } from '@friday/protocol';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const Check = z.object({
  name: z.string().min(1),
  kind: z.enum(['test', 'lint', 'build', 'typecheck', 'other']).default('test'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeout_ms: z.number().int().min(1000).max(3_600_000).default(120_000),
  /** Relative to the project root (or the task worktree from M5). */
  cwd: z.string().optional(),
});
export type CheckConfig = z.infer<typeof Check>;

/** `.friday/config.yaml` (plan Appendix 6). Tracked in git; never holds secrets. */
export const FridayConfig = z
  .object({
    project: z.object({
      id: z.string().regex(/^proj_[0-9a-hjkmnp-tv-z]{26}$/, 'project.id must be a proj_ id'),
      name: z.string().min(1).default('project'),
    }),
    daemon: z
      .object({
        port: z.number().int().min(0).max(65_535).default(0),
        log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        trusted_origins: z.array(z.string().url()).default([]),
      })
      .prefault({}),
    leases: z
      .object({
        heartbeat_interval_ms: z.number().int().min(1000).optional(),
        lease_ttl_ms: z.number().int().min(2000).optional(),
        reconnect_window_ms: z.number().int().min(0).optional(),
        clean_exit_grace_ms: z.number().int().min(0).optional(),
        ack_timeout_ms: z.number().int().min(1000).optional(),
        max_delivery_attempts: z.number().int().min(1).optional(),
      })
      .prefault({}),
    scopes: z.record(z.string(), TaskScope).default({}),
    autonomy: z.record(z.string(), z.enum(['auto', 'review', 'manual'])).default({}),
    security: z
      .object({
        enforcement_required: z.enum(['L0', 'L1', 'L2']).default('L1'),
        require_enforcing_hooks: z.boolean().default(false),
      })
      .prefault({}),
    verification: z
      .object({
        auto_on_completion: z.boolean().default(false),
        checks: z.array(Check).default([]),
      })
      .prefault({}),
    reservations: z
      .object({ mode: z.enum(['hybrid', 'off']).default('hybrid'), required: z.array(z.string()).default([]) })
      .prefault({}),
    context: z.object({ session_start_max_chars: z.number().int().min(1000).max(10_000).default(9000) }).prefault({}),
    providers: z.record(z.string(), z.object({ allow_remote: z.boolean().default(false) }).passthrough()).default({}),
  })
  .passthrough();
export type FridayConfig = z.infer<typeof FridayConfig>;

export function parseConfig(text: string, source = 'config.yaml'): FridayConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new FridayError('invalid_request', `${source} is not valid YAML: ${(e as Error).message}`);
  }
  const res = FridayConfig.safeParse(raw ?? {});
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new FridayError('schema_mismatch', `${source} is invalid: ${issues.join('; ')}`, { issues });
  }
  return res.data;
}

export function loadConfig(path: string): FridayConfig {
  if (!existsSync(path)) throw new FridayError('project_not_found', `no Friday config at ${path}; run "friday init"`);
  return parseConfig(readFileSync(path, 'utf8'), path);
}

/** Initial config written by `friday init`. Block style so the hook launcher can find the id without a YAML parser. */
export function renderInitialConfig(projectId: string, name: string): string {
  return `# Friday project configuration. Tracked in git; never put secrets here.
# Reference: docs/BUILD_PLAN.md, Appendix 6.
project:
  id: ${projectId}
  name: ${JSON.stringify(name)}

daemon:
  port: 0            # 0 = pick a free port each start
  log_level: info

# Named scopes you can reuse when creating tasks (project-relative globs).
scopes: {}

# Commands \`friday verify <task>\` runs. Example:
#   checks:
#     - name: tests
#       command: node
#       args: ["--test"]
verification:
  auto_on_completion: false
  checks: []

providers:
  anthropic:
    allow_remote: false   # model calls leave this machine only when you set this to true (M2)
`;
}
