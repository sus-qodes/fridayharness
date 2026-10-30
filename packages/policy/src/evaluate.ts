import type { TaskScope } from '@friday/protocol';
import { CLASS_CAPABILITY } from './capabilities.js';
import { type Autonomy, type CommandClass, classifyCommand } from './commands.js';
import { canonicalize, globsOverlap, matchesAny, type PathContext } from './paths.js';
import {
  type SensitiveClass,
  sensitiveClassOf,
  sensitiveInText,
  sensitivePattern,
  sensitiveWorkingFolder,
} from './sensitive.js';

export type ActionKind = 'read' | 'search' | 'write' | 'command' | 'network' | 'mcp';

export interface PolicyAction {
  /** Host tool name (Read, Edit, Bash, …). */
  tool: string;
  kind: ActionKind;
  paths?: string[];
  /** Glob or regex patterns (Glob, Grep). */
  patterns?: string[];
  command?: string;
  /**
   * The folder the command runs in, when the host names it (Gemini CLI's `dir_path`, Antigravity's
   * `Cwd`, Cursor's `cwd`); relative names in the command are read from there.
   */
  cwd?: string;
  url?: string;
  /** A third-party MCP tool (ADR-0030): its server and tool name. */
  server?: string;
  mcpTool?: string;
  /** Strings from an MCP tool's input, checked like a command (ADR-0030 §2). */
  texts?: string[];
  /** Those that look like paths, also checked like a write. */
  pathish?: string[];
}

export interface PolicyTask {
  task_id: string;
  status: string;
  scope: TaskScope | null;
  /** Review and research tasks without a write scope are read-only (ADR-0013). */
  kind?: string;
  /**
   * The team scopes of the agent's role (ADR-0028): a write must fall inside each, and a human
   * may approve a path outside them one at a time. Without `ceiling`, they are the ceiling too.
   */
  teams?: readonly { source: string; write: readonly string[] }[];
  /**
   * The ceiling of the task (plan M12.2): the team scopes of the task's own role, what delegated
   * it. A path outside the task's scope and outside one of these is beyond what delegated the
   * task, and no approval reaches it. Empty for a task no role bounds (one a human created); the
   * state cuts a plan task to the same scopes when the plan is made.
   */
  ceiling?: readonly { source: string; write: readonly string[] }[];
}

export interface OtherWriter {
  task_id: string;
  agent_key: string;
  scope: TaskScope | null;
}

export interface PolicyInput {
  action: PolicyAction;
  ctx: PathContext;
  /** The task the acting agent holds, if any. */
  task: PolicyTask | null;
  /** Other sessions currently writing in this working tree (single-live-writer rule, plan B26). */
  otherWriters?: OtherWriter[];
  /**
   * Whether a usable approval covers this capability (a catalogue name, ADR-0027) and exact target.
   * Only a check: the caller uses up what the result says it relied on.
   */
  approved?: (capability: string, target: string) => boolean;
  autonomy?: Partial<Record<CommandClass, Autonomy>>;
  /**
   * The project's verification checks, each its program and arguments (plan M14.6): a command that
   * is exactly one of them is judged as a test run.
   */
  checks?: readonly (readonly string[])[];
  /**
   * Conflict-prone files (ADR-0025 §1): a write under a `required` pattern needs the task to hold
   * that pattern's reservation, which the write takes when it is free; `held` are the reservations
   * other tasks hold.
   */
  reservations?: { required: readonly string[]; held: readonly { pattern: string; task_id: string }[] };
  /** The project's deny rules (ADR-0028): paths no task writes or reads without a human approving that path. */
  deny?: { write: readonly string[]; read: readonly string[] };
  /** The level of a third-party MCP tool under the project's server policy (ADR-0030 §3); default review. */
  mcp?: (server: string, tool: string) => Autonomy;
}

export type Decision = 'allow' | 'deny' | 'ask';

export interface PolicyResult {
  decision: Decision;
  reason: string;
  /** Stable rule id for audit and tests. */
  rule: string;
  sensitive_class?: SensitiveClass;
  command_class?: CommandClass;
  /** Project-relative targets the decision applied to. */
  targets: string[];
  enforcement_level: 'L1';
  /** An allowed write under these `required` patterns: the task must take their reservations. */
  reserve?: string[];
  /** A write denied because another task holds the reservation. */
  reserved_by?: { pattern: string; task_id: string };
  /** Approvals an allowed action relied on, to be used up by the caller (ADR-0027). */
  relied_on?: { capability: string; target: string }[];
  /**
   * With `ask`: the approval that lets this action through once a human grants it, so a caller
   * without a human at the host can ask for exactly that (ADR-0032 §4).
   */
  grant?: { capability: string; target: string };
}

const r = (decision: Decision, rule: string, reason: string, extra: Partial<PolicyResult> = {}): PolicyResult => ({
  decision,
  rule,
  reason,
  targets: [],
  enforcement_level: 'L1',
  ...extra,
});

const HOW_TO_ASK =
  'If this is really needed, call friday_request_permission and wait for a human, or report the task as blocked.';

/** Sensitive-path check alone; the hook launcher runs this locally so it holds even when the daemon is down. */
export function evaluateSensitive(action: PolicyAction, ctx: PathContext): PolicyResult | null {
  const op = action.kind === 'write' ? 'write' : 'read';
  for (const p of action.paths ?? []) {
    const hit = sensitiveClassOf(p, ctx, op);
    if (hit) {
      return r(
        'deny',
        `sensitive.${hit.class}`,
        `${hit.path} is protected by Friday (${hit.class}); agents may not ${op} it.`,
        {
          sensitive_class: hit.class,
          targets: [hit.path],
        },
      );
    }
  }
  for (const pat of action.patterns ?? []) {
    const hit = sensitivePattern(pat, ctx);
    if (hit) {
      return r('deny', `sensitive.${hit.class}`, `searching ${pat} would expose protected files (${hit.class}).`, {
        sensitive_class: hit.class,
        targets: [pat],
      });
    }
  }
  if (action.command) {
    const hit = sensitiveInText(action.command, ctx);
    if (hit) {
      return r('deny', `sensitive.${hit.class}`, `this command touches protected files (${hit.class}).`, {
        sensitive_class: hit.class,
        targets: [hit.path],
      });
    }
  }
  if (action.cwd) {
    const hit = sensitiveWorkingFolder(action.cwd, ctx);
    if (hit) {
      return r(
        'deny',
        `sensitive.${hit.class}`,
        `this command would run inside ${hit.path}, a folder Friday protects (${hit.class}); run it from the project's own folders.`,
        { sensitive_class: hit.class, targets: [hit.path] },
      );
    }
  }
  // A third-party MCP tool: Friday cannot know what it does with its input (ADR-0030 §2).
  for (const t of action.texts ?? []) {
    const hit = sensitiveInText(t, ctx);
    if (hit) {
      return r('deny', `sensitive.${hit.class}`, `${action.tool} was given a protected location (${hit.class}).`, {
        sensitive_class: hit.class,
        targets: [hit.path],
      });
    }
  }
  for (const p of action.pathish ?? []) {
    let hit: ReturnType<typeof sensitiveClassOf> = null;
    try {
      hit = sensitiveClassOf(p.replace(/^file:\/\/\/?/i, ''), ctx, 'write');
    } catch {
      hit = null; // not a usable path
    }
    if (hit) {
      return r(
        'deny',
        `sensitive.${hit.class}`,
        `${action.tool} was given ${hit.path}, which Friday protects (${hit.class}).`,
        {
          sensitive_class: hit.class,
          targets: [hit.path],
        },
      );
    }
  }
  return null;
}

/**
 * The project's read rule (ADR-0028, review F02): a project-relative path its policy keeps from
 * agents (`deny.read`) stays kept unless a human approved reading that exact path. The hooks and
 * the context compiler apply this one rule, so what an agent may not read is never gathered for it.
 */
export function readKeptFromAgents(
  rel: string,
  denyRead: readonly string[],
  approved?: (rel: string) => boolean,
  windows?: boolean,
): boolean {
  if (!denyRead.length || !matchesAny(rel, denyRead, windows)) return false;
  return !approved?.(rel);
}

/**
 * The ceiling on a task's writes (plan M12.2): a task never holds more authority than what
 * delegated it. A plan task is cut to the scopes the project declares for its role when it is
 * made, so its scope lies inside them; a human may still widen it path by path (an exact-path
 * approval) up to that ceiling, and a team scope may yield inside the task's scope the same way
 * (ADR-0028). A path outside the task's scope and outside a team scope of the role is beyond
 * both, and no approval lifts it. The role is the task's own (`ceiling`); a caller that knows
 * only the agent's team scopes passes those as `teams`, and they bound the task the same way.
 * Returns the team scope that is the ceiling, or null when the path is inside the task's scope,
 * the role has no team scope, or the task declares no scope.
 */
export function aboveCeiling(
  rel: string,
  task: Pick<PolicyTask, 'scope' | 'teams' | 'ceiling'>,
  windows?: boolean,
): { source: string; write: readonly string[] } | null {
  const scope = task.scope?.write ?? [];
  if (scope.length === 0 || matchesAny(rel, scope, windows)) return null;
  const layers = task.ceiling ?? task.teams ?? [];
  return layers.find((t) => t.write.length > 0 && !matchesAny(rel, t.write, windows)) ?? null;
}

/**
 * Friday's M1 policy for one intercepted host action (spec Part 07, plan M1.8). The result is
 * only ever used to restrict: "allow" means Friday does not object, and the host's own
 * permission rules still apply.
 */
export function evaluate(input: PolicyInput): PolicyResult {
  const { action, ctx, task } = input;
  const sensitive = evaluateSensitive(action, ctx);
  if (sensitive) return sensitive;

  if (action.kind === 'read' || action.kind === 'search') {
    // Paths the project keeps from agents (ADR-0028), unless a human approved that exact path.
    for (const p of input.deny?.read.length ? (action.paths ?? []) : []) {
      const rel = canonicalize(p, ctx).relative;
      if (rel === null || !readKeptFromAgents(rel, input.deny?.read ?? [], undefined, ctx.windows)) continue;
      if (input.approved?.('file.read', rel)) {
        return r('allow', 'read.approved', `a human approved reading ${rel}.`, {
          targets: [rel],
          relied_on: [{ capability: 'file.read', target: rel }],
        });
      }
      return r('deny', 'read.denied_by_policy', `the project's policy keeps ${rel} from agents. ${HOW_TO_ASK}`, {
        targets: [rel],
      });
    }
    return r('allow', 'read.default', 'reading is not restricted by task scope in M1.');
  }

  if (action.kind === 'mcp') {
    const server = action.server ?? '';
    const tool = action.mcpTool ?? '';
    const target = `${server}/${tool}`;
    const level = input.mcp?.(server, tool) ?? 'review';
    if (level === 'never')
      return r('deny', 'mcp.never', `the project's policy never lets agents use ${target}.`, { targets: [target] });
    if (level === 'auto') return r('allow', 'mcp.auto', `${target} runs without review.`, { targets: [target] });
    if (input.approved?.('mcp.call', target)) {
      return r('allow', 'mcp.approved', `a human approved using ${target}.`, {
        targets: [target],
        relied_on: [{ capability: 'mcp.call', target }],
      });
    }
    if (level === 'manual') {
      return r('deny', 'mcp.manual', `${target} needs an explicit human approval first (mcp.call). ${HOW_TO_ASK}`, {
        targets: [target],
      });
    }
    return r('ask', 'mcp.review', `${target} is a tool of another MCP server; a human decides.`, {
      targets: [target],
      grant: { capability: 'mcp.call', target },
    });
  }

  if (action.kind === 'network') {
    const target = action.url ?? action.tool;
    if (input.approved?.('network.read', target))
      return r('allow', 'network.approved', `a human approved network access to ${target}.`, {
        targets: [target],
        relied_on: [{ capability: 'network.read', target }],
      });
    return r('ask', 'network.review', `network access (${target}) needs a human decision in M1.`, {
      command_class: 'network.fetch',
      targets: [target],
      grant: { capability: 'network.read', target },
    });
  }

  if (action.kind === 'command') {
    // The host tool names the shell: Claude Code's Bash tool runs bash (Git Bash on Windows), its
    // PowerShell tool PowerShell; other hosts name it in the command's own wrapper (LESSONS D-45).
    const shell = action.tool === 'PowerShell' ? 'powershell' : action.tool === 'Bash' ? 'posix' : undefined;
    const c = classifyCommand(action.command ?? '', input.autonomy, shell, input.checks ?? []);
    const target = action.command ?? '';
    if (c.autonomy === 'never') {
      return r(
        'deny',
        `command.${c.class}`,
        `${c.class} commands are never allowed for agents (${c.segments.find((s) => s.class === c.class)?.text ?? target}). Use the friday_* tools for anything Friday-related.`,
        {
          command_class: c.class,
          targets: [target],
        },
      );
    }
    if (c.autonomy === 'auto')
      return r('allow', `command.${c.class}`, `${c.class} runs without review.`, {
        command_class: c.class,
        targets: [target],
      });
    if (input.approved?.(CLASS_CAPABILITY[c.class], target)) {
      return r('allow', 'command.approved', `a human approved this ${c.class} command.`, {
        command_class: c.class,
        targets: [target],
        relied_on: [{ capability: CLASS_CAPABILITY[c.class], target }],
      });
    }
    if (c.autonomy === 'manual') {
      return r('deny', `command.${c.class}`, `${c.class} needs an explicit human approval first. ${HOW_TO_ASK}`, {
        command_class: c.class,
        targets: [target],
      });
    }
    return r('ask', `command.${c.class}`, `${c.class} commands need a human decision.`, {
      command_class: c.class,
      targets: [target],
      grant: { capability: CLASS_CAPABILITY[c.class], target },
    });
  }

  // Writes: scope, approvals and the single-live-writer rule.
  const targets: string[] = [];
  /** Every project-relative location a write lands on: the path as given and, behind a link, its target. */
  const locations: string[] = [];
  for (const p of action.paths ?? []) {
    const c = canonicalize(p, ctx);
    if (c.relative === null) {
      return r('deny', 'write.outside_project', `${c.absolute} is outside the project. ${HOW_TO_ASK}`, {
        targets: [c.absolute],
      });
    }
    if (c.linked && c.realRelative === null) {
      return r(
        'deny',
        'write.outside_project',
        `${c.relative} is a link to ${c.real}, which is outside the project. ${HOW_TO_ASK}`,
        { targets: [c.relative] },
      );
    }
    targets.push(c.relative);
    locations.push(c.relative);
    if (c.linked && c.realRelative && c.realRelative !== c.relative) locations.push(c.realRelative);
  }
  if (!task) {
    return r(
      'ask',
      'write.no_task',
      'you hold no Friday task. Claim one with friday_task_claim before editing, or confirm this edit with the human.',
      { targets },
    );
  }
  if (!['RUNNING', 'WAITING'].includes(task.status)) {
    return r(
      'deny',
      'write.task_not_running',
      `your task ${task.task_id} is ${task.status}; edits are only allowed while it is RUNNING.`,
      { targets },
    );
  }
  if ((task.kind === 'review' || task.kind === 'research') && (task.scope?.write ?? []).length === 0) {
    return r(
      'deny',
      'write.read_only_task',
      `${task.task_id} is a ${task.kind} task with no write scope, so it is read-only. ${HOW_TO_ASK}`,
      { targets },
    );
  }
  const windows = ctx.windows ?? process.platform === 'win32';
  const relied: { capability: string; target: string }[] = [];
  for (const rel of locations) {
    for (const other of input.otherWriters ?? []) {
      const otherWrites = other.scope?.write ?? [];
      const conflict =
        otherWrites.length === 0 ||
        matchesAny(rel, otherWrites, windows) ||
        (task.scope?.write.length
          ? globsOverlap(task.scope.write, otherWrites) && matchesAny(rel, otherWrites, windows)
          : true);
      if (conflict) {
        return r(
          'deny',
          'write.single_live_writer',
          `${other.agent_key} is editing this working tree for ${other.task_id}, and its scope may include ${rel}. Coordinate through friday_communicate or wait.`,
          { targets },
        );
      }
    }
    const scope = task.scope?.write ?? [];
    // The ceiling (plan M12.2) is judged before any approval: nothing lifts it.
    const ceiling = aboveCeiling(rel, task, windows);
    if (ceiling) {
      return r(
        'deny',
        'write.above_ceiling',
        `${rel} is outside the scope of ${task.task_id} (${scope.join(', ')}) and outside the ${ceiling.source} scope of your role (${ceiling.write.join(', ')}). That scope is the ceiling of this task: no approval reaches beyond it. Work inside your scope, or tell the human the task needs another role or a wider team scope.`,
        { targets },
      );
    }
    let inScope = scope.length === 0 || matchesAny(rel, scope, windows);
    if (!inScope && input.approved?.('file.write', rel)) {
      inScope = true;
      relied.push({ capability: 'file.write', target: rel });
    }
    if (!inScope) {
      return r(
        'deny',
        'write.outside_scope',
        `${rel} is outside the scope of ${task.task_id} (${scope.join(', ')}). ${HOW_TO_ASK}`,
        { targets },
      );
    }
    // The project's deny rules and the team scopes of the agent's role only tighten (ADR-0028).
    const denied = input.deny?.write.length ? matchesAny(rel, input.deny.write, windows) : false;
    const team = (task.teams ?? []).find((t) => t.write.length > 0 && !matchesAny(rel, t.write, windows));
    if (denied || team) {
      if (input.approved?.('file.write', rel)) {
        if (!relied.some((x) => x.target === rel)) relied.push({ capability: 'file.write', target: rel });
      } else {
        return denied
          ? r(
              'deny',
              'write.denied_by_policy',
              `the project's policy keeps agents from changing ${rel}. ${HOW_TO_ASK}`,
              {
                targets,
              },
            )
          : r(
              'deny',
              'write.outside_team_scope',
              `${rel} is outside your team's scope (${team?.write.join(', ')}, from ${team?.source}). ${HOW_TO_ASK}`,
              { targets },
            );
      }
    }
    const holder = input.reservations?.held.find((h) => matchesAny(rel, [h.pattern], windows));
    if (holder) {
      return r(
        'deny',
        'write.reserved',
        `${rel} is reserved by ${holder.task_id} (${holder.pattern}) until that task's work is integrated. Wait for it, or coordinate through friday_communicate.`,
        { targets, reserved_by: { pattern: holder.pattern, task_id: holder.task_id } },
      );
    }
  }
  const required = input.reservations?.required ?? [];
  const reserve = [...new Set(locations.flatMap((rel) => required.filter((p) => matchesAny(rel, [p], windows))))];
  return r(
    'allow',
    task.scope?.write.length ? 'write.in_scope' : 'write.no_scope',
    task.scope?.write.length ? 'inside the task scope.' : 'the task declares no write scope.',
    { targets, ...(reserve.length ? { reserve } : {}), ...(relied.length ? { relied_on: relied } : {}) },
  );
}
