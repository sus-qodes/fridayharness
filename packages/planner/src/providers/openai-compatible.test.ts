import { describe, expect, it } from 'vitest';
import { runPlanner } from '../model.js';
import { parsePlanDraft } from '../parse.js';
import { PROMPT_VERSIONS } from '../prompts.js';
import { draftJsonSchema, type PlanDraftInput } from '../schemas.js';
import { wrapProjectContext } from './anthropic.js';
import {
  jsonModeInstructions,
  localEndpoint,
  localOutputSchema,
  OpenAICompatiblePlannerModel,
  usageFrom,
} from './openai-compatible.js';
import { ModelError, type ModelRequest } from './types.js';

const task = (key: string, write: string[], depends_on: string[] = []) => ({
  key,
  summary: `Do ${key}`,
  acceptance_criteria: [`${key} works`],
  depends_on,
  scope: { write },
});

const PLAN: PlanDraftInput = {
  objective: 'Add Stripe subscriptions while keeping one-time checkout working',
  constraints: ['keep one-time checkout working'],
  outcomes: ['subscriptions can be created'],
  summary: 'Backend first, then the page.',
  tasks: [task('backend-subscriptions', ['backend/src/billing/**']), task('frontend-subscribe', ['frontend/src/**'])],
};

const req: ModelRequest = {
  purpose: 'plan',
  model: 'qwen2.5:7b',
  system: 'You are the Master Brain.',
  context: 'Repository layout: backend/, frontend/, shared/',
  status: 'HEAD abc1234\nRecent commits:\nabc1234 the checkout',
  instructions: 'Your job now: the first plan.',
  prompt: 'Goal goal_1: add subscriptions',
  schema: draftJsonSchema('plan'),
  schemaName: 'plan',
  maxTokens: 16_000,
};

type Sent = { url: string; body: Record<string, unknown>; headers: Headers; redirect: string | undefined };

/** The ModelError a completion rejects with; a completion that resolves is the test's failure. */
async function fails(completion: Promise<unknown>): Promise<ModelError> {
  try {
    await completion;
  } catch (e) {
    if (e instanceof ModelError) return e;
    throw e;
  }
  throw new Error('the request did not fail');
}

/** A scripted OpenAI-compatible server: each call takes the next answer. */
function server(answers: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const sent: Sent[] = [];
  const queue = [...answers];
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')),
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
    });
    const next = queue.shift();
    if (!next) throw new Error('no scripted answer left');
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  }) as typeof fetch;
  return { sent, fetch: fetchStub };
}

const completion = (content: string | null, extra: Record<string, unknown> = {}, finish = 'stop') => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'qwen2.5:7b',
  choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 3200, completion_tokens: 900 },
  ...extra,
});

/** Readers for a captured request; an absent request reads as empty, so a wrong count fails on the assertion, not a throw. */
const messagesOf = (s: Sent | undefined): { role: string; content: string }[] =>
  (s?.body.messages as { role: string; content: string }[] | undefined) ?? [];
const systemOf = (s: Sent | undefined): string => messagesOf(s)[0]?.content ?? '';
const formatOf = (s: Sent | undefined): { type?: string; json_schema?: { schema?: Record<string, unknown> } } =>
  (s?.body.response_format as { type?: string; json_schema?: { schema?: Record<string, unknown> } } | undefined) ?? {};
const schemaOf = (s: Sent | undefined): Record<string, unknown> => formatOf(s).json_schema?.schema ?? {};

const make = (
  fetchStub: typeof fetch,
  extra: Partial<ConstructorParameters<typeof OpenAICompatiblePlannerModel>[0]> = {},
) => new OpenAICompatiblePlannerModel({ baseUrl: 'http://127.0.0.1:11434/v1', fetch: fetchStub, ...extra });

describe('the loopback rule (review F09)', () => {
  it('accepts plain http to 127.0.0.1 or [::1] and refuses everything else, before any request', () => {
    expect(localEndpoint('http://127.0.0.1:11434/v1').host).toBe('127.0.0.1:11434');
    expect(localEndpoint('http://[::1]:1234/v1').hostname).toBe('[::1]');
    for (const bad of [
      'http://localhost:11434/v1', // portability-allow: localhost
      'http://ollama.example.com/v1',
      'https://127.0.0.1:11434/v1',
      'http://user:pw@127.0.0.1:11434/v1',
      'http://10.0.0.5:11434/v1',
      'not a url',
    ]) {
      const err = (() => {
        try {
          localEndpoint(bad);
          return null;
        } catch (e) {
          return e as ModelError;
        }
      })();
      expect(err, bad).toBeInstanceOf(ModelError);
      expect(err?.code).toBe('unavailable');
      expect(err?.billed).toBe('no');
    }
    const { sent, fetch: f } = server([]);
    expect(() => new OpenAICompatiblePlannerModel({ baseUrl: 'http://example.com/v1', fetch: f })).toThrow(
      /must run on this machine/,
    );
    expect(sent).toHaveLength(0);
  });

  it('refuses a redirect instead of following it', async () => {
    const { sent, fetch: f } = server([{ status: 307, body: '', headers: { location: 'http://127.0.0.1:9/v1' } }]);
    const err = await fails(make(f).complete(req));
    expect(err).toBeInstanceOf(ModelError);
    expect(err.code).toBe('unavailable');
    expect(err.message).toMatch(/redirect \(307\); Friday follows none/);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.redirect).toBe('manual');
  });
});

describe('OpenAI-compatible provider', () => {
  it('sends one chat completion with a JSON schema, the rules then the marked context, and no key unless given', async () => {
    const { sent, fetch: f } = server([{ status: 200, body: completion(JSON.stringify(PLAN)) }]);
    const model = make(f);
    const res = await model.complete(req);
    expect(sent).toHaveLength(1);
    const [call] = sent;
    expect(call?.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(call?.headers.get('authorization')).toBeNull();
    expect(call?.body).toMatchObject({
      model: 'qwen2.5:7b',
      max_tokens: 16_000,
      stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'plan', strict: true } },
      messages: [{ role: 'system' }, { role: 'user', content: req.prompt }],
    });
    const system = systemOf(call);
    expect(system.indexOf(req.system)).toBe(0);
    expect(system).toContain(wrapProjectContext(req.context));
    // The revision follows the stable context, as source material too, before the instructions (plan M14.8).
    expect(system.indexOf('HEAD abc1234')).toBeGreaterThan(system.indexOf(req.context));
    expect(system.indexOf(req.instructions)).toBeGreaterThan(system.indexOf('HEAD abc1234'));
    expect(system.indexOf(req.instructions)).toBeGreaterThan(system.lastIndexOf('</project_context>'));
    expect(system).not.toContain('JSON Schema exactly');
    expect(call?.body.temperature).toBeUndefined();
    const schema = schemaOf(call);
    expect(JSON.stringify(schema)).toContain('"tasks"');
    expect(schema.additionalProperties).toBe(false);
    expect(res).toMatchObject({ output: PLAN, model: 'qwen2.5:7b', stop_reason: 'stop', request_id: 'chatcmpl-1' });
    expect(res.usage).toEqual({
      input_tokens: 3200,
      output_tokens: 900,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(model.jsonSchemaSupported).toBe(true);
    expect(model.remote).toBe(false);
    expect(model.provider).toBe('local');
  });

  it('falls back to JSON mode with the schema in the instructions when the server refuses a schema (400), and remembers', async () => {
    const { sent, fetch: f } = server([
      { status: 400, body: { error: { message: 'response_format.json_schema is not supported' } } },
      { status: 200, body: completion(JSON.stringify(PLAN)) },
      { status: 200, body: completion(JSON.stringify(PLAN)) },
    ]);
    const model = make(f);
    const res = await model.complete(req);
    expect(res.output).toEqual(PLAN);
    expect(sent.map((s) => (s.body.response_format as { type: string }).type)).toEqual(['json_schema', 'json_object']);
    const system = systemOf(sent[1]);
    expect(system).toContain(jsonModeInstructions(schemaOf(sent[0])));
    expect(system).toMatch(/one JSON object only/);
    expect(model.jsonSchemaSupported).toBe(false);
    // The next call goes straight to JSON mode.
    await model.complete(req);
    expect(sent.map((s) => formatOf(s).type)).toEqual(['json_schema', 'json_object', 'json_object']);
  });

  it('turns a repair into an assistant turn followed by the errors', async () => {
    const { sent, fetch: f } = server([{ status: 200, body: completion(JSON.stringify(PLAN)) }]);
    await make(f).complete({ ...req, repair: { previous: '{"tasks":[]}', errors: ['tasks: too few'] } });
    expect(messagesOf(sent[0]).slice(2)).toEqual([
      { role: 'assistant', content: '{"tasks":[]}' },
      { role: 'user', content: expect.stringContaining('tasks: too few') },
    ]);
  });

  it('sends the key as a bearer token only when one is given', async () => {
    const { sent, fetch: f } = server([{ status: 200, body: completion(JSON.stringify(PLAN)) }]);
    await make(f, { apiKey: 'lm-studio-key' }).complete(req);
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer lm-studio-key');
  });

  it('counts cached prompt tokens as cache reads when the server names them, and tokens as 0 when it reports none', () => {
    expect(
      usageFrom({ prompt_tokens: 5000, completion_tokens: 700, prompt_tokens_details: { cached_tokens: 4200 } }),
    ).toEqual({
      input_tokens: 800,
      output_tokens: 700,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 4200,
    });
    expect(usageFrom(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('passes an unparseable or fenced answer on for validation and repair', async () => {
    const { fetch: f } = server([
      { status: 200, body: completion('not json') },
      { status: 200, body: completion(`\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``) },
    ]);
    const model = make(f);
    expect((await model.complete(req)).output).toBe('not json');
    expect((await model.complete(req)).output).toEqual(PLAN);
  });

  it('maps a cut-off answer, a refusal and HTTP errors, keeping usage only for answers the server gave', async () => {
    const cases: Array<[{ status: number; body: unknown }, string, 'yes' | 'no', RegExp]> = [
      [{ status: 200, body: completion('{"objective":', {}, 'length') }, 'truncated', 'yes', /max_tokens/],
      [{ status: 200, body: completion(null, {}, 'content_filter') }, 'refused', 'yes', /declined/],
      [{ status: 200, body: completion('') }, 'no_output', 'yes', /no text/],
      [{ status: 200, body: 'garbage' }, 'no_output', 'yes', /not JSON/],
      [
        { status: 404, body: { error: { message: 'model "qwen2.5:7b" not found, try pulling it first' } } },
        'bad_request',
        'no',
        /has no model "qwen2.5:7b".*friday doctor/,
      ],
      [{ status: 401, body: { error: { message: 'unauthorized' } } }, 'auth', 'no', /api_key_env/],
      [{ status: 429, body: { error: { message: 'busy' } } }, 'rate_limited', 'no', /busy/],
      [{ status: 500, body: { error: 'llama runner crashed' } }, 'unavailable', 'no', /llama runner crashed/],
      [{ status: 422, body: { message: 'bad body' } }, 'bad_request', 'no', /422.*bad body/],
    ];
    for (const [answer, code, billed, message] of cases) {
      const { fetch: f } = server([answer]);
      const model = make(f);
      // JSON mode from the start, so a 4xx is an error and not the schema fallback.
      const err = await fails(model.complete({ ...req, repair: undefined }));
      expect(err, code).toBeInstanceOf(ModelError);
      expect(err.code, code).toBe(code);
      expect(err.billed, code).toBe(billed);
      expect(err.message, code).toMatch(message);
      if (billed === 'yes' && answer.status === 200 && typeof answer.body !== 'string')
        expect(err.usage?.output_tokens, code).toBe(900);
    }
  });

  it('a 400 after the schema fallback is the server rejecting the request, not another fallback', async () => {
    const { sent, fetch: f } = server([
      { status: 400, body: { error: { message: 'no schema' } } },
      { status: 400, body: { error: { message: 'bad request anyway' } } },
    ]);
    const err = await fails(make(f).complete(req));
    expect(err.code).toBe('bad_request');
    expect(err.message).toMatch(/bad request anyway/);
    expect(sent).toHaveLength(2);
  });

  it('reports an unreachable server as a network error that names the address', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as typeof fetch;
    const err = await fails(make(f).complete(req));
    expect(err.code).toBe('network');
    expect(err.message).toMatch(/no model server answers at http:\/\/127\.0\.0\.1:11434\/v1/);
    expect(err.retryable).toBe(true);
  });

  it('times out a model that never answers, with an unknown outcome', async () => {
    const f = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(init.signal?.reason));
      })) as unknown as typeof fetch;
    const err = await fails(make(f, { timeoutMs: 20 }).complete(req));
    expect(err.code).toBe('timeout');
    expect(err.billed).toBe('unknown');
    expect(err.message).toMatch(/did not answer within/);
  });
});

describe('the schema a local server turns into a grammar', () => {
  it('keeps the key and role patterns and the item bounds, drops string and number bounds, closes objects', () => {
    const schema = localOutputSchema(draftJsonSchema('plan')) as Record<string, unknown>;
    const text = JSON.stringify(schema);
    expect(text).toContain('"pattern":"^[a-z0-9][a-z0-9-]{0,47}$"');
    expect(text).toContain('"pattern":"^[a-z][a-z0-9-]{0,31}$"');
    expect(text).toContain('"maxItems"');
    expect(text).not.toMatch(/"(minLength|maxLength|minimum|maximum|format|default|\$schema)"/);
    expect(schema.additionalProperties).toBe(false);
    const tasks = (schema.properties as { tasks: { items: Record<string, unknown> } }).tasks;
    expect(tasks.items.additionalProperties).toBe(false);
  });

  it('drops a pattern with a lookaround, and never mistakes a property name for a keyword', () => {
    expect(localOutputSchema({ type: 'string', pattern: '^(?!bad)[a-z]+$', maxLength: 9 })).toEqual({ type: 'string' });
    expect(localOutputSchema({ type: 'object', properties: { default: { type: 'string', maxLength: 5 } } })).toEqual({
      type: 'object',
      properties: { default: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('is what the request carries, in the schema and in JSON mode alike', async () => {
    const { sent, fetch: f } = server([
      { status: 400, body: { error: { message: 'no schema' } } },
      { status: 200, body: completion(JSON.stringify(PLAN)) },
    ]);
    await make(f).complete(req);
    expect(JSON.stringify(schemaOf(sent[0]))).toContain('"pattern"');
    expect(systemOf(sent[1])).toContain('"pattern":"^[a-z0-9][a-z0-9-]{0,47}$"');
  });
});

describe('a local model through runPlanner', () => {
  const policy = { allowRemote: false, spentTodayUsd: 0, dailyBudgetUsd: 0 };

  it('needs no consent and no budget, costs 0.00, and records its tokens', async () => {
    const { fetch: f } = server([{ status: 200, body: completion(JSON.stringify(PLAN)) }]);
    const out = await runPlanner(make(f), req, parsePlanDraft, policy, { promptVersion: PROMPT_VERSIONS.plan });
    expect(out.ok).toBe(true);
    expect(out.calls).toMatchObject([
      {
        provider: 'local',
        model: 'qwen2.5:7b',
        remote: false,
        status: 'ok',
        cost_usd: 0,
        cost_estimate_usd: null,
        usage: { input_tokens: 3200, output_tokens: 900 },
        request_id: 'chatcmpl-1',
      },
    ]);
  });

  it('gets the one repair attempt after a malformed answer, and the repair costs 0 too', async () => {
    const bad = { ...PLAN, tasks: [task('a', ['x/**'], ['missing'])] };
    const { sent, fetch: f } = server([
      { status: 200, body: completion(JSON.stringify(bad)) },
      { status: 200, body: completion(JSON.stringify(PLAN)) },
    ]);
    const out = await runPlanner(make(f), req, parsePlanDraft, policy, { promptVersion: PROMPT_VERSIONS.plan });
    expect(out.ok).toBe(true);
    expect(out.calls.map((c) => [c.status, c.cost_usd])).toEqual([
      ['invalid', 0],
      ['ok', 0],
    ]);
    const repair = sent[1]?.body.messages as { role: string; content: string }[];
    expect(repair[2]).toMatchObject({ role: 'assistant', content: expect.stringContaining('"missing"') });
    expect(repair[3]?.content).toMatch(/depends on "missing"/);
  });

  it('a timed-out local call is recorded at cost 0, not unknown', async () => {
    const f = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(init.signal?.reason));
      })) as unknown as typeof fetch;
    const out = await runPlanner(make(f, { timeoutMs: 20 }), req, parsePlanDraft, policy, {
      promptVersion: PROMPT_VERSIONS.plan,
    });
    expect(out).toMatchObject({ ok: false, reason: 'provider' });
    expect(out.calls).toMatchObject([{ status: 'error', error_code: 'timeout', cost_usd: 0, cost_estimate_usd: null }]);
  });
});

describe('a schema with alternatives at the top', () => {
  it('closes each branch, never the holder of the alternatives', () => {
    const schema = localOutputSchema({
      type: 'object',
      oneOf: [
        { required: ['status', 'roles'], properties: { status: { const: 'classified' }, roles: { type: 'array' } } },
        {
          required: ['status', 'questions'],
          properties: { status: { const: 'clarification_required' }, questions: { type: 'array' } },
        },
      ],
    }) as { additionalProperties?: boolean; oneOf: { additionalProperties?: boolean }[] };
    expect(schema.additionalProperties).toBeUndefined();
    expect(schema.oneOf.map((b) => b.additionalProperties)).toEqual([false, false]);
  });
});
