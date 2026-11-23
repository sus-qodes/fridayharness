import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePlanDraft } from '../parse.js';
import { draftJsonSchema } from '../schemas.js';
import {
  CODEX_PLANNER_OFF,
  CODEX_UNNAMED_MODEL,
  CodexPlannerModel,
  classifyCodexFailure,
  dropNullOptionals,
  strictOutputSchema,
  usageFromCodex,
} from './codex.js';
import { ModelError, type ModelRequest } from './types.js';

/**
 * The Master Brain through Codex headless (2026-11-23): a scripted `codex` records what it was
 * given and answers as `codex exec --json --output-last-message` does, so no test calls a model.
 */

const req: ModelRequest = {
  purpose: 'plan',
  model: 'auto',
  system: 'You are the Master Brain.',
  context: 'Repository layout: backend/, frontend/, shared/',
  status: 'HEAD abc1234',
  instructions: 'Your job now: the first plan.',
  prompt: 'Goal goal_1: add subscriptions',
  schema: draftJsonSchema('plan'),
  schemaName: 'plan',
  maxTokens: 16_000,
};

const PLAN = {
  objective: 'Add subscriptions to the shop',
  summary: 'One task adds the subscription API.',
  tasks: [
    {
      key: 'api',
      summary: 'Add the subscription API',
      acceptance_criteria: ['node --test passes'],
      scope: { write: ['backend/**'], read: [] },
    },
  ],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'friday-codex-brain-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Recorded {
  argv: string[];
  stdin: string;
  cwd: string;
  schema: unknown;
  files: string[];
}

/**
 * A scripted Codex: records its arguments, stdin, folder and the schema file it was given, then
 * runs `script` with `answerFile` (the `--output-last-message` path) and `emit` (one event line).
 * Every run appends to the record, so a second attempt is seen too.
 */
function fakeCodex(script: string): { command: string; args: string[]; runs: () => Recorded[] } {
  const file = path.join(dir, 'fake-codex.mjs');
  const record = path.join(dir, 'record.jsonl');
  writeFileSync(
    file,
    `import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
const argv = process.argv.slice(2);
const after = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
const schemaFile = after('--output-schema');
const answerFile = after('--output-last-message');
appendFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv, stdin, cwd: process.cwd(),
  schema: schemaFile && existsSync(schemaFile) ? JSON.parse(readFileSync(schemaFile, 'utf8')) : null,
  files: readdirSync(process.cwd()),
}) + '\\n');
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
const run = readFileSync(${JSON.stringify(record)}, 'utf8').trim().split('\\n').length;
${script}
`,
  );
  return {
    command: process.execPath,
    args: [file],
    runs: () =>
      readFileSync(record, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Recorded),
  };
}

const answers = (value: unknown, usage = { input_tokens: 5000, cached_input_tokens: 1200, output_tokens: 700 }) =>
  `emit({ type: 'thread.started', thread_id: 'thread-1' });
emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: ${JSON.stringify(JSON.stringify(value))} } });
emit({ type: 'turn.completed', usage: ${JSON.stringify(usage)} });
writeFileSync(answerFile, ${JSON.stringify(JSON.stringify(value))});`;

describe('the strict form of a schema, for a service that takes only that', () => {
  it('closes every object, requires every property, and offers an optional one as "this, or null"', () => {
    const strict = strictOutputSchema({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 3 },
        note: { type: 'string', default: '' },
        maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        inner: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a'] },
      },
      required: ['name', 'inner'],
    }) as Record<string, never>;
    expect(strict).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['name', 'note', 'maybe', 'inner'],
      properties: {
        name: { type: 'string' },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        // Already allows null: left as it is.
        maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        inner: {
          type: 'object',
          additionalProperties: false,
          required: ['a', 'b'],
          properties: { a: { type: 'number' }, b: { anyOf: [{ type: 'number' }, { type: 'null' }] } },
        },
      },
    });
  });

  it('makes the plan schema strict all the way down, and an answer to it reads as a plan again', () => {
    const schema = draftJsonSchema('plan');
    const strict = strictOutputSchema(schema);
    // Every object in it is closed and requires each of its properties.
    const check = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(check);
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      if (o.properties && typeof o.properties === 'object') {
        expect(o.additionalProperties).toBe(false);
        expect(o.required).toEqual(Object.keys(o.properties));
      }
      Object.values(o).forEach(check);
    };
    check(strict);
    // A strict service fills what the plan left out with null: Friday reads it as left out.
    const filled = {
      ...PLAN,
      constraints: null,
      outcomes: null,
      non_goals: null,
      definition_of_done: null,
      rationale: null,
      needs_human: null,
      tasks: [
        {
          ...PLAN.tasks[0],
          kind: null,
          description: null,
          depends_on: null,
          role: null,
          priority: null,
          risk_level: null,
        },
      ],
    };
    const back = dropNullOptionals(filled, schema) as typeof PLAN & { needs_human?: unknown };
    expect(back.tasks[0]).toEqual(PLAN.tasks[0]);
    expect('constraints' in back).toBe(false);
    // A property that itself may be null keeps its null.
    expect(back.needs_human).toBeNull();
    const parsed = parsePlanDraft(back);
    expect(parsed.ok).toBe(true);
  });
});

describe('usage and failures as Codex reports them', () => {
  it('counts the cached part of the prompt as read from the cache, not twice', () => {
    expect(usageFromCodex({ input_tokens: 5000, cached_input_tokens: 1200, output_tokens: 700 })).toEqual({
      input_tokens: 3800,
      output_tokens: 700,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1200,
    });
    expect(usageFromCodex(undefined).input_tokens).toBe(0);
  });

  it('tells a sign-in, a limit of the account and a model it cannot use apart', () => {
    expect(classifyCodexFailure('Not logged in. Run `codex login`.', 1).code).toBe('auth');
    const limit = classifyCodexFailure("You've hit your usage limit. Try again in 3 hours.", 1);
    expect([limit.code, limit.retryable]).toEqual(['rate_limited', true]);
    expect(
      classifyCodexFailure('The model `gpt-x` is not supported when using Codex with a ChatGPT account.', 1).code,
    ).toBe('bad_request');
    expect(classifyCodexFailure('', 3).message).toContain('exit code 3');
  });
});

describe('planning through Codex', () => {
  it('runs Codex so that it can only answer, in a folder of its own, and reads the plan and its tokens', async () => {
    const codex = fakeCodex(answers({ ...PLAN, rationale: null }));
    const model = new CodexPlannerModel({ command: codex.command, args: codex.args, tmpDir: dir });
    expect([model.provider, model.remote, model.unpriced]).toEqual(['codex', true, true]);
    const res = await model.complete(req);

    expect(res.output).toEqual(PLAN);
    expect(res.usage).toEqual({
      input_tokens: 3800,
      output_tokens: 700,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1200,
    });
    // No model was named, and Codex did not say which it used.
    expect([res.model, res.request_id]).toEqual([CODEX_UNNAMED_MODEL, 'thread-1']);

    const [run] = codex.runs();
    const argv = run?.argv ?? [];
    expect(argv[0]).toBe('exec');
    for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--json']) {
      expect(argv, flag).toContain(flag);
    }
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('read-only');
    // Its command tools, apps, plugins and browser are all off.
    for (const feature of CODEX_PLANNER_OFF) {
      expect(
        argv.some((a, i) => a === '--disable' && argv[i + 1] === feature),
        feature,
      ).toBe(true);
    }
    expect(argv).toContain('web_search="disabled"');
    expect(argv).toContain('project_doc_max_bytes=0');
    // No model named: Codex's own default.
    expect(argv).not.toContain('--model');
    expect(argv.at(-1)).toBe('-');
    // A folder of its own, holding only the schema, and gone afterwards.
    expect(run?.cwd).not.toBe(dir);
    expect(path.dirname(run?.cwd ?? '')).toBe(dir);
    expect(run?.files).toEqual(['schema.json']);
    expect(argv[argv.indexOf('--cd') + 1]).toBe(run?.cwd);
    expect(() => readFileSync(path.join(run?.cwd ?? '', 'schema.json'))).toThrow();
    // The schema in the strict form; the request on standard input, the repository's text marked.
    expect((run?.schema as { required: string[] }).required).toContain('rationale');
    expect(run?.stdin).toContain('You are the Master Brain.');
    expect(run?.stdin).toContain('Your job now: the first plan.');
    expect(run?.stdin).toContain('Repository layout: backend/, frontend/, shared/');
    expect(run?.stdin).toContain('Goal goal_1: add subscriptions');
    expect(run?.stdin).toContain('Do not run commands, read files or search');
    expect(run?.stdin.indexOf('You are the Master Brain.')).toBeLessThan(run?.stdin.indexOf('Repository layout') ?? 0);
    expect(model.schemaSupported).toBe(true);
  });

  it('names the model and the effort a person chose', async () => {
    const codex = fakeCodex(answers(PLAN));
    const model = new CodexPlannerModel({
      command: codex.command,
      args: codex.args,
      tmpDir: dir,
      effort: () => 'max',
    });
    const res = await model.complete({ ...req, model: 'gpt-6.1-sol' });
    const argv = codex.runs()[0]?.argv ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-6.1-sol');
    // Codex has no "max": its highest.
    expect(argv).toContain('model_reasoning_effort="xhigh"');
    expect(res.model).toBe('gpt-6.1-sol');
  });

  it('sends the request again without the schema when the service refuses it, and not again after', async () => {
    const codex = fakeCodex(`if (argv.includes('--output-schema')) {
  emit({ type: 'error', message: "Invalid schema for response_format 'codex_output_schema': In context=(), 'required' is required" });
  emit({ type: 'turn.failed', error: { message: 'Invalid schema for response_format' } });
  process.exit(1);
}
${answers(PLAN)}`);
    const model = new CodexPlannerModel({ command: codex.command, args: codex.args, tmpDir: dir });
    const res = await model.complete(req);
    expect(res.output).toEqual(PLAN);
    const runs = codex.runs();
    expect(runs).toHaveLength(2);
    expect(runs[1]?.argv).not.toContain('--output-schema');
    // The schema goes into the request instead.
    expect(runs[1]?.stdin).toContain('Answer with one JSON object only');
    expect(runs[1]?.files).toEqual([]);
    expect(model.schemaSupported).toBe(false);
    await model.complete(req);
    expect(codex.runs()).toHaveLength(3);
  });

  it('gives an answer that is not JSON to Friday’s own validation, for its repair attempt', async () => {
    const codex = fakeCodex(`emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
writeFileSync(answerFile, 'Here is the plan: first, the API.');`);
    const model = new CodexPlannerModel({ command: codex.command, args: codex.args, tmpDir: dir });
    const res = await model.complete({ ...req, repair: { previous: '{"x":1}', errors: ['objective: Required'] } });
    expect(res.output).toBe('Here is the plan: first, the API.');
    const stdin = codex.runs()[0]?.stdin ?? '';
    expect(stdin).toContain('Your previous answer was:\n{"x":1}');
    expect(stdin).toContain('objective: Required');
  });

  it('reads the last message from the events when no answer file was written', async () => {
    const codex = fakeCodex(`emit({ type: 'item.completed', item: { type: 'agent_message', text: 'thinking aloud' } });
emit({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(`\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``)} } });
emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });`);
    const model = new CodexPlannerModel({ command: codex.command, args: codex.args, tmpDir: dir });
    expect((await model.complete(req)).output).toEqual(PLAN);
  });

  it('says a sign-in or a limit as what it is, and bills nothing for a request that never ran', async () => {
    const signedOut = fakeCodex(`process.stderr.write('Not logged in. Run codex login.\\n'); process.exit(1);`);
    const a = new CodexPlannerModel({ command: signedOut.command, args: signedOut.args, tmpDir: dir });
    const e1 = await a.complete(req).catch((e: unknown) => e as ModelError);
    expect(e1).toBeInstanceOf(ModelError);
    expect([(e1 as ModelError).code, (e1 as ModelError).billed]).toEqual(['auth', 'no']);

    rmSync(path.join(dir, 'record.jsonl'), { force: true });
    const limited = fakeCodex(
      `emit({ type: 'error', message: "You've hit your usage limit. Try again in 2 hours." }); process.exit(1);`,
    );
    const b = new CodexPlannerModel({ command: limited.command, args: limited.args, tmpDir: dir });
    const e2 = (await b.complete(req).catch((e: unknown) => e)) as ModelError;
    expect([e2.code, e2.retryable]).toEqual(['rate_limited', true]);
  });

  it('says so when Codex cannot be started, and stops one that does not answer in time', async () => {
    const missing = new CodexPlannerModel({ command: path.join(dir, 'no-such-codex.exe'), tmpDir: dir });
    const e1 = (await missing.complete(req).catch((e: unknown) => e)) as ModelError;
    expect([e1.code, e1.billed]).toEqual(['unavailable', 'no']);
    expect(e1.message).toContain('Codex could not start');

    const slow = fakeCodex(`await new Promise((r) => setTimeout(r, 30_000));`);
    const model = new CodexPlannerModel({ command: slow.command, args: slow.args, tmpDir: dir, timeoutMs: 400 });
    const e2 = (await model.complete(req).catch((e: unknown) => e)) as ModelError;
    expect([e2.code, e2.retryable, e2.billed]).toEqual(['timeout', true, 'unknown']);
  });

  it('refuses to be built without a program', () => {
    expect(() => new CodexPlannerModel({ command: ' ' })).toThrow(ModelError);
  });
});
