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
});
export type ContextPacket = z.infer<typeof ContextPacket>;
