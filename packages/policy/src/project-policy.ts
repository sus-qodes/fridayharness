import { createHash } from 'node:crypto';
import { type Capability, DEFAULT_RISK, type Risk } from './capabilities.js';
import { type Autonomy, type CommandClass, DEFAULT_AUTONOMY } from './commands.js';

/**
 * A project's own policy (spec Part 07 §3, §11, ADR-0028): what its tracked files say, merged with
 * Friday's defaults. Tightening always applies. Anything that loosens Friday's defaults comes from
 * repository content, so it applies only once this clone trusted exactly that loosening.
 */

/** One tracked source: `config.yaml`, or a file in `.friday/policies/`. */
export interface PolicySource {
  name: string;
  autonomy?: Record<string, string>;
  risk?: Record<string, string>;
  /** Paths no task may write (or read) without a human, whatever its scope. */
  deny?: { write?: string[]; read?: string[] };
  /** Scopes per agent role: an agent of the role never writes outside its team's scope. */
  teams?: Record<string, { write?: string[]; read?: string[] }>;
  enforcement_required?: 'L0' | 'L1' | 'L2';
  reservations_mode?: 'hybrid' | 'off';
  auto_approve?: boolean;
}

export interface Loosening {
  source: string;
  setting: string;
  from: string;
  to: string;
}

export interface ProjectPolicy {
  autonomy: Partial<Record<CommandClass, Autonomy>>;
  risk: Partial<Record<Capability, Risk>>;
  deny: { write: string[]; read: string[] };
  /** Per role, every scope a source gave it: a write must fall inside each (tighten only). */
  teams: Record<string, { source: string; write: string[]; read: string[] }[]>;
  enforcement_required: 'L0' | 'L1' | 'L2';
  reservations_mode: 'hybrid' | 'off';
  auto_approve: boolean;
  /** What tracked files loosen, with where each comes from. */
  loosening: Loosening[];
  /** The hash `friday policy trust` records; null when nothing loosens. */
  loosening_hash: string | null;
  /** Whether the loosening above applies (this clone trusted exactly it). */
  trusted: boolean;
  /** Identifies the effective policy: approvals granted under another version no longer count. */
  version: string;
  sources: string[];
}

const A: Record<Autonomy, number> = { auto: 0, review: 1, manual: 2, never: 3 };
const R: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
const L: Record<'L0' | 'L1' | 'L2', number> = { L0: 0, L1: 1, L2: 2 };
const DEFAULTS = { enforcement_required: 'L1' as const, reservations_mode: 'hybrid' as const, auto_approve: false };

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const isAutonomy = (v: string): v is Autonomy => v in A;
const isRisk = (v: string): v is Risk => v in R;

export function projectPolicy(sources: readonly PolicySource[], trustedHash: string | null): ProjectPolicy {
  const loosening: Loosening[] = [];
  for (const s of sources) {
    for (const [cls, v] of Object.entries(s.autonomy ?? {})) {
      const def = DEFAULT_AUTONOMY[cls as CommandClass];
      if (def && isAutonomy(v) && A[v] < A[def])
        loosening.push({ source: s.name, setting: `autonomy.${cls}`, from: def, to: v });
    }
    for (const [cap, v] of Object.entries(s.risk ?? {})) {
      const def = DEFAULT_RISK[cap as Capability];
      if (def && isRisk(v) && R[v] < R[def])
        loosening.push({ source: s.name, setting: `risk.${cap}`, from: def, to: v });
    }
    if (s.enforcement_required && L[s.enforcement_required] < L[DEFAULTS.enforcement_required]) {
      loosening.push({
        source: s.name,
        setting: 'security.enforcement_required',
        from: 'L1',
        to: s.enforcement_required,
      });
    }
    if (s.reservations_mode === 'off') {
      loosening.push({ source: s.name, setting: 'reservations.mode', from: 'hybrid', to: 'off' });
    }
    if (s.auto_approve)
      loosening.push({ source: s.name, setting: 'master_brain.auto_approve', from: 'false', to: 'true' });
  }
  loosening.sort((a, b) => `${a.setting} ${a.source}`.localeCompare(`${b.setting} ${b.source}`));
  const loosening_hash = loosening.length ? hash(loosening) : null;
  const trusted = loosening_hash === null || loosening_hash === trustedHash;

  // Each setting: the strictest of what the sources say, loosening counted only when trusted.
  const autonomy: Partial<Record<CommandClass, Autonomy>> = {};
  for (const cls of Object.keys(DEFAULT_AUTONOMY) as CommandClass[]) {
    const def = DEFAULT_AUTONOMY[cls];
    const values = sources.flatMap((s) => {
      const v = s.autonomy?.[cls];
      return v && isAutonomy(v) && (trusted || A[v] >= A[def]) ? [v] : [];
    });
    if (values.length) autonomy[cls] = values.reduce((a, b) => (A[b] > A[a] ? b : a));
  }
  const risk: Partial<Record<Capability, Risk>> = {};
  for (const cap of Object.keys(DEFAULT_RISK) as Capability[]) {
    const def = DEFAULT_RISK[cap];
    const values = sources.flatMap((s) => {
      const v = s.risk?.[cap];
      return v && isRisk(v) && (trusted || R[v] >= R[def]) ? [v] : [];
    });
    if (values.length) risk[cap] = values.reduce((a, b) => (R[b] > R[a] ? b : a));
  }
  const levels = sources.flatMap((s) =>
    s.enforcement_required && (trusted || L[s.enforcement_required] >= L.L1) ? [s.enforcement_required] : [],
  );
  const enforcement_required = levels.length
    ? levels.reduce((a, b) => (L[b] > L[a] ? b : a))
    : DEFAULTS.enforcement_required;
  const reservations_mode: ProjectPolicy['reservations_mode'] =
    sources.some((s) => s.reservations_mode === 'off') && trusted ? 'off' : DEFAULTS.reservations_mode;
  const auto_approve = trusted && sources.some((s) => s.auto_approve === true);

  const deny = {
    write: [...new Set(sources.flatMap((s) => s.deny?.write ?? []))].sort(),
    read: [...new Set(sources.flatMap((s) => s.deny?.read ?? []))].sort(),
  };
  const teams: ProjectPolicy['teams'] = {};
  for (const s of sources) {
    for (const [role, t] of Object.entries(s.teams ?? {})) {
      const layers = teams[role] ?? [];
      layers.push({ source: s.name, write: [...(t.write ?? [])], read: [...(t.read ?? [])] });
      teams[role] = layers;
    }
  }
  const effective = { autonomy, risk, deny, teams, enforcement_required, reservations_mode, auto_approve };
  return {
    ...effective,
    loosening,
    loosening_hash,
    trusted,
    version: hash(effective),
    sources: sources.map((s) => s.name),
  };
}
