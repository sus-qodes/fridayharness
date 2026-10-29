// A scripted stand-in for the installed Claude Code run headless (`claude -p`, stream-json in and
// out, as checked on 2.1.300). It reads the flags Friday's spawn adapter passes, runs Friday's real
// hook launcher for each tool call as Claude Code runs a settings file's hooks (exec form, input on
// standard input), acts on the decision, and ends the turn with a result whose structured output
// follows the schema it was given. An allowed long command starts a real process that writes to a
// work file, so a test can prove what Friday stopped. It never calls a model.
//
// Environment:
//   FAKE_CLAUDE_SCRIPT  a JSON file: { model?, extraTools?: string[], mcpServers?: string[],
//                       turns: Step[][], resume?: Step[] }
//   FAKE_CLAUDE_LOG     a JSON-lines file of what it was given and what it did
//   FAKE_CLAUDE_WORK    a folder: <task>.work files grow while a long command runs;
//                       session-<id>.json remembers each session, so --resume can find it
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const script = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, 'utf8'));
const logFile = process.env.FAKE_CLAUDE_LOG;
const workDir = process.env.FAKE_CLAUDE_WORK;
mkdirSync(workDir, { recursive: true });
const log = (entry) => logFile && appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);

// ---- flags, as Claude Code parses them -------------------------------------------------------
const argv = process.argv.slice(2);
const flags = {};
const BOOLEAN = new Set([
  '-p',
  '--print',
  '--verbose',
  '--replay-user-messages',
  '--restricted',
  '--strict-mcp-config',
  '--disable-slash-commands',
]);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (BOOLEAN.has(a)) flags[a] = true;
  else if (a.startsWith('-')) {
    flags[a] = argv[i + 1];
    i += 1;
  }
}
log({ args: argv, flags });
const sessionId = flags['--resume'] ?? flags['--session-id'];
const sessionFile = path.join(workDir, `session-${sessionId}.json`);
if (flags['--resume'] && !existsSync(sessionFile)) {
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
  process.exit(1);
}
const session = existsSync(sessionFile)
  ? JSON.parse(readFileSync(sessionFile, 'utf8'))
  : { id: sessionId, task: null, turns: 0 };
const save = () => writeFileSync(sessionFile, JSON.stringify(session));
save();
const settings = flags['--settings'] ? JSON.parse(readFileSync(flags['--settings'], 'utf8')) : {};
const tools = String(flags['--tools'] ?? '')
  .split(',')
  .filter(Boolean);
const cwd = process.cwd();
const model = flags['--model'] ?? script.model ?? 'claude-fake';

const send = (msg) => process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...msg })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let toolSeq = 0;

// ---- hooks: Friday's launcher, run as Claude Code runs a settings file's hooks ----------------
function runHook(event, input, toolName) {
  const groups = settings.hooks?.[event] ?? [];
  const entries = groups
    .filter((g) => !toolName || !g.matcher || g.matcher === '*' || new RegExp(`^(${g.matcher})$`).test(toolName))
    .flatMap((g) => g.hooks ?? []);
  return Promise.all(
    entries.map(
      (h) =>
        new Promise((resolve) => {
          const p = spawn(h.command, h.args ?? [], {
            cwd,
            env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
          let out = '';
          p.stdout.on('data', (d) => {
            out += d;
          });
          const timer = setTimeout(() => p.kill(), (h.timeout ?? 60) * 1000);
          p.on('close', (code) => {
            clearTimeout(timer);
            let json = null;
            try {
              json = out.trim() ? JSON.parse(out) : null;
            } catch {
              json = null;
            }
            resolve({ code, json, onFailure: h.onFailure });
          });
          p.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: path.join(workDir, `${sessionId}.jsonl`), cwd, hook_event_name: event, ...input }));
        }),
    ),
  );
}

/** PreToolUse, as Claude Code applies it with `--permission-prompts none`: anything that would prompt is refused. */
async function decide(toolName, toolInput) {
  const results = await runHook('PreToolUse', { permission_mode: 'default', tool_name: toolName, tool_input: toolInput, tool_use_id: `toolu_${++toolSeq}` }, toolName);
  let decision = null;
  let reason = '';
  for (const r of results) {
    if (r.code !== 0 && r.onFailure === 'block') return { decision: 'deny', reason: 'the PreToolUse hook failed' };
    const out = r.json?.hookSpecificOutput;
    if (out?.permissionDecision) {
      decision = out.permissionDecision;
      reason = out.permissionDecisionReason ?? '';
      if (decision === 'deny') break;
    }
  }
  // No hook allowed it and no prompt can be answered: reads pass, the rest is refused.
  if (decision === null) decision = ['Read', 'Glob', 'Grep'].includes(toolName) ? 'allow' : 'deny';
  if (decision === 'ask') decision = 'deny';
  log({ hook: 'PreToolUse', tool: toolName, input: toolInput, decision, reason });
  return { decision, reason };
}

const WRITER = "setInterval(() => require('node:fs').appendFileSync(process.argv[1], 'x'), 20)";

/** One tool call: the assistant asks for it, the hooks decide, the tool runs or is refused. */
async function tool(name, input, run) {
  const id = `toolu_${toolSeq + 1}`;
  send({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null });
  const { decision, reason } = await decide(name, input);
  if (decision !== 'allow') {
    send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: reason || `Permission to use ${name} has been denied.` }] }, parent_tool_use_id: null });
    return false;
  }
  const output = (await run?.()) ?? '';
  send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: String(output) }] }, parent_tool_use_id: null });
  await runHook('PostToolUse', { permission_mode: 'default', tool_name: name, tool_input: input, tool_response: { success: true } }, name);
  return true;
}

// ---- input: user messages on standard input --------------------------------------------------
const queue = [];
let waiter = null;
let inputClosed = false;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type !== 'user') return;
  queue.push(msg);
  if (waiter) {
    waiter();
    waiter = null;
  }
}).on('close', () => {
  inputClosed = true;
  if (waiter) {
    waiter();
    waiter = null;
  }
});
const nextMessage = async () => {
  while (!queue.length && !inputClosed) await new Promise((r) => { waiter = r; });
  return queue.shift() ?? null;
};
const textOf = (msg) => {
  const c = msg.message?.content;
  return typeof c === 'string' ? c : (c ?? []).map((b) => b.text ?? '').join('\n');
};
const take = (msg) => {
  // `--replay-user-messages`: a message taken into the conversation comes back, with its uuid.
  if (flags['--replay-user-messages']) send({ type: 'user', uuid: msg.uuid, message: msg.message, parent_tool_use_id: null, isReplay: true });
  log({ received_message: textOf(msg) });
};

async function play(steps) {
  const at = (p) => (path.isAbsolute(p) ? p : path.join(cwd, p));
  for (const s of steps) {
    if (s.op === 'write') {
      await tool('Write', { file_path: at(s.path), content: s.text ?? '' }, () => {
        mkdirSync(path.dirname(at(s.path)), { recursive: true });
        writeFileSync(at(s.path), s.text ?? '');
        return `File created successfully at: ${at(s.path)}`;
      });
    } else if (s.op === 'read') {
      await tool('Read', { file_path: at(s.path) }, () => (existsSync(at(s.path)) ? readFileSync(at(s.path), 'utf8') : ''));
    } else if (s.op === 'bash') {
      const shell = process.platform === 'win32' ? 'PowerShell' : 'Bash';
      await tool(shell, { command: s.command, description: s.command }, () => {
        if (s.long) {
          // Real work that only Friday's group can end.
          spawn(process.execPath, ['-e', WRITER, path.join(workDir, `${session.task}.work`)], { stdio: 'ignore' });
          return 'running';
        }
        if (s.write) writeFileSync(at(s.write.path), s.write.text);
        return 'ok';
      });
    } else if (s.op === 'message') {
      send({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: s.text }] }, parent_tool_use_id: null });
    } else if (s.op === 'waitMessage') {
      const msg = await nextMessage();
      if (msg) take(msg);
    } else if (s.op === 'wait') {
      await sleep(s.ms ?? 100);
    } else if (s.op === 'final') {
      const structured = {
        status: s.status ?? 'completed',
        summary: s.summary ?? 'done',
        changed_paths: s.changed_paths ?? [],
        blocked_reason: s.blocked_reason ?? '',
      };
      log({ final: structured });
      send({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 10, total_cost_usd: 0.0012, usage: { input_tokens: 1200, output_tokens: 80 }, result: JSON.stringify(structured), structured_output: structured });
      return;
    } else if (s.op === 'fail') {
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, total_cost_usd: 0, usage: {}, result: s.message ?? 'failed' });
      return;
    } else if (s.op === 'exit') {
      process.exit(s.code ?? 3);
    }
  }
  // A script without a final step leaves the turn running, as a long task does.
  await new Promise(() => {});
}

// ---- the session ------------------------------------------------------------------------------
const first = await nextMessage();
if (!first) process.exit(0);
const text = textOf(first);
const task = /task_[0-9a-z]{26}/i.exec(text)?.[0];
if (task) session.task = task;
const resumed = /Continue the task where you left off/.test(text);
await runHook('SessionStart', { source: flags['--resume'] ? 'resume' : 'startup', model });
send({
  type: 'system',
  subtype: 'init',
  cwd,
  model,
  tools: [...tools, ...(script.extraTools ?? [])],
  mcp_servers: (script.mcpServers ?? []).map((name) => ({ name, status: 'connected' })),
  permissionMode: 'default',
  claude_code_version: '2.1.300',
  apiKeySource: 'none',
});
take(first);
const steps = resumed ? (script.resume ?? []) : (script.turns[session.turns] ?? []);
session.turns += 1;
save();
await play(steps);
// After the result, Claude Code waits for more input; closing it ends the session.
await new Promise((r) => {
  const check = () => (inputClosed ? r() : setTimeout(check, 50));
  check();
});
await runHook('SessionEnd', { reason: 'other' });
process.exit(0);
