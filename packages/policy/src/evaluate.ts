import type { TaskScope } from '@friday/protocol';
import { type Autonomy, type CommandClass, classifyCommand } from './commands.js';
import { canonicalize, globsOverlap, matchesAny, type PathContext } from './paths.js';
import { type SensitiveClass, sensitiveClassOf, sensitiveInText, sensitivePattern } from './sensitive.js';

export type ActionKind = 'read' | 'search' | 'write' | 'command' | 'network';

export interface PolicyAction {
  /** Host tool name (Read, Edit, Bash, …). */
  tool: string;
  kind: ActionKind;
  paths?: string[];
  /** Glob or regex patterns (Glob, Grep). */
  patterns?: string[];
  command?: string;
  url?: string;
}

export interface PolicyTask {
  task_id: string;
  status: string;
  scope: TaskScope | null;
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
  /** True when a human granted this capability/target and the grant has not expired. */
  approved?: (capability: string, target: string) => boolean;
  autonomy?: Partial<Record<CommandClass, Autonomy>>;
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
  return null;
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

  if (action.kind === 'read' || action.kind === 'search')
    return r('allow', 'read.default', 'reading is not restricted by task scope in M1.');

  if (action.kind === 'network') {
    const target = action.url ?? action.tool;
    if (input.approved?.('network.read', target))
      return r('allow', 'network.approved', `a human approved network access to ${target}.`, { targets: [target] });
    return r('ask', 'network.review', `network access (${target}) needs a human decision in M1.`, {
      command_class: 'network.fetch',
      targets: [target],
    });
  }

  if (action.kind === 'command') {
    const c = classifyCommand(action.command ?? '', input.autonomy);
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
    if (input.approved?.(c.class, target)) {
      return r('allow', 'command.approved', `a human approved this ${c.class} command.`, {
        command_class: c.class,
        targets: [target],
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
    });
  }

  // Writes: scope, approvals and the single-live-writer rule.
  const targets: string[] = [];
  for (const p of action.paths ?? []) {
    const c = canonicalize(p, ctx);
    if (c.relative === null) {
      return r('deny', 'write.outside_project', `${c.absolute} is outside the project. ${HOW_TO_ASK}`, {
        targets: [c.absolute],
      });
    }
    targets.push(c.relative);
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
  const windows = ctx.windows ?? process.platform === 'win32';
  for (const rel of targets) {
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
    if (scope.length === 0) continue;
    if (matchesAny(rel, scope, windows)) continue;
    if (input.approved?.('fs.write', rel)) continue;
    return r(
      'deny',
      'write.outside_scope',
      `${rel} is outside the scope of ${task.task_id} (${scope.join(', ')}). ${HOW_TO_ASK}`,
      { targets },
    );
  }
  return r(
    'allow',
    task.scope?.write.length ? 'write.in_scope' : 'write.no_scope',
    task.scope?.write.length ? 'inside the task scope.' : 'the task declares no write scope.',
    { targets },
  );
}
