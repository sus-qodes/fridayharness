// A scripted stand-in for the Cursor CLI (`agent`) run headless, as Cursor's documentation describes
// it (CLI 2026.10.16 and IDE 3.24, read 2026-10-18; not recorded from a run, see manifest.json):
// `agent create-chat` prints a new chat id; `agent -p --output-format stream-json` prints the
// documented stream-json events (system/init, user, assistant, tool_call started and completed,
// result). It runs the hooks of the workspace's `.cursor/hooks.json` and of every `--plugin-dir`,
// each command through the platform's shell with Cursor's documented input on standard input, and
// applies their answers as the hooks page says (deny beats ask, exit code 2 blocks, a permission
// hook's unreadable answer blocks, `failClosed` blocks on a crash, a timeout or no output). It
// connects to the URL MCP servers of its plugins with the MCP SDK's client and calls Friday's
// (`friday` steps). An allowed long command starts a real process that writes to a work file, so a
// test can prove what Friday stopped. It never calls a model.
//
// What the documentation leaves open, and this stand-in assumes (each item is on the live check of
// docs/integration/cursor.md): hooks run through the platform's shell from the project root (plugin
// hooks from the plugin's folder); a plugin's MCP server keeps its own name (`friday`); print mode
// runs a call no hook objected to and refuses one a hook asked a human about; `{}` from a hook is no
// objection; the result carries `usage` with the names of Cursor's SDK (inputTokens, outputTokens,
// cacheReadTokens, cacheWriteTokens).
//
// Environment:
//   FAKE_CURSOR_SCRIPT  a JSON file: { model?, version?, usage? (the result's usage; null leaves it
//                       out), cwd? (what init reports as its folder), createChatFails?: true,
//                       turns: Step[][], resume?: Step[] }
//   FAKE_CURSOR_LOG     a JSON-lines file of what it was given and what it did
//   FAKE_CURSOR_WORK    a folder: <task>.work files grow while a long command runs;
//                       chat-<id>.json remembers each chat, so --resume can find it
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const script = JSON.parse(readFileSync(process.env.FAKE_CURSOR_SCRIPT, 'utf8'));
const logFile = process.env.FAKE_CURSOR_LOG;
const workDir = process.env.FAKE_CURSOR_WORK;
mkdirSync(workDir, { recursive: true });
const log = (entry) => logFile && appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
const version = script.version ?? '2026.10.16-e3cb207';
const chatFile = (id) => path.join(workDir, `chat-${id}.json`);

// ---- agent create-chat ----------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv[0] === 'create-chat') {
  if (script.createChatFails) {
    process.stderr.write('Authentication required: run agent login\n');
    process.exit(1);
  }
  const id = randomUUID();
  writeFileSync(chatFile(id), JSON.stringify({ id, task: null, turns: 0 }));
  log({ create_chat: id, cwd: process.cwd() });
  process.stdout.write(`${id}\n`);
  process.exit(0);
}

// ---- flags, as the CLI parses them ------------------------------------------------------------------
const BOOLEAN = new Set(['-p', '--print', '--trust', '--approve-mcps', '--force', '--yolo', '--stream-partial-output']);
const flags = {};
const pluginDirs = [];
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (BOOLEAN.has(a)) flags[a] = true;
  else if (a === '--plugin-dir') {
    pluginDirs.push(argv[i + 1]);
    i += 1;
  } else if (a.startsWith('--')) {
    flags[a] = argv[i + 1];
    i += 1;
  } else positional.push(a);
}
const prompt = positional.join(' ');
log({ args: argv.slice(0, -1), flags, plugin_dirs: pluginDirs, prompt });
if (!flags['-p'] && !flags['--print']) {
  process.stderr.write('this stand-in speaks print mode only\n');
  process.exit(1);
}
const workspace = path.resolve(flags['--workspace'] ?? process.cwd());
// Headless runs in a folder Cursor does not trust stop with guidance (CLI changelog, January 2026).
if (!flags['--trust'] && !flags['--force'] && !flags['--yolo']) {
  process.stderr.write('Workspace Trust Required: pass --trust to trust this folder in headless mode\n');
  process.exit(1);
}
const chatId = flags['--resume'] ?? randomUUID();
if (flags['--resume'] && !existsSync(chatFile(chatId))) {
  process.stderr.write(`No chat found with id ${chatId}\n`);
  process.exit(1);
}
const chat = existsSync(chatFile(chatId))
  ? JSON.parse(readFileSync(chatFile(chatId), 'utf8'))
  : { id: chatId, task: null, turns: 0 };
const save = () => writeFileSync(chatFile(chatId), JSON.stringify(chat));
const model = flags['--model'] ?? script.model ?? 'Fake Model 1';

const send = (msg) => process.stdout.write(`${JSON.stringify({ ...msg, session_id: chatId })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

// ---- hooks: the workspace's and every plugin's, all of them run ---------------------------------
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const sources = [
  { source: 'project', cwd: workspace, file: path.join(workspace, '.cursor', 'hooks.json') },
  ...pluginDirs.map((d) => ({ source: 'plugin', cwd: d, file: path.join(d, 'hooks', 'hooks.json') })),
];
const hookSets = sources.map((s) => ({ ...s, hooks: readJson(s.file)?.hooks ?? {} }));
log({ hooks: hookSets.map((s) => ({ source: s.source, events: Object.keys(s.hooks) })) });

const PERMISSION = new Set(['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile']);
const ASKING = new Set(['beforeShellExecution', 'beforeMCPExecution']);

function runOne(entry, cwd, input) {
  return new Promise((resolve) => {
    const p = spawn(entry.command, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        CURSOR_PROJECT_DIR: workspace,
        CURSOR_VERSION: '3.24.0',
        CLAUDE_PROJECT_DIR: workspace,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', () => {});
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, (entry.timeout ?? 30) * 1000);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), timedOut, failClosed: entry.failClosed === true });
    });
    p.stdin.end(JSON.stringify(input));
  });
}

/** Runs every hook for `event`; for a permission hook, answers allow, deny or ask as Cursor combines them. */
async function hook(event, fields, toolName) {
  const input = {
    conversation_id: chatId,
    generation_id: `gen_${seq}`,
    model,
    model_id: model,
    hook_event_name: event,
    cursor_version: '3.24.0',
    workspace_roots: [workspace],
    user_email: 'someone@example.invalid',
    transcript_path: path.join(workDir, `${chatId}.jsonl`),
    ...fields,
  };
  const runs = [];
  for (const s of hookSets) {
    for (const entry of s.hooks[event] ?? []) {
      if (entry.matcher && toolName && !new RegExp(entry.matcher).test(toolName)) continue;
      const r = await runOne(entry, s.cwd, input);
      runs.push({ source: s.source, ...r });
    }
  }
  if (!PERMISSION.has(event)) {
    log({ hook: event, sources: runs.map((r) => r.source), out: runs.map((r) => r.out) });
    return { decision: 'allow', reason: '', runs, json: runs.map((r) => safeJson(r.out)) };
  }
  let decision = 'allow';
  let reason = '';
  for (const r of runs) {
    let d = null;
    if (r.timedOut || (r.code !== 0 && r.code !== 2) || (r.code === 0 && !r.out)) {
      // A hook that failed: blocks only with failClosed, otherwise the call goes on.
      if (r.failClosed) d = 'deny';
    } else if (r.code === 2) d = 'deny';
    else {
      const j = safeJson(r.out);
      if (!j || typeof j !== 'object') d = 'deny';
      else if (j.permission === 'deny') d = 'deny';
      else if (j.permission === 'ask') d = ASKING.has(event) ? 'ask' : null;
    }
    const j = safeJson(r.out);
    if (d === 'deny') {
      decision = 'deny';
      reason = j?.agent_message ?? j?.user_message ?? `the ${event} hook blocked it`;
    } else if (d === 'ask' && decision !== 'deny') {
      decision = 'ask';
      reason = j?.agent_message ?? '';
    }
  }
  // Nobody answers a prompt in print mode: a call a hook asked a human about does not run.
  const final = decision === 'ask' ? 'deny' : decision;
  log({ hook: event, tool: toolName ?? null, input: fields, decision: final, asked: decision === 'ask', reason, sources: runs.map((r) => r.source) });
  return { decision: final, reason };
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ---- MCP servers: the URL servers of the plugins, connected as Cursor connects them ---------------
const mcp = {};
for (const d of pluginDirs) {
  const config = readJson(path.join(d, 'mcp.json')) ?? {};
  for (const [name, cfg] of Object.entries(config.mcpServers ?? {})) {
    if (!cfg?.url) continue;
    const client = new Client({ name: 'fake-cursor', version });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers ?? {} } }));
      mcp[name] = { client, tools: (await client.listTools()).tools.map((t) => t.name) };
    } catch (e) {
      mcp[name] = { client: null, tools: [], error: String(e) };
    }
  }
}
const projectMcp = Object.keys(readJson(path.join(workspace, '.cursor', 'mcp.json'))?.mcpServers ?? {});
log({ mcp: Object.fromEntries(Object.entries(mcp).map(([k, v]) => [k, v.error ?? v.tools])), project_mcp: projectMcp });

// ---- tools --------------------------------------------------------------------------------------------
const WRITER = "setInterval(() => require('node:fs').appendFileSync(process.argv[1], 'x'), 20)";
const at = (p) => (path.isAbsolute(p) ? p : path.join(workspace, p));
const texts = [];

/** One tool call: preToolUse, the dedicated hook, the call or its refusal, then the after-hook. */
async function tool(kind, name, input, dedicated, run) {
  seq += 1;
  const id = `tool_${seq}`;
  const call = kind === 'function' ? { function: { name, arguments: JSON.stringify(input) } } : { [kind]: { args: input } };
  send({ type: 'tool_call', subtype: 'started', call_id: id, tool_call: call });
  const pre = await hook('preToolUse', { tool_name: name, tool_input: input, tool_use_id: id, cwd: workspace, agent_message: '' }, name);
  let refused = pre.decision === 'deny' ? pre : null;
  if (!refused && dedicated) {
    const d = await hook(dedicated.event, { ...dedicated.fields, tool_use_id: id }, name);
    if (d.decision === 'deny') refused = d;
  }
  if (refused) {
    send({ type: 'tool_call', subtype: 'completed', call_id: id, tool_call: kind === 'function' ? call : { [kind]: { args: input, result: { error: { message: refused.reason } } } } });
    await hook('postToolUseFailure', { tool_name: name, tool_input: input, tool_use_id: id, cwd: workspace, error_message: refused.reason, failure_type: 'permission_denied', is_interrupt: false }, name);
    return false;
  }
  const result = (await run?.()) ?? {};
  send({ type: 'tool_call', subtype: 'completed', call_id: id, tool_call: kind === 'function' ? call : { [kind]: { args: input, result: { success: result } } } });
  await hook('postToolUse', { tool_name: name, tool_input: input, tool_use_id: id, cwd: workspace, tool_output: JSON.stringify(result).slice(0, 2000), duration: 1 }, name);
  return true;
}

async function play(steps) {
  for (const s of steps) {
    if (s.op === 'write') {
      const file = at(s.path);
      await tool('writeToolCall', 'Write', { path: file, fileText: s.text ?? '', toolCallId: `tool_${seq + 1}` }, null, () => {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, s.text ?? '');
        return { path: file, linesCreated: String(s.text ?? '').split('\n').length, fileSize: Buffer.byteLength(s.text ?? '') };
      });
    } else if (s.op === 'read') {
      const file = at(s.path);
      const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
      await tool('readToolCall', 'Read', { path: file }, { event: 'beforeReadFile', fields: { file_path: file, content, attachments: [] } }, () => ({
        content,
        isEmpty: !content,
        exceededLimit: false,
        totalLines: content.split('\n').length,
        totalChars: content.length,
      }));
    } else if (s.op === 'shell') {
      await tool('function', 'Shell', { command: s.command, working_directory: workspace }, { event: 'beforeShellExecution', fields: { command: s.command, cwd: workspace, sandbox: false } }, () => {
        if (s.long) {
          // Real work that only Friday's group can end.
          spawn(process.execPath, ['-e', WRITER, path.join(workDir, `${chat.task}.work`)], { stdio: 'ignore' });
          return { output: 'running' };
        }
        return { output: 'ok' };
      });
    } else if (s.op === 'friday' || s.op === 'mcp') {
      // An MCP tool: preToolUse names it MCP:<tool>; beforeMCPExecution gives its arguments as a JSON string.
      const server = s.op === 'friday' ? 'friday' : s.server;
      const args = s.args ?? {};
      await tool('function', `MCP:${s.tool}`, args, { event: 'beforeMCPExecution', fields: { tool_name: s.tool, tool_input: JSON.stringify(args), mcp_server_name: server } }, async () => {
        if (!mcp[server]?.client) return { text: 'no such server' };
        const r = await mcp[server].client.callTool({ name: s.tool, arguments: args });
        const text = r.content?.[0]?.text ?? '';
        log({ toolCall: s.tool, server, success: !r.isError, text });
        return { text };
      });
    } else if (s.op === 'message') {
      texts.push(s.text);
      send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: s.text }] } });
    } else if (s.op === 'wait') {
      await sleep(s.ms ?? 100);
    } else if (s.op === 'final') {
      const final = {
        status: s.status ?? 'completed',
        summary: s.summary ?? 'done',
        changed_paths: s.changed_paths ?? [],
        blocked_reason: s.blocked_reason ?? '',
      };
      const text = `${s.prose ? `${s.prose}\n\n` : ''}${JSON.stringify(final)}`;
      texts.push(text);
      send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
      await hook('stop', { status: 'completed', loop_count: 0 });
      log({ final });
      const usage =
        script.usage === null
          ? {}
          : { usage: script.usage ?? { inputTokens: 5200, outputTokens: 140, cacheReadTokens: 3100, cacheWriteTokens: 600 } };
      send({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 12,
        duration_api_ms: 12,
        // The concatenation of every assistant text, as the documentation shows.
        result: texts.join(''),
        request_id: `req_${chat.turns}`,
        ...usage,
      });
      process.exit(0);
    } else if (s.op === 'fail') {
      // On failure the CLI exits non-zero, writes to stderr and prints no result.
      process.stderr.write(`${s.message ?? 'failed'}\n`);
      process.exit(1);
    } else if (s.op === 'exit') {
      process.exit(s.code ?? 3);
    }
  }
  // A script without a final step leaves the run going, as a long task does.
  await new Promise(() => {});
}

// ---- the run --------------------------------------------------------------------------------------
const task = /task_[0-9a-z]{26}/i.exec(prompt)?.[0];
if (task) chat.task = task;
const resumed = /Continue the task where you left off/.test(prompt);
await hook('sessionStart', { session_id: chatId, is_background_agent: false, composer_mode: 'agent' });
send({
  type: 'system',
  subtype: 'init',
  apiKeySource: 'login',
  cwd: script.cwd ?? workspace,
  model,
  permissionMode: 'default',
});
send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
log({ received_message: prompt, turn: chat.turns, resumed });
const steps = resumed ? (script.resume ?? []) : (script.turns[chat.turns] ?? []);
chat.turns += 1;
save();
await play(steps);
