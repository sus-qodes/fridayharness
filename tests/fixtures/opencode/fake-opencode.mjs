// Scripted classic OpenCode surface. No provider, model SDK or model request exists here.
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
record({ op: 'environment', env: process.env, args, cwd: process.cwd() });
let hooks;
let session;
let timer;
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
    session = { id: 'ses_scripted', directory: process.cwd() };
    record({ op: 'session-created' });
    timer = setInterval(() => void exercise(), 20);
    return reply(200, session);
  }
  if (req.url === '/global/dispose') return reply(200, true);
  if (/^\/session\/[^/]+\/abort$/.test(req.url)) return reply(200, true);
  // Any inference route is a test failure, never a fake success.
  record({ op: 'forbidden-endpoint', path: req.url });
  return reply(500, { error: 'model calls are forbidden in A/B' });
});
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
      } catch {
        record({ op: 'tool', id: call.callID, decision: 'deny' });
      }
    }
  } finally { busy = false; }
}
server.listen(0, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + server.address().port));
process.on('SIGTERM', () => { clearInterval(timer); server.close(); });
void pathToFileURL;
