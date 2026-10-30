/**
 * The Codex adapter's pure parts (ADR-0032): the JSON-RPC line client, the turn's final message,
 * the usage record a thread's token counts become, and the environment its host gets.
 */
import { describe, expect, it } from 'vitest';
import { codexModelName, routedModelName } from './adapter.js';
import {
  codexHostUsage,
  FINAL_SCHEMA,
  hostEnvironment,
  JsonRpcLines,
  MethodNotFound,
  parseFinal,
  STRICT_FINAL_SCHEMA,
} from './index.js';

describe('JSON-RPC over lines', () => {
  it('matches answers to requests, answers the server, and fails open requests when the server goes', async () => {
    const sent: Record<string, unknown>[] = [];
    const notes: string[] = [];
    const rpc = new JsonRpcLines((line) => sent.push(JSON.parse(line)), {
      onNotification: (m) => notes.push(m),
      onRequest: async (m, p) => {
        if (m === 'item/fileChange/requestApproval')
          return { decision: 'decline', for: (p as { itemId: string }).itemId };
        throw new MethodNotFound(m);
      },
    });
    const a = rpc.request<{ ok: number }>('thread/start', { cwd: '.' });
    const b = rpc.request('turn/start', {});
    expect(sent.map((m) => [m.id, m.method])).toEqual([
      [1, 'thread/start'],
      [2, 'turn/start'],
    ]);
    // Answers arrive in any order; a server request id may be 0.
    rpc.feed(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32600, message: 'no thread' } }));
    rpc.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: 1 } }));
    await expect(a).resolves.toEqual({ ok: 1 });
    await expect(b).rejects.toThrow('no thread');
    rpc.feed(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: {} }));
    rpc.feed(
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'item/fileChange/requestApproval', params: { itemId: 'p1' } }),
    );
    rpc.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'item/permissions/requestApproval', params: {} }));
    rpc.feed('not json: a log line');
    await new Promise((r) => setTimeout(r, 10));
    expect(notes).toEqual(['turn/completed']);
    expect(sent.slice(2)).toEqual([
      { jsonrpc: '2.0', id: 0, result: { decision: 'decline', for: 'p1' } },
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: "item/permissions/requestApproval is not served by Friday's adapter" },
      },
    ]);
    const c = rpc.request('turn/interrupt', {});
    rpc.close('it exited');
    await expect(c).rejects.toThrow(/gone \(it exited\)/);
    await expect(rpc.request('initialize', {})).rejects.toThrow(/gone/);
  });
});

describe('the final message', () => {
  it('reads the output schema, and takes prose as a summary', () => {
    expect(parseFinal(JSON.stringify({ status: 'blocked', summary: 's', blocked_reason: 'needs a key' }))).toEqual({
      status: 'blocked',
      summary: 's',
      blocked_reason: 'needs a key',
    });
    expect(parseFinal('  I changed src/a.ts.  ')).toEqual({
      status: 'completed',
      summary: 'I changed src/a.ts.',
      blocked_reason: '',
    });
    expect(parseFinal(JSON.stringify({ status: 'done' })).status).toBe('completed');
  });

  it('asks only for what Friday cannot read from the worktree (plan M13.4)', () => {
    // Codex's structured output is strict: every field required, nothing else.
    expect(STRICT_FINAL_SCHEMA.required).toEqual(['status', 'summary', 'blocked_reason']);
    expect(STRICT_FINAL_SCHEMA.additionalProperties).toBe(false);
    // A host that refuses an answer that does not fit requires only the status, and takes extra fields.
    expect(FINAL_SCHEMA.required).toEqual(['status']);
    expect('additionalProperties' in FINAL_SCHEMA).toBe(false);
    expect(Object.keys(FINAL_SCHEMA.properties)).not.toContain('changed_paths');
  });

  it("keeps the model's summary and cuts another parameter's markup out of it (CC-35)", () => {
    expect(
      parseFinal({ status: 'completed', summary: 'Added the module.</summary> <parameter name="changed_paths">["a"]' }),
    ).toEqual({ status: 'completed', summary: 'Added the module.', blocked_reason: '' });
    // No summary at all: the session's last text stands in for it.
    expect(parseFinal({ status: 'completed' }, ' I added backend/src/a.ts. ').summary).toBe(
      'I added backend/src/a.ts.',
    );
    // An extra field is ignored, never an error.
    expect(parseFinal({ status: 'completed', summary: 's', changed_paths: ['x'] })).toEqual({
      status: 'completed',
      summary: 's',
      blocked_reason: '',
    });
  });
});

describe('the usage record (plan M11.4)', () => {
  it("reads the thread's last token count into the shape every host's usage is recorded in", () => {
    // The `total` of the sixth and last `thread/tokenUsage/updated` of the recorded live turn
    // (0.162.1, tests/fixtures/codex/v0.162.1/live-adapter-transcript.jsonl): the thread's count so
    // far, in which `inputTokens` holds the whole prompt, the cached part included.
    const total = {
      totalTokens: 64866,
      inputTokens: 64178,
      cachedInputTokens: 39936,
      cacheWriteInputTokens: 0,
      outputTokens: 688,
      reasoningOutputTokens: 70,
    };
    expect(codexHostUsage(total, 1, 'gpt-5.6-luna')).toEqual({
      cost_usd: null,
      input_tokens: 64178,
      output_tokens: 688,
      cache_read_input_tokens: 39936,
      cache_creation_input_tokens: 0,
      turns: 1,
      model: 'gpt-5.6-luna',
    });
    // A host that sent no count: every count unknown, never 0; the turn and the model still known.
    expect(codexHostUsage(null, 1, 'gpt-5.6-luna')).toEqual({
      cost_usd: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      turns: 1,
      model: 'gpt-5.6-luna',
    });
    // A count that is not a finite number is unknown too.
    expect(codexHostUsage({ inputTokens: '12', outputTokens: Number.NaN, cachedInputTokens: 3 }, 2, null)).toEqual({
      cost_usd: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: null,
      turns: 2,
      model: null,
    });
  });
});

describe("the host's environment", () => {
  it("drops Friday's variables and anything that looks like a secret, but keeps Codex's own login", () => {
    const env = hostEnvironment({
      PATH: '/bin',
      FRIDAY_STATE_DIR: '/s',
      friday_agent: 'x',
      GITHUB_TOKEN: 't',
      AWS_SECRET_ACCESS_KEY: 'k',
      DB_PASSWORD: 'p',
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'o',
      CODEX_HOME: '/c',
      HOME: '/home/me',
    });
    expect(Object.keys(env).sort()).toEqual(['CODEX_HOME', 'HOME', 'OPENAI_API_KEY', 'PATH']);
  });
});

describe('model names between the registry and Codex (live check of 2026-10-22)', () => {
  it('sends Codex the bare name and reports the routed one back', () => {
    expect(codexModelName('openai/gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(codexModelName('gpt-5.6-luna')).toBe('gpt-5.6-luna');
    expect(routedModelName('gpt-6.1-sol', 'openai/gpt-6.1-sol')).toBe('openai/gpt-6.1-sol');
    expect(routedModelName('gpt-5.6-luna', 'openai/gpt-6.1-sol')).toBe('gpt-5.6-luna');
    expect(routedModelName('gpt-5.6-luna', null)).toBe('gpt-5.6-luna');
  });
});
