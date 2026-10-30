// Scripted classic OpenCode surface. No provider, model SDK or model request exists here.
// With `prompts` in its fixture (the worker lifecycle, plan M14.4), a session takes prompts: each
// prompt runs the next script of `prompts` (shared across servers through the `counter` file), its
// tool calls going through Friday's plugin exactly as A/B's calls do, and its answer becoming the
// session's last assistant message. Without `prompts`, any prompt route is a test failure.
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const controlFile = args[args.indexOf('--fixture') + 1];
const fixture = controlFile && args.includes('--fixture') ? JSON.parse(fs.readFileSync(controlFile, 'utf8')) : {};
if (args.includes('--version')) {
  console.log(fixture.version ?? '1.19.3');
  process.exit(0);
}
const record = (entry) => fs.appendFileSync(fixture.log, JSON.stringify(entry) + '\n');
record({ op: 'environment', env: process.env, args, cwd: process.cwd(), pid: process.pid });
let hooks;
let session;
let timer;
// The worker lifecycle: the session's messages, whether it is busy, and whether it was stopped.
const messages = [];
let working = false;
let aborted = false;
let nextCall = 0;
let missedPolls = 0;
// The tool parts of the answer being written, as OpenCode records them in the session.
let toolParts = [];
const server = createServer(async (req, res) => {
  const reply = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64'))
    return reply(401, { error: 'authentication required' });
  record({ op: 'request', path: req.url, method: req.method });
  if (req.url === '/global/health') return reply(200, { healthy: true, version: fixture.version ?? '1.19.3' });
  if (req.url === '/config') {
    const config = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
    if (!hooks && !fixture.missingPlugin) {
      try {
        if (fixture.failingPlugin) throw Error('fixture plugin failed');
        hooks = await (await import(config.plugin[0])).default({ directory: process.cwd() });
      } catch { record({ op: 'plugin-failed' }); }
    }
    if (fixture.foreignPlugin) config.plugin.push('file:///untrusted-plugin.mjs');
    if (fixture.projectConfig) config.command = { injected: { template: 'project command' } };
    return reply(200, config);
  }
  if (req.url === '/session' && req.method === 'POST') {
    session = { id: fixture.prompts ? `ses_scripted_${process.pid}` : 'ses_scripted', directory: process.cwd() };
    record({ op: 'session-created' });
    if (!fixture.prompts) timer = setInterval(() => void exercise(), 20);
    return reply(200, session);
  }
  if (req.url === '/global/dispose') return reply(200, true);
  if (/^\/session\/[^/]+\/abort$/.test(req.url)) {
    if (fixture.prompts) {
      aborted = true;
      working = false;
      record({ op: 'abort', t: Date.now() });
    }
    return reply(200, true);
  }
  if (fixture.prompts && session) {
    // A host too busy to answer a few polls (the worker must not give the session up for them).
    if (req.url === '/session/status' && missedPolls < (fixture.missPolls ?? 0)) {
      missedPolls += 1;
      return reply(503, { error: 'busy' });
    }
    if (req.url === '/session/status') return reply(200, { [session.id]: { type: working ? 'busy' : 'idle' } });
    if (req.url === `/session/${session.id}/message` && req.method === 'GET') return reply(200, messages);
    if (req.url === `/session/${session.id}/prompt_async` && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw);
      const text = body.parts.map((p) => p.text).join('\n');
      record({ op: 'prompt', text, model: body.model });
      messages.push({ info: { role: 'user', time: { created: Date.now() } }, parts: [{ type: 'text', text }] });
      working = true;
      aborted = false;
      void run(nextScript());
      res.writeHead(204).end();
      return;
    }
  }
  // Any inference route is a test failure, never a fake success.
  record({ op: 'forbidden-endpoint', path: req.url });
  return reply(500, { error: 'model calls are forbidden in A/B' });
});

/** The next prompt's script, counted across every server of the fixture. */
function nextScript() {
  let n = 0;
  if (fixture.counter) {
    n = fs.existsSync(fixture.counter) ? Number(fs.readFileSync(fixture.counter, 'utf8')) : 0;
    fs.writeFileSync(fixture.counter, String(n + 1));
  }
  return fixture.prompts[Math.min(n, fixture.prompts.length - 1)] ?? [];
}

/** One tool call through Friday's plugin; an allowed write is written into the session's folder. */
async function call(c) {
  const input = { tool: c.tool, sessionID: session.id, callID: `call_${process.pid}_${++nextCall}` };
  const output = { args: structuredClone(c.args) };
  try {
    if (!hooks) throw Error('policy plugin missing');
    await hooks['tool.execute.before'](input, output);
    if (aborted) return;
    if (c.tool === 'write' && typeof output.args.filePath === 'string') {
      const file = path.resolve(process.cwd(), output.args.filePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(output.args.content ?? ''));
    }
    toolParts.push({ type: 'tool', callID: input.callID, tool: c.tool, state: { status: 'completed', input: output.args } });
    record({ op: 'tool', id: input.callID, decision: 'allow', args: output.args, t: Date.now() });
  } catch (error) {
    toolParts.push({ type: 'tool', callID: input.callID, tool: c.tool, state: { status: 'error', input: output.args, error: String(error?.message ?? error) } });
    record({ op: 'tool', id: input.callID, decision: 'deny', args: output.args, reason: String(error?.message ?? error), t: Date.now() });
  }
}

async function run(script) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const step of script) {
    if (aborted) return;
    if (step.call) await call(step.call);
    if (step.wait) await sleep(step.wait);
    if (step.loop) {
      while (!aborted) {
        await call(step.loop);
        await sleep(step.loop.everyMs ?? 30);
      }
      return;
    }
    if (step.answer !== undefined) {
      if (aborted) return;
      const now = Date.now();
      messages.push({
        info: {
          role: 'assistant',
          time: { created: now, completed: now },
          modelID: 'qwen-fake',
          providerID: 'friday-local',
          cost: 0,
          tokens: { input: 120, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [...toolParts.splice(0), { type: 'text', text: step.answer }],
      });
    }
  }
  working = false;
}

let busy = false;
async function exercise() {
  if (busy || !fixture.calls || !fs.existsSync(fixture.calls)) return;
  busy = true;
  try {
    const calls = JSON.parse(fs.readFileSync(fixture.calls, 'utf8'));
    fs.unlinkSync(fixture.calls);
    for (const call of calls) {
      const input = { tool: call.tool, sessionID: call.sessionID ?? session.id, callID: call.callID };
      const output = { args: call.args };
      try {
        if (!hooks) throw Error('policy plugin missing');
        await hooks['tool.execute.before'](input, output);
        if (call.mutate) output.args.filePath = call.mutate;
        if (call.effect) fs.writeFileSync(path.join(process.cwd(), call.effect), 'fixture side effect\n');
        record({ op: 'tool', id: call.callID, decision: 'allow', args: output.args });
      } catch (error) {
        record({ op: 'tool', id: call.callID, decision: 'deny', reason: String(error?.message ?? error) });
      }
    }
  } finally { busy = false; }
}
server.listen(0, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + server.address().port));
process.on('SIGTERM', () => { clearInterval(timer); aborted = true; server.close(); });
void pathToFileURL;
