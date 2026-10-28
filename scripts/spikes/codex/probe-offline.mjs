// M3.5 spike, offline part: talk to `codex app-server` over stdio without starting a turn
// (no model call). Prints what each method returns, trimmed. Usage: node <this> <scratch-cwd>
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const cwd = process.argv[2];
const proc = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
const rl = readline.createInterface({ input: proc.stdout });
const pending = new Map();
const notes = [];
let nextId = 1;
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method) {
    notes.push(msg.method + (msg.id !== undefined ? ' (server request)' : ''));
  }
});
let stderr = '';
proc.stderr.on('data', (d) => {
  stderr += d;
});
const call = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ error: { message: 'timeout' } });
      }
    }, 15000);
  });
const show = (label, r, pick = (x) => x) => {
  const body = r.error ? { error: r.error } : pick(r.result);
  console.log(`== ${label}\n${JSON.stringify(body, null, 1).slice(0, 1500)}`);
};

const init = await call('initialize', {
  clientInfo: { name: 'friday_spike', title: 'Friday M3.5 spike', version: '0.0.1' },
  capabilities: null,
});
show('initialize', init);
proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
show('model/list', await call('model/list', {}), (x) => ({
  count: x?.data?.length,
  models: (x?.data ?? []).map((m) => ({
    id: m.id ?? m.model,
    default: m.isDefault,
    efforts: m.supportedReasoningEfforts?.map?.((e) => e.reasoningEffort ?? e),
  })),
}));
show('permissionProfile/list', await call('permissionProfile/list', {}));
show('hooks/list', await call('hooks/list', { cwds: [cwd] }));
show('windowsSandbox/readiness', await call('windowsSandbox/readiness', {}));
show('configRequirements/read', await call('configRequirements/read', {}));
show('config/read (keys only)', await call('config/read', { includeLayers: false, cwd }), (x) => ({
  keys: Object.keys(x?.config ?? {}),
}));
const started = await call('thread/start', {
  cwd,
  approvalPolicy: 'untrusted',
  sandbox: 'read-only',
  developerInstructions: 'Friday spike: this thread is only started, never run.',
  ephemeral: true,
});
show('thread/start', started, (x) => ({
  thread: x?.thread && { id: x.thread.id, status: x.thread.status, cwd: x.thread.cwd, ephemeral: x.thread.ephemeral },
  model: x?.model,
  modelProvider: x?.modelProvider,
  approvalPolicy: x?.approvalPolicy,
  sandbox: x?.sandbox,
  reasoningEffort: x?.reasoningEffort,
  keys: Object.keys(x ?? {}),
}));
await new Promise((r) => setTimeout(r, 1500));
console.log(`== notifications seen: ${[...new Set(notes)].join(', ')}`);
proc.stdin.end();
proc.kill();
if (stderr.trim()) console.log(`== stderr (first 600 chars)\n${stderr.slice(0, 600)}`);
process.exit(0);
