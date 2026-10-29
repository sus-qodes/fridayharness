import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FridayError, TaskKind, TaskScope } from '@friday/protocol';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * An environment variable a project may set for a check or an operation: not one the execution
 * profile sets itself (ADR-0029 §4), and no `FRIDAY_` variable.
 */
const ENV_NAME =
  /^(?!(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR)$)(?!FRIDAY_)[A-Za-z_][A-Za-z0-9_]{0,63}$/i;
const ENV_NAME_MESSAGE = 'a variable name such as STRIPE_MODE (not PATH, TEMP, SystemRoot or a FRIDAY_ variable)';
export const EnvName = z.string().regex(ENV_NAME, ENV_NAME_MESSAGE);
/** A record keyed by variable names; Zod's own key errors do not say what is wrong. */
const envRecord = <T extends z.ZodType>(value: T) =>
  z.record(z.string(), value).superRefine((r, ctx) => {
    for (const k of Object.keys(r)) {
      if (!ENV_NAME.test(k)) ctx.addIssue({ code: 'custom', path: [k], message: `${k}: ${ENV_NAME_MESSAGE}` });
    }
  });
const EnvValues = envRecord(z.string().max(2000)).default({});
/** A path relative to the checkout, never leaving it. */
const RelativeDir = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (p) => !path.isAbsolute(p) && !/^[\\/]/.test(p) && !p.split(/[\\/]/).includes('..'),
    'a folder inside the checkout, relative to it',
  );

export const OPERATION_NAME = /^[a-z][a-z0-9-]{0,47}$/;

/**
 * An operation Friday runs for agents (ADR-0029 §1): a fixed command in the execution profile, with
 * stored secrets as environment variables. Declaring one is loosening: it waits for trust.
 */
export const OperationSpec = z
  .object({
    description: z.string().max(500).optional(),
    /** A binary name on the execution profile's list (such as `node`), or an absolute path to one. */
    command: z
      .string()
      .min(1)
      .max(500)
      .refine((c) => !/[\\/]/.test(c) || path.isAbsolute(c), 'a binary name such as "node", or an absolute path'),
    args: z.array(z.string().max(2000)).max(100).default([]),
    cwd: RelativeDir.optional(),
    env: EnvValues,
    /** Variable name → the name of a secret stored with `friday secrets set <name>`. */
    credentials: envRecord(
      z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'secret names are lowercase words such as "stripe-test"'),
    ).default({}),
    /** Default: high when it uses a credential, medium otherwise. */
    risk: z.enum(['low', 'medium', 'high']).optional(),
    timeout_ms: z.number().int().min(1000).max(3_600_000).default(120_000),
    /** Agent roles that may run it; empty: any agent holding a task. */
    roles: z.array(z.string().min(1).max(100)).max(20).default([]),
  })
  .strict();
export type OperationSpec = z.infer<typeof OperationSpec>;
export const Operations = z.record(
  z.string().regex(OPERATION_NAME, 'operation names are lowercase words'),
  OperationSpec,
);

/** Additions to the execution profile (ADR-0029 §4); both are loosening. */
export const ExecutionSettings = z
  .object({
    /** Binary names the profile may run beyond Friday's defaults. */
    binaries: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, 'a binary name such as "make"'))
      .max(50)
      .default([]),
    /** Variables of the daemon's environment passed to checks and operations. */
    env_passthrough: z.array(EnvName).max(50).default([]),
  })
  .strict()
  .prefault({});

const McpLevel = z.enum(['auto', 'review', 'manual', 'never']);
const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Levels for the tools of third-party MCP servers (ADR-0030 §3): `auto` (no review; loosening),
 * `review` (the host asks the human; the default), `manual` (denied unless approved), `never`.
 * Friday's own server is not configurable.
 */
export const McpSettings = z
  .object({
    servers: z
      .record(
        z.string(),
        z
          .object({ default: McpLevel.optional(), tools: z.record(z.string(), McpLevel).default({}) })
          .strict()
          .superRefine((m, ctx) => {
            for (const t of Object.keys(m.tools)) {
              if (!MCP_NAME.test(t)) ctx.addIssue({ code: 'custom', path: ['tools', t], message: `${t}: a tool name` });
            }
          }),
      )
      .default({})
      .superRefine((r, ctx) => {
        for (const k of Object.keys(r)) {
          if (!MCP_NAME.test(k)) ctx.addIssue({ code: 'custom', path: [k], message: `${k}: a server name` });
          else if (k === 'friday')
            ctx.addIssue({ code: 'custom', path: [k], message: "Friday's own MCP server is not configurable" });
        }
      }),
  })
  .strict()
  .prefault({});

/**
 * A URL on this machine: task text never leaves it for a service a tracked file chose (ADR-0031 §10).
 * A literal loopback address only: a name may resolve to an IPv6 address a service listening on
 * IPv4 does not answer (plan E.3).
 */
const LoopbackUrl = z
  .string()
  .url()
  .refine((u) => {
    try {
      return ['127.0.0.1', '[::1]'].includes(new URL(u).hostname);
    } catch {
      return false;
    }
  }, 'Laya must run on this machine: use http://127.0.0.1:<port>');

/** Model routing (ADR-0031). */
export const RoutingSettings = z
  .object({
    /** manual: a pinned or default model; policy: the guide; auto: Laya or the score; hybrid: pins and constraints first. */
    mode: z.enum(['manual', 'policy', 'auto', 'hybrid']).default('hybrid'),
    optimize: z.enum(['quality', 'balanced', 'cost', 'latency']).default('balanced'),
    default_model: z.string().min(1).max(100).nullable().default(null),
    must_use_local: z.boolean().default(false),
    prefer_cheaper_if_score_delta_below: z.number().min(0).max(1).default(0.05),
    /** When Laya's answer is not confident: the score's choice, the strongest model, a human, or no autonomous run. */
    low_confidence: z.enum(['score', 'strongest', 'human', 'block']).default('score'),
    /** Outcomes a model needs for a task class before they count. */
    min_samples: z.number().int().min(1).max(1000).default(5),
    /** Work that only runs on a model a human pinned for it. */
    sensitive: z
      .object({ kinds: z.array(z.string()).default([]), roles: z.array(z.string()).default([]) })
      .strict()
      .prefault({}),
    /** Models the project adds to Friday's registry, or replaces by id. */
    models: z.array(z.record(z.string(), z.unknown())).max(100).default([]),
    /**
     * A spending cap per task attempt, in dollars (plan M11.5); unset means no cap. Friday hands it
     * to spawn adapters whose host can enforce one (Claude Code's `--max-budget-usd`: the smaller of
     * the adapter's own cap and this), and ends any attempt whose reported cost reaches it.
     */
    task_budget_usd: z.number().positive().optional(),
    laya: z
      .object({
        enabled: z.boolean().default(false),
        url: LoopbackUrl.default('http://127.0.0.1:8000'),
        /** A Laya checkpoint name; default: Laya picks. */
        model: z.string().min(1).max(200).optional(),
        timeout_ms: z.number().int().min(100).max(60_000).default(3000),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});

/** Who decides approvals where (ADR-0030 §5). */
export const ApprovalSettings = z
  .object({
    /** false: low- and medium-risk approvals are decided on the CLI and the status page only. */
    elicitation: z.boolean().default(true),
  })
  .strict()
  .prefault({});

const Check = z.object({
  name: z.string().min(1),
  kind: z.enum(['test', 'lint', 'build', 'typecheck', 'other']).default('test'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeout_ms: z.number().int().min(1000).max(3_600_000).default(120_000),
  /** Relative to the checkout the task worked in: its worktree, or the main checkout (ADR-0024). */
  cwd: z.string().optional(),
  /** Plain variables for the check, on top of the execution profile's minimal environment (ADR-0029 §6). */
  env: EnvValues,
  /** The task kinds this check applies to; empty: every kind (ADR-0024 §4). */
  task_kinds: z.array(TaskKind).default([]),
  /** false: advisory; a failure is reported and does not fail the verification. */
  required: z.boolean().default(true),
  /**
   * Arguments that run only the tests related to the change, where "{files}" stands for them
   * (ADR-0024 §5). This targeted form runs first; if it fails, the full check is skipped.
   */
  targeted_args: z.array(z.string()).optional(),
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
    /** Risk tiers per capability (spec Part 07 §7, ADR-0027), over Friday's defaults. */
    risk: z.record(z.string(), z.enum(['low', 'medium', 'high'])).default({}),
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
    /**
     * Conflict-prone files (ADR-0025): writing under a `required` pattern takes an exclusive
     * reservation for the task; `ttl_ms` is how long it outlives a task that stands still.
     */
    reservations: z
      .object({
        mode: z.enum(['hybrid', 'off']).default('hybrid'),
        required: z.array(z.string()).default([]),
        ttl_ms: z.number().int().min(60_000).default(1_800_000),
      })
      .prefault({}),
    /**
     * Task worktrees (ADR-0023). `per_task`: each spawn-mode run works in its task's own checkout
     * beside Friday's state directory; `off`: everything works in the main checkout.
     */
    worktrees: z.object({ mode: z.enum(['per_task', 'off']).default('per_task') }).prefault({}),
    /**
     * Recovering work from a lost harness or a failed attempt (ADR-0026): how many more attempts a
     * task gets automatically, and how often the same agent error may repeat, before a human decides.
     */
    recovery: z
      .object({
        max_retries: z.number().int().min(0).max(10).default(2),
        max_same_error_retries: z.number().int().min(0).max(10).default(1),
      })
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
    /** Operations Friday runs for agents with stored secrets (ADR-0029); they wait for trust. */
    operations: Operations.default({}),
    /** The execution profile checks and operations run in (ADR-0029 §4). */
    execution: ExecutionSettings,
    /** Third-party MCP servers' tools (ADR-0030 §3). */
    mcp: McpSettings,
    approvals: ApprovalSettings,
    /** Model routing (ADR-0031). */
    routing: RoutingSettings,
  })
  .passthrough();
export type FridayConfig = z.infer<typeof FridayConfig>;

/**
 * The version of what decides permissions (ADR-0027 §4): autonomy, risk tiers, scopes, security and
 * reservations. An approval granted under one version does not count under another.
 */
export function policyVersion(config: FridayConfig): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
          )
        : v;
  const { autonomy, risk, scopes, security, reservations } = config;
  return createHash('sha256')
    .update(JSON.stringify(canonical({ autonomy, risk, scopes, security, reservations })))
    .digest('hex')
    .slice(0, 16);
}

/**
 * How a change to config.yaml reaches a running daemon (plan M11.2). A key under a live prefix is
 * read where it is used, so the daemon applies its new value as soon as it reads the file again;
 * what loosens still waits for trust (ADR-0028). A key under a restart prefix was captured when
 * Friday started (the address it listens on and its origins, the lease timers already running,
 * the worktree layout, the model providers and the planner built on its provider) and keeps its
 * start value until a restart. The most specific prefix decides, so the Master Brain's model, its
 * effort and token limit, its thresholds, `auto_approve` and `reservation_ttl_ms` are live inside a
 * section whose provider (and scripted answers) needs a restart. A key no list names applies live:
 * nothing of Friday captured it.
 */
export const LIVE_CONFIG_KEYS: readonly string[] = [
  'scopes',
  'autonomy',
  'risk',
  'security',
  'verification',
  'reservations',
  'recovery',
  'context',
  'communication',
  'master_brain.model',
  'master_brain.effort',
  'master_brain.max_tokens',
  'master_brain.auto_approve',
  'master_brain.escalate_after_failures',
  'master_brain.max_replans',
  'master_brain.reservation_ttl_ms',
  'operations',
  'execution',
  'mcp',
  'approvals',
  'routing',
];
export const RESTART_CONFIG_KEYS: readonly string[] = [
  'project',
  'daemon',
  'leases',
  'worktrees',
  'providers',
  'master_brain',
];

export type ConfigKeyEffect = 'live' | 'restart';

const prefixOf = (key: string, prefixes: readonly string[]): string =>
  prefixes
    .filter((p) => key === p || key.startsWith(`${p}.`))
    .reduce((longest, p) => (p.length > longest.length ? p : longest), '');

/** Whether a changed key (a dotted path such as `daemon.port`) applies while Friday runs or needs a restart. */
export function configKeyEffect(key: string): ConfigKeyEffect {
  return prefixOf(key, RESTART_CONFIG_KEYS).length > prefixOf(key, LIVE_CONFIG_KEYS).length ? 'restart' : 'live';
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => sameValue(a[k], b[k]));
  }
  return false;
};

/**
 * The keys whose values differ between two configurations, as dotted paths down to the first value
 * that is not a plain object (`daemon.port`, `scopes.frontend.write`, `verification.checks`), in
 * the file's order.
 */
export function changedConfigKeys(before: unknown, after: unknown, prefix = ''): string[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])];
    return keys.flatMap((k) => changedConfigKeys(before[k], after[k], prefix ? `${prefix}.${k}` : k));
  }
  return sameValue(before, after) || prefix === '' ? [] : [prefix];
}

/** Whether a declared key lies below this path, so the path's own effect is not the whole story. */
const dividedBelow = (path: string): boolean =>
  [...LIVE_CONFIG_KEYS, ...RESTART_CONFIG_KEYS].some((k) => k.startsWith(`${path}.`));

function inForce(path: string, started: unknown, next: unknown): unknown {
  // The root, and a section with live and restart-only keys below it, are decided key by key.
  if ((path === '' || dividedBelow(path)) && isPlainObject(started) && isPlainObject(next)) {
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(next), ...Object.keys(started)])) {
      const sub = path ? `${path}.${k}` : k;
      const v = inForce(sub, started[k], next[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return configKeyEffect(path) === 'restart' ? started : next;
}

/**
 * The configuration a running daemon applies once the file changed: every live key as the file
 * has it now, every restart-only key as Friday started with it.
 */
export function liveConfig(started: FridayConfig, next: FridayConfig): FridayConfig {
  return inForce('', started, next) as FridayConfig;
}

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

# Commands \`friday verify <task>\` runs in the checkout the task worked in. Example:
#   checks:
#     - name: tests
#       command: node
#       args: ["--test"]
#       task_kinds: [implementation]          # optional: only for these task kinds
#       targeted_args: ["--test", "{files}"]  # optional: the related tests run first
verification:
  auto_on_completion: false
  checks: []

# Operations Friday runs for agents with secrets the agents never see. Store a secret with
# "friday secrets set <name>"; each operation waits for "friday policy trust" on every clone.
#   operations:
#     stripe-test:
#       command: node
#       args: ["--test", "test/stripe.integration.test.mjs"]
#       credentials: { STRIPE_SECRET_KEY: stripe-test }

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
