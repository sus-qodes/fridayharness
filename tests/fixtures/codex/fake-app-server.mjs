// A scripted stand-in for `codex app-server` (protocol v2 as recorded in M3.5 against Codex
// 0.162.1). It speaks JSON-RPC over stdio like the real one and plays a script for each turn:
// agent messages, commands and file changes that ask for approval, writes that do not, reroutes,
// questions, delegation, and calls of the client's own tools (`friday`: Friday's tools, review
// M8-R06; "$lastMessageId" in its arguments is the newest message steered in). An approved long command starts a real process that writes to a work
// file, so a test can prove what Friday allowed, declined and stopped. It never calls a model.
// Like the real one, it counts the thread's tokens and tells the client after each model response
// (`thread/tokenUsage/updated`), the last time before the turn ends (plan M11.4).
//
// Environment:
//   FAKE_CODEX_SCRIPT  a JSON file: { model?, multiAgentMode?, turns: Step[][], resume?: Step[],
//                      mcpServers?: string[] (configured MCP servers), keepServers?: true (a host that
//                      leaves them running whatever the thread's config says), approvalPolicy?: string
//                      (a host that applies another policy than the one asked for) }
//   FAKE_CODEX_LOG     a JSON-lines file of everything the client sent, the answers it gave, and the
//                      token counts sent to it ({ tokenUsage: <total> }, one per model response)
//   FAKE_CODEX_WORK    a folder: <task>.work files grow while a long command runs; threads.json
//                      (thread-<id>.json) remembers each thread, so a new app-server can resume it
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const script = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCRIPT, 'utf8'));
const logFile = process.env.FAKE_CODEX_LOG;
const workDir = process.env.FAKE_CODEX_WORK;
mkdirSync(workDir, { recursive: true });
/** One file per thread, so a new app-server can resume a thread another one started. */
const threadFile = (id) => path.join(workDir, `thread-${id}.json`);
const loadThread = (id) => (existsSync(threadFile(id)) ? JSON.parse(readFileSync(threadFile(id), 'utf8')) : null);
const saveThread = (t) => writeFileSync(threadFile(t.id), JSON.stringify(t));
let started = 0;
const log = (entry) => logFile && appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
let nextServerId = 0;
const answers = new Map();
/** A request to the client; resolves with its answer (or { error }). */
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerId++;
    answers.set(id, resolve);
    send({ id, method, params });
  });
const notify = (method, params) => send({ method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steers = [];
let steerWaiter = null;
let item = 0;
/** A tool's arguments, with "$lastMessageId" as the id of the newest message steered in. */
const fill = (v) => {
  if (v === '$lastMessageId') return /message (msg_[0-9a-z]+)/i.exec(steers.at(-1) ?? '')?.[1] ?? '';
  if (Array.isArray(v)) return v.map(fill);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
  return v;
};

const WRAP =
  process.platform === 'win32'
    ? (c) => `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '${c.replace(/'/g, "''")}'`
    : (c) => `/bin/bash -lc '${c.replace(/'/g, "'\\''")}'`;
const WRITER = "setInterval(() => require('node:fs').appendFileSync(process.argv[1], 'x'), 20)";

/** The steps a model response produces an item for; the final message's count follows the message. */
const COUNTED = new Set(['command', 'write', 'message', 'ask', 'delegate', 'friday']);

/**
 * One model response's tokens, told as the real app-server tells them (0.162.1): `last` is the
 * response's own count, `total` the thread's so far, in which `inputTokens` holds the whole prompt,
 * the cached part included. The figures are invented but deterministic: response n of a thread
 * reads 10000 + 200 n input tokens, 9984 of them from the cache after the first, which writes 1024
 * into it, and writes 40 + 10 n output tokens. The thread's file keeps the total, so a thread
 * resumed by a new app-server continues it, as a thread's count would (what a real server counts
 * into a resumed thread's total was not recorded).
 */
function responded(thread, turnId) {
  thread.responses = (thread.responses ?? 0) + 1;
  const n = thread.responses;
  const input = 10000 + 200 * n;
  const output = 40 + 10 * n;
  const last = {
    totalTokens: input + output,
    inputTokens: input,
    cachedInputTokens: n > 1 ? 9984 : 0,
    cacheWriteInputTokens: n === 1 ? 1024 : 0,
    outputTokens: output,
    reasoningOutputTokens: 5 * n,
  };
  const total = { ...(thread.total ?? {}) };
  for (const [k, v] of Object.entries(last)) total[k] = (total[k] ?? 0) + v;
  thread.total = total;
  saveThread(thread);
  notify('thread/tokenUsage/updated', { threadId: thread.id, turnId, tokenUsage: { total, last, modelContextWindow: 258400 } });
  log({ tokenUsage: total });
}

async function play(steps, thread, turnId) {
  const cwd = thread.cwd;
  const at = (p) => (path.isAbsolute(p) ? p : path.join(cwd, p));
  for (const s of steps) {
    if (COUNTED.has(s.op)) responded(thread, turnId);
    if (s.op === 'command') {
      const id = `exec-${++item}`;
      const command = WRAP(s.command);
      notify('item/started', { threadId: thread.id, turnId, item: { type: 'commandExecution', id, command, status: 'inProgress' } });
      const r = await ask('item/commandExecution/requestApproval', {
        kind: 'command',
        threadId: thread.id,
        turnId,
        itemId: id,
        startedAtMs: Date.now(),
        command,
        cwd,
      });
      log({ approval: 'command', command: s.command, answer: r });
      if (r?.decision === 'accept') {
        if (s.long) {
          // Real work that outlives the turn's bookkeeping: only Friday's group can end it.
          spawn(process.execPath, ['-e', WRITER, path.join(workDir, `${thread.task}.work`)], { stdio: 'ignore' });
        } else {
          if (s.write) writeFileSync(at(s.write.path), s.write.text);
          notify('item/completed', { threadId: thread.id, turnId, item: { type: 'commandExecution', id, command, status: 'completed', exitCode: 0 } });
        }
      } else {
        notify('item/completed', { threadId: thread.id, turnId, item: { type: 'commandExecution', id, command, status: 'declined', exitCode: null } });
      }
    } else if (s.op === 'write') {
      const id = `patch-${++item}`;
      const changes = [{ path: at(s.path), kind: { type: 'add' }, diff: '' }];
      notify('item/started', { threadId: thread.id, turnId, item: { type: 'fileChange', id, changes, status: 'inProgress' } });
      let ok = true;
      if (s.ask !== false) {
        const r = await ask('item/fileChange/requestApproval', { threadId: thread.id, turnId, itemId: id, startedAtMs: Date.now() });
        log({ approval: 'fileChange', path: s.path, answer: r });
        ok = r?.decision === 'accept';
      }
      if (ok) {
        mkdirSync(path.dirname(at(s.path)), { recursive: true });
        writeFileSync(at(s.path), s.text ?? '');
      }
      notify('item/completed', { threadId: thread.id, turnId, item: { type: 'fileChange', id, changes, status: ok ? 'completed' : 'declined' } });
    } else if (s.op === 'message') {
      notify('item/completed', { threadId: thread.id, turnId, item: { type: 'agentMessage', id: `msg-${++item}`, text: s.text } });
    } else if (s.op === 'final') {
      const text = JSON.stringify({
        status: s.status ?? 'completed',
        summary: s.summary ?? 'done',
        changed_paths: s.changed_paths ?? [],
        blocked_reason: s.blocked_reason ?? '',
      });
      notify('item/completed', { threadId: thread.id, turnId, item: { type: 'agentMessage', id: `msg-${++item}`, text } });
      // As recorded: the count of the final response follows its message and precedes the turn's end.
      responded(thread, turnId);
      notify('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed', items: [], error: null } });
      return;
    } else if (s.op === 'fail') {
      notify('turn/completed', {
        threadId: thread.id,
        turn: { id: turnId, status: 'failed', items: [], error: { message: s.message ?? 'failed' } },
      });
      return;
    } else if (s.op === 'reroute') {
      notify('model/rerouted', { threadId: thread.id, turnId, fromModel: thread.model, toModel: s.to, reason: 'highRiskCyberActivity' });
    } else if (s.op === 'ask') {
      const r = await ask('item/tool/requestUserInput', {
        threadId: thread.id,
        turnId,
        itemId: `ask-${++item}`,
        isBlocking: true,
        questions: [{ id: 'q1', header: 'Question', question: s.question }],
      });
      log({ userInput: r });
    } else if (s.op === 'delegate') {
      notify('item/started', { threadId: thread.id, turnId, item: { type: 'collabAgentToolCall', id: `collab-${++item}`, tool: 'spawn_agent' } });
    } else if (s.op === 'friday') {
      // One of Friday's tools, which the client serves (dynamic tools, experimental in 0.162.1).
      const r = await ask('item/tool/call', {
        threadId: thread.id,
        turnId,
        callId: `call-${++item}`,
        tool: s.tool,
        namespace: null,
        arguments: fill(s.args ?? {}),
      });
      log({ toolCall: s.tool, success: r?.success ?? null, text: r?.contentItems?.[0]?.text ?? null });
    } else if (s.op === 'waitSteer') {
      // Until the count-th message of the thread has been steered in (the first by default).
      while (steers.length < (s.count ?? 1)) await new Promise((r) => { steerWaiter = r; });
    } else if (s.op === 'wait') {
      await sleep(s.ms ?? 100);
    }
  }
  // A script without a final step leaves the turn running, as a long task does.
}

/** The thread's answer about itself, as `thread/start` and `thread/resume` give it. */
const opened = (t, p) => ({
  thread: { id: t.id },
  model: t.model,
  modelProvider: 'openai',
  cwd: t.cwd,
  approvalPolicy: script.approvalPolicy ?? p.approvalPolicy,
  approvalsReviewer: p.approvalsReviewer,
  // As 0.162.1 reports it: the mode in camel case, the network off unless asked for.
  sandbox: { type: String(p.sandbox ?? 'read-only').replace(/-([a-z])/g, (_, c) => c.toUpperCase()), networkAccess: false },
  serviceTier: p.serviceTier ?? null,
  instructionSources: [],
  multiAgentMode: script.multiAgentMode ?? 'explicitRequestOnly',
});
/** The configured MCP servers the thread's config turned off (`mcp_servers.<name>.enabled = false`). */
const disabledBy = (config) =>
  Object.entries(config?.mcp_servers ?? {})
    .filter(([, v]) => v?.enabled === false)
    .map(([k]) => k);

const handlers = {
  initialize: () => ({ userAgent: `fake_codex/0.162.1 (${process.platform})`, codexHome: workDir }),
  'config/read': () => ({ config: { mcp_servers: Object.fromEntries((script.mcpServers ?? []).map((n) => [n, { command: 'node' }])) } }),
  'thread/start': (p) => {
    const id = `thr-${process.pid}-${++started}`;
    const t = {
      id,
      cwd: p.cwd,
      model: p.model ?? script.model ?? 'gpt-fake',
      task: null,
      turns: 0,
      // The thread's token count so far: how many model responses, and their total.
      responses: 0,
      total: null,
      disabled: disabledBy(p.config),
    };
    saveThread(t);
    return opened(t, p);
  },
  'thread/resume': (p) => {
    const t = loadThread(p.threadId);
    if (!t) throw Object.assign(new Error(`no thread ${p.threadId}`), { code: -32600 });
    t.cwd = p.cwd ?? t.cwd;
    t.disabled = disabledBy(p.config);
    saveThread(t);
    return opened(t, p);
  },
  'mcpServerStatus/list': (p) => {
    const t = loadThread(p.threadId);
    return {
      data: (script.mcpServers ?? []).map((name) => ({
        name,
        runtimeStatus: !script.keepServers && t?.disabled?.includes(name) ? 'disabled' : 'connected',
        tools: {},
        resources: [],
        resourceTemplates: [],
        authStatus: 'unsupported',
      })),
      nextCursor: null,
    };
  },
  'turn/start': (p) => {
    const t = loadThread(p.threadId);
    if (!t) throw Object.assign(new Error(`no thread ${p.threadId}`), { code: -32600 });
    const text = p.input?.[0]?.text ?? '';
    const task = /task_[0-9a-z]{26}/i.exec(text)?.[0];
    if (task) t.task = task;
    const steps = /Continue the task where you left off/.test(text) ? (script.resume ?? []) : (script.turns[t.turns] ?? []);
    t.turns += 1;
    saveThread(t);
    const turnId = `turn-${p.threadId}-${t.turns}`;
    setImmediate(() => void play(steps, t, turnId));
    return { turn: { id: turnId, status: 'inProgress', items: [] } };
  },
  'turn/steer': (p) => {
    steers.push(p.input?.[0]?.text ?? '');
    if (steerWaiter) {
      steerWaiter();
      steerWaiter = null;
    }
    return { turnId: p.expectedTurnId };
  },
  'turn/interrupt': () => ({}),
};

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method && msg.id === undefined) {
    log({ notification: msg.method });
    return;
  }
  if (msg.method) {
    log({ request: msg.method, params: msg.params });
    const h = handlers[msg.method];
    if (!h) return send({ id: msg.id, error: { code: -32601, message: `no ${msg.method}` } });
    try {
      send({ id: msg.id, result: await h(msg.params ?? {}) });
    } catch (e) {
      send({ id: msg.id, error: { code: e.code ?? -32603, message: e.message } });
    }
    return;
  }
  const resolve = answers.get(msg.id);
  if (resolve) {
    answers.delete(msg.id);
    resolve(msg.error ? { error: msg.error } : msg.result);
  }
});
