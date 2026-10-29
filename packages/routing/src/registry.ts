import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** The capability dimensions Friday tracks per model (spec Part 08 §4). */
export const DIMENSIONS = [
  'code_generation',
  'code_editing',
  'debugging',
  'planning',
  'architecture',
  'repo_navigation',
  'tool_use',
  'structured_output',
  'vision',
  'documentation',
  'test_generation',
  'review',
  'security_analysis',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

const Score = z.number().min(0).max(1);
const Capabilities = z.partialRecord(z.enum(DIMENSIONS), Score);

/** One model as a project may declare it (`routing.models`) or Friday ships it (the guide). */
export const ModelRecordInput = z
  .object({
    id: z.string().min(1).max(100),
    provider: z.string().min(1).max(50).default('unknown'),
    /** Harness vendors that can run it (`claude-code`, `codex`, …). */
    vendors: z.array(z.string().min(1).max(50)).default([]),
    vision: z.boolean().default(false),
    local: z.boolean().default(false),
    context_tokens: z.number().int().positive().nullable().default(null),
    /** USD per million tokens. */
    price: z
      .object({ input: z.number().min(0), output: z.number().min(0) })
      .nullable()
      .default(null),
    latency_ms: z.number().int().positive().nullable().default(null),
    capabilities: Capabilities.default({}),
    notes: z.string().max(500).nullable().default(null),
  })
  .strict();
export type ModelRecordInput = z.input<typeof ModelRecordInput>;
export type ModelRecord = z.output<typeof ModelRecordInput> & {
  /** Where its numbers come from: Friday's priors, or the project's own record. */
  source: 'seed' | 'project';
};

const GuideClass = z
  .object({
    preferred: z.array(z.string()).default([]),
    fallback: z.array(z.string()).default([]),
    avoid: z.array(z.string()).default([]),
    notes: z.string().nullable().default(null),
  })
  .strict();
export type GuideClass = z.output<typeof GuideClass>;

const GuideFile = z
  .object({
    version: z.string().min(1),
    models: z.array(ModelRecordInput),
    classes: z.record(z.string(), GuideClass),
  })
  .strict();

export interface ModelGuide {
  version: string;
  models: ModelRecord[];
  classes: Record<string, GuideClass>;
}

let cached: ModelGuide | undefined;

/** Friday's shipped registry priors and routing guide (`packages/routing/model-guide.yaml`). */
export function loadGuide(): ModelGuide {
  if (cached) return cached;
  const file = fileURLToPath(new URL('../model-guide.yaml', import.meta.url));
  const parsed = GuideFile.parse(parseYaml(readFileSync(file, 'utf8')));
  cached = {
    version: parsed.version,
    models: parsed.models.map((m) => ({ ...m, source: 'seed' as const })),
    classes: parsed.classes,
  };
  return cached;
}

/** Friday's models with the project's own records added; a project record replaces one with its id. */
export function mergeModels(seed: readonly ModelRecord[], project: readonly ModelRecordInput[]): ModelRecord[] {
  const out = new Map(seed.map((m) => [m.id, m]));
  for (const p of project) out.set(p.id, { ...ModelRecordInput.parse(p), source: 'project' });
  return [...out.values()];
}
