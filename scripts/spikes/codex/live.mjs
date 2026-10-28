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
const MAX_TURNS = 8;
let turnsUsed = 0;

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(OUT, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: SCRATCH });
writeFileSync(path.join(SCRATCH, 'README.md'), '# Friday M3.5 spike scratch repo\n');
writeFileSync(
  path.join(SCRATCH, 'ticker.js'),
  "// Appends one character every 200 ms; stops by itself after 30 s.\nconst fs = require('fs');\nsetInterval(() => fs.appendFileSync('tick.txt', 'x'), 200);\nsetTimeout(() => process.exit(0), 30000);\n",
);
const transcript = path.join(OUT, 'transcript.jsonl');
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
let decideCommand = () => 'decline';
let decideFile = () => 'decline';
const onServerRequest = (msg) => {
  approvals.push({ method: msg.method, params: msg.params });
  if (msg.method === 'item/commandExecution/requestApproval') return { decision: decideCommand(msg.params) };
  if (msg.method === 'item/fileChange/requestApproval') return { decision: decideFile(msg.params) };
  if (msg.method === 'item/permissions/requestApproval') return { decision: 'decline' };
  return {};
};
const check = (id, name, pass, evidence) => {
  results.push({ id, name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}: ${JSON.stringify(evidence).slice(0, 600)}`);
};

let a = new AppServer('A', onServerRequest);
try {
  const init = await a.init();
  check('C1', 'register (initialize)', !init.error, { userAgent: init.result?.userAgent });

  // Thread 1: read-only sandbox, approval for anything untrusted, Friday context in the instructions.
  const t1 = await a.call('thread/start', {
    cwd: SCRATCH,
    model: MODEL,
    approvalPolicy: 'untrusted',
    sandbox: 'read-only',
    developerInstructions:
      'You are working under Friday, a coordinator. Your Friday task is task_SPIKE01. Friday context token: FRIDAY-CTX-7731. Keep answers short.',
    ephemeral: false,
  });
  const thread1 = t1.result?.thread?.id;
  check('C0', 'thread started without a model call', !!thread1, {
    model: t1.result?.model,
    provider: t1.result?.modelProvider,
    sandbox: t1.result?.sandbox,
    approvalPolicy: t1.result?.approvalPolicy,
  });

  // T1: the task is accepted and the context arrived.
  const r1 = await turn(
    a,
    thread1,
    'Reply with exactly your Friday task id and the Friday context token, separated by one space. Do not run any commands or edit files.',
  );
  check(
    'C2',
    'accept a task and deliver context',
    r1.status === 'completed' && /task_SPIKE01/.test(r1.agentText) && /FRIDAY-CTX-7731/.test(r1.agentText),
    r1,
  );

  // T2: a file change is asked for, declined, and nothing is written.
  decideFile = () => 'decline';
  decideCommand = () => 'decline';
  const before2 = approvals.length;
  const r2 = await turn(
    a,
    thread1,
    'Create a file named denied.txt in the current folder containing the word hello. Use your file editing tool. If you are not allowed, say so and stop.',
  );
  const asked2 = approvals.slice(before2).map((x) => x.method);
  check(
    'C3',
    'deny a file write through the approval callback',
    asked2.length > 0 && !existsSync(path.join(SCRATCH, 'denied.txt')),
    {
      approvalsAsked: asked2,
      fileExists: existsSync(path.join(SCRATCH, 'denied.txt')),
      status: r2.status,
      agentText: r2.agentText.slice(0, 300),
    },
  );

  // T3: a shell command is asked for, declined, and nothing runs.
  const before3 = approvals.length;
  const r3 = await turn(
    a,
    thread1,
    "Run this exact shell command once: node -e \"require('fs').writeFileSync('cmd.txt','x')\" . If it is not allowed, say so and stop.",
  );
  const asked3 = approvals.slice(before3);
  check(
    'C4',
    'deny a shell command through the approval callback',
    asked3.length > 0 && !existsSync(path.join(SCRATCH, 'cmd.txt')),
    {
      approvalsAsked: asked3.map((x) => ({
        method: x.method,
        command: x.params?.command ?? x.params?.parsedCmd ?? null,
      })),
      fileExists: existsSync(path.join(SCRATCH, 'cmd.txt')),
      status: r3.status,
      agentText: r3.agentText.slice(0, 300),
    },
  );

  // T4: an approved long-running command is cancelled mid-turn; does the work really stop?
  const t2 = await a.call('thread/start', {
    cwd: SCRATCH,
    model: MODEL,
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    developerInstructions: 'You are working under Friday. Keep answers short.',
    ephemeral: true,
  });
  const thread2 = t2.result?.thread?.id;
  decideCommand = () => 'accept';
  const tick = path.join(SCRATCH, 'tick.txt');
  const size = () => (existsSync(tick) ? statSync(tick).size : 0);
  let sizes = null;
  const r4 = await turn(
    a,
    thread2,
    'Run the command `node ticker.js` and wait until it finishes, then report the size of tick.txt.',
    {
      timeoutMs: 60000,
      during: async (turnId) => {
        const end = Date.now() + 60000;
        while (size() < 5 && Date.now() < end) await sleep(200);
        const atInterrupt = size();
        const ir = await a.call('turn/interrupt', { threadId: thread2, turnId });
        await sleep(1000);
        const after1s = size();
        await sleep(2000);
        const after3s = size();
        sizes = { atInterrupt, after1s, after3s, interruptError: ir.error ?? null };
      },
    },
  );
  decideCommand = () => 'decline';
  const stopped = sizes && sizes.atInterrupt >= 5 && sizes.after3s === sizes.after1s;
  check('C5', 'cancel stops the work', r4.status === 'interrupted' && !!stopped, {
    status: r4.status,
    sizes,
    processExited: a.notes.some((n) => n.method === 'process/exited'),
  });

  // T5: the app-server dies; a new one resumes thread 1 with its history.
  a.kill();
  await sleep(1500);
  a = new AppServer('B', onServerRequest);
  await a.init();
  const resumed = await a.call('thread/resume', { threadId: thread1, model: MODEL });
  const r5 = await turn(
    a,
    thread1,
    'What Friday context token were you given at the start? Reply with the token only.',
  );
  check('C6', 'resume after the host process died', !resumed.error && /FRIDAY-CTX-7731/.test(r5.agentText), {
    resumeError: resumed.error ?? null,
    resumedModel: resumed.result?.model,
    status: r5.status,
    agentText: r5.agentText.slice(0, 200),
  });

  // The model that ran: Codex reports the configured model and notifies a server-side reroute.
  const reroutes = [r1, r2, r3, r4, r5].flatMap((r) => r.reroutes ?? []);
  check('C7', 'observe the model that ran', reroutes.length === 0 && t1.result?.model === MODEL, {
    configured: t1.result?.model,
    resumed: resumed.result?.model,
    reroutes,
    tokenUsage: [r1, r2, r3, r4, r5].map((r) => r.tokenUsage?.last ?? r.tokenUsage ?? null),
  });
} finally {
  a.kill();
  writeFileSync(
    path.join(OUT, 'results.json'),
    `${JSON.stringify({ model: MODEL, effort: EFFORT, turnsUsed, results, approvals }, null, 2)}\n`,
  );
  console.log(`turns used: ${turnsUsed}/${MAX_TURNS}`);
  process.exit(0);
}
