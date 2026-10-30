/**
 * The handoff's surfaces as tools (ADR-0038): each is one daemon call rendered in words, bounded
 * by the daemon, absent from the spawned set, and deferred for an attached session.
 */
import type { GenericHarnessClient } from '@friday/adapter-generic';
import type { ResultOf } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import type { FridaySession } from './session.js';
import { SPAWNED_AGENT_TOOLS, spawnedAgentTools, spawnedToolsRule } from './spawned.js';
import { artifactText, blastRadiusText, createSurfaceTools, graphQueryText, skeletonText } from './surfaces.js';

const SURFACES = [
  'friday_graph_query',
  'friday_blast_radius',
  'friday_skeleton_read',
  'friday_symbolic_patch',
  'friday_ccr_retrieve',
  'friday_mem_learn_from_failure',
];

/** A client that records its calls and answers each method with a fixed result. */
function recording(answers: Partial<Record<string, unknown>>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (!(method in answers)) throw new Error(`unexpected ${method}`);
      return answers[method];
    },
  } as unknown as GenericHarnessClient;
  const session = (me: unknown = undefined) =>
    ({ ready: async () => client, me: async () => me }) as unknown as FridaySession;
  return { calls, session };
}

const edge = (
  from: string,
  symbol: string,
  line: number,
): NonNullable<ResultOf<'graph.query'>['symbol']>['name_references'][number] => ({
  from: { path: from, symbol },
  to: { path: 'a.ts', symbol: 'f' },
  name: 'f',
  kind: 'call',
  certainty: 'exact',
  line,
});

describe('the surface tools (ADR-0038 §1)', () => {
  it('are six, deferred, and none of them is a spawned tool', () => {
    const tools = createSurfaceTools({} as FridaySession);
    expect(tools.map((t) => t.name)).toEqual(SURFACES);
    for (const t of tools) expect(t.alwaysLoad, t.name).toBe(false);
    for (const name of SURFACES) expect(SPAWNED_AGENT_TOOLS as readonly string[]).not.toContain(name);
    const spawned = spawnedAgentTools({
      client: () => ({}) as GenericHarnessClient,
      agentKey: 'a',
      taskId: 't',
      runId: 'r',
    });
    expect(spawned.map((t) => t.name)).toEqual([...SPAWNED_AGENT_TOOLS]);
    // The rules of a spawned session name only the tools it has (ADR-0038 §6).
    const subset = spawnedToolsRule(spawned.filter((t) => t.name !== 'friday_run_operation'));
    expect(subset).not.toContain('friday_run_operation');
    expect(subset).toContain('friday_request_context');
    for (const name of SURFACES) expect(spawnedToolsRule(spawned)).not.toContain(name);
    expect(spawnedToolsRule([])).toBe('');
    // The attached server's instructions name them and stay within what Claude Code always loads.
    for (const name of SURFACES) expect(SERVER_INSTRUCTIONS).toContain(name);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
  });

  it('asks the graph one question at a time and says what the answer describes', async () => {
    const answer: ResultOf<'graph.query'> = {
      version: 'v1',
      asked: 'symbol',
      symbol: {
        name: 'f',
        matches: [
          {
            symbol: {
              path: 'a.ts',
              name: 'f',
              kind: 'function',
              line: 3,
              end_line: 9,
              exported: true,
              parent: null,
              signature: 'export function f(): void',
            },
            callers: [edge('b.ts', 'g', 12)],
            callees: [],
            tests: ['a.test.ts'],
            callers_cut: 2,
            callees_cut: 0,
          },
        ],
        name_references: [edge('c.ts', 'h', 4)],
        matches_cut: 0,
      },
    };
    const { calls, session } = recording({ 'graph.query': answer });
    const query = createSurfaceTools(session()).find((t) => t.name === 'friday_graph_query');
    if (!query) throw new Error('missing');
    const res = await query.handler({ name: 'f', prefix: 'src' });
    expect(calls).toEqual([{ method: 'graph.query', params: { name: 'f', prefix: 'src' } }]);
    expect(res.text).toBe(
      [
        'a.ts:3-9  function, exported',
        '  export function f(): void',
        '  called or used by: b.ts#g:12 (exact) (+2 more)',
        '  uses: nothing the graph can see',
        '  tests of its file: a.test.ts',
        'Name-only matches (member calls on values the graph does not know; guesses): c.ts:4 in h',
        '(code graph v1)',
      ].join('\n'),
    );
    await expect(query.handler({})).rejects.toThrow(/ask one question/);
    await expect(query.handler({ name: 'f', words: 'f' })).rejects.toThrow(/ask one question/);
    expect(graphQueryText({ version: 'v1', asked: 'search', hits: [] })).toBe('Nothing found.\n(code graph v1)');
    expect(
      graphQueryText({
        version: 'v1',
        asked: 'symbol',
        symbol: { name: 'zz', matches: [], name_references: [], matches_cut: 0 },
      }),
    ).toContain('No symbol named zz');
  });

  it('renders a blast radius, skeletons and raw output with their bounds said', () => {
    expect(
      blastRadiusText({
        version: 'v2',
        seeds: [{ path: 'a.ts', symbols: ['f'], breaking: ['exported f is called from area web'] }],
        affected: [{ path: 'b.ts', symbol: 'g', via: 'reference', distance: 1, confidence: 'high', from: 'a.ts#f' }],
        depth: 2,
        cut: 3,
        name_matches_included: false,
      }),
    ).toBe(
      [
        'Changed: a.ts (f)  breaking: exported f is called from area web',
        '- 1 high: b.ts#g via reference from a.ts#f',
        'Depth 2; 3 more not shown; name-only matches left out (names: true). (code graph v2)',
      ].join('\n'),
    );
    expect(
      skeletonText({
        version: 'v3',
        files: [
          { path: 'a.ts', level: 1, lines: 20, text: '1: export function f() {\n  … (3 lines)', folded: 1, cut: false },
        ],
        missing: [{ path: 'README.md', reason: 'not in the code graph' }],
      }),
    ).toBe(
      'a.ts (L1: 20 lines, 1 folded)\n1: export function f() {\n  … (3 lines)\n\nREADME.md: not in the code graph\n\n(code graph v3)',
    );
    expect(
      artifactText({
        artifact_ref: 'artifact:x',
        kind: 'operation',
        of: { kind: 'operation', id: 'opr_1', task_id: 'task_1' },
        bytes: 10,
        lines_total: 52,
        from: 1,
        to: 2,
        text: 'one\ntwo',
        truncated: true,
        matched: null,
      }),
    ).toBe('artifact:x (operation opr_1 of task_1): lines 1-2 of 52; more: ask again with offset 3.\none\ntwo');
    expect(
      artifactText({
        artifact_ref: 'artifact:x',
        kind: 'check',
        of: { kind: 'check', id: 'chk_1', task_id: 'task_1' },
        bytes: 10,
        lines_total: 52,
        from: 0,
        to: 0,
        text: '',
        truncated: false,
        matched: 0,
      }),
    ).toBe('artifact:x (check chk_1 of task_1): no line of 52; 0 matched.');
  });

  it('learns from a failure through a proposal with the failure as its origin, for the task held or reserved', async () => {
    const proposal = {
      proposal_id: 'lrn_9',
      status: 'proposed',
      kind: 'learned-risk',
      origin: { kind: 'verification', id: 'ver_1', detail: 'tests: 2 failed' },
    };
    const { calls, session } = recording({ 'learning.propose': { proposal } });
    const me = {
      agent: { agent_key: 'be-1' },
      current_task: null,
      claimable: [{ task_id: 'task_7', reserved_for_agent_key: 'be-1' }],
    };
    const learn = createSurfaceTools(session(me)).find((t) => t.name === 'friday_mem_learn_from_failure');
    if (!learn) throw new Error('missing');
    const res = await learn.handler({ subject: 'Migrations', content: 'Back up first.', paths: ['db/**'] });
    expect(calls[0]?.method).toBe('learning.propose');
    expect(calls[0]?.params).toMatchObject({
      kind: 'learned-risk',
      subject: 'Migrations',
      paths: ['db/**'],
      task_id: 'task_7',
      from_failure: { kind: 'verification' },
    });
    expect(res.text).toContain(
      'Proposed lrn_9 for the whole project, learned from verification ver_1 (tests: 2 failed)',
    );
    expect(res.text).toContain('the failure itself promotes nothing');
    // A named operation run, and a task named by the agent, pass through as given.
    await learn.handler({
      subject: 's',
      content: 'c',
      kind: 'bug-pattern',
      failure: { kind: 'operation', id: 'opr_3' },
      task_id: 'task_8',
    });
    expect(calls[1]?.params).toMatchObject({
      kind: 'bug-pattern',
      task_id: 'task_8',
      from_failure: { kind: 'operation', id: 'opr_3' },
    });
  });
});
