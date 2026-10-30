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
  purpose: 'plan' | 'replan' | 'role' | 'intent';
  model: string;
  /** Friday's rules, the same for every call (trusted). */
  system: string;
  /**
   * Large, stable project context from the repository (review F03): source material, not
   * instructions. Redacted and bounded before it gets here; providers that can cache it do.
   */
  context: string;
  /**
   * The repository's revision and recent commits: source material too, but it changes with every
   * commit, so it is sent after the cached context, not inside it (plan M14.8).
   */
  status?: string;
  /** What this call is for: first plan or revision (trusted, after the context). */
  instructions: string;
  /** The per-call request: goal, requirements, plan state and evidence. */
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

/**
 * Whether a failed request was billed (review F04): `yes` the provider answered (a refusal or a
 * cut-off answer still costs its tokens), `no` it rejected the request before processing it,
 * `unknown` the outcome is not known (a timeout or a dropped connection after sending).
 */
export type Billed = 'yes' | 'no' | 'unknown';

export class ModelError extends Error {
  /** Usage the provider reported with an unusable answer. */
  usage?: ModelUsage;
  /** The model that answered, when known. */
  model?: string;
  requestId?: string | null;
  billed: Billed;

  constructor(
    readonly code: ModelErrorCode,
    message: string,
    readonly retryable = false,
    readonly status?: number,
    extra: { usage?: ModelUsage; model?: string; requestId?: string | null; billed?: Billed } = {},
  ) {
    super(message);
    this.name = 'ModelError';
    if (extra.usage) this.usage = extra.usage;
    if (extra.model) this.model = extra.model;
    this.requestId = extra.requestId ?? null;
    this.billed = extra.billed ?? (extra.usage ? 'yes' : 'no');
  }
}

export interface PlannerModel {
  /** `anthropic`, `fake`, … */
  readonly provider: string;
  /** True when requests leave this machine (needs `providers.<name>.allow_remote: true`, plan B28). */
  readonly remote: boolean;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
