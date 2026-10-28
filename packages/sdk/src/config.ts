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

const Price = z.object({
  input: z.number().min(0),
  cache_write_5m: z.number().min(0),
  cache_write_1h: z.number().min(0),
  cache_read: z.number().min(0),
  output: z.number().min(0),
});

/** One model provider (plan B28, ADR-0013). Keys never live here: `friday secrets set <provider>`. */
const Provider = z
  .object({
    /**
     * The project asks for remote model calls. They happen only when this is true and the user
     * also approved it on this machine (`friday brain allow-remote`, review F03).
     */
    allow_remote: z.boolean().default(false),
    /** Spend per UTC day before Friday stops calling the provider and asks a human. */
    daily_budget_usd: z.number().min(0).default(5),
    /** Prompt-cache lifetime of the project context. */
    cache_ttl: z.enum(['5m', '1h']).default('5m'),
    /**
     * Ignored: a tracked file must not choose where the user's key is sent (review F03). Set a
     * custom endpoint per user with `friday secrets set <provider> --base-url <url>`.
     */
    base_url: z.string().url().optional(),
    /** USD per million tokens, per model id, overriding Friday's defaults. */
    prices: z.record(z.string(), Price).optional(),
  })
  .passthrough();
export type ProviderConfig = z.infer<typeof Provider>;

/** The Master Brain (M2, ADR-0013). */
const MasterBrainConfig = z
  .object({
    /** `none`: plans are written by humans (`friday plan propose`); `fake`: scripted answers for tests and demos. */
    provider: z.enum(['anthropic', 'fake', 'none']).default('anthropic'),
    /** `auto` is the default planning model, claude-opus-5-5. */
    model: z.string().min(1).default('auto'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    max_tokens: z.number().int().min(1000).max(21_000).default(16_000),
    /** Without it a human approves every plan version. */
    auto_approve: z.boolean().default(false),
    escalate_after_failures: z.number().int().min(1).max(10).default(2),
    max_replans: z.number().int().min(0).max(20).default(3),
    /**
     * How long a task the Master Brain reserved for an attach-mode agent (or a rework kept for its
     * agent) waits to be claimed before anyone may take it (review F08). A human's reservation stays.
     */
    reservation_ttl_ms: z
      .number()
      .int()
      .min(10_000)
      .default(15 * 60 * 1000),
    /** For provider `fake`: a directory of scripted answers, relative to the project root. */
    fake_responses: z.string().optional(),
  })
  .prefault({});
export type MasterBrainConfig = z.infer<typeof MasterBrainConfig>;

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
    /** Agent messaging (M3, ADR-0017). */
    communication: z
      .object({
        /** `to: broadcast` reaches everyone on the sender's goal; off by default (spec Part 05 §8). */
        allow_broadcast: z.boolean().default(false),
        /** How long an inbox read reserves a message for the reading session. */
        delivery_reservation_ms: z.number().int().min(5000).default(120_000),
        /** Deliveries without an acknowledgement before a message is dead-lettered. */
        max_delivery_attempts: z.number().int().min(1).max(50).default(5),
        /** How long a message stays deliverable. */
        message_ttl_ms: z
          .number()
          .int()
          .min(60_000)
          .default(24 * 60 * 60 * 1000),
        /** The reply deadline of a blocking request that names none. */
        blocking_reply_ms: z
          .number()
          .int()
          .min(10_000)
          .default(30 * 60 * 1000),
        /** Unacknowledged messages an agent may hold before low and normal notifications to it are refused. */
        max_open_per_recipient: z.number().int().min(1).max(10_000).default(50),
      })
      .passthrough()
      .prefault({}),
    providers: z.record(z.string(), Provider).default({}),
    master_brain: MasterBrainConfig,
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

# The Master Brain turns goals into plans ("friday goal create"). It calls a model only when the
# project allows remote calls here AND you allowed it on your machine ("friday brain allow-remote");
# store the key with "friday secrets set anthropic".
master_brain:
  provider: anthropic   # anthropic | fake | none (none: you write plans with "friday plan propose")
  model: auto           # claude-opus-5-5
  auto_approve: false   # a human approves each plan version with "friday plan approve"

providers:
  anthropic:
    allow_remote: false   # model calls leave this machine only when you set this to true
    daily_budget_usd: 5
`;
}
