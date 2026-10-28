// Turns the spike's raw transcripts into committed fixtures: no account data, no machine paths,
// no streaming deltas. Usage: node <this> <out-dir> <schema-json-dir> <fixtures-dir> <scratch1> <scratch2>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [outDir, schemaDir, fixtures, ...scratches] = process.argv.slice(2);
mkdirSync(fixtures, { recursive: true });
const DROP =
  /^(account\/|item\/agentMessage\/delta|item\/reasoning\/|mcpServer\/startupStatus|remoteControl\/|skills\/changed|deprecationNotice|thread\/tokenUsage\/updated)/;
/** A `${NAME}` placeholder, written so it is not read as a template string. */
const ph = (name) => ['$', '{', name, '}'].join('');
const home = os.homedir();
const user = path.basename(home);
const scrub = (text) => {
  let t = text;
  for (const s of scratches) {
    for (const form of [s, s.replace(/\\/g, '\\\\'), s.replace(/\\/g, '/')]) t = t.split(form).join(ph('SCRATCH'));
  }
  for (const form of [home, home.replace(/\\/g, '\\\\'), home.replace(/\\/g, '/')]) t = t.split(form).join(ph('HOME'));
  return t.split(user).join(ph('USER'));
};
const keep = [];
for (const [file, run] of [
  ['transcript.jsonl', 'run-1'],
  ['transcript-2.jsonl', 'run-2'],
]) {
  for (const line of readFileSync(path.join(outDir, file), 'utf8').trim().split('\n')) {
    const { dir, msg } = JSON.parse(line);
    if (msg.method && DROP.test(msg.method)) continue;
    if (msg.result?.instructionSources) msg.result.instructionSources = '[omitted]';
    if (msg.result?.thread?.turns) msg.result.thread.turns = '[omitted]';
    keep.push(scrub(JSON.stringify({ run, dir: dir.endsWith('>') ? 'client->server' : 'server->client', msg })));
  }
}
writeFileSync(path.join(fixtures, 'spike-transcript.jsonl'), `${keep.join('\n')}\n`);

const results = ['results.json', 'results-2.json'].map((f) =>
  JSON.parse(scrub(readFileSync(path.join(outDir, f), 'utf8'))),
);
for (const r of results) delete r.approvals;
writeFileSync(path.join(fixtures, 'spike-results.json'), `${JSON.stringify(results, null, 2)}\n`);

const methods = {};
for (const f of ['ClientRequest.json', 'ServerRequest.json', 'ServerNotification.json', 'ClientNotification.json']) {
  const s = JSON.parse(readFileSync(path.join(schemaDir, f), 'utf8'));
  const set = new Set();
  const walk = (o) => {
    if (o && typeof o === 'object') {
      if (o.properties?.method?.enum) for (const m of o.properties.method.enum) set.add(m);
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(s);
  methods[f.replace('.json', '')] = [...set].sort();
}
writeFileSync(path.join(fixtures, 'protocol-methods.json'), `${JSON.stringify(methods, null, 2)}\n`);
writeFileSync(
  path.join(fixtures, 'manifest.json'),
  `${JSON.stringify(
    {
      host: 'codex-cli',
      version: '0.162.1',
      surface: 'codex app-server (stdio, JSON-RPC 2.0, protocol v2)',
      os: 'Windows 11 Pro 10.0.26200',
      recorded: '2026-10-14',
      model: 'gpt-5.6-luna, effort low',
      turns: 8,
      account: 'ChatGPT plan login (no API key); account notifications removed',
      regenerate: 'codex app-server generate-json-schema --out <dir>; the spike scripts in scripts/spikes/codex/',
    },
    null,
    2,
  )}\n`,
);
console.log(`kept ${keep.length} messages`);
