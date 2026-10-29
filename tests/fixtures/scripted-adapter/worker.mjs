// A scripted spawn-mode agent for the interface's day-in-the-life test (plan M9 §10.3, LESSONS
// UI-34): started by the agent launcher instead of `friday harness run`, it never starts a real host.
// It registers, and for each task Friday starts it writes one page in the task's worktree, asks
// for a commit and ends its turn waiting for the human; when Friday resumes the same run after the
// decision, it claims the task done. On its standard input closing it disconnects and exits, as
// `--parent-stdin` does.
// Arguments: <daemon url> <bootstrap token file> <project id> <agent key> <role>.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [url, tokenFile, projectId, agentKey, role] = process.argv.slice(2);
const bootstrap = readFileSync(tokenFile, 'utf8').trim();
const PAGE = 'docs/checkout.md';
let seq = 0;

async function rpc(bearer, method, params) {
  const res = await fetch(`${url}/protocol/v1/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `w${++seq}`, method, params: { protocol_version: '1.0', ...params } }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const reg = await rpc(bootstrap, 'harness.register', {
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
const token = reg.harness_token;
const session = `sess-${agentKey}-${process.pid}`;
process.stdout.write(`registered as ${reg.agent_id}\n`);

async function start(p) {
  const file = path.join(p.working_directory, PAGE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '# Checkout\n\nA customer enters a discount code before paying.\n');
  process.stdout.write(`wrote ${PAGE}\n`);
  const asked = await rpc(token, 'permission.request', {
    task_id: p.task_id,
    run_id: p.run_id,
    action_class: 'git.mutate',
    command: 'git commit -m "docs: checkout"',
    justification: 'commit the checkout page',
  });
  process.stdout.write(`asked for a commit: ${asked.status}\n`);
  await rpc(token, 'agent.result', {
    idempotency_key: `blocked-${p.run_id}`,
    task_id: p.task_id,
    run_id: p.run_id,
    status: 'blocked',
    summary: 'waiting for the commit approval',
    blocked_reason: `needs ${asked.approval_id}`,
    changed_paths: [PAGE],
    checks: [],
    notes: [],
  });
}

async function resume(p) {
  process.stdout.write(`resumed: ${p.note ?? ''}\n`);
  await rpc(token, 'agent.result', {
    idempotency_key: `done-${p.run_id}`,
    task_id: p.task_id,
    run_id: p.run_id,
    status: 'completed_claim',
    summary: 'wrote the checkout page',
    changed_paths: [PAGE],
    checks: [],
    notes: [],
  });
  process.stdout.write('claimed done\n');
}

let stopping = false;
async function loop() {
  while (!stopping) {
    let messages = [];
    try {
      messages = (await rpc(token, 'harness.poll', { wait_ms: 1000, max: 10 })).messages;
    } catch (e) {
      process.stdout.write(`poll failed: ${e.message}\n`);
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    for (const m of messages) {
      const acked = await rpc(token, 'harness.ack', { acks: [{ message_id: m.message_id, accepted: true, session_ref: session }] });
      if (!(acked.current ?? []).includes(m.message_id) && m.method !== 'task.cancel') continue;
      try {
        if (m.method === 'task.start') await start(m.params);
        else if (m.method === 'task.resume') await resume(m.params);
      } catch (e) {
        process.stdout.write(`failed: ${e.message}\n`);
      }
    }
  }
}

const stop = async () => {
  if (stopping) return;
  stopping = true;
  try {
    await rpc(token, 'harness.disconnect', { reason: 'client_disconnect' });
  } catch {
    // Friday may already be gone.
  }
  process.stdout.write('stopped\n');
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
setInterval(() => rpc(token, 'harness.heartbeat', {}).catch(() => undefined), 1000);
void loop();
