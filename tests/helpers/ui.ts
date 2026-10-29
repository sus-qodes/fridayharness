import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GenericHarnessClient } from '@friday/adapter-generic';
import type { TaskView, UiLoginCode, UiSession } from '@friday/protocol';
import type { TestWorkspace } from '@friday/test-support';
import { expect } from 'vitest';
import type { TestDaemon } from './daemon.js';
import { decisionOf, postHook, toolHook } from './hooks.js';

/** Helpers for the interface's daemon routes (docs/frontend/PLAN.md §5). */

/** A tiny built bundle: two pages and one asset. */
export function fakeBundle(ws: TestWorkspace): string {
  const dir = path.join(ws.root, 'ui-dist');
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Friday Studio</title>');
  writeFileSync(path.join(dir, 'notch.html'), '<!doctype html><title>Friday Notch</title>');
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  return dir;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, unknown> | null;
}

/** One HTTP request with full control of the bearer token, Origin and body type; no redirects followed. */
export async function raw(
  td: TestDaemon,
  method: string,
  url: string,
  init: { token?: string; origin?: string; body?: string; type?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  const res = await fetch(`${td.url}${url}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.origin ? { origin: init.origin } : {}),
      ...(init.body !== undefined ? { 'content-type': init.type ?? 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json: json as Record<string, unknown> | null };
}

/** The error code of a response, if any. */
export const codeOf = (r: RawResponse) => (r.json?.error as { code?: string } | undefined)?.code;

/** Mints a login code with the operator token; answers the code and the full answer. */
export async function mintCode(td: TestDaemon): Promise<{ code: string; login: UiLoginCode }> {
  const r = await raw(td, 'POST', td.operator.projectPath('/ui/login-codes'), {
    token: td.daemon.tokens.operator,
    body: '{}',
  });
  expect(r.status, r.text).toBe(201);
  const login = r.json as unknown as UiLoginCode;
  const m = /^http:\/\/127\.0\.0\.1:\d+\/ui\/(?:[A-Za-z0-9_-]+\/)?#code=([A-Za-z0-9_-]{43})$/.exec(login.url);
  expect(m, login.url).not.toBeNull();
  return { code: m?.[1] as string, login };
}

/** Signs in through a one-time code; answers the UI session token. */
export async function signIn(td: TestDaemon): Promise<string> {
  const { code } = await mintCode(td);
  const r = await raw(td, 'POST', '/ui/session', { origin: td.url, body: JSON.stringify({ code }) });
  expect(r.status, r.text).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-store');
  return (r.json as unknown as UiSession).token;
}

/** An attached session in the main checkout holding a task, as Claude Code in the VS Code panel. */
export async function attachedSession(
  td: TestDaemon,
  opts: { agentKey?: string; pid?: number; sessionId?: string; summary?: string; kind?: string } = {},
) {
  const dir = td.ws.projectDir;
  const pid = opts.pid ?? 8301;
  const sessionId = opts.sessionId ?? 'sess-ui';
  const agentKey = opts.agentKey ?? 'dev-1';
  const client = new GenericHarnessClient(td.bootstrap, {
    harness_key: `claude-code:${td.project.project_id}:pid:${pid}`,
    vendor: 'claude-code',
    name: 'Claude Code',
    version: '2.1.300',
    adapter_version: '0.1.0',
    attach_mode: 'attach',
    project_id: td.project.project_id,
    capabilities: { hooks: true },
    agent_key: agentKey,
    role: 'developer',
    host: { pid, session_id: sessionId, cwd: dir },
  });
  await client.register();
  const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
  await postHook(
    daemon,
    'SessionStart',
    { session_id: sessionId, cwd: dir, hook_event_name: 'SessionStart', source: 'startup' },
    { claudePid: pid },
  );
  const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary: opts.summary ?? 'change the readme',
    kind: opts.kind ?? 'docs',
    scope: { write: ['**'], read: [] },
    assign_agent_key: agentKey,
  });
  const claimed = await client.claim({ task_id: task.task_id });
  const pre = async (tool: string, input: Record<string, unknown>) => {
    const res = await postHook(
      daemon,
      'PreToolUse',
      toolHook('PreToolUse', tool, input, { projectDir: dir, sessionId }),
      {
        claudePid: pid,
      },
    );
    return decisionOf(res.body.hook_output);
  };
  return { client, task, run_id: claimed.run_id, pre, dir };
}

/** Config that keeps spawned runs in the main checkout, so `task.start` is queued at once. */
export const NO_WORKTREES = 'worktrees:\n  mode: off\n';

/**
 * A spawned agent driven by hand (plan M9 §5.5, §5.6): a spawn-mode harness that registers, takes a
 * task through `task.start`, and is told what to do next through the outbox. `hooks: true` is a host
 * whose every tool call passes Friday's hooks (Claude Code); without it, a host that changes files
 * without asking (Codex), which a pause cannot hold.
 */
export async function spawnedSession(
  td: TestDaemon,
  opts: { agentKey?: string; hooks?: boolean; summary?: string } = {},
) {
  const agentKey = opts.agentKey ?? 'sp-1';
  const client = new GenericHarnessClient(td.bootstrap, {
    harness_key: `generic:${td.project.project_id}:spawn:${agentKey}`,
    vendor: 'generic',
    name: 'Scripted host',
    version: '1.0.0',
    adapter_version: '0.1.0',
    attach_mode: 'spawn',
    project_id: td.project.project_id,
    capabilities: { task_start: true, task_cancel: true, ...(opts.hooks ? { hooks: true } : {}) },
    agent_key: agentKey,
    role: 'developer',
    enforcement_level: 'L1',
    host: { pid: process.pid },
  });
  await client.register();
  const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary: opts.summary ?? 'write the docs',
    kind: 'docs',
    scope: { write: ['**'], read: [] },
    ready: true,
  });
  await td.operator.post(td.operator.projectPath(`/tasks/${task.task_id}/assign`), { agent_key: agentKey });
  const start = await nextMessage(client, 'task.start');
  const acked = await client.ack([{ message_id: start.message_id, accepted: true, session_ref: 'sess-sp-1' }]);
  expect(acked.current).toContain(start.message_id);
  const run_id = String((start.params as { run_id: string }).run_id);
  return { client, task, run_id, start };
}

/** Polls the harness's outbox until a message of this method arrives (at most `ms`). */
export async function nextMessage(client: GenericHarnessClient, method: string, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const got = (await client.poll(200)).find((m) => m.method === method);
    if (got) return got;
  }
  throw new Error(`no ${method} within ${ms} ms`);
}

/** The harness's outbox holds nothing of this method now (polled once, briefly). */
export async function noMessage(client: GenericHarnessClient, method: string, ms = 400): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await client.poll(100)).some((m) => m.method === method)) return false;
  }
  return true;
}
