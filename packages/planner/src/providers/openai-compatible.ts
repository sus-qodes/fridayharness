import { repairPrompt } from '../prompts.js';
import { wrapProjectContext } from './anthropic.js';
import { ModelError, type ModelRequest, type ModelResponse, type ModelUsage, type PlannerModel } from './types.js';

/**
 * The Master Brain on a model that runs on this machine (plan M12.1): an OpenAI-compatible
 * chat-completions server such as Ollama or LM Studio, reached only at a loopback address. No
 * key is needed unless the server wants one, nothing leaves the machine, so no consent and no
 * budget applies, and a call costs nothing; its tokens are still recorded.
 */
export interface OpenAICompatibleOptions {
  /** `http://127.0.0.1:<port>/v1`: a literal loopback address, plain http, no credentials in it. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer …` when the server wants a key; never logged. */
  apiKey?: string;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  /** A 7-billion model on a processor takes minutes per answer: default 10 minutes. */
  timeoutMs?: number;
  /** The name Friday records for this provider (default `local`). */
  provider?: string;
}

/** Ollama's OpenAI-compatible endpoint; LM Studio serves at port 1234. */
export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** The most of an answer Friday reads: a plan is tens of kilobytes. */
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;

/**
 * A local model server runs on this machine (as Laya's rule, review F09): plain http to a literal
 * loopback address, with no credentials in the address. A host name may resolve elsewhere, so only
 * addresses are accepted. Checked when the provider is built and again before every request.
 */
export function localEndpoint(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ModelError('unavailable', `providers.local.base_url "${raw}" is not an address`);
  }
  if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== '[::1]') || u.username || u.password) {
    throw new ModelError(
      'unavailable',
      `a local model server must run on this machine, at http://127.0.0.1 or http://[::1]; ${u.protocol}//${u.host} is refused`,
    );
  }
  return u;
}

/** What the server says went wrong, bounded; never the request. */
function serverMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const m =
      typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.error?.message === 'string'
          ? parsed.error.message
          : typeof parsed.message === 'string'
            ? parsed.message
            : text;
    return m.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/**
 * Keywords the grammar engine behind a local server (llama.cpp, under Ollama and LM Studio) does
 * not take, or takes at a cost: a string bound such as `maxLength: 4000` becomes a 4,000-deep
 * repetition that slows every sampled token. Friday validates all of them itself afterwards.
 */
const GRAMMAR_UNSUPPORTED = new Set([
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'default',
  'format',
  '$schema',
]);

/**
 * Adapts a JSON Schema for a local server, which turns it into a grammar: every object closed
 * with `additionalProperties: false`, `pattern`, `minItems` and `maxItems` kept, since a grammar
 * enforces them for free and a small model needs that (checked live on 2026-10-18: a 7-billion
 * model wrote "Backend Subscription Service" as a task key twice when the pattern was not sent),
 * and the keywords above removed. A pattern with a lookaround cannot be a grammar and is removed.
 */
export function localOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(localOutputSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (GRAMMAR_UNSUPPORTED.has(k)) continue;
    if (k === 'pattern' && (typeof v !== 'string' || v.includes('(?'))) continue;
    out[k] =
      k === 'properties' && v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, localOutputSchema(pv)]),
          )
        : localOutputSchema(v);
  }
  if (out.type === 'object' || out.properties) out.additionalProperties = false;
  return out;
}

/** JSON mode gives a JSON object but no shape: the schema goes into the instructions instead. */
export function jsonModeInstructions(schema: unknown): string {
  return `Answer with one JSON object only: no prose, no code fences, nothing before or after it. The object must match this JSON Schema exactly:\n${JSON.stringify(schema)}`;
}

/** A small model may still wrap its JSON in a code fence; the object inside is what counts. */
function unfence(text: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return m?.[1] ?? text;
}

interface ChatCompletion {
  id?: unknown;
  model?: unknown;
  choices?: {
    finish_reason?: unknown;
    message?: { content?: unknown; refusal?: unknown };
  }[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * `prompt_tokens` and `completion_tokens` are what every OpenAI-compatible server reports. A
 * server that reports cached prompt tokens (`prompt_tokens_details.cached_tokens`) has them
 * counted as cache reads and taken out of the fresh input; no local server bills a cache write.
 */
export function usageFrom(u: ChatCompletion['usage']): ModelUsage {
  const cached = num(u?.prompt_tokens_details?.cached_tokens);
  return {
    input_tokens: Math.max(0, num(u?.prompt_tokens) - cached),
    output_tokens: num(u?.completion_tokens),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

export class OpenAICompatiblePlannerModel implements PlannerModel {
  readonly provider: string;
  readonly remote = false;
  readonly #opts: OpenAICompatibleOptions;
  /**
   * Whether the server takes `response_format: json_schema`; unknown until the first answer. A
   * server that refuses it (400) gets JSON mode with the schema in the instructions from then on.
   */
  #jsonSchema: boolean | undefined;

  constructor(opts: OpenAICompatibleOptions) {
    localEndpoint(opts.baseUrl);
    this.#opts = opts;
    this.provider = opts.provider ?? 'local';
  }

  /** What the last answer taught about the server; for tests and status. */
  get jsonSchemaSupported(): boolean | undefined {
    return this.#jsonSchema;
  }

  #body(req: ModelRequest, jsonSchema: boolean): Record<string, unknown> {
    const schema = localOutputSchema(req.schema);
    // Friday's rules, then the repository's text as marked source material, then what this call is
    // for: one system message, since servers differ in how they join several.
    const system = [
      req.system,
      wrapProjectContext(req.context),
      ...(req.status ? [wrapProjectContext(req.status)] : []),
      req.instructions,
    ];
    if (!jsonSchema) system.push(jsonModeInstructions(schema));
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: system.join('\n\n') },
      { role: 'user', content: req.prompt },
    ];
    if (req.repair) {
      messages.push(
        { role: 'assistant', content: req.repair.previous },
        { role: 'user', content: repairPrompt(req.repair.errors) },
      );
    }
    return {
      model: req.model,
      messages,
      max_tokens: req.maxTokens,
      stream: false,
      response_format: jsonSchema
        ? { type: 'json_schema', json_schema: { name: req.schemaName, schema, strict: true } }
        : { type: 'json_object' },
    };
  }

  async #post(url: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const doFetch = this.#opts.fetch ?? fetch;
    try {
      return await doFetch(url, {
        method: 'POST',
        // Never away from this machine: a redirect is refused, not followed (review F09).
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          ...(this.#opts.apiKey ? { authorization: `Bearer ${this.#opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal.aborted) {
        const why = signal.reason as { name?: string } | undefined;
        throw why?.name === 'TimeoutError'
          ? new ModelError(
              'timeout',
              `the local model did not answer within ${Math.round((this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60_000)} minutes`,
              false,
              undefined,
              { billed: 'unknown' },
            )
          : new ModelError('timeout', 'the request was cancelled', false, undefined, { billed: 'unknown' });
      }
      throw new ModelError(
        'network',
        `no model server answers at ${this.#opts.baseUrl}: ${(e as Error).message}; start it (Ollama: "ollama serve") and check providers.local.base_url`,
        true,
      );
    }
  }

  /** Reads a bounded body; anything larger is not a plan. */
  async #text(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ANSWER_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ModelError('no_output', `the answer was larger than ${MAX_ANSWER_BYTES} bytes`, false, undefined, {
          billed: 'yes',
        });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const base = localEndpoint(this.#opts.baseUrl);
    const url = `${base.origin}${base.pathname.replace(/\/$/, '')}/chat/completions`;
    const timeout = AbortSignal.timeout(this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let withSchema = this.#jsonSchema !== false;
    let res = await this.#post(url, this.#body(req, withSchema), abort);
    if (withSchema && res.status === 400) {
      // Older servers take JSON mode but not a schema: the schema goes into the instructions, and
      // Friday's own validation (with the one repair attempt) still decides what is accepted.
      await res.body?.cancel().catch(() => undefined);
      this.#jsonSchema = false;
      withSchema = false;
      res = await this.#post(url, this.#body(req, false), abort);
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => undefined);
      throw new ModelError(
        'unavailable',
        `the local model server answered with a redirect (${res.status}); Friday follows none`,
      );
    }
    const text = await this.#text(res);
    if (!res.ok) {
      const said = serverMessage(text);
      const where = `${base.origin}${base.pathname.replace(/\/$/, '')}`;
      if (res.status === 401 || res.status === 403) {
        throw new ModelError(
          'auth',
          `the local model server rejected the key (${res.status}); set providers.local.api_key_env to the variable that holds the key it wants`,
          false,
          res.status,
        );
      }
      if (res.status === 404) {
        throw new ModelError(
          'bad_request',
          `the server at ${where} has no model "${req.model}" (404: ${said}); pull it, or set master_brain.model to a model it has ("friday doctor" lists them)`,
          false,
          404,
        );
      }
      if (res.status === 429)
        throw new ModelError('rate_limited', `the local model server is busy (429): ${said}`, true, 429);
      if (res.status >= 500)
        throw new ModelError('unavailable', `the local model server failed (${res.status}): ${said}`, true, res.status);
      throw new ModelError(
        'bad_request',
        `the local model server rejected the request (${res.status}): ${said}`,
        false,
        res.status,
      );
    }
    if (withSchema) this.#jsonSchema = true;

    let completion: ChatCompletion;
    try {
      completion = JSON.parse(text) as ChatCompletion;
    } catch {
      throw new ModelError(
        'no_output',
        'the local model server answered with something that is not JSON',
        false,
        undefined,
        {
          billed: 'yes',
        },
      );
    }
    const usage = usageFrom(completion.usage);
    const model = typeof completion.model === 'string' && completion.model ? completion.model : req.model;
    const request_id = typeof completion.id === 'string' && completion.id ? completion.id : null;
    const billed = { usage, model, requestId: request_id, billed: 'yes' as const };
    const choice = completion.choices?.[0];
    const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'stop';
    if (finish === 'content_filter' || (typeof choice?.message?.refusal === 'string' && choice.message.refusal)) {
      throw new ModelError('refused', 'the model declined to plan this goal', false, undefined, billed);
    }
    if (finish === 'length') {
      throw new ModelError(
        'truncated',
        "the answer was cut off (finish_reason length); raise master_brain.max_tokens, or the server's context length",
        false,
        undefined,
        billed,
      );
    }
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ModelError(
        'no_output',
        `the model returned no text (finish_reason ${finish})`,
        false,
        undefined,
        billed,
      );
    }
    let output: unknown;
    try {
      output = JSON.parse(unfence(content));
    } catch {
      output = content; // fails validation and earns the repair attempt
    }
    return { output, model, usage, stop_reason: finish, request_id };
  }
}
