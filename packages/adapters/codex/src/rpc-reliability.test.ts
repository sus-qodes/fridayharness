import { describe, expect, it } from 'vitest';
import { JsonRpcLines } from './rpc.js';

describe('reliability audit of app-server shutdown', () => {
  it('rejects pending requests on a broken write and ignores later output', async () => {
    const notified = { count: 0 };
    const rpc = new JsonRpcLines(
      () => {
        throw new Error('EPIPE');
      },
      {
        onNotification: () => {
          notified.count += 1;
        },
        onRequest: async () => null,
      },
    );
    await expect(rpc.request('turn/start', {})).rejects.toThrow(/EPIPE/);
    rpc.feed(JSON.stringify({ method: 'turn/completed', params: {} }));
    expect(notified.count).toBe(0);
    await expect(rpc.request('turn/start', {})).rejects.toThrow(/gone/);
  });
  it('does not write a late approval response to a closed host transport', async () => {
    const writes: string[] = [];
    let answer!: (value: unknown) => void;
    const pending = new Promise<unknown>((r) => {
      answer = r;
    });
    const rpc = new JsonRpcLines((line) => writes.push(line), {
      onNotification: () => undefined,
      onRequest: () => pending,
    });
    rpc.feed(JSON.stringify({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} }));
    rpc.close('the attempt was cancelled');
    answer({ decision: 'accept' });
    await pending;
    await Promise.resolve();
    expect(writes).toEqual([]);
  });
});
