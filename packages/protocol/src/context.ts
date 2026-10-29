import { z } from 'zod';

/** Per-source ranking fields (spec Part 14 §9). */
export const SourceRef = z.object({
  source_id: z.string(),
  source_type: z.enum(['task_record', 'git', 'file', 'graph', 'memory', 'event', 'message', 'daemon']),
  authority: z.string(),
  recency: z.string(),
  relevance: z.number().min(0).max(1),
  relationship_distance: z.number().int().min(0),
  verification_status: z.enum(['verified', 'unverified', 'superseded']),
  selection_reason: z.string(),
  estimated_tokens: z.number().int().min(0),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const ContextSection = z.object({
  kind: z.string(),
  content: z.string(),
  sources: z.array(SourceRef),
  authority: z.enum(['human', 'system', 'agent', 'task', 'git', 'memory', 'graph']),
});
export type ContextSection = z.infer<typeof ContextSection>;

/** Context packet contract (spec Part 14 §8, ADR-0011). Optional fields are Friday additions. */
export const ContextPacket = z.object({
  context_id: z.string(),
  project_id: z.string(),
  recipient: z.object({
    kind: z.enum(['agent', 'master_brain', 'human']),
    id: z.string(),
    harness_id: z.string().optional(),
    run_id: z.string().optional(),
  }),
  task_id: z.string().optional(),
  purpose: z.string().optional(),
  created_at: z.string(),
  state_version: z.number().int().min(0),
  budget: z.object({ tokens: z.number().int(), latency_ms: z.number().int(), chars: z.number().int().optional() }),
  sections: z.array(ContextSection),
  staleness: z.object({ is_stale: z.boolean(), reason: z.string().optional() }),
  explain_uri: z.string().optional(),
  /** The execution root's source version the packet was compiled at (ADR-0019, ADR-0022). */
  source_version: z.string().optional(),
});
export type ContextPacket = z.infer<typeof ContextPacket>;

/** Why a packet holds what it holds (ADR-0022 §8). Sources withheld by permission are only counted. */
export const ContextExplanation = z.object({
  context_id: z.string(),
  cache_key: z.string(),
  source_version: z.string().nullable(),
  budget: z.object({
    chars: z.number().int(),
    used_chars: z.number().int(),
    max_sources: z.number().int(),
    sources: z.number().int(),
  }),
  included: z.array(
    z.object({
      section: z.string(),
      source_id: z.string(),
      priority: z.number().int(),
      relevance: z.number(),
      protected: z.boolean(),
      reason: z.string(),
      rule: z.string(),
      tokens: z.number().int(),
    }),
  ),
  cut_by_budget: z.array(
    z.object({
      section: z.string(),
      source_id: z.string(),
      priority: z.number().int(),
      reason: z.string(),
      tokens: z.number().int(),
    }),
  ),
  withheld_by_permission: z.number().int(),
  unsupported_edges: z.array(z.object({ from: z.string(), specifier: z.string().nullable(), reason: z.string() })),
  memory_conflicts: z.array(z.object({ memory_id: z.string(), contradicts: z.array(z.string()), kept: z.string() })),
  semantic_fallback: z.object({ enabled: z.boolean(), results: z.number().int() }),
  escalate: z.boolean(),
  notes: z.array(z.string()),
  timings_ms: z.record(z.string(), z.number()),
});
export type ContextExplanation = z.infer<typeof ContextExplanation>;
