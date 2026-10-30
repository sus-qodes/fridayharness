import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { draftJsonSchema } from '../schemas.js';
import { ClaudeCodePlannerModel, usageFromClaude } from './claude-code.js';
import { ModelError, type ModelRequest } from './types.js';

/**
 * The Master Brain through Claude Code headless (S11 §5.2.6): a scripted `claude` records what it was
 * given and answers as `claude -p --output-format json` does.
 */

const req: ModelRequest = {
  purpose: 'plan',
  model: 'claude-sonnet-5-5',
  system: 'You are the Master Brain.',
  context: 'Repository layout: backend/, frontend/, shared/',
  status: 'HEAD abc1234',
  instructions: 'Your job now: the first plan.',
  prompt: 'Goal goal_1: add subscriptions',
  schema: draftJsonSchema('plan'),
  schemaName: 'plan',
  maxTokens: 16_000,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'friday-claude-brain-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A scripted Claude Code: writes its arguments, stdin and cwd to a file, then prints the scripted result. */
function fakeClaude(script: string): {
  command: string;
  args: string[];
  record: () => { argv: string[]; stdin: string; cwd: string };
} {
  const file = path.join(dir, 'fake-claude.mjs');
  const record = path.join(dir, 'record.json');
  writeFileSync(
    file,
    `import { writeFileSync } from 'node:fs';
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() }));
${script}
`,
  );
  return {
    command: process.execPath,
    args: [file],
    record: () => JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; stdin: string; cwd: string },
  };
}

const result = (extra: Record<string, unknown>) =>
  `process.stdout.write(JSON.stringify(${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    usage: { input_tokens: 12, output_tokens: 300, cache_creation_input_tokens: 2000, cache_read_input_tokens: 500 },
    modelUsage: { 'claude-sonnet-5-5-20261001': { inputTokens: 12 } },
    session_id: 'sess-1',
    stop_reason: 'end_turn',
    ...extra,
  })}) + '\\n');`;

async function fails(p: Promise<unknown>): Promise<ModelError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ModelError) return e;
    throw e;
  }
  throw new Error('the request did not fail');
}

describe('the Master Brain through Claude Code', () => {
  it('runs one headless session with no tools, the rules as system prompt and the context on stdin, and reads the structured answer', async () => {
    const fake = fakeClaude(result({ structured_output: { objective: 'add subscriptions', tasks: [] } }));
    const model = new ClaudeCodePlannerModel({ ...fake, effort: () => 'high', tmpDir: dir });
    const res = await model.complete(req);
    expect(res.output).toEqual({ objective: 'add subscriptions', tasks: [] });
    expect(res.model).toBe('claude-sonnet-5-5-20261001');
    expect(res.usage).toEqual({
      input_tokens: 12,
      output_tokens: 300,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 500,
    });
    expect(res.request_id).toBe('sess-1');
    const r = fake.record();
    expect(r.argv.slice(0, 5)).toEqual([
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      expect.stringContaining('"objective"'),
    ]);
    expect(r.argv).toContain('--restricted');
    expect(r.argv.slice(r.argv.indexOf('--tools'), r.argv.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) {
      expect(r.argv).toContain(flag);
    }
    expect(r.argv.slice(r.argv.indexOf('--permission-prompts'), r.argv.indexOf('--permission-prompts') + 2)).toEqual([
      '--permission-prompts',
      'none',
    ]);
    expect(r.argv.slice(r.argv.indexOf('--model'), r.argv.indexOf('--model') + 2)).toEqual([
      '--model',
      'claude-sonnet-5-5',
    ]);
    expect(r.argv.slice(r.argv.indexOf('--effort'), r.argv.indexOf('--effort') + 2)).toEqual(['--effort', 'high']);
    expect(r.argv.slice(r.argv.indexOf('--system-prompt'), r.argv.indexOf('--system-prompt') + 2)).toEqual([
      '--system-prompt',
      'You are the Master Brain.\n\nYour job now: the first plan.',
    ]);
    // The repository's text is marked source material, before the request; the session runs in its own folder.
    expect(r.stdin).toContain('<project_context source="repository" trust="untrusted">\nRepository layout');
    expect(r.stdin).toContain('HEAD abc1234');
    expect(r.stdin.trim().endsWith('Goal goal_1: add subscriptions')).toBe(true);
    expect(r.cwd.startsWith(dir)).toBe(true);
    expect(r.argv.join(' ')).not.toContain('Repository layout');
  });

  it('appends the rejected answer and the repair request on a repair, and takes JSON from the text when there is no structured answer', async () => {
    const fake = fakeClaude(result({ result: '{"objective":"again","tasks":[]}' }));
    const model = new ClaudeCodePlannerModel({ ...fake, tmpDir: dir });
    const res = await model.complete({
      ...req,
      repair: { previous: '{"objective":1}', errors: ['objective: expected string'] },
    });
    expect(res.output).toEqual({ objective: 'again', tasks: [] });
    const r = fake.record();
    expect(r.stdin).toContain('Your previous answer was:\n{"objective":1}');
    expect(r.stdin).toContain('objective: expected string');
    // Text that is not JSON comes back as text: validation refuses it and earns the repair.
    const prose = fakeClaude(result({ result: 'I cannot plan this.' }));
    expect((await new ClaudeCodePlannerModel({ ...prose, tmpDir: dir }).complete(req)).output).toBe(
      'I cannot plan this.',
    );
  });

  it('says when Claude Code is not signed in, and classifies a failed run as the API would', async () => {
    const out = fakeClaude(`process.stderr.write('Not logged in · Please run /login\\n'); process.exit(1);`);
    const e = await fails(new ClaudeCodePlannerModel({ ...out, tmpDir: dir }).complete(req));
    expect(e.code).toBe('auth');
    expect(e.billed).toBe('no');
    expect(e.message).toContain('claude setup-token');
    const limited = fakeClaude(
      result({ is_error: true, subtype: 'error', result: 'You have hit your usage limit (429)' }),
    );
    const l = await fails(new ClaudeCodePlannerModel({ ...limited, tmpDir: dir }).complete(req));
    expect(l.code).toBe('rate_limited');
    expect(l.billed).toBe('yes');
    const crashed = fakeClaude(`process.stderr.write('segfault\\n'); process.exit(2);`);
    const c = await fails(new ClaudeCodePlannerModel({ ...crashed, tmpDir: dir }).complete(req));
    expect(c.code).toBe('unavailable');
    expect(c.message).toContain('segfault');
    const empty = fakeClaude(result({ result: '' }));
    expect((await fails(new ClaudeCodePlannerModel({ ...empty, tmpDir: dir }).complete(req))).code).toBe('no_output');
  });

  it('stops a session that takes too long, and one that is cancelled', async () => {
    const slow = fakeClaude('await new Promise((r) => setTimeout(r, 30_000));');
    const t = await fails(new ClaudeCodePlannerModel({ ...slow, tmpDir: dir, timeoutMs: 300 }).complete(req));
    expect(t.code).toBe('timeout');
    expect(t.billed).toBe('unknown');
    const ac = new AbortController();
    const p = new ClaudeCodePlannerModel({
      ...fakeClaude('await new Promise((r) => setTimeout(r, 30_000));'),
      tmpDir: dir,
    }).complete(req, ac.signal);
    setTimeout(() => ac.abort(), 200);
    expect((await fails(p)).message).toBe('the request was cancelled');
  });

  it('counts usage as Claude Code reports it, missing values as 0', () => {
    expect(usageFromClaude({ input_tokens: 3, output_tokens: 'x' })).toEqual({
      input_tokens: 3,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(usageFromClaude(undefined).output_tokens).toBe(0);
  });
});
