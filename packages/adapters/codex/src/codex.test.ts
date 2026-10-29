/**
 * The Codex adapter's pure parts (ADR-0032): the JSON-RPC line client, the turn's final message,
 * and the environment its host gets.
 */
import { describe, expect, it } from 'vitest';
import { hostEnvironment, JsonRpcLines, MethodNotFound, parseFinal } from './index.js';

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
    expect(
      parseFinal(JSON.stringify({ status: 'blocked', summary: 's', changed_paths: [], blocked_reason: 'needs a key' })),
    ).toEqual({ status: 'blocked', summary: 's', changed_paths: [], blocked_reason: 'needs a key' });
    expect(parseFinal('  I changed src/a.ts.  ')).toEqual({
      status: 'completed',
      summary: 'I changed src/a.ts.',
      changed_paths: [],
      blocked_reason: '',
    });
    expect(parseFinal(JSON.stringify({ status: 'done' })).status).toBe('completed');
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
