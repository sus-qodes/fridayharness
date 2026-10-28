// M3.5 spike, live part (approved by the owner 2026-10-14: at most 8 short turns on the ChatGPT
// plan, cheapest model, scratch folder only, no network). Usage: node <this> <scratch-dir> <out-dir>
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const SCRATCH = path.resolve(process.argv[2]);
const OUT = path.resolve(process.argv[3]);
const MODEL = 'gpt-5.6-luna';
const EFFORT = 'low';
const MAX_TURNS = 3; // 5 of the approved 8 were used in the first run
let turnsUsed = 0;

rmSync(SCRATCH, { recursive: true, force: true }); // fresh folder; the first run's is not reused
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(OUT, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: SCRATCH });
writeFileSync(path.join(SCRATCH, 'README.md'), '# Friday M3.5 spike scratch repo\n');
writeFileSync(
  path.join(SCRATCH, 'ticker.js'),
  "// Appends one character every 200 ms; stops by itself after 30 s.\nconst fs = require('fs');\nsetInterval(() => fs.appendFileSync('tick.txt', 'x'), 200);\nsetTimeout(() => process.exit(0), 30000);\n",
);
const transcript = path.join(OUT, 'transcript-2.jsonl');
writeFileSync(transcript, '');
const results = [];
const record = (dir, msg) => appendFileSync(transcript, `${JSON.stringify({ t: Date.now(), dir, msg })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AppServer {
  constructor(name, onServerRequest) {
    this.name = name;
    this.onServerRequest = onServerRequest;
    this.notes = [];
    this.pending = new Map();
    this.nextId = 1;
    this.proc = spawn('codex', ['app-server'], { cwd: SCRATCH, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = '';
    this.proc.stderr.on('data', (d) => {
      this.stderr += d;
    });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      record(`${name}<`, msg);
      if (msg.id !== undefined && msg.method === undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method && msg.id !== undefined) {
        Promise.resolve(this.onServerRequest(msg)).then((result) => this.send({ jsonrpc: '2.0', id: msg.id, result }));
      } else if (msg.method) {
        this.notes.push({ t: Date.now(), method: msg.method, params: msg.params });
      }
    });
  }
  send(msg) {
    record(`${this.name}>`, msg);
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }
  call(method, params, timeoutMs = 30000) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ error: { message: `timeout after ${timeoutMs} ms` } });
        }
      }, timeoutMs);
    });
  }
  async init() {
    const r = await this.call('initialize', {
      clientInfo: { name: 'friday_spike', title: 'Friday M3.5 spike', version: '0.0.1' },
      capabilities: null,
    });
    this.send({ jsonrpc: '2.0', method: 'initialized' });
    return r;
  }
  async waitFor(pred, timeoutMs) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.notes.find(pred);
      if (hit) return hit;
      if (Date.now() > end) return undefined;
      await sleep(100);
    }
  }
  kill() {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(this.proc.pid)], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
}

/** Starts a turn, answers approvals with `decide`, and waits for it to end. */
async function turn(server, threadId, text, opts = {}) {
  if (turnsUsed >= MAX_TURNS) throw new Error('turn budget exhausted');
  turnsUsed += 1;
  const since = Date.now();
  const r = await server.call('turn/start', {
    threadId,
    input: [{ type: 'text', text, text_elements: [] }],
    model: MODEL,
    effort: EFFORT,
  });
  if (r.error) return { error: r.error };
  const turnId = r.result?.turn?.id;
  if (opts.during) await opts.during(turnId);
  const done = await server.waitFor(
    (n) => n.t >= since && n.method === 'turn/completed' && n.params?.turn?.id === turnId,
    opts.timeoutMs ?? 120000,
  );
  const notes = server.notes.filter((n) => n.t >= since);
  const agentText = notes
    .filter((n) => n.method === 'item/completed' && n.params?.item?.type === 'agentMessage')
    .map((n) => n.params.item.text)
    .join('\n');
  return {
    turnId,
    status: done?.params?.turn?.status ?? 'no turn/completed',
    error: done?.params?.turn?.error ?? null,
    agentText,
    reroutes: notes.filter((n) => n.method === 'model/rerouted').map((n) => n.params),
    verifications: notes.filter((n) => n.method === 'model/verification').map((n) => n.params),
    tokenUsage: notes.filter((n) => n.method === 'thread/tokenUsage/updated').at(-1)?.params?.tokenUsage ?? null,
    itemTypes: notes.filter((n) => n.method === 'item/started').map((n) => n.params?.item?.type),
  };
}

const approvals = [];
// Only the harmless ticker may run; everything else is declined, as Friday's policy would.
const decideCommand = (p) => (/ticker.js/.test(String(p.command ?? '')) ? 'accept' : 'decline');
const onServerRequest = (msg) => {
  approvals.push({ method: msg.method, params: msg.params });
  if (msg.method === 'item/commandExecution/requestApproval') return { decision: decideCommand(msg.params) };
  if (msg.method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  if (msg.method === 'item/permissions/requestApproval') return { decision: 'decline' };
  return {};
};
const check = (id, name, pass, evidence) => {
  results.push({ id, name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}: ${JSON.stringify(evidence).slice(0, 700)}`);
};
const a = new AppServer('C', onServerRequest);
try {
  await a.init();
  const start = (sandbox, extra = {}) =>
    a.call('thread/start', {
      cwd: SCRATCH,
      model: MODEL,
      approvalPolicy: 'untrusted',
      sandbox,
      ephemeral: true,
      developerInstructions: 'You are working under Friday. Keep answers short.',
      ...extra,
    });

  // T6: deny a shell command.
  const th6 = (await start('danger-full-access')).result?.thread?.id;
  const b6 = approvals.length;
  const r6 = await turn(
    a,
    th6,
    "Run this exact shell command once: node -e \"require('fs').writeFileSync('cmd.txt','x')\"",
  );
  const asked6 = approvals.slice(b6);
  check(
    'C4',
    'deny a shell command through the approval callback',
    asked6.length > 0 && !existsSync(path.join(SCRATCH, 'cmd.txt')),
    {
      approvals: asked6.map((x) => ({ method: x.method, command: x.params?.command })),
      fileExists: existsSync(path.join(SCRATCH, 'cmd.txt')),
      status: r6.status,
      agentText: r6.agentText.slice(0, 300),
    },
  );

  // T7: cancel an approved long-running command.
  const th7 = (await start('danger-full-access')).result?.thread?.id;
  const tick = path.join(SCRATCH, 'tick.txt');
  const size = () => (existsSync(tick) ? statSync(tick).size : 0);
  let sizes = null;
  const r7 = await turn(
    a,
    th7,
    'Run the command `node ticker.js` and wait until it finishes, then report the size of tick.txt.',
    {
      timeoutMs: 90000,
      during: async (turnId) => {
        const end = Date.now() + 60000;
        while (size() < 5 && Date.now() < end) await sleep(200);
        const atInterrupt = size();
        const ir = await a.call('turn/interrupt', { threadId: th7, turnId });
        await sleep(1000);
        const after1s = size();
        await sleep(3000);
        const after4s = size();
        sizes = { atInterrupt, after1s, after4s, interruptError: ir.error ?? null };
      },
    },
  );
  const stopped = sizes && sizes.atInterrupt >= 5 && sizes.after4s === sizes.after1s;
  check('C5', 'cancel stops the work', r7.status === 'interrupted' && !!stopped, { status: r7.status, sizes });

  // T8: deny a file change (read-only; the model is not told about its sandbox).
  const th8 = (await start('read-only', { config: { include_permissions_instructions: false } })).result?.thread?.id;
  const b8 = approvals.length;
  const r8 = await turn(a, th8, 'Create a file named denied.txt in the current folder containing the word hello.');
  const asked8 = approvals.slice(b8);
  check(
    'C3',
    'deny a file write through the approval callback',
    asked8.length > 0 && !existsSync(path.join(SCRATCH, 'denied.txt')),
    {
      approvals: asked8.map((x) => ({
        method: x.method,
        reason: x.params?.reason ?? null,
        command: x.params?.command ?? null,
      })),
      fileExists: existsSync(path.join(SCRATCH, 'denied.txt')),
      status: r8.status,
      agentText: r8.agentText.slice(0, 300),
    },
  );
} finally {
  a.kill();
  writeFileSync(
    path.join(OUT, 'results-2.json'),
    `${JSON.stringify({ model: MODEL, effort: EFFORT, turnsUsed, results, approvals }, null, 2)}
`,
  );
  console.log(`turns used in this run: ${turnsUsed}`);
  process.exit(0);
}
