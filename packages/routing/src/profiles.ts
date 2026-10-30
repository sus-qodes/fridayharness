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

/**
 * Classify only from task facts. This deliberately does not inspect files or call a model, which keeps
 * routing reproducible and makes missing scope/summary visible instead of silently guessing.
 */
export function classifyRoutingProfile(task: RoutingTaskFacts): RoutingProfileClassification {
  const reasons: string[] = [];
  const summary = task.summary.trim();
  if (!summary) reasons.push('summary is empty');
  if (!task.scope) reasons.push('scope is missing');

  const paths = task.scope ? [...task.scope.write, ...task.scope.read] : [];
  if (!paths.length) reasons.push('scope has no paths');
  if (!summary || !task.scope || !paths.length) return { profile: 'ambiguous', reasons };

  if (task.risk_level === 'high') return { profile: 'high-risk', reasons: ['risk_level=high'] };

  if (paths.some((path) => GLOB.test(path))) {
    return { profile: 'large', reasons: ['scope contains a glob pattern'] };
  }

  if (paths.length === 1 && ['chore', 'docs', 'verification'].includes(task.kind)) {
    return { profile: 'trivial', reasons: ['one concrete path', `kind=${task.kind}`] };
  }
  if (paths.length <= 2)
    return { profile: 'short', reasons: [`${paths.length} concrete path${paths.length === 1 ? '' : 's'}`] };
  if (paths.length <= 8) return { profile: 'medium', reasons: [`${paths.length} concrete paths`] };
  return { profile: 'large', reasons: [`${paths.length} concrete paths`] };
}
