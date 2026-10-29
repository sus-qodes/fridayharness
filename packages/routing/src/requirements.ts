import type { Dimension } from './registry.js';

/**
 * What a task needs from a model (spec Part 08 §5), templated by task kind: no model call. Weights
 * say which capabilities matter; the sensitivities say how much latency and cost should count.
 */
export interface Requirements {
  weights: Partial<Record<Dimension, number>>;
  latency_sensitivity: number;
  cost_sensitivity: number;
  vision: boolean;
}

/** Recorded with every decision, so a decision can be reproduced (ADR-0031 §10). */
export const REQUIREMENTS_VERSION = 'req-1';

export const REQUIREMENTS: Record<string, Requirements> = {
  implementation: {
    weights: {
      code_editing: 1,
      code_generation: 0.9,
      debugging: 0.7,
      tool_use: 0.8,
      repo_navigation: 0.6,
      test_generation: 0.4,
    },
    latency_sensitivity: 0.3,
    cost_sensitivity: 0.4,
    vision: false,
  },
  verification: {
    weights: { tool_use: 1, debugging: 0.6, test_generation: 0.5, review: 0.4 },
    latency_sensitivity: 0.6,
    cost_sensitivity: 0.7,
    vision: false,
  },
  review: {
    weights: { review: 1, security_analysis: 0.7, architecture: 0.6, repo_navigation: 0.5, debugging: 0.4 },
    latency_sensitivity: 0.2,
    cost_sensitivity: 0.3,
    vision: false,
  },
  research: {
    weights: { repo_navigation: 1, planning: 0.8, architecture: 0.7, documentation: 0.4 },
    latency_sensitivity: 0.3,
    cost_sensitivity: 0.5,
    vision: false,
  },
  docs: {
    weights: { documentation: 1, structured_output: 0.5, repo_navigation: 0.4 },
    latency_sensitivity: 0.5,
    cost_sensitivity: 0.7,
    vision: false,
  },
  chore: {
    weights: { code_editing: 0.8, tool_use: 0.8, structured_output: 0.4 },
    latency_sensitivity: 0.7,
    cost_sensitivity: 0.9,
    vision: false,
  },
};

/** The template for a task kind; an unknown kind is treated as implementation. */
export function requirementsFor(kind: string): Requirements {
  return REQUIREMENTS[kind] ?? (REQUIREMENTS.implementation as Requirements);
}
