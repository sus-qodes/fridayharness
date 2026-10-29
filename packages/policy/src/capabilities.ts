/**
 * The capability catalogue (spec Part 07 §5–§7, ADR-0027): what an agent may ask for, each with a
 * resource target and a risk tier. Command classes (./commands.ts) map onto capabilities, so a
 * shell command, a host tool and an explicit request are judged in the same terms.
 */
import { type Autonomy, type CommandClass, classifyCommand, DEFAULT_AUTONOMY } from './commands.js';
import type { PolicyTask } from './evaluate.js';
import { canonicalize, matchesAny, type PathContext } from './paths.js';
import { sensitiveClassOf } from './sensitive.js';

export const CAPABILITIES = [
  'file.read',
  'file.write',
  'file.delete',
  'shell.test',
  'shell.build',
  'shell.git.read',
  'shell.git.commit',
  'shell.git.push',
  'network.read',
  'network.write',
  'package.install',
  'secret.resolve',
  'process.spawn',
  'agent.communicate',
  'task.reassign',
  'policy.request',
  'human.escalate',
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type Risk = 'low' | 'medium' | 'high';

/** The spec's suggested tiers (Part 07 §7); a project may change them (`risk` in its config). */
export const DEFAULT_RISK: Record<Capability, Risk> = {
  'file.read': 'low',
  'file.write': 'medium',
  'file.delete': 'high',
  'shell.test': 'low',
  'shell.build': 'low',
  'shell.git.read': 'low',
  'shell.git.commit': 'medium',
  'shell.git.push': 'high',
  'network.read': 'medium',
  'network.write': 'high',
  'package.install': 'medium',
  'secret.resolve': 'high',
  'process.spawn': 'medium',
  'agent.communicate': 'low',
  'task.reassign': 'high',
  'policy.request': 'high',
  'human.escalate': 'low',
};

/** The capability each command class needs. */
export const CLASS_CAPABILITY: Record<CommandClass, Capability> = {
  'read.local': 'file.read',
  'git.read': 'shell.git.read',
  'test.local': 'shell.test',
  'build.local': 'shell.build',
  'lint.local': 'shell.test',
  'git.mutate': 'shell.git.commit',
  'package.install': 'package.install',
  'fs.destructive': 'file.delete',
  'process.kill': 'process.spawn',
  'network.fetch': 'network.read',
  unknown: 'process.spawn',
  'git.push': 'shell.git.push',
  'git.force': 'shell.git.push',
  'network.publish': 'network.write',
  'secrets.read': 'secret.resolve',
  'friday.internal': 'policy.request',
};

/** Names the M1 policy and early agents used. */
const ALIASES: Record<string, Capability> = {
  'fs.read': 'file.read',
  'fs.write': 'file.write',
  'fs.delete': 'file.delete',
  'git.commit': 'shell.git.commit',
  'network.mutate': 'network.write',
};

/** The catalogue name for what was asked: a capability, a command class, or an older name; null if unknown. */
export function capabilityOf(name: string): Capability | null {
  if ((CAPABILITIES as readonly string[]).includes(name)) return name as Capability;
  if (name in CLASS_CAPABILITY) return CLASS_CAPABILITY[name as CommandClass];
  return ALIASES[name] ?? null;
}

const RANK: Record<Autonomy, number> = { auto: 0, review: 1, manual: 2, never: 3 };

export interface CapabilityRequest {
  capability: Capability;
  /** A path, a command, a URL or host; null when the capability has none. */
  target: string | null;
  task: PolicyTask | null;
  ctx: PathContext;
  autonomy?: Partial<Record<CommandClass, Autonomy>>;
  risk?: Partial<Record<Capability, Risk>>;
  /** The project's deny rules (ADR-0028); the task's team scopes come with the task. */
  deny?: { write: readonly string[]; read: readonly string[] };
}

export interface CapabilityDecision {
  /** `allow`: no approval needed; `review`: a human decides; `deny`: never through an approval. */
  decision: 'allow' | 'review' | 'deny';
  risk: Risk;
  rule: string;
  reason: string;
}

/**
 * Judges an explicit capability request (spec Part 07 §6): the task's scope, Friday's protected
 * files, the autonomy of the command classes behind the capability, and its risk.
 */
export function evaluateCapability(req: CapabilityRequest): CapabilityDecision {
  const risk = req.risk?.[req.capability] ?? DEFAULT_RISK[req.capability];
  const d = (decision: CapabilityDecision['decision'], rule: string, reason: string): CapabilityDecision => ({
    decision,
    risk,
    rule,
    reason,
  });
  const scope = req.task?.scope ?? null;
  switch (req.capability) {
    case 'secret.resolve':
      return d(
        'deny',
        'capability.secret',
        'secrets are never handed to agents; ask for the operation that needs one, which Friday runs with the secret itself',
      );
    case 'agent.communicate':
    case 'human.escalate':
      return d('allow', 'capability.own_tool', 'use friday_communicate or friday_ask_human; they need no approval');
    case 'task.reassign':
    case 'policy.request':
      return d('review', 'capability.human', `${req.capability} is decided by a human`);
    case 'file.read':
    case 'file.write':
    case 'file.delete': {
      if (!req.target) return d('review', 'capability.no_target', `${req.capability} needs the path it is for`);
      const op = req.capability === 'file.read' ? 'read' : 'write';
      const hit = sensitiveClassOf(req.target, req.ctx, op);
      if (hit) return d('deny', `sensitive.${hit.class}`, `${hit.path} is protected by Friday (${hit.class})`);
      const rel = canonicalize(req.target, req.ctx).relative;
      if (rel === null) return d('deny', 'capability.outside_project', `${req.target} is outside the project`);
      // The project's own tightening (ADR-0028) holds here as in the hooks: a human decides.
      const denied = op === 'read' ? (req.deny?.read ?? []) : (req.deny?.write ?? []);
      if (denied.length && matchesAny(rel, denied, req.ctx.windows)) {
        return d(
          'review',
          'capability.denied_by_policy',
          `the project's policy keeps agents from ${op === 'read' ? 'reading' : 'changing'} ${rel}`,
        );
      }
      const team =
        op === 'read'
          ? undefined
          : req.task?.teams?.find((t) => t.write.length > 0 && !matchesAny(rel, t.write, req.ctx.windows));
      if (team)
        return d('review', 'capability.outside_team_scope', `${rel} is outside your team's scope (${team.source})`);
      const globs = op === 'read' ? [...(scope?.read ?? []), ...(scope?.write ?? [])] : (scope?.write ?? []);
      if (op === 'read' && !scope?.read?.length)
        return d('allow', 'capability.in_scope', 'reading is not limited for this task');
      if (globs.length && matchesAny(rel, globs, req.ctx.windows)) {
        return req.capability === 'file.delete'
          ? d('review', 'capability.delete', `deleting ${rel} is decided by a human, even inside the scope`)
          : d('allow', 'capability.in_scope', `${rel} is inside the task's scope`);
      }
      return d('review', 'capability.outside_scope', `${rel} is outside the task's scope`);
    }
    default: {
      // Shell, network, packages, processes: the autonomy of the command classes behind them. For a
      // command, the stricter of that and the command's own class decides.
      const autonomy = { ...DEFAULT_AUTONOMY, ...(req.autonomy ?? {}) };
      let a = strictest(req.capability, autonomy);
      const shell =
        req.capability.startsWith('shell.') ||
        req.capability === 'package.install' ||
        req.capability === 'process.spawn';
      if (shell && req.target) {
        const c = classifyCommand(req.target, req.autonomy);
        if (RANK[c.autonomy] > RANK[a]) a = c.autonomy;
      }
      if (a === 'never') return d('deny', 'capability.never', `${req.capability} is never allowed for agents`);
      if (a === 'auto') return d('allow', 'capability.auto', `${req.capability} runs without review`);
      return d('review', `capability.${a}`, `${req.capability} needs a human decision (${risk} risk)`);
    }
  }
}

/** The strictest autonomy among the command classes that need a capability. */
function strictest(capability: Capability, autonomy: Record<CommandClass, Autonomy>): Autonomy {
  let worst: Autonomy = 'auto';
  for (const [cls, cap] of Object.entries(CLASS_CAPABILITY) as [CommandClass, Capability][]) {
    if (cap !== capability) continue;
    if (RANK[autonomy[cls]] > RANK[worst]) worst = autonomy[cls];
  }
  return worst;
}
