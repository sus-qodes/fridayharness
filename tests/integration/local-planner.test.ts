/**
 * The Master Brain on a model that runs on this machine (plan M12.1): `master_brain.provider: local`
 * against a stand-in for an OpenAI-compatible server (Ollama, LM Studio) on 127.0.0.1. The gate
 * scenario goal → plan → approve → tasks, the JSON-mode fallback, the repair attempt, the loopback
 * and redirect refusals, an unset model, and `friday doctor`'s checks. No network, no key, no money.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import { doctor } from '@friday/cli';
import type { GoalView, TaskView } from '@friday/protocol';
import { type TestWorkspace, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT } from '../helpers/cli.js';
import { startTestDaemon } from '../helpers/daemon.js';

const ws = useTestWorkspace();
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'planner', 'stripe-subscriptions');
const PLAN = (JSON.parse(readFileSync(path.join(FIXTURES, '01-plan.json'), 'utf8')) as { output: unknown }).output;
const GOAL = 'Add Stripe subscriptions, keep one-time checkout working, add tests';
const MODEL = 'qwen2.5:7b';

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['FRIDAY_STATE_DIR', 'FRIDAY_TEST_LOCAL_KEY']) saved[k] = process.env[k];
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface Captured {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}
type Answer =
  | { kind: 'plan'; output: unknown }
  | { kind: 'text'; content: string }
  | { kind: 'status'; status: number; body: unknown; headers?: Record<string, string> };

interface FakeServer {
  url: string;
  seen: Captured[];
  /** Scripted answers for POST /v1/chat/completions, in order; the last one repeats. */
  answers: Answer[];
  /** Whether `response_format: json_schema` is accepted; false answers 400 as an older server does. */
  jsonSchema: boolean;
  /** What GET /v1/models lists. */
  models: string[];
  /** Stops listening now (the workspace would otherwise close it at cleanup). */
  close: () => Promise<void>;
}

/** An OpenAI-compatible server on 127.0.0.1 at a random port, as Ollama and LM Studio serve it. */
async function fakeOpenAI(
  w: TestWorkspace,
  answers: Answer[],
  opts: { jsonSchema?: boolean } = {},
): Promise<FakeServer> {
  let closed = false;
  const fake: FakeServer = {
    url: '',
    seen: [],
    answers: [...answers],
    jsonSchema: opts.jsonSchema ?? true,
    models: [MODEL],
    close: () =>
      new Promise<void>((r) => {
        if (closed) return r();
        closed = true;
        server.close(() => r());
      }),
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      body += c;
    });
    req.on('end', () => {
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'GET' && req.url === '/v1/models') {
        json(200, { object: 'list', data: fake.models.map((id) => ({ id, object: 'model', owned_by: 'library' })) });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        json(404, { error: { message: `no route ${req.method} ${req.url}` } });
        return;
      }
      const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
      fake.seen.push({ url: req.url ?? '', headers: req.headers, body: parsed });
      const format = parsed.response_format as { type?: string } | undefined;
      if (format?.type === 'json_schema' && !fake.jsonSchema) {
        json(400, {
          error: { message: 'response_format type json_schema is not supported', type: 'invalid_request_error' },
        });
        return;
      }
      const next = fake.answers.length > 1 ? (fake.answers.shift() as Answer) : fake.answers[0];
      if (!next) {
        json(500, { error: { message: 'no scripted answer' } });
        return;
      }
      if (next.kind === 'status') {
        json(next.status, next.body, next.headers);
        return;
      }
      const content = next.kind === 'plan' ? JSON.stringify(next.output) : next.content;
      json(200, {
        id: `chatcmpl-${fake.seen.length}`,
        object: 'chat.completion',
        model: parsed.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 4100, completion_tokens: 1300, total_tokens: 5400 },
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  w.track({ close: fake.close });
  fake.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return fake;
}

/** An address on this machine where nothing listens: a server opened for its port and closed again. */
async function deadAddress(w: TestWorkspace): Promise<string> {
  const probe = await fakeOpenAI(w, []);
  await probe.close();
  return probe.url;
}

/** The messages of a captured request; an absent request reads as none. */
const messagesOf = (s: Captured | undefined): { role: string; content: string }[] =>
  (s?.body.messages as { role: string; content: string }[] | undefined) ?? [];

/** config.yaml with provider local at the given address; the template's master_brain block is replaced. */
const localConfig =
  (baseUrl: string, model: string = MODEL, extra = '') =>
  (yaml: string) =>
    yaml.replace(
      /\n# The Master Brain[\s\S]*$/,
      `\nmaster_brain:\n  provider: local\n  model: ${JSON.stringify(model)}\n\nproviders:\n  local:\n    base_url: ${JSON.stringify(baseUrl)}\n${extra}`,
    );

interface GoalDetail {
  goal: GoalView;
  proposed: { plan_id: string; version: number; tasks: { key: string; status: string | null }[] } | null;
  active: { tasks: { key: string; status: string | null }[] } | null;
  escalations: { kind: string | null; question: string; details: Record<string, unknown> | null }[];
}

interface BrainStatusJson {
  provider: string;
  model: string;
  remote: boolean;
  key: string;
  endpoint: string | null;
  ignored_base_url: string | null;
  planner_available: boolean;
  reason: string | null;
  daily_budget_usd: number | null;
  spent_today_usd: number;
}

describe('the Master Brain on a local model (provider local)', () => {
  it('goal → plan → approve → tasks through the daemon, with no key, no consent and cost 0', async () => {
    const api = await fakeOpenAI(ws(), [{ kind: 'plan', output: PLAN }]);
    const td = await startTestDaemon(ws(), {
      git: true,
      editConfig: localConfig(api.url),
      brain: { autoStart: false },
    });
    const op = td.operator;
    const dir = ws().projectDir;

    const status = JSON.parse((await cli(['--project', dir, '--json', 'brain', 'status'])).stdout) as BrainStatusJson;
    expect(status).toMatchObject({
      provider: 'local',
      model: MODEL,
      remote: false,
      key: 'not needed',
      endpoint: api.url,
      ignored_base_url: null,
      planner_available: true,
      reason: null,
      daily_budget_usd: null,
    });
    const shown = await cli(['--project', dir, 'brain', 'status']);
    expect(shown.stdout).toContain(`Master Brain: local / ${MODEL}  ready to plan`);
    expect(shown.stdout).toContain('Remote calls: not needed');
    expect(shown.stdout).toContain(`Local server: ${api.url}`);
    expect(shown.stdout).toContain('budget: none (the model runs on this machine)');
    expect(shown.stdout).not.toContain('of $0.0000');
    // The planner's model is in the registry as a model of this machine (plan M12.1): `friday
    // models` lists it, and the locality rule knows it runs here.
    const registry = await op.get<{ models: { id: string; provider: string; local: boolean; vendors: string[] }[] }>(
      op.projectPath('/models'),
    );
    expect(registry.models).toContainEqual(
      expect.objectContaining({ id: MODEL, provider: 'local', local: true, vendors: [] }),
    );

    const goal = await op.post<GoalView>(op.projectPath('/goals'), {
      request: GOAL,
      constraints: ['keep one-time checkout working'],
    });
    const pass = await op.post<{ steps: { action: string; result: string }[] }>(op.projectPath('/brain/run-once'), {});
    expect(pass.steps).toContainEqual(
      expect.objectContaining({ action: 'plan', result: expect.stringMatching(/^proposed plan_\w+ v1 with 4 task/) }),
    );
    const d1 = await op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
    expect(d1.proposed?.tasks.map((t) => t.key)).toEqual([
      'billing-service',
      'subscribe-page',
      'stripe-webhooks',
      'lifecycle-tests',
    ]);
    const approved = await op.post<{ created: TaskView[] }>(
      op.projectPath(`/plans/${d1.proposed?.plan_id}/versions/1/approve`),
      { note: 'go' },
    );
    expect(approved.created).toHaveLength(4);
    const d2 = await op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
    expect(d2.goal.status).toBe('ACTIVE');
    expect(d2.active?.tasks.map((t) => t.status)).toEqual(['READY', 'READY', 'PROPOSED', 'PROPOSED']);

    // One request, to this machine, with the schema and no key; Friday's rules first, the
    // repository's text marked as untrusted source material, then the job.
    expect(api.seen).toHaveLength(1);
    const req = api.seen[0] as Captured;
    expect(req.headers.authorization).toBeUndefined();
    expect(req.body).toMatchObject({
      model: MODEL,
      max_tokens: 16_000,
      stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'plan', strict: true } },
    });
    const messages = req.body.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toContain('You are the Master Brain of Friday');
    expect(messages[0]?.content).toContain('<project_context source="repository" trust="untrusted">');
    expect(messages[0]?.content).toContain('## README.md');
    expect(messages[1]?.content).toContain(GOAL);

    // Recorded as a model.called event: the server's tokens, cost 0.00, never remote.
    const calls = td.daemon.state.q.modelCalls(td.project.project_id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      provider: 'local',
      model: MODEL,
      status: 'ok',
      remote: false,
      input_tokens: 4100,
      output_tokens: 1300,
      cost_usd: 0,
      request_id: 'chatcmpl-1',
    });
    const listed = await cli(['--project', dir, 'brain', 'calls']);
    expect(listed.stdout).toMatch(new RegExp(`plan\\s+${MODEL.replace('.', '\\.')}\\s+ok\\s+4100\\s+1300`));
    expect(listed.stdout).toContain('Total: $0.00');
    const after = JSON.parse((await cli(['--project', dir, '--json', 'brain', 'status'])).stdout) as BrainStatusJson;
    expect(after.spent_today_usd).toBe(0);
  });

  it('uses JSON mode with the schema in the instructions when the server refuses a schema', async () => {
    const api = await fakeOpenAI(ws(), [{ kind: 'plan', output: PLAN }], { jsonSchema: false });
    const td = await startTestDaemon(ws(), {
      git: true,
      editConfig: localConfig(api.url),
      brain: { autoStart: false },
    });
    const op = td.operator;
    const goal = await op.post<GoalView>(op.projectPath('/goals'), { request: GOAL });
    const pass = await op.post<{ steps: { action: string; result: string }[] }>(op.projectPath('/brain/run-once'), {});
    expect(pass.steps).toContainEqual(
      expect.objectContaining({ action: 'plan', result: expect.stringMatching(/v1 with 4 task/) }),
    );
    expect(api.seen.map((s) => (s.body.response_format as { type: string }).type)).toEqual([
      'json_schema',
      'json_object',
    ]);
    const system = messagesOf(api.seen[1])[0]?.content ?? '';
    expect(system).toMatch(/one JSON object only/);
    expect(system).toContain('"tasks"');
    const d = await op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
    expect(d.proposed?.tasks).toHaveLength(4);
    // One call recorded: the refused first request was never processed by the server.
    expect(td.daemon.state.q.modelCalls(td.project.project_id)).toHaveLength(1);
  });

  it('gives a malformed answer the one repair attempt, then proposes the corrected plan', async () => {
    const broken = { ...(PLAN as Record<string, unknown>), tasks: [] };
    const api = await fakeOpenAI(ws(), [
      { kind: 'text', content: JSON.stringify(broken) },
      { kind: 'plan', output: PLAN },
    ]);
    const td = await startTestDaemon(ws(), {
      git: true,
      editConfig: localConfig(api.url),
      brain: { autoStart: false },
    });
    const op = td.operator;
    const goal = await op.post<GoalView>(op.projectPath('/goals'), { request: GOAL });
    await op.post(op.projectPath('/brain/run-once'), {});
    const d = await op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
    expect(d.proposed?.tasks).toHaveLength(4);
    expect(api.seen).toHaveLength(2);
    const repair = api.seen[1]?.body.messages as { role: string; content: string }[];
    expect(repair.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(repair[2]?.content).toContain('"tasks":[]');
    expect(repair[3]?.content).toMatch(/not accepted/);
    const calls = td.daemon.state.q.modelCalls(td.project.project_id);
    expect(calls.map((c) => [c.attempt, c.status, c.cost_usd]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [1, 'invalid', 0],
      [2, 'ok', 0],
    ]);

    // Twice malformed: an invalid_plan question for the human, still at cost 0.
    api.answers.splice(0, api.answers.length, { kind: 'text', content: 'not json at all' });
    const again = await op.post<GoalView>(op.projectPath('/goals'), { request: `${GOAL} (second goal)` });
    await op.post(op.projectPath('/brain/run-once'), {});
    const d2 = await op.get<GoalDetail>(op.projectPath(`/goals/${again.goal_id}`));
    expect(d2.proposed).toBeNull();
    expect(d2.escalations.map((e) => e.kind)).toEqual(['invalid_plan']);
    expect(api.seen).toHaveLength(4);
  });

  it('refuses an address that is not this machine when the config is read', async () => {
    await expect(
      startTestDaemon(ws(), {
        git: true,
        editConfig: localConfig('http://ollama.lan:11434/v1'),
        brain: { autoStart: false },
      }),
    ).rejects.toThrow(/providers\.local\.base_url.*must run on this machine/s);
  });

  it('refuses a redirect instead of following it, and a server that is down becomes a question', async () => {
    const elsewhere = await fakeOpenAI(ws(), [{ kind: 'plan', output: PLAN }]);
    const redirecting = await fakeOpenAI(ws(), [
      { kind: 'status', status: 307, body: {}, headers: { location: `${elsewhere.url}/chat/completions` } },
    ]);
    const td = await startTestDaemon(ws(), {
      git: true,
      editConfig: localConfig(redirecting.url),
      brain: { autoStart: false },
    });
    const op = td.operator;
    const goal = await op.post<GoalView>(op.projectPath('/goals'), { request: GOAL });
    await op.post(op.projectPath('/brain/run-once'), {});
    const d = await op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
    expect(d.proposed).toBeNull();
    expect(d.escalations[0]).toMatchObject({ kind: 'planner_unavailable' });
    expect(JSON.stringify(d.escalations[0])).toMatch(/redirect \(307\); Friday follows none/);
    expect(elsewhere.seen).toHaveLength(0);
    expect(td.daemon.state.q.modelCalls(td.project.project_id)[0]).toMatchObject({
      status: 'error',
      error_code: 'unavailable',
      cost_usd: 0,
    });
  });

  it('asks a human, naming the address, when no server listens there', async () => {
    const url = await deadAddress(ws());
    const td = await startTestDaemon(ws(), { git: true, editConfig: localConfig(url), brain: { autoStart: false } });
    const op = td.operator;
    const goal = await op.post<GoalView>(op.projectPath('/goals'), { request: GOAL });
    await op.post(op.projectPath('/brain/run-once'), {});
    const d = await op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
    expect(d.escalations[0]).toMatchObject({ kind: 'planner_unavailable' });
    expect(JSON.stringify(d.escalations[0])).toContain(`no model server answers at ${url}`);
    expect(td.daemon.state.q.modelCalls(td.project.project_id)[0]).toMatchObject({
      status: 'error',
      error_code: 'network',
      cost_usd: 0,
    });
  });

  it('says what to set when master_brain.model is still auto', async () => {
    const api = await fakeOpenAI(ws(), [{ kind: 'plan', output: PLAN }]);
    const td = await startTestDaemon(ws(), {
      git: true,
      editConfig: localConfig(api.url, 'auto'),
      brain: { autoStart: false },
    });
    const status = JSON.parse(
      (await cli(['--project', ws().projectDir, '--json', 'brain', 'status'])).stdout,
    ) as BrainStatusJson;
    expect(status).toMatchObject({
      provider: 'local',
      model: 'auto',
      planner_available: false,
      reason: expect.stringContaining('set it to a model your local server has'),
    });
    const op = td.operator;
    const goal = await op.post<GoalView>(op.projectPath('/goals'), { request: GOAL });
    await op.post(op.projectPath('/brain/run-once'), {});
    const d = await op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
    expect(d.escalations[0]).toMatchObject({ kind: 'planner_unavailable' });
    expect(JSON.stringify(d.escalations[0])).toContain('master_brain.model names no model');
    expect(api.seen).toHaveLength(0);
  });

  it('sends a bearer key only when providers.local.api_key_env names a variable that is set, and never records it', async () => {
    process.env.FRIDAY_TEST_LOCAL_KEY = 'lm-studio-secret-key-4242';
    const api = await fakeOpenAI(ws(), [{ kind: 'plan', output: PLAN }]);
    const td = await startTestDaemon(ws(), {
      git: true,
      editConfig: localConfig(api.url, MODEL, '    api_key_env: FRIDAY_TEST_LOCAL_KEY\n'),
      brain: { autoStart: false },
    });
    const op = td.operator;
    const goal = await op.post<GoalView>(op.projectPath('/goals'), {
      request: `${GOAL} (key lm-studio-secret-key-4242)`,
    });
    await op.post(op.projectPath('/brain/run-once'), {});
    expect(api.seen[0]?.headers.authorization).toBe('Bearer lm-studio-secret-key-4242');
    expect(JSON.stringify(api.seen[0]?.body)).not.toContain('lm-studio-secret-key-4242');
    const d = await op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
    expect(d.proposed?.tasks).toHaveLength(4);
    const events = JSON.stringify(td.daemon.state.store.readSince(td.project.project_id, 0, { limit: 10_000 }));
    expect(events).not.toContain('lm-studio-secret-key-4242');
  });
});

describe('friday doctor with provider local', () => {
  const byId = (results: Awaited<ReturnType<typeof doctor>>) => Object.fromEntries(results.map((r) => [r.id, r]));

  it('reports the server and the model in plain words: present, missing, unset, or no server at all', async () => {
    const api = await fakeOpenAI(ws(), []);
    const dir = ws().projectDir;
    await startTestDaemon(ws(), { git: true, editConfig: localConfig(api.url), brain: { autoStart: false } });
    const ok = byId(await doctor(dir))['master-brain'];
    expect(ok).toMatchObject({ status: 'ok', message: expect.stringContaining(`plans with ${MODEL} on this machine`) });
    expect(byId(await doctor(dir)).endpoint).toBeUndefined();

    api.models = ['llama3.2:3b', 'mistral:latest'];
    const missing = byId(await doctor(dir))['master-brain'];
    expect(missing).toMatchObject({
      status: 'fail',
      message: expect.stringContaining(`has no model "${MODEL}" (it has: llama3.2:3b, mistral:latest)`),
      fix: expect.stringContaining(`ollama pull ${MODEL}`),
    });

    // A model pulled without a tag is listed as `name:latest`; the user may write either.
    api.models = ['qwen2.5:7b', 'phi4:latest'];
    expect(byId(await doctor(dir))['master-brain']?.status).toBe('ok');
  });

  it('names the address when nothing answers there, and the missing model name when it is auto', async () => {
    const api = await fakeOpenAI(ws(), []);
    const dir = ws().projectDir;
    await startTestDaemon(ws(), { git: true, editConfig: localConfig(api.url, 'auto'), brain: { autoStart: false } });
    const unset = byId(await doctor(dir))['master-brain'];
    expect(unset).toMatchObject({
      status: 'fail',
      message: expect.stringContaining('master_brain.model names no model'),
      fix: expect.stringContaining('set master_brain.model'),
    });
  });

  it('fails plainly when no server listens', async () => {
    const url = await deadAddress(ws());
    const dir = ws().projectDir;
    await startTestDaemon(ws(), { git: true, editConfig: localConfig(url), brain: { autoStart: false } });
    const down = byId(await doctor(dir))['master-brain'];
    expect(down).toMatchObject({
      status: 'fail',
      message: expect.stringContaining(`no model server answers at ${url}`),
      fix: expect.stringContaining('ollama serve'),
    });
  });
});
