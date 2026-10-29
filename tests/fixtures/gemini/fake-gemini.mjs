// A scripted stand-in for Gemini CLI run headless (`gemini -p ... --output-format stream-json`),
// written from 0.64.0's documented behaviour and source (plan M8b.4), never from a run: nothing of
// Gemini CLI is installed here. It reads the flags Friday's spawn adapter passes; it reads
// `.gemini/settings.json` from the folder it starts in, as the host does, and runs each hook's
// command the way the host runs it: a shell string through PowerShell on Windows (bash elsewhere),
// in the session's folder, with `$GEMINI_PROJECT_DIR` and the other variables replaced by quoted
// values, the input on standard input, its answer read from stdout (else stderr). It applies the
// `--policy` deny rules, refuses an untrusted folder without `--skip-trust`, and speaks the
// stream-json events: init, message, tool_use, tool_result, error, result. An allowed long shell
// command starts a real process that writes to a work file, so a test can prove what Friday
// stopped. It starts the MCP servers the settings name and `--allowed-mcp-server-names` allows,
// the system layer's entry winning over the project's (the host's merge order), and calls a tool
// of an HTTP server as an MCP client does. It never calls a model.
//
// Where the host's behaviour is not documented, the stand-in picks one and says so:
// - a hook's "ask" in a headless run: the call fails as the policy's own ask does there;
// - the environment of hooks: passed whole (the host's default); a real host inside GitHub Actions
//   keeps only an allowlist of variables, which this stand-in does not imitate.
//
// Environment:
//   FAKE_GEMINI_SCRIPT  a JSON file: { model?, runs: Step[][] (one list per new session, in order),
//                       resume?: Step[] }
//   FAKE_GEMINI_LOG     a JSON-lines file of what it was given and what it did
//   FAKE_GEMINI_WORK    a folder: <task>.work files grow while a long command runs;
//                       session-<id>.json remembers each session, so --resume can find it
import { spawn, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = JSON.parse(readFileSync(process.env.FAKE_GEMINI_SCRIPT, 'utf8'));
const logFile = process.env.FAKE_GEMINI_LOG;
const workDir = process.env.FAKE_GEMINI_WORK;
mkdirSync(workDir, { recursive: true });
const log = (entry) => logFile && appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
const started = Date.now();

// ---- flags, as Gemini CLI's yargs parses them -------------------------------------------------
const argv = process.argv.slice(2);
const BOOLEAN = new Set(['--skip-trust', '-y', '--yolo', '-d', '--debug', '--sandbox', '-s']);
const ARRAY = new Set(['--policy', '--include-directories', '--allowed-mcp-server-names', '--extensions', '-e']);
const ALIAS = { '-p': '--prompt', '-m': '--model', '-o': '--output-format', '-r': '--resume' };
const flags = {};
for (let i = 0; i < argv.length; i += 1) {
  const raw = argv[i];
  const [name, inline] = raw.startsWith('--') && raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined];
  const a = ALIAS[name] ?? name;
  if (BOOLEAN.has(a)) flags[a] = true;
  else if (ARRAY.has(a)) {
    const v = inline ?? argv[++i] ?? '';
    flags[a] = [...(flags[a] ?? []), ...v.split(',').map((x) => x.trim()).filter(Boolean)];
  } else if (a.startsWith('-')) flags[a] = inline ?? argv[++i];
}
log({ args: argv.map((x) => (x.length > 200 ? `<${x.length} chars>` : x)), flags: { ...flags, '--prompt': flags['--prompt'] ? `<${flags['--prompt'].length} chars>` : undefined } });
const fatal = (code, message) => {
  process.stderr.write(`${message}\n`);
  log({ fatal: code, message });
  process.exit(code);
};
if (flags['--resume'] !== undefined && flags['--session-id'] !== undefined) {
  fatal(1, 'The flags --resume, --session-id, and --session-file are mutually exclusive. Please provide only one.');
}
if (flags['--prompt'] === undefined) fatal(42, 'this stand-in runs headless only (-p)');
const cwd = process.cwd();
const yolo = flags['--approval-mode'] === 'yolo' || flags['--yolo'] === true;

// ---- trust: a headless run in a folder nobody trusted stops at once ---------------------------
if (flags['--skip-trust']) process.env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
if (process.env.GEMINI_CLI_TRUST_WORKSPACE !== 'true') {
  fatal(55, `Gemini CLI is not running in a trusted directory: ${cwd}. Use --skip-trust to trust it for this session.`);
}

// ---- settings: the system, user and project layers (comments allowed) -------------------------
const stripComments = (t) => t.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s ?? '');
const readSettings = (file) => {
  try {
    return existsSync(file) ? JSON.parse(stripComments(readFileSync(file, 'utf8'))) : {};
  } catch {
    return {};
  }
};
const home = process.env.GEMINI_CLI_HOME || os.homedir();
const layers = [
  process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ? readSettings(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) : {},
  readSettings(path.join(home, '.gemini', 'settings.json')),
  readSettings(path.join(cwd, '.gemini', 'settings.json')),
];
const hooksOn = !layers.some((l) => l.hooksConfig?.enabled === false);
const disabledHooks = new Set(layers.flatMap((l) => l.hooksConfig?.disabled ?? []));
const hookGroups = (event) => (hooksOn ? layers.flatMap((l) => l.hooks?.[event] ?? []) : []);
// The host merges `mcpServers` by name with the system layer last: its entry wins.
const [systemLayer, userLayer, projectLayer] = layers;
const servers = Object.assign({}, userLayer.mcpServers ?? {}, projectLayer.mcpServers ?? {}, systemLayer.mcpServers ?? {});
const allowed = flags['--allowed-mcp-server-names'] ?? [];
const started_servers = Object.keys(servers).filter((n) => !allowed.length || allowed.includes(n));
log({
  hooks_on: hooksOn,
  mcp_servers: started_servers,
  system_settings: process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? null,
});

// ---- policy: --policy files replace the user's own; the highest-priority rule that matches a
// tool decides, and a deny keeps it out -------------------------------------------------------
const rules = [];
for (const p of flags['--policy'] ?? []) {
  let text = '';
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    fatal(1, `could not read policy file ${p}`);
  }
  for (const block of text.split(/^\[\[rule\]\]\s*$/m).slice(1)) {
    rules.push({
      tool: /^toolName\s*=\s*"([^"]*)"/m.exec(block)?.[1],
      mcp: /^mcpName\s*=\s*"([^"]*)"/m.exec(block)?.[1],
      decision: /^decision\s*=\s*"([^"]*)"/m.exec(block)?.[1],
      priority: Number(/^priority\s*=\s*(\d+)/m.exec(block)?.[1] ?? 0),
    });
  }
}
rules.sort((a, b) => b.priority - a.priority);
const denied = rules.filter((r) => r.decision === 'deny' && r.tool).map((r) => r.tool);
const like = (pattern, name) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name);
/** `server`: the MCP server of the tool, whose own name a rule with mcpName gives without its prefix. */
const excluded = (name, server) => {
  const hit = rules.find((r) =>
    r.mcp !== undefined
      ? server !== undefined && (r.mcp === '*' || r.mcp === server) && (!r.tool || like(r.tool, name.slice(`mcp_${server}_`.length)))
      : r.tool !== undefined && like(r.tool, name),
  );
  return hit?.decision === 'deny';
};
log({ denied });

// ---- the session -------------------------------------------------------------------------------
const sessionId = flags['--resume'] ?? flags['--session-id'] ?? randomUUID();
const sessionFile = path.join(workDir, `session-${sessionId}.json`);
if (flags['--resume'] !== undefined && !existsSync(sessionFile)) fatal(1, `Error resuming session: no session found with ID ${sessionId}`);
const session = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')) : { id: sessionId, task: null, runs: 0 };
const save = () => writeFileSync(sessionFile, JSON.stringify(session));
const model = flags['--model'] ?? script.model ?? 'gemini-fake-pro';
const transcript = path.join(home, '.gemini', 'tmp', 'fake', 'chats', `session-${sessionId}.json`);

// ---- hooks: each command through the host's shell ---------------------------------------------
function hookShell() {
  if (process.platform !== 'win32') return { exe: 'bash', args: ['-c'], kind: 'bash' };
  const ps = ['-NoProfile', '-NonInteractive', '-Command'];
  const comSpec = process.env.ComSpec ?? process.env.COMSPEC;
  if (comSpec && /(powershell|pwsh)\.exe$/i.test(comSpec)) return { exe: comSpec, args: ps, kind: 'powershell' };
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    if (existsSync(path.join(dir, 'pwsh.exe'))) return { exe: path.join(dir, 'pwsh.exe'), args: ['-NoProfile', '-Command'], kind: 'powershell' };
  }
  return { exe: 'powershell.exe', args: ps, kind: 'powershell' };
}
const shell = hookShell();
const quote = (v) => {
  if (!v) return '';
  if (/^[a-zA-Z0-9\-_.]+$/.test(v)) return v;
  return shell.kind === 'powershell' ? `'${v.replace(/'/g, "''")}'` : `'${v.replace(/'/g, "'\\''")}'`;
};
function commandLine(command) {
  const dir = quote(cwd);
  const line = command
    .replace(/\$GEMINI_PROJECT_DIR/g, () => dir)
    .replace(/\$GEMINI_CWD/g, () => dir)
    .replace(/\$GEMINI_PLANS_DIR/g, () => quote(path.join(home, '.gemini', 'plans')))
    .replace(/\$GEMINI_SESSION_ID/g, () => quote(sessionId))
    .replace(/\$CLAUDE_PROJECT_DIR/g, () => dir);
  return shell.kind === 'powershell' ? `${line}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }` : line;
}

function runOne(hook, input) {
  return new Promise((resolve) => {
    const child = spawn(shell.exe, [...shell.args, commandLine(hook.command)], {
      cwd,
      env: {
        ...process.env,
        GEMINI_PROJECT_DIR: cwd,
        GEMINI_PLANS_DIR: path.join(home, '.gemini', 'plans'),
        GEMINI_CWD: cwd,
        GEMINI_SESSION_ID: sessionId,
        CLAUDE_PROJECT_DIR: cwd,
        ...(hook.env ?? {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /pid ${child.pid} /f /t`, { timeout: 2000, stdio: 'ignore' });
        } catch {}
      } else child.kill('SIGTERM');
    }, hook.timeout ?? 60_000);
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ output: null, code: null, error: 'spawn failed' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // A hook that timed out gives no output, and no output is no decision: the call proceeds.
      if (timedOut) return resolve({ output: null, code, error: 'timed out' });
      const text = stdout.trim() || stderr.trim();
      if (!text) return resolve({ output: null, code });
      try {
        let v = JSON.parse(text);
        if (typeof v === 'string') v = JSON.parse(v);
        return resolve({ output: v && typeof v === 'object' ? v : null, code });
      } catch {
        // Plain text: exit 0 and 1 allow, any other code denies with the text.
        const c = code || 0;
        return resolve({ output: c === 0 || c === 1 ? { decision: 'allow', systemMessage: text } : { decision: 'deny', reason: text }, code });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

async function runHooks(event, extra, toolName) {
  const entries = hookGroups(event)
    .filter((g) => !toolName || !g.matcher || g.matcher === '*' || new RegExp(g.matcher).test(toolName))
    .flatMap((g) => g.hooks ?? [])
    .filter((h) => h?.type === 'command' && !disabledHooks.has(h.name || h.command));
  const input = { session_id: sessionId, transcript_path: transcript, cwd, hook_event_name: event, timestamp: new Date().toISOString(), ...extra };
  const results = await Promise.all(entries.map((h) => runOne(h, input)));
  const outputs = results.map((r) => r.output).filter(Boolean);
  // Any deny wins, then ask, then allow.
  const deny = outputs.find((o) => o.decision === 'deny' || o.decision === 'block');
  const ask = outputs.find((o) => o.decision === 'ask');
  const stop = outputs.find((o) => o.continue === false);
  const context = outputs.map((o) => o.hookSpecificOutput?.additionalContext).filter(Boolean).join('\n');
  log({ hook: event, tool: toolName ?? null, ran: entries.length, outputs, codes: results.map((r) => r.code), errors: results.map((r) => r.error ?? null) });
  return { deny, ask, stop, context, ran: entries.length };
}

// ---- stream-json ---------------------------------------------------------------------------------
const emit = (event) => process.stdout.write(`${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let toolCalls = 0;
/** What the default policy runs without asking; anything else asks unless the approval mode is yolo. */
const READ_ONLY = new Set(['read_file', 'read_many_files', 'glob', 'grep_search', 'list_directory', 'google_web_search']);
const WRITER = "setInterval(() => require('node:fs').appendFileSync(process.argv[1], 'x'), 20)";

/**
 * Calls one tool of an HTTP MCP server the settings name, as an MCP client does (JSON answers):
 * one connection per server for the session, initialized once, as the host keeps it.
 */
const connections = new Map();
async function mcpCall(server, toolName, args) {
  const cfg = servers[server] ?? {};
  if (!cfg.httpUrl) throw new Error(`the MCP server ${server} has no httpUrl`);
  const c = connections.get(server) ?? { sid: null, version: null, tools: null };
  connections.set(server, c);
  const post = async (body) => {
    const res = await fetch(cfg.httpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(cfg.headers ?? {}),
        ...(c.sid ? { 'mcp-session-id': c.sid } : {}),
        ...(c.version ? { 'mcp-protocol-version': c.version } : {}),
      },
      body: JSON.stringify(body),
    });
    c.sid = res.headers.get('mcp-session-id') ?? c.sid;
    const text = await res.text();
    if (res.status >= 400) throw new Error(`the MCP server ${server} answered ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  if (!c.tools) {
    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-gemini', version: '0.64.0' } },
    });
    c.version = init?.result?.protocolVersion ?? null;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    c.tools = (list?.result?.tools ?? []).map((t) => t.name);
  }
  const call = await post({ jsonrpc: '2.0', id: 3 + toolCalls, method: 'tools/call', params: { name: toolName, arguments: args } });
  return { tools: c.tools, result: call?.result ?? call?.error ?? null };
}

/** One tool call: the model asks for it, the hooks decide, the tool runs or is refused. */
async function tool(name, params, run, mcp) {
  toolCalls += 1;
  const id = `${name}-${Date.now()}-${toolCalls}`;
  emit({ type: 'tool_use', tool_name: name, tool_id: id, parameters: params });
  if (excluded(name, mcp?.server_name)) {
    log({ excluded: name });
    emit({ type: 'tool_result', tool_id: id, status: 'error', error: { type: 'TOOL_NOT_REGISTERED', message: `Tool "${name}" not found in registry.` } });
    return false;
  }
  const before = await runHooks('BeforeTool', { tool_name: name, tool_input: params, ...(mcp ? { mcp_context: mcp } : {}) }, name);
  if (before.stop) {
    emit({ type: 'tool_result', tool_id: id, status: 'error', error: { type: 'STOP_EXECUTION', message: `Agent execution stopped by hook: ${before.stop.reason ?? ''}` } });
    return 'stop';
  }
  if (before.deny) {
    const reason = before.deny.reason ?? before.deny.systemMessage ?? 'blocked';
    log({ decision: 'deny', tool: name, reason });
    emit({ type: 'tool_result', tool_id: id, status: 'error', error: { type: 'POLICY_VIOLATION', message: `Tool execution blocked: ${reason}` } });
    return false;
  }
  if (before.ask || (!yolo && !READ_ONLY.has(name))) {
    // Nobody answers a confirmation in a headless run: the policy's own ask fails the call there,
    // and the stand-in reads a hook's ask the same way (undocumented for a hook).
    log({ decision: 'ask', tool: name, reason: before.ask?.reason ?? 'not auto-approved' });
    emit({ type: 'tool_result', tool_id: id, status: 'error', error: { type: 'EXECUTION_FAILED', message: `Tool "${name}" requires user confirmation, which is not supported in non-interactive mode.` } });
    return false;
  }
  log({ decision: 'allow', tool: name });
  let output = '';
  let failure = null;
  try {
    output = String((await run?.()) ?? '');
  } catch (e) {
    failure = String(e?.message ?? e);
  }
  emit(failure ? { type: 'tool_result', tool_id: id, status: 'error', error: { type: 'EXECUTION_FAILED', message: failure } } : { type: 'tool_result', tool_id: id, status: 'success', output });
  await runHooks('AfterTool', { tool_name: name, tool_input: params, tool_response: failure ? { error: failure } : { llmContent: output, returnDisplay: output } }, name);
  return !failure;
}

function stats(step) {
  if (step?.usage === 'none') return { total_tokens: 0, input_tokens: 0, output_tokens: 0, cached: 0, input: 0, duration_ms: Date.now() - started, tool_calls: toolCalls, models: {} };
  const m = { total_tokens: 12_300, input_tokens: 12_000, output_tokens: 300, cached: 8000, input: 4000 };
  return { ...m, duration_ms: Date.now() - started, tool_calls: toolCalls, models: { [model]: m } };
}

async function play(steps, prompt) {
  const at = (p) => (path.isAbsolute(p) ? p : path.join(cwd, p));
  for (const s of steps) {
    let r = true;
    if (s.op === 'write') {
      r = await tool('write_file', { file_path: at(s.path), content: s.text ?? '' }, () => {
        mkdirSync(path.dirname(at(s.path)), { recursive: true });
        writeFileSync(at(s.path), s.text ?? '');
        return `Successfully created and wrote to new file: ${at(s.path)}.`;
      });
    } else if (s.op === 'replace') {
      r = await tool('replace', { file_path: at(s.path), old_string: s.old, new_string: s.new }, () => {
        writeFileSync(at(s.path), readFileSync(at(s.path), 'utf8').replace(s.old, s.new));
        return `Successfully modified file: ${at(s.path)} (1 replacements).`;
      });
    } else if (s.op === 'read') {
      r = await tool('read_file', { file_path: at(s.path) }, () => readFileSync(at(s.path), 'utf8'));
    } else if (s.op === 'shell') {
      r = await tool('run_shell_command', { command: s.command, description: s.command }, () => {
        if (s.long) {
          // Real work that only Friday's group can end.
          spawn(process.execPath, ['-e', WRITER, path.join(workDir, `${session.task}.work`)], { stdio: 'ignore' });
          return 'running in the background';
        }
        return 'ok';
      });
    } else if (s.op === 'tool') {
      r = await tool(s.name, s.input ?? {}, () => 'ok');
    } else if (s.op === 'mcp') {
      // A tool of an MCP server the session started: `mcp_<server>_<tool>`, its context in the hook input.
      const server = s.server ?? 'friday';
      r = await tool(
        `mcp_${server}_${s.tool}`,
        s.input ?? {},
        async () => {
          if (!started_servers.includes(server)) throw new Error(`the MCP server ${server} is not running`);
          const out = await mcpCall(server, s.tool, s.input ?? {});
          log({ mcp: s.tool, server, tools: out.tools, result: out.result });
          return JSON.stringify(out.result);
        },
        { server_name: server, tool_name: s.tool },
      );
    } else if (s.op === 'message') {
      emit({ type: 'message', role: 'assistant', content: s.text, delta: true });
    } else if (s.op === 'wait') {
      await sleep(s.ms ?? 100);
    } else if (s.op === 'error') {
      emit({ type: 'error', severity: s.severity ?? 'warning', message: s.message ?? 'something happened' });
    } else if (s.op === 'final') {
      const answer = JSON.stringify({
        status: s.status ?? 'completed',
        summary: s.summary ?? 'done',
        changed_paths: s.changed_paths ?? [],
        blocked_reason: s.blocked_reason ?? '',
      });
      const text = s.fence ? `Here is the result.\n\`\`\`json\n${answer}\n\`\`\`` : answer;
      // The answer streams in pieces, as the host's content events do.
      const half = Math.floor(text.length / 2);
      emit({ type: 'message', role: 'assistant', content: text.slice(0, half), delta: true });
      emit({ type: 'message', role: 'assistant', content: text.slice(half), delta: true });
      const after = await runHooks('AfterAgent', { prompt, prompt_response: text, stop_hook_active: false });
      if (after.deny) log({ after_agent: 'deny', reason: after.deny.reason ?? '' });
      log({ final: JSON.parse(answer) });
      emit({ type: 'result', status: 'success', stats: stats(s) });
      return true;
    } else if (s.op === 'fail') {
      emit({ type: 'result', status: 'error', error: { type: 'Error', message: s.message ?? 'failed' }, stats: stats(s) });
      return false;
    } else if (s.op === 'exit') {
      process.exit(s.code ?? 1);
    }
    if (r === 'stop') {
      emit({ type: 'result', status: 'success', stats: stats(s) });
      return true;
    }
  }
  // A script without a final step leaves the run going, as a long task does.
  await new Promise(() => {});
}

// Standard input: read when it is not a terminal; a pipe that brings nothing in 500 ms is let go.
async function readStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    let timer = setTimeout(() => done(), 500);
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.pause();
      resolve(data);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      clearTimeout(timer);
      timer = null;
      data += d;
    });
    process.stdin.on('end', done);
  });
}

const stdin = await readStdin();
const prompt = stdin ? `${stdin}\n\n${flags['--prompt']}` : flags['--prompt'];
const resumed = flags['--resume'] !== undefined;
const startHooks = await runHooks('SessionStart', { source: resumed ? 'resume' : 'startup' });
if (startHooks.context) log({ session_context: startHooks.context.slice(0, 200) });
emit({ type: 'init', session_id: sessionId, model });
emit({ type: 'message', role: 'user', content: prompt });
// The task's own id: the one the task line names, else the first in the prompt.
const task = /Task (task_[0-9a-z]{26})/i.exec(prompt)?.[1] ?? /task_[0-9a-z]{26}/i.exec(prompt)?.[0];
if (task) session.task = task;
const steps = resumed ? (script.resume ?? []) : (script.runs?.[session.runs] ?? []);
session.runs += 1;
save();
log({
  received_prompt: prompt.slice(0, 120),
  prompt_chars: prompt.length,
  prompt_names_friday_tools: /friday_[a-z]/.test(prompt),
  resumed,
});
const ok = await play(steps, prompt);
// The host does not wait for SessionEnd; the stand-in gives it a moment so tests see it.
await Promise.race([runHooks('SessionEnd', { reason: 'exit' }), sleep(3000)]);
process.exit(ok ? 0 : 1);
