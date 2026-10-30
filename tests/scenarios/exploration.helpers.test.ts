/**
 * The exploration measurement's arithmetic, offline: a session's tool calls sorted by what they did,
 * and what each result cost over the calls that carried it.
 */
import { describe, expect, it } from 'vitest';
import { explorationFigures } from '../helpers/exploration.js';
import type { TraceLine } from '../helpers/token-baseline.js';

const cwd = process.platform === 'win32' ? 'C:/work/repo' : '/work/repo';
const r = (msg: Record<string, unknown>): TraceLine => ({ t: 0, dir: 'receive', msg: msg as TraceLine['msg'] });
const call = (n: number, uses: Record<string, unknown>[]) =>
  r({ type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: 1000 * n }, content: uses } });
const result = (id: string, text: string) =>
  r({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

describe('the exploration figures', () => {
  it('sorts reads by whether the file was later changed, and counts what each result cost over the calls after it', () => {
    const lines: TraceLine[] = [
      { t: 0, dir: 'send', msg: { type: 'user', message: { content: 'task' } } as TraceLine['msg'] },
      call(1, [{ type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'usageRow' } }]),
      result('g', 'x'.repeat(400)),
      call(2, [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: `${cwd}/src/a.ts` } }]),
      result('a', 'x'.repeat(4000)),
      call(3, [{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'src/b.ts' } }]),
      result('b', 'x'.repeat(2000)),
      call(4, [{ type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: `${cwd}/src/b.ts` } }]),
      result('e', 'ok'),
      call(5, []),
      r({
        type: 'result',
        usage: { input_tokens: 50, cache_read_input_tokens: 15000, cache_creation_input_tokens: 0, output_tokens: 300 },
        total_cost_usd: 0.004,
      }),
    ];
    const f = explorationFigures(lines, cwd);
    expect(f.calls).toBe(5);
    expect(f.edited).toEqual(['src/b.ts']);
    expect(f.first_call_input).toBe(1010);
    expect(f.tools.map((u) => [u.name, u.class, u.call, u.result_tokens, u.carried_tokens])).toEqual([
      ['Grep', 'search', 1, 100, 400],
      ['Read', 'read-other', 2, 1000, 3000],
      ['Read', 'read-edited', 3, 500, 1000],
      ['Edit', 'edit', 4, 1, 1],
    ]);
    // Searches and reads of unchanged files: 400 + 3000 of an input side of 15,050.
    expect(f.exploration_carried).toBe(3400);
    expect(f.input_side).toBe(15050);
    expect(f.exploration_share).toBe(0.226);
  });

  it('reports nothing it was not told: no result, no input side', () => {
    const f = explorationFigures([call(1, [])], cwd);
    expect(f).toMatchObject({ calls: 1, input_side: null, exploration_share: null, tools: [] });
  });
});
