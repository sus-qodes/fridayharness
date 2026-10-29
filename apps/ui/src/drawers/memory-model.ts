/**
 * The memory bank's pure parts (plan §7.4, ERRATA F25): authority looks, the recency bar from the
 * search result's `why.weight` and the authority's half-life (agent 30 days, system 90, verified 180,
 * human-approved never), and the kind and scope filters, which run here over the results shown
 * because `GET memory` has no scope filter (plan §2).
 */
import type { MemoryHit } from '../api/client.js';

/** Days for a memory's recency to halve, by authority (`@friday/state` memory.ts). */
export const HALF_LIFE_DAYS: Record<string, number> = {
  'human-approved': Number.POSITIVE_INFINITY,
  verified: 180,
  system: 90,
  agent: 30,
};

export const MEMORY_KINDS = [
  'decision',
  'architecture',
  'constraint',
  'convention',
  'bug-pattern',
  'dependency',
  'operational-runbook',
  'human-preference',
  'outcome',
  'learned-risk',
  'unresolved-question',
  'summary',
] as const;

export const MEMORY_SCOPES = ['project', 'team', 'agent', 'task', 'session'] as const;

export type Tone = 'good' | 'info' | 'warn' | 'danger' | 'muted' | 'strong';

export const AUTHORITY_LOOK: Record<string, { label: string; tone: Tone }> = {
  'human-approved': { label: 'Human-approved', tone: 'strong' },
  verified: { label: 'Verified', tone: 'good' },
  system: { label: 'System', tone: 'info' },
  agent: { label: 'Agent', tone: 'muted' },
};

export function authorityLook(authority: string): { label: string; tone: Tone } {
  return AUTHORITY_LOOK[authority] ?? { label: authority, tone: 'muted' };
}

const DAY = 86_400_000;

export interface RecencyBar {
  /** 0–1: how much of its recency the memory keeps (1 for one that never fades). */
  fraction: number;
  /** The daemon's ranking weight for this search (authority × verification × recency × reuse × review). */
  weight: number | null;
  halfLifeDays: number;
  ageDays: number;
  permanent: boolean;
  label: string;
}

export function recencyBar(hit: Pick<MemoryHit, 'authority' | 'updated_at' | 'why'>, now: number): RecencyBar {
  const halfLifeDays = HALF_LIFE_DAYS[hit.authority] ?? 30;
  const t = Date.parse(hit.updated_at);
  const ageDays = Number.isNaN(t) ? 0 : Math.max(0, (now - t) / DAY);
  const permanent = !Number.isFinite(halfLifeDays);
  const fraction = permanent ? 1 : clamp01(0.5 ** (ageDays / halfLifeDays));
  const w = hit.why?.weight;
  const weight = typeof w === 'number' && Number.isFinite(w) ? clamp01(w) : null;
  const age = ageDays < 1 ? 'today' : `${Math.round(ageDays)} d old`;
  const label = permanent
    ? `never fades · ${age}`
    : `half-life ${halfLifeDays} d · ${age} · ${Math.round(fraction * 100)}% recent`;
  return { fraction, weight, halfLifeDays, ageDays, permanent, label };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export interface MemoryFilter {
  kind: string;
  scope: string;
}

/** The kind and scope filters ('' = all), applied to the results shown. */
export function filterMemories(hits: readonly MemoryHit[], f: MemoryFilter): MemoryHit[] {
  return hits.filter((m) => (!f.kind || m.kind === f.kind) && (!f.scope || m.scope_type === f.scope));
}

/** Human-approved memories pinned first, then by score, then the newest. */
export function sortMemories(hits: readonly MemoryHit[]): MemoryHit[] {
  return [...hits].sort((a, b) => {
    const pa = a.authority === 'human-approved' ? 0 : 1;
    const pb = b.authority === 'human-approved' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (sa !== sb) return sb - sa;
    return b.updated_at.localeCompare(a.updated_at);
  });
}
