/** The planner's view of a model: one structured request in, one JSON object out (ADR-0013). */

export interface ModelUsage {
  /** Uncached prompt tokens. */
  input_tokens: number;
  /** Includes thinking tokens. */
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** The part of `cache_creation_input_tokens` written with the 1-hour TTL (priced higher). */
  cache_write_1h_input_tokens?: number;
}

export const ZERO_USAGE: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

export interface ModelRequest {
  purpose: 'plan' | 'replan';
  model: string;
  system: string;
  /** Large, stable project context; providers that support it cache this part. */
  context: string;
  /** The per-call instruction. */
  prompt: string;
  /** JSON Schema of the object to return. */
  schema: Record<string, unknown>;
  schemaName: string;
  maxTokens: number;
  /** The rejected previous answer and why, for the single repair attempt. */
  repair?: { previous: string; errors: string[] };
}

export interface ModelResponse {
  /** The returned object, not yet validated. */
  output: unknown;
  model: string;
  usage: ModelUsage;
  stop_reason: string;
  request_id: string | null;
}

export type ModelErrorCode =
  | 'rate_limited'
  | 'overloaded'
  | 'auth'
  | 'bad_request'
  | 'network'
  | 'timeout'
  | 'refused'
  | 'truncated'
  | 'no_output'
  | 'unavailable';

export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

export interface PlannerModel {
  /** `anthropic`, `fake`, … */
  readonly provider: string;
  /** True when requests leave this machine (needs `providers.<name>.allow_remote: true`, plan B28). */
  readonly remote: boolean;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
