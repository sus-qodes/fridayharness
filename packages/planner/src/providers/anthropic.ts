import Anthropic from '@anthropic-ai/sdk';
import { repairPrompt } from '../prompts.js';
import { ModelError, type ModelRequest, type ModelResponse, type PlannerModel } from './types.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** `master_brain.model: auto`: the most capable model of the current generation (ADR-0013). */
export const DEFAULT_PLANNER_MODEL = 'claude-opus-5-5';

export interface AnthropicPlannerOptions {
  apiKey: string;
  baseURL?: string;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  /** SDK retries for 408, 409, 429, 5xx and connection errors (default 2). */
  maxRetries?: number;
  timeoutMs?: number;
  effort?: Effort;
  /** Prompt-cache lifetime of the project context (default 5 minutes). */
  cacheTtl?: '5m' | '1h';
}

/** Keywords structured outputs rejects or does not enforce; Friday validates them itself afterwards. */
const UNSUPPORTED = new Set([
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'maxItems',
  'default',
  'format',
  '$schema',
]);

/**
 * Adapts a JSON Schema for `output_config.format`: every object closed with
 * `additionalProperties: false`, unsupported keywords removed, `minItems` only when 0 or 1.
 */
export function structuredOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(structuredOutputSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED.has(k)) continue;
    if (k === 'minItems' && typeof v === 'number' && v > 1) continue;
    out[k] =
      k === 'properties' && v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, structuredOutputSchema(pv)]),
          )
        : structuredOutputSchema(v);
  }
  if (out.type === 'object' || out.properties) out.additionalProperties = false;
  return out;
}

function toModelError(e: unknown): ModelError {
  if (e instanceof ModelError) return e;
  if (e instanceof Anthropic.APIUserAbortError) return new ModelError('timeout', 'the request was cancelled');
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ModelError('timeout', 'the request timed out', true);
  if (e instanceof Anthropic.APIConnectionError)
    return new ModelError('network', `could not reach the API: ${e.message}`, true);
  if (e instanceof Anthropic.RateLimitError)
    return new ModelError('rate_limited', 'rate limited (429); try again later', true, 429);
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new ModelError(
      'auth',
      `the API key was rejected (${e.status}); run "friday secrets set anthropic"`,
      false,
      e.status,
    );
  }
  if (e instanceof Anthropic.InternalServerError) {
    return new ModelError(
      e.status === 529 ? 'overloaded' : 'unavailable',
      `the API is ${e.status === 529 ? 'overloaded' : 'unavailable'} (${e.status})`,
      true,
      e.status,
    );
  }
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === 'number' ? e.status : undefined;
    if (status === 402) return new ModelError('auth', 'billing problem on the Anthropic account (402)', false, 402);
    return new ModelError(
      'bad_request',
      `the API rejected the request (${status ?? '?'}): ${e.message}`.slice(0, 500),
      false,
      status,
    );
  }
  return new ModelError('unavailable', (e as Error)?.message ?? String(e));
}

/** Master Brain over the Claude Messages API with structured outputs (ADR-0013). */
export class AnthropicPlannerModel implements PlannerModel {
  readonly provider = 'anthropic';
  readonly remote = true;
  readonly #client: Anthropic;
  readonly #opts: AnthropicPlannerOptions;

  constructor(opts: AnthropicPlannerOptions) {
    this.#opts = opts;
    this.#client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: opts.maxRetries ?? 2,
      timeout: opts.timeoutMs ?? 300_000,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: req.prompt }];
    if (req.repair) {
      messages.push(
        { role: 'assistant', content: req.repair.previous },
        { role: 'user', content: repairPrompt(req.repair.errors) },
      );
    }
    const cache: Anthropic.CacheControlEphemeral =
      this.#opts.cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
    let msg: Anthropic.Message;
    try {
      msg = await this.#client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          // The project context comes first and carries the cache breakpoint, so plan and replan calls share it.
          system: [
            { type: 'text', text: req.context, cache_control: cache },
            { type: 'text', text: req.system },
          ],
          messages,
          output_config: {
            format: { type: 'json_schema', schema: structuredOutputSchema(req.schema) as Record<string, unknown> },
            ...(this.#opts.effort ? { effort: this.#opts.effort } : {}),
          },
        },
        signal ? { signal } : undefined,
      );
    } catch (e) {
      throw toModelError(e);
    }
    if (msg.stop_reason === 'refusal') throw new ModelError('refused', 'the model declined to plan this goal');
    if (msg.stop_reason === 'max_tokens' || msg.stop_reason === 'model_context_window_exceeded') {
      throw new ModelError('truncated', `the answer was cut off (${msg.stop_reason}); raise master_brain.max_tokens`);
    }
    const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
    if (!text) throw new ModelError('no_output', `the model returned no text (stop_reason ${msg.stop_reason})`);
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      output = text; // fails validation and earns the repair attempt
    }
    const u = msg.usage;
    return {
      output,
      model: msg.model,
      usage: {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_write_1h_input_tokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      },
      stop_reason: msg.stop_reason ?? 'end_turn',
      request_id: (msg as { _request_id?: string | null })._request_id ?? null,
    };
  }
}
