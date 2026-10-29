// A scripted spawn-mode adapter for the agent launcher's tests (plan M9 §5.9, LESSONS UI-34):
// started by the launcher instead of `friday harness run`, it registers as the agent, prints a
// line, and on its standard input closing disconnects and exits, as `--parent-stdin` does. It
// never starts a real host. Arguments: <daemon url> <bootstrap token file> <project id> <agent key> <role>.
import { readFileSync } from 'node:fs';

const [url, tokenFile, projectId, agentKey, role] = process.argv.slice(2);
const token = readFileSync(tokenFile, 'utf8').trim();

async function rpc(bearer, method, params) {
  const res = await fetch(`${url}/protocol/v1/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: String(Date.now()), method, params: { protocol_version: '1.0', ...params } }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

const reg = await rpc(token, 'harness.register', {
  harness_key: `codex:${projectId}:${agentKey}`,
  vendor: 'codex',
  name: 'Scripted Codex',
  version: '0.0.0-test',
  attach_mode: 'spawn',
  project_id: projectId,
  capabilities: { task_start: true, task_cancel: true },
  agent: { agent_key: agentKey, role },
  enforcement_level: 'L1',
  host: { pid: process.pid },
});
// It prints the bootstrap token it read, as a careless host might: the launcher must redact it.
process.stdout.write(`registered as ${reg.agent_id} using ${token}\n`);

const stop = async () => {
  try {
    await rpc(reg.harness_token, 'harness.disconnect', { reason: 'client_disconnect' });
    process.stdout.write('disconnected\n');
  } catch (e) {
    process.stdout.write(`disconnect failed: ${e.message}\n`);
  }
  process.stdout.write('stopped\n');
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
setInterval(() => rpc(reg.harness_token, 'harness.heartbeat', {}).catch(() => undefined), 1000);
