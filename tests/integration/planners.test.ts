/**
 * Planning without Claude (2026-11-23). Until then only Claude could write a plan: through Claude
 * Code or with an Anthropic key. A person with Codex, with a key of another service, or with a
 * model on their own machine had to write every plan by hand. Here: every way to plan is listed
 * with where it stands, a goal is planned through a scripted Codex from the same steps a person
 * takes in Settings, and a planner Friday knows no price for is held to requests a day.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { BrainStatusView, GoalView, PlannerOptionView } from '@friday/protocol';
import { approveProvider, setProviderEndpoint } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';

const ws = useTestWorkspace();

const PLAN = {
  objective: 'Add a discount code field to the checkout',
  summary: 'One task adds the field and its test.',
  tasks: [
    {
      key: 'discount-field',
      summary: 'Add the discount code field',
      acceptance_criteria: ['the checkout test passes'],
      scope: { write: ['src/checkout/**'], read: [] },
    },
  ],
};

/** A scripted Codex that answers every run with `PLAN`, as `codex exec --json` does, and counts its runs. */
function fakeCodex(dir: string): { command: string; args: string[]; runs: () => number } {
  const file = path.join(dir, 'fake-codex.mjs');
  const count = path.join(dir, 'codex-runs.txt');
  writeFileSync(
    file,
    `import { appendFileSync, writeFileSync } from 'node:fs';
for await (const _ of process.stdin) {}
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(count)}, 'x');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4200, cached_input_tokens: 200, output_tokens: 310 } }) + '\\n');
writeFileSync(argv[argv.indexOf('--output-last-message') + 1], ${JSON.stringify(JSON.stringify(PLAN))});
`,
  );
  return {
    command: process.execPath,
    args: [file],
    runs: () => {
      try {
        return readFileSync(count, 'utf8').length;
      } catch {
        return 0;
      }
    },
  };
}

type Status = BrainStatusView & { planners: PlannerOptionView[] };

describe('every way to plan, and where each stands on this machine', () => {
  it('lists the installed programs, the key services, a local model and writing plans yourself', async () => {
    const codex = fakeCodex(ws().root);
    const td = await startTestDaemon(ws(), { brain: { codex, autoStart: false } });
    const s = await td.operator.get<Status>(td.operator.projectPath('/brain'));
    expect(s.planners.map((p) => [p.id, p.kind])).toEqual([
      ['claude-code', 'program'],
      ['codex', 'program'],
      ['anthropic', 'key'],
      ['openai', 'key'],
      ['gemini', 'key'],
      ['deepseek', 'key'],
      ['openrouter', 'key'],
      ['local', 'local'],
      ['none', 'none'],
    ]);
    const by = (id: string) => s.planners.find((p) => p.id === id) as PlannerOptionView;
    // Friday was handed Codex when it started.
    expect(by('codex')).toMatchObject({
      label: 'Codex',
      found: true,
      remote: true,
      allowed: false,
      approved: false,
      key: 'not needed',
      model: null,
      needs_model: false,
      // No price is known for it: requests a day, 50 unless the project says otherwise.
      unpriced: true,
      project_budget_usd: null,
      project_calls: 50,
    });
    expect(by('claude-code')).toMatchObject({ unpriced: false, project_budget_usd: 5, project_calls: null });
    expect(by('openai')).toMatchObject({ label: 'OpenAI', found: null, needs_model: true, unpriced: true });
    // Nothing of a model on this machine, or of plans a person writes, leaves it: nothing to allow.
    expect(by('local')).toMatchObject({
      remote: false,
      allowed: true,
      approved: true,
      key: 'not needed',
      needs_model: true,
    });
    expect(by('none')).toMatchObject({ remote: false, needs_model: false });
    // The running planner is the project's (an Anthropic key): held to dollars, no requests count.
    expect(s.requests).toBeNull();
  });
});

describe('planning through Codex, from the steps a person takes in Settings', () => {
  it('plans a goal once the project allows it and this machine approved it, and holds it to its requests a day', async () => {
    const codex = fakeCodex(ws().root);
    const env = { FRIDAY_STATE_DIR: ws().stateDir };
    const first = await startTestDaemon(ws(), { git: true, brain: { codex, autoStart: false } });
    const P = (p: string) => first.operator.projectPath(p);
    // 1. The project allows it (the one setting the team shares), with two requests a day.
    await first.operator.post(P('/config/settings'), {
      set: { 'providers.codex.allow_remote': true, 'providers.codex.daily_calls': 2 },
    });
    // 2. This person plans with it: kept on this machine, with a model of their own for it.
    const chosen = await first.operator.post<Status>(P('/brain/planner-choice'), {
      provider: 'codex',
      model: 'gpt-6.1-sol',
      model_for: 'codex',
    });
    expect(chosen.choice).toMatchObject({ here: 'codex', wanted: 'codex' });
    expect(chosen.planners.find((p) => p.id === 'codex')?.model).toBe('gpt-6.1-sol');
    // The Claude planners' own choice of a model is untouched by it.
    expect(chosen.model_choice?.here).toBeNull();
    // 3. This machine approves it: its own act (the shell's dialog), never a route's.
    approveProvider(first.project, 'codex', { daily_calls: 5 }, env);
    await first.daemon.close('restart');

    // Friday starts again with the new planner.
    const td = await startTestDaemon(ws(), { initialized: true, brain: { codex, autoStart: false } });
    const op = td.operator;
    const Q = (p: string) => op.projectPath(p);
    const ready = await op.get<Status>(Q('/brain'));
    expect(ready).toMatchObject({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      remote: true,
      allow_remote: true,
      approved_here: true,
      key: 'not needed',
      planner_available: true,
      reason: null,
      // Dollars are not counted for it.
      daily_budget_usd: null,
    });
    // The lower of this machine's five and the project's two holds.
    expect(ready.requests).toEqual({ limit: 2, today: 0, yours: 5, project: 2 });

    const goal = await op.post<GoalView>(Q('/goals'), { request: 'Add a discount code field to the checkout' });
    const pass = await op.post<{ steps: { action: string; result: string }[] }>(Q('/brain/run-once'), {});
    expect(pass.steps).toContainEqual(
      expect.objectContaining({ action: 'plan', result: expect.stringMatching(/^proposed plan_\w+ v1 with 1 task/) }),
    );
    expect(codex.runs()).toBe(1);
    const calls = await op.get<{
      calls: { provider: string; model: string; status: string; cost_usd: number | null; input_tokens: number }[];
    }>(Q(`/model-calls?goal=${goal.goal_id}`));
    // Its tokens are recorded; its cost is not known, and never said to be 0.
    expect(calls.calls).toHaveLength(1);
    expect(calls.calls[0]).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', status: 'ok', cost_usd: null });
    expect((await op.get<Status>(Q('/brain'))).requests).toMatchObject({ limit: 2, today: 1 });

    // A second goal uses the day's second request; a third is refused before Codex is started.
    await op.post<GoalView>(Q('/goals'), { request: 'Add a gift card field to the checkout' });
    await op.post(Q('/brain/run-once'), {});
    expect(codex.runs()).toBe(2);
    await op.post<GoalView>(Q('/goals'), { request: 'Add a loyalty points field to the checkout' });
    const third = await op.post<{ steps: { action: string; result: string }[] }>(Q('/brain/run-once'), {});
    expect(codex.runs()).toBe(2);
    // The person is asked, in words that say which limit it is.
    expect(third.steps).toContainEqual(
      expect.objectContaining({
        action: 'plan',
        result: expect.stringMatching(/^escalated esc_\w+ \(budget_exceeded\)/),
      }),
    );
    const asked = td.daemon.state.q.escalations(td.project.project_id, 'pending').map((e) => JSON.stringify(e));
    expect(asked.join(' ')).toContain("today's limit of 2 requests to the planner is reached (2 made)");

    // Taking the approval back holds at once: the page may, since it only tightens.
    const off = await op.post<{ removed: boolean; brain: Status }>(Q('/brain/deny-remote'), { provider: 'codex' });
    expect([off.removed, off.brain.approved_here, off.brain.planner_available]).toEqual([true, false, false]);
  });

  it('says Codex was not found when Friday was not handed one, before anything is asked of it', async () => {
    const first = await startTestDaemon(ws(), { brain: { autoStart: false } });
    await first.operator.post(first.operator.projectPath('/brain/planner-choice'), { provider: 'codex' });
    await first.daemon.close('restart');
    const saved = process.env.CODEX_BIN;
    delete process.env.CODEX_BIN;
    try {
      const td = await startTestDaemon(ws(), { initialized: true, brain: { autoStart: false } });
      const s = await td.operator.get<Status>(td.operator.projectPath('/brain'));
      expect(s).toMatchObject({
        provider: 'codex',
        planner_available: false,
        reason: 'Codex was not found on this computer',
      });
      expect(s.planners.find((p) => p.id === 'codex')?.found).toBe(false);
    } finally {
      if (saved !== undefined) process.env.CODEX_BIN = saved;
    }
  });
});

describe('a model on this machine, chosen in the app', () => {
  /** A scripted model server on this machine: lists two models. */
  async function modelServer(): Promise<{ url: string; server: Server; asked: string[] }> {
    const asked: string[] = [];
    const server = createServer((req, res) => {
      asked.push(`${req.method} ${req.url} ${req.headers.authorization ?? '-'}`);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ object: 'list', data: [{ id: 'qwen2.5:7b' }, { id: 'llama3.3:8b' }, { id: '--bad name' }] }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/v1`, server, asked };
  }

  it('takes only an address of this machine, lists the server’s models to pick from, and plans with the one picked', async () => {
    const local = await modelServer();
    ws().track({ close: () => new Promise<void>((r) => local.server.close(() => r())) });
    const td = await startTestDaemon(ws(), { brain: { autoStart: false } });
    const op = td.operator;
    const P = (p: string) => op.projectPath(p);
    // An address anywhere else is refused: nothing could be sent away from this machine by it.
    // A name is refused too, even this machine's own: a name can be made to resolve elsewhere.
    const byName = `http://${['local', 'host'].join('')}:11434/v1`;
    for (const bad of ['https://example.com/v1', 'http://192.168.1.5:11434/v1', byName, 'nope']) {
      await expect(op.post(P('/brain/local-endpoint'), { base_url: bad }), bad).rejects.toThrow();
    }
    expect(await op.post(P('/brain/local-endpoint'), { base_url: local.url })).toEqual({ base_url: local.url });
    // The server's own list, names only, sorted; a name that is not one is left out.
    const listed = await op.get<{ models: string[] }>(P('/brain/models?provider=local'));
    expect(listed.models).toEqual(['llama3.3:8b', 'qwen2.5:7b']);
    expect(local.asked).toEqual(['GET /v1/models -']);
    // A planner Friday cannot list models for says so; a key service without a key says that.
    await expect(op.get(P('/brain/models?provider=codex'))).rejects.toThrow(/cannot list the models/);
    await expect(op.get(P('/brain/models?provider=deepseek'))).rejects.toThrow(/no DeepSeek key is stored/);

    const chosen = await op.post<Status>(P('/brain/planner-choice'), {
      provider: 'local',
      model: 'qwen2.5:7b',
      model_for: 'local',
    });
    expect(chosen.planners.find((p) => p.id === 'local')?.model).toBe('qwen2.5:7b');
    await td.daemon.close('restart');
    const again = await startTestDaemon(ws(), { initialized: true, brain: { autoStart: false } });
    const s = await again.operator.get<Status>(again.operator.projectPath('/brain'));
    // Nothing leaves the machine: no consent, no key, no limit; the model is the one picked here.
    expect(s).toMatchObject({
      provider: 'local',
      model: 'qwen2.5:7b',
      remote: false,
      endpoint: local.url,
      key: 'not needed',
      planner_available: true,
      daily_budget_usd: null,
      requests: null,
    });
    // Handing the address back: the project's own stands again.
    expect(await again.operator.post(again.operator.projectPath('/brain/local-endpoint'), { base_url: null })).toEqual({
      base_url: 'http://127.0.0.1:11434/v1',
    });
  });

  it('refuses an address of another machine even when one was put on this machine by hand', async () => {
    setProviderEndpoint('local', 'https://models.example.com/v1', { FRIDAY_STATE_DIR: ws().stateDir });
    const td = await startTestDaemon(ws(), {
      brain: { autoStart: false },
      editConfig: (y) => y.replace('provider: anthropic', 'provider: local'),
    });
    const s = await td.operator.get<Status>(td.operator.projectPath('/brain'));
    expect(s.planner_available).toBe(false);
    expect(s.reason).toContain('a local model server must run on this machine');
  });
});
