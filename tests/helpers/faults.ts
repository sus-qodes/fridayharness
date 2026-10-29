/**
 * Controlled faults at the boundary between an adapter and the daemon (review M8, §7): a bootstrap
 * client whose protocol calls pass through rules a test sets. Each rule matches one call and either
 * fails it before it reaches the daemon, loses the daemon's answer after the call was committed,
 * holds it until the test lets it through, or does something first. Nothing is timed: the test
 * decides when each step happens. The harness token the adapter receives keeps the same fetch.
 */
import { DaemonClient } from '@friday/sdk';
import type { TestDaemon } from './daemon.js';

export interface RpcCall {
  method: string;
  params: Record<string, unknown>;
}
type Forward = () => Promise<Response>;
type Act = (call: RpcCall, forward: Forward) => Promise<Response>;

/** A call that never reached the daemon, as `fetch` reports a refused connection. */
export const notDelivered: Act = async () => {
  throw new TypeError('fetch failed (controlled fault: request not delivered)');
};

/** The daemon committed the call; its answer was lost on the way back. */
export const answerLost: Act = async (_call, forward) => {
  await (await forward()).text();
  throw new TypeError('fetch failed (controlled fault: response lost after commit)');
};

/** A gate a test opens when it is ready. */
export function gate(): { promise: Promise<void>; open: () => void; opened: boolean } {
  let open = () => {};
  const g = {
    promise: new Promise<void>((r) => {
      open = r;
    }),
    open: () => {
      g.opened = true;
      open();
    },
    opened: false,
  };
  return g;
}

export function interceptedBootstrap(td: TestDaemon) {
  const rules: { match: (c: RpcCall) => boolean; act: Act; times: number }[] = [];
  const calls: RpcCall[] = [];
  const intercepting: typeof fetch = async (input, init) => {
    const forward = () => fetch(input, init);
    if (!String(input).endsWith('/protocol/v1/rpc') || typeof init?.body !== 'string') return forward();
    let call: RpcCall;
    try {
      const j = JSON.parse(init.body) as { method: string; params?: Record<string, unknown> };
      call = { method: j.method, params: j.params ?? {} };
    } catch {
      return forward();
    }
    calls.push(call);
    const i = rules.findIndex((r) => r.match(call));
    if (i < 0) return forward();
    const rule = rules[i] as (typeof rules)[number];
    rule.times -= 1;
    if (rule.times <= 0) rules.splice(i, 1);
    return rule.act(call, forward);
  };
  const client = new DaemonClient({
    baseUrl: td.url,
    token: td.daemon.tokens.bootstrap,
    tokenClass: 'bootstrap',
    projectId: td.project.project_id,
    fetch: intercepting,
  });
  return {
    client,
    calls,
    /** Applies `act` to the next `times` calls that match (Infinity: until removed). */
    on(match: (c: RpcCall) => boolean, act: Act, times = 1): () => void {
      const rule = { match, act, times };
      rules.push(rule);
      return () => {
        const i = rules.indexOf(rule);
        if (i >= 0) rules.splice(i, 1);
      };
    },
  };
}

/** Matches a protocol method, and optionally its params. */
export const method =
  (name: string, where: (p: Record<string, unknown>) => boolean = () => true) =>
  (c: RpcCall) =>
    c.method === name && where(c.params);
