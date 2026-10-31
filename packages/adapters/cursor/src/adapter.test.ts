import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { chatIdFrom, cursorHostUsage, finalFrom, hookShellCommand, projectHookEvents } from './adapter.js';
import { CURSOR_HOOK_EVENTS, CURSOR_HOOK_SCRIPT, fridayCursorHooks } from './templates.js';

const ws = useTestWorkspace();

describe('what a Cursor attempt cost (host.usage)', () => {
  it("reads the counts under either naming, sums the attempt's runs, and leaves what was not reported unknown", () => {
    const sdk = { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 5 } };
    const snake = {
      usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 1 },
    };
    expect(cursorHostUsage([sdk, snake], 2, 'Model A')).toEqual({
      cost_usd: null,
      input_tokens: 150,
      output_tokens: 15,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 6,
      turns: 2,
      model: 'Model A',
      reported_fields: [
        'cacheReadTokens',
        'cacheWriteTokens',
        'cache_creation_input_tokens',
        'cache_read_input_tokens',
        'inputTokens',
        'input_tokens',
        'outputTokens',
        'output_tokens',
      ],
    });
    // A run that reported nothing makes the attempt's figure unknown, never smaller.
    expect(cursorHostUsage([sdk, { result: 'x' }], 2, null)).toMatchObject({
      input_tokens: null,
      output_tokens: null,
      turns: 2,
    });
    expect(cursorHostUsage([], 0, null)).toMatchObject({
      input_tokens: null,
      cost_usd: null,
      turns: 0,
      reported_fields: [],
    });
    expect(cursorHostUsage([{ total_cost_usd: 0.25, usage: {} }], 1, 'm')).toMatchObject({
      cost_usd: 0.25,
      input_tokens: null,
    });
  });
});

describe('the final answer of a Cursor session', () => {
  const final = { status: 'completed', summary: 'done', blocked_reason: '' };
  it('is the JSON object the last message ends with, wrapped or not', () => {
    expect(finalFrom(JSON.stringify(final))).toEqual({ ...final, checks: [] });
    expect(finalFrom(`All set.\n\n${JSON.stringify(final)}`)).toEqual({ ...final, checks: [] });
    expect(finalFrom(`Here it is:\n\`\`\`json\n${JSON.stringify(final, null, 2)}\n\`\`\`\nThanks.`)).toEqual({
      ...final,
      checks: [],
    });
    expect(
      finalFrom(
        `{"note": {"status": "draft"}} then ${JSON.stringify({ ...final, status: 'blocked', blocked_reason: 'x' })}`,
      ),
    ).toMatchObject({ status: 'blocked', blocked_reason: 'x' });
  });
  it('is the summary of a completed task when the message is prose', () => {
    expect(finalFrom('I changed the parser. {not json}')).toEqual({
      status: 'completed',
      summary: 'I changed the parser. {not json}',
      blocked_reason: '',
      checks: [],
    });
  });
});

describe('the chat id agent create-chat prints', () => {
  it('is the last id on its output', () => {
    expect(chatIdFrom('c6b62c6f-7ead-4fd6-9922-e952131177ff\n')).toBe('c6b62c6f-7ead-4fd6-9922-e952131177ff');
    expect(chatIdFrom('Created chat:\r\nc6b62c6f-7ead-4fd6-9922-e952131177ff\r\n')).toBe(
      'c6b62c6f-7ead-4fd6-9922-e952131177ff',
    );
    expect(chatIdFrom('chat_abc123\n')).toBe('chat_abc123');
    expect(chatIdFrom('Error: not logged in\n')).toBeNull();
    expect(chatIdFrom('')).toBeNull();
  });
});

describe("a spawned session's hook command", () => {
  it('quotes absolute paths with forward slashes, so cmd.exe and POSIX shells read them alike', () => {
    const node = path.resolve('/opt/node dir/node.exe');
    const hook = path.resolve('/srv/friday/hook.mjs');
    expect(hookShellCommand({ command: node, args: [hook] }, 'preToolUse')).toBe(
      `"${node.replaceAll('\\', '/')}" "${hook.replaceAll('\\', '/')}" cursor preToolUse`,
    );
    expect(() => hookShellCommand({ command: path.resolve('/a%PATH%/node'), args: [] }, 'stop')).toThrow(
      /a shell would read part of/,
    );
  });
});

describe("the worktree's own Friday hooks", () => {
  it('cover the events whose Friday entry fails closed, and none without the tracked launcher', () => {
    const root = ws().projectDir;
    mkdirSync(path.join(root, '.cursor'), { recursive: true });
    const hooks = fridayCursorHooks();
    writeFileSync(
      path.join(root, '.cursor', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: { ...hooks, stop: [{ ...hooks.stop[0], failClosed: false }], beforeReadFile: [{ command: 'x' }] },
      }),
    );
    expect(projectHookEvents(root)).toEqual([]);
    mkdirSync(path.join(root, ...path.dirname(CURSOR_HOOK_SCRIPT).split('/')), { recursive: true });
    writeFileSync(path.join(root, ...CURSOR_HOOK_SCRIPT.split('/')), '// launcher\n');
    expect(projectHookEvents(root)).toEqual(CURSOR_HOOK_EVENTS.filter((e) => e !== 'stop' && e !== 'beforeReadFile'));
  });
});
