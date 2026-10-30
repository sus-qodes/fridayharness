import type { GuideClass } from './registry.js';

/** The deterministic task-shape profiles used by model routing. */
export const ROUTING_PROFILES = ['trivial', 'short', 'medium', 'large', 'high-risk', 'ambiguous'] as const;
export type RoutingProfile = (typeof ROUTING_PROFILES)[number];

export interface RoutingTaskFacts {
  kind: string;
  summary: string;
  risk_level: 'low' | 'medium' | 'high' | null | undefined;
  scope: { write: readonly string[]; read: readonly string[] } | null | undefined;
}

export interface RoutingProfileClassification {
  profile: RoutingProfile;
  reasons: string[];
}

/** A profile preference has the same shape as an existing guide class, so overrides stay compatible. */
export type ProfilePreference = GuideClass;

const GLOB = /[*?]|\[/;
const KNOWN_KINDS = new Set(['implementation', 'verification', 'review', 'research', 'docs', 'chore']);
const READ_ONLY_KINDS = new Set(['verification', 'review', 'research']);
const HIGH_RISK_PATH =
  /(^|[\\/])(\.env(?:\.|$)|.*(?:auth|security|payment|migration|policy|permission|firestore\.rules).*)/i;

/**
 * Classify only from task facts. This deliberately does not inspect files or call a model, which keeps
 * routing reproducible and makes missing scope/summary visible instead of silently guessing.
 */
export function classifyRoutingProfile(task: RoutingTaskFacts): RoutingProfileClassification {
  const reasons: string[] = [];
  const summary = task.summary.trim();
  if (!summary) reasons.push('summary is empty');
  if (!KNOWN_KINDS.has(task.kind)) reasons.push(`unknown task kind: ${task.kind}`);
  if (!task.scope) reasons.push('scope is missing');

  const writePaths = task.scope?.write ?? [];
  const readPaths = task.scope?.read ?? [];
  const paths = READ_ONLY_KINDS.has(task.kind) ? [...writePaths, ...readPaths] : [...writePaths];
  if (!paths.length) reasons.push('scope has no paths');
  if (!READ_ONLY_KINDS.has(task.kind) && !writePaths.length) reasons.push('task kind requires a write scope');
  if (!summary || !task.scope || !paths.length || !KNOWN_KINDS.has(task.kind)) return { profile: 'ambiguous', reasons };

  if (task.risk_level === 'high' || paths.some((path) => HIGH_RISK_PATH.test(path))) {
    return {
      profile: 'high-risk',
      reasons: task.risk_level === 'high' ? ['risk_level=high'] : ['scope contains a high-risk path'],
    };
  }

  if (paths.some((path) => GLOB.test(path))) {
    return { profile: 'large', reasons: ['scope contains a glob pattern'] };
  }

  if (paths.length === 1 && ['chore', 'docs', 'verification'].includes(task.kind)) {
    return { profile: 'trivial', reasons: ['one concrete path', `kind=${task.kind}`] };
  }
  if (['review', 'research'].includes(task.kind) && paths.length <= 3) {
    return {
      profile: 'medium',
      reasons: [`${paths.length} bounded path${paths.length === 1 ? '' : 's'}`, `kind=${task.kind}`],
    };
  }
  if (paths.length <= 2)
    return { profile: 'short', reasons: [`${paths.length} concrete path${paths.length === 1 ? '' : 's'}`] };
  if (paths.length <= 8) return { profile: 'medium', reasons: [`${paths.length} concrete paths`] };
  return { profile: 'large', reasons: [`${paths.length} concrete paths`] };
}
